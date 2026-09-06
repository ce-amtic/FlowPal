import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = resolve(packageRoot, '..', '..')
const outDir = resolve(packageRoot, 'dist')

// @flowpal/server is intentionally a TypeScript-first workspace package. It
// cannot remain an external import in Electron: the packaged Node runtime does
// not have a TS loader, and the package export points at src/index.ts. Alias
// both workspace packages to source here so esbuild follows and bundles them
// (including their runtime dependencies) into the main-process entry.
const serverEntry = resolve(workspaceRoot, 'packages', 'server', 'src', 'index.ts')
const sharedEntry = resolve(workspaceRoot, 'packages', 'shared', 'src', 'index.ts')
if (!existsSync(serverEntry) || !existsSync(sharedEntry)) {
  throw new Error(`FlowPal workspace sources are missing: ${serverEntry}`)
}

// Avoid stale entry points surviving a renamed source file.  The target is
// this package's narrow dist directory, never a workspace-wide path.
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
await esbuild.build({
  absWorkingDir: packageRoot,
  entryPoints: ['src/main.ts', 'src/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  alias: {
    '@flowpal/server': serverEntry,
    '@flowpal/shared': sharedEntry,
  },
  // Electron and Node built-ins are provided by the host process. Keeping
  // them external also avoids accidentally bundling native `node:sqlite`.
  external: ['electron', 'node:*'],
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
  logLevel: 'info',
})

/*
 * 离线同步的样例数据。runner 用 `new URL('./fixtures/…', import.meta.url)` 找它们，
 * 而打包之后那个 import.meta.url 指的是 dist/main.mjs——源码树里的 fixtures 目录
 * 到不了这里。不拷的话，样例同步在打包的壳里必然 ENOENT，而路由把它记成一次
 * 「RUC 同步失败」，看不出真正的原因。
 */
const fixtures = resolve(workspaceRoot, 'packages', 'server', 'src', 'sync', 'fixtures')
if (!existsSync(fixtures)) throw new Error(`同步样例数据不见了：${fixtures}`)
cpSync(fixtures, resolve(outDir, 'fixtures'), { recursive: true })
