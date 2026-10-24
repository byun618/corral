// LIFE-675 최종 관문 g1 — 격리 GUI 실측(K1–K5). 앱 기동 하나 = 새 ROOT(/tmp/l675q-*) · 새 herdr 이름 세션, 그 안에서 장면을 차례로 잰다.
//
// 격리: l675/up.sh(= l693/up.sh 사본) — userData·제어 소켓·설정 전부 ROOT 아래, herdr 는 레포 guard 바이너리의 이름 세션 `l675q-<꼬리>`.
//   설치본·사용자 userData·사용자 herdr 무접촉. 앱은 빌드 산출물 사본(fixture-app.sh — 창 showInactive)으로 띄운다.
// 입력: 클릭 = CDP `Input.dispatchMouseEvent`(요소 가운데 좌표, 격리 페이지 대상 — `click()` 직접 호출 아님). OS 입력 이벤트 없음.
//   K3 만 격리 런타임 소켓을 명시한 CLI `worktree create --activate`.
// 측정(STATE_JS): 덮개 수 · 작업 페이지 is-closed · 상태바 라벨 · 선택 pane · activeElement(태그·클래스·가장 가까운 pane 상자) · app-body inert.
// 「대상 노출」 = ⓐ 라벨 = `corral / <대상 브랜치>` ⓑ 선택 pane = 대상 ⓒ activeElement 가 그 상자 안. 클릭 뒤 20ms 간격으로 2초까지 본다.
// 판정은 하지 않는다 — 수치 JSON + PNG 를 남기고 항목별 대조는 g1-summary.md 에서 한다.
// 사용(app/ 에서): node scripts/l675/g.mjs --build impl|base --root /tmp/l675q-<x> --port <CDP 포트> --out <raw txt>
/* global fetch, WebSocket */ // Node 22+ 전역(CDP 접속)
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const { build, root } = args
const port = Number(args.port)
if (!/^\/tmp\/l675q-[a-z0-9-]+$/.test(root ?? '')) throw new Error(`--root 는 /tmp/l675q-*: ${root}`)
if (build !== 'impl' && build !== 'base') throw new Error('--build impl|base')
const out = path.resolve(args.out)
const dataDir = out.replace(/\.txt$/, '')
fs.mkdirSync(dataDir, { recursive: true })
const log = recorder(out)
const session = `l675q-${path.basename(root).replace(/^l675q-/, '')}`
const herdrSock = path.join(os.homedir(), '.config/herdr-dev/sessions', session, 'herdr.sock')
const appDir = `${root}-app`
const repo = path.join(root, 'repo')
const repoB = path.join(root, 'repo-b')
const DEADLINE_MS = 2000
const sent = { clicks: 0, cli: 0 }
const uptime = () => execFileSync('uptime', { encoding: 'utf8' }).trim()

// --- 바깥 도구 -----------------------------------------------------------------
const sh = (argv, env = {}) => {
  const run = spawnSync('sh', argv, { cwd: APP, encoding: 'utf8', env: { ...process.env, ...env } })
  log(`$ sh ${argv.join(' ')} → exit ${run.status}`)
  log((run.stdout + run.stderr).trim().replaceAll(os.homedir(), '~'))
  if (run.status !== 0) throw new Error(`${argv[0]} 실패`)
}
function herdr(method, params = {}, timeoutMs = 10_000) {
  if (!session.startsWith('l675q-')) throw new Error(`거부: 격리 세션이 아니다 (${session})`)
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(herdrSock)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr 시간 초과 ${method}`)) }, timeoutMs)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l675', method, params }) + '\n'))
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
/** 요소 가운데를 CDP 마우스로 누른다 — 가운데의 elementFromPoint 가 그 요소(또는 자손)가 아니면 누르지 않고 실패. */
async function click(selector) {
  const point = await until(() => js(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)})
    if (!e) return null
    const b = e.getBoundingClientRect()
    const x = b.left + b.width / 2, y = b.top + b.height / 2
    const at = document.elementFromPoint(x, y)
    return at && (at === e || e.contains(at)) ? { x, y } : null
  })()`), { timeoutMs: 10_000, everyMs: 150, label: `click 대상 ${selector}` }).catch(() => null)
  if (point === null) throw new Error(`click 실패(없음·가려짐) ${selector}`)
  const { x, y } = point.value
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  sent.clicks += 1
  return { x: +x.toFixed(1), y: +y.toFixed(1), at: Date.now() }
}

