// LIFE-590 뷰어 격리 확인 — E4ⓓ Markdown 정화(실제 Chromium) · E4ⓔ 이미지(PNG 픽셀·GIF·SVG 정상/악성) · E4ⓕ 대용량(25 MB 일반 텍스트·60 MB 안내, 읽은 바이트)
// · E6 auto reveal(접힌 조상 펼침·선택·포커스 유지·패널 닫힘/열림) · E3ⓖ 키 표(편집기 포커스에서 누가 받나 — ⌘C 는 시스템 클립보드라 격리에서 누르지 않는다).
// 격리 개발 Electron(`l577/g-up.sh` /tmp/l590g-*) + fixture(`fixture.mjs`). 항목마다 `checks` 에 통과/실패와 값. 실패가 하나라도 있으면 exit 1.
// 사용(app/ 에서): node scripts/l590/viewer-check.mjs --root /tmp/l590g-v --repo /tmp/l590g-t/repo --out <dir>
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, herdr, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const root = values.root
const repo = values.repo
fs.mkdirSync(values.out, { recursive: true })
const checks = []
const check = (id, pass, value) => {
  checks.push({ id, pass: Boolean(pass), value })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(value).slice(0, 300)}`)
}
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 200, label: `click ${selector}` })
const dblclick = (selector) => until(async () => (await ctl(root, { cmd: 'dblclick', selector })).ok === true, { timeoutMs: 10_000, everyMs: 200, label: `dblclick ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const shot = async (name) => {
  const result = await ctl(root, { cmd: 'shot', name })
  if (result.file) fs.copyFileSync(result.file, path.join(values.out, `${name}.png`))
}
const expanded = async (rel) => (await js(`document.querySelector('[data-explorer-row="${rel}"]')?.getAttribute('aria-expanded') ?? null`)) === 'true'
const ensureExpanded = async (rel) => {
  if (!(await expanded(rel))) await click(`[data-explorer-row="${rel}"]`)
  await until(() => expanded(rel), { label: `expand ${rel}` })
}
const openFile = async (rel, pin = false) => {
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i += 1) await ensureExpanded(parts.slice(0, i).join('/'))
  await (pin ? dblclick : click)(`[data-explorer-row="${rel}"]`)
  await until(() => js(`document.querySelector('[data-file-view="${rel}"]') !== null`), { label: `view ${rel}` })
}
const logLines = (tag) =>
  fs.readFileSync(path.join(root, 'ud/corral.ndjson'), 'utf8').split('\n').filter((line) => line.includes(`"tag":"${tag}"`)).map((line) => JSON.parse(line))

