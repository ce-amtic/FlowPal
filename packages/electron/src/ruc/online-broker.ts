import { session, type Session } from 'electron'

/**
 * Clean-room RUC transport based on the endpoints verified in RUCGO.
 * Credentials never leave Electron: the server receives only normalized JSON.
 */
export function createRucOnlineBroker(): {
  portalSchedule: () => Promise<unknown>
  graduateTimetable: (term: { code: string; name: string }) => Promise<unknown>
  graduateTerm: () => Promise<{ code: string; name: string }>
} {
  const partition = session.fromPartition('persist:ruc')
  return {
    portalSchedule: () => requestJson(partition, 'https://my.ruc.edu.cn/calendar/mgr/api/ruc/calendarList.rst?categoryIds=0,-2,-5'),
    graduateTerm: async () => {
      const body = await requestForm(partition, 'https://yjs2.ruc.edu.cn/gsapp/sys/wdkbapp/modules/xskcb/kfdxnxqcx.do', {})
      const rows = findRows(body, 'kfdxnxqcx')
      const first = rows[0]
      if (!first || typeof first !== 'object') throw new Error('RUC 未返回可用学期')
      const record = first as Record<string, unknown>
      const code = String(record.XNXQDM ?? '')
      const name = String(record.XNXQDM_DISPLAY ?? code)
      if (!/^\d{5}$/.test(code)) throw new Error('RUC 学期编码格式异常')
      return { code, name }
    },
    graduateTimetable: async (term) => {
      const url = 'https://yjs2.ruc.edu.cn/gsapp/sys/wdkbapp/bykb/loadXskbData.do'
      let response = await requestFormResponse(partition, url, { XNXQDM: term.code })
      if (response.status === 403) {
        await requestText(partition, 'https://yjs2.ruc.edu.cn/gsapp/sys/wdkbapp/*default/index.do')
        response = await requestFormResponse(partition, url, { XNXQDM: term.code })
      }
      return parseResponse(response, '研究生课表')
    },
  }
}

async function cookieHeader(store: Session, url: string): Promise<string> {
  const cookies = await store.cookies.get({ url })
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

async function requestText(store: Session, url: string): Promise<string> {
  const response = await request(store, url, { method: 'GET' })
  return await parseResponse(response, 'RUC') as string
}

async function requestJson(store: Session, url: string): Promise<unknown> {
  const response = await request(store, url, { method: 'GET', headers: { accept: 'application/json' } })
  return parseResponse(response, 'RUC 门户日程')
}

async function requestForm(store: Session, url: string, values: Record<string, string>): Promise<unknown> {
  const response = await requestFormResponse(store, url, values)
  return parseResponse(response, 'RUC 研究生')
}

async function requestFormResponse(store: Session, url: string, values: Record<string, string>): Promise<Response> {
  return request(store, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', accept: 'application/json' },
    body: new URLSearchParams(values).toString(),
  })
}

async function request(store: Session, url: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  const cookies = await cookieHeader(store, url)
  if (cookies) headers.set('cookie', cookies)
  const response = await fetch(url, { ...init, headers, redirect: 'manual' })
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    if (location?.includes('cas.ruc.edu.cn/cas/login')) throw new Error('RUC_SESSION_EXPIRED')
  }
  return response
}

async function parseResponse(response: Response, label: string): Promise<unknown> {
  if (response.status === 401 || response.status === 403) throw new Error(`${label}_UNAUTHORIZED`)
  if (!response.ok) throw new Error(`${label}_HTTP_${response.status}`)
  const text = await response.text()
  try { return JSON.parse(text) as unknown } catch { return text }
}

function findRows(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const candidate = record[key]
  if (Array.isArray(candidate)) return candidate
  if (candidate && typeof candidate === 'object') {
    const rows = (candidate as Record<string, unknown>).rows
    if (Array.isArray(rows)) return rows
  }
  for (const nested of Object.values(record)) {
    const rows = findRows(nested, key)
    if (rows.length > 0) return rows
  }
  return []
}
