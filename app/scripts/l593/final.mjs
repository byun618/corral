// LIFE-593 최종 관문 — 격리 회차(01-criteria E1~E6·E8). 격리 개발 Electron(iso.sh 가 /tmp/l593g-* 에 띄운 것)과 그 fixture 에서만.
// 사용(app/ 에서, iso.sh 안): node scripts/l593/final.mjs <ROOT> <OUT.json> <case>[,<case>...] <FAKE>
//   사례: e1 e2 e2q e3 e4 e5 e5r e6 e8   (e2q 는 L593_Q_REPO=<corral fd1664c4d 트리 레포> 필요 · e4·e5r 는 앱을 다시 띄운다 — FAKE 필요)
//   ISO_ENV='L577_ELECTRON_ARGS=--remote-debugging-port=0' — CDP(합성 IME 조합).
// 입력: 제어 소켓 sendInputEvent · CDP(Input.imeSetComposition·dispatchKeyEvent·insertText) · DOM 값 setter(필터 입력칸에 한꺼번에 넣기만)·DOM focus(사이드바 포커스).
//   OS 키 입력(CGEvent)·시스템 클립보드 쓰기 없음. 휴지통에는 이름에 l593 이 든 fixture 항목만 간다(결과 `trashed`).
// 판정: 사례마다 check(이름, 참/거짓, 원자료). 하나라도 거짓이면 종료 코드 1. 「한계 확인」 은 limit(…) 로 따로 적고 판정에 넣지 않는다.
/* global fetch, WebSocket */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ctl, evalJs, sleep, until, repoPane, writeJson, exposeMonaco, herdr, giveBack, giveBackLog } from './lib.mjs'

const [root, out, caseArg, fake] = process.argv.slice(2)
if (!/^\/tmp\/l593g-[^/]+$/.test(root ?? '') || out === undefined || caseArg === undefined) throw new Error('사용: final.mjs /tmp/l593g-* OUT.json case[,case] FAKE')
const repo = path.join(root, 'repo')
const outside = path.join(root, 'outside')
const result = { at: new Date().toISOString(), root, method: 'sendInputEvent(control socket) · CDP — not CGEvent', cases: {}, trashed: [], checks: [], limits: [] }
let current = null
const log = (name, data) => {
  current.steps.push({ name, at: new Date().toISOString(), ...data })
  console.log(`# ${current.name}/${name} ${JSON.stringify(data).slice(0, 300)}`)
}
const check = (name, ok, data = null) => {
  const row = { case: current.name, name, ok: ok === true, data }
  result.checks.push(row)
  current.checks.push(row)
  console.log(`${ok === true ? 'PASS' : 'FAIL'} ${current.name}/${name}${ok === true ? '' : ` ${JSON.stringify(data).slice(0, 400)}`}`)
  return ok === true
}
const limit = (name, data) => {
  result.limits.push({ case: current.name, name, data })
  console.log(`LIMIT ${current.name}/${name} ${JSON.stringify(data).slice(0, 300)}`)
}

// --- 화면 ----------------------------------------------------------------------------------------------
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const type = async (text) => {
  await key('Shift')
  return ctl(root, { cmd: 'type', text })
}
const click = (selector) => ctl(root, { cmd: 'click', selector })
const clickUntil = (selector, label = selector) => until(async () => (await click(selector)).ok === true, { timeoutMs: 8000, label })
const rect = async (selector) => (await ctl(root, { cmd: 'rect', selector })).rect ?? null
const mouse = (kind, at, button = 'left') => ctl(root, { cmd: 'raw-mouse', type: kind, x: Math.round(at.x), y: Math.round(at.y), button })
const row = (rel) => `[data-explorer-row="${rel}"]`
const hasRow = (rel) => q(`document.querySelector('${row(rel)}') !== null`)
const treeFocused = () => q(`document.activeElement === document.querySelector('[data-explorer-tree]')`)
const selectedRow = () => q(`document.querySelector('.explorer-row.is-selected')?.dataset.explorerRow ?? null`)
const expanded = (rel) => q(`document.querySelector('${row(rel)}')?.getAttribute('aria-expanded') ?? null`)
const explorerRows = () => q(`[...document.querySelectorAll('[data-explorer-row]')].map((e) => e.dataset.explorerRow)`)
const expandedRows = () => q(`[...document.querySelectorAll('[data-explorer-row][aria-expanded="true"]')].map((e) => e.dataset.explorerRow)`)
const activeInfo = () => q(`(() => { const a = document.activeElement; return { tag: a?.tagName ?? null, cls: String(a?.className ?? '').slice(0, 60), quickInput: a?.matches?.('[data-quick-open-input]') === true, toggle: a?.matches?.('[data-quick-open-ignored]') === true, xterm: a?.classList?.contains('xterm-helper-textarea') === true, tree: a === document.querySelector('[data-explorer-tree]'), editor: a?.closest?.('[data-file-editor]') != null, sidebar: a?.closest?.('aside, .sidebar, [data-sidebar]') != null, filterInput: a?.matches?.('[data-explorer-filter-input]') === true } })()`)
const focusRow = async (rel) => {
  const was = await expanded(rel)
  await until(async () => {
    await click(row(rel))
    await sleep(150)
    return (await treeFocused()) && (await selectedRow()) === rel
  }, { timeoutMs: 8000, label: `트리 포커스 ${rel}` })
  const now = await expanded(rel)
  if (was !== null && now !== was) {
    await key(was === 'true' ? 'Right' : 'Left')
    await until(async () => (await expanded(rel)) === was, { label: `펼침 복귀 ${rel}` })
  }
}
const expand = async (rel) => {
  if ((await expanded(rel)) === 'true') return
  await focusRow(rel)
  if ((await expanded(rel)) !== 'true') await key('Right')
  await until(async () => (await expanded(rel)) === 'true', { label: `펼침 ${rel}` })
}
const panelOpen = async () => (await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
const openPanel = async () => {
  if (!(await panelOpen())) await key('L', ['meta'])
  await until(panelOpen, { label: '탐색기' })
  await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { label: '탐색기 행' })
}
const tab = (rel) => q(`(() => { const t = document.querySelector('[data-file-tab="${rel}"]'); if (t === null) return null; return { dirty: t.dataset.fileDirty ?? null, preview: t.dataset.tabPreview ?? null, active: t.dataset.active ?? null } })()`)
const fileTabs = () => q(`[...document.querySelectorAll('[data-file-tab]')].map((t) => t.dataset.fileTab)`)
const termTabs = () => q(`[...document.querySelectorAll('.main-tab:not(.main-tab-file)')].map((e) => e.dataset.mainTab)`)
const stub = (answers) => ctl(root, { cmd: 'file-dialog-stub', answers })
const termText = async () => ((await ctl(root, { cmd: 'term-read' })).term?.lines ?? []).join('\n')
const logRows = () => {
  try {
    return fs.readFileSync(path.join(root, 'ud/corral.ndjson'), 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return {} } })
  } catch { return [] }
}
const prefsFile = () => path.join(root, 'ud', 'ui-prefs.json')
const prefs = () => { try { return JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) } catch { return null } }
const recentOf = (repoPath = repo) => prefs()?.recentFiles?.[fs.realpathSync(repoPath)] ?? null

// --- 빠른 열기 -------------------------------------------------------------------------------------------
const qoOpen = () => q(`!!document.querySelector('[data-quick-open]')`)
const qoState = () => q(`document.querySelector('[data-quick-open]')?.dataset.quickOpenState ?? null`)
const qoRows = () => q(`[...document.querySelectorAll('[data-quick-open-row]')].map((e) => e.dataset.quickOpenRow)`)
const qoRowsFull = () => q(`[...document.querySelectorAll('[data-quick-open-row]')].map((e) => ({ rel: e.dataset.quickOpenRow, group: e.dataset.quickOpenGroup, marks: [...e.querySelectorAll('mark')].map((m) => m.textContent) }))`)
const qoInputValue = () => q(`document.querySelector('[data-quick-open-input]')?.value ?? null`)
const pressQuick = async () => {
  await key('Shift')
  await key('P', ['meta'])
  await until(qoOpen, { timeoutMs: 8000, label: '⌘P 열림' })
}
/** 행이 두 번 연달아 같으면(그리고 준비·읽는 중 아님) 그 질의 결과로 본다. */
const stableRows = async (label) => {
  let last = null
  return (await until(async () => {
    if ((await qoState()) !== 'ready') return null
    if (await q(`document.querySelector('[data-quick-open]')?.hasAttribute('data-quick-open-loading') === true`)) return null
    const now = JSON.stringify(await qoRowsFull())
    const same = now === last
    last = now
    return same ? JSON.parse(now) : null
  }, { timeoutMs: 15_000, everyMs: 200, label })).value
}
/** ⌘P → (질의) → 안정된 결과. 대화상자는 열어 둔다. */
const quick = async (query) => {
  if (!(await qoOpen())) await pressQuick()
  await until(async () => (await qoState()) === 'ready', { timeoutMs: 15_000, label: '⌘P 준비' })
  if (query !== '') await type(query)
  await sleep(300)
  return stableRows(`결과 ${query}`)
}
const quickClose = async () => {
  if (!(await qoOpen())) return
  await key('Escape')
  await until(async () => !(await qoOpen()), { timeoutMs: 4000, label: '⌘P 닫힘' })
}
/** ⌘P 로 rel 을 연다(질의 → 그 행이 맨 위 → Enter) — 맨 위가 아니면 클릭. */
const quickOpenFile = async (rel, query = rel) => {
  const rows = await quick(query)
  if (rows[0]?.rel === rel) await key('Return')
  else await clickUntil(`[data-quick-open-row="${rel}"]`, `⌘P 행 ${rel}`)
  await until(async () => (await tab(rel))?.active === 'true', { timeoutMs: 8000, label: `탭 ${rel}` })
}

// --- 터미널·편집기 ----------------------------------------------------------------------------------------
let paneIdCache = null
const terminalPane = async () => {
  if (paneIdCache === null) paneIdCache = (await repoPane(root)).paneId
  return paneIdCache
}
const showTerminal = async () => {
  const paneId = await terminalPane()
  const tabId = ((await herdr(root, 'pane.list')).panes ?? []).find((item) => item.pane_id === paneId)?.tab_id
  await until(async () => (await click(`[data-main-tab="${tabId}"]`)).hit === true, { timeoutMs: 15_000, everyMs: 200, label: '터미널 탭' })
  await until(async () => (await ctl(root, { cmd: 'state' })).state?.terminal?.phase === 'streaming', { timeoutMs: 15_000, label: 'streaming' })
  await until(async () => {
    if ((await activeInfo()).xterm) return true
    await ctl(root, { cmd: 'term-click', fx: 0.5, fy: 0.5 })
    await sleep(150)
    return (await activeInfo()).xterm
  }, { timeoutMs: 8000, everyMs: 200, label: '터미널 포커스' })
}
const editorOf = (rel) => `(() => { const host = document.querySelector('[data-file-view="${rel}"] [data-file-editor]'); return host === null ? null : (window.l593Monaco?.editor.getEditors().find((x) => host.contains(x.getContainerDomNode())) ?? null) })()`
const modelText = (rel) => q(`(${editorOf(rel)})?.getModel()?.getValue() ?? null`)
const waitEditor = (rel) => until(() => q(`${editorOf(rel)} !== null`), { timeoutMs: 10_000, label: `편집기 ${rel}` })
const focusEditor = async (rel) => {
  await waitEditor(rel)
  await until(async () => {
    await click(`[data-file-view="${rel}"] [data-file-editor] .view-lines`)
    await sleep(150)
    return (await activeInfo()).editor
  }, { timeoutMs: 8000, label: `편집기 포커스 ${rel}` })
}

