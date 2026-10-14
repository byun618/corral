// LIFE-592 최종 관문 — 격리 회차(01-criteria E1~E9·E10ⓑ). 격리 개발 Electron(iso.sh 가 /tmp/l592g-* 에 띄운 것)과 그 fixture 에서만.
// 사용(app/ 에서, iso.sh 안): node scripts/l592/final.mjs <ROOT> <OUT.json> <case>[,<case>...] <FAKE>   (FAKE = iso.sh 의 {FAKE} — 앱 재시작(E4ⓓ·E10ⓑ)에 쓴다)
//   사례: e1 e2 e3 e4 e5 e5b e6 e7 e8 e9 e10b · e5lim(한계 확인 — DONE 미완 10)
//   ISO_ENV='L577_ELECTRON_ARGS=--remote-debugging-port=0 CORRAL_TEST_OP_HOOK_FILE={ROOT}/op-hook.json' — CDP(합성 IME·합성 드롭)·⑩ 경쟁 주입 훅.
// 입력: 제어 소켓 sendInputEvent · CDP(Input.imeSetComposition·Input.dispatchDragEvent·Input.dispatchKeyEvent) · DOM 값 setter(입력칸에 NUL·긴 이름 넣기만).
//   OS 키 입력(CGEvent)·Finder 끌기·시스템 클립보드 쓰기 없음. 휴지통에는 이름에 l592 가 든 fixture 항목만 간다(결과 `trashed` 에 원래 경로·시각).
// 판정: 사례마다 check(이름, 참/거짓, 원자료). 하나라도 거짓이면 종료 코드 1. 결과 json 에 단계·관측값 전부.
/* global fetch, WebSocket */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ctl, evalJs, sleep, until, repoPane, writeJson, exposeMonaco, herdr, pct, startNoticeSampler, stopNoticeSampler } from './lib.mjs'

const [root, out, caseArg] = process.argv.slice(2)
if (!/^\/tmp\/l592g-[^/]+$/.test(root ?? '') || out === undefined || caseArg === undefined) throw new Error('사용: final.mjs /tmp/l592g-* OUT.json case[,case]')
const repo = path.join(root, 'repo')
const outside = path.join(root, 'outside')
const result = { at: new Date().toISOString(), root, method: 'sendInputEvent(control socket) · CDP — not CGEvent', cases: {}, trashed: [], checks: [] }
let current = null
const log = (name, data) => {
  const row = { name, at: new Date().toISOString(), ...data }
  current.steps.push(row)
  console.log(`# ${current.name}/${name} ${JSON.stringify(data).slice(0, 260)}`)
  return row
}
const check = (name, ok, data = null) => {
  const row = { case: current.name, name, ok: ok === true, data }
  result.checks.push(row)
  current.checks.push(row)
  console.log(`${ok === true ? 'PASS' : 'FAIL'} ${current.name}/${name}${ok === true ? '' : ` ${JSON.stringify(data).slice(0, 300)}`}`)
  return ok === true
}

// --- 디스크 ---------------------------------------------------------------------------------------------
const abs = (rel) => path.join(repo, rel)
const exists = (rel) => { try { fs.lstatSync(abs(rel)); return true } catch { return false } }
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
/** 디스크 대조 목록(이름·종류·inode·크기·sha256·mode) — `.git` 밑은 뺀다. */
function snap(base = repo) {
  const rows = {}
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (rel === '' && name === '.git') continue
      const p = path.join(dir, name)
      const r = rel === '' ? name : `${rel}/${name}`
      const st = fs.lstatSync(p)
      const mode = (st.mode & 0o7777).toString(8)
      if (st.isSymbolicLink()) rows[r] = { k: 'l', ino: st.ino, link: fs.readlinkSync(p) }
      else if (st.isDirectory()) {
        rows[r] = { k: 'd', ino: st.ino, mode }
        try { walk(p, r) } catch (error) { rows[`${r}/*`] = { k: 'unreadable', error: String(error.code) } }
      } else if (st.isFile()) {
        let digest = null
        try { digest = sha(p) } catch (error) { digest = `unreadable:${error.code}` }
        rows[r] = { k: 'f', ino: st.ino, size: st.size, sha: digest, mode, nlink: st.nlink }
      } else rows[r] = { k: 'o', ino: st.ino }
    }
  }
  walk(base, '')
  return rows
}
function diff(a, b) {
  const added = Object.keys(b).filter((k) => !(k in a))
  const removed = Object.keys(a).filter((k) => !(k in b))
  const changed = Object.keys(b).filter((k) => k in a && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
  return { added, removed, changed }
}
const same = (d) => d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0
const eqSet = (list, want) => JSON.stringify([...list].sort()) === JSON.stringify([...want].sort())
const trashListing = (prefix) => {
  try {
    return fs.readdirSync(path.join(os.homedir(), '.Trash')).filter((name) => name.startsWith(prefix))
  } catch (error) {
    return `~/.Trash 읽기 실패: ${error.code ?? error.message}`
  }
}
const noteTrash = (rel, via, at = new Date().toISOString()) => result.trashed.push({ path: abs(rel), at, via, case: current.name })

// --- 화면 ----------------------------------------------------------------------------------------------
const q = (js) => evalJs(root, js)
const key = (keyCode, modifiers = [], type) => ctl(root, { cmd: 'key', keyCode, modifiers, ...(type === undefined ? {} : { type }) })
/** 글자 입력 — main 이 막은 keyDown 뒤 char 가 버려지는 하네스 문제(residual.md 하네스 주의)를 피해 Shift keyDown 을 먼저. */
const type = async (text) => {
  await key('Shift')
  return ctl(root, { cmd: 'type', text })
}
const click = (selector) => ctl(root, { cmd: 'click', selector })
const clickUntil = (selector, label = selector) => until(async () => (await click(selector)).ok === true, { timeoutMs: 8000, label })
const rect = async (selector) => (await ctl(root, { cmd: 'rect', selector })).rect ?? null
const center = async (selector) => {
  const r = await rect(selector)
  if (r === null) throw new Error(`rect 없음 ${selector}`)
  return { x: Math.round(r.left + Math.min(r.width / 2, 80)), y: Math.round(r.top + r.height / 2) }
}
const mouse = (kind, at, button = 'left') => ctl(root, { cmd: 'raw-mouse', type: kind, x: Math.round(at.x), y: Math.round(at.y), button })
const row = (rel) => `[data-explorer-row="${rel}"]`
const hasRow = (rel) => q(`document.querySelector('${row(rel)}') !== null`)
const treeFocused = () => q(`document.activeElement === document.querySelector('[data-explorer-tree]')`)
const selectedRow = () => q(`document.querySelector('.explorer-row.is-selected')?.dataset.explorerRow ?? null`)
const expanded = (rel) => q(`document.querySelector('${row(rel)}')?.getAttribute('aria-expanded') ?? null`)
/** 행을 클릭해 트리 포커스·선택 — 폴더 행 클릭은 접고 펴기를 겸하므로 클릭 전 펼침 상태로 되돌린다. */
const focusRow = async (rel) => {
  const was = await q(`document.querySelector('${row(rel)}')?.getAttribute('aria-expanded') ?? null`)
  await until(async () => {
    await click(row(rel))
    await sleep(150)
    return (await treeFocused()) && (await selectedRow()) === rel
  }, { timeoutMs: 8000, label: `트리 포커스 ${rel}` })
  const now = await q(`document.querySelector('${row(rel)}')?.getAttribute('aria-expanded') ?? null`)
  if (was !== null && now !== was) {
    await key(was === 'true' ? 'Right' : 'Left')
    await until(async () => (await q(`document.querySelector('${row(rel)}')?.getAttribute('aria-expanded') ?? null`)) === was, { label: `펼침 복귀 ${rel}` })
  }
}
/** 폴더를 펼친다(트리 포커스 → 선택 → → 키). */
const expand = async (rel) => {
  if ((await expanded(rel)) === 'true') return
  await focusRow(rel)
  if ((await expanded(rel)) !== 'true') await key('Right')
  await until(async () => (await expanded(rel)) === 'true', { label: `펼침 ${rel}` })
}
const rowMenu = async (rel, action) => {
  const at = await center(row(rel))
  await mouse('mouseDown', at, 'right')
  await mouse('mouseUp', at, 'right')
  await until(() => q(`document.querySelector('[data-explorer-row-menu] [data-menu-action="${action}"]') !== null`), { label: `행 메뉴 ${action}` })
  await clickUntil(`[data-explorer-row-menu] [data-menu-action="${action}"]`)
}
const emptyMenu = async (action) => {
  const r = await rect('.explorer-scroll')
  const at = { x: r.left + 40, y: r.top + r.height - 12 }
  await mouse('mouseDown', at, 'right')
  await mouse('mouseUp', at, 'right')
  await until(() => q(`document.querySelector('[data-explorer-empty-menu] [data-menu-action="${action}"]') !== null`), { label: `빈 영역 메뉴 ${action}` })
  await clickUntil(`[data-explorer-empty-menu] [data-menu-action="${action}"]`)
}
const inputOpen = () => q(`document.querySelector('[data-explorer-input]') !== null`)
const inputValue = () => q(`document.querySelector('[data-explorer-input]')?.value ?? null`)
const inputMessage = () => q(`document.querySelector('[data-explorer-input-message]')?.textContent ?? null`)
const waitInput = () => until(() => q(`document.activeElement?.matches('[data-explorer-input]') === true`), { label: '입력 행 포커스' })
/** 입력칸 값을 DOM setter 로(합성 글자가 못 넣는 NUL·긴 이름). React 의 onChange 가 받는다. */
const setInput = (value) => q(`(() => { const el = document.querySelector('[data-explorer-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value })()`)
const tab = (rel) => q(`(() => { const t = document.querySelector('[data-file-tab="${rel}"]'); if (t === null) return null; return { dirty: t.dataset.fileDirty ?? null, preview: t.dataset.tabPreview ?? null, active: t.dataset.active ?? null, title: t.textContent.trim(), tooltip: t.getAttribute('title'), icon: t.querySelector('svg, img, [class*=icon]')?.getAttribute('class') ?? null, deleted: t.classList.contains('is-deleted'), group: [...document.querySelectorAll('[data-tab-group]')].findIndex((g) => g.contains(t)), order: [...t.parentElement.querySelectorAll('[data-file-tab]')].indexOf(t) } })()`)
const fileTabs = () => q(`[...document.querySelectorAll('[data-file-tab]')].map((t) => t.dataset.fileTab)`)
const toasts = () => q(`[...document.querySelectorAll('[data-sonner-toast]')].map((e) => e.textContent)`)
const stub = (answers) => ctl(root, { cmd: 'file-dialog-stub', answers })
const ipc = (input) => q(`window.corral.explorerOp(${JSON.stringify(input)})`)
/** 렌더러가 쓰는 루트(열린 worktree 로 등록된 경로) — fixture 경로 또는 그 realpath 중 main 이 not_worktree 로 거절하지 않는 쪽. */
let ipcRootCache = null
const ipcRoot = async () => {
  if (ipcRootCache !== null) return ipcRootCache
  for (const candidate of [repo, fs.realpathSync(repo)]) {
    const r = await ipc({ op: 'inspect', root: candidate, rel: 'l592-top.txt' })
    if (r.code !== 'not_worktree') return (ipcRootCache = candidate)
  }
  throw new Error('ipc 루트 없음')
}
const logRows = () => {
  try {
    return fs.readFileSync(path.join(root, 'ud/corral.ndjson'), 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return {} } })
  } catch { return [] }
}
const opLogs = () => logRows().filter((r) => r.tag === 'explorer.op')
const edOf = (rel, body) => q(`(() => { const host = document.querySelector('[data-file-view="${rel}"] [data-file-editor]'); const e = window.l592Monaco?.editor.getEditors().find((x) => host !== null && host.contains(x.getContainerDomNode())); if (e === undefined) return null; const m = e.getModel(); ${body} })()`)
const editorFocus = (rel) =>
  until(async () => {
    await click(`[data-file-view="${rel}"] [data-file-editor] .view-lines`)
    await sleep(150)
    return q(`document.activeElement?.closest('[data-file-view="${rel}"]') !== null`)
  }, { timeoutMs: 8000, label: `편집기 포커스 ${rel}` })
