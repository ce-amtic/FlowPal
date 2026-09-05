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
    return this.count === 0
  }

  header(url: string): string {
    return this.jar.getCookieStringSync(url)
  }

  /**
   * 服务端下发的 Set-Cookie。逐跳跟随时每一跳都要过这里，SSO 的会话就是在跳转里
   * 签发的。
   *
   * **这里是全模块唯一一处「收不下就算了」，理由是这批数据不归我们管**：属性畸形
   * 或作用域对不上的 Set-Cookie 是服务端发的，我们改不了，而为其中一条中断整轮
   * 同步换不来任何东西。丢了要紧的那条也不会静悄悄地错——下一个请求会停在登录页，
   * 由失效判据大声说出来。下面 importFromBrowser 里就不是这样：那批数据是我们
   * 自己组的，收不下说明我们组错了。
   */
  absorb(url: string, setCookies: string[]): void {
    for (const raw of setCookies) {
      const cookie = Cookie.parse(raw)
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
   *
   * **收不下就抛，不吞。** 这批数据是我们自己按每条 Cookie 的属性组出来的，
   * 罐子拒收只能说明我们组错了。吞掉的话，一次「登录成功、存了 12 条」之后紧接着
   * 一次「需要重新登录」，而那 12 条里到底进去几条无从知道。
   *
   * 返回的是罐子里真的多出来几条，不是循环跑了几次——这两个数不一样时，是前者
   * 有意义。
   */
  importFromBrowser(cookies: BrowserCookie[]): number {
    const before = this.count

    for (const c of cookies) {
      // Electron 用前导点表示「含子域」，tough-cookie 用 hostOnly=false 表达同一件事。
      const host = c.domain.replace(/^\./, '')
      const path = c.path === '' ? '/' : c.path
      const cookie = new Cookie({
        key: c.name,
        value: c.value,
        domain: host,
        path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        hostOnly: !c.domain.startsWith('.'),
        expires: c.expirationDate === undefined ? 'Infinity' : new Date(c.expirationDate * 1000),
      })
      try {
        this.jar.setCookieSync(cookie, `${c.secure ? 'https' : 'http'}://${host}${path}`)
      } catch (e) {
        // 只报名字与作用域，不报值——值就是登录态本身。
        throw new Error(
          `登录态里的 ${c.name}（${c.domain}${path}）存不进去：${e instanceof Error ? e.message : e}`,
        )
      }
    }

    this.save()
    return this.count - before
  }

  private get count(): number {
    return this.jar.serializeSync()?.cookies.length ?? 0
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
