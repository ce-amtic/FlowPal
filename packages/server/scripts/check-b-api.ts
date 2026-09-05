import { openDb, SCHEMA_VERSION } from '../src/store/db.ts'
import { getSettings, SecretSettingsUnsupported, SettingsRevisionConflict, updateSettings } from '../src/store/settings.ts'
import { finishSyncRun, getSyncStatus, startSyncRun } from '../src/store/sync.ts'
import { endFocusSession, getFocusSession, insertFocusSession, startFocusSession } from '../src/store/focus.ts'

/** Deterministic, model-free smoke checks for the B-owned server contracts. */
const failures: string[] = []
function assert(ok: boolean, message: string): void {
  if (ok) console.log(`  ✓ ${message}`)
  else { console.log(`  ✗ ${message}`); failures.push(message) }
}

const db = openDb(':memory:')
const config = {
  llm: {
    text: { baseUrl: 'https://text.example/v1', model: 'text', apiKey: 'configured' },
    vision: { baseUrl: 'https://vision.example/v1', model: 'vision', apiKey: '' },
  },
  ruc: null,
} as any
const ctx = {
  userId: 'local', now: '2026-09-05T10:00:00+08:00', tz: 'Asia/Shanghai',
  term: { id: 'test', name: 'test', startMonday: '2026-09-01', weeks: 16 },
}

console.log(`B API smoke (schema v${SCHEMA_VERSION})`)
assert(SCHEMA_VERSION === 5, 'schema version is v5')
for (const table of ['settings', 'sync_runs', 'sync_records', 'focus_session_fragments']) {
  assert(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined,
    `${table} table exists`,
  )
}

const initial = getSettings(db, config)
assert(initial.revision === 0 && initial.text.apiKeyConfigured, 'settings hides secret values but reports configured state')
const saved = updateSettings(db, config, ctx, {
  revision: 0,
  chronotype: { workdayWakeTime: '08:00' },
})
assert(saved.revision === 1 && saved.chronotype.workdayWakeTime === '08:00', 'settings revision update persists')
try {
  updateSettings(db, config, ctx, { revision: 0, sync: { enabled: false } })
  assert(false, 'stale settings revision is rejected')
} catch (error) {
  assert(error instanceof SettingsRevisionConflict, 'stale settings revision is rejected')
}
try {
  updateSettings(db, config, ctx, { revision: 1, text: { apiKeyAction: 'set' } })
  assert(false, 'secret settings action is rejected')
} catch (error) {
  assert(error instanceof SecretSettingsUnsupported, 'secret settings action is rejected')
}
const rawSettings = String(db.prepare(`SELECT value_json FROM settings WHERE key = 'public'`).get()?.value_json ?? '')
assert(!rawSettings.includes('configured'), 'settings JSON contains no API key')

const focus = startFocusSession(db, ctx, { plannedMinutes: 25, idempotencyKey: 'smoke-focus' })
const retry = startFocusSession(db, { ...ctx, now: '2026-09-05T10:01:00+08:00' }, {
  plannedMinutes: 25, idempotencyKey: 'smoke-focus',
})
assert(focus.session.id === retry.session.id, 'focus start is idempotent')
const changedKey = startFocusSession(db, { ...ctx, now: '2026-09-05T10:02:00+08:00' }, {
  plannedMinutes: 30, idempotencyKey: 'smoke-focus-v2',
})
assert(changedKey.session.id === focus.session.id, 'active target wins over a changed retry key')
const ended = endFocusSession(db, { ...ctx, now: '2026-09-05T10:07:00+08:00' }, focus.session.id, { outcome: 'continue' })
const repeated = endFocusSession(db, { ...ctx, now: '2026-09-05T10:08:00+08:00' }, focus.session.id, { outcome: 'done' })
assert(ended?.session.outcome === 'continue' && repeated?.session.outcome === 'continue', 'focus end keeps first outcome on retry')
assert(ended?.summary.durationMinutes === 7, 'focus duration comes from persisted timestamps, not renderer hint')
assert(getFocusSession(db, focus.session.id, ctx.now)?.session.status === 'ended', 'focus session restores as ended')
const legacy = insertFocusSession(db, ctx, {
  startedAt: '2026-09-05T09:00:00+08:00', plannedMinutes: 25, actualMinutes: 5, endedEarly: true,
})
assert(getFocusSession(db, legacy.id, ctx.now)?.session.outcome === 'continue', 'legacy endedEarly maps to continue')

const sync = startSyncRun(db, ctx, null)
assert(!sync.reused && sync.run.status === 'running', 'sync run starts')
const syncDone = finishSyncRun(db, ctx, sync.run.id, 'unsupported', 0, 'not_configured', 'connector unavailable')
const syncRetry = finishSyncRun(db, ctx, sync.run.id, 'succeeded', 42, null, null)
assert(
  syncDone.status === 'unsupported' && syncRetry.status === 'unsupported'
    && getSyncStatus(db, config, false).recentRuns.length === 1,
  'unsupported sync is explicit, durable, and terminal-idempotent',
)

const stale = startSyncRun(db, { ...ctx, now: '2026-09-05T10:00:00+08:00' }, null)
const recovered = startSyncRun(db, { ...ctx, now: '2026-09-05T11:00:01+08:00' }, null)
assert(stale.run.id !== recovered.run.id && recovered.run.status === 'running', 'stale running sync is recovered after a crash')

db.close()
if (failures.length > 0) {
  console.error(`\n${failures.length} B API checks failed`)
  process.exit(1)
}
console.log('\nB API checks passed')