const openFixed = async (rel) => {
  await until(async () => (await ctl(root, { cmd: 'dblclick', selector: row(rel) })).ok === true, { label: `더블클릭 ${rel}` })
  await until(async () => (await tab(rel))?.preview === 'false', { label: `고정 탭 ${rel}` })
  await until(() => q(`document.querySelector('[data-file-view="${rel}"] .view-lines') !== null`), { timeoutMs: 15_000, label: `편집기 ${rel}` })
}
/** 트리 포커스를 행 하나로(⌘Z·⌘⇧Z 를 탐색기로). */
const treeOn = async (rel) => {
  if (await treeFocused()) return
  await focusRow(rel)
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
/** 합성 OS 드롭(Chromium 드래그 경로 — 파일 경로가 실린 DataTransfer). 실제 Finder 끌기가 아니다(E12 몫). */
async function cdpDrop(at, files) {
  const data = { items: [], files, dragOperationsMask: 1 }
  await cdp('Input.dispatchDragEvent', { type: 'dragEnter', x: at.x, y: at.y, data })
  await cdp('Input.dispatchDragEvent', { type: 'dragOver', x: at.x, y: at.y, data })
  await sleep(60)
  await cdp('Input.dispatchDragEvent', { type: 'drop', x: at.x, y: at.y, data })
}

// --- 사례 ----------------------------------------------------------------------------------------------
const cases = {}

/** 새 파일/폴더 하나를 입구로 열고 이름을 넣어 Enter. 확정 → 행 표시 ms(렌더러 시계 — Enter keydown 캡처 → 행 등장 MutationObserver). */
async function createVia(open, { name, expectRel }) {
  await open()
  await waitInput()
  const slot = await q(`(() => { const r = document.querySelector('[data-explorer-input-row]'); const rows = [...document.querySelectorAll('[data-explorer-row]')].map((e) => ({ rel: e.dataset.explorerRow, top: parseFloat(e.style.top), kind: e.getAttribute('aria-expanded') === null ? 'file' : 'dir' })); return { kind: r?.dataset.explorerInputRow ?? null, top: r === null ? null : parseFloat(r.style.top), icon: r?.querySelector('.explorer-file-icon, .explorer-twistie .is-placeholder')?.className ?? null, rows } })()`)
  await type(name)
  await q(`(() => { window.__l592enter = null; window.__l592shown = null; window.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target?.matches?.('[data-explorer-input]')) window.__l592enter = performance.now() }, { capture: true, once: true }); const mo = new MutationObserver(() => { if (window.__l592enter !== null && document.querySelector('${row(expectRel)}') !== null) { window.__l592shown = performance.now(); mo.disconnect() } }); mo.observe(document.body, { subtree: true, childList: true, attributes: true }); return true })()`)
  await key('Return')
  await until(() => hasRow(expectRel), { timeoutMs: 5000, label: `새 행 ${expectRel}` })
  await until(() => q(`window.__l592shown !== null`), { timeoutMs: 2000, label: '표시 시각' }).catch(() => null)
  const ms = await q(`window.__l592shown === null || window.__l592enter === null ? null : Math.round((window.__l592shown - window.__l592enter) * 10) / 10`)
  return { slot, ms }
}

cases.e1 = async () => {
  await expand('src')
  // ⓐ 입구 — 파일 행 우클릭(= 부모) · 폴더 행 우클릭(= 그 폴더) · 빈 영역 우클릭(= 루트) · 툴바 새 파일(선택 폴더 안) · 툴바 새 폴더(선택 파일의 부모)
  const entries = [
    { label: '행 메뉴 새 파일(파일 행 → 부모)', open: () => rowMenu('src/l592-a.ts', 'newFile'), name: 'l592-e1-row-file.ts', rel: 'src/l592-e1-row-file.ts', kind: 'f' },
    { label: '행 메뉴 새 폴더(폴더 행 → 그 폴더, 접혀 있으면 펼침)', open: () => rowMenu('docs', 'newFolder'), name: 'l592-e1-row-dir', rel: 'docs/l592-e1-row-dir', kind: 'd', collapsed: 'docs' },
    { label: '빈 영역 메뉴 새 파일(루트)', open: () => emptyMenu('newFile'), name: 'l592-e1-empty.txt', rel: 'l592-e1-empty.txt', kind: 'f' },
    { label: '툴바 새 파일(선택 = 폴더 src/sub → 그 안)', open: async () => { await focusRow('src/sub'); await clickUntil('[data-explorer-new-file]') }, name: 'l592-e1-tool.ts', rel: 'src/sub/l592-e1-tool.ts', kind: 'f' },
    { label: '툴바 새 폴더(선택 = 파일 l592-top.txt → 루트)', open: async () => { await focusRow('l592-top.txt'); await clickUntil('[data-explorer-new-folder]') }, name: 'l592-e1-tool-dir', rel: 'l592-e1-tool-dir', kind: 'd' },
  ]
  for (const entry of entries) {
    const before = snap()
    const collapsedBefore = entry.collapsed === undefined ? null : await expanded(entry.collapsed)
    const { slot, ms } = await createVia(entry.open, { name: entry.name, expectRel: entry.rel })
    const d = diff(before, snap())
    const st = fs.lstatSync(abs(entry.rel))
    const newTab = entry.kind === 'f' ? await until(() => tab(entry.rel), { timeoutMs: 3000, label: '새 탭' }).then((r) => r.value, () => null) : null
    const data = { entry: entry.label, slot, ms, diff: d, size: st.size, mode: (st.mode & 0o7777).toString(8), newTab, selected: await selectedRow(), collapsedBefore, expandedAfter: entry.collapsed === undefined ? null : await expanded(entry.collapsed) }
    log(`entry ${entry.rel}`, data)
    check(`ⓐ ${entry.label}`, eqSet(d.added, [entry.rel]) && d.removed.length === 0 && d.changed.length === 0 && (entry.kind === 'f' ? st.isFile() && st.size === 0 : st.isDirectory()), data)
    check(`ⓑ 입력 행 종류·자리 ${entry.rel}`, slot.kind === (entry.kind === 'f' ? 'file' : 'dir') && slot.top !== null && slot.icon !== null, slot)
    check(`ⓔ 만든 뒤 선택·탭 ${entry.rel}`, (await selectedRow()) === entry.rel && (entry.kind === 'd' || (newTab?.preview === 'false' && newTab?.active === 'true')), data)
    if (entry.collapsed !== undefined) check(`ⓑ 접힌 폴더 펼침 ${entry.collapsed}`, collapsedBefore === 'false' && data.expandedAfter === 'true', data)
    if (entry.kind === 'f') check(`ⓕ 0 B·mode ${entry.rel}`, st.size === 0, { size: st.size, mode: data.mode })
    else check(`ⓕ 폴더 mode ${entry.rel}`, typeof data.mode === 'string', { mode: data.mode })
  }
  // ⓑ 폴더 우선 자리 — src 안 새 파일 입력 행은 하위 폴더(sub) 뒤·파일 앞
  await focusRow('src')
  await clickUntil('[data-explorer-new-file]')
  await waitInput()
  const order = await q(`(() => { const r = document.querySelector('[data-explorer-input-row]'); const top = parseFloat(r.style.top); const rows = [...document.querySelectorAll('[data-explorer-row]')].map((e) => ({ rel: e.dataset.explorerRow, top: parseFloat(e.style.top) })); return { top, sub: rows.find((x) => x.rel === 'src/sub')?.top ?? null, firstFile: rows.filter((x) => x.rel.startsWith('src/') && !x.rel.slice(4).includes('/') && x.rel !== 'src/sub').map((x) => x.top).sort((a, b) => a - b)[0] ?? null } })()`)
  check('ⓑ 폴더 우선 정렬 자리(하위 폴더 뒤·파일 앞)', order.sub !== null && order.top > order.sub && (order.firstFile === null || order.top <= order.firstFile), order)
  // ⓑ Esc 취소 — 디스크 무변경
  let before = snap()
  await type('l592-esc.ts')
  await key('Escape')
  await until(async () => !(await inputOpen()), { label: 'Esc 닫힘' })
  check('ⓑ Esc 취소 = 디스크 무변경·트리 포커스', same(diff(before, snap())) && (await treeFocused()), { treeFocused: await treeFocused() })
  // ⓑ 입력 중 ⌘A·화살표·⌘Z 는 입력칸 몫(트리·앱이 가로채지 않음) — 직전 조작(만들기)의 탐색기 기록이 남아 있는데 ⌘Z 가 그것을 되돌리지 않는다
  await focusRow('src')
  await clickUntil('[data-explorer-new-file]')
  await waitInput()
  before = snap()
  await type('abc')
  // ⌘A — macOS 에선 메뉴(Edit ▸ Select All)·키 바인딩이 selectAll 편집 명령을 만든다. sendInputEvent 는 그 경로를 안 거치므로
  //   ① sendInputEvent ⌘A 의 keydown 이 페이지에서 막히는지(defaultPrevented) ② CDP dispatchKeyEvent(commands: selectAll — 네이티브 키 바인딩 경로 흉내)의 결과를 함께 기록한다.
  await q(`(() => { window.__l592keys = []; window.addEventListener('keydown', (e) => { if (e.metaKey) setTimeout(() => window.__l592keys.push({ key: e.key, prevented: e.defaultPrevented, target: e.target?.matches?.('[data-explorer-input]') === true }), 0) }, { capture: true }); return true })()`)
  await key('A', ['meta'])
  await sleep(100)
  const viaSend = await q(`(() => { const el = document.querySelector('[data-explorer-input]'); return { start: el.selectionStart, end: el.selectionEnd, keys: window.__l592keys.slice() } })()`)
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
  await sleep(100)
  const selAll = await q(`(() => { const el = document.querySelector('[data-explorer-input]'); return { start: el.selectionStart, end: el.selectionEnd, len: el.value.length, keys: window.__l592keys.slice() } })()`)
  selAll.viaSendInputEvent = viaSend
  await key('Right')
  await key('Left')
  const caret = await q(`(() => { const el = document.querySelector('[data-explorer-input]'); return { start: el.selectionStart, value: el.value, selected: document.querySelector('.explorer-row.is-selected')?.dataset.explorerRow ?? null } })()`)
  await key('Z', ['meta'])
  await sleep(300)
  const afterUndo = { value: await inputValue(), open: await inputOpen(), diff: diff(before, snap()) }
  check('ⓑ 입력 중 ⌘A = 가로채지 않음(keydown 미차단) · 입력칸 전체 선택(CDP selectAll 명령)', selAll.keys.every((k) => k.target && !k.prevented) && selAll.keys.length >= 1 && selAll.start === 0 && selAll.end === selAll.len && selAll.len === 3, selAll)
  check('ⓑ 입력 중 화살표 = 커서만(트리 선택 무변화)', caret.start === 2 && caret.value === 'abc' && caret.selected === 'src', caret)
  check('ⓑ 입력 중 ⌘Z = 입력칸 몫(탐색기 기록·디스크 무변화)', afterUndo.open === true && same(afterUndo.diff), afterUndo)
  await key('Escape')
  // ⓑ 바깥 클릭(blur) — 유효하면 확정(VS Code), 무효면 취소
  await focusRow('src')
  await clickUntil('[data-explorer-new-file]')
  await waitInput()
  before = snap()
  await type('l592-blur.ts')
  await click(row('docs'))
  await until(() => Promise.resolve(exists('src/l592-blur.ts')), { timeoutMs: 3000, label: 'blur 확정' }).catch(() => null)
  check('ⓑ 바깥 클릭 = 유효하면 확정', eqSet(diff(before, snap()).added, ['src/l592-blur.ts']), diff(before, snap()))
  await focusRow('src')
  await clickUntil('[data-explorer-new-file]')
  await waitInput()
  before = snap()
  await type('l592-a.ts')
  await click(row('docs'))
  await sleep(500)
  check('ⓑ 바깥 클릭 = 무효(이미 있음)면 닫고 디스크 무변경', !(await inputOpen()) && same(diff(before, snap())), { open: await inputOpen(), diff: diff(before, snap()) })
  // ⓑ 합성 한글 조합(CDP) — 조합 중 Enter(keyCode 229)는 확정하지 않는다, 조합 확정 뒤 Enter 가 만든다
  await focusRow('src')
  await clickUntil('[data-explorer-new-file]')
  await waitInput()
  before = snap()
  await type('l592-')
  await cdp('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 })
  await cdp('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 })
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'Enter', windowsVirtualKeyCode: 229 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229 })
  await sleep(300)
  const midIme = { open: await inputOpen(), value: await inputValue(), diff: diff(before, snap()) }
  await cdp('Input.insertText', { text: '한' })
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until(() => Promise.resolve(exists('src/l592-한')), { timeoutMs: 3000, label: '조합 확정 뒤 만들기' }).catch(() => null)
  const imeDone = { added: diff(before, snap()).added }
  check('ⓑ 조합 중 Enter(229) = 확정 안 함(입력 행 유지·디스크 무변경)', midIme.open === true && same(midIme.diff), midIme)
  check('ⓑ 조합 확정 뒤 Enter = 만듦(이름 정확)', eqSet(imeDone.added, ['src/l592-한']), imeDone)
  // ⓒ 이름 검증 — 입력 행 안내 + Enter 해도 디스크 무변경
  const bad = [
    { label: '.', value: '.' },
    { label: '..', value: '..' },
    { label: 'NUL', value: 'l592\u0000x' },
    { label: '255 바이트 초과', value: `l592-${'가'.repeat(90)}` },
    { label: '이미 있는 이름', value: 'l592-a.ts' },
    { label: '대소문자만 다른 이미 있는 이름', value: 'L592-A.TS' },
    { label: '앞 공백', value: ' l592-sp.ts' },
    { label: '뒤 공백', value: 'l592-sp.ts ' },
    { label: '빈 성분(a//b)', value: 'l592-x//y.ts' },
    { label: '앞 /', value: '/l592-abs.ts' },
    { label: '.. 성분', value: 'l592-x/../y.ts' },
  ]
  for (const item of bad) {
    await focusRow('src')
    await clickUntil('[data-explorer-new-file]')
    await waitInput()
    before = snap()
    await setInput(item.value)
    await sleep(120)
    const shown = await inputMessage()
    await key('Return')
    await sleep(400)
    const after = { message: shown, afterEnter: await inputMessage(), open: await inputOpen(), diff: diff(before, snap()) }
    check(`ⓒ ${item.label} — 안내·디스크 무변경`, (shown !== null || after.afterEnter !== null) && same(after.diff), after)
    if (await inputOpen()) await key('Escape')
  }
  // 빈 이름 Enter = 닫기만
  await focusRow('src')
  await clickUntil('[data-explorer-new-file]')
  await waitInput()
  before = snap()
  await key('Return')
  await sleep(300)
  check('ⓒ 빈 이름 Enter = 닫음·디스크 무변경', !(await inputOpen()) && same(diff(before, snap())), null)
  // ⓓ a/b/c.ts — 중간 폴더까지
  before = snap()
  const nested = await createVia(async () => { await focusRow('l592-top.txt'); await clickUntil('[data-explorer-new-file]') }, { name: 'l592-n1/l592-n2/c.ts', expectRel: 'l592-n1/l592-n2/c.ts' })
  const nd = diff(before, snap())
  check('ⓓ a/b/c.ts = 중간 폴더까지 만들고 c.ts 고정 탭', eqSet(nd.added, ['l592-n1', 'l592-n1/l592-n2', 'l592-n1/l592-n2/c.ts']) && (await tab('l592-n1/l592-n2/c.ts'))?.preview === 'false', { nd, ms: nested.ms })
  // ⓔ 확정 → 행 표시 ≤ 500 ms, 10회 p95
  const lat = []
  for (let i = 0; i < 10; i += 1) {
    const r = await createVia(async () => { await focusRow('docs'); await clickUntil('[data-explorer-new-file]') }, { name: `l592-lat-${i}.txt`, expectRel: `docs/l592-lat-${i}.txt` })
    lat.push(r.ms)
  }
  const p95 = pct(lat.filter(Number.isFinite), 95)
  current.metrics = { createToRowMs: lat, p95, max: Math.max(...lat.filter(Number.isFinite)) }
  check('ⓔ 확정 → 행 표시 10회 p95 ≤ 500 ms', lat.every(Number.isFinite) && p95 <= 500, current.metrics)
}

cases.e2 = async () => {
  await expand('src')
  // ⓐ 입구 — 트리 Enter · 행 우클릭 「이름 바꾸기」 · F2(넣지 않음 — 기록)
  await focusRow('src/l592-a.ts')
  await key('Return')
  await waitInput()
  const sel = await q(`(() => { const el = document.querySelector('[data-explorer-input]'); return { value: el.value, start: el.selectionStart, end: el.selectionEnd } })()`)
  check('ⓐ Enter = 이름 바꾸기 입력 행 · ⓑ 지금 이름·확장자 앞까지 선택', sel.value === 'l592-a.ts' && sel.start === 0 && sel.end === 'l592-a'.length, sel)
  let before = snap()
  await key('Escape')
  await sleep(200)
  check('ⓑ Esc 취소 = 디스크 무변경', !(await inputOpen()) && same(diff(before, snap())), null)
  await rowMenu('src/l592-b.ts', 'rename')
  await waitInput()
  check('ⓐ 행 메뉴 「이름 바꾸기」', (await inputValue()) === 'l592-b.ts', { value: await inputValue() })
  await key('Escape')
  await focusRow('src/l592-a.ts')
  await key('F2')
  await sleep(300)
  const f2 = await inputOpen()
  log('F2', { opensInput: f2, decision: 'F2 는 넣지 않음(02-kickoff Q6 — macOS 는 Enter)' })
  check('ⓐ F2 = 넣지 않음(결정대로 무동작)', f2 === false, { f2 })
  // ⓑ Enter 확정 — 실제 이름 바꾸기 + 탭 없음
  before = snap()
  await focusRow('src/l592-a.ts')
  await key('Return')
  await waitInput()
  await setInput('l592-a2.ts')
  await key('Return')
  await until(() => Promise.resolve(exists('src/l592-a2.ts')), { label: '이름 바뀜' })
  let d = diff(before, snap())
  check('ⓑ Enter 확정 = 이름 바뀜(같은 inode)', eqSet(d.added, ['src/l592-a2.ts']) && eqSet(d.removed, ['src/l592-a.ts']) && before['src/l592-a.ts'].ino === snap()['src/l592-a2.ts'].ino, d)
  // ⓒ 같은 이름 = 무동작
  before = snap()
  await focusRow('src/l592-a2.ts')
  await key('Return')
  await waitInput()
  await key('Return')
  await sleep(400)
  check('ⓒ 같은 이름 Enter = 무동작', same(diff(before, snap())) && !(await inputOpen()), null)
  // ⓒ 대소문자만 바꾸기 — readdir 대조
  before = snap()
  await focusRow('l592-top.txt')
  await key('Return')
  await waitInput()
  await setInput('L592-TOP.txt')
  await key('Return')
  await until(() => Promise.resolve(fs.readdirSync(repo).includes('L592-TOP.txt')), { timeoutMs: 4000, label: '대소문자 바뀜' }).catch(() => null)
  const names = fs.readdirSync(repo)
  check('ⓒ 대소문자만 바꾸기 = readdir 이름이 바뀜·inode 같음', names.includes('L592-TOP.txt') && !names.includes('l592-top.txt') && snap()['L592-TOP.txt']?.ino === before['l592-top.txt'].ino, { names, msg: await inputMessage() })
  // ⓓ 충돌 = 안내·덮어쓰기 0
  before = snap()
  await focusRow('src/l592-a2.ts')
  await key('Return')
  await waitInput()
  await setInput('l592-b.ts')
  await sleep(120)
  const msg = await inputMessage()
  await key('Return')
  await sleep(500)
  check('ⓓ 다른 항목과 충돌 = 안내·덮어쓰기 0', msg !== null && same(diff(before, snap())), { msg, after: await inputMessage() })
  await key('Escape')
  // ⓔ 폴더 이름 변경 — 밑 펼침·선택 유지
  fs.mkdirSync(abs('src/sub/l592-inner'))
  fs.writeFileSync(abs('src/sub/l592-inner/x.txt'), 'x\n')
  await expand('src/sub')
  await until(() => hasRow('src/sub/l592-inner'), { label: 'inner 행' })
  await expand('src/sub/l592-inner')
  await focusRow('src/sub')
  // 폴더 행 클릭은 접고 펴기를 겸한다 — 펼친 상태로 되돌린 뒤 이름을 바꾼다
  if ((await expanded('src/sub')) !== 'true') await key('Right')
  await until(async () => (await expanded('src/sub')) === 'true' && (await expanded('src/sub/l592-inner')) === 'true', { label: '펼침 상태' })
  await key('Return')
  await waitInput()
  await setInput('l592-sub2')
  await key('Return')
  await until(() => hasRow('src/l592-sub2/l592-inner/x.txt'), { timeoutMs: 5000, label: '새 경로 행' }).catch(() => null)
  const kept = { sub2: await expanded('src/l592-sub2'), inner: await expanded('src/l592-sub2/l592-inner'), child: await hasRow('src/l592-sub2/l592-inner/x.txt'), selected: await selectedRow() }
  check('ⓔ 폴더 이름 변경 뒤 밑 펼침·선택이 새 경로', kept.sub2 === 'true' && kept.inner === 'true' && kept.child && kept.selected === 'src/l592-sub2', kept)
  // ⓕ 열기 입구 무회귀 — ⌘↓(고정) · Space(미리보기) · 클릭(미리보기) · 더블클릭(고정)
  await focusRow('docs')
  await expand('docs')
  await focusRow('docs/l592-readme.md')
  await key('Down', ['meta'])
  await until(() => tab('docs/l592-readme.md'), { label: '⌘↓ 탭' })
  const cmdDown = await tab('docs/l592-readme.md')
  await focusRow('src/l592-b.ts')
  await key('Space')
  await until(() => tab('src/l592-b.ts'), { label: 'Space 탭' })
  const space = await tab('src/l592-b.ts')
  await click(row('src/l592-a2.ts'))
  await until(() => tab('src/l592-a2.ts'), { label: '클릭 탭' })
  const single = await tab('src/l592-a2.ts')
  await ctl(root, { cmd: 'dblclick', selector: row('src/l592-a2.ts') })
  await until(async () => (await tab('src/l592-a2.ts'))?.preview === 'false', { label: '더블클릭 고정' })
  const dbl = await tab('src/l592-a2.ts')
  const opens = { cmdDown, space, single, dbl, inputOpen: await inputOpen() }
  check('ⓕ ⌘↓ = 고정 탭 · Space = 미리보기 · 클릭 = 미리보기 · 더블클릭 = 고정(Enter 는 이름 바꾸기로 바뀜)', cmdDown?.preview === 'false' && space?.preview === 'true' && single?.preview === 'true' && dbl?.preview === 'false' && opens.inputOpen === false, opens)
}

cases.e3 = async () => {
  await expand('src')
  // ⓐ 행 우클릭 「삭제」 — 확인(스텁 trash) → 휴지통
  fs.writeFileSync(abs('src/l592-del-menu.txt'), 'menu\n')
  fs.writeFileSync(abs('src/l592-del-key.txt'), 'key\n')
  await until(() => hasRow('src/l592-del-key.txt'), { label: '삭제 대상 행' })
  let before = snap()
  await stub(['trash'])
  let at = new Date().toISOString()
  await rowMenu('src/l592-del-menu.txt', 'trash')
  await until(() => Promise.resolve(!exists('src/l592-del-menu.txt')), { label: '메뉴 삭제' })
  noteTrash('src/l592-del-menu.txt', '행 메뉴 삭제 → 확인(스텁)', at)
  let asked = (await stub([])).asked
  check('ⓐ 행 메뉴 삭제 → 확인 → 휴지통', eqSet(diff(before, snap()).removed, ['src/l592-del-menu.txt']), { asked })
  // ⓐ ⌘⌫
  before = snap()
  await stub(['trash'])
  await focusRow('src/l592-del-key.txt')
  at = new Date().toISOString()
  await key('Backspace', ['meta'])
  await until(() => Promise.resolve(!exists('src/l592-del-key.txt')), { label: '⌘⌫ 삭제' })
  noteTrash('src/l592-del-key.txt', '⌘⌫ → 확인(스텁)', at)
  asked = (await stub([])).asked
  check('ⓐ 트리 ⌘⌫ → 확인 → 휴지통', eqSet(diff(before, snap()).removed, ['src/l592-del-key.txt']), { asked })
  // ⓒ 원 경로 없음 + ~/.Trash 에 그 l592 항목(확인 방식: ~/.Trash readdir 에서 이름 접두사만 — 남의 항목 이름은 기록하지 않는다)
  // 확인 방식(trashed.md 와 같음): 원 경로 없음 + main 로그 explorer.op trash ok. ~/.Trash 목록은 이 세션에 전체 디스크 접근이 없으면 EPERM — 그 사실을 기록한다(Finder 확인은 E12ⓒ).
  const listing = { menu: trashListing('l592-del-menu'), key: trashListing('l592-del-key') }
  const trashOk = opLogs().filter((r) => r.op === 'trash' && r.ok === true).length
  log('trash-listing', { listing, trashOk })
  check('ⓒ 원 경로 없음 + explorer.op trash ok 2건(~/.Trash 목록은 기록만)', !exists('src/l592-del-menu.txt') && !exists('src/l592-del-key.txt') && trashOk >= 2, { listing, trashOk })
  // ⓑ 확인 대화상자 — 폴더(안의 내용까지)·수정 중 탭 사실 · 취소 = 무변경
  fs.mkdirSync(abs('l592-deldir/inner'), { recursive: true })
  fs.writeFileSync(abs('l592-deldir/inner/f.ts'), 'export const f = 1\n')
  await until(() => hasRow('l592-deldir'), { label: '폴더 행' })
  await expand('l592-deldir')
  await expand('l592-deldir/inner')
  await openFixed('l592-deldir/inner/f.ts')
  await exposeMonaco(root)
  await edOf('l592-deldir/inner/f.ts', `e.setPosition({ lineNumber: 1, column: 1 }); e.trigger('keyboard', 'type', { text: 'Z' }); return true`)
  await until(async () => (await tab('l592-deldir/inner/f.ts'))?.dirty === 'true', { label: '수정 중' })
  before = snap()
  await stub(['cancel'])
  await rowMenu('l592-deldir', 'trash')
  await sleep(600)
  asked = (await stub([])).asked
  const dialogLog = logRows().filter((r) => r.tag === 'file.dialog').slice(-1)[0] ?? null
  log('dialog', { asked, dialogLog })
  check('ⓑ 폴더·수정 중 탭 확인 → 취소 = 디스크 무변경·탭 그대로', same(diff(before, snap())) && (await tab('l592-deldir/inner/f.ts'))?.dirty === 'true', { asked, dialogLog })
  check('ⓑ 확인 대화상자에 폴더(isDir)·수정 중 탭(dirty) 사실', dialogLog?.kind === 'trash' && dialogLog?.isDir === true && dialogLog?.dirty >= 1 && dialogLog?.choice === 'cancel', { asked, dialogLog })
  // ⓓ 링크 행 삭제 = 링크만 — 안 대상·밖 대상 sha 무변경
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'l592-target.txt'), 'outside target\n')
  fs.symlinkSync('src/l592-b.ts', abs('l592-link-in'))
  fs.symlinkSync(path.join(outside, 'l592-target.txt'), abs('l592-link-out'))
  await until(() => hasRow('l592-link-out'), { label: '링크 행' })
  const targets = () => ({ inside: sha(abs('src/l592-b.ts')), outside: sha(path.join(outside, 'l592-target.txt')) })
  const t0 = targets()
  for (const link of ['l592-link-in', 'l592-link-out']) {
    await stub(['trash'])
    at = new Date().toISOString()
    await rowMenu(link, 'trash')
    await until(() => Promise.resolve(!exists(link)), { label: `링크 삭제 ${link}` })
    noteTrash(link, '행 메뉴 삭제(링크 자체) → 확인(스텁)', at)
    await stub([])
  }
  check('ⓓ 링크 행 삭제 = 링크만(안·밖 대상 sha 무변경)', JSON.stringify(targets()) === JSON.stringify(t0) && !exists('l592-link-in') && !exists('l592-link-out'), { t0, t1: targets() })
  // ⓔ 루트·.git·밖 거절(실제 창 → preload → ipcMain)
  const r0 = await ipcRoot()
  const refusals = { ipcRoot: r0, root: await ipc({ op: 'trash', root: r0, rel: '', snapshot: false }), git: await ipc({ op: 'trash', root: r0, rel: '.git', snapshot: false }), gitUpper: await ipc({ op: 'trash', root: r0, rel: '.GIT', snapshot: false }), outside: await ipc({ op: 'trash', root: r0, rel: '../outside/l592-target.txt', snapshot: false }) }
  check('ⓔ 루트·.git·밖 = 거절(사유 코드)', refusals.root.code === 'protected' && refusals.git.code === 'protected' && refusals.gitUpper.code === 'protected' && !refusals.outside.ok && fs.existsSync(path.join(repo, '.git')) && fs.existsSync(path.join(outside, 'l592-target.txt')), refusals)
  // ⓕ 휴지통 실패(쓰기 권한 없는 폴더 안) → 안내·디스크 무변경·영구 삭제 0
  fs.mkdirSync(abs('l592-locked'))
  fs.writeFileSync(abs('l592-locked/l592-keep.txt'), 'keep\n')
  await until(() => hasRow('l592-locked'), { label: '잠금 폴더 행' })
  await expand('l592-locked')
  fs.chmodSync(abs('l592-locked'), 0o555)
  try {
    before = snap()
    await stub(['trash'])
    await rowMenu('l592-locked/l592-keep.txt', 'trash')
    await until(async () => (await toasts()).some((t) => t.includes('휴지통')), { timeoutMs: 6000, label: '실패 안내' }).catch(() => null)
    const shown = await toasts()
    await stub([])
    const failLog = opLogs().slice(-1)[0] ?? null
    check('ⓕ 휴지통 실패 = 안내·디스크 무변경(영구 삭제 없음)', same(diff(before, snap())) && exists('l592-locked/l592-keep.txt') && shown.some((t) => t.includes('trash_failed') || t.includes('휴지통')), { shown, failLog })
  } finally {
    fs.chmodSync(abs('l592-locked'), 0o755)
  }
}

