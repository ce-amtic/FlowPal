import { useEffect, useState } from 'react'

export type AppRoute = {
  path: string
  search: URLSearchParams
}

function readRoute(): AppRoute {
  const raw = window.location.hash.replace(/^#/, '') || '/now'
  const [pathPart, query = ''] = raw.split('?')
  const path = pathPart?.startsWith('/') ? pathPart : `/${pathPart ?? 'now'}`
  return { path: path || '/now', search: new URLSearchParams(query) }
}

/** Small dependency-free hash router until the shared shell installs its router. */
export function useAppRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() => readRoute())

  useEffect(() => {
    const update = () => setRoute(readRoute())
    window.addEventListener('hashchange', update)
    if (!window.location.hash) window.location.hash = '/now'
    return () => window.removeEventListener('hashchange', update)
  }, [])

  return route
}

export function navigate(path: string): void {
  const normalized = path.startsWith('/') ? path : `/${path}`
  if (`#${normalized}` === window.location.hash) return
  window.location.hash = normalized
}