// --- CDP -----------------------------------------------------------------------------------------------
let cdpSocket = null
let cdpSeq = 0
const cdpPending = new Map()
async function cdp(method, params = {}) {
  if (cdpSocket === null) {
    const port = Number(fs.readFileSync(path.join(root, 'ud/DevToolsActivePort'), 'utf8').split('\n')[0])
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = pages.find((item) => item.type === 'page' && item.url.includes('/out/renderer/'))
    cdpSocket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => ((cdpSocket.onopen = resolve), (cdpSocket.onerror = reject)))
    cdpSocket.onmessage = ({ data }) => {
      const message = JSON.parse(data)
      const waiter = cdpPending.get(message.id)
      if (waiter === undefined) return
      cdpPending.delete(message.id)
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    }
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  }
  return new Promise((resolve, reject) => {
    cdpSeq += 1
    cdpPending.set(cdpSeq, { resolve, reject })
    cdpSocket.send(JSON.stringify({ id: cdpSeq, method, params }))
  })
}
/** 조합 중 키(229) — 한글 조합을 열고 그 상태에서 key 를 누른다. 조합은 열어 둔다. */
const imeKey = async (keyName, code) => {
  await cdp('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 })
  await cdp('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1 })
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code, windowsVirtualKeyCode: 229 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: 229 })
  await sleep(300)
}
const imeCommit = async (text) => {
  await cdp('Input.insertText', { text })
  await sleep(200)
}

// --- 앱 재시작 --------------------------------------------------------------------------------------------
async function restartApp(beforeUp = () => undefined) {
  cdpSocket?.close()
  cdpSocket = null
  await ctl(root, { cmd: 'flush-storage' }).catch(() => null)
  const down = execFileSync('sh', ['scripts/l577/g-down.sh', root, 'term'], { encoding: 'utf8' })
  beforeUp()
  const extra = (process.env.ISO_ENV ?? '').split(/\s+/).filter(Boolean).map((item) => item.replaceAll('{ROOT}', root))
  const up = execFileSync('sh', ['scripts/l577/g-up.sh', root, fake, 'L577_KEEP_PAINTING=1', ...extra], { encoding: 'utf8' })
  log('restart', { down: down.trim().split('\n').slice(-2), up: up.trim().split('\n').slice(-1), appPid: fs.readFileSync(path.join(root, 'app.pid'), 'utf8').trim() })
  await until(() => q(`!!document.querySelector('.app-body')`).catch(() => false), { timeoutMs: 30_000, label: '재시작 렌더러' })
  await giveBack()
  await sleep(1500)
  await ctl(root, { cmd: 'resize-window', width: 1400, height: 900 }).catch(() => null)
  await exposeMonaco(root)
}

// --- fixture 덧붙임 ---------------------------------------------------------------------------------------
const write = (rel, text = `// ${rel}\n`) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  fs.writeFileSync(path.join(repo, rel), text)
}
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
const commit = (message) => git('-c', 'user.name=l593', '-c', 'user.email=l593@example.invalid', 'commit', '-q', '-m', message)

// --- 사례 ----------------------------------------------------------------------------------------------
const cases = {}

// E1 — ⌘P 대화상자: ⓔ worktree 없음(먼저) · ⓐ 네 포커스 + PTY 대조 · ⓑ 팔레트와 별도 · ⓒ 닫기·포커스 복귀·inert·단축키 막힘 · ⓓ IME · ⓕ 다시 열면 빈 입력
cases.e1 = async () => {
  // ⓔ — 레포를 등록하기 전(열린 worktree 없음)
  const listBefore = logRows().filter((r) => r.tag === 'file.list').length
  await pressQuick()
  await sleep(800)
  const noRoot = await q(`(() => ({ state: document.querySelector('[data-quick-open]')?.dataset.quickOpenState ?? null, empty: document.querySelector('[data-quick-open-empty]')?.dataset.quickOpenEmpty ?? null, text: document.querySelector('[data-quick-open-empty]')?.textContent ?? null, inputDisabled: document.querySelector('[data-quick-open-input]')?.disabled ?? null }))()`)
  const noRootActive = await q(`(() => { const a = document.activeElement; return { tag: a?.tagName ?? null, cls: String(a?.className ?? '').slice(0, 60), inDialog: a?.closest?.('[data-quick-open]') != null } })()`)
  await key('Escape')
  const escClosed = await until(async () => !(await qoOpen()), { timeoutMs: 2000, label: '닫힘(no-root) Esc' }).then(() => true, () => false)
  let noRootOutside = null
  if (!escClosed) {
    const box = await rect('[data-quick-open]')
    const at = { x: 8, y: Math.max(8, (box?.top ?? 100) + (box?.height ?? 100) + 40) }
    await mouse('mouseDown', at)
    await mouse('mouseUp', at)
    noRootOutside = await until(async () => !(await qoOpen()), { timeoutMs: 3000, label: '닫힘(no-root) 바깥 클릭' }).then(() => true, () => false)
  }
  const listAfter = logRows().filter((r) => r.tag === 'file.list').length
  check('ⓔ 열린 worktree 없음 = 안내만·입력 비활성·file.list IPC 0', noRoot.state === 'no-root' && noRoot.empty === 'no-root' && noRoot.inputDisabled === true && listAfter === listBefore, { noRoot, listBefore, listAfter })
  check('ⓒ(no-root) 안내 상태에서도 Esc 로 닫힘', escClosed, { escClosed, noRootActive, noRootOutside })
  if (await qoOpen()) throw new Error('no-root 대화상자가 닫히지 않음')

  await terminalPane()
  await sleep(1500)
  await exposeMonaco(root)
  // ⓐ 네 포커스 — 터미널·편집기·트리·사이드바. 열고 표지 글자를 친 뒤 Esc → 원래 자리로. PTY·편집기 모델에 표지 0.
  const results = {}
  const mark = (name) => `zq${name}`
  const tryFrom = async (name, focus, isBack) => {
    await focus()
    const before = { active: await activeInfo(), term: await termText() }
    await pressQuick()
    const opened = { active: await activeInfo(), palette: await q(`!!document.querySelector('[data-command-palette]')`), inert: await q(`document.querySelector('.app-body')?.inert === true`) }
    await type(mark(name))
    await sleep(300)
    const value = await qoInputValue()
    await key('Escape')
    await until(async () => !(await qoOpen()), { label: `닫힘 ${name}` })
    await sleep(300)
    const after = { active: await activeInfo(), term: await termText() }
    const leaked = after.term.split(mark(name)).length > before.term.split(mark(name)).length
    results[name] = { before: before.active, opened, value, after: after.active, ptyLeak: leaked }
    return opened.active.quickInput && !opened.palette && opened.inert && value === mark(name) && !leaked && isBack(after.active)
  }
  const okTerm = await tryFrom('term', showTerminal, (a) => a.xterm)
  write('src/l593-e1.ts', 'export const e1 = 1\n')
  await openPanel()
  await quickOpenFile('src/l593-e1.ts', 'l593-e1')
  const okEditor = await tryFrom('editor', () => focusEditor('src/l593-e1.ts'), (a) => a.editor)
  const editorModel = await modelText('src/l593-e1.ts')
  const okTree = await tryFrom('tree', () => focusRow('README.md'), (a) => a.tree)
  const okSidebar = await tryFrom('sidebar', async () => {
    await q(`(() => { const el = [...document.querySelectorAll('aside button, .sidebar button, [data-worktree]')].find((e) => e.offsetParent !== null); el?.focus(); return el?.tagName ?? null })()`)
    await until(async () => (await activeInfo()).sidebar, { timeoutMs: 3000, label: '사이드바 포커스' })
  }, (a) => a.sidebar)
  check('ⓐ 터미널 포커스 ⌘P = 대화상자·PTY 표지 0·Esc 뒤 터미널로', okTerm, results.term)
  check('ⓐ 편집기 포커스 ⌘P = 대화상자·모델 표지 0·Esc 뒤 편집기로', okEditor && !String(editorModel).includes(mark('editor')), { ...results.editor, editorModel })
  check('ⓐ 트리 포커스 ⌘P = 대화상자·Esc 뒤 트리로', okTree, results.tree)
  check('ⓐ 사이드바 포커스 ⌘P = 대화상자·Esc 뒤 사이드바로', okSidebar, results.sidebar)

  // ⓑ 팔레트(⌘K·⌘J)와 별도
  await showTerminal()
  await key('K', ['meta'])
  const k = await until(() => q(`!!document.querySelector('[data-command-palette]') && !document.querySelector('[data-quick-open]')`), { timeoutMs: 4000, label: '⌘K' }).then(() => true, () => false)
  await key('Escape')
  await sleep(300)
  await key('J', ['meta'])
  const j = await until(() => q(`!!document.querySelector('[data-command-palette]') && !document.querySelector('[data-quick-open]')`), { timeoutMs: 4000, label: '⌘J' }).then(() => true, () => false)
  await key('Escape')
  await sleep(300)
  check('ⓑ ⌘K·⌘J = 커맨드 팔레트(⌘P 대화상자 아님)·⌘P = 별도 대화상자', k && j && results.term?.opened?.palette === false, { k, j })

  // ⓒ 열린 동안 다른 단축키 막힘(⌘K·⌘T) · 바깥 클릭 닫힘 + 포커스 복귀
  await showTerminal()
  const t0 = (await termTabs()).length
  await pressQuick()
  await key('K', ['meta'])
  await sleep(400)
  await key('T', ['meta'])
  await sleep(800)
  const blocked = { palette: await q(`!!document.querySelector('[data-command-palette]')`), stillOpen: await qoOpen(), termTabs: (await termTabs()).length }
  const box = await rect('[data-quick-open]')
  await mouse('mouseDown', { x: 8, y: Math.max(8, (box?.top ?? 100) + (box?.height ?? 100) + 40) })
  await mouse('mouseUp', { x: 8, y: Math.max(8, (box?.top ?? 100) + (box?.height ?? 100) + 40) })
  const outsideClosed = await until(async () => !(await qoOpen()), { timeoutMs: 3000, label: '바깥 클릭' }).then(() => true, () => false)
  await sleep(300)
  const back = await activeInfo()
  check('ⓒ 열린 동안 ⌘K·⌘T 막힘(팔레트 0·새 탭 0)·뒤 inert', !blocked.palette && blocked.stillOpen && blocked.termTabs === t0 && results.term?.opened?.inert === true, { blocked, t0 })
  check('ⓒ 바깥 클릭 = 닫힘·연 자리(터미널)로 포커스', outsideClosed && back.xterm, { outsideClosed, back })

  // ⓓ IME 조합 중 Enter·화살표 = 대화상자 동작 안 함 — 조합 글자(하)가 들어가도 결과가 남게 이름에 「하」 가 든 파일 둘(G21c: 조합 글자가 질의를 바꿔 결과가 사라져 판별 불가였다)
  write('src/l593-하-a.ts')
  write('src/l593-하-b.ts')
  await quick('l593-')
  const selected = () => q(`document.querySelector('[data-quick-open-row][aria-selected="true"]')?.dataset.quickOpenRow ?? null`)
  await cdp('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 })
  await cdp('Input.imeSetComposition', { text: '하', selectionStart: 1, selectionEnd: 1 })
  await sleep(600)
  const composingRows = (await qoRows()).slice(0, 3)
  const selBefore = await selected()
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'ArrowDown', windowsVirtualKeyCode: 229 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 229 })
  await sleep(300)
  const selAfterArrow = await selected()
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'Enter', windowsVirtualKeyCode: 229 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 })
  await sleep(400)
  const midIme = { open: await qoOpen(), tabs: await fileTabs() }
  await imeCommit('하')
  const committed = await qoInputValue()
  // 양성 대조 — 조합이 끝난 뒤의 ↓ 는 선택을 옮긴다
  await key('Down')
  await sleep(300)
  const selAfterPlainDown = await selected()
  await quickClose()
  check('ⓓ 조합 중 ↓ = 선택 그대로 · 조합 중 Enter = 열지 않음(대화상자 유지) · 조합 뒤 ↓ 는 옮김(양성 대조)', selBefore !== null && selAfterArrow === selBefore && midIme.open === true && !midIme.tabs.includes(selBefore) && selAfterPlainDown !== null && selAfterPlainDown !== selBefore, { composingRows, selBefore, selAfterArrow, midIme, committed, selAfterPlainDown })

  // ⓕ 다시 열면 빈 입력
  await pressQuick()
  await type('abc')
  await sleep(200)
  await quickClose()
  await pressQuick()
  await sleep(300)
  const reopened = await qoInputValue()
  await quickClose()
  check('ⓕ 다시 열면 빈 입력', reopened === '', { reopened })
}