// --- 공용(E4~E10ⓑ) -------------------------------------------------------------------------------------
const fake = process.argv[5] ?? null
/** 같은 ROOT 로 앱만 다시 띄운다(herdr 세션 유지 — 재시작 복원). ISO_ENV 는 iso.sh 가 준 그대로. */
async function restartApp() {
  cdpSocket?.close()
  cdpSocket = null
  await ctl(root, { cmd: 'flush-storage' }).catch(() => null)
  const down = execFileSync('sh', ['scripts/l577/g-down.sh', root, 'term'], { encoding: 'utf8' })
  const extra = (process.env.ISO_ENV ?? '').split(/\s+/).filter(Boolean).map((item) => item.replaceAll('{ROOT}', root))
  const up = execFileSync('sh', ['scripts/l577/g-up.sh', root, fake, 'L577_KEEP_PAINTING=1', ...extra], { encoding: 'utf8' })
  log('restart', { down: down.trim().split('\n').slice(-2), up: up.trim().split('\n').slice(-1), appPid: fs.readFileSync(path.join(root, 'app.pid'), 'utf8').trim() })
  await until(() => q(`!!document.querySelector('.app-body')`).catch(() => false), { timeoutMs: 30_000, label: '재시작 렌더러' })
  await sleep(1500)
  await ctl(root, { cmd: 'resize-window', width: 1400, height: 900 }).catch(() => null)
  if (!(await panelOpen())) await key('L', ['meta'])
  await until(panelOpen, { label: '재시작 탐색기' })
  await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { label: '재시작 탐색기 행' })
}
const panelOpen = async () => (await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
const prefs = () => JSON.parse(fs.readFileSync(path.join(root, 'ud/ui-prefs.json'), 'utf8'))
const layoutFormats = () => (prefs().groupLayouts ?? []).map((rowItem) => ({ worktreePath: rowItem.worktreePath, layoutFormat: rowItem.layoutFormat ?? null, fileTabs: JSON.stringify(rowItem.layout).match(/file:[^"]+/g) ?? [] }))
const renameVia = async (rel, newName) => {
  await focusRow(rel)
  await key('Return')
  await waitInput()
  await setInput(newName)
  await key('Return')
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : ''
  await until(() => Promise.resolve(exists(`${parent}${newName}`)), { timeoutMs: 5000, label: `이름 변경 ${rel} → ${newName}` })
  return `${parent}${newName}`
}
/** 행 끌기(문턱 넘는 여러 단계 움직임). `hold` ms 만큼 대상 위에 머문다. 놓기 전 화면 표지를 돌려준다. */
async function dragRow(fromSel, toAt, { steps = 6, hold = 0, release = true } = {}) {
  const from = await center(fromSel)
  await mouse('mouseDown', from)
  for (let i = 1; i <= steps; i += 1) {
    await mouse('mouseMove', { x: from.x + ((toAt.x - from.x) * i) / steps, y: from.y + ((toAt.y - from.y) * i) / steps })
    await sleep(40)
  }
  if (hold > 0) {
    const until0 = Date.now() + hold
    while (Date.now() < until0) {
      await mouse('mouseMove', { x: toAt.x + ((Date.now() / 50) % 2), y: toAt.y })
      await sleep(60)
    }
  }
  const marks = await q(`({ dragging: document.querySelector('.explorer-scroll.is-dragging') !== null, target: [...document.querySelectorAll('.explorer-row.is-drop-target')].map((e) => e.dataset.explorerRow), root: document.querySelector('.explorer-scroll.is-drop-root') !== null, source: document.querySelector('.explorer-row.is-drag-source')?.dataset.explorerRow ?? null })`)
  if (release) await mouse('mouseUp', toAt)
  return marks
}
const ptyLog = () => path.join(root, 'pty.log')
/** 터미널 pane 이 받는 바이트를 파일로(-icanon·echo 끔 · `dd bs=1` — 1바이트씩 바로 쓴다. BSD `cat -v` 는 파일 출력을 버퍼에 모아 양성 대조가 비었다) — PTY 로 간 바이트를 센다. */
async function ptyCaptureStart(paneId) {
  fs.rmSync(ptyLog(), { force: true })
  await herdr(root, 'pane.send_text', { pane_id: paneId, text: `stty -icanon -echo min 1; dd bs=1 of=${ptyLog()} 2>/dev/null\n` })
  await until(() => Promise.resolve(fs.existsSync(ptyLog())), { timeoutMs: 8000, label: 'pty 캡처 시작' })
  await sleep(400)
}
async function ptyCaptureStop(paneId) {
  await herdr(root, 'pane.send_text', { pane_id: paneId, text: '\x03' })
  await sleep(200)
  await herdr(root, 'pane.send_text', { pane_id: paneId, text: 'stty sane\n' })
  await sleep(200)
}
const ptyBytes = () => (fs.existsSync(ptyLog()) ? fs.readFileSync(ptyLog(), 'utf8') : null)
const termFocus = async (paneId) => {
  await click('.main-tab:not(.main-tab-file)').catch(() => null)
  await sleep(300)
  await until(async () => {
    await ctl(root, { cmd: 'term-click', fx: 0.5, fy: 0.5 }).catch(() => null)
    await click(`[data-term-pane-box="${paneId}"]`).catch(() => null)
    await sleep(200)
    return q(`document.activeElement?.closest('[data-term-pane-box]') !== null`)
  }, { timeoutMs: 8000, label: '터미널 포커스' })
}
const terminalPane = async () => (await repoPane(root)).paneId
/** 두 번째 worktree(같은 레포의 linked worktree) — 같은 상대 경로가 있다. */
async function openSecondWorktree() {
  const real = fs.realpathSync(repo)
  const wt2 = path.join(path.dirname(real), 'wt2')
  if (!fs.existsSync(wt2)) execFileSync('git', ['-C', real, 'worktree', 'add', '-q', '-b', 'l592-wt2', wt2])
  await q(`window.corral.refreshTree()`)
  await q(`window.corral.openWorktree({ repoRoot: ${JSON.stringify(real)}, path: ${JSON.stringify(wt2)}, isLinked: true })`)
  await until(async () => ((await herdr(root, 'pane.list')).panes ?? []).some((pane) => typeof pane.cwd === 'string' && pane.cwd.includes('wt2')), { timeoutMs: 15_000, label: 'wt2 pane' })
  await until(() => q(`!!document.querySelector('[data-worktree="${wt2}"]')`), { label: 'wt2 카드' })
  return { real, wt2 }
}
async function selectWorktree(worktreePath) {
  await clickUntil(`[data-worktree="${worktreePath}"]`)
  await sleep(900)
  await until(() => q(`document.querySelector('[data-explorer-root]')?.dataset.explorerRoot === ${JSON.stringify(worktreePath)}`), { timeoutMs: 8000, label: `탐색기 루트 ${worktreePath}` })
  await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { label: '행' })
}
const modelOf = (rel) => edOf(rel, `return { value: m.getValue(), cursor: e.getPosition(), scrollTop: e.getScrollTop(), canUndo: m.canUndo(), version: m.getAlternativeVersionId(), uri: m.uri.path }`)

cases.e4 = async () => {
  await expand('src')
  fs.mkdirSync(abs('src/l592-e4'))
  const body = Array.from({ length: 120 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'
  fs.writeFileSync(abs('src/l592-e4/l592-a.ts'), body)
  fs.writeFileSync(abs('src/l592-e4/l592-p.ts'), 'export const p = 1\n')
  fs.writeFileSync(abs('src/l592-e4/l592-q.ts'), 'export const q = 1\n')
  await until(() => hasRow('src/l592-e4'), { label: 'e4 폴더' })
  await expand('src/l592-e4')
  await exposeMonaco(root)
  for (const name of ['l592-p.ts', 'l592-a.ts', 'l592-q.ts']) await openFixed(`src/l592-e4/${name}`)
  await click('[data-main-tab="file:src/l592-e4/l592-a.ts"]')
  await until(async () => (await tab('src/l592-e4/l592-a.ts'))?.active === 'true', { label: 'a 활성' })
  // ⓑ 준비 — 수정·커서·스크롤
  await editorFocus('src/l592-e4/l592-a.ts')
  await edOf('src/l592-e4/l592-a.ts', `e.setPosition({ lineNumber: 80, column: 5 }); e.trigger('keyboard', 'type', { text: 'EDIT' }); e.setScrollTop(900); return true`)
  await until(async () => (await tab('src/l592-e4/l592-a.ts'))?.dirty === 'true', { label: '수정 중' })
  await sleep(200)
  const m0 = await modelOf('src/l592-e4/l592-a.ts')
  const t0 = await tab('src/l592-e4/l592-a.ts')
  // ⓐ 파일 이름 변경 → 탭 속성
  await startNoticeSampler(root)
  let rel = await renameVia('src/l592-e4/l592-a.ts', 'l592-a2.ts')
  await until(() => tab(rel), { label: '탭 따라감' })
  await sleep(1500)
  const seen1 = await stopNoticeSampler(root)
  const t1 = await tab(rel)
  const m1 = await modelOf(rel)
  log('rename-file', { t0, t1, m0: { ...m0, value: m0.value.length }, m1: { ...m1, value: m1?.value.length }, seen1, oldTab: await tab('src/l592-e4/l592-a.ts') })
  const tabSame = (a, b, newTitle) => b !== null && a.dirty === b.dirty && a.preview === b.preview && a.active === b.active && a.group === b.group && a.order === b.order && a.icon === b.icon && b.title.includes(newTitle) && (b.tooltip ?? '').includes(newTitle)
  check('ⓐ 파일 이름 변경 → 탭 새 경로(제목·아이콘·툴팁·활성·미리보기·영역·순서)', tabSame(t0, t1, 'l592-a2.ts') && (await tab('src/l592-e4/l592-a.ts')) === null, { t0, t1 })
  check('ⓑ 수정 중 탭 내용·수정 표시·커서·스크롤 그대로', m1 !== null && m1.value === m0.value && t1.dirty === 'true' && JSON.stringify(m1.cursor) === JSON.stringify(m0.cursor) && m1.scrollTop === m0.scrollTop, { m0c: m0.cursor, m1c: m1?.cursor, s0: m0.scrollTop, s1: m1?.scrollTop })
  // ⓐ 품은 폴더 이름 변경
  await startNoticeSampler(root)
  const dirRel = await renameVia('src/l592-e4', 'l592-e4b')
  rel = 'src/l592-e4b/l592-a2.ts'
  await until(() => tab(rel), { label: '폴더 이름 변경 탭 따라감' })
  await sleep(1500)
  const seen2 = await stopNoticeSampler(root)
  const t2 = await tab(rel)
  const m2 = await modelOf(rel)
  const others = { p: await tab('src/l592-e4b/l592-p.ts'), q: await tab('src/l592-e4b/l592-q.ts') }
  check('ⓐ 품은 폴더 이름 변경 → 탭 셋 새 경로·속성 그대로', tabSame(t0, t2, 'l592-a2.ts') && others.p !== null && others.q !== null && m2?.value === m0.value, { dirRel, t2, others })
  // ⓐ 이동(끌기) — 품은 폴더를 docs 로
  await startNoticeSampler(root)
  await dragRow(row('src/l592-e4b'), await center(row('docs')))
  rel = 'docs/l592-e4b/l592-a2.ts'
  await until(() => Promise.resolve(exists('docs/l592-e4b/l592-a2.ts')), { label: '폴더 이동' })
  await until(() => tab(rel), { label: '이동 탭 따라감' })
  await sleep(1500)
  const seen3 = await stopNoticeSampler(root)
  const t3 = await tab(rel)
  const m3 = await modelOf(rel)
  check('ⓐ 품은 폴더 이동(끌기) → 탭 새 경로·속성 그대로', tabSame(t0, t3, 'l592-a2.ts') && m3?.value === m0.value, { t3 })
  check('ⓒ 재지정 3회 「삭제됨」·배너 표본 0', seen1.length === 0 && seen2.length === 0 && seen3.length === 0, { seen1, seen2, seen3 })
  // ⓑ 편집 실행 취소 기록 — 편집기 ⌘Z 가 이름 변경 전 편집을 되돌린다 → ⌘⇧Z 로 다시
  await editorFocus(rel)
  await key('Z', ['meta'])
  await sleep(300)
  const undone = await modelOf(rel)
  await key('Z', ['meta', 'shift'])
  await sleep(300)
  const redone = await modelOf(rel)
  check('ⓑ 편집 실행 취소 기록 유지(⌘Z = 이름 변경 전 편집 되돌림 · ⌘⇧Z 다시)', undone.value === body && redone.value === m0.value, { undoneIsDisk: undone.value === body, redoneIsEdit: redone.value === m0.value })
  // ⓑ ⌘S → 새 경로에 저장, 옛 경로 재생성 0
  await key('S', ['meta'])
  await until(async () => (await tab(rel))?.dirty === 'false', { label: '저장' })
  const saved = fs.readFileSync(abs(rel), 'utf8')
  check('ⓑ ⌘S = 새 경로에 저장·옛 경로(파일·폴더) 재생성 0', saved === m0.value && !exists('src/l592-e4/l592-a.ts') && !exists('src/l592-e4') && !exists('src/l592-e4b'), { savedSame: saved === m0.value })
  // ⓒ 10회 연속 — 수정 중 탭을 품은 파일 이름을 번갈아 바꾼다
  await edOf(rel, `e.setPosition({ lineNumber: 3, column: 1 }); e.trigger('keyboard', 'type', { text: 'Z' }); return true`)
  await until(async () => (await tab(rel))?.dirty === 'true', { label: '다시 수정' })
  const cont = []
  for (let i = 0; i < 10; i += 1) {
    const before = await modelOf(rel)
    await startNoticeSampler(root)
    const reads0 = logRows().filter((r) => r.tag === 'file.read').length
    const next = await renameVia(rel, i % 2 === 0 ? 'l592-a3.ts' : 'l592-a2.ts')
    await until(() => tab(next), { label: `연속 ${i}` })
    await sleep(1200)
    const seen = await stopNoticeSampler(root)
    const after = await modelOf(next)
    const reads = logRows().filter((r) => r.tag === 'file.read').length - reads0
    cont.push({ i, from: rel, to: next, seen: seen.length, seenFirst: seen[0] ?? null, seenLast: seen.at(-1) ?? null, seenKinds: [...new Set(seen.map((x) => `${x.deleted ? 'deleted' : ''}${x.banner ? 'banner' : ''}:${x.tab}`))], same: after?.value === before.value, dirty: (await tab(next))?.dirty, cursor: JSON.stringify(after?.cursor) === JSON.stringify(before.cursor), reads })
    rel = next
  }
  current.metrics = { continuous: cont }
  check('ⓒ 10회 연속 — 「삭제됨」·배너 0 · 다시 읽어 덮기 0(모델 = 수정 내용·수정 표시·커서)', cont.length === 10 && cont.every((c) => c.seen === 0 && c.same && c.dirty === 'true' && c.cursor), cont)
  await editorFocus(rel)
  await key('S', ['meta'])
  await until(async () => (await tab(rel))?.dirty === 'false', { label: '저장 2' })
  // ⓓ ⌘⇧T — 닫은 탭을 이름 변경 뒤 다시 열기 = 새 경로
  await openFixed('docs/l592-readme.md')
  await click('[data-main-tab-close="file:docs/l592-readme.md"]')
  await until(async () => (await tab('docs/l592-readme.md')) === null, { label: '탭 닫힘' })
  await renameVia('docs/l592-readme.md', 'l592-readme-r.md')
  await click(`[data-main-tab="file:${rel}"]`)
  await key('T', ['meta', 'shift'])
  await until(() => tab('docs/l592-readme-r.md'), { timeoutMs: 5000, label: '⌘⇧T 새 경로' }).catch(() => null)
  const reopened = { newPath: await tab('docs/l592-readme-r.md'), oldPath: await tab('docs/l592-readme.md'), oldDisk: exists('docs/l592-readme.md') }
  check('ⓓ 닫은 탭 다시 열기(⌘⇧T) = 새 경로(옛 경로 탭·파일 0)', reopened.newPath !== null && reopened.oldPath === null && !reopened.oldDisk, reopened)
  // ⓓ 재시작 복원 · layoutFormat 같음 · ⓓ(E5) 기록은 메모리 — 재시작 뒤 ⌘Z 무동작
  const tabsBefore = await fileTabs()
  await ctl(root, { cmd: 'flush-storage' }).catch(() => null)
  await sleep(500)
  const lf0 = layoutFormats()
  await restartApp()
  await until(async () => (await fileTabs()).length > 0, { timeoutMs: 10_000, label: '복원 탭' }).catch(() => null)
  const tabsAfter = await fileTabs()
  const lf1 = layoutFormats()
  check('ⓓ 재시작 복원 = 새 경로 탭(옛 경로 0) · layoutFormat 같음', tabsAfter.includes(rel) && tabsAfter.includes('docs/l592-readme-r.md') && !tabsAfter.some((t) => t.includes('l592-e4/') || t === 'docs/l592-readme.md') && JSON.stringify(lf0.map((r) => r.layoutFormat)) === JSON.stringify(lf1.map((r) => r.layoutFormat)) && lf1.every((r) => r.layoutFormat === lf0[0]?.layoutFormat), { tabsBefore, tabsAfter, lf0: lf0.map((r) => [r.worktreePath, r.layoutFormat]), lf1: lf1.map((r) => [r.worktreePath, r.layoutFormat]) })
  let before = snap()
  await focusRow('docs')
  await key('Z', ['meta'])
  await sleep(700)
  check('(E5ⓓ) 재시작 뒤 기록 비움 — 트리 ⌘Z 디스크 무변경', same(diff(before, snap())), diff(before, snap()))
  await exposeMonaco(root)
  // ⓔ 삭제 탭 — 수정 없는 탭은 닫힘 · 수정 중 탭은 「삭제됨」 유지 → ⌘Z 되살림이면 풀림
  await expand('src')
  fs.writeFileSync(abs('src/l592-e4-clean.ts'), 'clean\n')
  fs.writeFileSync(abs('src/l592-e4-dirty.ts'), 'dirty\n')
  await until(() => hasRow('src/l592-e4-dirty.ts'), { label: 'e4ⓔ 행' })
  await openFixed('src/l592-e4-clean.ts')
  await openFixed('src/l592-e4-dirty.ts')
  await editorFocus('src/l592-e4-dirty.ts')
  await edOf('src/l592-e4-dirty.ts', `e.setPosition({ lineNumber: 1, column: 1 }); e.trigger('keyboard', 'type', { text: 'W' }); return true`)
  await until(async () => (await tab('src/l592-e4-dirty.ts'))?.dirty === 'true', { label: 'ⓔ 수정' })
  const dirtyModel = (await modelOf('src/l592-e4-dirty.ts')).value
  for (const target of ['src/l592-e4-clean.ts', 'src/l592-e4-dirty.ts']) {
    await stub(['trash'])
    const at = new Date().toISOString()
    await rowMenu(target, 'trash')
    await until(() => Promise.resolve(!exists(target)), { label: `삭제 ${target}` })
    noteTrash(target, '행 메뉴 삭제 → 확인(스텁) — 열린 탭', at)
    await stub([])
  }
  await sleep(800)
  const del = { clean: await tab('src/l592-e4-clean.ts'), dirty: await tab('src/l592-e4-dirty.ts'), marker: await q(`document.querySelector('[data-file-tab="src/l592-e4-dirty.ts"]')?.matches('.is-deleted') ?? null`), banner: await q(`document.querySelector('[data-file-view="src/l592-e4-dirty.ts"] [data-file-notice="deleted"]') !== null`), model: (await modelOf('src/l592-e4-dirty.ts'))?.value }
  check('ⓔ 수정 없는 탭 닫힘 · 수정 중 탭 남고 「삭제됨」·내용·수정 표시 유지', del.clean === null && del.dirty !== null && del.dirty.dirty === 'true' && (del.marker === true || del.banner === true) && del.model === dirtyModel, del)
  const bannerSel = '[data-file-view="src/l592-e4-dirty.ts"] [data-file-notice="external-change"]'
  const bannerBeforeUndo = await q(`document.querySelector('${bannerSel}') !== null`)
  await q(`(() => { window.__l592b = []; clearInterval(window.__l592bt); window.__l592bt = setInterval(() => window.__l592b.push({ t: Date.now(), banner: document.querySelector('${bannerSel}') !== null, deleted: document.querySelector('[data-file-view="src/l592-e4-dirty.ts"] [data-file-notice="deleted"]') !== null }), 20); return true })()`)
  await focusRow('src')
  const undoAt = Date.now()
  await key('Z', ['meta'])
  await until(() => Promise.resolve(exists('src/l592-e4-dirty.ts')), { timeoutMs: 6000, label: '되살림' })
  const restoredAt = Date.now()
  await sleep(1200)
  const timeline = await q(`(() => { clearInterval(window.__l592bt); return window.__l592b })()`)
  const firstBanner = timeline.find((x) => x.banner)?.t ?? null
  log('ⓔ 되살림 배너 시간선', { bannerBeforeUndo, undoAt, restoredAt, firstBanner, firstBannerAfterRestoreMs: firstBanner === null ? null : firstBanner - restoredAt, lastDeleted: [...timeline].reverse().find((x) => x.deleted)?.t ?? null, samples: timeline.length, restoreLog: opLogs().filter((x) => x.op === 'restore').slice(-1)[0] ?? null, readsAfter: logRows().filter((x) => x.tag === 'file.read' && x.at >= undoAt).length })
  const back = { dirty: await tab('src/l592-e4-dirty.ts'), marker: await q(`document.querySelector('[data-file-tab="src/l592-e4-dirty.ts"]')?.matches('.is-deleted') ?? null`), banner: await q(`document.querySelector('[data-file-view="src/l592-e4-dirty.ts"] [data-file-notice="deleted"]') !== null`), clean: await tab('src/l592-e4-clean.ts'), disk: fs.readFileSync(abs('src/l592-e4-dirty.ts'), 'utf8'), externalBanner: await q(`document.querySelector('[data-file-view="src/l592-e4-dirty.ts"] [data-file-notice="external-change"], [data-file-view="src/l592-e4-dirty.ts"] .file-view-conflict') !== null`), notices: await q(`[...document.querySelectorAll('[data-file-view="src/l592-e4-dirty.ts"] [data-file-notice]')].map((e) => e.dataset.fileNotice + ':' + e.textContent.slice(0, 80))`) }
  check('ⓔ 실행 취소로 되살리면 「삭제됨」 풀림 · 닫힌 탭은 다시 열지 않음', back.dirty !== null && back.marker === false && back.banner === false && back.clean === null && back.disk === 'dirty\n', back)
  // 되살린 내용 = 탭이 기대던 디스크 내용 그대로 — 설계(useFileOps 「되살리기」: 기준 stamp 만 옮겨 「삭제됨」·외부 변경 배너 없이 정상으로)대로 외부 변경 배너도 없어야 한다
  check('ⓔ 되살린 뒤 외부 변경 배너 없음(설계 useFileOps 7·220행)', bannerBeforeUndo === false && back.externalBanner === false, { bannerBeforeUndo, externalBanner: back.externalBanner, notices: back.notices, firstBanner, restoredAt })
  // D1 ① 되살린 뒤 ⌘S — 충돌 대화상자 없이 저장(external none 이면 묻지 않는다 — 대화상자가 뜨면 스텁이 「취소」 로 답하고 asked 에 남는다), 디스크 = 편집기 내용
  const conflictAsked = (asked) => JSON.stringify(asked ?? []).includes('conflict')
  const dialogsSince = (at) => logRows().filter((r) => r.tag === 'file.dialog' && r.at >= at).map((r) => r.kind)
  await stub(['cancel'])
  const saveAt = Date.now()
  await editorFocus('src/l592-e4-dirty.ts')
  await key('S', ['meta'])
  const savedClean = await until(async () => (await tab('src/l592-e4-dirty.ts'))?.dirty === 'false', { timeoutMs: 6000, label: 'D1 ⌘S' }).then(() => true, () => false)
  const restoredSave = { savedClean, asked: (await stub([])).asked, dialogs: dialogsSince(saveAt), disk: fs.readFileSync(abs('src/l592-e4-dirty.ts'), 'utf8'), model: (await modelOf('src/l592-e4-dirty.ts'))?.value, externalBanner: await q(`document.querySelector('${bannerSel}') !== null`) }
  check('D1① 되살린 뒤 ⌘S = 충돌 대화상자 없이 저장 · 디스크 = 편집기 내용 · 배너 없음', savedClean && !conflictAsked(restoredSave.asked) && !restoredSave.dialogs.includes('conflict') && restoredSave.disk === restoredSave.model && restoredSave.model === dirtyModel && !restoredSave.externalBanner, restoredSave)
  // D1 ②·③ — 수정 중 탭의 파일을 지우고 ⌘Z 로 되살리는 한 바퀴(앞의 ⓔ 와 같은 조작)
  const deleteAndRestore = async (target) => {
    await stub(['trash'])
    const at = new Date().toISOString()
    await rowMenu(target, 'trash')
    await until(() => Promise.resolve(!exists(target)), { label: `삭제 ${target}` })
    noteTrash(target, '행 메뉴 삭제 → 확인(스텁) — 수정 중 탭(D1 대조)', at)
    await stub([])
    await sleep(800)
    await focusRow('src')
    await key('Z', ['meta'])
    await until(() => Promise.resolve(exists(target)), { timeoutMs: 6000, label: `되살림 ${target}` })
    await sleep(1200)
  }
  const bannerOf = (rel) => q(`document.querySelector('[data-file-view="${rel}"] [data-file-notice="external-change"]') !== null`)
  const deletedOf = (rel) => q(`document.querySelector('[data-file-view="${rel}"] [data-file-notice="deleted"]') !== null || (document.querySelector('[data-file-tab="${rel}"]')?.matches('.is-deleted') ?? false)`)
  const dirtyEdit = async (rel, text) => {
    await editorFocus(rel)
    await edOf(rel, `e.setPosition({ lineNumber: 1, column: 1 }); e.trigger('keyboard', 'type', { text: '${text}' }); return true`)
    await until(async () => (await tab(rel))?.dirty === 'true', { label: `수정 ${rel}` })
  }
  // ② 양성 대조 — 되살린 뒤(다시 읽거나 저장하기 전) 외부에서 내용을 바꾸면 배너가 뜬다
  const pc = 'src/l592-e4-pc.ts'
  fs.writeFileSync(abs(pc), 'pc\n')
  await until(() => hasRow(pc), { label: 'D1② 행' })
  await openFixed(pc)
  await dirtyEdit(pc, 'P')
  await deleteAndRestore(pc)
  const pcRestored = { banner: await bannerOf(pc), deleted: await deletedOf(pc), dirty: (await tab(pc))?.dirty ?? null }
  fs.writeFileSync(abs(pc), 'pc external after restore\n')
  const pcBanner = await until(() => bannerOf(pc), { timeoutMs: 6000, label: 'D1② 배너' }).then(() => true, () => false)
  check('D1② 양성 대조 — 되살린 뒤(배너 없음) 외부 변경 → 배너 뜬다 · 편집 내용 유지', pcRestored.banner === false && pcRestored.deleted === false && pcRestored.dirty === 'true' && pcBanner && (await modelOf(pc))?.value === 'Ppc\n', { pcRestored, pcBanner })
  // ② 수정 중 탭 열린 채 외부 변경(삭제 없이) — 배너 그대로
  const nd = 'src/l592-e4-nodel.ts'
  fs.writeFileSync(abs(nd), 'nodel\n')
  await until(() => hasRow(nd), { label: 'D1② 삭제 없음 행' })
  await openFixed(nd)
  await dirtyEdit(nd, 'N')
  await sleep(600)
  const ndBefore = await bannerOf(nd)
  fs.writeFileSync(abs(nd), 'nodel external\n')
  const ndBanner = await until(() => bannerOf(nd), { timeoutMs: 6000, label: 'D1② 삭제 없음 배너' }).then(() => true, () => false)
  check('D1② 수정 중 탭 열린 채 외부 변경(삭제 없음) → 배너', ndBefore === false && ndBanner, { ndBefore, ndBanner })
  // ③ 삭제 전에 디스크가 이미 바뀐 경우(되살린 내용 ≠ 탭 기준) — 기존 동작: 되살린 뒤에도 외부 변경 배너 · ⌘S 는 충돌을 묻는다
  const df = 'src/l592-e4-diff.ts'
  fs.writeFileSync(abs(df), 'diff\n')
  await until(() => hasRow(df), { label: 'D1③ 행' })
  await openFixed(df)
  await dirtyEdit(df, 'D')
  fs.writeFileSync(abs(df), 'diff external before delete\n')
  const dfBefore = await until(() => bannerOf(df), { timeoutMs: 6000, label: 'D1③ 삭제 전 배너' }).then(() => true, () => false)
  await deleteAndRestore(df)
  const dfRestored = { banner: await bannerOf(df), deleted: await deletedOf(df), disk: fs.readFileSync(abs(df), 'utf8') }
  await stub(['cancel'])
  const dfSaveAt = Date.now()
  await editorFocus(df)
  await key('S', ['meta'])
  await sleep(1500)
  const dfSave = { asked: (await stub([])).asked, dialogs: dialogsSince(dfSaveAt), disk: fs.readFileSync(abs(df), 'utf8'), dirty: (await tab(df))?.dirty ?? null }
  check('D1③ 되살린 내용 ≠ 탭 기준 → 배너 그대로 · ⌘S 충돌 확인(취소 = 디스크 무변경)', dfBefore && dfRestored.banner === true && dfRestored.deleted === false && dfRestored.disk === 'diff external before delete\n' && (conflictAsked(dfSave.asked) || dfSave.dialogs.includes('conflict')) && dfSave.disk === dfRestored.disk && dfSave.dirty === 'true', { dfBefore, dfRestored, dfSave })
  // 정리 — 대조 탭은 「덮어쓰기」 로 저장해 닫을 때 묻지 않게(뒤 사례에 영향 없게)
  for (const rel of [pc, nd, df]) {
    await stub(['overwrite'])
    await click(`[data-main-tab="file:${rel}"]`)
    await until(async () => (await tab(rel))?.active === 'true', { label: `정리 활성 ${rel}` })
    await editorFocus(rel)
    await key('S', ['meta'])
    await until(async () => (await tab(rel))?.dirty === 'false', { timeoutMs: 6000, label: `정리 저장 ${rel}` }).catch(() => null)
    await stub([])
  }
  // ⓕ 실행 취소로 이름 변경을 되돌리면 탭도 옛 경로 — 수정 중 탭(ⓔ 와 다른 새 파일 — ⓔ 의 배너와 섞이지 않게)
  fs.writeFileSync(abs('src/l592-e4-f.ts'), 'f-line\n')
  await until(() => hasRow('src/l592-e4-f.ts'), { label: 'ⓕ 행' })
  await openFixed('src/l592-e4-f.ts')
  await editorFocus('src/l592-e4-f.ts')
  await edOf('src/l592-e4-f.ts', `e.setPosition({ lineNumber: 1, column: 3 }); e.trigger('keyboard', 'type', { text: 'F' }); return true`)
  await until(async () => (await tab('src/l592-e4-f.ts'))?.dirty === 'true', { label: 'ⓕ 수정' })
  const mBefore = await modelOf('src/l592-e4-f.ts')
  await renameVia('src/l592-e4-f.ts', 'l592-e4-f-r.ts')
  await until(() => tab('src/l592-e4-f-r.ts'), { label: 'ⓕ 따라감' })
  await startNoticeSampler(root)
  await focusRow('src/l592-e4-f-r.ts')
  await key('Z', ['meta'])
  await until(() => Promise.resolve(exists('src/l592-e4-f.ts')), { timeoutMs: 6000, label: 'ⓕ 되돌림' })
  await until(() => tab('src/l592-e4-f.ts'), { label: 'ⓕ 탭 옛 경로' })
  await sleep(1200)
  const seenF = await stopNoticeSampler(root)
  const mBack = await modelOf('src/l592-e4-f.ts')
  check('ⓕ ⌘Z 로 이름 변경 되돌림 → 탭 옛 경로·내용·수정·커서 그대로·표지 0', (await tab('src/l592-e4-f-r.ts')) === null && mBack?.value === mBefore.value && (await tab('src/l592-e4-f.ts'))?.dirty === 'true' && JSON.stringify(mBack.cursor) === JSON.stringify(mBefore.cursor) && seenF.length === 0, { seenF })
  // ⓖ 다른 worktree 의 같은 상대 경로 탭 영향 0
  const { real, wt2 } = await openSecondWorktree()
  await selectWorktree(wt2)
  await expand('src')
  await openFixed('src/l592-b.ts')
  const wtTab0 = await tab('src/l592-b.ts')
  await selectWorktree(real)
  await expand('src')
  await renameVia('src/l592-b.ts', 'l592-b-moved.ts')
  await sleep(800)
  await selectWorktree(wt2)
  await sleep(600)
  const wtTab1 = { b: await tab('src/l592-b.ts'), moved: await tab('src/l592-b-moved.ts'), disk: fs.existsSync(path.join(wt2, 'src/l592-b.ts')), deletedMarker: await q(`document.querySelector('[data-file-tab="src/l592-b.ts"]')?.matches('.is-deleted') ?? null`) }
  check('ⓖ 다른 worktree 같은 상대 경로 탭 영향 0', wtTab0 !== null && wtTab1.b !== null && wtTab1.moved === null && wtTab1.disk && wtTab1.deletedMarker === false, { wtTab0, wtTab1 })
  await selectWorktree(real)
  // ⓗ 외부 rename = 범위 밖(Q5) — 옛 경로 「삭제됨」(VS Code 와 같음) 무회귀
  await expand('src')
  await openFixed('src/l592-e4-dirty.ts')
  await editorFocus('src/l592-e4-dirty.ts')
  await key('S', ['meta'])
  await until(async () => (await tab('src/l592-e4-dirty.ts'))?.dirty === 'false', { label: 'ⓗ 저장' })
  fs.renameSync(abs('src/l592-e4-dirty.ts'), abs('src/l592-e4-ext.ts'))
  await sleep(2500)
  const ext = { old: await tab('src/l592-e4-dirty.ts'), marker: await q(`!!document.querySelector(${JSON.stringify('.main-tab.is-deleted, [data-file-notice="deleted"]')})`), newTab: await tab('src/l592-e4-ext.ts'), row: await hasRow('src/l592-e4-ext.ts') }
  check('ⓗ 외부 rename = 탭 따라가지 않음 · 옛 경로 「삭제됨」(또는 닫힘 — 기록) · 새 행 보임', ext.newTab === null && ext.row && (ext.old === null || ext.marker === true), ext)
}

// --- E5 ------------------------------------------------------------------------------------------------
const undo = async (at = 'src') => { await treeOn(at); await key('Z', ['meta']) }
const redo = async (at = 'src') => { await treeOn(at); await key('Z', ['meta', 'shift']) }
const settle = async (pred, label) => until(() => Promise.resolve(pred()), { timeoutMs: 6000, label }).then(() => true, () => false)

cases.e5 = async () => {
  await expand('src')
  const rows = []
  const cell = async (name, doIt, { forward, backward, undos = 1 }) => {
    const s0 = snap()
    await doIt()
    const okDo = await settle(forward, `${name} 실행`)
    const s1 = snap()
    for (let i = 0; i < undos; i += 1) {
      await undo()
      await sleep(250)
    }
    const okUndo = await settle(backward, `${name} 실행 취소`)
    const s2 = snap()
    for (let i = 0; i < undos; i += 1) {
      await redo()
      await sleep(250)
    }
    const okRedo = await settle(forward, `${name} 다시 실행`)
    const s3 = snap()
    const r = { name, okDo, okUndo, okRedo, undoDiff: diff(s0, s2), redoDiff: diff(s1, s3), toasts: await toasts() }
    rows.push(r)
    log(`cell ${name}`, r)
    return r
  }
  // 새 파일
  let r = await cell('새 파일', async () => createVia(async () => { await focusRow('src'); await clickUntil('[data-explorer-new-file]') }, { name: 'l592-u-new.ts', expectRel: 'src/l592-u-new.ts' }), { forward: () => exists('src/l592-u-new.ts'), backward: () => !exists('src/l592-u-new.ts') })
  noteTrash('src/l592-u-new.ts', '⌘Z(만들기 되돌림) → shell.trashItem')
  check('ⓐ 새 파일 ⌘Z·⌘⇧Z', r.okDo && r.okUndo && r.okRedo && same(r.undoDiff), r)
  r = await cell('새 폴더', async () => createVia(async () => { await focusRow('src'); await clickUntil('[data-explorer-new-folder]') }, { name: 'l592-u-dir', expectRel: 'src/l592-u-dir' }), { forward: () => exists('src/l592-u-dir'), backward: () => !exists('src/l592-u-dir') })
  noteTrash('src/l592-u-dir', '⌘Z(폴더 만들기 되돌림) → shell.trashItem')
  check('ⓐ 새 폴더 ⌘Z·⌘⇧Z', r.okDo && r.okUndo && r.okRedo && same(r.undoDiff), r)
  r = await cell('이름 변경', async () => renameVia('src/l592-a.ts', 'l592-a-r.ts'), { forward: () => exists('src/l592-a-r.ts') && !exists('src/l592-a.ts'), backward: () => exists('src/l592-a.ts') && !exists('src/l592-a-r.ts') })
  check('ⓐ 이름 변경 ⌘Z·⌘⇧Z(inode 같음)', r.okDo && r.okUndo && r.okRedo && same(r.undoDiff) && same(r.redoDiff), r)
  r = await cell('이동(끌기)', async () => dragRow(row('src/l592-a-r.ts'), await center(row('docs'))), { forward: () => exists('docs/l592-a-r.ts'), backward: () => exists('src/l592-a-r.ts') && !exists('docs/l592-a-r.ts') })
  check('ⓐ 이동 ⌘Z·⌘⇧Z', r.okDo && r.okUndo && r.okRedo && same(r.undoDiff) && same(r.redoDiff), r)
  r = await cell('복제', async () => rowMenu('l592-top.txt', 'duplicate'), { forward: () => exists('l592-top copy.txt'), backward: () => !exists('l592-top copy.txt') })
  noteTrash('l592-top copy.txt', '⌘Z(복제 되돌림) → shell.trashItem')
  check('ⓐ 복제 ⌘Z·⌘⇧Z', r.okDo && r.okUndo && r.okRedo && same(r.undoDiff), r)
  // 가져오기(합성 드롭) — 원본은 outside
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'l592-imp.txt'), 'imported\n')
  r = await cell('가져오기', async () => cdpDrop(await center(row('docs')), [path.join(outside, 'l592-imp.txt')]), { forward: () => exists('docs/l592-imp.txt'), backward: () => !exists('docs/l592-imp.txt') })
  noteTrash('docs/l592-imp.txt', '⌘Z(가져오기 되돌림) → shell.trashItem')
  check('ⓐ 가져오기 ⌘Z·⌘⇧Z', r.okDo && r.okUndo && r.okRedo && same(r.undoDiff), r)
  // 삭제 → 되살림 sha
  const shaBefore = sha(abs('src/l592-b.ts'))
  await stub(['trash', 'trash'])
  r = await cell('삭제', async () => { await focusRow('src/l592-b.ts'); await key('Backspace', ['meta']) }, { forward: () => !exists('src/l592-b.ts'), backward: () => exists('src/l592-b.ts') })
  await stub([])
  noteTrash('src/l592-b.ts', '⌘⌫ → 확인(스텁) / ⌘⇧Z 다시 삭제')
  const shaRestored = r.okUndo ? null : null
  void shaRestored
  await undo()
  await settle(() => exists('src/l592-b.ts'), '삭제 되살림 2')
  const shaAfter = exists('src/l592-b.ts') ? sha(abs('src/l592-b.ts')) : null
  check('ⓐ 삭제 ⌘Z 되살림 sha = 삭제 전 · ⌘⇧Z 다시 휴지통', r.okDo && r.okUndo && r.okRedo && shaAfter === shaBefore, { r, shaBefore, shaAfter })
  current.metrics = { cells: rows.map((x) => ({ name: x.name, do: x.okDo, undo: x.okUndo, redo: x.okRedo })) }
  // 기록 연쇄 격리 실창(Q51 너머) — 이름 변경 → 삭제 → ⌘Z → ⌘Z · 복제 → 이름 변경 → ⌘Z ⌘Z ⌘⇧Z ⌘⇧Z
  await stub(['trash'])
  const c0 = snap()
  const renamed = await renameVia('docs/l592-readme.md', 'l592-readme-c.md')
  await focusRow(renamed)
  await key('Backspace', ['meta'])
  await settle(() => !exists(renamed), '연쇄 삭제')
  noteTrash(renamed, '연쇄: 이름 변경 → ⌘⌫')
  await stub([])
  await undo('docs')
  await settle(() => exists(renamed), '연쇄 되살림')
  await undo('docs')
  const chain1 = await settle(() => exists('docs/l592-readme.md') && !exists(renamed), '연쇄 이름 되돌림')
  check('ⓐ 연쇄 이름 변경 → 삭제 → ⌘Z ⌘Z = 원래 상태(sha 같음)', chain1 && JSON.stringify(snap()['docs/l592-readme.md']?.sha) === JSON.stringify(c0['docs/l592-readme.md'].sha), { chain1, toasts: await toasts() })
  // 새 파일로(앞 「복제」 칸이 l592-top copy.txt 를 남겼다)
  fs.writeFileSync(abs('l592-chain.txt'), 'chain\n')
  await until(() => hasRow('l592-chain.txt'), { label: '연쇄 파일 행' })
  await rowMenu('l592-chain.txt', 'duplicate')
  await settle(() => exists('l592-chain copy.txt'), '연쇄 복제')
  await renameVia('l592-chain copy.txt', 'l592-chain-dup.txt')
  await undo('l592-chain.txt')
  await settle(() => exists('l592-chain copy.txt'), '연쇄 ⌘Z 1')
  await undo('l592-chain.txt')
  const c2a = await settle(() => !exists('l592-chain copy.txt') && !exists('l592-chain-dup.txt'), '연쇄 ⌘Z 2')
  noteTrash('l592-chain copy.txt', '연쇄: 복제 → 이름 변경 → ⌘Z ⌘Z(복제 되돌림)')
  await redo('l592-chain.txt')
  await settle(() => exists('l592-chain copy.txt'), '연쇄 ⌘⇧Z 1')
  await redo('l592-chain.txt')
  const c2b = await settle(() => exists('l592-chain-dup.txt') && !exists('l592-chain copy.txt'), '연쇄 ⌘⇧Z 2')
  check('ⓐ 연쇄 복제 → 이름 변경 → ⌘Z ⌘Z ⌘⇧Z ⌘⇧Z 왕복 거절 없음', c2a && c2b && !(await toasts()).some((t) => t.includes('하지 못했습니다')), { c2a, c2b, toasts: await toasts() })
  // ⓒ 데이터 무손실 — 만든 뒤 내용이 바뀐 파일의 만들기 되돌림 = 거절(안내)·파일 그대로
  await createVia(async () => { await focusRow('src'); await clickUntil('[data-explorer-new-file]') }, { name: 'l592-u-mod.ts', expectRel: 'src/l592-u-mod.ts' })
  fs.writeFileSync(abs('src/l592-u-mod.ts'), 'changed after create\n')
  await sleep(600)
  await undo()
  await sleep(1200)
  const modRefuse = { exists: exists('src/l592-u-mod.ts'), content: exists('src/l592-u-mod.ts') ? fs.readFileSync(abs('src/l592-u-mod.ts'), 'utf8') : null, toasts: await toasts(), last: opLogs().slice(-1)[0] }
  check('ⓒ 만든 뒤 바뀐 파일 ⌘Z = 거절 안내·내용 그대로(영구 삭제 0)', modRefuse.exists && modRefuse.content === 'changed after create\n' && modRefuse.last?.code === 'modified', modRefuse)
  // ⓒ 되돌릴 자리에 다른 것이 생김 → 덮어쓰기 0
  fs.writeFileSync(abs('src/l592-sq.ts'), 'mine\n')
  await until(() => hasRow('src/l592-sq.ts'), { label: '덮어쓰기 칸 행' })
  await renameVia('src/l592-sq.ts', 'l592-sq-o.ts')
  fs.writeFileSync(abs('src/l592-sq.ts'), 'squatter\n')
  await sleep(500)
  await undo()
  await sleep(1200)
  const squat = { squatter: fs.readFileSync(abs('src/l592-sq.ts'), 'utf8'), moved: exists('src/l592-sq-o.ts'), last: opLogs().slice(-1)[0], toasts: await toasts() }
  check('ⓒ 되돌릴 자리에 다른 항목 = 거절·덮어쓰기 0', squat.squatter === 'squatter\n' && squat.moved && squat.last?.ok === false, squat)
  // ⓓ 새 조작이 다시 실행 기록을 비운다
  await createVia(async () => { await focusRow('src'); await clickUntil('[data-explorer-new-file]') }, { name: 'l592-u-r1.ts', expectRel: 'src/l592-u-r1.ts' })
  await undo()
  await settle(() => !exists('src/l592-u-r1.ts'), 'r1 되돌림')
  noteTrash('src/l592-u-r1.ts', '⌘Z(만들기 되돌림)')
  await createVia(async () => { await focusRow('src'); await clickUntil('[data-explorer-new-file]') }, { name: 'l592-u-r2.ts', expectRel: 'src/l592-u-r2.ts' })
  let before = snap()
  await redo()
  await sleep(900)
  check('ⓓ 새 조작 뒤 ⌘⇧Z 무동작(다시 실행 기록 비움)', same(diff(before, snap())) && !exists('src/l592-u-r1.ts'), diff(before, snap()))
  // ⓓ worktree 별 · 전환 왕복 유지
  const { real, wt2 } = await openSecondWorktree()
  await selectWorktree(wt2)
  const wtBefore = snap()
  const wt2Before = snap(wt2)
  await expand('src')
  await focusRow('src')
  await key('Z', ['meta'])
  await sleep(900)
  check('ⓓ 다른 worktree 의 ⌘Z 는 이 worktree 기록을 건드리지 않음', same(diff(wtBefore, snap())) && same(diff(wt2Before, snap(wt2))), { repo: diff(wtBefore, snap()), wt2: diff(wt2Before, snap(wt2)) })
  await selectWorktree(real)
  await expand('src')
  await undo()
  const kept = await settle(() => !exists('src/l592-u-r2.ts'), '전환 왕복 뒤 ⌘Z')
  noteTrash('src/l592-u-r2.ts', '전환 왕복 뒤 ⌘Z(만들기 되돌림)')
  check('ⓓ worktree 전환 왕복 뒤 기록 유지(⌘Z = 직전 만들기 되돌림)', kept, null)
  // ⓔ 실행 취소도 가둠을 거친다 — 만든 폴더를 밖 링크로 바꿔 두고 ⌘Z → 거절·밖 무변경
  await createVia(async () => { await focusRow('src'); await clickUntil('[data-explorer-new-folder]') }, { name: 'l592-u-esc', expectRel: 'src/l592-u-esc' })
  fs.mkdirSync(path.join(outside, 'l592-esc-target'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'l592-esc-target/keep.txt'), 'keep\n')
  const outBefore = snap(outside)
  fs.renameSync(abs('src/l592-u-esc'), abs('src/l592-u-esc.moved'))
  fs.symlinkSync(path.join(outside, 'l592-esc-target'), abs('src/l592-u-esc'))
  await sleep(600)
  await undo()
  await sleep(1200)
  const esc = { link: fs.lstatSync(abs('src/l592-u-esc')).isSymbolicLink(), outside: diff(outBefore, snap(outside)), last: opLogs().slice(-1)[0] }
  check('ⓔ 실행 취소도 가둠(만든 폴더 자리가 밖 링크 = 거절·밖 무변경)', esc.link && same(esc.outside) && esc.last?.ok === false, esc)
  fs.unlinkSync(abs('src/l592-u-esc'))
  fs.renameSync(abs('src/l592-u-esc.moved'), abs('src/l592-u-esc'))
  before = null
}

/** E5ⓑ ⌘Z·⌘⇧Z 포커스별 표. 탐색기 기록에 「만들기」 하나를 쌓아 두고, 각 포커스에서 ⌘Z·⌘⇧Z 가 그것을 건드리는지·그 대상에 무엇이 일어나는지. */
cases.e5b = async () => {
  await expand('src')
  const paneId = await terminalPane()
  await exposeMonaco(root)
  await openFixed('src/l592-a.ts')
  await createVia(async () => { await focusRow('src'); await clickUntil('[data-explorer-new-file]') }, { name: 'l592-focus.ts', expectRel: 'src/l592-focus.ts' })
  await q(`(() => { window.__l592k = []; window.addEventListener('keydown', (e) => { if (e.metaKey && (e.key === 'z' || e.key === 'Z')) setTimeout(() => window.__l592k.push({ shift: e.shiftKey, prevented: e.defaultPrevented, target: (e.target?.className || e.target?.tagName || '').toString().slice(0, 60) }), 0) }, { capture: true }); return true })()`)
  const table = []
  const run = async (label, focus, observe, expectFn) => {
    await focus()
    const focusOk = await q(`document.activeElement?.tagName + '.' + String(document.activeElement?.className ?? '').slice(0, 60)`)
    const s0 = snap()
    const o0 = await observe()
    await q(`(window.__l592k = [], true)`)
    const logs0 = opLogs().length
    await key('Z', ['meta'])
    await sleep(500)
    const o1 = await observe()
    const s1 = snap()
    await key('Z', ['meta', 'shift'])
    await sleep(500)
    const o2 = await observe()
    const s2 = snap()
    const rowData = { label, focus: focusOk, keys: await q(`window.__l592k`), explorerOps: opLogs().slice(logs0).map((x) => `${x.op}:${x.ok}`), undoDiff: diff(s0, s1), redoDiff: diff(s1, s2), o0, o1, o2 }
    table.push(rowData)
    log(`focus ${label}`, rowData)
    check(`ⓑ ${label}`, expectFn(rowData), rowData)
  }
  const explorerUntouched = (x) => same(x.undoDiff) && same(x.redoDiff) && x.explorerOps.length === 0
  // 1 Monaco — 편집 실행 취소만
  await run('Monaco 편집기 → 편집 실행 취소만(탐색기 기록 무변화)', async () => {
    await clickUntil('[data-main-tab="file:src/l592-a.ts"]')
    await until(() => q(`document.querySelector('[data-file-view="src/l592-a.ts"] .view-lines')?.getBoundingClientRect().width > 0`), { label: 'a 보임' })
    await editorFocus('src/l592-a.ts')
    await type('MON')
    await sleep(200)
  }, async () => (await modelOf('src/l592-a.ts')).value.slice(0, 40), (x) => explorerUntouched(x) && x.o0.includes('MON') && !x.o1.includes('MON') && x.o2.includes('MON'))
  // 2 터미널 — PTY 바이트 0 (양성 대조: 같은 캡처에 글자 하나)
  await ptyCaptureStart(paneId)
  await run('터미널 → PTY 바이트 0·탐색기 기록 무변화(⌘⇧Z = 기존 pane 줌)', async () => termFocus(paneId), async () => ({ pty: ptyBytes(), zoomed: await q(`document.querySelector('[data-term-zoomed], .is-zoomed') !== null`) }), (x) => explorerUntouched(x) && x.o1.pty === x.o0.pty && x.o2.pty === x.o0.pty)
  if (await q(`document.querySelector('[data-term-zoomed], .is-zoomed') !== null`)) await key('Z', ['meta', 'shift'])
  await termFocus(paneId)
  await key('Shift')
  await ctl(root, { cmd: 'type', text: 'x' })
  await until(() => Promise.resolve((ptyBytes() ?? '').includes('x')), { timeoutMs: 3000, label: 'pty 양성' }).catch(() => null)
  const positive = ptyBytes()
  await ptyCaptureStop(paneId)
  check('ⓑ 터미널 PTY 캡처 양성 대조(글자 x 는 잡힌다)', typeof positive === 'string' && positive.includes('x'), { positive })
  // 3 인라인 입력 — 입력칸 글자 실행 취소(CDP undo 명령 = 네이티브 키 바인딩 경로 흉내)
  const inputCase = async (label, open, selector) => {
    await open()
    await until(() => q(`document.activeElement?.matches(${JSON.stringify(selector)}) === true`), { label: `${label} 포커스` })
    await type('abc')
    await sleep(150)
    const s0 = snap()
    await q(`(window.__l592k = [], true)`)
    const logs0 = opLogs().length
    await key('Z', ['meta'])
    await sleep(300)
    const viaSend = await q(`document.activeElement?.value ?? null`)
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 4, commands: ['undo'] })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 4 })
    await sleep(300)
    const afterUndo = await q(`document.activeElement?.value ?? null`)
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 12, commands: ['redo'] })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 12 })
    await sleep(300)
    const afterRedo = await q(`document.activeElement?.value ?? null`)
    const rowData = { label, viaSendInputEvent: viaSend, afterUndo, afterRedo, keys: await q(`window.__l592k`), explorerOps: opLogs().slice(logs0).map((x) => `${x.op}:${x.ok}`), diff: diff(s0, snap()) }
    table.push(rowData)
    log(`focus ${label}`, rowData)
    // ⌘⇧Z 는 기록만 — 팔레트·설정 입력칸에선 기존 전역 terminal.zoom(Mod+Shift+Z — 기준 91255e55f 와 같은 결합·같은 경로)이 가져간다. 인라인 입력 행은 data-inline-rename 양보로 입력칸 몫.
    rowData.redoOutcome = afterRedo.endsWith('abc') ? '입력칸 다시 실행' : rowData.keys.some((k) => k.shift && k.prevented) ? '기존 전역 terminal.zoom 이 가져감(기준과 같음)' : '변화 없음'
    check(`ⓑ ${label} → ⌘Z = 그 입력의 글자 실행 취소(가로채지 않음·탐색기 기록 무변화) · ⌘⇧Z 기록`, same(rowData.diff) && rowData.explorerOps.length === 0 && rowData.keys.filter((k) => !k.shift).every((k) => !k.prevented) && typeof afterUndo === 'string' && !afterUndo.endsWith('abc') && afterUndo.length < 'abc'.length + 1, rowData)
    await key('Escape')
    await sleep(300)
  }
  await inputCase('인라인 입력 행', async () => { await focusRow('src'); await clickUntil('[data-explorer-new-file]') }, '[data-explorer-input]')
  await inputCase('커맨드 팔레트', async () => { await click('[data-main-tab="file:src/l592-a.ts"]'); await key('K', ['meta']) }, 'input[role="combobox"]')
  await inputCase('설정 입력칸', async () => { await key(',', ['meta']); await until(() => q(`document.querySelector('[data-settings-search]') !== null`), { label: '설정' }); await clickUntil('[data-settings-search]') }, '[data-settings-search]')
  await key('Escape')
  await sleep(300)
  // 4 탭바·사이드바 포커스 — 기록(설계: 탐색기 표지는 트리 활성일 때만 → 탭바·사이드바의 ⌘Z 는 탐색기 기록 무변화)
  await run('탭바 포커스 → 탐색기 기록 무변화(기록)', async () => {
    await click('[data-main-tab="file:src/l592-a.ts"]')
    await q(`(document.querySelector('[data-main-tab="file:src/l592-a.ts"]')?.focus(), true)`)
  }, async () => null, (x) => explorerUntouched(x))
  await run('사이드바 포커스 → 탐색기 기록 무변화(기록)', async () => {
    const card = await q(`document.querySelector('[data-worktree]')?.dataset.worktree ?? null`)
    await q(`(document.querySelector('[data-worktree="${card}"] [data-worktree-card-surface]') ?? document.querySelector('[data-worktree="${card}"]'))?.focus?.()`)
    await q(`(() => { const el = document.querySelector('[data-worktree] [tabindex], [data-worktree] button'); el?.focus(); return document.activeElement?.closest('[data-worktree]') !== null })()`)
  }, async () => null, (x) => explorerUntouched(x))
  // 5 탐색기 트리 — 기록(⌘Z = 만들기 되돌림 · ⌘⇧Z = 다시 만들기)
  await run('탐색기 트리 → 탐색기 기록(⌘Z 되돌림·⌘⇧Z 다시)', async () => focusRow('src'), async () => exists('src/l592-focus.ts'), (x) => x.o0 === true && x.o1 === false && x.o2 === true && x.keys.length === 0)
  noteTrash('src/l592-focus.ts', '트리 ⌘Z(만들기 되돌림)')
  // Edit 메뉴 role 무회귀 — 메뉴 구조(복사·붙여넣기·실행 취소 role·가속키). 실행은 시스템 클립보드 쓰기 금지(G5)라 하지 않는다 — E12 몫
  const menu = await ctl(root, { cmd: 'menu-dump' })
  const edit = JSON.stringify(menu.menu ?? menu).match(/"role":"(undo|redo|cut|copy|paste|selectAll|selectall|pasteAndMatchStyle)"/gi) ?? []
  log('edit-menu', { roles: edit })
  check('ⓑ Edit 메뉴 role(실행 취소·다시 실행·잘라내기·복사·붙여넣기·모두 선택) 그대로 — 실행은 클립보드 쓰기 금지로 생략(E12)', ['undo', 'redo', 'cut', 'copy', 'paste'].every((r) => edit.some((x) => x.toLowerCase().includes(`"${r}"`))), { edit })
  current.metrics = { focusTable: table.map((x) => ({ label: x.label, explorerOps: x.explorerOps, prevented: (x.keys ?? []).map((k) => k.prevented) })) }
}

