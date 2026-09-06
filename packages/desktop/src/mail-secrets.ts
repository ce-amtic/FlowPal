import { safeStorage } from 'electron'

/**
 * 邮箱授权码的加解密。**全仓库只有这一处能碰钥匙串**，所以也只有这一处解得开
 * 落在库里的那份密文。
 *
 * 分工是这么定的：钥匙在系统钥匙串里，密文在 SQLite 里，明文只在 server 进程的
 * 内存里。拿到 `flowpal.db` 不等于拿到授权码——那正是选钥匙串而不是明文入库的
 * 全部理由。
 *
 * 代价要说清楚：`pnpm dev:server` 单跑时没有这一侧，于是没有明文，邮箱那一路会
 * 明说「需要在桌面应用里解锁」。这不是缺陷，是那台进程上确实没有钥匙。
 */
function assertAvailable(): void {
  if (safeStorage.isEncryptionAvailable()) return
  /*
   * Linux 上没有可用钥匙环时会走到这儿。**不退回明文存盘**——用户之所以看见
   * 「已加密」这句话，是因为我们说了；悄悄降级等于说了谎。
   */
  throw new Error('系统钥匙串不可用，没法安全地存授权码')
}

export function encryptSecret(plain: string): string {
  assertAvailable()
  return safeStorage.encryptString(plain).toString('base64')
}

export function decryptSecret(cipher: string): string {
  assertAvailable()
  return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
}

/**
 * 冷启动时把库里的密文解开一批，交还给 server。
 *
 * 一条解不开不该拖住别的：换过机器、重装过系统、钥匙串条目被删掉，都会让某一条
 * 变成解不开的字节。那一条留在锁着的状态、在设置页上显示出来，用户重填一次授权码
 * 就好；别的账号照常工作。
 */
export async function unlockAll(serverUrl: string, token: string | null): Promise<number> {
  const headers: Record<string, string> = token === null ? {} : { Authorization: `Bearer ${token}` }

  const res = await fetch(`${serverUrl}/api/mail-accounts/locked`, { headers })
  if (!res.ok) throw new Error(`取锁着的邮箱账号失败：${await res.text()}`)
  const { accounts } = await res.json() as { accounts: { id: string; passwordCipher: string }[] }
  if (accounts.length === 0) return 0

  const unlocked: Record<string, string> = {}
  for (const account of accounts) {
    try {
      unlocked[account.id] = decryptSecret(account.passwordCipher)
    } catch (e) {
      console.error(`邮箱账号 ${account.id} 的授权码解不开，它会停在未解锁：`, e)
    }
  }
  if (Object.keys(unlocked).length === 0) return 0

  const put = await fetch(`${serverUrl}/api/mail-accounts/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(unlocked),
  })
  if (!put.ok) throw new Error(`解锁邮箱账号失败：${await put.text()}`)
  return Object.keys(unlocked).length
}