// E2 — ⓐ 규칙 · ⓒ 한글 NFC·NFD · ⓓ 상한 「더 있음」 · ⓔ 빈 입력 = 최근
cases.e2 = async () => {
  write('zeta/l593alpha.ts')
  write('l593alpha/zeta.ts')
  write('src/l593abc-x.ts')
  write('src/l593a-b-c.ts')
  write('main/index.ts')
  write('main/other/index.ts')
  write('other/main-index-notes.md')
  for (let i = 0; i < 60; i += 1) write(`many/l593-many-${String(i).padStart(2, '0')}.ts`)
  await terminalPane()
  await sleep(1500)
  await showTerminal()
  const lower = await quick('readme')
  await quickClose()
  const upper = await quick('README')
  await quickClose()
  check('ⓐ 대소문자 무시(readme·README 맨 위 README.md)', lower[0]?.rel === 'README.md' && upper[0]?.rel === 'README.md', { lower: lower.slice(0, 3), upper: upper.slice(0, 3) })
  const and = await quick('needle guide')
  await quickClose()
  check('ⓐ 공백 = AND(needle guide → guide 파일만)', and.length >= 1 && and[0].rel === 'docs/guide/l593-needle-guide.md' && !and.some((r) => r.rel === 'src/deep/a/b/l593-needle.md'), { and: and.slice(0, 5) })
  const pathQ = await quick('main/index')
  await quickClose()
  check('ⓐ / 경로 질의(main/index → main/index.ts 맨 위)', pathQ[0]?.rel === 'main/index.ts', { pathQ: pathQ.slice(0, 5) })
  const nameFirst = await quick('l593alpha')
  await quickClose()
  const nameIdx = nameFirst.findIndex((r) => r.rel === 'zeta/l593alpha.ts')
  const pathIdx = nameFirst.findIndex((r) => r.rel === 'l593alpha/zeta.ts')
  check('ⓐ 파일명 일치 > 경로만 일치', nameIdx !== -1 && pathIdx !== -1 && nameIdx < pathIdx, { nameFirst: nameFirst.slice(0, 5) })
  const contig = await quick('l593abc')
  await quickClose()
  const cIdx = contig.findIndex((r) => r.rel === 'src/l593abc-x.ts')
  const sIdx = contig.findIndex((r) => r.rel === 'src/l593a-b-c.ts')
  check('ⓐ 연속 일치 > 흩어진 일치', cIdx !== -1 && (sIdx === -1 || cIdx < sIdx), { contig: contig.slice(0, 5) })
  check('ⓐ 맞은 글자 강조(mark)', (nameFirst[0]?.marks ?? []).join('').toLowerCase().includes('l593alpha'), { marks: nameFirst[0]?.marks })
  // ⓒ 한글 NFC(한글/파일.md)·NFD(nfd/노트.md 디스크 NFD)
  const nfc = await quick('파일')
  await quickClose()
  const nfd = await quick('노트')
  await quickClose()
  check('ⓒ 한글 NFC·NFD 이름이 한글 질의로', nfc.some((r) => r.rel.normalize('NFC') === '한글/파일.md') && nfd.some((r) => r.rel.normalize('NFC') === 'nfd/노트.md'), { nfc: nfc.slice(0, 3), nfd: nfd.slice(0, 3) })
  // ⓓ 상한 50 넘으면 「더 있음」
  const many = await quick('l593-many')
  const more = await q(`document.querySelector('[data-quick-open-more]')?.textContent ?? null`)
  const total = await q(`Number(document.querySelector('[data-quick-open]')?.dataset.quickOpenTotal ?? 0)`)
  await quickClose()
  check('ⓓ 결과 50 상한·「더 있음」 안내(60개 중)', many.length === 50 && total === 60 && typeof more === 'string' && more.includes('더 있습니다'), { rows: many.length, total, more })
  // ⓔ 빈 입력 = 최근 연 파일부터(연 순서의 역)
  await quickOpenFile('main/index.ts', 'main/index')
  await quickOpenFile('src/l593abc-x.ts', 'l593abc')
  await quickOpenFile('README.md', 'readme')
  await showTerminal()
  const empty = await quick('')
  const heading = await q(`document.querySelector('[data-quick-open-heading="recent"]')?.textContent ?? null`)
  await quickClose()
  const recents = empty.filter((r) => r.group === 'recent').map((r) => r.rel)
  check('ⓔ 빈 입력 = 최근 연 파일(최근이 앞)·「최근 연 파일」 머리', JSON.stringify(recents.slice(0, 3)) === JSON.stringify(['README.md', 'src/l593abc-x.ts', 'main/index.ts']) && heading !== null, { recents, heading })
}

// E2ⓑ — 질의 표 q1~q12 (corral fd1664c4d 트리 레포 — L593_Q_REPO). 항목마다 실제 상위 5.
cases.e2q = async () => {
  const qRepo = process.env.L593_Q_REPO
  if (qRepo === undefined || !fs.existsSync(qRepo)) throw new Error('L593_Q_REPO 없음')
  const { paneId } = await repoPane(root, { repo: qRepo })
  paneIdCache = paneId
  await sleep(1500)
  await showTerminal()
  const table = [
    ['q1', 'explorer-fs', 'app/src/main/explorer-fs.ts', 3],
    ['q2', 'shared/keybindings', 'app/src/shared/keybindings.ts', 1],
    ['q3', 'main/index', 'app/src/main/index.ts', 3],
    ['q4', 'CommandPalette', 'app/src/renderer/src/components/CommandPalette.tsx', 1],
    ['q5', 'cmdpal', 'app/src/renderer/src/components/CommandPalette.tsx', 5],
    ['q6', 'AGENTS.md', 'AGENTS.md', 3],
    ['q7', 'file tabs', 'app/src/renderer/src/file-tabs.ts', 3],
    ['q8', 'uiprefs', 'app/src/main/ui-prefs.ts', 5],
    ['q9', 'Explorer.tsx', 'app/src/renderer/src/components/Explorer.tsx', 1],
    ['q10', 'electron-builder', 'app/electron-builder.yml', 3],
    ['q11', '00-project', 'specs/00-project.md', 2],
    ['q12', 'EXPLORER-FS', 'app/src/main/explorer-fs.ts', 3],
  ]
  const rows = []
  for (const [id, query, want, within] of table) {
    const got = await quick(query)
    await quickClose()
    const rank = got.findIndex((r) => r.rel === want) + 1
    rows.push({ id, query, want, within, rank, top5: got.slice(0, 5).map((r) => `${r.rel}${r.group === 'recent' ? ' (최근)' : ''}`) })
    check(`ⓑ ${id} ${query} → ${want} 상위 ${within}`, rank >= 1 && rank <= within, rows.at(-1))
  }
  current.table = rows
}