// --- E6 ------------------------------------------------------------------------------------------------
cases.e6 = async () => {
  await expand('src')
  // ⓐ 폴더 행에 놓기 — 강조 · 이동 · ⓕ 디스크 대조
  let s0 = snap()
  const marks = await dragRow(row('src/l592-a.ts'), await center(row('docs')))
  await settle(() => exists('docs/l592-a.ts'), '폴더 행 놓기')
  let d = diff(s0, snap())
  check('ⓐ 폴더 행 놓기 = 이동(같은 inode)·강조·끄는 원본 표지', eqSet(d.added, ['docs/l592-a.ts']) && eqSet(d.removed, ['src/l592-a.ts']) && snap()['docs/l592-a.ts'].ino === s0['src/l592-a.ts'].ino && marks.target.includes('docs') && marks.source === 'src/l592-a.ts' && marks.dragging, { marks, d })
  // ⓐ 루트(빈 영역) 놓기
  s0 = snap()
  const sr = await rect('.explorer-scroll')
  const rootMarks = await dragRow(row('src/l592-b.ts'), { x: sr.left + 60, y: sr.top + sr.height - 14 })
  await settle(() => exists('l592-b.ts'), '루트 놓기')
  d = diff(s0, snap())
  check('ⓐ 빈 영역 = 루트로 이동·루트 강조', eqSet(d.added, ['l592-b.ts']) && eqSet(d.removed, ['src/l592-b.ts']) && rootMarks.root === true, { rootMarks, d })
  // ⓐ Esc 끌기 취소
  s0 = snap()
  const escMarks = await dragRow(row('l592-b.ts'), await center(row('src')), { release: false })
  await key('Escape')
  await sleep(200)
  const afterEsc = await q(`({ dragging: document.querySelector('.explorer-scroll.is-dragging') !== null, target: document.querySelectorAll('.explorer-row.is-drop-target').length })`)
  await mouse('mouseUp', await center(row('src')))
  await sleep(500)
  check('ⓐ Esc = 끌기 취소(표지 사라짐·놓아도 이동 0)', escMarks.dragging && !afterEsc.dragging && afterEsc.target === 0 && same(diff(s0, snap())), { escMarks, afterEsc })
  // ⓑ 자기 자신·하위 거절 · 같은 부모 무동작 · 충돌 덮어쓰기 0
  s0 = snap()
  const self = await dragRow(row('src'), await center(row('src/sub')))
  await sleep(500)
  check('ⓑ 자기 하위로 = 놓을 수 없음 표시·이동 0', self.target.length === 0 && same(diff(s0, snap())), self)
  const sameParent = await dragRow(row('docs/l592-readme.md'), await center(row('docs/l592-a.ts')))
  await sleep(500)
  check('ⓑ 같은 부모(파일 행 = 그 부모 docs) = 무동작', same(diff(s0, snap())), sameParent)
  fs.writeFileSync(abs('docs/l592-b.ts'), 'other b\n')
  await until(() => hasRow('docs/l592-b.ts'), { label: '충돌 행' })
  s0 = snap()
  await dragRow(row('l592-b.ts'), await center(row('docs')))
  await sleep(900)
  check('ⓑ 충돌(대상에 같은 이름) = 안내·덮어쓰기 0', same(diff(s0, snap())) && opLogs().slice(-1)[0]?.code === 'exists', { last: opLogs().slice(-1)[0], toasts: await toasts() })
  // ⓒ 확인 대화상자 없음 · 끌기 문턱 — 작은 움직임은 클릭(미리보기)·더블클릭(고정)
  const stubbed = (await stub([])).asked
  check('ⓒ 이동 확인 대화상자 없음(Q4)', JSON.stringify(stubbed) === '[]' || stubbed === undefined, { stubbed })
  s0 = snap()
  const c = await center(row('docs/l592-readme.md'))
  await mouse('mouseDown', c)
  await mouse('mouseMove', { x: c.x + 4, y: c.y + 3 })
  const small = await q(`document.querySelector('.explorer-scroll.is-dragging') !== null`)
  await mouse('mouseUp', { x: c.x + 4, y: c.y + 3 })
  await until(() => tab('docs/l592-readme.md'), { label: '작은 움직임 = 클릭' })
  await ctl(root, { cmd: 'dblclick', selector: row('docs/l592-readme.md') })
  await until(async () => (await tab('docs/l592-readme.md'))?.preview === 'false', { label: '더블클릭 고정' })
  check('ⓒ 문턱(6 px) 아래 움직임 = 클릭(미리보기)·더블클릭 고정·이동 0', small === false && same(diff(s0, snap())), { small, threshold: 6 })
  // ⓓ 머무름 펼침 — 접힌 폴더 위 500 ms
  fs.mkdirSync(abs('l592-hover/inner'), { recursive: true })
  fs.writeFileSync(abs('l592-hover/inner/h.txt'), 'h\n')
  await until(() => hasRow('l592-hover'), { label: '머무름 폴더' })
  const hoverBefore = await expanded('l592-hover')
  await dragRow(row('docs/l592-readme.md'), await center(row('l592-hover')), { hold: 900, release: false })
  const hoverAfter = await expanded('l592-hover')
  await key('Escape')
  await mouse('mouseUp', await center(row('l592-hover')))
  check('ⓓ 접힌 폴더 위에 머무르면 펼침(500 ms)', hoverBefore === 'false' && hoverAfter === 'true', { hoverBefore, hoverAfter })
  // ⓓ 가장자리 스크롤 — 행이 많을 때 아래 가장자리에 머무름
  fs.mkdirSync(abs('l592-many'))
  for (let i = 0; i < 80; i += 1) fs.writeFileSync(abs(`l592-many/f${String(i).padStart(2, '0')}.txt`), `${i}\n`)
  await until(() => hasRow('l592-many'), { label: '많은 폴더' })
  await expand('l592-many')
  await q(`(document.querySelector('.explorer-scroll').scrollTop = 0, true)`)
  await sleep(200)
  const sr2 = await rect('.explorer-scroll')
  const top0 = await q(`document.querySelector('.explorer-scroll').scrollTop`)
  await dragRow(row('docs'), { x: sr2.left + 60, y: sr2.top + sr2.height - 6 }, { hold: 1200, release: false })
  const top1 = await q(`document.querySelector('.explorer-scroll').scrollTop`)
  await key('Escape')
  await mouse('mouseUp', { x: sr2.left + 60, y: sr2.top + sr2.height - 6 })
  check('ⓓ 아래 가장자리 머무름 = 스크롤', top1 > top0, { top0, top1, band: 22 })
  // ⓔ 탭 끌기 무회귀(탭 순서 바꾸기) — 80개 행 폴더를 접어 src 를 화면 안으로
  await q(`(document.querySelector('.explorer-scroll').scrollTop = 0, true)`)
  await sleep(200)
  await focusRow('l592-many')
  await key('Left')
  await until(async () => (await expanded('l592-many')) === 'false', { label: '많은 폴더 접기' })
  await expand('src')
  await openFixed('src/sub/l592-c.md').catch(async () => { await expand('src/sub'); await openFixed('src/sub/l592-c.md') })
  await openFixed('l592-top.txt')
  const order0 = await q(`[...document.querySelectorAll('[data-main-tab]')].map((e) => e.dataset.mainTab)`)
  const a = await center('[data-main-tab="file:l592-top.txt"]')
  const b0 = await rect(`[data-main-tab="${order0[0]}"]`)
  await mouse('mouseDown', a)
  for (let i = 1; i <= 8; i += 1) {
    await mouse('mouseMove', { x: a.x + ((b0.left + 4 - a.x) * i) / 8, y: a.y })
    await sleep(40)
  }
  await mouse('mouseUp', { x: b0.left + 4, y: a.y })
  await sleep(500)
  const order1 = await q(`[...document.querySelectorAll('[data-main-tab]')].map((e) => e.dataset.mainTab)`)
  s0 = snap()
  check('ⓔ 탭 끌기 = 탭 순서 바뀜(탐색기 이동 0)', JSON.stringify(order0) !== JSON.stringify(order1) && order1.indexOf('file:l592-top.txt') < order0.indexOf('file:l592-top.txt') && same(diff(s0, snap())), { order0, order1 })
  // ⓔ 사이드바 카드 끌기 — 탐색기 위로 끌어 놓아도 탐색기 조작 0
  const logs0 = opLogs().length
  s0 = snap()
  const card = await center('[data-worktree]')
  const treeAt = await center(row('docs'))
  await mouse('mouseDown', card)
  for (let i = 1; i <= 8; i += 1) {
    await mouse('mouseMove', { x: card.x + ((treeAt.x - card.x) * i) / 8, y: card.y + ((treeAt.y - card.y) * i) / 8 })
    await sleep(40)
  }
  const cardMarks = await q(`({ explorerDragging: document.querySelector('.explorer-scroll.is-dragging') !== null, target: document.querySelectorAll('.explorer-row.is-drop-target').length })`)
  await mouse('mouseUp', treeAt)
  await sleep(500)
  check('ⓔ 사이드바 카드 끌기 = 탐색기 끌기 표지 0·조작 0', !cardMarks.explorerDragging && cardMarks.target === 0 && opLogs().length === logs0 && same(diff(s0, snap())), cardMarks)
  // ⓕ 이동 뒤 탭 따라감 — 열린 탭 파일을 끌어 옮김
  await openFixed('docs/l592-a.ts')
  await dragRow(row('docs/l592-a.ts'), await center(row('src')))
  await settle(() => exists('src/l592-a.ts'), '탭 파일 이동')
  await until(() => tab('src/l592-a.ts'), { label: '탭 따라감' })
  check('ⓕ 이동 뒤 탭 따라감·디스크 대조', (await tab('docs/l592-a.ts')) === null && exists('src/l592-a.ts') && !exists('docs/l592-a.ts'), null)
}