// --- 측정 ----------------------------------------------------------------------
const STATE_JS = `(() => {
  const active = document.activeElement
  const box = active ? active.closest('[data-term-pane-box]') : null
  const body = document.querySelector('.app-body')
  const tasks = document.querySelector('[data-tasks-page]')
  return {
    overlays: document.querySelectorAll('[data-settings-overlay]').length,
    settingsSection: document.querySelector('[data-settings-nav-item][aria-current="page"]')?.getAttribute('data-settings-nav-item') ?? null,
    tasksPage: tasks === null ? 'absent' : tasks.classList.contains('is-closed') ? 'closed' : 'open',
    label: document.querySelector('.statusbar-repo')?.textContent ?? null,
    selected: [...document.querySelectorAll('.is-selected[data-term-pane-box]')].map((e) => e.getAttribute('data-term-pane-box')),
    active: active ? { tag: active.tagName.toLowerCase(), className: String(active.className || ''), paneBox: box ? box.getAttribute('data-term-pane-box') : null } : null,
    appBodyInert: body ? body.inert === true || body.hasAttribute('inert') : null,
    resourcePanel: !!document.querySelector('[data-statusbar-resource-panel]'),
    hasFocus: document.hasFocus(),
  }
})()`
const exposed = (s, target) => ({ a: s.label === `corral / ${target.branch}`, b: s.selected.includes(target.paneId), c: s.active?.paneBox === target.paneId })
async function shot(tag) {
  const result = await ctl(root, { cmd: 'shot', name: tag }).catch((error) => ({ error: String(error) }))
  if (!result.file) { log('shot 실패', result); return null }
  const target = path.join(dataDir, `${tag}.png`)
  fs.copyFileSync(result.file, target)
  log('shot', { file: path.relative(path.resolve(APP, '..'), target), bytes: fs.statSync(target).size })
  return path.basename(target)
}
/** 시작 시각부터 2초까지 20ms 간격으로 상태를 본다 — 노출 ⓐⓑⓒ 각각이 처음 참이 된 ms 와 마지막 상태. */
async function watch(startedAt, target) {
  const first = { a: null, b: null, c: null, all: null }
  let last = null
  for (;;) {
    last = await js(STATE_JS)
    const ms = Date.now() - startedAt
    const e = exposed(last, target)
    for (const key of ['a', 'b', 'c']) if (e[key] && first[key] === null) first[key] = ms
    if (e.a && e.b && e.c && first.all === null) first.all = ms
    if (ms >= DEADLINE_MS || first.all !== null) break
    await sleep(20)
  }
  return { firstMs: first, last }
}

