// R3-A 사본 기하 픽스처 번들 — `node build.mjs <outDir>`. 출력: <outDir>/renderer.js · <outDir>/browser.html (제품 CSS 를 file:// 로 싣는다).
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(process.argv[2] ?? '/tmp/l576g')
const src = resolve(here, '../../../src/renderer/src')
mkdirSync(out, { recursive: true })
await build({ entryPoints: [resolve(here, 'renderer.tsx')], outfile: resolve(out, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl', '.svg': 'dataurl' }, define: { 'process.env.NODE_ENV': '"development"' } })
writeFileSync(resolve(out, 'browser.html'), `<!doctype html><html><head><link rel="stylesheet" href="file://${src}/design-tokens.css"><link rel="stylesheet" href="file://${src}/styles.css"><style>body,#root{height:700px}.sidebar{height:700px}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
console.log('built', out)
