import { useEffect, useMemo, useState } from 'react'
import type { SettingsPublic, SyncStatus } from '@flowpal/shared'
import { ApiError, api } from '../../api.ts'
import './settings.css'

type EditableSettings = Pick<SettingsPublic, 'text' | 'vision' | 'ruc' | 'chronotype' | 'sync'>

const EMPTY_SETTINGS: SettingsPublic = {
  revision: 0,
  updatedAt: null,
  text: { baseUrl: '', model: '', apiKeyConfigured: false },
  vision: { baseUrl: '', model: '', apiKeyConfigured: false },
  ruc: { authorized: false, role: null, lastSessionAt: null },
  chronotype: { workdayWakeTime: null, freeDayWakeTime: null },
  sync: { enabled: false, intervalMinutes: 360 },
}

export function SettingsView() {
  const [settings, setSettings] = useState<SettingsPublic>(EMPTY_SETTINGS)
  const [draft, setDraft] = useState<SettingsPublic>(EMPTY_SETTINGS)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [status, setStatus] = useState<'loading' | 'clean' | 'dirty' | 'saving' | 'saved' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)

  const dirty = useMemo(() => JSON.stringify(settings) !== JSON.stringify(draft), [settings, draft])

  useEffect(() => {
    let alive = true
    Promise.allSettled([api.getSettings(), api.getSyncStatus()]).then(([settingsResult, syncResult]) => {
      if (!alive) return
      if (settingsResult.status === 'fulfilled') {
        setSettings(settingsResult.value.settings)
        setDraft(settingsResult.value.settings)
        setStatus('clean')
      } else {
        setStatus('error')
        setMessage('设置尚未连接到本地服务；可以先查看页面结构。')
      }
      if (syncResult.status === 'fulfilled') setSync(syncResult.value.status)
    })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (status === 'clean' || status === 'saved') setStatus(dirty ? 'dirty' : 'clean')
  }, [dirty, status])

  function update<K extends keyof EditableSettings>(section: K, patch: Partial<EditableSettings[K]>) {
    setDraft((current) => ({ ...current, [section]: { ...current[section], ...patch } }))
  }

  async function save() {
    if (!dirty || status === 'saving') return
    setStatus('saving')
    setMessage(null)
    try {
      const result = await api.saveSettings({
        revision: settings.revision,
        text: {
          baseUrl: draft.text.baseUrl,
          model: draft.text.model,
          apiKeyAction: 'keep',
        },
        vision: {
          baseUrl: draft.vision.baseUrl,
          model: draft.vision.model,
          apiKeyAction: 'keep',
        },
        chronotype: draft.chronotype,
        sync: draft.sync,
      })
      setSettings(result.settings)
      setDraft(result.settings)
      setSync(result.sync)
      setStatus('saved')
      setMessage('已保存。')
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && isSettingsConflict(cause.body)) {
        // Another window saved a newer revision. Keep the user's local draft,
        // but refresh the server baseline and sync summary so the next save
        // carries the current revision instead of overwriting newer changes.
        const latest = await api.getSettings().catch(() => null)
        const latestSettings = latest?.settings ?? cause.body.settings
        setSettings(latestSettings)
        // Rebase only fields the user actually changed onto the newer server
        // draft. Unchanged fields from another window must not be written back
        // as stale values on the next save.
        setDraft(rebaseDraft(settings, draft, latestSettings))
        if (latest) {
          setSync(latest.sync)
        } else {
          const latestSync = await api.getSyncStatus().catch(() => null)
          if (latestSync) setSync(latestSync.status)
        }
        setStatus('dirty')
        setMessage('设置已在另一窗口更新；已刷新版本，请检查后再次保存。')
        return
      }
      setStatus('error')
      setMessage(toMessage(cause))
    }
  }

  async function runSync(mode: 'online' | 'fixture') {
    if (syncing) return
    setSyncing(true)
    setMessage(null)
    try {
      const result = await api.runSync(null, mode)
      const next = await api.getSyncStatus()
      setSync(next.status)
      const run = result.run
      if (run?.status === 'succeeded') {
        setMessage(`已导入 ${run.importedCount} 条 RUC 记录；原始结构化数据已保留。`)
      } else if (run?.status === 'unsupported') {
        setMessage(run.errorMessage ?? '在线 RUC 连接器尚未接入；可以先导入离线样例。')
      } else if (run?.status === 'failed') {
        setMessage(run.errorMessage ?? 'RUC 同步失败；保留上一次成功结果。')
      } else {
        setMessage('同步请求已记录；完成后会保留上次成功结果。')
      }
    } catch (cause) {
      setMessage(toMessage(cause))
    } finally {
      setSyncing(false)
    }
  }

  async function openRucLogin() {
    // Keep the action visible without pretending that a local route is a
    // login broker.  The Electron-owned CAS/WebView seam is deliberately
    // explicit until it can persist a protected session and report its role.
    setMessage('当前构建尚未接入 RUC 登录 broker；可以先导入离线样例验证同步链路。')
  }

  return (
    <section className="settings-page" aria-labelledby="settings-title">
      <div className="settings-heading">
        <div>
          <p className="eyebrow">设置</p>
          <h1 id="settings-title">让 FlowPal 知道怎么帮你</h1>
        </div>
        <button type="button" className="save-button" disabled={!dirty || status === 'saving'} onClick={() => void save()}>
          {status === 'saving' ? '保存中…' : '保存'}
        </button>
      </div>

      {message && <p className={`settings-message${status === 'error' ? ' error' : ''}`} role="status">{message}</p>}

      <div className="settings-sections">
        <section className="settings-section" aria-labelledby="model-settings">
          <h2 id="model-settings">模型</h2>
          <p className="section-note">只保存连接地址和模型名。密钥由桌面端安全存储，不会回显。</p>
          <ModelFields label="文本模型" value={draft.text} onChange={(patch) => update('text', patch)} />
          <ModelFields label="视觉模型" value={draft.vision} onChange={(patch) => update('vision', patch)} />
        </section>

        <section className="settings-section" aria-labelledby="ruc-settings">
          <div className="section-heading-row">
            <h2 id="ruc-settings">RUC 教务</h2>
            <span className={`state-pill ${draft.ruc.authorized ? 'ok' : ''}`}>
              {draft.ruc.authorized ? '已授权' : '未授权'}
            </span>
          </div>
          <p className="section-note">登录入口已保留；RUC broker 尚未接入当前构建，不会把密码写入 server。</p>
          <dl className="facts">
            <div><dt>角色</dt><dd>{roleLabel(draft.ruc.role)}</dd></div>
            <div><dt>上次会话</dt><dd>{draft.ruc.lastSessionAt ? formatTimestamp(draft.ruc.lastSessionAt) : '尚未登录'}</dd></div>
          </dl>
          <button type="button" onClick={() => void openRucLogin()}>{draft.ruc.authorized ? '重新授权' : '登录 RUC（待接入）'}</button>
          <div className="capabilities" aria-label="RUC 能力">
            {(sync?.capabilities ?? defaultCapabilities()).map((capability) => (
              <span key={capability.source} className="capability">
                {capability.source === 'ruc.graduate' ? '研究生课表' : '门户日程'}：{capabilityLabel(capability.status)}
              </span>
            ))}
            <span className="capability muted">本科课表 / 考试：暂不支持</span>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="chronotype-settings">
          <h2 id="chronotype-settings">你的作息</h2>
          <p className="section-note">只问两件事；数据不足时会明确写“还在学”，不会假装测量。</p>
          <div className="two-fields">
            <label>工作日通常几点起床<input type="time" value={draft.chronotype.workdayWakeTime ?? ''} onChange={(e) => update('chronotype', { workdayWakeTime: e.target.value || null })} /></label>
            <label>休息日通常几点起床<input type="time" value={draft.chronotype.freeDayWakeTime ?? ''} onChange={(e) => update('chronotype', { freeDayWakeTime: e.target.value || null })} /></label>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="sync-settings">
          <div className="section-heading-row">
            <h2 id="sync-settings">同步</h2>
            <div className="sync-actions">
              <button type="button" disabled={syncing} onClick={() => void runSync('online')}>{syncing ? '同步中…' : '立即同步'}</button>
              <button type="button" className="secondary" disabled={syncing} onClick={() => void runSync('fixture')}>导入离线样例</button>
            </div>
          </div>
          <label className="switch-row"><input type="checkbox" checked={draft.sync.enabled} onChange={(e) => update('sync', { enabled: e.target.checked })} />
            <span>启用定时同步</span>
          </label>
          <p className="section-note">当前间隔：{Math.round(draft.sync.intervalMinutes / 60)} 小时。在线连接器尚未接入时不会伪报成功；离线样例仅用于验证导入链路。</p>
          {sync?.recentRuns?.[0] && <p className="sync-result">上次同步 {formatTimestamp(sync.recentRuns[0].startedAt)} · {syncStatusLabel(sync.recentRuns[0].status)}</p>}
        </section>
      </div>
    </section>
  )
}