// --- 준비 ----------------------------------------------------------------------
function makeRepo() {
  fs.mkdirSync(repo, { recursive: true })
  fs.writeFileSync(path.join(repo, 'l675.md'), '# l675\n')
  const git = (...argv) => execFileSync('git', argv, { encoding: 'utf8' })
  git('init', '-q', '-b', 'main', repo)
  git('-C', repo, 'add', '.')
  git('-C', repo, '-c', 'user.name=l675', '-c', 'user.email=l675@example.invalid', 'commit', '-q', '-m', 'fixture')
  git('-C', repo, 'worktree', 'add', '-q', '-b', 'feat-b', repoB)
  log('repo', { commands: [`git init -b main ${repo}`, 'git add · commit', `git -C ${repo} worktree add -b feat-b ${repoB}`] })
}
async function workspaceOf(worktreePath) {
  const real = fs.realpathSync(worktreePath)
  const st = (await ctl(root, { cmd: 'state' })).state
  for (const r of st.repos) for (const wt of r.worktrees) if (wt.workspace !== null && (wt.path === worktreePath || wt.path === real)) return wt.workspace
  return null
}
async function up() {
  sh(['scripts/l675/up.sh', root, 'CORRAL_WINDOW=1180x800', `L675_EXTRA_ARGS=--remote-debugging-port=${port}`], { L675_APP_DIR: appDir })
  await until(() => js(`!!document.querySelector('[data-sidebar]')`), { timeoutMs: 30_000, label: '렌더러(사이드바)' })
  await cdpConnect()
  await sleep(1000)
}
const down = () => sh(['scripts/l675/down.sh', root, 'herdr'])
async function fixture() {
  const added = await ctl(root, { cmd: 'add-repo', root: repo })
  if (!added.ok) throw new Error(`add-repo 실패 ${JSON.stringify(added).slice(0, 200)}`)
  await herdr('workspace.create', { cwd: repo, focus: false })
  const wsA = (await until(() => workspaceOf(repo), { timeoutMs: 15_000, label: 'repo 워크스페이스' })).value
  await herdr('tab.create', { workspace_id: wsA.workspaceId, cwd: repo, focus: false })
  await until(async () => (await workspaceOf(repo))?.tabs.length === 2, { timeoutMs: 15_000, label: 'repo 탭 2' })
  await herdr('workspace.create', { cwd: repoB, focus: false })
  await until(() => workspaceOf(repoB), { timeoutMs: 15_000, label: 'repo-b 워크스페이스' })
  const a = await workspaceOf(repo)
  const b = await workspaceOf(repoB)
  const panes = {
    A1: { paneId: a.tabs[0].panes[0].paneId, branch: 'main', where: 'repo 탭 1' },
    A2: { paneId: a.tabs[1].panes[0].paneId, branch: 'main', where: 'repo 탭 2' },
    B1: { paneId: b.tabs[0].panes[0].paneId, branch: 'feat-b', where: 'repo-b(feat-b) 탭 1' },
  }
  log('fixture', { commands: [`ctl add-repo ${repo}`, `herdr --session ${session} rpc workspace.create {cwd: repo}`, 'herdr rpc tab.create {workspace_id: repo, cwd: repo}', 'herdr rpc workspace.create {cwd: repo-b}'], panes })
  return panes
}
async function openPanel() {
  if (!(await js(`!!document.querySelector('[data-statusbar-resource-panel]')`))) await click('[data-statusbar-resource]')
  await until(() => js(`!!document.querySelector('[data-statusbar-resource-panel]')`), { timeoutMs: 8_000, label: '리소스 패널' })
}
async function clickRow(paneId) {
  await openPanel()
  await until(() => js(`!!document.querySelector('[data-statusbar-resource-row="${paneId}"]')`), { timeoutMs: 20_000, everyMs: 250, label: `행 ${paneId}` })
  return click(`[data-statusbar-resource-row="${paneId}"]`)
}
/** 덮개를 걷고 A1 로 — 다음 장면의 출발점(설정 닫힘 · 작업 페이지 닫힘 · A1 선택·포커스). */
async function reset(panes) {
  const s = await js(STATE_JS)
  if (s.overlays > 0) { await click('[data-settings-back]'); await until(async () => (await js(STATE_JS)).overlays === 0, { timeoutMs: 5_000, label: '설정 닫힘' }) }
  if ((await js(STATE_JS)).tasksPage === 'open') { await click('[data-tasks-open]'); await until(async () => (await js(STATE_JS)).tasksPage !== 'open', { timeoutMs: 5_000, label: '작업 페이지 닫힘' }) }
  const startedAt = (await clickRow(panes.A1.paneId)).at
  const seen = await watch(startedAt, panes.A1)
  await sleep(300)
  const ready = await js(STATE_JS)
  log('reset → A1', { firstMs: seen.firstMs, state: ready })
  if (!exposed(ready, panes.A1).b) throw new Error('reset: A1 선택 실패')
}

