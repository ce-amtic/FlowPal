import type { RucCookies } from './cookies.ts'

/**
 * 学校系统的 HTTP 客户端。
 *
 * 两件事决定了它不能是一句 `fetch`：
 *
 * 1. **必须逐跳跟随重定向。** 单点登录就是一串带 Set-Cookie 的 302，各子系统的
 *    会话正是在这些跳转里被签发的。交给运行时自动跟随的话，中间那些 Set-Cookie
 *    不经过我们的 Cookie 罐，会话建不起来——而且不报错，只是下一个请求又停在登录页。
 * 2. **失效判据作用于链条终点，不作用于中间跳转。** 持有效凭据访问任何子系统，
 *    链条同样会经过认证方，只是立刻带票跳回来。以「是否跳向登录页」判断，会把
 *    正常的换票过程误判成会话失效。
 *
 * 两条都是既有 Flutter/Dart 实现真机实测过的结论，不是推想。
 */

const MAX_HOPS = 10

/**
 * 取自桌面浏览器。不带 UA 时校内有些站点前面的 WAF 直接 403，
 * 而那个 403 长得像接口坏了。
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 登录态失效，需要用户重新登录。这是同步这条路上唯一要求用户介入的失败。 */
export class SessionExpired extends Error {
  constructor(readonly url: string, readonly terminal: string) {
    super(`人大门户的登录态已失效：${url} → ${terminal}`)
    this.name = 'SessionExpired'
  }
}

export type Hop = { status: number; url: string }

export type Landing = {
  /** 重定向链实际停下的地址。判断问题出在哪一环全靠它 */
  terminal: URL
  status: number
  body: string
}

export class RucHttp {
  constructor(private readonly cookies: RucCookies) {}

  /**
   * 走完一个地址的重定向链，返回终点。
   *
   * 不套用任何失效判据——判据是各系统自己的事，见 portal.ts。
   */
  async follow(url: string, hops?: Hop[]): Promise<Landing> {
    let current = new URL(url)
    let referer = `${current.origin}/`

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const res = await fetch(current, {
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'zh-CN,zh;q=0.9',
          // 刻意不加 X-Requested-With：实测同一个未登录请求，不带它返回 302 跳认证方，
          // 带上则返回 401 且不跳转。整个换票流程依赖跟随那个 302。
          Referer: referer,
          Cookie: this.cookies.header(current.toString()),
        },
      })
      this.cookies.absorb(current.toString(), res.headers.getSetCookie())
      hops?.push({ status: res.status, url: current.toString() })

      if (res.status < 300 || res.status >= 400) {
        return { terminal: current, status: res.status, body: await res.text() }
      }

      const location = res.headers.get('location')
      if (location === null) {
        throw new Error(`${current} 返回 ${res.status}，但响应里没有 Location 头`)
      }
      referer = current.toString()
      current = new URL(location, current)
    }

    throw new Error(`${url} 的重定向超过 ${MAX_HOPS} 跳，疑似循环`)
  }
}

/** 把落地页当 JSON 读。读不出来时把开头一段带上——光说「解析失败」查不出是哪一种失败。 */
export function asJson(landing: Landing, what: string): unknown {
  try {
    return JSON.parse(landing.body)
  } catch {
    const head = landing.body.slice(0, 200)
    throw new Error(
      `${what} 返回的不是 JSON：${landing.terminal} HTTP ${landing.status}，开头是 ${head}`,
    )
  }
}
