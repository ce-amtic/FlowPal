/**
 * 邮箱授权码的明文，只在内存里。
 *
 * 盘上只有密文（`mail_accounts.password_cipher`），钥匙在系统钥匙串里；而 server
 * 不依赖 Electron，所以**它自己解不开那份密文**。明文从两个地方进来，都在桌面端
 * 那一侧解密：
 *
 *   - 用户在设置页新加或改一个账号时，跟密文一起送来；
 *   - 桌面端每次启动时，把库里的密文解开一批推进来。
 *
 * 进程退出就没了，不写盘、不进日志。所以 `pnpm dev:server` 单跑时这里是空的，
 * 邮箱那一路会明说「需要在桌面应用里解锁」——这是正确的，不是缺陷：那台机器上
 * 没有能解开钥匙串的东西。
 */
export class MailSecrets {
  private readonly byAccount = new Map<string, string>()

  unlock(accountId: string, password: string): void {
    if (password === '') throw new Error(`账号 ${accountId} 的授权码是空的`)
    this.byAccount.set(accountId, password)
  }

  get(accountId: string): string | null {
    return this.byAccount.get(accountId) ?? null
  }

  forget(accountId: string): void {
    this.byAccount.delete(accountId)
  }

  /** 哪些账号现在能用。设置页据此显示「需要在桌面应用里解锁」。 */
  has(accountId: string): boolean {
    return this.byAccount.has(accountId)
  }
}
