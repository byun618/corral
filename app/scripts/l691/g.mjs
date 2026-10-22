// LIFE-691 최종 관문 g1 — 격리 GUI 회차(K3 ⓐ–ⓔ · K3+ ⓕ–ⓝ). 회차 하나 = 새 ROOT(/tmp/l691q-*) · 새 herdr 이름 세션 · 새 fixture 레포.
//
// 격리: l691/up.sh(= l670/up.sh 사본) — userData·제어 소켓·ui-prefs·레지스트리 전부 ROOT 아래, herdr 는 레포 guard 바이너리의 이름 세션 `l691q-<꼬리>`.
//   설치본·사용자 userData·사용자 herdr·실제 LA 무접촉. 앱은 빌드 산출물 사본(fixture-app.sh — 창 showInactive · preload 커밋 순서 기록)으로 띄운다.
// 입력: 제어 소켓(click·dblclick·key·type = webContents.sendInputEvent) — OS 키 입력(CGEvent) 없음. 창은 비활성으로 떠 사용자 키보드 포커스를 가져가지 않는다.
// 관측(dump):
//   · 화면 — 활성 영역(`.tab-group.is-active-group`), 영역별 탭 순서·활성 탭(`[data-main-tab]` data-active)
//   · 선택 pane = `lifecycle.selectedPane` — 사이드바 컴포넌트에 넘기는 prop 그대로(React fiber 의 memoizedProps.selectedPane, App.tsx `<Sidebar selectedPane={lifecycle.selectedPane}>`)
//   · DOM 포커스 터미널(`document.activeElement` 의 `[data-term-pane]`) · pane → 탭 대응은 제어 소켓 `state`
//   · 문자열 입력 도착 = 제어 소켓 `type`(sendInputEvent char) 뒤 herdr `pane.read` 로 **각 pane 화면**에서 표지를 찾는다(그 뒤 ⌃U 로 지움)
// 판정: 항목마다 통과/미달. 타임아웃·못 찾음·예외는 미달로 전파한다(exit 1).
// 사용(app/ 에서): node scripts/l691/g.mjs --scenario <a|b|c|d|e|f|g|h|i|j|k|l|m|n> --root /tmp/l691q-<x> --build impl|base --out <raw txt> [--restarts 3]
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { ctl, evalJs, recorder, sleep, until } from '../l577/g-lib.mjs'

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const BASE_APP = path.resolve(APP, '../../LIFE-691-tab-close-focus-base/app')
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const scenario = args.scenario
const root = args.root
const build = args.build ?? 'impl'
if (!/^\/tmp\/l691q-[a-z0-9-]+$/.test(root ?? '')) throw new Error(`--root 는 /tmp/l691q-*: ${root}`)
if (build !== 'impl' && build !== 'base') throw new Error('--build impl|base')
const out = path.resolve(args.out)
const shotDir = out.replace(/\.txt$/, '-shots')
const log = recorder(out)
const verdicts = []
const judge = (item, pass, detail) => {
  verdicts.push({ item, pass })
  log(`[판정] ${item} ${pass ? '통과' : '미달'}`, detail ?? '')
}
const note = (item, detail) => log(`[기록] ${item}`, detail ?? '')
const session = `l691q-${path.basename(root).replace(/^l691q-/, '')}`
const herdrSock = path.join(os.homedir(), '.config/herdr-dev/sessions', session, 'herdr.sock')
const repo = path.join(root, 'repo')
const repo2 = path.join(root, 'repo2')
const appDir = `${root}-app`

// --- 바깥 도구 -----------------------------------------------------------------
const sh = (argv, env = {}) => {
  const run = spawnSync('sh', argv, { cwd: APP, encoding: 'utf8', env: { ...process.env, ...env } })
  log(`$ sh ${argv.join(' ')} → exit ${run.status}`)
  log((run.stdout + run.stderr).trim().replaceAll(os.homedir(), '~'))
  if (run.status !== 0) throw new Error(`${argv[0]} 실패`)
}
function herdr(method, params = {}, timeoutMs = 10_000) {
  if (!session.startsWith('l691q-')) throw new Error(`거부: 격리 세션이 아니다 (${session})`)
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(herdrSock)
    socket.setEncoding('utf8')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`herdr 시간 초과 ${method}`)) }, timeoutMs)
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'l691', method, params }) + '\n'))
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
const key = (keyCode, modifiers = [], type = undefined) => ctl(root, { cmd: 'key', keyCode, modifiers, ...(type === undefined ? {} : { type }) })
async function click(selector, cmd = 'click') {
  let last = null
  await until(async () => { last = await ctl(root, { cmd, selector }); return last.ok }, { timeoutMs: 10_000, everyMs: 250, label: `${cmd} ${selector}` }).catch(() => null)
  if (!last?.ok) throw new Error(`${cmd} 실패 ${selector} ${JSON.stringify(last)}`)
}
async function shot(name) {
  const result = await ctl(root, { cmd: 'shot', name }).catch((error) => ({ error: String(error) }))
  if (!result.file) { log('shot 실패', result); return }
  fs.mkdirSync(shotDir, { recursive: true })
  const target = path.join(shotDir, `${name}.png`)
  fs.copyFileSync(result.file, target)
  log('shot', { file: path.relative(path.resolve(APP, '..'), target), bytes: fs.statSync(target).size })
}

