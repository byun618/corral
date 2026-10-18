// LIFE-591 E7ⓑ 무회귀 사본 — scripts/l590/mixed-tabs.mjs 에서 격리 루트(/tmp/l591g-*)·fixture 경로(/tmp/l591g-u)만 바꿨다.
// LIFE-590 E3 섞인 탭 격리 합성 회차 — 터미널 탭 + 파일 탭이 한 영역에 섞인 상태에서 ⓐ ⌘⇧] 순환·⌃숫자·⌘W ⓑ 탭바 안 끌어 순서 이동·본문 오른쪽 끝으로 끌어 분할
// ⓒ 영역 닫기(⌘⌥W) ⓓ ⌘⇧T(같은 파일 탭·같은 자리·미리보기 여부) ⓔ 재시작 복원(앱만 내렸다 같은 ROOT 로 다시 — 순서·활성·미리보기, 지운 파일은 「삭제됨」)
// ⓕ 탭을 오가도 스크롤 자리 ⓗ 파일 탭 우클릭 메뉴 항목(핀·색·이름 바꾸기 없음 — 숨김). 실패가 하나라도 있으면 exit 1.
// 사용(app/ 에서): node scripts/l590/mixed-tabs.mjs --root /tmp/l590g-m --fake /tmp/l590g-fm --repo /tmp/l591g-u/repo --out <dir>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const root = values.root
const repo = values.repo
fs.mkdirSync(values.out, { recursive: true })
const checks = []
const check = (id, pass, value) => {
  checks.push({ id, pass: Boolean(pass), value })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(value).slice(0, 400)}`)
}
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 100, label: `click ${selector}` })
const dblclick = (selector) => until(async () => (await ctl(root, { cmd: 'dblclick', selector })).ok === true, { timeoutMs: 10_000, everyMs: 100, label: `dblclick ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const shot = async (name) => {
  const result = await ctl(root, { cmd: 'shot', name })
  if (result.file) fs.copyFileSync(result.file, path.join(values.out, `${name}.png`))
}
const expanded = async (rel) => (await js(`document.querySelector('[data-explorer-row="${rel}"]')?.getAttribute('aria-expanded') ?? null`)) === 'true'
const openFile = async (rel, pin) => {
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/')
    if (!(await expanded(dir))) await click(`[data-explorer-row="${dir}"]`)
    await until(() => expanded(dir), { label: `expand ${dir}` })
  }
  await (pin ? dblclick : click)(`[data-explorer-row="${rel}"]`)
  await until(() => js(`document.querySelector('[data-main-tab="file:${rel}"]') !== null`), { label: `tab ${rel}` })
}
const tabs = () => js(`[...document.querySelectorAll('[data-tab-group]')].map((group) => ({ group: group.dataset.tabGroup, tabs: [...group.querySelectorAll('[data-main-tab]')].map((el) => ({ id: el.dataset.mainTab, active: el.dataset.active === 'true', preview: el.dataset.tabPreview ?? null, deleted: el.classList.contains('is-deleted') })) }))`)
const activeIn = async (groupIndex = 0) => (await tabs())[groupIndex]?.tabs.find((tab) => tab.active)?.id ?? null
const rect = (selector) => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null })()`)
const drag = async (from, to) => {
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', x: from.x, y: from.y })
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseDown', x: from.x, y: from.y })
  for (let step = 1; step <= 12; step += 1) {
    await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(from.x + ((to.x - from.x) * step) / 12), y: Math.round(from.y + ((to.y - from.y) * step) / 12) })
    await sleep(25)
  }
  await sleep(150)
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseUp', x: to.x, y: to.y })
  await sleep(400)
}
const firstLine = (rel) => js(`Math.min(...[...document.querySelectorAll('[data-file-view="${rel}"] .margin-view-overlays .line-numbers')].map((el) => Number(el.textContent)).filter((n) => n > 0))`)

await repoPane(root, { repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
fs.writeFileSync(path.join(repo, 'notes/long.txt'), Array.from({ length: 300 }, (_, i) => `long ${i + 1}`).join('\n') + '\n')
fs.writeFileSync(path.join(repo, 'notes/doomed.txt'), 'restart 때 지워질 파일\n')

await openFile('src/sample.ts', true)
await openFile('notes/long.txt', true)
await openFile('README.md', false)
const terminalId = (await tabs())[0].tabs.find((tab) => !tab.id.startsWith('file:')).id
check('setup', (await tabs())[0].tabs.map((tab) => tab.id).join(',') === `${terminalId},file:src/sample.ts,file:notes/long.txt,file:README.md`, await tabs())

// ⓐ 순환·⌃숫자·⌘W
await click(`[data-main-tab="${terminalId}"]`)
await key(']', ['meta', 'shift'])
await sleep(200)
check('a-cycle-into-file', (await activeIn()) === 'file:src/sample.ts', await activeIn())
await key('3', ['control'])
await sleep(200)
check('a-ctrl-index-file', (await activeIn()) === 'file:notes/long.txt', await activeIn())
await key('[', ['meta', 'shift'])
await key('[', ['meta', 'shift'])
await sleep(200)
check('a-cycle-back-to-terminal', (await activeIn()) === terminalId, await activeIn())

// ⓕ 스크롤 자리 — long.txt 를 내리고 다른 탭 갔다 오기
await click('[data-main-tab="file:notes/long.txt"]')
await until(() => js(`!!document.querySelector('[data-file-view="notes/long.txt"] [data-editor-ready]')`), { label: 'long ready' })
await click('[data-file-view="notes/long.txt"] [data-file-editor]')
for (let i = 0; i < 4; i += 1) await key('PageDown')
await sleep(300)
const lineBefore = await firstLine('notes/long.txt')
await click('[data-main-tab="file:src/sample.ts"]')
await sleep(300)
await click('[data-main-tab="file:notes/long.txt"]')
await until(() => js(`!!document.querySelector('[data-file-view="notes/long.txt"] [data-editor-ready]')`), { label: 'long ready again' })
await sleep(300)
const lineAfter = await firstLine('notes/long.txt')
check('f-scroll-kept', lineBefore > 50 && lineBefore === lineAfter, { lineBefore, lineAfter })

// ⓓ ⌘W 로 미리보기 탭 닫고 ⌘⇧T — 같은 자리·미리보기
await click('[data-main-tab="file:README.md"]')
await key('W', ['meta'])
await until(() => js(`document.querySelector('[data-main-tab="file:README.md"]') === null`), { label: 'closed readme' })
check('a-cmd-w-file', true, 'README closed')
await key('T', ['meta', 'shift'])
await until(() => js(`document.querySelector('[data-main-tab="file:README.md"]') !== null`), { label: 'reopened readme' })
const reopened = (await tabs())[0].tabs
check('d-reopen-same-place-preview', reopened.at(-1)?.id === 'file:README.md' && reopened.at(-1)?.preview === 'true', reopened)

// ⓑ 끌기 — 탭바 안: sample.ts 를 터미널 탭 앞으로
const sampleRect = await rect('[data-main-tab="file:src/sample.ts"]')
const termRect = await rect(`[data-main-tab="${terminalId}"]`)
await drag({ x: Math.round(sampleRect.x + sampleRect.w / 2), y: Math.round(sampleRect.y + sampleRect.h / 2) }, { x: Math.round(termRect.x + 8), y: Math.round(termRect.y + termRect.h / 2) })
const reordered = (await tabs())[0].tabs.map((tab) => tab.id)
check('b-drag-reorder-file', reordered[0] === 'file:src/sample.ts' && reordered[1] === terminalId, reordered)
// 본문 오른쪽 끝으로 끌어 분할 — long.txt 를 새 오른쪽 영역으로
const longRect = await rect('[data-main-tab="file:notes/long.txt"]')
const bodyRect = await rect('[data-file-group]') ?? (await rect('.term-group'))
await click('[data-main-tab="file:notes/long.txt"]')
const body = await rect('[data-file-group]')
await drag({ x: Math.round(longRect.x + longRect.w / 2), y: Math.round(longRect.y + longRect.h / 2) }, { x: Math.round(body.x + body.w - 20), y: Math.round(body.y + body.h / 2) })
const split = await tabs()
check('b-drag-split-file', split.length === 2 && split.some((group) => group.tabs.length === 1 && group.tabs[0].id === 'file:notes/long.txt'), { split, bodyRect })
await shot('m01-split-file-group')

// ⓒ 영역 닫기 — 파일 탭만 있는 영역을 ⌘⌥W
const fileOnly = split.findIndex((group) => group.tabs.length === 1 && group.tabs[0].id === 'file:notes/long.txt')
if (fileOnly >= 0) {
  await click('[data-main-tab="file:notes/long.txt"]')
  await key('W', ['meta', 'alt'])
  await sleep(500)
}
const afterGroupClose = await tabs()
check('c-group-close', afterGroupClose.length === 1, afterGroupClose)

// ⓗ 파일 탭 우클릭 메뉴 — 핀·색·이름 바꾸기 없음
const sr = await rect('[data-main-tab="file:src/sample.ts"]')
await ctl(root, { cmd: 'raw-mouse', type: 'mouseDown', x: Math.round(sr.x + 40), y: Math.round(sr.y + sr.h / 2), button: 'right' })
await ctl(root, { cmd: 'raw-mouse', type: 'mouseUp', x: Math.round(sr.x + 40), y: Math.round(sr.y + sr.h / 2), button: 'right' })
await sleep(300)
const menu = await js(`[...document.querySelectorAll('[data-file-tab-menu] [role="menuitem"], [data-file-tab-menu] button')].map((el) => ({ label: el.textContent.trim(), disabled: el.getAttribute('aria-disabled') === 'true' || el.disabled === true }))`)
check('h-file-tab-menu', menu.length > 0 && !menu.some((item) => /핀|고정됨|색|이름/.test(item.label)), menu)
await key('Escape')
await shot('m02-file-tab-menu')

// ⓔ 재시작 복원 — 상태를 적고, doomed.txt 를 탭으로 연 뒤 앱만 내리고 그 파일을 지우고 다시 띄운다
await openFile('notes/doomed.txt', true)
await openFile('config/settings.json', false)
await sleep(800) // ui-prefs 저장(디바운스) 대기
const beforeRestart = await tabs()
execFileSync('sh', ['scripts/l577/g-down.sh', root, 'term'], { stdio: 'ignore' })
fs.rmSync(path.join(repo, 'notes/doomed.txt'))
execFileSync('sh', ['scripts/l577/g-up.sh', root, values.fake], { stdio: 'ignore' })
await until(async () => (await js(`document.querySelectorAll('[data-main-tab]').length`).catch(() => 0)) >= beforeRestart[0].tabs.length, { label: 'restored tabs', timeoutMs: 30_000 })
await sleep(1500)
const afterRestart = await tabs()
const strip = (groups) => groups.map((group) => group.tabs.map((tab) => `${tab.id}|${tab.active}|${tab.preview}`))
check('e-restore-order-active-preview', JSON.stringify(strip(afterRestart)) === JSON.stringify(strip(beforeRestart)), { before: strip(beforeRestart), after: strip(afterRestart) })
check('e-restore-deleted-marked', afterRestart.flatMap((group) => group.tabs).find((tab) => tab.id === 'file:notes/doomed.txt')?.deleted === true, afterRestart)
await click('[data-main-tab="file:notes/doomed.txt"]')
await until(() => js(`!!document.querySelector('[data-file-view="notes/doomed.txt"] [data-file-notice="not_found"]')`), { label: 'not_found notice' })
check('e-restore-deleted-notice', true, 'not_found notice')
await shot('m03-restored-deleted')

// 섞인 영역에서 터미널 탭 메뉴 「다른 탭 닫기」 — 파일 탭은 배치에서만 닫히고 herdr 닫기 요청에는 파일 탭 id 가 가지 않는다(요청 수 = 터미널 탭 수 0).
const closeLogBefore = fs.readFileSync(path.join(root, 'ud/corral.ndjson'), 'utf8').split('\n').filter((line) => line.includes('"tag":"lifecycle.close_tabs"')).length
const tr = await rect(`[data-main-tab="${terminalId}"]`)
await ctl(root, { cmd: 'raw-mouse', type: 'mouseDown', x: Math.round(tr.x + 40), y: Math.round(tr.y + tr.h / 2), button: 'right' })
await ctl(root, { cmd: 'raw-mouse', type: 'mouseUp', x: Math.round(tr.x + 40), y: Math.round(tr.y + tr.h / 2), button: 'right' })
await until(() => js(`!!document.querySelector('[data-tab-menu-close-others]')`), { label: 'terminal tab menu' })
await click('[data-tab-menu-close-others]')
await sleep(800)
const afterOthers = await tabs()
const closeLogs = fs.readFileSync(path.join(root, 'ud/corral.ndjson'), 'utf8').split('\n').filter((line) => line.includes('"tag":"lifecycle.close_tabs"')).slice(closeLogBefore).map((line) => JSON.parse(line))
check('a-close-others-mixed', afterOthers.length === 1 && afterOthers[0].tabs.length === 1 && afterOthers[0].tabs[0].id === terminalId && closeLogs.every((row) => row.requested === 0), { afterOthers, closeLogs })

writeJson(path.join(values.out, 'mixed-tabs.json'), { root, checks })
const failed = checks.filter((row) => !row.pass)
console.log(JSON.stringify({ total: checks.length, failed: failed.map((row) => row.id) }))
process.exit(failed.length === 0 ? 0 : 1)