// --- 장면 ----------------------------------------------------------------------
const results = []
async function record(tag, input) {
  await sleep(300)
  const after = await js(STATE_JS)
  const png = await shot(tag)
  const row = { tag, build, at: new Date().toISOString(), uptime: uptime(), ...input, after, exposedAfter: input.target ? exposed(after, input.target) : null, png }
  results.push(row)
  fs.writeFileSync(path.join(dataDir, `${tag}.json`), JSON.stringify(row, null, 2) + '\n')
  log(`[장면] ${tag}`, { firstMs: input.firstMs, after: { overlays: after.overlays, tasksPage: after.tasksPage, label: after.label, selected: after.selected, active: after.active, inert: after.appBodyInert } })
  return row
}
/** cover: none|settings|tasks · section: shortcuts|connections · to: 대상 pane 키. */
async function moveScene(panes, { tag, cover, section = 'shortcuts', to }) {
  await reset(panes)
  if (cover === 'settings') {
    await click('[data-settings-open]')
    await until(async () => (await js(STATE_JS)).overlays === 1, { timeoutMs: 5_000, label: '설정 열림' })
    if (section !== 'shortcuts') await click(`[data-settings-nav-item="${section}"]`)
    await until(async () => (await js(STATE_JS)).settingsSection === section, { timeoutMs: 5_000, label: `설정 섹션 ${section}` })
  } else if (cover === 'tasks') {
    await click('[data-tasks-open]')
    await until(async () => (await js(STATE_JS)).tasksPage === 'open', { timeoutMs: 5_000, label: '작업 페이지 열림' })
  }
  await sleep(300)
  const before = await js(STATE_JS)
  await shot(`${tag}-before`)
  const target = panes[to]
  const clicked = await clickRow(target.paneId)
  const seen = await watch(clicked.at, target)
  return record(tag, { scene: { cover, section: cover === 'settings' ? section : null, to, ...target }, uptimeBefore: uptime(), clicked, before, firstMs: seen.firstMs, atDeadline: seen.last, target })
}
async function cliScene(panes) {
  const tag = 'k3-cli-settings'
  await reset(panes)
  await click('[data-settings-open]')
  await until(async () => (await js(STATE_JS)).overlays === 1, { timeoutMs: 5_000, label: '설정 열림' })
  await sleep(300)
  const before = await js(STATE_JS)
  await shot(`${tag}-before`)
  const socket = path.join(root, 'ud/runtime/rpc.sock')
  // `--socket` 은 서버까지 넘어가 worktree create 가 모르는 플래그로 거절한다(impl-1 K3) — 소켓은 환경변수로만 준다.
  // 이 워커 pane 의 HERDR_*·CORRAL_* 환경(사용자 herdr 의 pane 정체)은 격리 런타임에 넘기지 않는다.
  const argv = [path.join(APP, 'cli/corral.mjs'), 'worktree', 'create', '--name', 'g1-k3', '--activate']
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HERDR_') && !key.startsWith('CORRAL_')))
  const startedAt = Date.now()
  const run = spawnSync(process.execPath, argv, { cwd: repo, encoding: 'utf8', env: { ...env, CORRAL_RUNTIME_SOCKET: socket }, timeout: 60_000 })
  sent.cli += 1
  const cliMs = Date.now() - startedAt
  const cli = { command: `cd ${repo} && env -u HERDR_* -u CORRAL_* CORRAL_RUNTIME_SOCKET=${socket} ${process.execPath} ${argv.join(' ')}`, exit: run.status, ms: cliMs, stdout: run.stdout, stderr: run.stderr }
  fs.writeFileSync(path.join(dataDir, `${tag}-cli.json`), JSON.stringify(cli, null, 2) + '\n')
  log('[K3 CLI]', { exit: run.status, ms: cliMs, stdout: run.stdout.slice(0, 400), stderr: run.stderr.slice(0, 400) })
  const created = path.join(repo, '.claude/worktrees/g1-k3')
  const ws = (await until(() => workspaceOf(created), { timeoutMs: 10_000, label: 'g1-k3 워크스페이스' }).catch(() => ({ value: null }))).value
  const target = { paneId: ws?.tabs[0]?.panes[0]?.paneId ?? null, branch: 'g1-k3', where: 'CLI 로 만든 g1-k3 탭 1' }
  const afterCliStart = Date.now()
  const seen = await watch(afterCliStart, target)
  return record(tag, { scene: { cover: 'settings', section: 'shortcuts', to: 'CLI', ...target }, uptimeBefore: uptime(), clicked: null, cli: { exit: run.status, ms: cliMs }, before, firstMs: seen.firstMs, firstMsFrom: 'CLI 반환 시각(창 상태는 CLI 도중에 이미 바뀌었을 수 있다)', atDeadline: seen.last, target })
}
const passed = (row) => row.firstMs.all !== null && row.after.overlays === 0 && row.after.tasksPage !== 'open' && row.after.appBodyInert === false
/** 2초 기한 실패면 같은 장면을 1회 더(두 회차 모두 남는다). */
async function sceneWithRetry(panes, spec) {
  const row = await moveScene(panes, spec)
  if (build === 'impl' && !passed(row)) {
    log(`[재시도] ${spec.tag} — 1회차 미달`, { firstMs: row.firstMs, load: row.uptime })
    await moveScene(panes, { ...spec, tag: `${spec.tag}-retry` })
  }
}

