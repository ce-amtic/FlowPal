import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { Cookie, CookieJar } from 'tough-cookie'

/**
 * 学校系统的登录态，落在一个 JSON 文件里。
 *
 * 登录本身不在这里发生，也不在 server 里发生：CAS 的登录页带验证码、短信码和
 * 一段前端加密的密码，无头重放这套表单是在猜一个会变的东西，而且猜错的代价是
 * 真实账号被锁。所以密码从不进入本程序——用户在一个真的浏览器窗口里登录一次，
 * 那次登录留下的 Cookie 被搬到这里，之后所有取数由 server 自己发出。
 *
 * 搬运的动作在 packages/desktop（它有浏览器），入口是 POST /api/sync/session。
 * server 这一侧只认 Cookie，不知道浏览器存在——这条边界跟别处是同一条。
 */
export class RucCookies {
  private constructor(readonly jar: CookieJar, private readonly path: string) {}

  static open(path: string): RucCookies {
    const jar = new CookieJar()
    if (existsSync(path)) {
      const serialized = JSON.parse(readFileSync(path, 'utf8'))
      return new RucCookies(CookieJar.deserializeSync(serialized), path)
    }
    return new RucCookies(jar, path)
  }

  /** 有没有登录过。空罐子和「登录过但过期了」是两回事，界面上说的话不一样。 */
  get isEmpty(): boolean {
    return this.jar.serializeSync()?.cookies.length === 0
  }

  header(url: string): string {
    return this.jar.getCookieStringSync(url)
  }

  /** 服务端下发的 Set-Cookie。逐跳跟随时每一跳都要过这里，SSO 的会话就是在跳转里签发的。 */
  absorb(url: string, setCookies: string[]): void {
    for (const raw of setCookies) {
      const cookie = Cookie.parse(raw)
      // 解析不了的 Set-Cookie 直接忽略：这不是我们能修的东西，而且丢一条属性畸形的
      // Cookie 不会静悄悄地错——真的缺了它，下一个请求会响亮地停在登录页。
      if (cookie) this.jar.setCookieSync(cookie, url, { ignoreError: true })
    }
  }

  /**
   * 把浏览器里的一批 Cookie 装进罐子。
   *
   * domain / path / secure / httpOnly 原样带过来，不做归一。rucgo 那边被迫把路径
   * 写死在根上（Android 的 CookieManager 只给裸键值对），并因此踩过同名 Cookie
   * 两份并存、服务端读到陈的那一份的坑。Electron 的 cookies API 给的是完整属性，
   * 没有那个约束，所以这里照原样存——同名不同作用域的 Cookie 本来就该各存各的。
   */
  importFromBrowser(cookies: BrowserCookie[]): number {
    let saved = 0
    for (const c of cookies) {
      // Electron 用前导点表示「含子域」，tough-cookie 用 hostOnly=false 表达同一件事。
      const host = c.domain.replace(/^\./, '')
      const cookie = new Cookie({
        key: c.name,
        value: c.value,
        domain: host,
        path: c.path || '/',
        secure: c.secure,
        httpOnly: c.httpOnly,
        hostOnly: !c.domain.startsWith('.'),
        expires: c.expirationDate ? new Date(c.expirationDate * 1000) : 'Infinity',
      })
      const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`
      this.jar.setCookieSync(cookie, url, { ignoreError: true })
      saved += 1
    }
    this.save()
    return saved
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.jar.serializeSync(), null, 2))
  }

  clear(): void {
    this.jar.removeAllCookiesSync()
    if (existsSync(this.path)) rmSync(this.path)
  }
}

/** Electron 的 Cookie 形状。这个类型写在这里是为了 server 不必 import electron。 */
export type BrowserCookie = {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  /** Unix 秒。会话 Cookie 没有这一项 */
  expirationDate?: number
}