// --- E7 ------------------------------------------------------------------------------------------------
cases.e7 = async () => {
  await expand('src')
  const src = path.join(root, 'l592-src')
  fs.mkdirSync(path.join(src, 'l592-pkg/deep'), { recursive: true })
  fs.writeFileSync(path.join(src, 'l592-one.txt'), 'one\n')
  fs.writeFileSync(path.join(src, 'l592-two.bin'), crypto.randomBytes(4096))
  fs.writeFileSync(path.join(src, 'l592-pkg/a.txt'), 'a\n')
  fs.writeFileSync(path.join(src, 'l592-pkg/deep/b.txt'), 'b\n')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'l592-secret.txt'), 'secret\n')
  fs.symlinkSync(path.join(outside, 'l592-secret.txt'), path.join(src, 'l592-pkg/deep/l592-leak'))
  fs.symlinkSync(path.join(outside, 'l592-secret.txt'), path.join(src, 'l592-toplink'))
  const srcSnap0 = snap(src)
  // ⓐ 여러 개(파일 둘·폴더 재귀) → 폴더 행
  let s0 = snap()
  await cdpDrop(await center(row('docs')), [path.join(src, 'l592-one.txt'), path.join(src, 'l592-two.bin'), path.join(src, 'l592-pkg')])
  await settle(() => exists('docs/l592-pkg/deep/b.txt') && exists('docs/l592-two.bin'), '가져오기')
  await sleep(500)
  let d = diff(s0, snap())
  const shaOk = sha(abs('docs/l592-two.bin')) === sha(path.join(src, 'l592-two.bin')) && sha(abs('docs/l592-pkg/deep/b.txt')) === sha(path.join(src, 'l592-pkg/deep/b.txt'))
  check('ⓐ 파일·폴더 재귀·여러 개 = 복사(내용 sha 같음)', eqSet(d.added, ['docs/l592-one.txt', 'docs/l592-two.bin', 'docs/l592-pkg', 'docs/l592-pkg/a.txt', 'docs/l592-pkg/deep', 'docs/l592-pkg/deep/b.txt']) && shaOk, d)
  check('ⓐ 원본 sha·inode·목록 무변경', same(diff(srcSnap0, snap(src))), diff(srcSnap0, snap(src)))
  check('ⓑ 폴더 안 원본 링크 = 따라가지 않음(건너뜀·밖 내용 0)', !exists('docs/l592-pkg/deep/l592-leak'), { toasts: await toasts() })
  // ⓑ 최상위 원본 링크
  s0 = snap()
  await cdpDrop(await center(row('docs')), [path.join(src, 'l592-toplink')])
  await sleep(1500)
  check('ⓑ 최상위 원본 링크 = 건너뜀·안내(밖 내용 0)', same(diff(s0, snap())), { toasts: await toasts(), last: opLogs().slice(-1)[0] })
  // ⓒ 충돌 = 새 이름(복제 이름 규칙)·덮어쓰기 0 · 빈 영역 = 루트
  s0 = snap()
  await cdpDrop(await center(row('docs')), [path.join(src, 'l592-one.txt')])
  await settle(() => exists('docs/l592-one copy.txt'), '충돌 가져오기')
  d = diff(s0, snap())
  check('ⓒ 충돌 = 「copy」 새 이름·원래 파일 무변경', eqSet(d.added, ['docs/l592-one copy.txt']) && d.changed.length === 0, d)
  s0 = snap()
  const sr = await rect('.explorer-scroll')
  await cdpDrop({ x: Math.round(sr.left + 60), y: Math.round(sr.top + sr.height - 14) }, [path.join(src, 'l592-one.txt')])
  await settle(() => exists('l592-one.txt'), '루트 가져오기')
  check('ⓐ 빈 영역 = 루트로', eqSet(diff(s0, snap()).added, ['l592-one.txt']), diff(s0, snap()))
  // ⓓ 위조 원본 — 렌더러가 만든 표지·이미 쓴 표지 = bad_token, 대상 무변경 (양성 대조: 위 실제 드롭은 성공)
  s0 = snap()
  const r0 = await ipcRoot()
  const forged = { madeUp: await ipc({ op: 'import', root: r0, dir: 'docs', token: 'l592-forged' }), notString: await ipc({ op: 'import', root: r0, dir: 'docs', token: { paths: [path.join(outside, 'l592-secret.txt')] } }), replayForged: await ipc({ op: 'import', root: r0, dir: 'docs', replay: 'l592-forged', names: ['l592-secret.txt'] }) }
  check('ⓓ 위조 원본(만든 표지·형 위반·재생 위조) = 거절·대상 무변경', forged.madeUp.code === 'bad_token' && forged.notString.code === 'bad_token' && forged.replayForged.code === 'bad_token' && same(diff(s0, snap())), forged)
  // ⓔ 큰 가져오기(≥ 5천 항목) 중 트리 스크롤·터미널 입력 · 렌더러 응답 표본
  const big = path.join(root, 'l592-big')
  fs.mkdirSync(big)
  for (let i = 0; i < 52; i += 1) {
    fs.mkdirSync(path.join(big, `d${i}`))
    for (let j = 0; j < 100; j += 1) fs.writeFileSync(path.join(big, `d${i}`, `f${j}.txt`), `${i}-${j}\n`)
  }
  // 트리를 스크롤할 수 있게 긴 폴더를 펼쳐 둔다
  fs.mkdirSync(abs('l592-long'))
  for (let i = 0; i < 80; i += 1) fs.writeFileSync(abs(`l592-long/f${String(i).padStart(2, '0')}.txt`), `${i}\n`)
  await until(() => hasRow('l592-long'), { label: '긴 폴더' })
  await expand('l592-long')
  await q(`(document.querySelector('.explorer-scroll').scrollTop = 0, true)`)
  const paneId = await terminalPane()
  await herdr(root, 'pane.send_text', { pane_id: paneId, text: 'clear\n' })
  await sleep(500)
  await cdpDrop(await center(row('docs')), [big])
  const t0 = Date.now()
  const rtts = []
  let termOk = null
  let scrolled = null
  while (Date.now() - t0 < 60_000) {
    const a = Date.now()
    await q(`1`)
    rtts.push(Date.now() - a)
    if (rtts.length === 3) {
      const before = await q(`document.querySelector('.explorer-scroll').scrollTop`)
      const at = await center('.explorer-scroll')
      await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 200 })
      await sleep(150)
      scrolled = { before, after: await q(`document.querySelector('.explorer-scroll').scrollTop`), ms: Date.now() - a }
      await herdr(root, 'pane.send_text', { pane_id: paneId, text: 'echo l592-big-$((3+4))\n' })
      const tt = Date.now()
      termOk = await until(async () => JSON.stringify((await herdr(root, 'pane.read', { pane_id: paneId, source: 'visible' }).catch(() => ({})))).includes('l592-big-7'), { timeoutMs: 10_000, label: '터미널 응답' }).then(() => Date.now() - tt, () => null)
    }
    if (exists('docs/l592-big/d51/f99.txt') && opLogs().some((r) => r.op === 'import' && r.ms > 0 && r.at > t0)) break
    await sleep(50)
  }
  const importLog = opLogs().filter((r) => r.op === 'import').slice(-1)[0]
  const count = fs.existsSync(abs('docs/l592-big')) ? fs.readdirSync(abs('docs/l592-big')).reduce((n, dname) => n + fs.readdirSync(abs(`docs/l592-big/${dname}`)).length, 0) : 0
  current.metrics = { bigItems: 52 * 100 + 52, copied: count, importMs: importLog?.ms ?? null, rttMax: Math.max(...rtts), rttP95: pct(rtts, 95), samples: rtts.length, scrolled, termEchoMs: termOk }
  check('ⓔ 5천 항목 이상 가져오기 중 렌더러 응답(eval 왕복 p95 < 200 ms)·트리 스크롤·터미널 입력', count === 5200 && pct(rtts, 95) < 200 && scrolled !== null && scrolled.after > scrolled.before && termOk !== null, current.metrics)
  // ⓔ 도중 실패 — 읽을 수 없는 원본 파일 → 무엇이 복사됐는지 안내
  const part = path.join(root, 'l592-part')
  fs.mkdirSync(part)
  fs.writeFileSync(path.join(part, 'ok.txt'), 'ok\n')
  fs.writeFileSync(path.join(part, 'locked.txt'), 'locked\n')
  fs.chmodSync(path.join(part, 'locked.txt'), 0o000)
  await q(`(document.querySelector('.explorer-scroll').scrollTop = 0, true)`)
  await sleep(300)
  try {
    s0 = snap()
    await cdpDrop(await center(row('docs')), [part])
    await settle(() => exists('docs/l592-part/ok.txt'), '부분 가져오기')
    await sleep(1200)
    const shown = await toasts()
    check('ⓔ 도중 실패(권한 없는 원본) = 된 것은 남고 실패 항목 안내', exists('docs/l592-part/ok.txt') && shown.some((t) => t.includes('locked.txt')), { shown, added: diff(s0, snap()).added })
  } finally {
    fs.chmodSync(path.join(part, 'locked.txt'), 0o644)
  }
  // ⓕ 터미널 pane 파일 드롭(경로 붙여넣기) 무회귀 · 밖 놓기 무동작(창 이탈 0)
  await click('.main-tab:not(.main-tab-file)').catch(() => null)
  await sleep(500)
  await herdr(root, 'pane.send_text', { pane_id: paneId, text: '\x15' })
  s0 = snap()
  const termAt = await center(`[data-term-pane-box="${paneId}"]`)
  await cdpDrop(termAt, [path.join(src, 'l592-one.txt')])
  const pasted = await until(async () => JSON.stringify(await herdr(root, 'pane.read', { pane_id: paneId, source: 'visible' }).catch(() => ({}))).includes('l592-one.txt'), { timeoutMs: 5000, label: '터미널 드롭' }).then(() => true, () => false)
  await herdr(root, 'pane.send_text', { pane_id: paneId, text: '\x15' })
  check('ⓕ 터미널 pane 파일 드롭 = 경로 붙여넣기(탐색기 조작 0)', pasted && same(diff(s0, snap())), { pasted })
  const href0 = await q(`location.href`)
  const sideAt = await center('[data-worktree]')
  await cdpDrop(sideAt, [path.join(src, 'l592-one.txt')])
  await sleep(1200)
  check('ⓕ 탐색기·터미널 밖 놓기 = 무동작(창 이탈 0·디스크 무변경)', (await q(`location.href`)) === href0 && same(diff(s0, snap())), { href0 })
}