// --- 상태 ----------------------------------------------------------------------
const appState = async () => (await ctl(root, { cmd: 'state' })).state
async function workspaceOf(repoPath) {
  const real = fs.realpathSync(repoPath)
  const st = await appState()
  for (const r of st.repos) for (const wt of r.worktrees) if (wt.workspace !== null && (wt.path === repoPath || wt.path === real)) return wt.workspace
  return null
}
/** pane → 탭 (전 worktree). */
async function paneMap() {
  const st = await appState()
  const map = {}
  for (const r of st.repos) for (const wt of r.worktrees) for (const tab of wt.workspace?.tabs ?? []) for (const pane of tab.panes) map[pane.paneId] = { tabId: tab.tabId, workspaceId: tab.workspaceId, focused: pane.focused }
  return map
}
const DUMP_JS = `(() => {
  const sidebar = document.querySelector('[data-sidebar]')
  let selected = '<sidebar 없음>'
  if (sidebar !== null) {
    const fiberKey = Object.keys(sidebar).find((k) => k.startsWith('__reactFiber$'))
    let fiber = fiberKey === undefined ? null : sidebar[fiberKey]
    while (fiber && !(fiber.memoizedProps && typeof fiber.memoizedProps === 'object' && 'selectedPane' in fiber.memoizedProps && 'activeWorkspaceId' in fiber.memoizedProps)) fiber = fiber.return
    selected = fiber ? fiber.memoizedProps.selectedPane : '<fiber 못 찾음>'
  }
  const groups = [...document.querySelectorAll('.tab-group[data-tab-group]')].map((g) => ({
    groupId: g.dataset.tabGroup,
    active: g.classList.contains('is-active-group'),
    tabs: [...g.querySelectorAll('[data-main-tab]')].map((t) => t.dataset.mainTab),
    activeTab: g.querySelector('[data-main-tab][data-active="true"]')?.dataset.mainTab ?? null,
  }))
  const activeGroup = groups.find((g) => g.active) ?? null
  return {
    activeGroupId: activeGroup?.groupId ?? null,
    activeTab: activeGroup?.activeTab ?? null,
    selectedPane: selected,
    focusTermPane: document.activeElement?.closest('[data-term-pane]')?.dataset.termPane ?? null,
    activeElement: document.activeElement?.tagName ?? null,
    stripSelected: document.querySelector('[data-pane-strip-item].is-selected')?.dataset.paneStripItem ?? null,
    groups,
    order: typeof window.corral.l691Order === 'function' ? window.corral.l691Order() : null,
  }
})()`
async function dump(label, { capture = true } = {}) {
  const dom = await js(DUMP_JS)
  const panes = await paneMap()
  const selectedTab = typeof dom.selectedPane === 'string' ? (panes[dom.selectedPane]?.tabId ?? null) : null
  const herdrFocused = Object.entries(panes).filter(([, v]) => v.focused).map(([paneId, v]) => ({ paneId, tabId: v.tabId }))
  const row = { label, ...dom, order: undefined, selectedTab, herdrFocused }
  log(`[덤프] ${label}`, row)
  if (capture) await shot(label)
  return { ...row, order: dom.order }
}
/** 표지 문자열을 쳐서 어느 pane 화면에 나타나는지(전 pane). 표지는 ⌃U 로 지운다. */
async function typeProbe(label) {
  const marker = `l691${label.replace(/[^a-z0-9]/gi, '')}${Date.now() % 100000}`
  await ctl(root, { cmd: 'type', text: marker })
  const panes = Object.keys(await paneMap())
  let landed = []
  await until(async () => {
    landed = []
    for (const paneId of panes) {
      const text = await herdr('pane.read', { pane_id: paneId, source: 'visible', format: 'text', strip_ansi: true }).then((r) => r.read?.text ?? '', () => '')
      // 좁은 pane 에서는 표지가 줄바꿈된다(g-l-1·2 하네스 미달 원인) — 줄바꿈·줄 끝 공백을 걷고 찾는다.
      if (text.split('\n').map((line) => line.trimEnd()).join('').includes(marker)) landed.push(paneId)
    }
    return landed.length > 0
  }, { timeoutMs: 5_000, everyMs: 300, label: `표지 ${marker}` }).catch(() => null)
  if (landed.length === 0) {
    // 못 찾음 진단 — 각 pane 화면 끝 줄 · 렌더러 xterm 버퍼(term-read) · 렌더러가 보낸 입력 링(진단 실행일 때).
    for (const paneId of panes) {
      const text = await herdr('pane.read', { pane_id: paneId, source: 'visible', format: 'text', strip_ansi: true }).then((r) => r.read?.text ?? '', (e) => `오류 ${e}`)
      log(`[진단] ${paneId} 화면 끝`, text.trimEnd().split('\n').slice(-3))
    }
    log('[진단] term-read', await ctl(root, { cmd: 'term-read' }).catch((e) => String(e)))
    log('[진단] activeElement', await js(`({ tag: document.activeElement?.tagName, cls: String(document.activeElement?.className ?? ''), term: document.activeElement?.closest('[data-term-pane]')?.dataset.termPane ?? null, composing: document.activeElement?.closest('.xterm')?.querySelector('.composition-view')?.classList.contains('active') ?? null, hasFocus: document.hasFocus() })`))
  }
  await key('U', ['control'])
  log(`[입력] ${label}`, { marker, landed })
  return landed
}

