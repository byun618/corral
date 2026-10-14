// LIFE-592 빠른 확인 보조 — 핵심 진입점 밖 입구를 한 번씩(격리 Electron, fixture 만). 최종 관문이 아니다(그건 별도 일감).
//   ① 수정 중 탭 파일을 트리에서 끌어 폴더로 옮김(문턱·강조·탭 따라감·「삭제됨」 표본) → ⌘S 새 경로 ② 문턱 아래 움직임 = 클릭(미리보기 열기, 이동 0)
//   ③ 자기 하위로 끌기 = 무동작 ④ 트리 ⌘Z = 이동 되돌림(탭도 옛 경로) ⑤ 빈 영역 메뉴 새 폴더 — 이미 있는 이름(대소문자 무시) 안내·디스크 무변경·Esc 취소
//   ⑥ 행 메뉴 새 폴더 `a/b`(중간 폴더) ⑦ 행 메뉴 복제(copy 이름·sha) ⑧ 대소문자만 이름 바꾸기 ⑨ 폴더 삭제(확인 요청 isDir·되돌릴 수 없음) → ⌘Z 무동작
//   ⑩ 터미널 포커스 ⌘Z — 탐색기 기록 무변화(디스크 무변경)
// 사용(app/ 에서, iso.sh 안): node scripts/l592/extra-flow.mjs <ROOT> <OUT.json>
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson } from './lib.mjs'

const [root, out] = process.argv.slice(2)
if (!/^\/tmp\/l592g-[^/]+$/.test(root ?? '') || out === undefined) throw new Error('사용: extra-flow.mjs /tmp/l592g-* OUT.json')
const repo = path.join(root, 'repo')
const result = { at: new Date().toISOString(), method: 'sendInputEvent (control socket) — not CGEvent', steps: [], trashed: [], checks: {} }
const step = (name, data) => {
  result.steps.push({ name, at: new Date().toISOString(), ...data })
  console.log(`# ${name} ${JSON.stringify(data).slice(0, 300)}`)
}
const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null)
const exists = (rel) => fs.existsSync(path.join(repo, rel))
const listing = (rel) => fs.readdirSync(path.join(repo, rel)).sort()
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const treeFocused = () => q(`document.activeElement === document.querySelector('[data-explorer-tree]')`)
const focusRow = async (rel) => {
  await until(async () => {
    await ctl(root, { cmd: 'click', selector: `[data-explorer-row="${rel}"]` })
    await sleep(200)
    return (await treeFocused()) && (await q(`document.querySelector('[data-explorer-row="${rel}"]')?.classList.contains('is-selected') === true`))
  }, { timeoutMs: 6000, label: `트리 포커스 ${rel}` })
}
const center = async (selector) => {
  const rect = (await ctl(root, { cmd: 'rect', selector })).rect
  if (rect === null || rect === undefined) throw new Error(`rect 없음 ${selector}`)
  return { x: Math.round(rect.left + Math.min(rect.width / 2, 80)), y: Math.round(rect.top + rect.height / 2) }
}
const mouse = (type, at, button = 'left') => ctl(root, { cmd: 'raw-mouse', type, x: at.x, y: at.y, button })
const rowMenu = async (rel, action) => {
  const at = await center(`[data-explorer-row="${rel}"]`)
  await mouse('mouseDown', at, 'right')
  await mouse('mouseUp', at, 'right')
  await until(() => q(`document.querySelector('[data-explorer-row-menu] [data-menu-action="${action}"]') !== null`), { label: `메뉴 ${action}` })
  await ctl(root, { cmd: 'click', selector: `[data-explorer-row-menu] [data-menu-action="${action}"]` })
}
const editorFocus = async (rel) =>
  until(async () => {
    await ctl(root, { cmd: 'click', selector: `[data-file-view="${rel}"] [data-file-editor] .view-lines` })
    await sleep(200)
    return q(`document.activeElement?.closest('[data-file-editor]') !== null`)
  }, { timeoutMs: 6000, label: `편집기 포커스 ${rel}` })
const startSampler = () => q(`(() => { window.__l592seen = []; clearInterval(window.__l592timer); window.__l592timer = setInterval(() => { const d = document.querySelector('.main-tab.is-deleted, [data-file-notice="deleted"]'); if (d) window.__l592seen.push({ at: Date.now(), tab: d.getAttribute('data-file-tab') }) }, 20); return true })()`)
const stopSampler = () => q(`(() => { clearInterval(window.__l592timer); return window.__l592seen })()`)
const tabState = (rel) => q(`(() => { const t = document.querySelector('[data-file-tab="${rel}"]'); return t === null ? null : { dirty: t.dataset.fileDirty, preview: t.dataset.tabPreview, active: t.dataset.active } })()`)

