import type { Citation, Item } from '@flowpal/shared'

export type ItemWithSources = Item & {
  sourceFragmentIds: string[]
  citations: Citation[]
}

const BASE = import.meta.env.VITE_SERVER_URL ?? 'http://127.0.0.1:5123'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export const api = {
  listItems: () => call<{ items: ItemWithSources[] }>('/api/items'),

  getItem: (id: string) =>
    call<{ item: ItemWithSources; history: unknown[] }>(`/api/items/${id}`),

  patchItem: (id: string, patch: Record<string, string | null>) =>
    call<{ item: ItemWithSources }>(`/api/items/${id}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }),

  /** 扔一条东西进来。 */
  throwIn: (body: { source: string; rawType: string; rawText?: string; rawBlobPath?: string }) =>
    call<{ fragment: unknown; items: ItemWithSources[] }>('/api/fragments', {
      method: 'POST', body: JSON.stringify(body),
    }),

  getFragment: (id: string) => call<{ fragment: { rawText: string | null } }>(`/api/fragments/${id}`),
}