// --- E8 ------------------------------------------------------------------------------------------------
cases.e8 = async () => {
  await expand('src')
  let s0 = snap()
  await rowMenu('src/l592-a.ts', 'duplicate')
  await settle(() => exists('src/l592-a copy.ts'), '복제 1')
  await rowMenu('src/l592-a.ts', 'duplicate')
  await settle(() => exists('src/l592-a copy 2.ts'), '복제 2')
  let d = diff(s0, snap())
  const sel = await selectedRow()
  check('ⓐ 파일 복제 = 「l592-a copy.ts」·「copy 2」·sha 같음·새 inode', eqSet(d.added, ['src/l592-a copy.ts', 'src/l592-a copy 2.ts']) && sha(abs('src/l592-a copy.ts')) === sha(abs('src/l592-a.ts')) && snap()['src/l592-a copy.ts'].ino !== s0['src/l592-a.ts'].ino, d)
  check('ⓑ 복제 뒤 새 항목 선택·이름 변경 입력 없음(기록)', sel === 'src/l592-a copy 2.ts' && !(await inputOpen()), { sel })
  s0 = snap()
  await rowMenu('src/sub', 'duplicate')
  await settle(() => exists('src/sub copy/l592-c.md'), '폴더 복제')
  d = diff(s0, snap())
  check('ⓐ 폴더 복제(재귀) = 「sub copy」', eqSet(d.added, ['src/sub copy', 'src/sub copy/l592-c.md']), d)
  // 확장자 없음·점 파일
  fs.writeFileSync(abs('l592-noext'), 'n\n')
  await until(() => hasRow('l592-noext'), { label: '확장자 없음 행' })
  await rowMenu('l592-noext', 'duplicate')
  const noext = await settle(() => exists('l592-noext copy'), '확장자 없음 복제')
  check('ⓐ 확장자 없는 이름 = 「l592-noext copy」', noext, { listing: fs.readdirSync(repo) })
  // ⓒ 링크 = 링크로 · 하드링크 기록
  fs.symlinkSync('src/l592-b.ts', abs('l592-ln'))
  fs.linkSync(abs('l592-top.txt'), abs('l592-hard.txt'))
  await until(() => hasRow('l592-hard.txt'), { label: '링크 행' })
  await rowMenu('l592-ln', 'duplicate')
  await settle(() => exists('l592-ln copy'), '링크 복제')
  const lnCopy = fs.lstatSync(abs('l592-ln copy'))
  check('ⓒ 링크 복제 = 같은 글의 링크', lnCopy.isSymbolicLink() && fs.readlinkSync(abs('l592-ln copy')) === 'src/l592-b.ts', { link: lnCopy.isSymbolicLink() ? fs.readlinkSync(abs('l592-ln copy')) : null })
  await rowMenu('l592-hard.txt', 'duplicate')
  await settle(() => exists('l592-hard copy.txt'), '하드링크 복제')
  const hard = { nlinkSrc: fs.statSync(abs('l592-hard.txt')).nlink, copyIno: fs.statSync(abs('l592-hard copy.txt')).ino, srcIno: fs.statSync(abs('l592-hard.txt')).ino, copyNlink: fs.statSync(abs('l592-hard copy.txt')).nlink }
  check('ⓒ 하드링크(nlink 2) 복제 = 내용 복사(새 inode·nlink 1) — 기록', hard.copyIno !== hard.srcIno && hard.copyNlink === 1 && sha(abs('l592-hard copy.txt')) === sha(abs('l592-hard.txt')), hard)
}