await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
const { paneId } = await repoPane(root)
await sleep(1500)
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
const panelOpen = async () => (await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
if (!(await panelOpen())) await key('L', ['meta'])
await until(panelOpen, { label: '탐색기' })
await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { label: '탐색기 행' })
await focusRow('src')
if ((await q(`document.querySelector('[data-explorer-row="src"]')?.getAttribute('aria-expanded')`)) === 'false') await key('Right')
await until(() => q(`document.querySelector('[data-explorer-row="src/l592-a.ts"]') !== null`), { label: 'src 펼침' })

// ① 수정 중 탭 → 끌어 옮기기
await ctl(root, { cmd: 'dblclick', selector: '[data-explorer-row="src/l592-a.ts"]' })
await until(() => q(`document.querySelector('[data-file-tab="src/l592-a.ts"]')?.dataset.tabPreview === 'false'`), { label: '고정 탭' })
await editorFocus('src/l592-a.ts')
await ctl(root, { cmd: 'type', text: 'Q' })
await until(() => q(`document.querySelector('[data-file-tab="src/l592-a.ts"]')?.dataset.fileDirty === 'true'`), { label: '수정' })
const shaA = sha(path.join(repo, 'src/l592-a.ts'))
const from = await center('[data-explorer-row="src/l592-a.ts"]')
const to = await center('[data-explorer-row="docs"]')
await mouse('mouseDown', from)
await mouse('mouseMove', { x: from.x + 3, y: from.y })
await sleep(80)
const draggingBelowThreshold = await q(`document.querySelector('.explorer-scroll.is-dragging') !== null`)
for (let index = 1; index <= 6; index += 1) {
  await mouse('mouseMove', { x: from.x + ((to.x - from.x) * index) / 6, y: from.y + ((to.y - from.y) * index) / 6 })
  await sleep(40)
}
const highlight = await q(`({ dragging: document.querySelector('.explorer-scroll.is-dragging') !== null, target: [...document.querySelectorAll('.explorer-row.is-drop-target')].map((e) => e.dataset.explorerRow), source: document.querySelector('.explorer-row.is-drag-source')?.dataset.explorerRow ?? null })`)
await startSampler()
await mouse('mouseUp', to)
await until(() => exists('docs/l592-a.ts'), { label: '이동' })
await until(() => q(`document.querySelector('[data-file-tab="docs/l592-a.ts"]') !== null`), { label: '탭 따라감' })
await sleep(1500)
const seenMove = await stopSampler()
const movedTab = await tabState('docs/l592-a.ts')
step('drag-move', { draggingBelowThreshold, highlight, srcGone: !exists('src/l592-a.ts'), shaSame: sha(path.join(repo, 'docs/l592-a.ts')) === shaA, movedTab, oldTab: await tabState('src/l592-a.ts'), seenDeleted: seenMove })
await editorFocus('docs/l592-a.ts')
await key('S', ['meta'])
await until(() => q(`document.querySelector('[data-file-tab="docs/l592-a.ts"]')?.dataset.fileDirty === 'false'`), { label: '저장' })
const savedA = fs.readFileSync(path.join(repo, 'docs/l592-a.ts'), 'utf8')
step('drag-save', { savedA, srcBack: exists('src/l592-a.ts') })
result.checks.dragMove = draggingBelowThreshold === false && highlight.target.includes('docs') && highlight.source === 'src/l592-a.ts' && movedTab?.dirty === 'true' && seenMove.length === 0 && savedA.includes('Q') && !exists('src/l592-a.ts')

// ② 문턱 아래 움직임 = 클릭
const b = await center('[data-explorer-row="src/l592-b.ts"]')
await mouse('mouseDown', b)
await mouse('mouseMove', { x: b.x + 3, y: b.y + 2 })
await mouse('mouseUp', { x: b.x + 3, y: b.y + 2 })
await until(() => q(`document.querySelector('[data-file-tab="src/l592-b.ts"]') !== null`), { label: '클릭 열기' })
step('click-small-move', { tab: await tabState('src/l592-b.ts'), stillThere: exists('src/l592-b.ts') })
result.checks.clickThreshold = exists('src/l592-b.ts') && (await tabState('src/l592-b.ts'))?.preview === 'true'

