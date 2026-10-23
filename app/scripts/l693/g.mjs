// LIFE-693 최종 관문 g1 — 격리 GUI 실측(K1–K4 · 판정 A·B 관찰). 회차 하나 = 새 ROOT(/tmp/l693q-*) · 새 herdr 이름 세션.
//
// 격리: l693/up.sh(= l691/up.sh 사본) — userData·제어 소켓·설정 전부 ROOT 아래, herdr 는 레포 guard 바이너리의 이름 세션 `l693q-<꼬리>`.
//   설치본·사용자 userData·사용자 herdr 무접촉. 앱은 빌드 산출물 사본(fixture-app.sh — 창 showInactive)으로 띄운다.
// 입력: 클릭 = 제어 소켓 click(히트테스트 뒤 webContents.sendInputEvent — 가려져 있으면 누르지 않는다) ·
//   휠·우클릭·키 = CDP `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent`(격리 페이지 대상). OS 입력 이벤트 없음.
// 측정(MEASURE_JS): 뷰포트 · 창 rect · 제목/✕/취소/확인 중심 elementFromPoint · 스크롤 영역 scrollHeight/clientHeight/scrollTop · 마지막 행 노출.
// 판정은 하지 않는다 — 수치 JSON + PNG 를 남기고, 항목별 통과선 대조는 g1-summary.mjs 가 한다.
// 사용(app/ 에서): node scripts/l693/g.mjs --scenario orphan|tabs --build impl|base --root /tmp/l693q-<x> --port <CDP 포트> --out <raw txt>
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const { scenario, build, root } = args
const port = Number(args.port)
if (!/^\/tmp\/l693q-[a-z0-9-]+$/.test(root ?? '')) throw new Error(`--root 는 /tmp/l693q-*: ${root}`)
if (build !== 'impl' && build !== 'base') throw new Error('--build impl|base')
if (scenario !== 'orphan' && scenario !== 'tabs') throw new Error('--scenario orphan|tabs')
const out = path.resolve(args.out)
const dataDir = out.replace(/\.txt$/, '')
fs.mkdirSync(dataDir, { recursive: true })
const log = recorder(out)
const session = `l693q-${path.basename(root).replace(/^l693q-/, '')}`
const herdrSock = path.join(os.homedir(), '.config/herdr-dev/sessions', session, 'herdr.sock')
const appDir = `${root}-app`
const repo = path.join(root, 'repo')
const ORPHANS = 32
const TABS = 20
const sent = { keys: [], wheels: 0, rightClicks: 0, clicks: 0 }