// --- 준비 ----------------------------------------------------------------------
function makeRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text)
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=l691', '-c', 'user.email=l691@example.invalid', 'commit', '-q', '-m', 'fixture'])
}
async function up() {
  sh(['scripts/l691/up.sh', root, 'L691_EXTRA_ARGS=--disable-backgrounding-occluded-windows'], { L691_APP_DIR: appDir })
  await until(() => js(`!!document.querySelector('[data-sidebar]')`), { timeoutMs: 30_000, label: '렌더러(사이드바)' })
}
const down = (withHerdr = false) => sh(['scripts/l691/down.sh', root, ...(withHerdr ? ['herdr'] : [])])
/** 첫 기동: fixture 레포 → 앱 → 레포 등록 → herdr 워크스페이스 + 터미널 탭 n개. 탭 id 를 순서대로 돌려준다. */
async function boot({ terminals, secondRepo = false }) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  makeRepo(repo, { 'l691-a.md': '# 파일1\n\nl691 a\n', 'l691-b.md': '# 파일2\n\nl691 b\n', 'l691-c.md': '# 파일3\n' })
  if (secondRepo) makeRepo(repo2, { 'l691-z.md': '# 다른 worktree\n' })
  sh(['scripts/l691/fixture-app.sh', build === 'base' ? BASE_APP : APP, appDir])
  await up()
  await ctl(root, { cmd: 'resize-window', width: 1400, height: 860 }).catch(() => null)
  const added = await ctl(root, { cmd: 'add-repo', root: repo })
  if (!added.ok) throw new Error(`add-repo 실패 ${JSON.stringify(added).slice(0, 200)}`)
  const ws = await herdr('workspace.create', { cwd: repo, focus: false })
  log('workspace.create', ws)
  const wsId = (await until(async () => (await workspaceOf(repo))?.workspaceId ?? null, { timeoutMs: 15_000, label: '워크스페이스 도착' })).value
  for (let i = 1; i < terminals; i += 1) await herdr('tab.create', { workspace_id: wsId, cwd: repo, focus: false })
  await until(async () => (await workspaceOf(repo))?.tabs.length === terminals, { timeoutMs: 15_000, label: `터미널 탭 ${terminals}` })
  const tabs = (await workspaceOf(repo)).tabs.map((tab) => tab.tabId)
  await until(() => js(`document.querySelectorAll('[data-main-tab]').length === ${terminals}`), { timeoutMs: 15_000, label: '화면 탭' })
  // 셸 프롬프트가 뜰 때까지(표지 입력이 프롬프트에 찍히게).
  await sleep(1500)
  log('boot', { wsId, tabs })
  return { wsId, tabs }
}
const paneOfTab = async (tabId) => (await workspaceOf(repo)).tabs.find((tab) => tab.tabId === tabId)?.panes.map((pane) => pane.paneId) ?? []
async function activate(tabId) {
  await click(`[data-main-tab="${tabId}"]`)
  await until(async () => (await js(DUMP_JS)).activeTab === tabId, { timeoutMs: 5_000, label: `활성 ${tabId}` })
  await sleep(300)
}
async function openFile(rel) {
  const panelOpen = async () => (await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
  if (!(await panelOpen())) await key('L', ['meta'])
  await until(panelOpen, { timeoutMs: 5_000, label: '탐색기' })
  await until(() => js(`!!document.querySelector('[data-explorer-row="${rel}"]')`), { timeoutMs: 10_000, label: `탐색기 행 ${rel}` })
  await click(`[data-explorer-row="${rel}"]`, 'dblclick')
  await until(() => js(`document.querySelector('[data-file-tab="${rel}"]')?.dataset.active === 'true'`), { timeoutMs: 8_000, label: `파일 탭 ${rel}` })
  await sleep(300)
}
async function closeTab(tabId) {
  await click(`[data-main-tab-close="${tabId}"]`)
  await until(() => js(`document.querySelector('[data-main-tab="${tabId}"]') === null`), { timeoutMs: 10_000, label: `닫힘 ${tabId}` })
  await sleep(800)
}
const F1 = 'file:l691-a.md'
const F2 = 'file:l691-b.md'

// --- 시나리오 ------------------------------------------------------------------
/** [세션1, 세션2, 파일1, 파일2] — 세션2 활성에서 파일1·파일2 를 연다(열린 탭은 활성 뒤에 선다). */
async function fourTabs() {
  const { wsId, tabs } = await boot({ terminals: 2 })
  const [S1, S2] = tabs
  await activate(S2)
  await openFile('l691-a.md')
  await openFile('l691-b.md')
  const d = await dump('setup')
  const order = d.groups.find((g) => g.active)?.tabs ?? []
  judge('준비 [세션1,세션2,파일1,파일2] 파일2 활성', JSON.stringify(order) === JSON.stringify([S1, S2, F1, F2]) && d.activeTab === F2, { order, active: d.activeTab })
  return { wsId, S1, S2 }
}

const scenarios = {
  // K3ⓐ 파일2 × → 파일1
  async a() {
    await fourTabs()
    await closeTab(F2)
    const d = await dump('a-after-close-f2')
    judge('K3ⓐ 파일2 닫기 → 원 영역 파일1 활성', d.activeTab === F1, { activeTab: d.activeTab })
  },
  // K3ⓑ 파일2 새 영역으로(⌘⌥D 오른쪽) → 원 영역 파일1 · 포커스 새 영역
  async b() {
    await fourTabs()
    const before = await dump('b-before', { capture: false })
    await key('D', ['meta', 'alt'])
    await until(async () => (await js(DUMP_JS)).groups.length === 2, { timeoutMs: 5_000, label: '새 영역' })
    await sleep(500)
    const d = await dump('b-after-split')
    const origin = d.groups.find((g) => g.groupId === before.activeGroupId)
    const fresh = d.groups.find((g) => g.groupId !== before.activeGroupId)
    judge('K3ⓑ 원 영역 활성 = 파일1', origin?.activeTab === F1, { origin })
    judge('K3ⓑ 활성 영역 = 새 영역(파일2)', d.activeGroupId === fresh?.groupId && fresh?.activeTab === F2, { activeGroupId: d.activeGroupId, fresh })
  },
  // K3ⓒ 세션2 → 파일1 → 세션1 방문 뒤 세션1 닫기 → 파일1(MRU)
  async c() {
    const { S1, S2 } = await fourTabs()
    await activate(S2)
    await activate(F1)
    await activate(S1)
    await dump('c-before-close-s1')
    await closeTab(S1)
    const d = await dump('c-after-close-s1')
    judge('K3ⓒ 세션1 닫기 → 파일1 (MRU, 이웃이면 세션2)', d.activeTab === F1, { activeTab: d.activeTab })
  },
  // K3ⓓ 세션2 활성에서 세션2 닫기 → 선택 pane = 화면 활성 탭의 pane, 입력 도착. 화면 탭이 터미널이 되게 세션1 → 세션2 순으로 방문(MRU → 세션1).
  async d() {
    const { S1, S2 } = await fourTabs()
    await activate(S1)
    await activate(S2)
    // herdr 포커스를 다른 탭(세션1 이 아닌 곳)에 두지 않는다 — 세션2 를 닫으면 herdr 포커스는 herdr 가 정한다. 기록만 한다.
    await dump('d-before-close-s2')
    await closeTab(S2)
    const d = await dump('d-after-close-s2')
    const s1Panes = await paneOfTab(S1)
    judge('K3ⓓ 화면 활성 탭 = 세션1 (MRU)', d.activeTab === S1, { activeTab: d.activeTab })
    judge('K3ⓓ 선택 pane = 화면 활성 탭의 pane', d.selectedTab === d.activeTab && s1Panes.includes(d.selectedPane), { selectedPane: d.selectedPane, selectedTab: d.selectedTab })
    const landed = await typeProbe('d')
    judge('K3ⓓ 문자열 입력이 그 pane 에 도착', landed.length === 1 && landed[0] === d.selectedPane, { landed })
  },
  // K3ⓔ 재기동 뒤 가운데 탭 닫기 → 오른쪽 이웃
  async e() {
    const { tabs } = await boot({ terminals: 3 })
    const [, S2, S3] = tabs
    await activate(S2)
    await dump('e-before-restart')
    down()
    await up()
    await until(async () => (await js(DUMP_JS)).activeTab === S2, { timeoutMs: 15_000, label: '재기동 뒤 세션2 활성 복원' })
    await sleep(1000)
    await dump('e-after-restart')
    await closeTab(S2)
    const d = await dump('e-after-close-s2')
    judge('K3ⓔ 재기동 뒤 가운데(세션2) 닫기 → 오른쪽 세션3', d.activeTab === S3, { activeTab: d.activeTab })
  },
  // K3+ⓕ [세션1, 세션2, 파일1] 세션2 → 파일1 열기 → 파일1 닫기 → 세션2 · 선택 pane = 세션2 pane · 입력 도착
  async f() {
    const { tabs } = await boot({ terminals: 2 })
    const [, S2] = tabs
    await activate(S2)
    await openFile('l691-a.md')
    await dump('f-before-close-f1')
    await closeTab(F1)
    const d = await dump('f-after-close-f1')
    const s2Panes = await paneOfTab(S2)
    judge('K3+ⓕ 세션2 활성', d.activeTab === S2, { activeTab: d.activeTab })
    judge('K3+ⓕ 선택 pane = 세션2 pane', s2Panes.includes(d.selectedPane), { selectedPane: d.selectedPane, s2Panes })
    const landed = await typeProbe('f')
    judge('K3+ⓕ 입력이 세션2 에 도착', landed.length === 1 && s2Panes.includes(landed[0]), { landed })
  },
  // K3+ⓖ 세션2 선택 → 파일2 활성 → 파일2 새 영역으로 → 선택 pane 불변(K2ⓒ)
  async g() {
    const { S2 } = await fourTabs()
    await activate(S2)
    await activate(F2)
    const before = await dump('g-before-split')
    await key('D', ['meta', 'alt'])
    await until(async () => (await js(DUMP_JS)).groups.length === 2, { timeoutMs: 5_000, label: '새 영역' })
    await sleep(800)
    const d = await dump('g-after-split')
    judge('K3+ⓖ 활성 영역 = 새 영역의 파일2', d.activeTab === F2 && d.activeGroupId !== before.activeGroupId, { activeGroupId: d.activeGroupId, activeTab: d.activeTab })
    judge('K3+ⓖ 선택 pane 불변(세션2 pane)', d.selectedPane === before.selectedPane && before.selectedTab === S2, { before: before.selectedPane, after: d.selectedPane })
  },
  // K3+ⓗ 재기동 n회 — 저장 활성 = 세션2, herdr 포커스 = 세션3(≠ 저장 활성 · ≠ 첫 탭). 매 회 화면 활성 탭·선택 pane 의 탭·커밋 순서 기록.
  async h() {
    const restarts = Number(args.restarts ?? 3)
    const { tabs } = await boot({ terminals: 3 })
    const [, S2, S3] = tabs
    await activate(S2)
    const runs = []
    for (let i = 1; i <= restarts; i += 1) {
      const s3Pane = (await paneOfTab(S3))[0]
      await herdr('pane.focus', { pane_id: s3Pane })
      await until(async () => (await paneMap())[s3Pane]?.focused === true, { timeoutMs: 5_000, label: 'herdr 포커스 세션3' })
      await dump(`h-${i}-before-restart`, { capture: false })
      down()
      // 앱이 꺼진 동안 herdr 포커스가 세션3 인지(앱이 내려가며 바꾸지 않았는지) 확인.
      const focusedWhileDown = (await herdr('pane.list')).panes.filter((p) => p.focused).map((p) => p.pane_id)
      await up()
      await until(async () => (await js(DUMP_JS)).activeTab !== null, { timeoutMs: 15_000, label: '재기동 화면' })
      await sleep(2000)
      const d = await dump(`h-${i}-after-restart`)
      const row = { run: i, activeTab: d.activeTab, selectedPane: d.selectedPane, selectedTab: d.selectedTab, screenEqualsSelected: d.selectedTab === d.activeTab, focusedWhileDown, s3Pane, order: d.order }
      runs.push(row)
      note(`ⓗ 회차 ${i}`, row)
      // 다음 회차를 위해 저장 활성은 그대로 세션2(재기동이 바꾸지 않았는지 기록).
      if (d.activeTab !== S2) await activate(S2)
    }
    fs.writeFileSync(out.replace(/\.txt$/, '.json'), JSON.stringify({ build, S2, S3, runs }, null, 2) + '\n')
    judge(`K3+ⓗ 재기동 ${restarts}회 화면 활성 = 저장 활성 세션2(관측 완료)`, runs.length === restarts && runs.every((r) => r.activeTab === S2), { runs: runs.map((r) => ({ run: r.run, activeTab: r.activeTab, selectedTab: r.selectedTab })) })
    // 기준 대비 회귀 여부는 g-summary 가 base 회차 json 과 대조한다(여기서는 관측만).
  },
  // K3+ⓘ 분할 pane ⌘W(LIFE-508) 뒤 같은 탭 pane 선택 · ⌃Tab 한 번 뒤 화면 pane = MRU 맨 앞
  async i() {
    const { tabs } = await boot({ terminals: 2 })
    const [S1, S2] = tabs
    await activate(S1)
    await activate(S2)
    const firstPane = (await paneOfTab(S2))[0]
    await key('D', ['meta'])
    await until(async () => (await paneOfTab(S2)).length === 2, { timeoutMs: 8_000, label: '분할 pane' })
    await until(async () => { const d = await js(DUMP_JS); return d.selectedPane !== firstPane && typeof d.selectedPane === 'string' }, { timeoutMs: 5_000, label: '새 pane 선택' })
    const split = await dump('i-after-split')
    const newPane = split.selectedPane
    await key('W', ['meta'])
    await until(async () => (await paneOfTab(S2)).length === 1, { timeoutMs: 8_000, label: '분할 pane 닫힘' })
    await sleep(800)
    const closed = await dump('i-after-close-split-pane')
    judge('K3+ⓘ 분할 pane ⌘W 뒤 같은 탭(세션2) pane 선택(LIFE-508)', closed.selectedPane === firstPane && closed.activeTab === S2, { newPane, selectedPane: closed.selectedPane, firstPane })
    await key('Control', ['control'], 'keyDown')
    await key('Tab', ['control'], 'keyDown')
    await key('Tab', ['control'], 'keyUp')
    await sleep(200)
    await key('Control', [], 'keyUp')
    await sleep(1000)
    const mru = await dump('i-after-ctrl-tab')
    judge('K3+ⓘ ⌃Tab 한 번 → 세션1 · 화면 pane = 선택 pane(MRU 맨 앞)', mru.activeTab === S1 && mru.selectedTab === S1 && mru.selectedTab === mru.activeTab, { activeTab: mru.activeTab, selectedTab: mru.selectedTab })
  },
  // K3+ⓙ 핀 1개 + 활성 터미널 닫기 → 화면 순서 이웃(재기동 직후 MRU 없음). 터미널 [S1,S2,S3,S4] 활성 S4, 핀 S3 → 화면 [S3*,S1,S2,S4] → S4 닫기 → S2
  async j() {
    const { tabs } = await boot({ terminals: 4 })
    const [S1, S2, S3, S4] = tabs
    await activate(S4)
    const wsId = (await workspaceOf(repo)).workspaceId
    down()
    const prefsFile = path.join(root, 'ud/ui-prefs.json')
    const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'))
    note('ⓙ 저장값(핀 넣기 전)', { groupLayouts: prefs.groupLayouts, tabMarks: prefs.tabMarks ?? null })
    prefs.tabMarks = [...(Array.isArray(prefs.tabMarks) ? prefs.tabMarks : []), { tabId: S3, workspaceId: wsId, pinned: true, color: null }]
    fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2))
    await up()
    await until(async () => (await js(DUMP_JS)).activeTab === S4, { timeoutMs: 15_000, label: '재기동 뒤 S4 활성' })
    await sleep(1000)
    const before = await dump('j-after-restart-pinned')
    const order = before.groups.find((g) => g.active)?.tabs ?? []
    judge('K3+ⓙ 화면 순서 [S3*,S1,S2,S4]', JSON.stringify(order) === JSON.stringify([S3, S1, S2, S4]), { order })
    await closeTab(S4)
    const d = await dump('j-after-close-s4')
    judge('K3+ⓙ 활성 S4 닫기 → 화면 왼쪽 이웃 S2 (저장 순서 왼쪽이면 S3)', d.activeTab === S2, { activeTab: d.activeTab })
  },
  // K3+ⓚ 탐색기 삭제로 활성 파일 탭이 닫혀 새 활성이 터미널 → 선택 pane = 그 탭 pane · 입력 도착.
  //   판별 배치: [S1,S2,F1] 에서 S1 을 새 영역으로(선택 pane = S1) → 원 영역 F1 활성(선택 pane 은 S1 그대로) → 탐색기에서 F1 삭제 → 원 영역 S2
  async k() { await fileCloseFollow({ via: 'trash' }) },
  // K3+ⓛ 수정된 파일 닫기 확인 「저장 안 함」 경유 → ⓚ 와 같음
  async l() { await fileCloseFollow({ via: 'discard' }) },
  // K3+ⓜ ① 비활성 영역의 파일 탭 닫기 → 선택 pane 불변 ② worktree 전환 직후 닫기 → 선택 pane 이 다른 worktree 로 끌려가지 않음
  async m() {
    const { tabs } = await boot({ terminals: 2, secondRepo: true })
    const [, S2] = tabs
    await activate(S2)
    await openFile('l691-a.md')
    await key('D', ['meta', 'alt'])
    await until(async () => (await js(DUMP_JS)).groups.length === 2, { timeoutMs: 5_000, label: '새 영역(F1)' })
    await activate(S2)
    const before = await dump('m1-before-close-inactive-f1')
    await click(`[data-main-tab-close="${F1}"]`)
    await until(() => js(`document.querySelector('[data-main-tab="${F1}"]') === null`), { timeoutMs: 8_000, label: 'F1 닫힘' })
    await sleep(1000)
    const after = await dump('m1-after-close-inactive-f1')
    judge('K3+ⓜ① 비활성 영역 파일 닫기 → 선택 pane 불변', after.selectedPane === before.selectedPane && before.selectedTab === S2, { before: before.selectedPane, after: after.selectedPane })
    // ② 두 번째 worktree — 등록·워크스페이스. A 에서 F2 를 열고(활성 = 파일) 닫기 직후 B 로 전환.
    const added = await ctl(root, { cmd: 'add-repo', root: repo2 })
    if (!added.ok) throw new Error(`add-repo2 실패 ${JSON.stringify(added).slice(0, 200)}`)
    await herdr('workspace.create', { cwd: repo2, focus: false })
    const wsB = (await until(async () => (await workspaceOf(repo2))?.workspaceId ?? null, { timeoutMs: 15_000, label: 'B 워크스페이스' })).value
    await sleep(1000)
    await openFile('l691-b.md')
    await dump('m2-before-close-f2-switch')
    const realB = fs.realpathSync(repo2)
    const cardSel = await js(`(() => { const rows = [...document.querySelectorAll('[data-worktree]')]; const row = rows.find((r) => r.dataset.worktree === ${JSON.stringify(repo2)} || r.dataset.worktree === ${JSON.stringify(realB)}); return row ? '[data-worktree="' + row.dataset.worktree + '"] [data-worktree-card-surface]' : null })()`)
    if (cardSel === null) throw new Error('B 카드 못 찾음')
    // 닫기와 전환을 연달아 보낸다(기다리지 않음).
    await ctl(root, { cmd: 'click', selector: `[data-main-tab-close="${F2}"]` })
    await ctl(root, { cmd: 'click', selector: cardSel })
    await sleep(2500)
    const d = await dump('m2-after-close-switch')
    const panes = await paneMap()
    const selectedWs = typeof d.selectedPane === 'string' ? panes[d.selectedPane]?.workspaceId ?? null : null
    judge('K3+ⓜ② worktree 전환 직후 닫기 → 선택 pane 이 B 워크스페이스', selectedWs === wsB, { selectedPane: d.selectedPane, selectedWs, wsB })
  },
  // K3+ⓝ 격리 herdr 를 창을 띄운 채 재기동(같은 workspace id 재사용) → 화면 활성 탭 = 선택 pane 의 탭?
  async n() {
    const { wsId, tabs } = await boot({ terminals: 3 })
    const [, S2] = tabs
    await activate(S2)
    const before = await dump('n-before-herdr-restart')
    const herdrPid = Number(fs.readFileSync(path.join(root, 'herdr.pid'), 'utf8').trim())
    const listBefore = await herdr('workspace.list').catch((error) => ({ error: String(error) }))
    note('ⓝ herdr 재기동 전', { herdrPid, wsId, listBefore })
    process.kill(herdrPid, 'SIGTERM')
    await until(() => !fs.existsSync(herdrSock) || (() => { try { process.kill(herdrPid, 0); return false } catch { return true } })(), { timeoutMs: 10_000, label: 'herdr 내려감' })
    await sleep(1000)
    note('ⓝ 남은 세션 프로세스', spawnSync('sh', ['-c', `pgrep -f -- '--session ${session} ' || true`], { encoding: 'utf8' }).stdout.trim())
    const guard = execFileSync('sh', ['-c', `ps -o command= -p ${herdrPid} 2>/dev/null || true`], { encoding: 'utf8' }).trim()
    note('ⓝ 옛 herdr 명령(남아 있으면)', guard)
    // up.sh 와 같은 명령으로 같은 이름 세션을 다시 띄운다(소켓이 없으면 up.sh 가 띄우는 경로 — 앱은 그대로 둔다).
    const KEY = execFileSync('node', ['-e', 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))'], { cwd: APP, encoding: 'utf8' }).trim()
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: APP, encoding: 'utf8' }).trim()
    const GUARD = `${common}/corral-herdr-dev/${KEY}/herdr-0.9.0/target/debug/herdr`
    spawnSync('sh', [path.join(APP, 'scripts/l470/clean.sh'), '--', `nohup '${GUARD}' --session ${session} server > '${root}/herdr-server-2.out' 2>&1 & echo $! > '${root}/herdr.pid'`], { cwd: APP, stdio: 'ignore' })
    await until(() => fs.existsSync(herdrSock), { timeoutMs: 30_000, label: 'herdr 소켓 다시' })
    const listAfter = await until(async () => { const l = await herdr('workspace.list').catch(() => null); return l && (l.workspaces ?? []).length > 0 ? l : null }, { timeoutMs: 20_000, label: 'herdr 복원' }).then((r) => r.value).catch((error) => ({ error: String(error) }))
    note('ⓝ herdr 재기동 후', { herdrPid: fs.readFileSync(path.join(root, 'herdr.pid'), 'utf8').trim(), listAfter })
    // 앱이 다시 붙어 탭이 돌아올 때까지.
    await until(async () => ((await workspaceOf(repo))?.tabs.length ?? 0) > 0 && (await js(DUMP_JS)).activeTab !== null, { timeoutMs: 30_000, label: '앱 재연결' })
    await sleep(3000)
    const d = await dump('n-after-herdr-restart')
    const wsAfter = (await workspaceOf(repo))?.workspaceId ?? null
    const row = { wsBefore: wsId, wsAfter, sameWorkspaceId: wsAfter === wsId, before: { activeTab: before.activeTab, selectedTab: before.selectedTab }, after: { activeTab: d.activeTab, selectedPane: d.selectedPane, selectedTab: d.selectedTab, herdrFocused: d.herdrFocused, groups: d.groups } }
    fs.writeFileSync(out.replace(/\.txt$/, '.json'), JSON.stringify({ build, ...row }, null, 2) + '\n')
    note('ⓝ 결과', row)
    judge('K3+ⓝ herdr 재기동 뒤 화면 활성 탭 = 선택 pane 의 탭', d.activeTab !== null && d.selectedTab === d.activeTab, { activeTab: d.activeTab, selectedTab: d.selectedTab, sameWorkspaceId: row.sameWorkspaceId })
  },
}