// --- E9ⓒ 양성 대조 — 실제 창 → preload → ipcMain(window.corral.explorerOp) -----------------------------
cases.e9 = async () => {
  const r0 = await ipcRoot()
  fs.mkdirSync(path.join(outside, 'l592-odir/sub'), { recursive: true })
  fs.writeFileSync(path.join(outside, 'l592-ofile.txt'), 'outside\n')
  fs.writeFileSync(path.join(outside, 'l592-odir/sub/x.txt'), 'x\n')
  fs.symlinkSync(path.join(outside, 'l592-odir'), abs('l592-olink'))
  fs.symlinkSync(path.join(outside, 'l592-ofile.txt'), abs('l592-ofile-link'))
  fs.mkdirSync(abs('l592-in/deep'), { recursive: true })
  fs.writeFileSync(abs('l592-in/f.txt'), 'f\n')
  const outSnap = () => snap(outside)
  const out0 = outSnap()
  const otherRoot = path.join(root, 'l592-notroot')
  fs.mkdirSync(otherRoot, { recursive: true })
  const matrix = []
  const call = async (family, kase, input, want) => {
    const res = await ipc({ root: r0, ...input })
    const ok = typeof want === 'function' ? want(res) : want.includes(res.ok ? 'ok' : res.code)
    matrix.push({ family, kase, input: { ...input, root: input.root === undefined ? '<root>' : input.root }, result: { ok: res.ok, code: res.code ?? null, done: res.done ?? null }, want: typeof want === 'function' ? 'fn' : want, pass: ok })
    return res
  }
  const families = [
    { name: '생성 파일', make: (dir, name = 'l592-n.txt') => ({ op: 'create', dir, name, kind: 'file' }) },
    { name: '생성 폴더', make: (dir, name = 'l592-nd') => ({ op: 'create', dir, name, kind: 'dir' }) },
  ]
  for (const f of families) {
    await call(f.name, '① 안 경로', f.make('l592-in'), ['ok'])
    await call(f.name, '② .. 탈출', f.make('../outside'), ['outside_root', 'invalid_argument'])
    await call(f.name, '③ 절대 밖', f.make(outside), ['invalid_argument', 'outside_root'])
    await call(f.name, '④ 마지막 성분 밖 링크', f.make('l592-olink'), ['outside_root'])
    await call(f.name, '⑤ 중간 폴더 밖 링크', f.make('l592-olink/sub'), ['outside_root'])
    await call(f.name, '⑥ 등록 안 된 루트', { ...f.make(''), root: otherRoot }, ['not_worktree'])
    await call(f.name, '⑦ 형 위반', { ...f.make(''), dir: 42 }, ['invalid_argument'])
    await call(f.name, '⑧ .git', f.make('.git'), ['protected'])
    await call(f.name, '⑧ .GIT 성분 이름', f.make('', '.GIT'), ['protected', 'invalid_name'])
    await call(f.name, '⑨ NUL', f.make('', 'l592\u0000x'), ['invalid_name', 'invalid_argument'])
    await call(f.name, '⑨ .. 성분', f.make('', 'l592-x/../../y'), ['invalid_name'])
    await call(f.name, '⑨ / 끝', f.make('', 'l592-x/'), ['invalid_name'])
  }
  // 이동 원본
  const mv = (from, to) => ({ op: 'move', from, to })
  fs.writeFileSync(abs('l592-in/m.txt'), 'm\n')
  await call('이동 원본', '① 안 경로', mv('l592-in/m.txt', 'l592-in/deep/m.txt'), ['ok'])
  await call('이동 원본', '② .. 탈출', mv('../outside/l592-ofile.txt', 'l592-in/x.txt'), ['outside_root', 'invalid_argument'])
  await call('이동 원본', '③ 절대 밖', mv(path.join(outside, 'l592-ofile.txt'), 'l592-in/x.txt'), ['invalid_argument', 'outside_root'])
  await call('이동 원본', '④ 마지막 성분 = 밖 링크(링크 자체를 옮김 — 밖 무변경)', mv('l592-ofile-link', 'l592-in/l592-ofile-link'), (r) => r.ok === true && fs.lstatSync(abs('l592-in/l592-ofile-link')).isSymbolicLink())
  await call('이동 원본', '⑤ 중간 폴더 밖 링크', mv('l592-olink/sub/x.txt', 'l592-in/x.txt'), ['outside_root'])
  await call('이동 원본', '⑥ 등록 안 된 루트', { ...mv('a', 'b'), root: otherRoot }, ['not_worktree'])
  await call('이동 원본', '⑦ 형 위반', { op: 'move', from: 7, to: 'x' }, ['invalid_argument'])
  await call('이동 원본', '⑧ 루트 자체', mv('', 'l592-in/r'), ['protected', 'invalid_argument'])
  await call('이동 원본', '⑧ .git', mv('.git', 'l592-in/g'), ['protected'])
  await call('이동 원본', '⑨ NUL', mv('l592-in/f\u0000.txt', 'l592-in/x.txt'), ['invalid_argument', 'invalid_name'])
  // 이동 대상
  await call('이동 대상', '① 안 경로', mv('l592-in/deep/m.txt', 'l592-in/m.txt'), ['ok'])
  await call('이동 대상', '② .. 탈출', mv('l592-in/m.txt', '../outside/l592-m.txt'), ['outside_root', 'invalid_argument'])
  await call('이동 대상', '③ 절대 밖', mv('l592-in/m.txt', path.join(outside, 'l592-m.txt')), ['invalid_argument', 'outside_root'])
  await call('이동 대상', '④ 대상 폴더 = 밖 링크', mv('l592-in/m.txt', 'l592-olink/l592-m.txt'), ['outside_root'])
  await call('이동 대상', '⑤ 중간 폴더 밖 링크', mv('l592-in/m.txt', 'l592-olink/sub/l592-m.txt'), ['outside_root'])
  await call('이동 대상', '⑧ .git 안', mv('l592-in/m.txt', '.git/l592-m.txt'), ['protected'])
  await call('이동 대상', '⑧ .GIT 이름', mv('l592-in/m.txt', '.GIT'), ['protected', 'invalid_name'])
  await call('이동 대상', '⑨ .. 성분', mv('l592-in/m.txt', 'l592-in/../../x'), ['invalid_argument', 'invalid_name', 'outside_root'])
  await call('이동 대상', '⑨ / 끝', mv('l592-in/m.txt', 'l592-in/x/'), ['invalid_argument', 'invalid_name'])
  await call('이동 대상', '덮어쓰기 0(있는 대상)', mv('l592-in/m.txt', 'l592-in/f.txt'), ['exists'])
  // 휴지통
  const tr = (rel) => ({ op: 'trash', rel, snapshot: true })
  fs.writeFileSync(abs('l592-in/l592-t.txt'), 'trash me\n')
  const trashed = await call('휴지통', '① 안 경로', tr('l592-in/l592-t.txt'), ['ok'])
  noteTrash('l592-in/l592-t.txt', 'E9 휴지통 ① (IPC — 실제 창 경로)')
  await call('휴지통', '② .. 탈출', tr('../outside/l592-ofile.txt'), ['outside_root', 'invalid_argument'])
  await call('휴지통', '③ 절대 밖', tr(path.join(outside, 'l592-ofile.txt')), ['invalid_argument', 'outside_root'])
  await call('휴지통', '⑤ 중간 폴더 밖 링크', tr('l592-olink/sub/x.txt'), ['outside_root'])
  await call('휴지통', '⑥ 등록 안 된 루트', { ...tr('a'), root: otherRoot }, ['not_worktree'])
  await call('휴지통', '⑦ 형 위반', { op: 'trash', rel: ['x'] }, ['invalid_argument'])
  await call('휴지통', '⑧ 루트', tr(''), ['protected'])
  await call('휴지통', '⑧ .git', tr('.git'), ['protected'])
  await call('휴지통', '⑨ NUL', tr('l592\u0000'), ['invalid_argument', 'invalid_name'])
  // 되살리기
  const rs = (rel, snapshotId) => ({ op: 'restore', rel, snapshotId })
  const sid = trashed.snapshotId
  await call('되살리기', '② .. 탈출', rs('../outside/l592-t.txt', sid), ['outside_root', 'invalid_argument'])
  await call('되살리기', '③ 절대 밖', rs(path.join(outside, 'l592-t.txt'), sid), ['invalid_argument', 'outside_root'])
  await call('되살리기', '④ 대상 폴더 = 밖 링크', rs('l592-olink/l592-t.txt', sid), ['outside_root', 'invalid_argument'])
  await call('되살리기', '⑤ 중간 폴더 밖 링크', rs('l592-olink/sub/l592-t.txt', sid), ['outside_root', 'invalid_argument'])
  await call('되살리기', '⑥ 등록 안 된 루트', { ...rs('l592-in/l592-t.txt', sid), root: otherRoot }, ['not_worktree'])
  await call('되살리기', '⑦ 형 위반', { op: 'restore', rel: 'l592-in/l592-t.txt', snapshotId: 5 }, ['invalid_argument', 'bad_token', 'not_found'])
  await call('되살리기', '⑧ .git 안', rs('.git/l592-t.txt', sid), ['protected', 'invalid_argument'])
  await call('되살리기', '⑨ NUL', rs('l592-in/l592\u0000t', sid), ['invalid_argument', 'invalid_name'])
  await call('되살리기', '① 안 경로(같은 사본)', rs('l592-in/l592-t.txt', sid), ['ok'])
  // 복제
  const du = (rel) => ({ op: 'duplicate', rel })
  await call('복제', '① 안 경로', du('l592-in/f.txt'), ['ok'])
  await call('복제', '② .. 탈출', du('../outside/l592-ofile.txt'), ['outside_root', 'invalid_argument'])
  await call('복제', '③ 절대 밖', du(path.join(outside, 'l592-ofile.txt')), ['invalid_argument', 'outside_root'])
  fs.symlinkSync(path.join(outside, 'l592-ofile.txt'), abs('l592-ofile-link2'))
  await call('복제', '④ 마지막 성분 = 밖 링크(링크로 복제 — 밖 무변경)', du('l592-ofile-link2'), (r) => r.ok === true && fs.lstatSync(abs(r.rel)).isSymbolicLink() && fs.readlinkSync(abs(r.rel)) === path.join(outside, 'l592-ofile.txt'))
  await call('복제', '⑤ 중간 폴더 밖 링크', du('l592-olink/sub/x.txt'), ['outside_root'])
  await call('복제', '⑥ 등록 안 된 루트', { ...du('a'), root: otherRoot }, ['not_worktree'])
  await call('복제', '⑦ 형 위반', { op: 'duplicate', rel: null }, ['invalid_argument'])
  await call('복제', '⑧ 루트', du(''), ['protected'])
  await call('복제', '⑧ .git', du('.git'), ['protected'])
  await call('복제', '⑨ NUL', du('l592\u0000'), ['invalid_argument', 'invalid_name'])
  // 가져오기 원본 — 원본은 실제 드롭 경로만(표지). 렌더러가 넣을 수 있는 모든 꼴 = bad_token
  await call('가져오기 원본', '② 위조 표지', { op: 'import', dir: 'l592-in', token: '../outside' }, ['bad_token'])
  await call('가져오기 원본', '③ 표지 자리에 밖 절대 경로', { op: 'import', dir: 'l592-in', token: path.join(outside, 'l592-ofile.txt') }, ['bad_token'])
  await call('가져오기 원본', '⑦ 형 위반', { op: 'import', dir: 'l592-in', token: [path.join(outside, 'l592-ofile.txt')] }, ['bad_token'])
  await call('가져오기 원본', '재생 위조', { op: 'import', dir: 'l592-in', replay: 'x', names: ['l592-ofile.txt'] }, ['bad_token'])
  // 가져오기 대상 — 실제 드롭(CDP) + 드롭 표지 DOM 위조(렌더러가 고른 대상 폴더) → preload → main
  const srcFile = path.join(root, 'l592-drop.txt')
  fs.writeFileSync(srcFile, 'drop\n')
  await until(() => hasRow('l592-in'), { label: 'l592-in 행' })
  const dropInto = async (kase, forgedDir, forgedRoot, want) => {
    const logs0 = opLogs().length
    const snapBefore = snap()
    await q(`(() => { const el = document.querySelector('${row('l592-in')}'); el.dataset.explorerDropDir = ${JSON.stringify(forgedDir)}; ${forgedRoot === null ? '' : `document.querySelector('[data-explorer-root]').dataset.explorerRoot = ${JSON.stringify(forgedRoot)};`} return true })()`)
    await cdpDrop(await center(row('l592-in')), [srcFile])
    await until(() => Promise.resolve(opLogs().slice(logs0).some((x) => x.op === 'import')), { timeoutMs: 5000, label: `드롭 ${kase}` }).catch(() => null)
    const got = opLogs().slice(logs0).find((x) => x.op === 'import') ?? null
    await q(`(() => { document.querySelector('[data-explorer-root]').dataset.explorerRoot = ${JSON.stringify(r0)}; const el = document.querySelector('${row('l592-in')}'); if (el) el.dataset.explorerDropDir = 'l592-in'; return true })()`)
    const ok = got === null ? want.includes('none') && same(diff(snapBefore, snap())) : want.includes(got.ok ? 'ok' : got.code)
    matrix.push({ family: '가져오기 대상', kase, input: { dropDir: forgedDir, root: forgedRoot ?? '<root>' }, result: got === null ? null : { ok: got.ok, code: got.code, done: got.done }, want, pass: ok })
  }
  await dropInto('① 안 경로', 'l592-in', null, ['ok'])
  await dropInto('② .. 탈출', '../outside', null, ['outside_root', 'invalid_argument'])
  await dropInto('③ 절대 밖', outside, null, ['invalid_argument', 'outside_root'])
  await dropInto('④ 대상 폴더 = 밖 링크', 'l592-olink', null, ['outside_root'])
  await dropInto('⑤ 중간 폴더 밖 링크', 'l592-olink/sub', null, ['outside_root'])
  // ⑥ — 렌더러는 화면 루트와 다른 드롭을 main 에 보내지 않는다(useFileOps importDrop owner=null — 1차 거름). 그 드롭의 실제 표지(main 에 안 쓰인 채 남음)를
  //   잡아 등록 안 된 루트로 직접 부르면 main 가둠(not_worktree)이 2차로 거절함을 보인다.
  await q(`(() => { window.__l592drops = []; window.__l592off?.(); window.__l592off = window.corral.onExplorerDrop((d) => window.__l592drops.push(d)); return true })()`)
  await dropInto('⑥ 등록 안 된 루트(렌더러 1차 거름 — main 호출 0)', '', otherRoot, ['none'])
  const captured = await q(`window.__l592drops.slice(-1)[0] ?? null`)
  const direct = captured?.token ? await ipc({ op: 'import', root: otherRoot, dir: '', token: captured.token }) : null
  matrix.push({ family: '가져오기 대상', kase: '⑥ 등록 안 된 루트 — 그 실제 표지로 main 직접', input: { root: otherRoot, token: captured?.token ? '<실제 드롭 표지>' : null }, result: direct === null ? null : { ok: direct.ok, code: direct.code ?? null }, want: ['not_worktree'], pass: direct !== null && direct.code === 'not_worktree' })
  await q(`(window.__l592off?.(), true)`)
  await dropInto('⑧ .git', '.git', null, ['protected'])
  await dropInto('⑨ NUL', 'l592\u0000', null, ['invalid_argument', 'invalid_name'])
  const out1 = outSnap()
  const failed = matrix.filter((x) => !x.pass)
  current.metrics = { matrix: matrix.length, failed: failed.length }
  result.e9matrix = matrix
  check(`ⓒ 가족 × ①~⑨ 양성 대조 ${matrix.length}건 — 사유 코드 기대대로`, failed.length === 0, failed)
  check('ⓒ 밖 파일 sha·목록 무변경(①~⑨ 전부 뒤)', same(diff(out0, out1)), diff(out0, out1))
  // ⑩ 경쟁 주입 — 검사 뒤·호출 전에 중간 폴더를 밖 링크로 (훅 파일 = 호출마다 다시 읽힘, 한 번만 돈다)
  const hookFile = path.join(root, 'op-hook.json')
  const race = []
  const raceOne = async (phase, prepare, input, expectFn, note) => {
    const swap = abs('l592-race')
    const target = path.join(outside, `l592-race-${phase}`)
    fs.rmSync(swap, { recursive: true, force: true })
    fs.rmSync(`${swap}.l592-orig`, { recursive: true, force: true })
    fs.mkdirSync(swap, { recursive: true })
    fs.mkdirSync(target, { recursive: true })
    prepare(swap, target)
    const before = { outside: snap(outside), inside: snap() }
    fs.writeFileSync(hookFile, JSON.stringify({ phase, swapDir: fs.realpathSync(swap), linkTo: target }))
    const res = await ipc({ root: r0, ...input })
    fs.rmSync(hookFile, { force: true })
    const fired = fs.existsSync(`${swap}.l592-orig`)
    const after = { outside: snap(outside), inside: snap() }
    const rowData = { phase, input, result: { ok: res.ok, code: res.code ?? null, done: res.done ?? null }, fired, outsideDiff: diff(before.outside, after.outside), note }
    rowData.pass = fired && expectFn(res, rowData)
    rowData.caughtBy = res.ok ? '잡지 못함(성공 반환)' : res.done === true ? '사후 확인(done — 호출은 일어남)' : '호출 전 검사(거절 — 호출 없음)'
    race.push(rowData)
    log(`race ${phase}`, rowData)
    // 원복 — 링크 치우고 원래 폴더를 되돌린다
    if (fired) {
      fs.unlinkSync(swap)
      fs.renameSync(`${swap}.l592-orig`, swap)
    }
    return rowData
  }
  await raceOne('create-file', () => {}, { op: 'create', dir: 'l592-race', name: 'l592-r.txt', kind: 'file' }, (r, x) => r.ok === false && same(x.outsideDiff), 'fd 연산(O_NOFOLLOW_ANY) = 거절·밖 무변경')
  await raceOne('mkdir', () => {}, { op: 'create', dir: 'l592-race', name: 'l592-rd', kind: 'dir' }, (r) => r.ok === false && r.code === 'changed' && r.done === true, '경로 연산 — 밖에 빈 폴더가 생길 수 있음(residual 표) · 사후 확인이 changed done 으로 잡는다')
  // 경로 연산의 판정(Q8): 결과 그대로 기록 — 훅 지점(검사 직후)은 「직전 재검사」 앞이라 재검사가 먼저 잡으면 거절·밖 무변경(done 없음), 놓치면 사후 확인이 changed done.
  const pathOk = (r, x) => r.ok === false && ((r.code === 'changed' && r.done === true) || same(x.outsideDiff))
  await raceOne('rename', (swap) => fs.writeFileSync(path.join(swap, 'l592-mv.txt'), 'mv\n'), { op: 'move', from: 'l592-race/l592-mv.txt', to: 'l592-moved.txt' }, pathOk, '경로 연산 — 직전 재검사(거절·밖 무변경) 또는 사후 확인(changed done)')
  await raceOne('symlink', (swap) => fs.symlinkSync('../l592-top.txt', path.join(swap, 'l592-ln')), { op: 'duplicate', rel: 'l592-race/l592-ln' }, (r) => r.ok === false && (r.code === 'changed' || r.code === 'outside_root' || r.code === 'io_error'), '경로 연산(symlink) — 사후 확인')
  const trashRace = await raceOne('trash', (swap, target) => { fs.writeFileSync(path.join(swap, 'l592-tr.txt'), 'in\n'); fs.writeFileSync(path.join(target, 'l592-tr.txt'), 'outside\n') }, { op: 'trash', rel: 'l592-race/l592-tr.txt', snapshot: false }, () => true, 'residual 표 — 휴지통 경쟁은 사후 확인이 잡지 못함(밖 항목이 휴지통으로 갈 수 있음) — 결과 그대로 기록')
  if (trashRace.outsideDiff.removed.length > 0) result.trashed.push({ path: path.join(outside, 'l592-race-trash/l592-tr.txt'), at: new Date().toISOString(), via: 'E9⑩ 휴지통 경쟁 주입 — 밖 링크를 따라 밖 fixture 항목이 휴지통으로(residual 표 「잡지 못함」)', case: current.name })
  result.e9race = race
  check('ⓒ⑩ 경쟁 주입 — fd 연산 거절·경로 연산 재검사/사후 확인(Q8 판정대로)·휴지통은 결과 기록', race.every((x) => x.pass), race.map((x) => ({ phase: x.phase, result: x.result, fired: x.fired, caughtBy: x.caughtBy, outside: x.outsideDiff })))
  // ⑪ 하드링크·특수 파일
  fs.writeFileSync(abs('l592-in/l592-h.txt'), 'h\n')
  fs.linkSync(abs('l592-in/l592-h.txt'), abs('l592-in/l592-h2.txt'))
  execFileSync('mkfifo', [abs('l592-in/l592-fifo')])
  const special = {
    moveHard: await ipc({ root: r0, op: 'move', from: 'l592-in/l592-h.txt', to: 'l592-in/deep/l592-h.txt' }),
    dupHard: await ipc({ root: r0, op: 'duplicate', rel: 'l592-in/l592-h2.txt' }),
    dupFifo: await ipc({ root: r0, op: 'duplicate', rel: 'l592-in/l592-fifo' }),
    moveFifo: await ipc({ root: r0, op: 'move', from: 'l592-in/l592-fifo', to: 'l592-in/deep/l592-fifo' }),
  }
  const hardState = { movedNlink: fs.statSync(abs('l592-in/deep/l592-h.txt')).nlink, dupNlink: special.dupHard.ok ? fs.statSync(abs(special.dupHard.rel)).nlink : null }
  log('special', { special, hardState })
  check('ⓒ⑪ 하드링크 이동(같은 inode·nlink 유지)·복제(내용 복사)·FIFO 복제 거절 또는 건너뜀 — 기록', special.moveHard.ok === true && hardState.movedNlink === 2 && special.dupHard.ok === true && hardState.dupNlink === 1 && (special.dupFifo.ok === false || (special.dupFifo.skipped ?? []).length > 0), { special, hardState })
}

