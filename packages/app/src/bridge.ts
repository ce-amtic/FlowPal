/**
 * window.flowpal —— 主进程暴露的四个方法，加一份浏览器 mock。
 *
 * 有 mock 的意义是界面全程可以在普通浏览器标签页里开发，不启动 Electron，
 * 于是界面这条线不被主进程那条线阻塞。
 */
export type SignInResult = { ok: true; saved: number } | { ok: false; message: string }

export type FlowpalBridge = {
  /** 主进程的 process.platform。窗口底色与窗口按钮的位置按平台分，不能一概而论 */
  platform: string
  onHotkeyOpen: (cb: () => void) => void
  onFilesDropped: (cb: (paths: string[]) => void) => void
  readClipboard: () => Promise<string>
  hideWindow: () => Promise<void>
  /**
   * 开一个真的浏览器窗口登录人大门户，把那次登录留下的 Cookie 交给 server。
   *
   * 走 IPC 而不是 HTTP，是因为它需要一个浏览器窗口——分界线仍是「手机端将来要不要
   * 得起」，而手机端要不起这个。同步本身要得起，所以那条走 HTTP。
   */
  signInToRuc: () => Promise<SignInResult>
  /**
   * 把邮箱授权码交给系统钥匙串加密，拿回一段 base64 密文。
   *
   * 界面拿到密文之后，连同明文一起 POST 给 server：**落库的是密文，明文只进内存**。
   * 同一条请求里两样都有看着多余，其实不是——加密防的是盘上被读走，不是这一跳。
   */
  encryptSecret: (plain: string) => Promise<EncryptResult>
}

export type EncryptResult = { ok: true; cipher: string } | { ok: false; message: string }

declare global {
  interface Window { flowpal?: FlowpalBridge }
}

const browserMock: FlowpalBridge = {
  platform: 'browser',
  onHotkeyOpen: () => {},
  onFilesDropped: () => {},
  readClipboard: () => navigator.clipboard.readText(),
  hideWindow: async () => {},
  // 浏览器标签页里开不出登录窗口。说清楚而不是假装成功——设置页据此显示
  // 「登录要在桌面应用里做」，而不是转一圈之后仍然没有登录态。
  signInToRuc: async () => ({ ok: false, message: '登录要在桌面应用里做' }),
  // 浏览器标签页里没有系统钥匙串。说清楚而不是退回明文——用户看见的「已加密」
  // 是我们说的，悄悄降级等于说了谎。
  encryptSecret: async () => ({ ok: false, message: '邮箱要在桌面应用里配置' }),
}

export const bridge: FlowpalBridge = window.flowpal ?? browserMock
export const inElectron = window.flowpal !== undefined
/** 只有 macOS 有窗口毛玻璃和左上角红绿灯。其余平台两样都没有，界面得知道 */
export const onMac = bridge.platform === 'darwin'
