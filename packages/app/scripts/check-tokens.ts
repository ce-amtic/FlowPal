import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * 设计值单一来源的静态断言。
 *
 * 判断依据是本项目定下的一条规则：颜色、圆角、间距、动效时长只能来自
 * tokens.css，别处一律引用变量。这条在多人并行时最容易被违反，而违反之后
 * 桌宠和主窗口会各长一套值，合起来是拼的——那种问题肉眼要很久才看得出来。
 */
const appSrc = join(import.meta.dirname, '..', 'src')
const TOKEN_DIR = join(appSrc, 'tokens')

type Violation = { file: string; line: number; text: string; rule: string }

const RULES: { name: string; test: (line: string) => boolean }[] = [
  {
    name: '十六进制颜色',
    test: (l) => /#[0-9a-fA-F]{3,8}\b/.test(stripComments(l)),
  },
  {
    name: 'rgb / hsl 颜色字面量',
    test: (l) => /\b(rgba?|hsla?)\s*\(/.test(stripComments(l)),
  },
  {
    name: '圆角字面量',
    test: (l) => /border-radius\s*:/.test(l) && !/var\(/.test(l) && !/:\s*0\s*;/.test(l),
  },
  {
    name: '动效时长字面量',
    test: (l) => /\b\d+(\.\d+)?m?s\b/.test(stripComments(l)) && /transition|animation|duration/i.test(l),
  },
]

/** 注释里出现的值不算违例——说明性的文字里提到 #fff 是正常的。 */
function stripComments(line: string): string {
  return line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '')
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )
}

const violations: Violation[] = []

for (const file of walk(appSrc)) {
  if (file.startsWith(TOKEN_DIR)) continue
  if (!/\.(css|tsx?|jsx?)$/.test(file)) continue

  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.test(line)) {
        violations.push({ file: relative(appSrc, file), line: i + 1, text: line.trim(), rule: rule.name })
        break
      }
    }
  })
}

// 动效时长在 CSS 与 JS 里各存一份（一个要单位，一个要数字）。核对它们一致，
// 否则改了一边忘了另一边，切页与悬停会跑在不同节奏上，而这种不齐很难被看出来。
{
  const css = readFileSync(join(TOKEN_DIR, 'tokens.css'), 'utf8')
  const ts = readFileSync(join(TOKEN_DIR, 'motion.ts'), 'utf8')
  for (const name of ['fast', 'base', 'slow']) {
    const cssMs = css.match(new RegExp(`--dur-${name}:\\s*(\\d+(?:\\.\\d+)?)ms`))?.[1]
    const tsSec = ts.match(new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)`))?.[1]
    if (!cssMs || !tsSec) {
      violations.push({ file: 'tokens/', line: 0, rule: '动效时长对不上', text: `读不到 --dur-${name}` })
    } else if (Math.abs(Number(cssMs) / 1000 - Number(tsSec)) > 1e-9) {
      violations.push({
        file: 'tokens/', line: 0, rule: '动效时长对不上',
        text: `--dur-${name} 是 ${cssMs}ms，motion.ts 里是 ${tsSec}s`,
      })
    }
  }
}

if (violations.length === 0) {
  console.log('设计值单一来源：通过')
  process.exit(0)
}

console.log(`设计值单一来源：${violations.length} 处违例\n`)
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}  ${v.rule}`)
  console.log(`    ${v.text}`)
}
console.log('\n把值加进 src/tokens/tokens.css，此处引用变量。')
process.exit(1)