// E3 — ⓐ 고정 탭·이미 열린 탭·미리보기 → 고정 ⓑ 친 글자가 그 파일 모델에 + 편집기 없는 보기 포커스 ⓒ 기존 열기 경로(로그) ⓓ 지워진 파일 ⓔ F4 따라감·F3 수정 표시
cases.e3 = async () => {
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'bin', 'l593.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 3, 0]))
  write('src/l593-del.ts', 'export const del = 1\n')
  write('src/l593-ren.ts', 'export const ren = 1\n')
  await terminalPane()
  await sleep(1500)
  await exposeMonaco(root)
  await showTerminal()
  // ⓐ 고정 탭
  const logFrom = logRows().length
  await quickOpenFile('README.md', 'readme')
  const readme = await tab('README.md')
  const tags = [...new Set(logRows().slice(logFrom).map((r) => r.tag))]
  // ⓐ 미리보기 → 고정 · 이미 열린 탭 = 새 탭 없음
  await openPanel()
  await expand('src')
  await click(row('src/app.ts'))
  await until(async () => (await tab('src/app.ts'))?.preview === 'true', { label: '미리보기 탭' })
  const countBefore = (await fileTabs()).length
  await quickOpenFile('src/app.ts', 'src/app')
  const promoted = await tab('src/app.ts')
  await quickOpenFile('README.md', 'readme')
  const countAfter = (await fileTabs()).length
  check('ⓐ ⌘P Enter = 고정 탭', readme?.preview === 'false' && readme?.active === 'true', { readme })
  check('ⓐ 미리보기 탭 → ⌘P = 같은 탭이 고정으로 · 이미 열린 탭 = 새 탭 0', promoted?.preview === 'false' && countAfter === countBefore, { promoted, countBefore, countAfter })
  // ⓒ 여는 경로 = 기존 경로(main 로그 태그: 목록·탐색기 목록·file.read 만)
  // (G23 — 허용 목록을 모든 태그에 걸어 control.cmd·stream.* 같은 무관한 태그로 실패. 파일 계열 태그만 본다)
  const fileTags = tags.filter((t) => /^file\./.test(t ?? ''))
  check('ⓒ 여는 경로 로그 — 파일 계열 = file.list(_git)·file.read·file.changed 뿐 + explorer.list(부모 확인) — 새 읽기 IPC 없음', tags.includes('file.read') && tags.includes('explorer.list') && fileTags.every((t) => ['file.list', 'file.list_git', 'file.read', 'file.changed'].includes(t)), { tags, fileTags })
  // ⓑ 열고 곧바로 친 글자 → 그 파일 모델 · 편집기 없는 보기 포커스
  await showTerminal()
  await quickOpenFile('src/l593-ren.ts', 'l593-ren')
  await waitEditor('src/l593-ren.ts')
  await sleep(300)
  await type('Q593')
  const typed = await until(async () => String(await modelText('src/l593-ren.ts')).includes('Q593'), { timeoutMs: 3000, label: '모델 입력' }).then(() => true, () => false)
  await quickOpenFile('bin/l593.bin', 'l593.bin')
  const binFocus = await until(() => q(`document.activeElement?.matches('.file-group[data-file-view="bin/l593.bin"]') === true`), { timeoutMs: 4000, label: '보기 포커스' }).then(() => true, () => false)
  check('ⓑ 열고 곧바로 친 글자가 그 파일 모델에', typed, { model: await modelText('src/l593-ren.ts') })
  check('ⓑ 편집기 없는 보기(바이너리) = 그 보기 자리에 포커스', binFocus, { active: await activeInfo() })
  // ⓔ F3 수정 표시 · F4 이름 변경 따라감
  const dirty = await tab('src/l593-ren.ts')
  await quickOpenFile('src/l593-ren.ts', 'l593-ren')
  const dirtyAgain = { tab: await tab('src/l593-ren.ts'), model: await modelText('src/l593-ren.ts') }
  await stub(['save'])
  await openPanel()
  await expand('src')
  await focusRow('src/l593-ren.ts')
  await key('Return')
  await until(() => q(`document.activeElement?.matches('[data-explorer-input]') === true`), { label: '이름 바꾸기 입력' })
  await q(`(() => { const el = document.querySelector('[data-explorer-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'l593-renamed.ts'); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await key('Return')
  const followed = await until(async () => (await tab('src/l593-renamed.ts')) !== null && (await tab('src/l593-ren.ts')) === null, { timeoutMs: 6000, label: '탭 따라감' }).then(() => true, () => false)
  const afterRename = { tab: await tab('src/l593-renamed.ts'), model: await modelText('src/l593-renamed.ts') }
  check('ⓔ F3 수정 표시 유지(⌘P 로 다시 가도 수정·내용 그대로)', dirty?.dirty === 'true' && dirtyAgain.tab?.dirty === 'true' && String(dirtyAgain.model).includes('Q593'), { dirty, dirtyAgain })
  check('ⓔ F4 이름 변경 → 탭이 새 경로로·수정 내용 그대로', followed && afterRename.tab?.dirty === 'true' && String(afterRename.model).includes('Q593'), { followed, afterRename })
  // ⓓ 목록을 받은 뒤 지워진 파일
  await showTerminal()
  const delRows = await quick('l593-del')
  fs.rmSync(path.join(repo, 'src/l593-del.ts'))
  await sleep(300)
  if (delRows[0]?.rel === 'src/l593-del.ts') await key('Return')
  const closed = await until(async () => !(await qoOpen()), { timeoutMs: 3000, label: '닫힘' }).then(() => true, () => false)
  const notice = await until(() => q(`(() => { const n = document.querySelector('[data-file-view="src/l593-del.ts"] .file-view-notice')?.dataset.fileNotice ?? null; return n === null || n === 'loading' ? null : n })()`), { timeoutMs: 5000, label: '없음 안내' }).then((hit) => hit.value, () => null)
  const again = await quick('l593-del')
  await quickClose()
  check('ⓓ 지워진 파일 고름 = 기존 「없음」 안내·대화상자 정상 닫힘·다시 열면 목록에서 빠짐', delRows[0]?.rel === 'src/l593-del.ts' && closed && notice === 'not_found' && !again.some((r) => r.rel === 'src/l593-del.ts'), { delTop: delRows[0], closed, notice, again: again.slice(0, 3) })
}

// E4 — R4 해석 오라클 대조(끔·켬) · ⓒ dotfile · ⓓ 토글 키보드·기억 범위 · ⓔ fixture 종류
/** 독립 오라클(01-criteria 「해석 기록」) — ls-files -co(켬이면 무시 포함) 가운데 디스크에서 파일로 열 수 있는 것. 지워졌으나 추적 중인 것·.git/·node_modules/ 는 뺀다. */
function oracle(includeIgnored) {
  const z = (args) => execFileSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
  const deleted = new Set(z(['ls-files', '-z', '--deleted']))
  const base = z(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).filter((rel) => !deleted.has(rel))
  const ignored = includeIgnored ? z(['ls-files', '-z', '--others', '--ignored', '--exclude-standard']).filter((rel) => !rel.startsWith('.git/') && !/(^|\/)node_modules\//.test(rel)) : []
  const openable = (rel) => {
    try {
      const st = fs.lstatSync(path.join(repo, rel))
      if (st.isFile()) return true
      if (!st.isSymbolicLink()) return false
      try { return !fs.statSync(path.join(repo, rel)).isDirectory() } catch { return true }
    } catch { return false }
  }
  return new Set([...base, ...ignored].filter(openable).map((rel) => rel.normalize('NFC')))
}
cases.e4 = async () => {
  // fixture 종류 더하기 — skip-worktree(디스크에 있음·없음) · gitlink · 추적 폴더 링크(fixture link-dir) · 밖 링크(파일·폴더) · 중첩 .gitignore·! 부정·info/exclude·강제 추적(fixture)
  write('l593-skip-present.ts', 'export const s = 1\n')
  write('l593-skip-gone.ts', 'export const g = 1\n')
  git('add', 'l593-skip-present.ts', 'l593-skip-gone.ts')
  git('update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},l593-gitlink`)
  commit('e4 kinds')
  git('update-index', '--skip-worktree', 'l593-skip-present.ts', 'l593-skip-gone.ts')
  fs.rmSync(path.join(repo, 'l593-skip-gone.ts'))
  write('src/l593-deleted-tracked.ts')
  git('add', 'src/l593-deleted-tracked.ts')
  commit('deleted tracked')
  fs.rmSync(path.join(repo, 'src/l593-deleted-tracked.ts'))
  await terminalPane()
  await sleep(1500)
  await showTerminal()
  const real = fs.realpathSync(repo)
  const viaIpc = async (includeIgnored) => {
    const r = await q(`window.corral.fileList({ root: ${JSON.stringify(real)}, includeIgnored: ${includeIgnored}, requestId: 'e4-' + Date.now() }).then((r) => r.ok ? { ok: true, paths: r.paths, truncated: r.truncated } : r)`)
    return r.ok ? new Set(r.paths.split('\0').filter(Boolean).map((rel) => rel.normalize('NFC'))) : r
  }
  const compare = (name, got, want) => {
    const missing = [...want].filter((x) => !got.has(x)).sort()
    const extra = [...got].filter((x) => !want.has(x)).sort()
    current.metrics = { ...(current.metrics ?? {}), [name]: { got: [...got].sort(), want: [...want].sort(), missing, extra } }
    return { missing, extra, size: got.size }
  }
  const offGot = await viaIpc(false)
  const offCmp = compare('off', offGot, oracle(false))
  check('ⓐ 끔 = 독립 오라클(집합 같음)', offCmp.missing.length === 0 && offCmp.extra.length === 0, offCmp)
  const onGot = await viaIpc(true)
  const onCmp = compare('on', onGot, oracle(true))
  check('ⓑ 켬 = 독립 오라클(.git·node_modules 뺌)', onCmp.missing.length === 0 && onCmp.extra.length === 0 && ![...onGot].some((x) => x.startsWith('.git/') || x.includes('node_modules/')), onCmp)
  // ⓔ 종류별 기대(해석 기록) — 있음/없음
  const kinds = {
    tracked: offGot.has('src/app.ts'), untracked: offGot.has('src/untracked-new.ts'), ignoredOff: !offGot.has('debug.log'), ignoredOn: onGot.has('debug.log'),
    nestedIgnore: !offGot.has('src/sub/local-only.txt') && onGot.has('src/sub/local-only.txt'), negation: offGot.has('keep.log'), infoExclude: !offGot.has('excluded-by-info.txt') && onGot.has('excluded-by-info.txt'),
    forcedTracked: offGot.has('forced-ignored.txt'), space: offGot.has('with space/file name.md'), korean: offGot.has('한글/파일.md'), nfd: offGot.has('nfd/노트.md'),
    fileLink: offGot.has('link-file'), trackedDirLinkOut: !offGot.has('link-dir'), outsideFileLink: onGot.has('link-outside-file') || offGot.has('link-outside-file'), outsideDirLinkNotFollowed: ![...onGot].some((x) => x.startsWith('link-outside-dir/')),
    gitlinkOut: !offGot.has('l593-gitlink'), skipPresentIn: offGot.has('l593-skip-present.ts'), skipGoneOut: !offGot.has('l593-skip-gone.ts'), deletedTrackedOut: !offGot.has('src/l593-deleted-tracked.ts'), nodeModulesOut: ![...onGot].some((x) => x.includes('node_modules/')),
  }
  check('ⓔ fixture 종류 전부(추적·untracked·무시·중첩·!·info/exclude·강제 추적·공백·한글 NFC/NFD·링크 파일/폴더/밖·gitlink·skip-worktree 둘·지워진 추적)', Object.values(kinds).every(Boolean), kinds)
  // 화면 대조 — 빈 질의 대화상자 총 개수 = IPC 목록 수
  await pressQuick()
  await until(async () => (await qoState()) === 'ready', { label: '⌘P 준비' })
  await type('l593-skip')
  const skipRows = await stableRows('skip 행')
  await quickClose()
  check('ⓐ 화면 — skip-worktree 디스크에 있음은 ⌘P 에 보이고 없음은 안 보임', skipRows.some((r) => r.rel === 'l593-skip-present.ts') && !skipRows.some((r) => r.rel === 'l593-skip-gone.ts'), { skipRows })
  // ⓒ dotfile — 탐색기 dotfile 끔이어도 ⌘P 에 든다
  await openPanel()
  const dotBefore = await hasRow('.github')
  if (dotBefore) {
    await clickUntil('[data-explorer-view-menu]')
    await clickUntil('[data-menu-action="toggle-dotfiles"]')
    await until(async () => !(await hasRow('.github')), { label: 'dotfile 숨김' })
  }
  const dotRows = await quick('ci.yml')
  await quickClose()
  const gi = await quick('.gitignore')
  await quickClose()
  check('ⓒ 탐색기 dotfile 숨김이어도 ⌘P 에 .github/…·.gitignore', !(await hasRow('.github')) && dotRows.some((r) => r.rel === '.github/workflows/ci.yml') && gi.some((r) => r.rel === '.gitignore'), { dotBefore, dotRows: dotRows.slice(0, 3), gi: gi.slice(0, 3) })
  // ⓓ 토글 — Tab 으로 닿고 Space 로 켬, 다시 Tab 으로 입력. 기억 = 앱 실행 동안(다시 열어도 켬, 재시작하면 끔)
  await showTerminal()
  await pressQuick()
  await until(async () => (await qoState()) === 'ready', { label: '⌘P 준비' })
  await key('Tab')
  const onToggle = (await activeInfo()).toggle
  await key('Space')
  await until(() => q(`document.querySelector('[data-quick-open-ignored]')?.dataset.quickOpenIgnored === 'on'`), { timeoutMs: 3000, label: '토글 켬' })
  await key('Tab')
  const backToInput = (await activeInfo()).quickInput
  await type('debug.log')
  const ignoredRows = await stableRows('무시 파일 행')
  await quickClose()
  await pressQuick()
  await sleep(400)
  const keptOn = await q(`document.querySelector('[data-quick-open-ignored]')?.dataset.quickOpenIgnored ?? null`)
  await quickClose()
  check('ⓓ 토글 키보드(Tab → Space → Tab)·켜면 무시 파일 보임·다시 열어도 켬', onToggle && backToInput && ignoredRows.some((r) => r.rel === 'debug.log') && keptOn === 'on', { onToggle, backToInput, ignoredRows: ignoredRows.slice(0, 3), keptOn })
  await restartApp()
  await terminalPane()
  await sleep(1000)
  await pressQuick()
  await sleep(400)
  const afterRestart = await q(`document.querySelector('[data-quick-open-ignored]')?.dataset.quickOpenIgnored ?? null`)
  await quickClose()
  check('ⓓ 기억 범위 = 앱 실행 동안(재시작하면 끔 — Q3)', afterRestart === 'off', { afterRestart })
}

