import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CalendarSchema, createCtx, nowInShanghai } from '@flowpal/shared'
import { ServerConfig } from '../src/config.ts'
import { loadConfig } from '../src/index.ts'
import { openDb } from '../src/store/db.ts'
import { RucCookies, runSync } from '../src/sync/index.ts'
import { MailSecrets } from '../src/sync/secrets.ts'

/**
 * 现跑一次同步，打印结果。`pnpm sync:once`。
 *
 * 与 `check:sync` 分工不同，两个都要有：那一个不联网，验的是解析与落库对不对；
 * 这一个联网，验的是**接口今天还给不给那份形状、登录态还在不在**。后者只有真跑
 * 才知道，而它恰恰是最容易在某天早上悄悄坏掉的那一半。
 *
 * 它用的是 desktop 那次真人登录留下的 Cookie（`dataDir/ruc-cookies.json`）。还没
 * 登录过时它会这么说，而不是装作同步了一次什么都没有。
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const config = ServerConfig.parse(loadConfig(repoRoot))
const calendar = CalendarSchema.parse(JSON.parse(readFileSync(config.calendarPath, 'utf8')))
const ctx = createCtx(calendar, nowInShanghai())
const db = openDb(config.dataDir)
const cookies = RucCookies.open(join(config.dataDir, 'ruc-cookies.json'))

console.log(`学期 ${ctx.term.name}（${ctx.term.startMonday} 起 ${ctx.term.weeks} 周）`)
console.log(cookies.isEmpty ? '还没有登录态' : '有登录态')

/*
 * 这里没有解开的邮箱授权码，也不该有：密文的钥匙在系统钥匙串里，只有桌面端拿得到。
 * 所以这个脚本验的是门户那两路，邮箱那几行会显示「需要在桌面应用里解锁」。
 */
const result = await runSync({
  db, ctx, config, cookies, secrets: new MailSecrets(), onChanged: () => {},
})

console.log(`\n${result.state}：${result.message}`)
for (const source of result.sources) {
  const detail = source.skipped ?? `新增 ${source.created} · 更新 ${source.updated}`
  console.log(`  ${source.label}　${detail}`)
}

db.close()
process.exit(result.state === 'ok' ? 0 : 1)