// ③ 자기 하위로 끌기 = 무동작
const srcAt = await center('[data-explorer-row="src"]')
const subAt = await center('[data-explorer-row="src/sub"]')
await mouse('mouseDown', srcAt)
for (let index = 1; index <= 5; index += 1) {
  await mouse('mouseMove', { x: srcAt.x, y: srcAt.y + ((subAt.y - srcAt.y) * index) / 5 })
  await sleep(40)
}
const intoSelf = await q(`({ target: [...document.querySelectorAll('.explorer-row.is-drop-target')].map((e) => e.dataset.explorerRow) })`)
await mouse('mouseUp', subAt)
await sleep(400)
step('drag-into-self', { intoSelf, srcStill: exists('src/sub/l592-c.md'), nested: exists('src/sub/src') })
result.checks.intoSelf = intoSelf.target.length === 0 && exists('src/sub/l592-c.md') && !exists('src/sub/src')

// ④ 트리 ⌘Z = 이동 되돌림
await focusRow('docs')
await startSampler()
await key('Z', ['meta'])
await until(() => exists('src/l592-a.ts'), { label: '이동 되돌림' })
await until(() => q(`document.querySelector('[data-file-tab="src/l592-a.ts"]') !== null`), { label: '탭 옛 경로' })
await sleep(1200)
step('undo-move', { back: exists('src/l592-a.ts'), docsGone: !exists('docs/l592-a.ts'), tab: await tabState('src/l592-a.ts'), seenDeleted: await stopSampler() })
result.checks.undoMove = exists('src/l592-a.ts') && !exists('docs/l592-a.ts')

// ⑤ 빈 영역 메뉴 → 새 폴더, 이미 있는 이름(대소문자 무시) 안내, Esc
const scrollRect = (await ctl(root, { cmd: 'rect', selector: '.explorer-scroll' })).rect
const empty = { x: Math.round(scrollRect.left + 60), y: Math.round(scrollRect.top + scrollRect.height - 20) }
await mouse('mouseDown', empty, 'right')
await mouse('mouseUp', empty, 'right')
await until(() => q(`document.querySelector('[data-explorer-empty-menu] [data-menu-action="newFolder"]') !== null`), { label: '빈 영역 메뉴' })
await ctl(root, { cmd: 'click', selector: '[data-explorer-empty-menu] [data-menu-action="newFolder"]' })
await until(() => q(`document.activeElement?.matches('[data-explorer-input]') === true`), { label: '입력 행' })
const before = listing('.')
// 하네스 주의: main before-input-event 가 막은 keyDown(④ 의 ⌘Z) 뒤에는 Chromium 이 다음 keyDown 까지 char 를 버린다(suppress_events_until_keydown).
// 제어 소켓 `type` 은 char 만 보내므로 먼저 무해한 keyDown(Shift) 하나를 보낸다. 실제 키보드는 늘 keyDown 이 앞선다.
await key('Shift')
await q(`(() => { window.__l592focus = []; if (!window.__l592focusProbe) { window.__l592focusProbe = true; document.addEventListener('focusout', (e) => window.__l592focus?.push(['out', e.target.className, String(e.relatedTarget?.className ?? null), Date.now()]), true); for (const t of ['keydown', 'keypress', 'beforeinput', 'input']) document.addEventListener(t, (e) => window.__l592focus?.push([t, e.key ?? e.data ?? null, e.target?.className ?? null, e.defaultPrevented]), true) } window.__l592input = document.querySelector('[data-explorer-input]'); return true })()`)
await ctl(root, { cmd: 'type', text: 'DOCS' })
await sleep(100)
const message = await q(`document.querySelector('[data-explorer-input-message]')?.textContent ?? null`)
result.focusDuringValidate = await q(`({ sameInput: window.__l592input === document.querySelector('[data-explorer-input]'), events: window.__l592focus, value: document.querySelector('[data-explorer-input]')?.value ?? null, active: document.activeElement?.className ?? null })`)
await key('Return')
await sleep(300)
const stillOpen = await q(`document.querySelector('[data-explorer-input]') !== null`)
await key('Escape')
await sleep(200)
step('validate-exists', { message, stillOpenAfterEnter: stillOpen, closedAfterEsc: await q(`document.querySelector('[data-explorer-input]') === null`), diskSame: JSON.stringify(listing('.')) === JSON.stringify(before), refocused: await treeFocused() })
result.checks.validate = typeof message === 'string' && message.includes('이미 있습니다') && stillOpen === true && JSON.stringify(listing('.')) === JSON.stringify(before)

