import type { ParsedMail } from 'mailparser'
import type { MailAccount } from '../store/mail-accounts.ts'

/**
 * 学校与私人邮箱。
 *
 * 人大的邮箱是网易企业邮箱的一份部署，IMAP 在 `imap.ruc.edu.cn:993`。**密码不是
 * 登录密码，是邮箱设置里那串「客户端授权码」**——网易那套默认不许拿登录密码走
 * IMAP，填错了服务端只回一句认证失败，看不出是这个原因。
 *
 * 走 IMAP 而不是 POP3，理由不在协议在产品：POP3 拿不到 `\Seen`。「只读你还没处理
 * 过的」这条规矩完全建立在服务端的已读标记上，换成 POP3 就只能靠自己的水位猜，
 * 结果是昨晚已经读完并处理掉的邮件明早又被喂一遍。
 *
 * 与门户那条路不同，这里必须有一份密码：IMAP 没有别的凭据形式。密文落库、明文
 * 只在内存（见 secrets.ts），钥匙在系统钥匙串里。
 *
 * **读哪些邮件是个感受问题，不只是技术问题。** 定的规矩是：只读收件箱里未读的、
 * 且比水位新的，每轮至多几封。不翻历史、不读已读。
 */
export type MailMessage = {
  /** IMAP 的 UID。在一个邮箱里稳定且递增，是「读到哪儿了」的水位 */
  uid: number
  /** 发件人、主题、正文拼成的一段文本，直接进管道 */
  text: string
}

export function describeMailbox(account: MailAccount): string {
  return `邮件（${account.username}）`
}

/**
 * 收件箱里未读、且 UID 大于水位的那几封。
 *
 * **水位不能用「已读」来代替。** 标记已读是用户自己的动作，替他标掉，他的收件箱
 * 就少了一条本来会看见的未读。所以我们自己记读到哪儿了，一封邮件的读没读跟我们
 * 处理没处理是两件事。
 */
export async function fetchMail(
  account: MailAccount, password: string,
): Promise<MailMessage[]> {
  return withMailbox(account, password, async (client) => {
    const unseen = await client.search({ seen: false }, { uid: true })
    if (unseen === false || unseen.length === 0) return []

    // 最新的几封。更老的未读邮件多半是用户自己决定不看的，不该由我们代读。
    const wanted = unseen
      .filter((uid) => uid > account.watermark)
      .sort((a, b) => a - b)
      .slice(-account.perRun)
    if (wanted.length === 0) return []

    const { simpleParser } = await import('mailparser')
    const messages: MailMessage[] = []
    for await (const message of client.fetch(wanted, { source: true, uid: true }, { uid: true })) {
      if (message.source === undefined) {
        throw new Error(`邮件 UID ${message.uid} 请求了原文却没有拿到`)
      }
      const parsed: ParsedMail = await simpleParser(message.source)
      const from = parsed.from?.text ?? '未知发件人'
      const subject = parsed.subject ?? '（无主题）'
      const body = (parsed.text ?? '').trim()
      messages.push({
        uid: message.uid,
        text: [`${from}\n${subject}`, body].filter((s) => s !== '').join('\n\n'),
      })
    }
    return messages
  })
}

/**
 * 连一次、数一下未读，然后断开。设置页上那个「测试连接」。
 *
 * 值得单独有一个：认证失败、主机写错、端口不对、授权码填成了登录密码，四种在
 * 同步日志里长得一模一样（「同步失败」），而它们的下一步完全不同。加账号的时候
 * 当场问一次，比等六小时后在状态行上看见一句话有用得多。
 */
export async function testMailbox(
  account: MailAccount, password: string,
): Promise<{ unseen: number }> {
  return withMailbox(account, password, async (client) => {
    const unseen = await client.search({ seen: false }, { uid: true })
    return { unseen: unseen === false ? 0 : unseen.length }
  })
}

/**
 * 把 imapflow 的错误翻成一句能照着办的话。
 *
 * **不翻的话它是一句「Command failed」**，认证被拒、邮箱被锁、服务端不高兴，
 * 三种长得一模一样。真正有用的东西在 `responseText` 里——那是服务端自己写的
 * 那一行，比我们能编的任何话都准。
 */
function describeMailError(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const detail = e as Error & {
    responseText?: string
    authenticationFailed?: boolean
    code?: string
  }

  if (detail.authenticationFailed === true) {
    // 这是最常见的一种，而它的原因几乎总是同一个：填了登录密码而不是授权码。
    return `认证被拒${detail.responseText ? `：${detail.responseText}` : ''}。` +
      `密码要填邮箱设置里的客户端授权码，不是登录密码。`
  }
  if (detail.responseText !== undefined && detail.responseText !== '') return detail.responseText
  if (detail.code !== undefined) return `${detail.code}：${e.message}`
  return e.message
}

async function withMailbox<T>(
  account: MailAccount, password: string,
  body: (client: import('imapflow').ImapFlow) => Promise<T>,
): Promise<T> {
  /*
   * imapflow 与 mailparser 在第一次真要读邮件时才载入。
   *
   * 它们连同一整套 MIME 与字符集表被打进 Electron 主进程那个 bundle，而邮件是
   * 一条要用户自己去配的来源。写成顶层 import 的话，这一大坨里任何一处在打包后
   * 出问题，整个应用会连窗口都开不出来。
   */
  const { ImapFlow } = await import('imapflow')

  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user: account.username, pass: password },
    // 这个库默认往 stdout 打整条 IMAP 会话，里面带着邮件主题。
    logger: false,
  })

  try {
    await client.connect()
  } catch (e) {
    // 连接与认证的失败在这里就翻成人话。这一层拥有它，上面不再包一次。
    throw new Error(describeMailError(e))
  }

  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      return await body(client)
    } finally {
      lock.release()
    }
  } catch (e) {
    throw new Error(describeMailError(e))
  } finally {
    // 断开本身失败不该盖掉真正的原因：上面那个错误才是用户要看的。
    await client.logout().catch(() => {})
  }
}