// E5 — ⓐ 여는 경로마다 기록 · ⓑ 묶음·정렬 · ⓒ worktree 별·상한 50 · ⓓ 영속은 e5r
cases.e5 = async () => {
  write('docs/l593-links.md', '# links\n\n[앱으로](../src/app.ts)\n')
  write('src/l593-filter-hit.ts')
  for (let i = 0; i < 55; i += 1) write(`cap/l593-cap-${String(i).padStart(2, '0')}.ts`)
  await terminalPane()
  await sleep(1500)
  await exposeMonaco(root)
  await showTerminal()
  const wait = () => sleep(1200)
  // 탐색기 클릭
  await openPanel()
  await expand('docs')
  await click(row('README.md'))
  await until(async () => (await tab('README.md')) !== null, { label: '탐색기 클릭 탭' })
  await wait()
  const viaExplorer = recentOf()?.[0]
  // ⌘P
  await quickOpenFile('src/deep/a/b/l593-target.ts', 'l593 target')
  await wait()
  const viaQuick = recentOf()?.[0]
  // 편집기 링크(Markdown 미리보기 링크)
  await click(row('docs/l593-links.md'))
  await until(async () => (await tab('docs/l593-links.md')) !== null, { label: '링크 문서 탭' })
  // (G25 — 단추를 탭이 뜬 직후 한 번만 찾아 아직 그려지기 전이라 못 찾았다. 제품 표지 `data-markdown-toggle` 이 뜰 때까지 누른다)
  const modeButton = await until(async () => (await click('[data-file-view="docs/l593-links.md"] [data-markdown-toggle="preview"]')).ok === true, { timeoutMs: 8000, label: '미리보기 단추' }).then(() => true, () => false)
  await until(() => q(`!!document.querySelector('[data-markdown-preview="docs/l593-links.md"] [data-md-href]')`), { timeoutMs: 8000, label: '미리보기 링크' }).catch(() => null)
  const linkClicked = await until(async () => (await click('[data-file-view="docs/l593-links.md"] [data-md-href]')).ok === true, { timeoutMs: 6000, label: '링크' }).then(() => true, () => false)
  await until(async () => (await tab('src/app.ts'))?.active === 'true', { timeoutMs: 5000, label: '링크로 연 탭' }).catch(() => null)
  await wait()
  const viaLink = recentOf()?.[0]
  // 이름 필터 행
  await focusRow('README.md')
  await key('F', ['meta', 'alt'])
  await until(() => q(`document.activeElement?.matches('[data-explorer-filter-input]') === true`), { label: '필터 입력칸' })
  await type('l593-filter-hit')
  await until(() => hasRow('src/l593-filter-hit.ts'), { timeoutMs: 8000, label: '필터 행' })
  await click(row('src/l593-filter-hit.ts'))
  await until(async () => (await tab('src/l593-filter-hit.ts')) !== null, { label: '필터 행 탭' })
  await wait()
  const viaFilter = recentOf()?.[0]
  await clickUntil('[data-explorer-filter-close]')
  check('ⓐ 탐색기 클릭·⌘P·편집기 링크·이름 필터 행 — 각각 기록 맨 앞', viaExplorer === 'README.md' && viaQuick === 'src/deep/a/b/l593-target.ts' && viaLink === 'src/app.ts' && viaFilter === 'src/l593-filter-hit.ts', { viaExplorer, viaQuick, viaLink, viaFilter, modeButton, linkClicked })
  // ⓑ 질의가 맞는 최근 파일 = 「최근 연 파일」 묶음 먼저, 나머지 점수 순
  await showTerminal()
  const grouped = await quick('ts')
  await quickClose()
  const firstFile = grouped.findIndex((r) => r.group === 'file')
  const recentPart = grouped.slice(0, firstFile === -1 ? grouped.length : firstFile)
  check('ⓑ 질의 있음 — 맞는 최근 파일이 먼저(최근 순)·그 뒤 파일 묶음', recentPart.length >= 2 && recentPart.every((r) => r.group === 'recent') && grouped.slice(recentPart.length).every((r) => r.group === 'file') && recentPart[0].rel === 'src/l593-filter-hit.ts', { recentPart, next: grouped.slice(recentPart.length, recentPart.length + 3) })
  // ⓒ worktree 별 — 둘째 레포 기록은 따로
  const repo2 = path.join(root, 'repo2')
  fs.mkdirSync(repo2, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo2])
  fs.writeFileSync(path.join(repo2, 'l593-r2.ts'), 'r2\n')
  const other = await repoPane(root, { repo: repo2 })
  await sleep(1500)
  const card = (p) => `[data-worktree="${fs.realpathSync(p)}"]`
  await until(async () => {
    await click(card(repo2))
    await sleep(300)
    return q(`!!document.querySelector('${card(repo2)} [data-worktree-card-active="primary"]')`)
  }, { timeoutMs: 15_000, everyMs: 300, label: 'repo2 카드' })
  await sleep(1500)
  await quickOpenFile('l593-r2.ts', 'l593-r2')
  await wait()
  const r2 = recentOf(repo2)
  const r1 = recentOf()
  check('ⓒ worktree 마다 따로 기록', JSON.stringify(r2) === JSON.stringify(['l593-r2.ts']) && !r1.includes('l593-r2.ts'), { r1: r1.slice(0, 5), r2, other: other.repo })
  await until(async () => {
    await click(card(repo))
    await sleep(300)
    return q(`!!document.querySelector('${card(repo)} [data-worktree-card-active="primary"]')`)
  }, { timeoutMs: 15_000, everyMs: 300, label: 'repo 카드' })
  await sleep(1500)
  // ⓒ 상한 50 — 55 개를 ⌘P 로 연다
  for (let i = 0; i < 55; i += 1) {
    const rel = `cap/l593-cap-${String(i).padStart(2, '0')}.ts`
    await quickOpenFile(rel, `l593-cap-${String(i).padStart(2, '0')}`)
  }
  await wait()
  const capped = recentOf()
  check('ⓒ 상한 50 — 오래된 것부터 버림(맨 앞 = 마지막 연 파일)', capped.length === 50 && capped[0] === 'cap/l593-cap-54.ts' && capped[49] === 'cap/l593-cap-05.ts', { length: capped.length, first: capped[0], last: capped.at(-1) })
}