async function fileCloseFollow({ via }) {
  const { tabs } = await boot({ terminals: 2 })
  const [S1, S2] = tabs
  await activate(S2)
  await openFile('l691-a.md')
  await activate(S1)
  // S1 을 새 영역으로 — 선택 pane = S1 pane, 활성 영역 = 새 영역.
  await key('D', ['meta', 'alt'])
  await until(async () => (await js(DUMP_JS)).groups.length === 2, { timeoutMs: 5_000, label: '새 영역(S1)' })
  await sleep(500)
  await activate(F1)
  const s1Panes = await paneOfTab(S1)
  const s2Panes = await paneOfTab(S2)
  const before = await dump(`${via}-before`)
  judge(`준비 원 영역 F1 활성 · 선택 pane = S1 pane`, before.activeTab === F1 && s1Panes.includes(before.selectedPane), { activeTab: before.activeTab, selectedPane: before.selectedPane })
  if (via === 'trash') {
    await ctl(root, { cmd: 'file-dialog-stub', answers: ['trash'] })
    await until(async () => {
      await ctl(root, { cmd: 'click', selector: '[data-explorer-row="l691-a.md"]' })
      await sleep(200)
      return js(`document.querySelector('[data-explorer-row="l691-a.md"]')?.classList.contains('is-selected') === true && document.activeElement === document.querySelector('[data-explorer-tree]')`)
    }, { timeoutMs: 6_000, label: '트리 포커스 l691-a.md' })
    await key('Backspace', ['meta'])
    await until(() => !fs.existsSync(path.join(repo, 'l691-a.md')), { timeoutMs: 8_000, label: '휴지통으로' })
    note('ⓚ 휴지통으로 보낸 fixture 파일', { path: path.join(repo, 'l691-a.md'), at: new Date().toISOString() })
  } else {
    await until(async () => {
      await ctl(root, { cmd: 'click', selector: '[data-file-view="l691-a.md"] [data-file-editor] .view-lines' })
      await sleep(200)
      return js(`document.activeElement?.closest('[data-file-editor]') !== null`)
    }, { timeoutMs: 6_000, label: '편집기 포커스' })
    await ctl(root, { cmd: 'type', text: 'l691 수정' })
    await until(() => js(`document.querySelector('[data-file-tab="l691-a.md"]')?.dataset.fileDirty === 'true'`), { timeoutMs: 5_000, label: '수정 표시' })
    await ctl(root, { cmd: 'file-dialog-stub', answers: ['discard'] })
    await click(`[data-main-tab-close="${F1}"]`)
  }
  await until(() => js(`document.querySelector('[data-main-tab="${F1}"]') === null`), { timeoutMs: 8_000, label: 'F1 탭 닫힘' })
  await sleep(1000)
  const asked = await ctl(root, { cmd: 'file-dialog-stub', answers: [] })
  note('대화상자 스텁', asked)
  const d = await dump(`${via}-after`)
  judge(`K3+${via === 'trash' ? 'ⓚ' : 'ⓛ'} 원 영역 새 활성 = 세션2`, d.activeTab === S2, { activeTab: d.activeTab, activeGroupId: d.activeGroupId })
  judge(`K3+${via === 'trash' ? 'ⓚ' : 'ⓛ'} 선택 pane = 세션2 pane`, s2Panes.includes(d.selectedPane), { selectedPane: d.selectedPane, s2Panes })
  const landed = await typeProbe(via)
  judge(`K3+${via === 'trash' ? 'ⓚ' : 'ⓛ'} 입력이 세션2 에 도착`, landed.length === 1 && s2Panes.includes(landed[0]), { landed })
  if (via === 'discard') note('ⓛ 디스크 파일(저장 안 함 → 원본 그대로)', { text: fs.readFileSync(path.join(repo, 'l691-a.md'), 'utf8') })
}