const { paneId } = await repoPane(root, { repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
await js(`(window.__pwned = undefined, true)`)

// ── E4ⓓ Markdown 정화 — 악성 fixture 를 미리보기로
await openFile('docs/evil.md', true)
await until(() => js(`document.querySelector('[data-file-view="docs/evil.md"] [data-editor-ready]') !== null`), { label: 'md source' })
check('E4d-source-default', await js(`document.querySelector('[data-markdown-toggle]')?.dataset.markdownToggle === 'preview'`), 'source first')
const hrefBefore = await js('location.href')
await click('[data-markdown-toggle="preview"]')
await until(() => js(`document.querySelector('[data-markdown-preview="docs/evil.md"]')?.dataset.markdownReady === 'true'`), { label: 'md preview' })
await until(() => js(`document.querySelectorAll('[data-markdown-preview] [data-md-image], [data-markdown-preview] [data-md-image-refused]').length >= 4`), { label: 'md images', timeoutMs: 10_000 })
const md = await js(`(() => {
  const host = document.querySelector('[data-markdown-preview="docs/evil.md"]')
  const all = [...host.querySelectorAll('*')]
  return {
    scripts: host.querySelectorAll('script').length,
    handlers: all.filter((el) => [...el.attributes].some((a) => a.name.startsWith('on'))).length,
    javascriptUrls: all.filter((el) => [...el.attributes].some((a) => /javascript:/i.test(a.value))).length,
    iframes: host.querySelectorAll('iframe, form, input, object, embed').length,
    styleAttrs: host.querySelectorAll('[style]').length,
    hrefOrSrc: host.querySelectorAll('[href], [src], [srcset]').length,
    localImages: [...host.querySelectorAll('[data-md-image]')].map((el) => el.dataset.mdImage),
    refused: [...host.querySelectorAll('[data-md-image-refused]')].map((el) => el.dataset.mdImageRefused),
    headingIds: [...host.querySelectorAll('h1, h2')].map((el) => el.id),
  }
})()`)
check('E4d-no-script', md.scripts === 0 && md.handlers === 0 && md.javascriptUrls === 0 && md.iframes === 0 && md.styleAttrs === 0 && md.hrefOrSrc === 0, md)
check('E4d-local-image', md.localImages.includes('img/pixel.png') && md.localImages.includes('img/logo.svg'), md.localImages)
check('E4d-remote-outside-refused', md.refused.includes('remote') && md.refused.includes('outside'), md.refused)
// 링크 — javascript: 링크·onclick 링크를 눌러도 실행·이동 없음. 조각 링크는 스크롤. 상대 파일 링크는 파일 탭. (외부 https 는 사용자 브라우저를 여니 격리에서 누르지 않는다.)
for (const label of ['스크립트 링크', 'onclick 링크']) {
  // DOMPurify 가 javascript: href 를 지워 data-md-href 가 없을 수 있다 — 글로 a 를 찾는다.
  await js(`[...document.querySelectorAll('[data-markdown-preview] a')].find((el) => el.textContent === ${JSON.stringify(label)})?.setAttribute('data-l590-click', ${JSON.stringify(label)}) ?? null`)
  await click(`[data-l590-click="${label}"]`)
}
await sleep(300)
check('E4d-no-exec-no-nav', (await js('window.__pwned')) === null && (await js('location.href')) === hrefBefore, { pwned: await js('window.__pwned ?? null'), href: await js('location.href') })
await js(`[...document.querySelectorAll('[data-markdown-preview] [data-md-href]')].find((el) => el.textContent === '조각')?.setAttribute('data-l590-click', 'frag') ?? null`)
await click('[data-l590-click="frag"]')
await sleep(300)
check('E4d-fragment-scroll', (await js(`document.querySelector('[data-markdown-preview]').scrollTop`)) > 0, await js(`document.querySelector('[data-markdown-preview]').scrollTop`))
await shot('v01-markdown-preview')
await js(`[...document.querySelectorAll('[data-markdown-preview] [data-md-href]')].find((el) => el.textContent === '상대 파일')?.setAttribute('data-l590-click', 'rel') ?? null`)
await click('[data-l590-click="rel"]')
await until(() => js(`document.querySelector('[data-file-view="src/sample.ts"]') !== null`), { label: 'relative link opens tab' })
check('E4d-relative-link-tab', await js(`document.querySelector('[data-main-tab="file:src/sample.ts"]')?.dataset.tabPreview === 'true'`), 'preview tab')
// 원문/미리보기 기억 — md 탭으로 돌아가면 미리보기 그대로
await click('[data-main-tab="file:docs/evil.md"]')
await until(() => js(`document.querySelector('[data-markdown-preview="docs/evil.md"]') !== null`), { label: 'md mode kept' })
check('E4d-mode-kept', true, 'preview kept after tab switch')

// ── E4ⓔ 이미지
await openFile('img/pixel.png')
await until(() => js(`document.querySelector('[data-file-image]')?.dataset.imageReady === 'image/png'`), { label: 'png' })
const pixels = await js(`(() => { const c = document.querySelector('[data-file-image] canvas'); const g = c.getContext('2d'); return { w: c.width, h: c.height, tl: [...g.getImageData(1, 1, 1, 1).data], br: [...g.getImageData(62, 46, 1, 1).data], info: document.querySelector('.file-image-info')?.textContent } })()`)
check('E4e-png-pixels', pixels.w === 64 && pixels.h === 48 && pixels.tl[0] === 255 && pixels.tl[2] === 0 && pixels.br[2] === 255, pixels)
await shot('v02-image-png')
await openFile('img/dot.gif')
await until(() => js(`document.querySelector('[data-file-image]')?.dataset.imageReady === 'image/gif'`), { label: 'gif' })
check('E4e-gif', (await js(`document.querySelector('[data-file-image] canvas')?.width`)) === 1, 'gif 1x1')
await openFile('img/logo.svg')
await until(() => js(`document.querySelector('[data-file-image]')?.dataset.imageReady === 'image/svg+xml'`), { label: 'svg' })
check('E4e-svg', await js(`document.querySelectorAll('[data-file-image] svg rect, [data-file-image] svg circle').length === 2`), 'svg shapes')
await js(`(window.__pwned = undefined, true)`)
await openFile('img/evil.svg')
await until(() => js(`document.querySelector('[data-file-image]')?.dataset.imageReady === 'image/svg+xml'`), { label: 'evil svg' })
await click('[data-file-image] svg rect').catch(() => null)
await sleep(300)
const evilSvg = await js(`(() => { const host = document.querySelector('[data-file-image]'); const all = [...host.querySelectorAll('*')]; return { pwned: window.__pwned ?? null, scripts: host.querySelectorAll('script').length, foreign: host.querySelectorAll('foreignObject').length, handlers: all.filter((el) => [...el.attributes].some((a) => a.name.startsWith('on'))).length, externalHref: all.filter((el) => ['href', 'xlink:href'].some((n) => el.hasAttribute(n))).length } })()`)
check('E4e-svg-no-script', evilSvg.pwned === null && evilSvg.scripts === 0 && evilSvg.foreign === 0 && evilSvg.handlers === 0 && evilSvg.externalHref === 0, evilSvg)
await shot('v03-image-evil-svg')

// ── E4ⓕ 대용량
await openFile('big/25mb.log')
await until(() => js(`document.querySelector('[data-file-view="big/25mb.log"] [data-editor-ready]')?.dataset.editorReady ?? null`), { label: '25mb', timeoutMs: 30_000 })
const large = await js(`({ banner: document.querySelector('[data-file-notice="large"]')?.textContent ?? null, language: document.querySelector('[data-file-view="big/25mb.log"] [data-editor-ready]')?.dataset.editorReady, coloredSpans: [...document.querySelectorAll('[data-file-view="big/25mb.log"] .view-line span span')].filter((s) => !/^mtk1$/.test(s.className)).length })`)
check('E4f-large-plaintext', large.banner !== null && large.language === 'plaintext', large)
await shot('v04-large-25mb')
await openFile('big/60mb.txt')
await until(() => js(`document.querySelector('[data-file-notice="too_large"]') !== null`), { label: '60mb' })
const reads = logLines('file.read').filter((row) => row.kind === 'too_large')
check('E4f-too-large-no-read', reads.length > 0 && reads.every((row) => row.bytesRead === 0), reads.slice(-1))
await shot('v05-too-large')

// ── E6 auto reveal — docs 를 접고 다른 탭 → evil.md 탭으로 돌아오면 docs 가 펼쳐지고 evil.md 선택·보임. 포커스는 탭바/본문 그대로.
await openFile('src/sample.ts', true)
if (await expanded('docs')) await click('[data-explorer-row="docs"]')
await until(async () => !(await expanded('docs')), { label: 'docs collapsed' })
// 접는 클릭이 포커스를 탐색기에 남긴다 — 편집기로 옮겨 두고 탭을 바꾼다(reveal 전 포커스 = 탐색기 밖).
await click('[data-file-view="src/sample.ts"] [data-file-editor]')
const focusBeforeReveal = await js(`!!document.activeElement?.closest('[data-explorer-row], .explorer')`)
await click('[data-main-tab="file:docs/evil.md"]')
await until(() => expanded('docs'), { label: 'reveal expands docs', timeoutMs: 5000 })
const reveal = await js(`(() => { const row = document.querySelector('[data-explorer-row="docs/evil.md"]'); const scroller = row?.closest('[data-explorer-scroll]') ?? row?.parentElement?.parentElement; const r = row?.getBoundingClientRect(); const s = scroller?.getBoundingClientRect(); return { selected: row?.getAttribute('aria-selected'), visible: !!(r && s && r.top >= s.top - 1 && r.bottom <= s.bottom + 1), focusInExplorer: !!document.activeElement?.closest('[data-explorer-row], .explorer') } })()`)
check('E6-reveal', reveal.selected === 'true' && reveal.visible && !focusBeforeReveal && !reveal.focusInExplorer, { ...reveal, focusBeforeReveal })
// 숨김 경로(node_modules)는 reveal 하지 않는다 — 단위(revealDirs). 패널 닫힘: 닫고 탭 바꾸고 열면 활성 파일이 선택돼 있다.
await key('L', ['meta'])
await until(async () => (await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open', { label: 'panel closed' })
await click('[data-main-tab="file:src/sample.ts"]')
await sleep(200)
await key('L', ['meta'])
await until(async () => (await js(`document.querySelector('[data-explorer-row="src/sample.ts"]')?.getAttribute('aria-selected') ?? null`)) === 'true', { label: 'reveal on open', timeoutMs: 5000 })
check('E6-reveal-on-panel-open', true, 'src/sample.ts selected after reopening panel')
await shot('v06-auto-reveal')

// ── E3ⓖ 키 표 — 편집기에 포커스를 두고 앱 단축키·편집기 키가 어디로 가는지. ⌘C 는 누르지 않는다(시스템 클립보드).
await click('[data-file-view="src/sample.ts"] [data-file-editor]')
await sleep(200)
const focusInEditor = () => js(`!!document.activeElement?.closest('[data-file-view] .monaco-editor')`)
const keyTable = []
check('E3g-editor-focused', await focusInEditor(), 'focus')
await key('A', ['meta'])
await sleep(150)
const selection = await js(`(() => { const sel = document.querySelector('[data-file-view="src/sample.ts"] .selected-text'); return sel !== null })()`)
keyTable.push({ key: '⌘A', receiver: selection ? 'editor(전체 선택)' : 'none' })
await key('F', ['meta'])
await sleep(300)
const findVisible = await js(`!!document.querySelector('[data-file-view="src/sample.ts"] .find-widget.visible')`)
keyTable.push({ key: '⌘F', receiver: findVisible ? 'editor(찾기)' : 'none' })
await key('Escape')
await sleep(150)
// 글자 입력이 새지 않는다 — 편집기에 'x' 를 치면 모델 그대로, 터미널 pane 화면에도 안 간다.
await click('[data-file-view="src/sample.ts"] [data-file-editor]')
const paneBefore = JSON.stringify(await herdr(root, 'pane.read', { pane_id: paneId }).catch(() => null))
await ctl(root, { cmd: 'type', text: 'zzq' })
await sleep(400)
const paneAfter = JSON.stringify(await herdr(root, 'pane.read', { pane_id: paneId }).catch(() => null))
const editorHasTyped = await js(`[...document.querySelectorAll('[data-file-view="src/sample.ts"] .view-line')].some((l) => l.textContent.includes('zzq'))`)
keyTable.push({ key: '글자(zzq)', receiver: editorHasTyped ? 'editor(편집됨!)' : 'none(읽기 전용)', terminalChanged: paneBefore !== paneAfter && paneAfter.includes('zzq') })
check('E3g-no-leak', !editorHasTyped && !(paneAfter.includes('zzq') && !paneBefore.includes('zzq')), keyTable.at(-1))
// 앱 단축키 — ⌘B(사이드바)·⌘L(오른쪽 패널) 는 앱이 받는다(토글 확인 후 되돌림)
const sidebar = () => js(`!!document.querySelector('.sidebar-column.is-collapsed')`)
await click('[data-file-view="src/sample.ts"] [data-file-editor]')
const sbBefore = await sidebar()
await key('B', ['meta'])
await sleep(300)
const sbAfter = await sidebar()
keyTable.push({ key: '⌘B', receiver: sbBefore !== sbAfter ? 'app(사이드바)' : 'unknown', before: sbBefore, after: sbAfter })
await key('B', ['meta'])
await sleep(300)
await click('[data-file-view="src/sample.ts"] [data-file-editor]')
await key('L', ['meta'])
await sleep(300)
const panelAfterL = await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)
keyTable.push({ key: '⌘L', receiver: panelAfterL !== 'open' ? 'app(오른쪽 패널)' : 'editor?(줄 선택)' })
await key('L', ['meta'])
await sleep(300)
// ⌘W — 활성 파일 탭을 닫는다(편집기 포커스에서)
await click('[data-file-view="src/sample.ts"] [data-file-editor]')
await key('W', ['meta'])
await sleep(400)
const closed = await js(`document.querySelector('[data-main-tab="file:src/sample.ts"]') === null`)
keyTable.push({ key: '⌘W', receiver: closed ? 'app(파일 탭 닫기)' : 'none' })
check('E3g-app-keys', keyTable.find((row) => row.key === '⌘W').receiver.startsWith('app') && keyTable.find((row) => row.key === '⌘L').receiver.startsWith('app'), keyTable)
await key('T', ['meta', 'shift'])
await until(() => js(`document.querySelector('[data-main-tab="file:src/sample.ts"]') !== null`), { label: '⌘⇧T reopen file', timeoutMs: 5000 })
keyTable.push({ key: '⌘⇧T', receiver: 'app(같은 파일 탭 다시 열기)' })
check('E3d-reopen-file', true, 'file tab reopened')
keyTable.push({ key: '⌘C', receiver: '격리에서 누르지 않음(시스템 클립보드) — Monaco clipboard 기여 + Electron Edit 메뉴 role copy. 네이티브 관문에서 확인' })

writeJson(path.join(values.out, 'viewer-check.json'), { root, repo, checks, keyTable })
const failed = checks.filter((row) => !row.pass)
console.log(JSON.stringify({ total: checks.length, failed: failed.map((row) => row.id) }))
process.exit(failed.length === 0 ? 0 : 1)
