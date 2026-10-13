// LIFE-590 수정 r1 R1-A — Markdown·SVG 안 리소스 참조 가둠(격리 개발 Electron, 실제 Chromium). E4ⓓⓔ·E7ⓐⓑ.
// 바깥 이미지 = worktree **밖**의 단색 자홍 PNG, 안 이미지 = worktree 안 단색 청록 PNG. 화면 캡처의 픽셀로 본다:
//   · 자홍 0 — 밖 리소스가 어떤 경로로도 그려지지 않았다(HTML IMG·srcset·background·SVG image·feImage·use·style url()·@import·set 애니메이션 · 상대·file://·`..`·링크 탈출·원격)
//   · 청록 > 0 — 안 이미지는 main 경계(`readImage`)를 거쳐 그려졌다
//   · **양성 대조**: 같은 실행에서 정화를 거치지 않은 `<svg><image href=밖>` 를 미리보기 자리에 직접 넣으면 자홍이 보인다 — 이 Chromium 에서 그 참조가 실제로 로드되고 측정기가 잡는다.
// 그리고 DOM 검사(남은 URL 속성·`url(` 값 0)과 경계 거절 사유 코드(`readImage` 직접 호출 · 미리보기 자리표시 `data-md-image-refused`).
// 사용(app/ 에서): node scripts/l590/resource-check.mjs --root /tmp/l590g-* --repo /tmp/l590g-t/repo --out <dir>
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const root = values.root
const repo = values.repo
fs.mkdirSync(values.out, { recursive: true })
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 100, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })

// ── PNG 만들기·읽기(단색 RGB 쓰기 · 캡처 RGBA/RGB 읽기 — 비인터레이스 8 bit)
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buffer) => {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
const solidPng = ({ size, rgb }) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: size }, () => Buffer.from(rgb))])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}
const decodePng = (buffer) => {
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
      if (data[8] !== 8 || data[12] !== 0) throw new Error('8 bit 비인터레이스만')
    }
    if (type === 'IDAT') idat.push(data)
    offset += 12 + length
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (bpp === 0) throw new Error(`색 형식 ${colorType}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x]
      const left = x >= bpp ? pixels[y * stride + x - bpp] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0
      const paeth = () => {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth()
      pixels[y * stride + x] = (value + predictor) & 0xff
    }
  }
  return { width, height, bpp, pixels }
}
const MAGENTA = [255, 0, 255]
const CYAN = [0, 255, 255]
const countColor = ({ file, rgb }) => {
  const image = decodePng(fs.readFileSync(file))
  let hits = 0
  for (let index = 0; index < image.pixels.length; index += image.bpp) {
    if (Math.abs(image.pixels[index] - rgb[0]) <= 8 && Math.abs(image.pixels[index + 1] - rgb[1]) <= 8 && Math.abs(image.pixels[index + 2] - rgb[2]) <= 8) hits += 1
  }
  return { hits, width: image.width, height: image.height }
}
/** 스크롤되는 영역은 위에서 아래로 한 화면씩 찍어 합한다(아래쪽 벡터가 화면 밖이면 픽셀로 못 본다). */
const scrolledShots = async ({ name, selector }) => {
  const total = { magenta: { hits: 0 }, cyan: { hits: 0 }, files: [] }
  const metrics = await js(`(() => { const host = document.querySelector(${JSON.stringify(selector)}); return { height: host.scrollHeight, view: host.clientHeight } })()`)
  for (let index = 0, top = 0; top < metrics.height; index += 1, top += Math.max(100, metrics.view - 40)) {
    await js(`(() => { document.querySelector(${JSON.stringify(selector)}).scrollTop = ${top}; return true })()`)
    await sleep(400)
    const part = await shot({ name: `${name}-${index}`, selector })
    total.magenta.hits += part.magenta.hits
    total.cyan.hits += part.cyan.hits
    total.files.push(path.basename(part.file))
  }
  return { ...total, metrics }
}
const shot = async ({ name, selector }) => {
  const result = await ctl(root, { cmd: 'shot', name, selector })
  if (!result.ok || typeof result.file !== 'string') throw new Error(`shot 실패 ${JSON.stringify(result).slice(0, 200)}`)
  const target = path.join(values.out, `${name}.png`)
  fs.copyFileSync(result.file, target)
  return { file: target, magenta: countColor({ file: target, rgb: MAGENTA }), cyan: countColor({ file: target, rgb: CYAN }) }
}

// ── fixture: 밖 자홍(worktree 부모 폴더) · 안 청록 · 밖을 가리키는 링크 · 시험 문서 둘
const realRepo = fs.realpathSync(repo)
const outsideFile = path.join(path.dirname(realRepo), 'l590-r1a-outside.png')
fs.writeFileSync(outsideFile, solidPng({ size: 48, rgb: MAGENTA }))
fs.writeFileSync(path.join(realRepo, 'img', 'r1a-inside.png'), solidPng({ size: 48, rgb: CYAN }))
fs.rmSync(path.join(realRepo, 'img', 'r1a-escape.png'), { force: true })
fs.symlinkSync(outsideFile, path.join(realRepo, 'img', 'r1a-escape.png'))
// 렌더러 문서(index.html) 기준 상대 경로 — 브라우저가 스스로 풀면 밖 파일에 닿는다(리뷰 r1 재현과 같은 방식).
const rendererDir = path.resolve('out/renderer')
const relFromRenderer = path.relative(rendererDir, outsideFile)
const fileUrl = `file://${outsideFile}`
const vectors = [
  ['md-svg-image-rel', `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><image href="${relFromRenderer}" width="48" height="48"/></svg>`],
  ['md-svg-image-file', `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><image href="${fileUrl}" width="48" height="48"/></svg>`],
  ['md-svg-xlink', `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="60" height="60"><image xlink:href="${relFromRenderer}" width="48" height="48"/></svg>`],
  ['md-svg-feimage', `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><filter id="f"><feImage href="${relFromRenderer}" width="48" height="48"/></filter><rect width="48" height="48" filter="url(#f)"/></svg>`],
  ['md-svg-set', `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><image width="48" height="48"><set attributeName="href" to="${relFromRenderer}"/></image></svg>`],
  ['md-svg-pattern-fill', `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="48" height="48" fill="url(${relFromRenderer})"/></svg>`],
  ['md-table-background', `<table background="${relFromRenderer}" width="60" height="60"><tr><td>bg</td></tr></table>`],
  ['md-img-srcset', `<img srcset="${relFromRenderer} 1x" width="48" height="48" alt="srcset">`],
  ['md-picture', `<picture><source srcset="${relFromRenderer}"><img alt="picture" width="48" height="48"></picture>`],
  ['md-img-dotdot', `<img src="../l590-r1a-outside.png" alt="dotdot" width="48" height="48">`],
  ['md-img-file-url', `<img src="${fileUrl}" alt="fileurl" width="48" height="48">`],
  ['md-img-absolute', `<img src="${outsideFile}" alt="absolute" width="48" height="48">`],
  ['md-img-escape-link', `<img src="img/r1a-escape.png" alt="escape" width="48" height="48">`],
  ['md-img-remote', `<img src="https://example.invalid/r1a.png" alt="remote" width="48" height="48">`],
  ['md-img-inside', `<img src="img/r1a-inside.png" alt="inside" width="48" height="48">`],
]
fs.writeFileSync(path.join(realRepo, 'r1a.md'), `# R1-A\n\n${vectors.map(([name, html]) => `<p id="v-${name}">${name}</p>\n\n${html}\n`).join('\n')}`)
fs.writeFileSync(
  path.join(realRepo, 'img', 'r1a.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="120" style="background-image:url(${fileUrl})">` +
    `<style>@import url("${relFromRenderer}"); rect.s { fill: url(${relFromRenderer}) }</style>` +
    `<defs><linearGradient id="g"><stop offset="0" stop-color="#333"/><stop offset="1" stop-color="#666"/></linearGradient><filter id="f"><feImage href="${relFromRenderer}" width="48" height="48"/></filter></defs>` +
    `<image href="${relFromRenderer}" x="0" y="0" width="48" height="48"/>` +
    `<image xlink:href="${fileUrl}" x="60" y="0" width="48" height="48"/>` +
    `<rect class="s" x="120" y="0" width="48" height="48"/>` +
    `<rect x="180" y="0" width="48" height="48" filter="url(#f)"/>` +
    `<rect x="240" y="0" width="48" height="48" style="fill:url(${relFromRenderer})"/>` +
    `<use href="${relFromRenderer}#x" x="300"/>` +
    `<rect x="0" y="60" width="380" height="40" fill="url(#g)"/></svg>`,
)

// 같은 문서 안에서 쓸 DOM 검사 — 남은 URL 속성(경계로 옮긴 data-md-* 와 SVG 조각 `#id` 빼고)과 리소스를 부르는 값(`url(` — `url(#id)` 빼고)
const SCAN = (selector) => `(() => {
  const host = document.querySelector(${JSON.stringify(selector)})
  if (host === null) return null
  const urlAttrs = new Set(['href','xlink:href','src','srcset','poster','background','action','formaction','data','codebase','cite','longdesc','lowsrc','dynsrc','ping','manifest','icon','profile','usemap','archive','classid','xml:base','imagesrcset'])
  const leftovers = []
  for (const element of host.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase()
      const svgFragment = element.namespaceURI === 'http://www.w3.org/2000/svg' && element.localName !== 'a' && /^#[\\w.:-]*$/.test(attribute.value.trim())
      if (urlAttrs.has(name) && !svgFragment) leftovers.push({ tag: element.localName, name, value: attribute.value.slice(0, 120) })
      else if (/url\\s*\\(|@import|image-set/i.test(attribute.value.replace(/url\\(\\s*(['"]?)#[\\w.:-]*\\1\\s*\\)/gi, ''))) leftovers.push({ tag: element.localName, name, value: attribute.value.slice(0, 120) })
    }
  }
  const styles = host.querySelectorAll('style, link, set, animate, foreignObject').length
  return { leftovers, styles, refused: [...host.querySelectorAll('[data-md-image-refused]')].map((node) => node.dataset.mdImageRefused), canvases: host.querySelectorAll('canvas').length }
})()`

const result = { outsideFile, relFromRenderer, vectors: vectors.map(([name]) => name) }
await repoPane(root, { repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 1000 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
await js(`window.__r1aViolations = []; document.addEventListener('securitypolicyviolation', (event) => window.__r1aViolations.push({ blocked: event.blockedURI, directive: event.violatedDirective })); true`)

// ① 경계 사유 코드 — 같은 main 핸들러에 안·`..`·절대·링크 탈출
result.boundary = await js(`Promise.all([
  ['inside', 'img/r1a-inside.png'], ['dotdot', '../l590-r1a-outside.png'], ['absolute', ${JSON.stringify(outsideFile)}], ['escape-link', 'img/r1a-escape.png'],
].map(([name, rel]) => window.corral.readImage({ root: ${JSON.stringify(realRepo)}, rel }).then((row) => ({ name, ok: row.ok, code: row.code ?? null, kind: row.kind ?? null, mime: row.mime ?? null }))))`)

// ② Markdown 미리보기
await until(async () => (await js(`!!document.querySelector('[data-explorer-row="r1a.md"]')`)) === true, { label: 'r1a.md row' })
await click('[data-explorer-row="r1a.md"]')
await until(() => js(`!!document.querySelector('[data-file-view="r1a.md"] [data-editor-ready]')`), { label: 'md editor' })
await click('[data-file-view="r1a.md"] [data-markdown-toggle="preview"]')
await until(() => js(`document.querySelector('[data-file-view="r1a.md"] [data-markdown-preview]')?.dataset.markdownReady === 'true'`), { label: 'md preview' })
await sleep(1500) // 남은 참조가 있다면 로드·그리기가 끝나게
result.markdown = { scan: await js(SCAN('[data-file-view="r1a.md"] [data-markdown-preview]')) }
result.markdown.shot = await scrolledShots({ name: 'r1a-markdown', selector: '[data-file-view="r1a.md"] [data-markdown-preview]' })

// ②' 양성 대조 — 정화를 거치지 않은 같은 참조를 미리보기 자리에 직접 넣는다(제품 경로 아님). 자홍이 보여야 측정기가 유효하다.
await js(`(() => { const host = document.querySelector('[data-file-view="r1a.md"] [data-markdown-preview]'); const probe = document.createElement('div'); probe.id = 'r1a-positive'; probe.innerHTML = ${JSON.stringify(`<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><image href="${relFromRenderer}" width="48" height="48"/></svg>`)}; host.prepend(probe); host.scrollTop = 0; return true })()`)
await sleep(1500)
result.positiveControl = await shot({ name: 'r1a-positive-control', selector: '[data-file-view="r1a.md"] [data-markdown-preview]' })
await js(`document.getElementById('r1a-positive')?.remove(); true`)

// ③ SVG 이미지 뷰어
await click('[data-explorer-row="img"]').catch(() => null)
await until(async () => (await js(`!!document.querySelector('[data-explorer-row="img/r1a.svg"]')`)) === true, { label: 'svg row' })
await click('[data-explorer-row="img/r1a.svg"]')
await until(() => js(`!!document.querySelector('[data-file-view="img/r1a.svg"] [data-image-ready]')`), { label: 'svg ready' })
await sleep(1500)
result.svg = { scan: await js(SCAN('[data-file-view="img/r1a.svg"] [data-file-image]')) }
result.svg.shot = await shot({ name: 'r1a-svg', selector: '[data-file-view="img/r1a.svg"]' })
result.svg.gradientKept = await js(`!!document.querySelector('[data-file-view="img/r1a.svg"] [data-file-image] rect[fill="url(#g)"]')`)
result.violations = await js(`window.__r1aViolations`)

const boundaryOk =
  result.boundary.find((row) => row.name === 'inside')?.ok === true &&
  result.boundary.filter((row) => row.name !== 'inside').every((row) => row.ok === false && typeof row.code === 'string')
const checks = {
  'positive-control-detects-outside': result.positiveControl.magenta.hits > 50,
  'markdown-no-outside-pixels': result.markdown.shot.magenta.hits === 0,
  'markdown-inside-via-boundary': result.markdown.shot.cyan.hits > 50,
  'markdown-no-leftover-refs': result.markdown.scan !== null && result.markdown.scan.leftovers.length === 0 && result.markdown.scan.styles === 0,
  'markdown-refused-reasons': result.markdown.scan !== null && result.markdown.scan.refused.length >= 4,
  'svg-no-outside-pixels': result.svg.shot.magenta.hits === 0,
  'svg-no-leftover-refs': result.svg.scan !== null && result.svg.scan.leftovers.length === 0 && result.svg.scan.styles === 0,
  'svg-local-gradient-kept': result.svg.gradientKept === true,
  'boundary-codes': boundaryOk,
}
result.checks = checks
writeJson(path.join(values.out, 'resource-check.json'), result)
console.log(JSON.stringify({ boundary: result.boundary, markdownRefused: result.markdown.scan?.refused, leftovers: { md: result.markdown.scan?.leftovers, svg: result.svg.scan?.leftovers }, pixels: { positive: result.positiveControl.magenta, md: [result.markdown.shot.magenta, result.markdown.shot.cyan], svg: result.svg.shot.magenta }, violations: result.violations.length, checks }))
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
console.log(JSON.stringify({ failed }))
fs.rmSync(outsideFile, { force: true })
process.exit(failed.length === 0 ? 0 : 1)