// ⑥ 행 메뉴 새 폴더 — 중간 폴더까지
await rowMenu('src', 'newFolder')
await until(() => q(`document.activeElement?.matches('[data-explorer-input]') === true`), { label: '입력 행(폴더)' })
await ctl(root, { cmd: 'type', text: 'l592-dir/inner' })
await key('Return')
await until(() => exists('src/l592-dir/inner'), { label: '중간 폴더' })
const innerMode = (fs.statSync(path.join(repo, 'src/l592-dir/inner')).mode & 0o777).toString(8)
await until(() => q(`document.querySelector('[data-explorer-row="src/l592-dir"]') !== null`), { label: '새 폴더 행' })
step('new-folder-nested', { innerMode, selected: await q(`document.querySelector('.explorer-row.is-selected')?.dataset.explorerRow ?? null`) })
result.checks.newFolder = exists('src/l592-dir/inner')

// ⑦ 복제
const shaTop = sha(path.join(repo, 'l592-top.txt'))
await rowMenu('l592-top.txt', 'duplicate')
await until(() => exists('l592-top copy.txt'), { label: '복제' })
step('duplicate', { shaSame: sha(path.join(repo, 'l592-top copy.txt')) === shaTop, selected: await q(`document.querySelector('.explorer-row.is-selected')?.dataset.explorerRow ?? null`) })
result.checks.duplicate = sha(path.join(repo, 'l592-top copy.txt')) === shaTop

// ⑧ 대소문자만 이름 바꾸기
await focusRow('l592-top.txt')
await key('Return')
await until(() => q(`document.activeElement?.matches('[data-explorer-input]') === true`), { label: '이름 변경 입력' })
await ctl(root, { cmd: 'type', text: 'L592-TOP' })
await key('Return')
await until(() => listing('.').includes('L592-TOP.txt'), { label: '대소문자 변경' })
step('case-rename', { listing: listing('.') })
result.checks.caseRename = listing('.').includes('L592-TOP.txt') && !listing('.').includes('l592-top.txt')

// ⑨ 폴더 삭제 — 확인 요청(isDir·되돌릴 수 없음) → 휴지통, ⌘Z 무동작
await ctl(root, { cmd: 'file-dialog-stub', answers: ['trash'] })
const dirTrashAt = new Date().toISOString()
await rowMenu('src/l592-dir', 'trash')
await until(() => !exists('src/l592-dir'), { label: '폴더 휴지통' })
result.trashed.push({ path: path.join(repo, 'src/l592-dir'), at: dirTrashAt, via: '행 메뉴 삭제 → shell.trashItem (폴더, 안에 inner/)' })
await ctl(root, { cmd: 'file-dialog-stub', answers: [] })
const logFile = path.join(root, 'ud/corral.ndjson')
const dialogLine = fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => line.includes('"file.dialog"')).pop() ?? null
await focusRow('src')
await key('Z', ['meta'])
await sleep(600)
step('trash-dir', { dialogLine, afterUndo: exists('src/l592-dir'), caseNameStill: listing('.').includes('L592-TOP.txt') })
// ⌘Z 는 폴더를 되살리지 않는다(Q1) — 그 앞 기록(대소문자 이름 바꾸기)을 되돌린다.
result.checks.trashDir = !exists('src/l592-dir')

// ⑩ 터미널 포커스 ⌘Z — 탐색기 기록 무변화
const snapshot = JSON.stringify([listing('.'), listing('src'), listing('docs')])
await ctl(root, { cmd: 'click', selector: '.main-tab:not(.main-tab-file)' }).catch(() => null)
await sleep(400)
await ctl(root, { cmd: 'click', selector: `[data-term-pane-box="${paneId}"]` }).catch(() => null)
await sleep(300)
const termFocused = await q(`document.activeElement?.closest('[data-term-pane-box]') !== null`)
await key('Z', ['meta'])
await sleep(600)
step('terminal-cmdz', { termFocused, diskSame: JSON.stringify([listing('.'), listing('src'), listing('docs')]) === snapshot })
result.checks.terminalCmdZ = termFocused === true && JSON.stringify([listing('.'), listing('src'), listing('docs')]) === snapshot

result.log = fs.readFileSync(logFile, 'utf8').split('\n').filter((line) => /explorer\.op|file\.dialog|shortcut\.intercepted/.test(line)).slice(-60)
result.pass = Object.values(result.checks).every((value) => value === true)
writeJson(out, result)
console.log(`# checks ${JSON.stringify(result.checks)} pass=${result.pass}`)
process.exit(result.pass ? 0 : 1)