// --- E10ⓑ 무회귀 격리 합성 1회 ----------------------------------------------------------------------------
cases.e10b = async () => {
  await expand('src')
  const paneId = await terminalPane()
  // F1 — 화살표·Space·⇧F10 메뉴·감시·git 색
  await focusRow('src')
  await key('Down')
  const down = await selectedRow()
  await key('Up')
  check('F1 화살표 이동', down === 'src/sub' && (await selectedRow()) === 'src', { down })
  await focusRow('src/l592-a.ts')
  await key('F10', ['shift'])
  const menuOpen = await until(() => q(`document.querySelector('[data-explorer-row-menu]') !== null`), { timeoutMs: 3000, label: '⇧F10' }).then(() => true, () => false)
  await key('Escape')
  check('F1 ⇧F10 = 행 메뉴', menuOpen, null)
  fs.writeFileSync(abs('src/l592-watch.txt'), 'w\n')
  const watched = await until(() => hasRow('src/l592-watch.txt'), { timeoutMs: 5000, label: '감시' }).then(() => true, () => false)
  fs.appendFileSync(abs('src/l592-a.ts'), '// changed\n')
  const git = await until(async () => (await q(`document.querySelector('${row('src/l592-a.ts')}')?.dataset.git ?? null`)) !== null, { timeoutMs: 8000, label: 'git 색' }).then(async () => q(`document.querySelector('${row('src/l592-a.ts')}')?.dataset.git`), () => null)
  check('F1 감시(바깥 생성 → 행)·git 색(수정 → 표지)', watched && git !== null, { watched, git })
  // F2 뷰어 · F3 편집·저장·충돌·종료 확인
  await exposeMonaco(root)
  await openFixed('src/sub/l592-c.md').catch(async () => { await expand('src/sub'); await openFixed('src/sub/l592-c.md') })
  const viewer = await q(`document.querySelector('[data-file-view="src/sub/l592-c.md"]') !== null`)
  await openFixed('src/l592-b.ts')
  await editorFocus('src/l592-b.ts')
  await type('S')
  await until(async () => (await tab('src/l592-b.ts'))?.dirty === 'true', { label: 'F3 수정' })
  const beforeSave = (await modelOf('src/l592-b.ts')).value
  await key('S', ['meta'])
  await until(async () => (await tab('src/l592-b.ts'))?.dirty === 'false', { label: 'F3 저장' })
  const savedOk = fs.readFileSync(abs('src/l592-b.ts'), 'utf8') === beforeSave && beforeSave.includes('S')
  await type('T')
  await until(async () => (await tab('src/l592-b.ts'))?.dirty === 'true', { label: 'F3 다시 수정' })
  fs.writeFileSync(abs('src/l592-b.ts'), 'external\n')
  const banner = await until(() => q(`document.querySelector('[data-file-notice="external-change"], .file-view-conflict') !== null`), { timeoutMs: 6000, label: '충돌 배너' }).then(() => true, () => false)
  check('F2 뷰어·F3 저장·충돌 배너', viewer && savedOk && banner, { viewer, savedOk, banner })
  // F3 종료 확인 — 수정 중 탭 ⌘W → 취소(스텁) = 탭 유지
  await stub(['cancel'])
  await click('[data-main-tab="file:src/l592-b.ts"]')
  await key('W', ['meta'])
  await sleep(800)
  const asked = (await stub([])).asked
  check('F3 수정 중 탭 닫기 확인 → 취소 = 탭 유지', (await tab('src/l592-b.ts')) !== null && JSON.stringify(asked).length > 2, { asked })
  // 터미널 탭 — ⌘T 새 탭 · ⌘W 닫기 · ⌘⇧T 다시 열기 · ⌘D 분할
  await termFocus(paneId)
  const termTabs = () => q(`[...document.querySelectorAll('.main-tab:not(.main-tab-file)')].map((e) => e.dataset.mainTab)`)
  const t0 = await termTabs()
  await key('T', ['meta'])
  await until(async () => (await termTabs()).length === t0.length + 1, { timeoutMs: 8000, label: '⌘T' })
  const t1 = await termTabs()
  await sleep(800)
  await key('Shift')
  await key('W', ['meta'])
  await until(async () => (await termTabs()).length === t0.length, { timeoutMs: 8000, label: '⌘W' }).catch(() => null)
  const t2 = await termTabs()
  await key('T', ['meta', 'shift'])
  await until(async () => (await termTabs()).length === t0.length + 1, { timeoutMs: 8000, label: '⌘⇧T' }).catch(() => null)
  const t3 = await termTabs()
  const panes0 = ((await herdr(root, 'pane.list')).panes ?? []).length
  await termFocus(paneId).catch(() => null)
  await key('D', ['meta'])
  const split = await until(async () => ((await herdr(root, 'pane.list')).panes ?? []).length === panes0 + 1, { timeoutMs: 8000, label: '⌘D' }).then(() => true, () => false)
  check('터미널 탭 ⌘T·⌘W·⌘⇧T·⌘D 분할', t1.length === t0.length + 1 && t2.length === t0.length && t3.length === t0.length + 1 && split, { t0, t1, t2, t3, split })
  // 단축키·설정(⌘K · ⌘,)
  await clickUntil('[data-main-tab="file:src/l592-b.ts"]')
  await key('K', ['meta'])
  const palette = await until(() => q(`document.querySelector('input[role="combobox"]') !== null`), { timeoutMs: 5000, label: '팔레트' }).then(() => true, () => false)
  await key('Escape')
  await sleep(300)
  await key(',', ['meta'])
  const settings = await until(() => q(`document.querySelector('[data-settings-search]') !== null`), { timeoutMs: 5000, label: '설정' }).then(() => true, () => false)
  await key('Escape')
  await sleep(300)
  check('설정(⌘,)·커맨드 팔레트(⌘K) 열림', settings && palette, { settings, palette })
  // 재시작 복원 — 터미널 탭 수·파일 탭
  await stub(['discard', 'discard', 'discard'])
  const tabsBefore = { term: (await termTabs()).length, files: await fileTabs() }
  await restartApp()
  await stub([])
  await until(async () => (await termTabs()).length > 0, { timeoutMs: 15_000, label: '복원 터미널' }).catch(() => null)
  const tabsAfter = { term: (await termTabs()).length, files: await fileTabs() }
  check('터미널 탭·파일 탭 재시작 복원', tabsAfter.term === tabsBefore.term && tabsBefore.files.every((f) => tabsAfter.files.includes(f)), { tabsBefore, tabsAfter })
}

/** 한계 확인(DONE 미완 10 — 판정 분모 아님): 만든 폴더를 사용자가 삭제(Q1 — 폴더는 되살림 칸 없음)한 뒤 ⌘Z → not_found 안내와 함께 앞 「만들기」 칸이 버려진다. 디스크 무변화. */
cases.e5lim = async () => {
  await expand('src')
  await createVia(async () => { await focusRow('src'); await clickUntil('[data-explorer-new-folder]') }, { name: 'l592-lim-dir', expectRel: 'src/l592-lim-dir' })
  await stub(['trash'])
  const at = new Date().toISOString()
  await rowMenu('src/l592-lim-dir', 'trash')
  await settle(() => !exists('src/l592-lim-dir'), '폴더 삭제')
  noteTrash('src/l592-lim-dir', '한계 확인: 만든 폴더 → 행 메뉴 삭제(폴더 — 되살림 칸 없음)', at)
  const asked = (await stub([])).asked
  let before = snap()
  const logs0 = opLogs().length
  await undo()
  await sleep(1200)
  const first = { diff: diff(before, snap()), ops: opLogs().slice(logs0).map((x) => `${x.op}:${x.ok}:${x.code}`), toasts: await toasts() }
  before = snap()
  const logs1 = opLogs().length
  await undo()
  await sleep(900)
  const second = { diff: diff(before, snap()), ops: opLogs().slice(logs1).map((x) => `${x.op}:${x.ok}:${x.code}`) }
  const dialog = logRows().filter((r) => r.tag === 'file.dialog').slice(-1)[0] ?? null
  log('한계 확인', { asked, dialog, first, second })
  check('한계 — 삭제 확인에 「되돌릴 수 없음」(undoable false)', dialog?.undoable === false, dialog)
  check('한계 — ⌘Z 1 = not_found 안내·디스크 무변화(앞 「만들기」 칸 버려짐)', same(first.diff) && first.ops.some((x) => x.includes('not_found')), first)
  check('한계 — ⌘Z 2 = 더 되돌릴 것 없음(버려진 칸)·디스크 무변화', same(second.diff), second)
}

// 사례 목록 실행 — 사례마다 같은 앱·fixture 를 이어 쓴다(앞 사례의 결과는 뒤 사례의 전제가 아님 — 사례는 자기 대상을 스스로 만든다).
await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
await repoPane(root)
await sleep(1500)
await ctl(root, { cmd: 'resize-window', width: 1400, height: 900 }).catch(() => null)
if (!(await panelOpen())) await key('L', ['meta'])
await until(panelOpen, { label: '탐색기' })
await until(() => q(`document.querySelectorAll('[data-explorer-row]').length > 0`), { label: '탐색기 행' })
for (const name of caseArg.split(',')) {
  current = { name, steps: [], checks: [], startedAt: new Date().toISOString() }
  result.cases[name] = current
  try {
    if (cases[name] === undefined) throw new Error(`모르는 사례 ${name}`)
    await cases[name]()
  } catch (error) {
    current.error = String(error?.stack ?? error)
    check('사례가 끝까지 돌았다', false, current.error.slice(0, 400))
  }
  current.endedAt = new Date().toISOString()
  writeJson(out, result)
}
result.pass = result.checks.every((c) => c.ok)
result.summary = { checks: result.checks.length, failed: result.checks.filter((c) => !c.ok).map((c) => `${c.case}/${c.name}`) }
writeJson(out, result)
cdpSocket?.close()
console.log(`결과 ${result.pass ? '통과' : '미달'} — 확인 ${result.summary.checks}, 실패 ${result.summary.failed.length}`)
process.exitCode = result.pass ? 0 : 1
