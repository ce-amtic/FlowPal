import type { ParsedMail } from 'mailparser'
import type { MailConfig } from '../config.ts'

/**
 * 学校邮箱。
 *
 * 人大的邮箱是网易企业邮箱的一份部署，IMAP 在 `imap.ruc.edu.cn:993`。**密码不是
 * 登录密码，是邮箱设置里那串「客户端授权码」**——网易那套默认不许拿登录密码走
 * IMAP，填错了服务端只回一句认证失败，看不出是这个原因。
 *
 * 与门户那条路不同，这里必须存一份密码：IMAP 没有别的凭据形式。所以它是显式配置
 * （`config.local.json` 的 `mail` 段，不配就整条不跑），而不是像门户那样由一次
 * 真人登录搬运登录态。
 *
 * **读哪些邮件是个感受问题，不只是技术问题。** 定的规矩是：只读收件箱里未读的，
 * 且每次至多几封。不翻历史、不读已读——用户已经处理过的东西再被读一遍，是这个
 * 产品最不该给人的感觉。
 */
export type MailMessage = {
  /** IMAP 的 UID。在一个邮箱里稳定且递增，是「读到哪儿了」的水位 */
  uid: number
  /** 发件人、主题、正文拼成的一段文本，直接进管道 */
  text: string
}

export function describeMailbox(config: MailConfig | null): string {
  return config === null ? '邮件' : `邮件（${config.user}）`
}

/**
 * 收件箱里未读、且 UID 大于水位的那几封。
 *
 * **水位不能用「已读」来代替。** 标记已读是用户自己的动作，替他标掉，他的收件箱
 * 就少了一条本来会看见的未读。所以我们自己记读到哪儿了，一封邮件的读没读跟我们
 * 处理没处理是两件事。
 */
export async function fetchMail(config: MailConfig, since: number): Promise<MailMessage[]> {
  /*
   * 这两个包在第一次真要读邮件时才载入。
   *
   * 它们连同一整套 MIME 与字符集表被打进 Electron 主进程那个 bundle，而邮件是
   * 一条**默认不开**的来源。写成顶层 import 的话，这一大坨里任何一处在打包后
   * 出问题，整个应用会连窗口都开不出来——为一个多数人没配的来源冒这个险不值得。
   */
  const { ImapFlow } = await import('imapflow')
  const { simpleParser } = await import('mailparser')

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    // 这个库默认往 stdout 打整条 IMAP 会话，里面带着邮件主题。
    logger: false,
  })

  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const unseen = await client.search({ seen: false }, { uid: true })
      if (unseen === false || unseen.length === 0) return []

      // 最新的几封。更老的未读邮件多半是用户自己决定不看的，不该由我们代读。
      const wanted = unseen.filter((uid) => uid > since).sort((a, b) => a - b).slice(-config.perRun)
      if (wanted.length === 0) return []

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
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
}
