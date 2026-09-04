import { join } from 'node:path'
import { createServer, loadConfig } from './index.ts'

/**
 * 独立进程入口：`pnpm dev:server`。
 *
 * 这不是为将来准备的备用路径——它是调 prompt 的日常工作方式：
 *   curl -X POST localhost:5123/api/extract -H 'content-type: application/json' \
 *        -d '{"rawText":"下周三之前把那个报告发给老师"}'
 * 全程不启动 Electron。边界天天被走，就不会烂掉。
 */
const repoRoot = join(import.meta.dirname, '..', '..', '..')
const server = createServer(loadConfig(repoRoot))
console.log(`FlowPal server: ${server.url}`)
