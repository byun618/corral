// LIFE-590 수정 r2 R2-A — 한글 ID SVG 내부 참조, 옛 정화(r2 대상 `764d01a10`)와 지금 정화를 같은 실제 Chromium(격리 Electron file:// 창)에서 대조(리뷰 r2 `svg-normal` 조건).
// 옛 판은 `git show 764d01a10:` 의 image.ts·resource-guard.ts 를 임시 폴더에 꺼내 esbuild 로 묶는다(dompurify 는 app/node_modules). 지금 판은 빌드 산출 `out/renderer/assets/image-*.js`.
// 판정: 지금 판은 한글 ID 그라디언트·필터·마스크·clip 참조가 남고 계산 색이 그라디언트(`url("#…")`), 옛 판은 같은 입력에서 `fill` 이 빠져 `rgb(0, 0, 0)` — 이 시험의 판별력.
// ASCII ID·일반 스타일은 두 판이 같아야 한다.
// 사용(app/ 에서): node scripts/l590/svg-unicode-check.mjs --root /tmp/l590g-* --out <json>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { checkRoot, evalJs, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const app = process.cwd()
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'l590-r2a-'))
for (const name of ['image.ts', 'resource-guard.ts']) fs.writeFileSync(path.join(work, name), execFileSync('git', ['show', `764d01a10:app/src/renderer/src/editor/${name}`], { encoding: 'utf8' }))
const { build } = await import(pathToFileURL(path.join(app, 'node_modules/esbuild/lib/main.js')))
const oldBundle = path.join(work, 'old-image.mjs')
await build({ entryPoints: [path.join(work, 'image.ts')], bundle: true, platform: 'browser', format: 'esm', outfile: oldBundle, nodePaths: [path.join(app, 'node_modules')], logLevel: 'error' })
const current = fs.readdirSync(path.join(app, 'out/renderer/assets')).find((file) => /^image-.*\.js$/.test(file))
if (current === undefined) throw new Error('빌드 산출 image-*.js 없음 — npm run build 먼저')

const cases = {
  unicode: `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><defs><linearGradient id="색"><stop offset="0" stop-color="lime"/></linearGradient><filter id="흐림"><feOffset dx="0" dy="0"/></filter><mask id="가림"><rect width="40" height="40" fill="white"/></mask><clipPath id="자르기"><rect width="40" height="40"/></clipPath></defs><rect width="30" height="30" fill="url(#색)" filter="url(#흐림)" mask="url(#가림)" clip-path="url('#자르기')"/></svg>`,
  ascii: `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><defs><linearGradient id="color"><stop offset="0" stop-color="lime"/></linearGradient></defs><rect width="30" height="30" fill="url(#color)"/></svg>`,
  regularStyle: `<svg xmlns="http://www.w3.org/2000/svg" style="opacity:0.5"><rect width="30" height="30" style="fill:rgb(0,255,255);stroke:red;stroke-width:2"/></svg>`,
  outside: `<svg xmlns="http://www.w3.org/2000/svg"><rect width="30" height="30" fill="url(../바깥.svg#색)" style="background:url(../x.png)"/></svg>`,
}
const result = await evalJs(
  values.root,
  `(async () => {
    const old = await import(${JSON.stringify(pathToFileURL(oldBundle).href)})
    const now = await import('./assets/${current}')
    const out = {}
    for (const [key, source] of Object.entries(${JSON.stringify(cases)})) {
      out[key] = {}
      for (const [version, module] of [['old', old], ['current', now]]) {
        const html = module.sanitizeSvg(source)
        const host = document.createElement('div')
        host.innerHTML = html
        document.body.append(host)
        const rect = host.querySelector('svg > rect')
        const style = rect === null ? null : getComputedStyle(rect)
        out[key][version] = { html, fill: style?.fill ?? null, filter: style?.filter ?? null, mask: style?.mask ?? null, clipPath: style?.clipPath ?? null, attrs: rect === null ? null : Object.fromEntries([...rect.attributes].map((a) => [a.name, a.value])) }
        host.remove()
      }
    }
    return out
  })()`,
)
fs.rmSync(work, { recursive: true, force: true })
const u = result.unicode
const checks = {
  'current-unicode-gradient': u.current.fill === 'url("#색")',
  'current-unicode-filter-mask-clip': u.current.filter !== 'none' && u.current.mask !== 'none' && u.current.clipPath !== 'none',
  'old-unicode-dropped (판별력)': u.old.fill === 'rgb(0, 0, 0)',
  'ascii-same': result.ascii.old.fill === result.ascii.current.fill && result.ascii.current.fill === 'url("#color")',
  'regular-style-same': result.regularStyle.old.fill === result.regularStyle.current.fill && result.regularStyle.current.fill === 'rgb(0, 255, 255)',
  'outside-still-dropped': result.outside.current.attrs !== null && !('fill' in result.outside.current.attrs) && !('style' in result.outside.current.attrs),
}
writeJson(values.out, { oldRef: '764d01a10', currentChunk: current, result, checks })
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
console.log(JSON.stringify({ unicode: { old: [u.old.fill, u.old.filter, u.old.mask, u.old.clipPath], current: [u.current.fill, u.current.filter, u.current.mask, u.current.clipPath] }, checks, failed }))
process.exit(failed.length === 0 ? 0 : 1)
