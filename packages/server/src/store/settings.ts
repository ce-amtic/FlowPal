import type { DatabaseSync } from 'node:sqlite'
import type {
  ChronotypeSettings,
  Ctx,
  ModelSettingsPublic,
  RucSettings,
  SettingsPatch,
  SettingsPublic,
  SyncSettings,
} from '@flowpal/shared'
import type { ServerConfig } from '../config.ts'

const KEY = 'public'
const DEFAULT_SYNC_INTERVAL = 6 * 60

type PersistedSettings = {
  text?: Pick<ModelSettingsPublic, 'baseUrl' | 'model'>
  vision?: Pick<ModelSettingsPublic, 'baseUrl' | 'model'>
  ruc?: Partial<RucSettings>
  chronotype?: Partial<ChronotypeSettings>
  sync?: Partial<SyncSettings>
}

export class SettingsRevisionConflict extends Error {
  readonly settings: SettingsPublic

  constructor(settings: SettingsPublic) {
    super('settings revision conflict')
    this.name = 'SettingsRevisionConflict'
    this.settings = settings
  }
}

export class SecretSettingsUnsupported extends Error {
  constructor() {
    super('secret settings are managed by the desktop secret store')
    this.name = 'SecretSettingsUnsupported'
  }
}

/** Legacy app_settings access used by buildContext. */
export function getSetting(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value ?? null
}

/** Legacy app_settings write retained for context and migration callers. */
export function setSetting(db: DatabaseSync, ctx: Ctx, key: string, value: string): void {
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, ctx.now)
}

export function getSettings(db: DatabaseSync, config: ServerConfig): SettingsPublic {
  const row = db.prepare('SELECT value_json, revision, updated_at FROM settings WHERE key = ?').get(KEY) as
    { value_json: string; revision: number; updated_at: string } | undefined
  let persisted: PersistedSettings = {}
  if (row) {
    try {
      const parsed: unknown = JSON.parse(row.value_json)
      if (isRecord(parsed)) persisted = parsed as PersistedSettings
    } catch { persisted = {} }
  }

  const persistedText = recordOrEmpty(persisted.text)
  const persistedVision = recordOrEmpty(persisted.vision)
  const persistedRuc = recordOrEmpty(persisted.ruc)
  const persistedChronotype = recordOrEmpty(persisted.chronotype)
  const persistedSync = recordOrEmpty(persisted.sync)
  const legacyWork = getSetting(db, 'chronotype_workday_wake')
  const legacyRest = getSetting(db, 'chronotype_restday_wake')

  return {
    revision: row?.revision ?? 0,
    updatedAt: row?.updated_at ?? null,
    text: {
      baseUrl: stringOr(persistedText.baseUrl, config.llm.text.baseUrl),
      model: stringOr(persistedText.model, config.llm.text.model),
      apiKeyConfigured: config.llm.text.apiKey.length > 0,
    },
    vision: {
      baseUrl: stringOr(persistedVision.baseUrl, config.llm.vision.baseUrl),
      model: stringOr(persistedVision.model, config.llm.vision.model),
      apiKeyConfigured: config.llm.vision.apiKey.length > 0,
    },
    ruc: {
      authorized: typeof persistedRuc.authorized === 'boolean' ? persistedRuc.authorized : false,
      role: roleOr(persistedRuc.role),
      lastSessionAt: nullableString(persistedRuc.lastSessionAt),
    },
    chronotype: {
      workdayWakeTime: nullableString(persistedChronotype.workdayWakeTime) ?? legacyWork,
      freeDayWakeTime: nullableString(persistedChronotype.freeDayWakeTime) ?? legacyRest,
    },
    sync: {
      enabled: typeof persistedSync.enabled === 'boolean' ? persistedSync.enabled : true,
      intervalMinutes: positiveIntOr(persistedSync.intervalMinutes, DEFAULT_SYNC_INTERVAL),
    },
  }
}

export function updateSettings(
  db: DatabaseSync, config: ServerConfig, ctx: Ctx, patch: SettingsPatch,
): SettingsPublic {
  if (patch.text?.apiKeyAction && patch.text.apiKeyAction !== 'keep') throw new SecretSettingsUnsupported()
  if (patch.vision?.apiKeyAction && patch.vision.apiKeyAction !== 'keep') throw new SecretSettingsUnsupported()

  db.exec('BEGIN IMMEDIATE')
  try {
    const current = getSettings(db, config)
    if (patch.revision !== current.revision) throw new SettingsRevisionConflict(current)

    const next: SettingsPublic = {
      ...current,
      revision: current.revision + 1,
      updatedAt: ctx.now,
      text: {
        ...current.text,
        ...(patch.text?.baseUrl === undefined ? {} : { baseUrl: patch.text.baseUrl }),
        ...(patch.text?.model === undefined ? {} : { model: patch.text.model }),
      },
      vision: {
        ...current.vision,
        ...(patch.vision?.baseUrl === undefined ? {} : { baseUrl: patch.vision.baseUrl }),
        ...(patch.vision?.model === undefined ? {} : { model: patch.vision.model }),
      },
      ruc: { ...current.ruc, ...patch.ruc },
      chronotype: { ...current.chronotype, ...patch.chronotype },
      sync: { ...current.sync, ...patch.sync },
    }
    const value: PersistedSettings = {
      text: { baseUrl: next.text.baseUrl, model: next.text.model },
      vision: { baseUrl: next.vision.baseUrl, model: next.vision.model },
      ruc: next.ruc,
      chronotype: next.chronotype,
      sync: next.sync,
    }
    db.prepare(`INSERT INTO settings (key, value_json, revision, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
        revision = excluded.revision, updated_at = excluded.updated_at`)
      .run(KEY, JSON.stringify(value), next.revision, ctx.now)

    // Keep the original A context contract in sync with the public settings
    // model. This also lets older databases retain their prior values.
    mirrorLegacySetting(db, ctx, 'chronotype_workday_wake', next.chronotype.workdayWakeTime)
    mirrorLegacySetting(db, ctx, 'chronotype_restday_wake', next.chronotype.freeDayWakeTime)
    db.exec('COMMIT')
    return next
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* preserve original error */ }
    throw error
  }
}

function mirrorLegacySetting(db: DatabaseSync, ctx: Ctx, key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
  } else {
    setSetting(db, ctx, key, value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : typeof value === 'string' ? value : null
}

function roleOr(value: unknown): RucSettings['role'] {
  return value === 'undergraduate' || value === 'graduate' || value === 'unknown' ? value : 'unknown'
}

function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}