// E5 — ⓐ 복원 탭(재시작·worktree 전환) 미기록 · ⓓ 재시작 영속·지워진 파일·깨진 기록
cases.e5r = async () => {
  write('src/l593-r-a.ts')
  write('src/l593-r-b.ts')
  write('src/l593-r-t.ts')
  write('src/l593-r-gone.ts')
  await terminalPane()
  await sleep(1500)
  await exposeMonaco(root)
  await showTerminal()
  for (const rel of ['src/l593-r-gone.ts', 'src/l593-r-b.ts', 'src/l593-r-a.ts', 'src/l593-r-t.ts']) await quickOpenFile(rel, rel.split('/').pop().replace('.ts', ''))
  await sleep(1200)
  const order = recentOf()
  // 재시작 — 기록을 [a, b, gone] 로 바꿔 두고(활성 탭 t 는 맨 앞이 아니게), gone 은 디스크에서 지운다
  const seeded = ['src/l593-r-a.ts', 'src/l593-r-b.ts', 'src/l593-r-gone.ts']
  await restartApp(() => {
    const p = prefs()
    p.recentFiles = { ...(p.recentFiles ?? {}), [fs.realpathSync(repo)]: seeded }
    fs.writeFileSync(prefsFile(), JSON.stringify(p, null, 2))
    fs.rmSync(path.join(repo, 'src/l593-r-gone.ts'))
  })
  await terminalPane()
  const restoredActive = await until(async () => (await tab('src/l593-r-t.ts'))?.active === 'true', { timeoutMs: 20_000, label: '복원 활성 탭' }).then(() => true, () => false)
  await sleep(3000)
  const afterRestart = recentOf()
  check('ⓐ 재시작 복원 활성 탭은 기록 안 함', restoredActive && JSON.stringify(afterRestart) === JSON.stringify(seeded), { order, restoredActive, afterRestart })
  // ⓓ 재시작 영속 — 빈 ⌘P 가 같은 순서, 지워진 파일은 안 보임
  await showTerminal()
  const empty = await quick('')
  await quickClose()
  const recents = empty.filter((r) => r.group === 'recent').map((r) => r.rel)
  check('ⓓ 재시작 뒤 빈 ⌘P = 저장 순서 · 지워진 파일 안 보임', JSON.stringify(recents) === JSON.stringify(['src/l593-r-a.ts', 'src/l593-r-b.ts']), { recents })
  // ⓐ worktree 전환 복원 — 다른 레포로 갔다가 돌아오면 그 레포의 활성 파일 탭은 기록 안 함
  await clickUntil('[data-file-tab="src/l593-r-t.ts"]')
  await sleep(1200)
  const t1 = recentOf()
  // t 를 기록에서 뒤로 보내려고 b 를 연다 → [b, t, a, …], 활성 = b. 그 뒤 활성을 t 로 두고 떠났다가 돌아오는 대신, 활성 b 인 채 떠났다가 돌아와 b 가 맨 앞에 그대로인지(복원이 맨 앞을 바꾸지 않음)는 판별력이 없다.
  // 판별: 활성 = t, 기록 = [a, …](t 가 맨 앞이 아님) 상태를 만든 뒤 떠났다 돌아온다 — ⌘P 로 a 를 열고 탭 클릭으로 t 를 활성으로 하면 탭 전환이 t 를 기록하므로,
  // 대신 둘째 영역을 쓰지 않고 a 를 연 뒤 ui-prefs 를 직접 바꿀 수 없어(앱이 덮음) — 재시작으로 만든 상태(t 활성·기록 [a, b])를 쓴다: 위 재시작 직후 상태에서 전환한다.
  const repo2 = path.join(root, 'repo2')
  fs.mkdirSync(repo2, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo2])
  await repoPane(root, { repo: repo2 })
  await sleep(1000)
  await restartApp(() => {
    const p = prefs()
    p.recentFiles = { ...(p.recentFiles ?? {}), [fs.realpathSync(repo)]: seeded.slice(0, 2) }
    fs.writeFileSync(prefsFile(), JSON.stringify(p, null, 2))
  })
  const card = (p) => `[data-worktree="${fs.realpathSync(p)}"]`
  const activeCard = (p) => q(`!!document.querySelector('${card(p)} [data-worktree-card-active="primary"]')`)
  await until(async () => (await tab('src/l593-r-t.ts'))?.active === 'true', { timeoutMs: 20_000, label: '복원 활성 탭 2' }).catch(() => null)
  await sleep(1500)
  const beforeSwitch = recentOf()
  await until(async () => { await click(card(repo2)); await sleep(300); return activeCard(repo2) }, { timeoutMs: 15_000, everyMs: 300, label: 'repo2 카드' })
  await sleep(1500)
  await until(async () => { await click(card(repo)); await sleep(300); return activeCard(repo) }, { timeoutMs: 15_000, everyMs: 300, label: 'repo 카드' })
  const backActive = await until(async () => (await tab('src/l593-r-t.ts'))?.active === 'true', { timeoutMs: 8000, label: '돌아온 활성 탭' }).then(() => true, () => false)
  await sleep(2000)
  const afterSwitch = recentOf()
  const activeMain = await q(`[...document.querySelectorAll('.main-tab')].filter((e) => e.dataset.active === 'true' || e.classList.contains('is-active') || e.getAttribute('aria-selected') === 'true').map((e) => e.dataset.mainTab)`)
  // (G26 — 돌아온 뒤 활성 탭이 파일 탭이 아니었다: 590 기존 동작 B3「다른 worktree 에 갔다 오면 활성 = 터미널」. 되살아난 활성 파일 탭이 없으면 판별할 수 없다 → 한계 확인으로 적는다)
  if (!backActive) limit('ⓐ worktree 전환 복원 — 돌아온 활성 탭이 파일 탭이 아님(B3 기존 동작) → 판별 불가 · 기록 무변경', { activeMain, beforeSwitch, afterSwitch, unchanged: JSON.stringify(afterSwitch) === JSON.stringify(beforeSwitch) })
  else check('ⓐ worktree 전환으로 되살아난 활성 탭은 기록 안 함', JSON.stringify(afterSwitch) === JSON.stringify(beforeSwitch) && afterSwitch[0] !== 'src/l593-r-t.ts', { t1, beforeSwitch, backActive, afterSwitch, activeMain })
  // ⓓ 깨진 기록 — ui-prefs.json 을 깨뜨려도 앱이 뜨고 ⌘P 가 돈다
  await restartApp(() => fs.writeFileSync(prefsFile(), '{ "recentFiles": [broken'))
  await terminalPane()
  await sleep(1000)
  await showTerminal()
  const brokenRows = await quick('l593-r')
  await quickClose()
  check('ⓓ 깨진 ui-prefs — 앱이 뜨고 ⌘P 동작(기록 없음)', brokenRows.length > 0 && brokenRows.every((r) => r.group === 'file'), { brokenRows: brokenRows.slice(0, 3) })
}

