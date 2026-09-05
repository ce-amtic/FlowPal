import { BrowserWindow, session } from 'electron'

/**
 * 人大门户的登录窗口。
 *
 * **这是全程序唯一一次真人登录，密码不经过我们的手。** CAS 的登录页上挂着图形
 * 验证码、短信验证码、人脸，密码还在前端加过一道；无头重放那套表单是在猜一个
 * 随时会变的东西，猜错的代价是真实账号被锁。所以这里开的是一个真的浏览器窗口，
 * 用户在里面登录，我们只把那次登录留下的 Cookie 搬走。
 *
 * 会话放在一个持久分区里。**这不是为了省事，是为了让「重新登录」多数时候不用输
 * 密码**：票据授予 Cookie 活得比子系统会话久得多，下次再打开这个窗口时 CAS 往往
 * 连密码都不问就放行，那一下「登录」实际做的事就是重新采集一遍。
 */
const PARTITION = 'persist:ruc'
const ENTRY = 'https://my.ruc.edu.cn/'
const PROBE = 'https://my.ruc.edu.cn/sopplus/_web/portal/api/user/loginInfo.rst'
const CAS_LOGIN = 'https://cas.ruc.edu.cn/cas/login'

export type SignInResult = { ok: true; saved: number } | { ok: false; message: string }

/**
 * 开窗口，等到门户认得这个会话为止，把 Cookie 交给 server。
 *
 * 判据是**探针跟完重定向之后停在哪儿**，不是窗口的地址栏。持有效凭据访问门户时
 * 链条同样会经过 CAS，只是立刻带票跳回来；盯着地址栏会把正常的换票过程当成还没
 * 登录，也会把「刚跳回门户但会话还没建好」当成已经登录。
 */
export async function signInToRuc(serverUrl: string, token: string | null): Promise<SignInResult> {
  const rucSession = session.fromPartition(PARTITION)

  const win = new BrowserWindow({
    width: 520,
    height: 760,
    title: '登录人大门户',
    autoHideMenuBar: true,
    webPreferences: { partition: PARTITION },
  })
  await win.loadURL(ENTRY)

  try {
    const signedIn = await waitForSession(rucSession, win)
    if (!signedIn) return { ok: false, message: '登录窗口关闭了，没有完成登录' }

    const cookies = await rucSession.cookies.get({})
    const forSchool = cookies
      .filter((c) => c.domain !== undefined && c.domain.replace(/^\./, '').endsWith('ruc.edu.cn'))
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain!,
        path: c.path ?? '/',
        secure: c.secure ?? false,
        httpOnly: c.httpOnly ?? false,
        expirationDate: c.expirationDate,
      }))

    const res = await fetch(`${serverUrl}/api/sync/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ cookies: forSchool }),
    })
    if (!res.ok) return { ok: false, message: `登录态没能交给 server：${await res.text()}` }
    return { ok: true, saved: ((await res.json()) as { saved: number }).saved }
  } finally {
    if (!win.isDestroyed()) win.close()
  }
}

/**
 * 每两秒探一次，直到会话可用或者用户关掉窗口。
 *
 * 不设总超时：登录可能要等一条短信，也可能用户先去开了别的东西。窗口还开着就说明
 * 这件事还在进行中，替他决定「太久了」只会在他刚收到验证码的时候把窗口收走。
 */
function waitForSession(
  rucSession: Electron.Session, win: BrowserWindow,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearInterval(timer)
      resolve(ok)
    }

    win.once('closed', () => finish(false))

    const timer = setInterval(() => {
      void (async () => {
        // 用这个分区自己的 fetch，它带的正是登录窗口里那批 Cookie。
        const landing = await rucSession.fetch(PROBE, { redirect: 'follow' }).catch(() => null)
        if (landing === null) return
        if (!landing.url.startsWith(CAS_LOGIN)) finish(true)
      })()
    }, 2000)
  })
}