// --- 실행 ----------------------------------------------------------------------
let code = 0
try {
  log(`# LIFE-675 g1 · build=${build} root=${root} session=${session} port=${port} · HEAD ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP, encoding: 'utf8' }).trim()} · ${new Date().toISOString()}`)
  log(`# uptime ${uptime()}`)
  makeRepo()
  sh(['scripts/l675/fixture-app.sh', `/tmp/l675q-out-${build}`, appDir])
  await up()
  const panes = await fixture()
  if (build === 'impl') {
    await sceneWithRetry(panes, { tag: 'k4a-none-other-wt', cover: 'none', to: 'B1' })
    await sceneWithRetry(panes, { tag: 'k1-settings-shortcuts-other-wt', cover: 'settings', section: 'shortcuts', to: 'B1' })
    await sceneWithRetry(panes, { tag: 'k1-settings-connections-other-wt', cover: 'settings', section: 'connections', to: 'B1' })
    await sceneWithRetry(panes, { tag: 'k1-settings-same-wt-other-tab', cover: 'settings', section: 'shortcuts', to: 'A2' })
    await sceneWithRetry(panes, { tag: 'k1-settings-already-selected', cover: 'settings', section: 'shortcuts', to: 'A1' })
    await sceneWithRetry(panes, { tag: 'k2-tasks-other-wt', cover: 'tasks', to: 'B1' })
    const k3 = await cliScene(panes)
    if (!passed(k3)) log('[K3] 1회차 미달 — CLI 장면은 새 worktree 이름이 필요해 같은 회차 안에서 재시도하지 않는다', { firstMs: k3.firstMs })
  } else {
    await moveScene(panes, { tag: 'k4a-none-other-wt', cover: 'none', to: 'B1' })
    await moveScene(panes, { tag: 'k5-settings-shortcuts-other-wt', cover: 'settings', section: 'shortcuts', to: 'B1' })
  }
} catch (error) {
  code = 1
  log('[실패]', String(error?.stack ?? error).replaceAll(os.homedir(), '~'))
  await js(STATE_JS).then((s) => log('failure-state', s)).catch(() => null)
  await shot('failure-state').catch(() => null)
} finally {
  log('보낸 입력', sent)
  fs.writeFileSync(path.join(dataDir, 'sent-input.json'), JSON.stringify(sent, null, 2) + '\n')
  fs.writeFileSync(path.join(dataDir, 'results.json'), JSON.stringify(results, null, 2) + '\n')
  try { cdpSocket?.close() } catch { /* 이미 닫힌 소켓 — 정리 단계라 무시 */ }
  try { down() } catch (error) { code = 1; log('down 실패', String(error)) }
  log(`# exit ${code}`)
  process.exit(code)
}