function ModelFields({
  label, value, onChange,
}: {
  label: string
  value: SettingsPublic['text']
  onChange: (patch: Partial<SettingsPublic['text']>) => void
}) {
  return (
    <div className="model-fields">
      <h3>{label}</h3>
      <label>Base URL<input value={value.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} placeholder="https://…/v1" /></label>
      <label>模型名<input value={value.model} onChange={(e) => onChange({ model: e.target.value })} placeholder="模型名称" /></label>
      <p className="secret-state">API key：{value.apiKeyConfigured ? '已配置' : '未配置'}（不在此页显示）</p>
    </div>
  )
}

function roleLabel(role: SettingsPublic['ruc']['role']): string {
  return role === 'graduate' ? '研究生' : role === 'undergraduate' ? '本科生' : '待识别'
}

function capabilityLabel(status: string): string {
  return status === 'available' ? '可用' : status === 'unauthorized' ? '需登录' : status === 'error' ? '出错' : '暂不支持'
}

function syncStatusLabel(status: string): string {
  return status === 'succeeded'
    ? '成功'
    : status === 'running'
      ? '进行中'
      : status === 'partial'
        ? '部分完成'
        : status === 'unsupported'
          ? '暂不支持'
          : '失败'
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function defaultCapabilities(): Array<{ source: 'ruc.portal' | 'ruc.graduate'; status: 'error' }> {
  return [
    { source: 'ruc.portal', status: 'error' },
    { source: 'ruc.graduate', status: 'error' },
  ]
}

function isSettingsConflict(value: unknown): value is { settings: SettingsPublic } {
  if (!value || typeof value !== 'object') return false
  const settings = (value as Record<string, unknown>).settings
  if (!settings || typeof settings !== 'object') return false
  const draft = settings as Record<string, unknown>
  const revision = draft.revision
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0
    && isRecord(draft.text) && isRecord(draft.vision)
    && isRecord(draft.ruc) && isRecord(draft.chronotype) && isRecord(draft.sync)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function rebaseDraft(
  previous: SettingsPublic,
  draft: SettingsPublic,
  latest: SettingsPublic,
): SettingsPublic {
  const next: SettingsPublic = {
    ...latest,
    text: { ...latest.text },
    vision: { ...latest.vision },
    ruc: { ...latest.ruc },
    chronotype: { ...latest.chronotype },
    sync: { ...latest.sync },
  }
  const sections = ['text', 'vision', 'ruc', 'chronotype', 'sync'] as const
  for (const section of sections) {
    const oldSection = previous[section] as Record<string, unknown>
    const draftSection = draft[section] as Record<string, unknown>
    const nextSection = next[section] as Record<string, unknown>
    for (const key of Object.keys(draftSection)) {
      if (JSON.stringify(draftSection[key]) !== JSON.stringify(oldSection[key])) {
        nextSection[key] = draftSection[key]
      }
    }
  }
  return next
}

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