// E6 — 이름 필터 ⓐ~ⓖ
cases.e6 = async () => {
  write('docs/l593-keep-open/inner.md')
  write('src/l593-storm/l593-storm-seed.ts')
  write('src/l593-move/l593-mv.ts')
  write('src/l593-target-dir/.keep', '')
  write('src/l593-del-me.ts')
  write('src/IMEFILE-한.ts')
  await terminalPane()
  await sleep(1500)
  await openPanel()
  // ⓐ 진입 — 툴바 단추 · 트리 포커스 ⌥⌘F
  await clickUntil('[data-explorer-filter-toggle]')
  const byButton = await until(() => q(`document.activeElement?.matches('[data-explorer-filter-input]') === true`), { timeoutMs: 3000, label: '단추 진입' }).then(() => true, () => false)
  await clickUntil('[data-explorer-filter-close]')
  await focusRow('README.md')
  await key('F', ['meta', 'alt'])
  const byKey = await until(() => q(`document.activeElement?.matches('[data-explorer-filter-input]') === true`), { timeoutMs: 3000, label: '⌥⌘F 진입' }).then(() => true, () => false)
  check('ⓐ 진입 — 툴바 「필터」 단추·트리 포커스 ⌥⌘F → 머리 입력칸 포커스', byButton && byKey, { byButton, byKey })
  await clickUntil('[data-explorer-filter-close]')
  // ⓔ 준비 — 필터 전 펼침 상태: docs 만 펼침
  await until(async () => {
    await click('[data-explorer-collapse-all]')
    await sleep(300)
    return (await expandedRows()).length === 0
  }, { timeoutMs: 6000, everyMs: 300, label: '모두 접기' })
  await expand('docs')
  const expandedBefore = await expandedRows()
  // ⓑⓒ 모양·매칭 — 대문자 질의(대소문자 무시)·공백 AND·접힌/안 읽은 폴더 안
  await focusRow('README.md')
  await key('F', ['meta', 'alt'])
  await until(() => q(`document.activeElement?.matches('[data-explorer-filter-input]') === true`), { label: '필터 입력칸' })
  await type('NEEDLE')
  const upper = await until(async () => { const r = await explorerRows(); return r.includes('src/deep/a/b/l593-needle.md') ? r : null }, { timeoutMs: 8000, label: '걸러진 트리' }).then((h) => h.value, () => null)
  const hits = await q(`[...document.querySelectorAll('.explorer-filter-hit')].map((m) => m.textContent)`)
  const exp = await expandedRows()
  check('ⓑ 맞은 항목 + 조상만·조상 펼침·접힌/안 읽은 폴더 안도 찾음·강조', JSON.stringify(upper) === JSON.stringify(['docs', 'docs/guide', 'docs/guide/l593-needle-guide.md', 'src', 'src/deep', 'src/deep/a', 'src/deep/a/b', 'src/deep/a/b/l593-needle.md']) && exp.includes('src/deep/a/b') && hits.length > 0 && hits.every((t) => t.toLowerCase() === 'needle'), { upper, hits, exp })
  await q(`(() => { const el = document.querySelector('[data-explorer-filter-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'needle guide'); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const andRows = await until(async () => { const r = await explorerRows(); return r.includes('docs/guide/l593-needle-guide.md') && !r.includes('src/deep/a/b/l593-needle.md') ? r : null }, { timeoutMs: 6000, label: 'AND' }).then((h) => h.value, () => null)
  check('ⓒ 대소문자 무시 부분 문자열·공백 = AND', upper !== null && andRows !== null, { andRows })
  // ⓒ dotfile 토글·Git 제외 토글 따름
  const setFilter = (v) => q(`(() => { const el = document.querySelector('[data-explorer-filter-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const viewToggle = async (action) => {
    await clickUntil('[data-explorer-view-menu]')
    await clickUntil(`[data-menu-action="${action}"]`)
    await sleep(600)
  }
  await setFilter('ci.yml')
  const dotShown = await until(() => hasRow('.github/workflows/ci.yml'), { timeoutMs: 6000, label: 'dot 보임' }).then(() => true, () => false)
  await viewToggle('toggle-dotfiles')
  const dotHidden = await until(async () => !(await hasRow('.github/workflows/ci.yml')), { timeoutMs: 6000, label: 'dot 숨김' }).then(() => true, () => false)
  await viewToggle('toggle-dotfiles')
  // (G27 — 「Git 제외 파일 보이기」 기본값을 끔으로 가정했다. 실제 기본 = 켬(useExplorer showIgnored: true). 처음 상태를 메뉴 표지로 읽고 켬 → 끔 → 켬 순서로 본다)
  await setFilter('debug.log')
  await clickUntil('[data-explorer-view-menu]')
  const ignoredInitial = await q(`document.querySelector('[data-menu-action="toggle-ignored"]')?.textContent ?? null`)
  await key('Escape')
  await sleep(300)
  const ignoredOn = await until(() => hasRow('debug.log'), { timeoutMs: 8000, label: 'git 제외 보임(처음 켬)' }).then(() => true, () => false)
  await viewToggle('toggle-ignored')
  const ignoredOff = await until(async () => !(await hasRow('debug.log')) && /일치 없음/.test(await q(`document.querySelector('[data-explorer-filter-status]')?.textContent ?? ''`)), { timeoutMs: 6000, label: 'git 제외 숨김' }).then(() => true, () => false)
  await viewToggle('toggle-ignored')
  const ignoredOnAgain = await until(() => hasRow('debug.log'), { timeoutMs: 8000, label: 'git 제외 다시 보임' }).then(() => true, () => false)
  check('ⓒ 탐색기 dotfile·Git 제외 토글을 따름', dotShown && dotHidden && ignoredOn && ignoredOff && ignoredOnAgain, { dotShown, dotHidden, ignoredInitial, ignoredOn, ignoredOff, ignoredOnAgain })
  // ⓖ 일치 0
  await setFilter('l593zzznomatch')
  const none = await until(() => q(`!!document.querySelector('[data-explorer-filter-empty]') && /일치 없음/.test(document.querySelector('[data-explorer-filter-status]')?.textContent ?? '')`), { timeoutMs: 5000, label: '일치 없음' }).then(() => true, () => false)
  check('ⓖ 일치 0 = 「일치 없음」 안내', none, null)
  // ⓓ 키 — Enter = 이름 바꾸기 아님(첫 일치 선택 + 트리) · ↓ = 트리 첫 일치 · Esc 두 번(지움 → 닫고 트리) · IME 조합 중 Enter 무시
  await setFilter('needle')
  await until(() => hasRow('src/deep/a/b/l593-needle.md'), { label: 'needle 행' })
  await q(`document.querySelector('[data-explorer-filter-input]').focus()`)
  await key('Return')
  await sleep(300)
  const afterEnter = { rename: await q(`!!document.querySelector('[data-explorer-input]')`), tree: await treeFocused(), selected: await selectedRow() }
  await q(`document.querySelector('[data-explorer-filter-input]').focus()`)
  await key('Down')
  await sleep(300)
  const afterDown = { tree: await treeFocused(), selected: await selectedRow() }
  await q(`document.querySelector('[data-explorer-filter-input]').focus()`)
  await imeKey('Enter', 'Enter')
  const midIme = { stillInput: (await activeInfo()).filterInput, rename: await q(`!!document.querySelector('[data-explorer-input]')`) }
  await imeCommit('하')
  await setFilter('needle')
  await sleep(300)
  await q(`document.querySelector('[data-explorer-filter-input]').focus()`)
  await key('Escape')
  await sleep(300)
  const esc1 = { open: await q(`!!document.querySelector('[data-explorer-filter-input]')`), value: await q(`document.querySelector('[data-explorer-filter-input]')?.value ?? null`) }
  // ⓔ 지우면(빈 입력) 필터 전 펼침 상태
  const expandedCleared = await expandedRows()
  await key('Escape')
  await sleep(300)
  const esc2 = { open: await q(`!!document.querySelector('[data-explorer-filter-input]')`), tree: await treeFocused() }
  const expandedAfterClose = await expandedRows()
  check('ⓓ 입력칸 Enter = 이름 바꾸기 없음·첫 일치 선택·트리 포커스', !afterEnter.rename && afterEnter.tree && afterEnter.selected === 'docs/guide/l593-needle-guide.md', afterEnter)
  check('ⓓ ↓ = 트리 첫 일치 행', afterDown.tree && afterDown.selected === 'docs/guide/l593-needle-guide.md', afterDown)
  check('ⓓ IME 조합 중 Enter 무시(입력칸 그대로·이름 바꾸기 없음)', midIme.stillInput && !midIme.rename, midIme)
  check('ⓓ Esc 1 = 지움(열림 유지) · Esc 2 = 닫고 트리 포커스', esc1.open && esc1.value === '' && !esc2.open && esc2.tree, { esc1, esc2 })
  check('ⓔ 필터를 지우면 필터 전 펼침 상태(docs 만)', JSON.stringify(expandedCleared) === JSON.stringify(expandedBefore) && JSON.stringify(expandedAfterClose) === JSON.stringify(expandedBefore), { expandedBefore, expandedCleared, expandedAfterClose })
  // ⓕ 필터 중 외부 변경 폭주 → 반영 (G27b — 질의가 폴더 이름에만 맞아 seed.ts 가 안 보였다: 맞은 폴더는 맞은 자손만 보임. 파일 이름에도 질의를 넣는다)
  await focusRow('README.md')
  await key('F', ['meta', 'alt'])
  await until(() => q(`document.activeElement?.matches('[data-explorer-filter-input]') === true`), { label: '필터 입력칸' })
  await type('l593-storm')
  const stormSeen = await until(() => hasRow('src/l593-storm/l593-storm-seed.ts'), { timeoutMs: 8000, label: 'storm 행' }).then(() => true, () => false)
  if (!stormSeen) {
    log('storm.diag', { value: await q(`document.querySelector('[data-explorer-filter-input]')?.value ?? null`), status: await q(`document.querySelector('[data-explorer-filter-status]')?.textContent ?? null`), rows: (await explorerRows()).slice(0, 20), active: await activeInfo() })
    throw new Error('storm 행 없음 — storm.diag')
  }
  const fileListBefore = logRows().filter((r) => r.tag === 'file.list').length
  const stormStart = Date.now()
  for (let i = 0; i < 40; i += 1) {
    const f = path.join(repo, `src/l593-storm/l593-storm-${i % 10}.ts`)
    if (fs.existsSync(f)) fs.rmSync(f)
    else fs.writeFileSync(f, String(i))
    await sleep(50)
  }
  // 끝 상태: 0~9 중 짝수 번 바뀐 것은 지워짐 — 40회 = 각 4회 → 모두 지워짐. 하나만 새로 남긴다.
  write('src/l593-storm/l593-storm-final.ts')
  const stormReflected = await until(async () => (await hasRow('src/l593-storm/l593-storm-final.ts')) && !(await hasRow('src/l593-storm/l593-storm-3.ts')), { timeoutMs: 10_000, label: '폭주 반영' }).then(() => Date.now() - stormStart, () => null)
  const stormReads = logRows().filter((r) => r.tag === 'file.list').length - fileListBefore
  check('ⓕ 필터 중 외부 변경 폭주(40회 2 s) → 끝 상태 반영·목록 다시 읽기는 몰아서', stormReflected !== null && stormReads >= 1 && stormReads <= 6, { stormReflected, stormReads })
  // ⓕ F4 — 필터 중 이름 바꾸기(Enter)·삭제(⌘⌫ 확인)·끌기(이동)
  await setFilter('l593-')
  await until(() => hasRow('src/l593-del-me.ts'), { timeoutMs: 8000, label: '조작 행' })
  await focusRow('src/l593-storm/l593-storm-seed.ts')
  await key('Return')
  const renameInput = await until(() => q(`document.activeElement?.matches('[data-explorer-input]') === true`), { timeoutMs: 3000, label: '이름 바꾸기 입력' }).then(() => true, () => false)
  if (renameInput) {
    await q(`(() => { const el = document.querySelector('[data-explorer-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'l593-seed2.ts'); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await key('Return')
  }
  const renamed = await until(() => Promise.resolve(fs.existsSync(path.join(repo, 'src/l593-storm/l593-seed2.ts')) && !fs.existsSync(path.join(repo, 'src/l593-storm/l593-storm-seed.ts'))), { timeoutMs: 5000, label: '디스크 이름' }).then(() => true, () => false)
  await stub(['trash'])
  await focusRow('src/l593-del-me.ts')
  await key('Backspace', ['meta'])
  const trashed = await until(() => Promise.resolve(!fs.existsSync(path.join(repo, 'src/l593-del-me.ts'))), { timeoutMs: 6000, label: '휴지통' }).then(() => true, () => false)
  if (trashed) result.trashed.push({ path: path.join(repo, 'src/l593-del-me.ts'), at: new Date().toISOString(), via: '필터 중 ⌘⌫', case: 'e6' })
  const from = await rect(row('src/l593-move/l593-mv.ts'))
  const to = await rect(row('src/l593-target-dir'))
  let moved = false
  if (from !== null && to !== null) {
    const a = { x: from.left + 40, y: from.top + from.height / 2 }
    const b = { x: to.left + 40, y: to.top + to.height / 2 }
    await mouse('mouseDown', a)
    for (let i = 1; i <= 8; i += 1) {
      await mouse('mouseMove', { x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 })
      await sleep(40)
    }
    await sleep(200)
    await mouse('mouseUp', b)
    moved = await until(() => Promise.resolve(fs.existsSync(path.join(repo, 'src/l593-target-dir/l593-mv.ts'))), { timeoutMs: 5000, label: '끌어 옮김' }).then(() => true, () => false)
  }
  await key('Z', ['meta'])
  const undone = await until(() => Promise.resolve(fs.existsSync(path.join(repo, 'src/l593-move/l593-mv.ts'))), { timeoutMs: 5000, label: '⌘Z' }).then(() => true, () => false)
  check('ⓕ 필터 중 F4 — 이름 바꾸기·삭제(휴지통)·끌어 옮기기·⌘Z 가 깨지지 않음', renameInput && renamed && trashed && moved && undone, { renameInput, renamed, trashed, moved, undone, filterStill: await q(`!!document.querySelector('[data-explorer-filter-input]')`) })
  await clickUntil('[data-explorer-filter-close]')
}

// E6ⓕ — 큰 무시 폴더 안내: 무시 파일 목록(--ignored)만 끝나지 않는 git shim(ISO_ENV L593_PATH=<shim>:… L593_SHIM_ONLY=--ignored L593_SHIM_PIDS=…)으로
//   「Git 제외 파일 보이기」 켬 상태의 필터가 시간 초과(10 s) → 무시 파일 없이 다시 읽고 안내하는지. shim 자식·손주가 끝났는지도 본다.
cases.e6big = async () => {
  const pidsFile = path.join(root, 'shim-pids.txt') // (G32 — process.env 로 읽어 비었다: 그 값은 앱에만 준다)
  await terminalPane()
  await sleep(1500)
  await openPanel()
  await clickUntil('[data-explorer-view-menu]')
  const ignoredLabel = await q(`document.querySelector('[data-menu-action="toggle-ignored"]')?.textContent ?? null`)
  await key('Escape')
  await focusRow('README.md')
  const t0 = Date.now()
  await key('F', ['meta', 'alt'])
  await until(() => q(`document.activeElement?.matches('[data-explorer-filter-input]') === true`), { label: '필터 입력칸' })
  await type('needle')
  const note = await until(async () => { const t = await q(`document.querySelector('[data-explorer-filter-status]')?.textContent ?? ''`); return /무시 파일이 너무 많아/.test(t) ? t : null }, { timeoutMs: 20_000, everyMs: 200, label: '안내' }).then((h) => h.value, () => null)
  const noteMs = note === null ? null : Date.now() - t0
  const rows = await explorerRows()
  await sleep(2000)
  const shim = fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean).map((l) => ({ pid: Number(l.split(' ')[0]), line: l.slice(0, 120) })) : []
  const alive = shim.filter((x) => { try { process.kill(x.pid, 0); return true } catch { return false } })
  for (const x of alive) { try { process.kill(x.pid, 'SIGKILL') } catch { /* 이미 끝남 */ } }
  check('ⓕ 큰 무시 폴더(무시 목록 시간 초과) — 무시 파일 없이 찾고 안내 · 결과는 그대로 보임 · 느린 git 자식·손주 0', note !== null && rows.includes('src/deep/a/b/l593-needle.md') && shim.length >= 2 && alive.length === 0, { ignoredLabel, note, noteMs, rows: rows.slice(0, 10), shim, alive })
}

// E8 — ⓐ 루트 양성 대조 · ⓑ -/--·NUL · ⓓ 밖 링크(폴더 미추적·파일 열기 거절) · ⓔ 최근 기록 상대·재가둠  (ⓒ 심은 git 은 e8git 사례)
cases.e8 = async () => {
  write('-l593-dash.ts')
  write('--l593-ddash.ts')
  await terminalPane()
  await sleep(1500)
  await showTerminal()
  const real = fs.realpathSync(repo)
  const call = (input) => q(`window.corral.fileList(${JSON.stringify(input)}).then((r) => r.ok ? { ok: true, count: r.count, paths: r.paths } : { ok: false, code: r.code })`)
  const notOpened = path.join(root, 'l593-not-opened')
  execFileSync('git', ['init', '-q', notOpened])
  fs.mkdirSync(path.join(repo, 'src/sub'), { recursive: true })
  const matrix = []
  for (const [label, input, want] of [
    ['정상(열린 worktree)', { root: real, includeIgnored: false, requestId: 'e8-ok' }, 'ok'],
    ['열리지 않은 실제 git 디렉터리', { root: notOpened, includeIgnored: false, requestId: 'e8-a' }, 'reject'],
    ['/', { root: '/', includeIgnored: false, requestId: 'e8-b' }, 'reject'],
    ['.. 섞인 경로', { root: `${real}/src/..`, includeIgnored: false, requestId: 'e8-c' }, 'reject'],
    ['.. 로 밖', { root: `${real}/../outside`, includeIgnored: false, requestId: 'e8-c2' }, 'reject'],
    ['worktree 하위 폴더', { root: `${real}/src`, includeIgnored: false, requestId: 'e8-d' }, 'reject'],
    ['형 위반(root 숫자)', { root: 42, includeIgnored: false, requestId: 'e8-e' }, 'reject'],
    ['includeIgnored 문자열', { root: real, includeIgnored: '--others', requestId: 'e8-f' }, 'reject'],
    ['NUL 섞인 루트', { root: `${real}\u0000x`, includeIgnored: false, requestId: 'e8-g' }, 'reject'],
    ['-- 로 시작하는 루트', { root: '--help', includeIgnored: false, requestId: 'e8-h' }, 'reject'],
    ['여분 키(args) 무시', { root: real, includeIgnored: false, requestId: 'e8-i', args: ['--exec=touch /tmp/l593g-pwn'] }, 'ok'],
  ]) {
    const r = await call(input)
    matrix.push({ label, want, result: r.ok ? { ok: true, count: r.count } : r, pass: want === 'ok' ? r.ok === true : r.ok === false })
  }
  current.matrix = matrix
  check('ⓐ 루트 = 열린 worktree 만(열리지 않은 git·/·..·하위 폴더·형 위반 거절, 정상 통과)', matrix.every((m) => m.pass), matrix)
  // ⓑ 응답 경로 — 루트 상대·.. 없음·절대 없음 · -/-- 로 시작하는 파일명이 그대로 나옴 · 질의 -/--
  const ok = await call({ root: real, includeIgnored: true, requestId: 'e8-paths' })
  const paths = ok.ok ? ok.paths.split('\0').filter(Boolean) : []
  const bad = paths.filter((p) => p.startsWith('/') || p.split('/').includes('..'))
  check('ⓑⓓ 응답 경로 = 루트 상대(.. 0·절대 0)·-/-- 파일명 그대로·밖 링크 폴더 안 0', ok.ok && bad.length === 0 && paths.includes('-l593-dash.ts') && paths.includes('--l593-ddash.ts') && !paths.some((p) => p.startsWith('link-outside-dir/')) && !fs.existsSync('/tmp/l593g-pwn'), { count: paths.length, bad, pwn: fs.existsSync('/tmp/l593g-pwn') })
  const dash = await quick('--l593')
  await quickClose()
  const dash1 = await quick('-l593-dash')
  await quickClose()
  check('ⓑ -/-- 로 시작하는 질의 = 그냥 글자(결과에 그 파일)', dash.some((r) => r.rel === '--l593-ddash.ts') && dash1.some((r) => r.rel === '-l593-dash.ts'), { dash: dash.slice(0, 3), dash1: dash1.slice(0, 3) })
  // ⓓ 밖 링크 파일 열기 = 가둠 거절(outside_root) · 최근 기록 무오염(양성 대조 — 정상 파일은 기록)
  await quickOpenFile('README.md', 'readme')
  const rows = await quick('link-outside-file')
  if (rows[0]?.rel === 'link-outside-file') await key('Return')
  else await quickClose()
  const notice = await until(() => q(`(() => { const n = document.querySelector('[data-file-view="link-outside-file"] .file-view-notice')?.dataset.fileNotice ?? null; return n === null || n === 'loading' ? null : n })()`), { timeoutMs: 5000, label: '밖 링크 안내' }).then((h) => h.value, () => null)
  await sleep(1500)
  const recent = recentOf()
  const readLog = logRows().filter((r) => r.tag === 'file.read').slice(-3)
  check('ⓓ 밖 링크 파일 열기 = 가둠 거절(outside_root)·최근 기록에 없음(README 는 있음)', notice === 'outside_root' && !recent.includes('link-outside-file') && recent.includes('README.md'), { top: rows[0], notice, recent, readLog })
  // ⓔ 최근 기록 — 상대 경로만 저장 · 기록에 밖/절대 경로를 심어도 열 때 다시 가둔다(보이지 않거나 열면 거절)
  const allRel = Object.values(prefs()?.recentFiles ?? {}).flat().every((p) => typeof p === 'string' && !p.startsWith('/') && !p.split('/').includes('..'))
  await restartApp(() => {
    const p = prefs()
    p.recentFiles = { ...(p.recentFiles ?? {}), [real]: ['../outside/l593-secret.txt', path.join(outside, 'l593-secret.txt'), 'README.md'] }
    fs.writeFileSync(prefsFile(), JSON.stringify(p, null, 2))
  })
  await terminalPane()
  await sleep(1000)
  await showTerminal()
  const empty = await quick('')
  await quickClose()
  const shown = empty.filter((r) => r.group === 'recent').map((r) => r.rel)
  check('ⓔ 기록은 상대 경로만 · 심은 밖/절대 경로는 목록에 없어 보이지 않음(README 는 보임)', allRel && !shown.some((p) => p.includes('outside') || p.startsWith('/')) && shown.includes('README.md'), { allRel, shown })
}

// E8ⓒ — worktree 안에 심은 git 이 실행되지 않는다(표지 0). 앱 PATH 맨 앞에 worktree 안 bin 을 둔다(ISO_ENV L593_PATH={ROOT}/repo/bin:…). core.fsmonitor 기록.
cases.e8git = async () => {
  // (G30 — 표지가 생겼지만 누가 불렀는지 몰랐다. 심은 실행 파일이 자기 인자·부모 명령을 표지에 덧붙이게 해 부른 쪽을 가른다)
  const marker = path.join(root, 'l593-planted-ran')
  const planted = `#!/bin/sh\necho "pid=$$ ppid=$PPID parent=$(ps -o command= -p $PPID | cut -c1-160) :: $*" >> '${marker}'\nexec /usr/bin/git "$@"\n`
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'bin', 'git'), planted, { mode: 0o755 })
  fs.writeFileSync(path.join(repo, 'git'), planted, { mode: 0o755 })
  const fsmMarker = path.join(root, 'l593-fsmonitor-ran')
  fs.writeFileSync(path.join(root, 'fsmonitor.sh'), `#!/bin/sh\necho "pid=$$ ppid=$PPID parent=$(ps -o command= -p $PPID | cut -c1-200) :: $*" >> '${fsmMarker}'\n`, { mode: 0o755 })
  git('config', 'core.fsmonitor', path.join(root, 'fsmonitor.sh'))
  const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [])
  // 양성 대조 — 심은 git 을 직접 부르면 표지가 생긴다 · fsmonitor 는 보통 git status 가 부른다
  execFileSync(path.join(repo, 'bin', 'git'), ['--version'])
  const control = lines(marker)
  fs.rmSync(marker, { force: true })
  execFileSync('/usr/bin/git', ['-C', repo, 'status', '--porcelain'])
  const fsmControl = lines(fsmMarker)
  fs.rmSync(fsmMarker, { force: true })
  const appPid = fs.readFileSync(path.join(root, 'app.pid'), 'utf8').trim()
  const appPath = (execFileSync('ps', ['eww', '-o', 'command=', '-p', appPid], { encoding: 'utf8' }).match(/(?:^| )PATH=([^ ]*)/) ?? [])[1] ?? null
  await terminalPane()
  await sleep(1500)
  await showTerminal()
  const rows = await quick('readme')
  await quickClose()
  await pressQuick()
  await key('Tab')
  await key('Space')
  await sleep(1500)
  await quickClose()
  await sleep(500)
  const picked = logRows().filter((r) => r.tag === 'file.list_git').map((r) => r.git)
  const all = lines(marker)
  const fsmAll = lines(fsmMarker)
  // 목록(ls-files)이 부른 것 = 인자에 ls-files 가 든 줄
  const byList = all.filter((l) => l.includes('ls-files'))
  const fsmByList = fsmAll.filter((l) => l.includes('ls-files'))
  // 탐색기를 열어 기존 git status(explorer-hub) 수준도 본다
  const mark2 = all.length
  const fsmMark2 = fsmAll.length
  await openPanel()
  await sleep(3000)
  const afterPanel = lines(marker).slice(mark2)
  const fsmAfterPanel = lines(fsmMarker).slice(fsmMark2)
  current.planted = { control, fsmControl, duringList: all, fsmDuringList: fsmAll, afterPanel, fsmAfterPanel, appPid, appPath }
  check('ⓒ 목록(ls-files)은 심은 git(worktree/bin·루트) 을 부르지 않음 — 표지 중 ls-files 0(양성 대조: 직접 부르면 표지)·고른 git 이 worktree 밖', control.length > 0 && byList.length === 0 && rows.length > 0 && picked.length > 0 && picked.every((g) => !g.startsWith(fs.realpathSync(repo)) && !g.startsWith(repo)), { control, byList, otherCallersDuringList: all.slice(0, 6), picked, appPath })
  limit('ⓒ core.fsmonitor·기존 git 호출 수준 기록(판정 아님)', { fsmControl: fsmControl.length, fsmonitorByList: fsmByList, fsmonitorDuringList: fsmAll.slice(0, 4), plantedAfterPanel: afterPanel.slice(0, 4), fsmonitorAfterPanel: fsmAfterPanel.slice(0, 4) })
}

// --- 실행 ----------------------------------------------------------------------------------------------
let exitCode = 1
try {
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  await giveBack()
  await ctl(root, { cmd: 'resize-window', width: 1400, height: 900 }).catch(() => null)
  for (const name of caseArg.split(',')) {
    if (cases[name] === undefined) throw new Error(`사례 없음 ${name}`)
    current = { name, steps: [], checks: [] }
    result.cases[name] = current
    try {
      await cases[name]()
      check('사례가 끝까지 돌았다', true)
    } catch (error) {
      check('사례가 끝까지 돌았다', false, { error: String(error?.stack ?? error).slice(0, 800) })
    }
  }
  exitCode = result.checks.every((c) => c.ok) ? 0 : 1
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.error(result.error)
} finally {
  cdpSocket?.close()
  result.giveBack = giveBackLog
  result.exitCode = exitCode
  result.summary = { pass: result.checks.filter((c) => c.ok).length, fail: result.checks.filter((c) => !c.ok).length, limits: result.limits.length }
  writeJson(path.resolve(out), result)
  console.log(`# summary ${JSON.stringify(result.summary)}`)
}
process.exit(exitCode)
