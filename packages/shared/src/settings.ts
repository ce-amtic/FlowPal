import { z } from 'zod'
import { SyncStatus } from './sync.ts'

/**
 * Settings is deliberately split into a public read model and a write intent.
 * API keys/passwords never belong to either model; the desktop-owned secret
 * store is the only place allowed to handle them.
 */
export const SecretAction = z.enum(['keep', 'set', 'clear'])
export type SecretAction = z.infer<typeof SecretAction>

export const ModelSettingsPublic = z.object({
  baseUrl: z.string(),
  model: z.string(),
  apiKeyConfigured: z.boolean(),
}).strict()
export type ModelSettingsPublic = z.infer<typeof ModelSettingsPublic>

export const ModelSettingsPatch = z.object({
  baseUrl: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  /** An intent only; the value of a key is never accepted by this API. */
  apiKeyAction: SecretAction.optional(),
}).strict()
export type ModelSettingsPatch = z.infer<typeof ModelSettingsPatch>

export const RucSettings = z.object({
  authorized: z.boolean(),
  role: z.enum(['undergraduate', 'graduate', 'unknown']).nullable(),
  lastSessionAt: z.string().nullable(),
}).strict()
export type RucSettings = z.infer<typeof RucSettings>

export const RucSettingsPatch = z.object({
  /** BrowserWindow/WebView writes only the resulting authorization state. */
  authorized: z.boolean().optional(),
  role: z.enum(['undergraduate', 'graduate', 'unknown']).nullable().optional(),
  lastSessionAt: z.string().nullable().optional(),
}).strict()
export type RucSettingsPatch = z.infer<typeof RucSettingsPatch>

export const ChronotypeSettings = z.object({
  workdayWakeTime: z.string().nullable(),
  freeDayWakeTime: z.string().nullable(),
}).strict()
export type ChronotypeSettings = z.infer<typeof ChronotypeSettings>

export const ChronotypeSettingsPatch = z.object({
  workdayWakeTime: z.string().nullable().optional(),
  freeDayWakeTime: z.string().nullable().optional(),
}).strict()
export type ChronotypeSettingsPatch = z.infer<typeof ChronotypeSettingsPatch>

export const SyncSettings = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().positive(),
}).strict()
export type SyncSettings = z.infer<typeof SyncSettings>

export const SyncSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().positive().max(7 * 24 * 60).optional(),
}).strict()
export type SyncSettingsPatch = z.infer<typeof SyncSettingsPatch>

export const SettingsPublic = z.object({
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(),
  text: ModelSettingsPublic,
  vision: ModelSettingsPublic,
  ruc: RucSettings,
  chronotype: ChronotypeSettings,
  sync: SyncSettings,
}).strict()
export type SettingsPublic = z.infer<typeof SettingsPublic>

export const SettingsPatch = z.object({
  revision: z.number().int().nonnegative(),
  text: ModelSettingsPatch.optional(),
  vision: ModelSettingsPatch.optional(),
  ruc: RucSettingsPatch.optional(),
  chronotype: ChronotypeSettingsPatch.optional(),
  sync: SyncSettingsPatch.optional(),
}).strict()
export type SettingsPatch = z.infer<typeof SettingsPatch>

export const SettingsResponse = z.object({ settings: SettingsPublic, sync: SyncStatus }).strict()
export type SettingsResponse = z.infer<typeof SettingsResponse>
