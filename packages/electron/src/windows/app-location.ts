import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type AppLocation =
  | { mode: 'dev'; url: string }
  | { mode: 'file'; distDir: string }

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function assertSafeDevUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`FLOWPAL_APP_URL 不是有效 URL：${value}`)
  }
  const local = parsed.protocol === 'http:'
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]' || parsed.hostname === '::1')
  if (!local && process.env.FLOWPAL_ALLOW_REMOTE_APP !== '1') {
    throw new Error('FLOWPAL_APP_URL 默认只允许本机 Vite；若确需远端开发地址，请显式设置 FLOWPAL_ALLOW_REMOTE_APP=1。')
  }
  return parsed.toString()
}

/**
 * Resolve the app renderer independently of whether Electron is launched from
 * the workspace (`electron packages/electron`) or from an asar bundle.  An
 * explicit FLOWPAL_APP_URL/FLOWPAL_APP_DIST always wins, which also makes CI
 * and packaged smoke tests deterministic.
 */
export function resolveAppLocation(appPath: string, isPackaged: boolean): AppLocation {
  const devUrl = nonEmpty(process.env.FLOWPAL_APP_URL)
  const explicitDist = nonEmpty(process.env.FLOWPAL_APP_DIST)
  if (!isPackaged && explicitDist) {
    const distDir = resolve(explicitDist)
    if (!existsSync(join(distDir, 'index.html'))) {
      throw new Error(`FLOWPAL_APP_DIST 不包含 index.html：${distDir}`)
    }
    return { mode: 'file', distDir }
  }
  if (!isPackaged && devUrl) return { mode: 'dev', url: assertSafeDevUrl(devUrl) }
  if (!isPackaged) return { mode: 'dev', url: 'http://localhost:5173' }

  const candidates = [
    explicitDist,
    join(appPath, 'packages', 'app', 'dist'),
    join(appPath, '..', 'app', 'dist'),
    join(appPath, '..', '..', 'packages', 'app', 'dist'),
    join(dirname(appPath), 'app', 'dist'),
  ].filter((candidate): candidate is string => Boolean(candidate))

  const distDir = candidates.map((candidate) => resolve(candidate)).find((candidate) => existsSync(join(candidate, 'index.html')))
  if (!distDir) {
    throw new Error([
      '找不到 FlowPal app dist。',
      '先运行 `pnpm --filter @flowpal/app build`，或设置 FLOWPAL_APP_DIST 指向包含 index.html/pet.html 的目录。',
    ].join(' '))
  }
  return { mode: 'file', distDir }
}

export function assertPetEntry(location: AppLocation): void {
  if (location.mode === 'dev') return
  if (!existsSync(join(location.distDir, 'pet.html'))) {
    throw new Error(`桌宠入口缺失：${join(location.distDir, 'pet.html')}。请重新构建 @flowpal/app。`)
  }
}

export function isAllowedAppNavigation(location: AppLocation, candidate: string): boolean {
  try {
    const url = new URL(candidate)
    if (location.mode === 'dev') {
      return url.origin === new URL(location.url).origin
    }
    if (url.protocol !== 'file:') return false
    // URL.pathname is slash-prefixed and URL-encoded on Windows (for
    // example `/C:/FlowPal/...`), so comparing it directly with a native
    // `C:\...` distDir rejects legitimate in-app navigations. Convert the
    // file URL through the platform-aware Node helper before resolving.
    const path = resolve(fileURLToPath(url))
    const root = resolve(location.distDir)
    const relativePath = relative(root, path)
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  } catch {
    return false
  }
}