// --- 실행 ----------------------------------------------------------------------
let exitCode = 1
log(`# ${path.basename(out)} ${new Date().toISOString()} scenario=${scenario} build=${build} ROOT=${root} session=${session} app=${build === 'base' ? BASE_APP : APP}`)
try {
  if (scenarios[scenario] === undefined) throw new Error(`모르는 시나리오 ${scenario}`)
  await scenarios[scenario]()
  const failed = verdicts.filter((v) => !v.pass)
  log(`판정 ${verdicts.length - failed.length}/${verdicts.length} 통과`)
  exitCode = failed.length === 0 && verdicts.length > 0 ? 0 : 1
} catch (error) {
  log('오류(미달로 센다)', String(error?.stack ?? error).replaceAll(os.homedir(), '~'))
  try { await dump('error-state') } catch (e) { log('오류 덤프 실패', String(e)) }
} finally {
  try { down(true) } catch (error) { log('down 실패', String(error)) }
  const left = spawnSync('sh', ['-c', `pgrep -f -- '${root}' || true`], { encoding: 'utf8' }).stdout.trim()
  log(`잔존 프로세스(ROOT 경로 포함): [${left.split('\n').filter(Boolean).join(' ')}]`)
  log(`# exit ${exitCode}`)
  process.exit(exitCode)
}