// --- 바깥 도구 -----------------------------------------------------------------
const sh = (argv, env = {}) => {
  const run = spawnSync('sh', argv, { cwd: APP, encoding: 'utf8', env: { ...process.env, ...env } })
  log(`$ sh ${argv.join(' ')} → exit ${run.status}`)
  log((run.stdout + run.stderr).trim().replaceAll(os.homedir(), '~'))
  if (run.status !== 0) throw new Error(`${argv[0]} 실패`)
}
function herdr(method, params = {}, timeoutMs = 10_000) {
  if (!session.startsWith('l693q-')) throw new Error(`거부: 격리 세션이 아니다 (${session})`)
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(herdrSock)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr 시간 초과 ${method}`)) }, timeoutMs)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l693', method, params }) + '\n'))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.destroy()
      const message = JSON.parse(buffer.slice(0, index))
      if (message.error) reject(new Error(`${method}: ${message.error.code} ${message.error.message}`))
      else resolve(message.result)
    })
  })
}
const js = (code) => evalJs(root, code)
async function click(selector) {
  let last = null
  await until(async () => { last = await ctl(root, { cmd: 'click', selector }); return last.ok }, { timeoutMs: 10_000, everyMs: 250, label: `click ${selector}` }).catch(() => null)
  if (!last?.ok) throw new Error(`click 실패 ${selector} ${JSON.stringify(last)}`)
  sent.clicks += 1
  return last
}

// --- CDP (Node 내장 WebSocket) ---------------------------------------------------
let cdpSocket = null
let cdpSeq = 0
const cdpWait = new Map()
async function cdpConnect() {
  const list = await until(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null)
    if (res === null) return null
    const pages = (await res.json()).filter((t) => t.type === 'page' && /renderer\/index\.html/.test(t.url))
    return pages.length > 0 ? pages : null
  }, { timeoutMs: 20_000, label: 'CDP 페이지' })
  const target = list.value[0]
  log('cdp.target', { url: target.url.replace(os.homedir(), '~'), id: target.id })
  cdpSocket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { cdpSocket.onopen = resolve; cdpSocket.onerror = reject })
  cdpSocket.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    const wait = cdpWait.get(message.id)
    if (wait === undefined) return
    cdpWait.delete(message.id)
    if (message.error) wait.reject(new Error(JSON.stringify(message.error)))
    else wait.resolve(message.result)
  }
}
function cdp(method, params = {}) {
  cdpSeq += 1
  const id = cdpSeq
  cdpSocket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => cdpWait.set(id, { resolve, reject }))
}
const KEYS = { Tab: { code: 'Tab', windowsVirtualKeyCode: 9 }, Escape: { code: 'Escape', windowsVirtualKeyCode: 27 } }
async function pressKey(keyName, { shift = false } = {}) {
  const base = { key: keyName, ...KEYS[keyName], nativeVirtualKeyCode: KEYS[keyName].windowsVirtualKeyCode, modifiers: shift ? 8 : 0 }
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  sent.keys.push(`${shift ? 'Shift+' : ''}${keyName}`)
  await sleep(250)
}
async function wheelAt({ x, y, deltaY }) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
  sent.wheels += 1
}
async function rightClick(selector) {
  const point = await js(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
  if (point === null) throw new Error(`우클릭 대상 없음 ${selector}`)
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'right', buttons: 2, clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'right', buttons: 0, clickCount: 1 })
  sent.rightClicks += 1
}

// --- 측정 ----------------------------------------------------------------------
// 기준 빌드에는 data-confirm-close-scroll 이 없다 — 같은 자리(.modal-body)를 본다.
const MEASURE_JS = `(() => {
  const m = document.querySelector('[data-confirm-close-modal]')
  if (!m) return { open: false, vp: { w: innerWidth, h: innerHeight } }
  const rect = (e) => { const b = e.getBoundingClientRect(); return { top: +b.top.toFixed(2), bottom: +b.bottom.toFixed(2), left: +b.left.toFixed(2), right: +b.right.toFixed(2), width: +b.width.toFixed(2), height: +b.height.toFixed(2) } }
  const hit = (sel) => {
    const e = m.querySelector(sel)
    if (!e) return { exists: false }
    const b = e.getBoundingClientRect()
    const x = b.left + b.width / 2, y = b.top + b.height / 2
    const inViewport = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight
    const at = inViewport ? document.elementFromPoint(x, y) : null
    return { exists: true, x: +x.toFixed(1), y: +y.toFixed(1), inViewport, hit: !!at && (at === e || e.contains(at)), at: at ? at.tagName.toLowerCase() + (at.className ? '.' + String(at.className).split(' ').join('.') : '') : null }
  }
  const s = m.querySelector('[data-confirm-close-scroll]') ?? m.querySelector('.modal-body')
  const sr = s.getBoundingClientRect()
  const visTop = Math.max(sr.top, 0), visBottom = Math.min(sr.bottom, innerHeight)
  const items = [...m.querySelectorAll('[data-confirm-close-fg] li')]
  const last = items[items.length - 1] ?? null
  const lb = last ? last.getBoundingClientRect() : null
  const box = m.querySelector('[data-dont-ask-again-input]')
  const bb = box ? box.getBoundingClientRect() : null
  const active = document.activeElement
  return {
    open: true,
    vp: { w: innerWidth, h: innerHeight },
    classes: m.className,
    modal: rect(m),
    modalInViewport: m.getBoundingClientRect().top >= 0 && m.getBoundingClientRect().bottom <= innerHeight,
    title: hit('[data-confirm-close-title]'), x: hit('[data-confirm-close-x]'), cancel: hit('[data-close-confirm-cancel]'), ok: hit('[data-close-confirm-ok]'),
    scroll: { rect: rect(s), scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, scrollTop: s.scrollTop, overflowY: getComputedStyle(s).overflowY, visTop: +visTop.toFixed(2), visBottom: +visBottom.toFixed(2) },
    rows: { li: items.length, labels: m.querySelectorAll('[data-confirm-close-tab]').length, code: m.querySelectorAll('.modal-code-block').length, lastText: last ? last.textContent : null },
    lastVisible: lb ? lb.top >= visTop - 0.5 && lb.bottom <= visBottom + 0.5 : null,
    checkbox: bb ? { rect: rect(box), visible: bb.top >= visTop - 0.5 && bb.bottom <= visBottom + 0.5 } : null,
    active: active ? { tag: active.tagName.toLowerCase(), cancel: active.hasAttribute('data-close-confirm-cancel'), ok: active.hasAttribute('data-close-confirm-ok'), checkbox: active.hasAttribute('data-dont-ask-again-input') } : null,
    hasFocus: document.hasFocus(),
  }
})()`
const measurements = []
async function measure(tag, { shot = true } = {}) {
  const m = await js(MEASURE_JS)
  const win = await ctl(root, { cmd: 'window-visibility', action: 'read' }).catch((e) => ({ error: String(e) }))
  const record = { tag, build, scenario, at: new Date().toISOString(), windowFocused: win.focused ?? null, ...m }
  measurements.push(record)
  fs.writeFileSync(path.join(dataDir, `${tag}.json`), JSON.stringify(record, null, 2) + '\n')
  log(`[측정] ${tag}`, { vp: m.vp, modal: m.modal, inVp: m.modalInViewport, hits: m.open ? [m.title.hit, m.x.hit, m.cancel.hit, m.ok.hit] : null, scroll: m.open ? [m.scroll.scrollHeight, m.scroll.clientHeight, m.scroll.scrollTop] : null, lastVisible: m.lastVisible })
  if (shot) {
    const result = await ctl(root, { cmd: 'shot', name: tag }).catch((error) => ({ error: String(error) }))
    if (result.file) {
      const target = path.join(dataDir, `${tag}.png`)
      fs.copyFileSync(result.file, target)
      log('shot', { file: path.relative(path.resolve(APP, '..'), target), bytes: fs.statSync(target).size })
    } else log('shot 실패', result)
  }
  return record
}
/** 실제 휠(CDP mouseWheel)로 스크롤 영역 가운데(보이는 부분)를 굴린다 — 마지막 행이 보이거나 3번 연속 안 움직이면 멈춘다. */
async function wheelToEnd(tag) {
  const before = await js(MEASURE_JS)
  const x = (before.scroll.rect.left + before.scroll.rect.right) / 2
  const y = (before.scroll.visTop + before.scroll.visBottom) / 2
  let stuck = 0
  let prev = before.scroll.scrollTop
  let n = 0
  for (; n < 80 && stuck < 3; n += 1) {
    await wheelAt({ x, y, deltaY: 240 })
    await sleep(120)
    const now = await js(MEASURE_JS)
    if (now.lastVisible) { n += 1; break }
    if (now.scroll.scrollTop === prev) stuck += 1
    else stuck = 0
    prev = now.scroll.scrollTop
  }
  await sleep(300)
  const after = await measure(tag)
  const record = { tag, point: { x, y }, wheels: n, before: { scrollTop: before.scroll.scrollTop, lastVisible: before.lastVisible }, after: { scrollTop: after.scroll.scrollTop, lastVisible: after.lastVisible } }
  fs.writeFileSync(path.join(dataDir, `${tag}-wheel.json`), JSON.stringify(record, null, 2) + '\n')
  log(`[휠] ${tag}`, record)
  return record
}
async function resize(height) {
  await ctl(root, { cmd: 'resize-window', width: 1180, height })
  await until(async () => { const vp = await js('({ h: innerHeight })'); return Math.abs(vp.h - height) <= 40 ? vp : null }, { timeoutMs: 5_000, label: `창 높이 ${height}` }).catch(() => null)
  await sleep(500)
  log('resize', { asked: height, vp: await js('({ w: innerWidth, h: innerHeight, outer: outerHeight })') })
}
const modalOpen = () => js(`!!document.querySelector('[data-confirm-close-modal]')`)

// --- 준비 ----------------------------------------------------------------------
async function up() {
  sh(['scripts/l693/up.sh', root, 'CORRAL_WINDOW=1180x800', `L693_EXTRA_ARGS=--remote-debugging-port=${port}`], { L693_APP_DIR: appDir })
  // clean.sh 가 KEY=VALUE 를 공백으로 쪼갠다 — EXTRA_ARGS 는 한 토큰만(1회차가 이것으로 CDP 플래그를 잃었다).
  await until(() => js(`!!document.querySelector('[data-sidebar]')`), { timeoutMs: 30_000, label: '렌더러(사이드바)' })
  await cdpConnect()
  await sleep(1000)
}
const down = () => sh(['scripts/l693/down.sh', root, 'herdr'])
/** 셸 프롬프트 뒤 `sleep 3600` — 첫 글자를 먹는 셸 rc 가 있어 foreground 가 sleep 이 될 때까지 다시 보낸다. */
async function runSleep(paneId) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await herdr('pane.send_text', { pane_id: paneId, text: 'sleep 3600\r' })
    const ok = await until(async () => {
      const info = await herdr('pane.process_info', { pane_id: paneId }).catch(() => null)
      return JSON.stringify(info ?? {}).includes('sleep') ? info : null
    }, { timeoutMs: 4_000, everyMs: 300, label: `sleep ${paneId}` }).catch(() => null)
    if (ok) return { paneId, attempt }
    await herdr('pane.send_text', { pane_id: paneId, text: '\u0015' }).catch(() => null)
  }
  throw new Error(`sleep 이 안 돈다 ${paneId}`)
}
async function makeHomeWorkspaces(count, prefix) {
  const made = []
  for (let i = 1; i <= count; i += 1) {
    const ws = await herdr('workspace.create', { cwd: os.homedir(), focus: false, label: `${prefix}${i}` })
    made.push({ workspaceId: ws.workspace?.workspace_id ?? ws.workspace_id ?? null, paneId: ws.root_pane.pane_id })
  }
  log('workspace.create(HOME)', { command: `herdr --session ${session} rpc workspace.create {cwd: HOME, focus: false, label: ${prefix}N} × ${count} → 각 root pane 에 pane.send_text "sleep 3600\\r"`, made: made.length, sample: made[0] })
  await sleep(2500)
  const runs = []
  for (const one of made) runs.push(await runSleep(one.paneId))
  log('sleep 실행', { panes: runs.length, retried: runs.filter((r) => r.attempt > 1).length })
  return made
}
async function openResourcePanel() {
  if (!(await js(`!!document.querySelector('[data-statusbar-resource-panel]')`))) await click('[data-statusbar-resource]')
  await until(() => js(`!!document.querySelector('[data-statusbar-resource-panel]')`), { timeoutMs: 8_000, label: '리소스 패널' })
}
const orphanRowCount = () => js(`document.querySelectorAll('[data-statusbar-resource-orphan]').length`)
async function waitOrphans(count) {
  await openResourcePanel()
  await until(async () => (await orphanRowCount()) >= count, { timeoutMs: 30_000, everyMs: 500, label: `카드 밖 ${count}줄` })
  log('카드 밖 줄', { rows: await orphanRowCount(), closeAll: await js(`document.querySelector('[data-statusbar-resource-orphan-close-all]')?.textContent ?? null`) })
}
async function workspaceList(tag) {
  const list = await herdr('workspace.list', {})
  const rows = (list.workspaces ?? list ?? []).map((w) => ({ id: w.workspace_id ?? w.id, label: w.label ?? null }))
  fs.writeFileSync(path.join(dataDir, `${tag}-herdr-workspace-list.json`), JSON.stringify(list, null, 2).replaceAll(os.homedir(), '~') + '\n')
  log(`herdr workspace.list ${tag}`, { count: rows.length, labels: rows.map((r) => r.label) })
  return rows
}
function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'l693.md'), '# l693\n')
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=l693', '-c', 'user.email=l693@example.invalid', 'commit', '-q', '-m', 'fixture'])
}
async function workspaceOf(repoPath) {
  const real = fs.realpathSync(repoPath)
  const st = (await ctl(root, { cmd: 'state' })).state
  for (const r of st.repos) for (const wt of r.worktrees) if (wt.workspace !== null && (wt.path === repoPath || wt.path === real)) return wt.workspace
  return null
}

// --- 시나리오 ------------------------------------------------------------------
async function orphanScene() {
  await makeHomeWorkspaces(ORPHANS, 'l693-')
  await waitOrphans(ORPHANS)
  await workspaceList('o0-before')
  await click('[data-statusbar-resource-orphan-close-all]')
  await until(modalOpen, { timeoutMs: 8_000, label: '확인 창(모두 닫기)' })
  await sleep(500)
  const heights = build === 'impl' ? [800, 600, 300, 160] : [800, 600]
  for (const h of heights) {
    await resize(h)
    await measure(`bulk-h${h}`)
    await wheelToEnd(`bulk-h${h}-wheel`)
  }
  await resize(800)
  if (build === 'impl') {
    // K1ⓓ — 800 에서 확인 클릭(히트테스트 통과 시에만 눌림) → 카드 밖 0줄 + herdr 대조
    const before = await measure('bulk-h800-before-confirm', { shot: false })
    const clicked = await click('[data-close-confirm-ok]')
    log('확인 클릭', clicked)
    // 닫기 IPC 는 32개를 차례로 닫고 돌아온다 — 그동안 창이 남는다(2회차: 10초 상한에 걸림, 실제로는 닫힘).
    const closedIn = await until(async () => !(await modalOpen()), { timeoutMs: 90_000, everyMs: 250, label: '확인 창 닫힘' })
    log('확인 창 닫힘까지', { ms: closedIn.ms })
    const settled = await until(async () => (await orphanRowCount()) === 0, { timeoutMs: 30_000, everyMs: 500, label: '카드 밖 0줄' }).catch(() => null)
    const rows = await orphanRowCount()
    const herdrRows = await workspaceList('o1-after-confirm')
    const record = { tag: 'bulk-confirm', rowsBefore: before.rows, orphanRowsAfter: rows, settledMs: settled?.ms ?? null, herdrWorkspacesAfter: herdrRows.length, herdrL693Left: herdrRows.filter((r) => String(r.label ?? '').startsWith('l693-')).length }
    fs.writeFileSync(path.join(dataDir, 'bulk-confirm.json'), JSON.stringify(record, null, 2) + '\n')
    log('[K1ⓓ]', record)
    await measure('bulk-after-confirm', { shot: true })
  } else {
    // 기준: 버튼에 닿지 못하므로 Esc(CDP, 격리 페이지)로 취소하고 herdr 로 닫는다.
    await pressKey('Escape')
    await until(async () => !(await modalOpen()), { timeoutMs: 5_000, label: '확인 창 닫힘(Esc)' })
    const rows = await workspaceList('o1-base-before-cli-close')
    for (const r of rows) await herdr('workspace.close', { workspace_id: r.id })
    log('herdr workspace.close (기준 정리)', { closed: rows.length })
    await until(async () => (await orphanRowCount()) === 0, { timeoutMs: 30_000, everyMs: 500, label: '카드 밖 0줄' })
  }
  // K2 — 짧은 내용, 체크박스 없음(카드 밖 1줄 닫기)
  await makeHomeWorkspaces(1, 'l693-one-')
  await waitOrphans(1)
  await click('[data-statusbar-resource-orphan-close]')
  await until(modalOpen, { timeoutMs: 8_000, label: '확인 창(1줄)' })
  await sleep(500)
  for (const h of [800, 600]) {
    await resize(h)
    await measure(`short-nobox-h${h}`)
  }
  await resize(800)
  await click('[data-close-confirm-cancel]')
  await until(async () => !(await modalOpen()), { timeoutMs: 5_000, label: '확인 창 닫힘(취소)' })
}

async function tabsScene() {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const added = await ctl(root, { cmd: 'add-repo', root: repo })
  if (!added.ok) throw new Error(`add-repo 실패 ${JSON.stringify(added).slice(0, 200)}`)
  const ws = await herdr('workspace.create', { cwd: repo, focus: false })
  const wsId = (await until(async () => (await workspaceOf(repo))?.workspaceId ?? null, { timeoutMs: 15_000, label: '워크스페이스 도착' })).value
  for (let i = 1; i < TABS; i += 1) await herdr('tab.create', { workspace_id: wsId, cwd: repo, focus: false })
  await until(async () => (await workspaceOf(repo))?.tabs.length === TABS, { timeoutMs: 20_000, label: `터미널 탭 ${TABS}` })
  log('탭 준비', { command: `herdr rpc workspace.create {cwd: repo} + tab.create × ${TABS - 1} → 각 pane 에 pane.send_text "sleep 3600\\r"`, wsId, rootPane: ws.root_pane?.pane_id })
  await until(() => js(`document.querySelectorAll('[data-main-tab]').length >= ${TABS}`), { timeoutMs: 20_000, label: '화면 탭' }).catch(() => null)
  log('화면 탭 수', await js(`document.querySelectorAll('[data-main-tab]').length`))
  await sleep(2500)
  const tabs = (await workspaceOf(repo)).tabs
  const runs = []
  for (const tab of tabs) runs.push(await runSleep(tab.panes[0].paneId))
  log('sleep 실행', { panes: runs.length, retried: runs.filter((r) => r.attempt > 1).length })
  await sleep(1500)
  // K2 — 짧은 내용, 체크박스 있음(실행 중 탭 1개 닫기 ×)
  const first = tabs[0].tabId
  await click(`[data-main-tab="${first}"]`)
  await sleep(500)
  await click(`[data-main-tab-close="${first}"]`)
  await until(modalOpen, { timeoutMs: 8_000, label: '확인 창(탭 1개)' })
  await sleep(500)
  for (const h of [800, 600, 300]) {
    await resize(h)
    await measure(`short-box-h${h}`)
  }
  await resize(800)
  await click('[data-close-confirm-cancel]')
  await until(async () => !(await modalOpen()), { timeoutMs: 5_000, label: '확인 창 닫힘(취소)' })
  if (build === 'base') return
  // K3ⓐ — 탭 여럿 닫기(「다른 탭 닫기」) 넘침, 600
  await resize(600)
  const openOthers = async () => {
    await rightClick(`[data-main-tab="${first}"]`)
    await until(() => js(`!!document.querySelector('[data-tab-menu-close-others]')`), { timeoutMs: 5_000, label: '탭 메뉴' })
    await click('[data-tab-menu-close-others]')
    await until(modalOpen, { timeoutMs: 8_000, label: '확인 창(다른 탭 닫기)' })
    await sleep(500)
  }
  await openOthers()
  const opened = await measure('tabs-h600')
  await wheelToEnd('tabs-h600-wheel')
  // K3ⓑ — 열림 직후 포커스=취소 · Esc=취소(창 닫힘)
  const esc = { focusAtOpen: opened.active }
  await pressKey('Escape')
  esc.closedByEsc = !(await modalOpen())
  esc.tabsAfterEsc = await js(`document.querySelectorAll('[data-main-tab]').length`)
  // 다시 열어 Tab → 확인 · Shift+Tab ×2 → 체크박스(스크롤 따라감)
  await openOthers()
  const reopened = await measure('kb-h600-open', { shot: false })
  await pressKey('Tab')
  const afterTab = await measure('kb-h600-tab', { shot: false })
  await pressKey('Tab', { shift: true })
  const afterShift1 = await measure('kb-h600-shift-tab-1', { shot: false })
  await pressKey('Tab', { shift: true })
  await sleep(300)
  const afterShift2 = await measure('kb-h600-shift-tab-2')
  const record = {
    tag: 'k3b', ...esc,
    reopenFocus: reopened.active, reopenScrollTop: reopened.scroll.scrollTop, reopenCheckboxVisible: reopened.checkbox?.visible ?? null,
    afterTab: afterTab.active,
    afterShiftTab1: afterShift1.active,
    afterShiftTab2: afterShift2.active, scrollTopAfterShiftTab2: afterShift2.scroll.scrollTop, checkboxVisibleAfterShiftTab2: afterShift2.checkbox?.visible ?? null,
  }
  fs.writeFileSync(path.join(dataDir, 'k3b.json'), JSON.stringify(record, null, 2) + '\n')
  log('[K3ⓑ]', record)
  await pressKey('Escape')
  await until(async () => !(await modalOpen()), { timeoutMs: 5_000, label: '확인 창 닫힘(Esc 2)' })
}

// --- 실행 ----------------------------------------------------------------------
let code = 0
try {
  log(`# LIFE-693 g1 · scenario=${scenario} build=${build} root=${root} session=${session} port=${port} · HEAD ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP, encoding: 'utf8' }).trim()} · ${new Date().toISOString()}`)
  if (scenario === 'tabs') makeRepo(repo)
  sh(['scripts/l693/fixture-app.sh', `/tmp/l693q-out-${build}`, appDir])
  await up()
  if (scenario === 'orphan') await orphanScene()
  else await tabsScene()
} catch (error) {
  code = 1
  log('[실패]', String(error?.stack ?? error).replaceAll(os.homedir(), '~'))
  await measure('failure-state').catch(() => null)
} finally {
  log('보낸 입력', sent)
  fs.writeFileSync(path.join(dataDir, 'sent-input.json'), JSON.stringify(sent, null, 2) + '\n')
  try { cdpSocket?.close() } catch {}
  // 격리 확인 원자료는 ud 를 지우기 전에 — 앱을 내린 뒤 로그를 읽는다.
  try { down() } catch (error) { code = 1; log('down 실패', String(error)) }
  log(`# exit ${code}`)
  process.exit(code)
}
