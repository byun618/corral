/* global window, document, getComputedStyle -- eval 로 렌더러 안에서 도는 클로저가 쓴다 */
// LIFE-511 U1·K1·K2 **격리** 실측 — 설정 페이지를 열고 닫는 동안 터미널이 그대로인가.
// 격리 = launchCorral(/tmp/l511i* 아래 userData·herdr 세션·제어 소켓). 사용자 userData·herdr 기본 세션은 안 건드린다.
//
// 장면: fixture 워크트리 1개 · 탭 1개 · pane 2개(A = 출력이 계속 나오는 셸 루프 — 에이전트 출력 대역,
// B = PTY 바이트 싱크 l497/byte-sink.mjs). 관측점:
//   ① main `counters` 의 gridRequests(herdr 로 간 resize 요청 수) · corral.ndjson `stream.sync` 행(렌더러 격자 선언)
//   ② pane 마다 xterm cols·rows(`corralPaneWrites`) ③ xterm 인스턴스 동일성(.xterm 요소에 표식을 달고 뒤에 다시 본다)
//   ④ B 의 화면 줄(`corralTermProbe.read` — 마지막 마운트 pane = B) ⑤ B 가 실제로 받은 바이트(싱크) ⑥ 포커스 pane
//
// --label before : A1 확인 — 워크스페이스(.main-area)를 display:none 으로 1.5초 숨겼다 되돌린다(eval — 제품 경로가 아니다.
//                  before 빌드에는 설정 화면이 없어 숨김 자체를 흉내 낸다). 기대: 격자 요청이 나간다(A1 참).
// --label after  : 구현 빌드 — 진입은 전부 실제 입력(제어 소켓 click/key/type = sendInputEvent). ⚙ → 키 입력·Esc 2단계 →
//                  ⌘, → 돌아가기 → 팔레트 → ? 메뉴 → workspace-tools. 기대: 격자 요청 0·cols/rows 불변·xterm 동일·
//                  설정 중 PTY 0바이트·닫으면 포커스가 B 로 돌아와 바로 친 글자가 B 에 간다.
// 사용: node iso-u1.mjs --app <app 폴더> --work /tmp/l511iX --port 95NN --out <raw 폴더> --label before|after [--ledger <runs.md>]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { beginRun, finishRun } from '../gui-diff/lib/runs.mjs'
import { pause, requirements, sinkRows } from '../l497/lib.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l511i')) throw new Error('--work 는 /tmp/l511i*')
if (!['before', 'after'].includes(args.label)) throw new Error('--label before|after')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
const NODE = `${process.env.HOME}/.nvm/versions/node/v24.14.1/bin/node`
const SINK_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '../l497/byte-sink.mjs')
const command = `node app/scripts/l511/iso-u1.mjs ${process.argv.slice(2).join(' ')}`
const criterion = args.label === 'before' ? 'U1·A1 (before 빌드 display:none 숨김 확인)' : 'K1ⓐⓑⓒⓓⓔ·K2ⓒⓓⓔⓕ (격리)'
const ledger = args.ledger ? path.resolve(args.ledger) : null
const runId = ledger ? beginRun(ledger, { criterion, command, expectedExit: 0, raw: path.relative(path.resolve(ledger, '../../../../..'), out) }) : null

// 504 가드 — 같은 격리 경로·herdr 세션 이름을 쓰는 프로세스가 있으면 띄우지 않는다.
const guard = (() => { try { return execFileSync('pgrep', ['-fl', `${work}|l443-gui-diff`], { encoding: 'utf8' }).trim() } catch { return '' } })()
fs.writeFileSync(path.join(out, 'guard-before.txt'), `pgrep -fl "${work}|l443-gui-diff" → ${guard === '' ? '(없음)' : `\n${guard}`}\n`)
if (guard !== '') {
  console.log('[u1] 504 가드: 같은 경로·세션을 쓰는 프로세스가 있다 — 멈춘다\n' + guard)
  if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: 3, raw: out, result: '실패 — 504 가드(프로세스 있음)' })
  process.exit(3)
}
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })

const fixture = path.join(work, 'fx')
fs.mkdirSync(fixture)
execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })

const result = { label: args.label, app: path.resolve(args.app), startedAt: new Date().toISOString(), steps: [], notes: [] }
const save = () => fs.writeFileSync(path.join(out, 'iso-u1.json'), `${JSON.stringify(result, null, 1)}\n`)
const checks = requirements((row) => { if (!row.pass) console.log('[u1] 필수 조건 실패', JSON.stringify(row).slice(0, 400)) })
result.requirements = checks.results
const owned = []
let exitCode = 0
let handle = null
const sinkFile = path.join(work, 'sink.ndjson')

try {
  handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  result.appPid = handle.status?.runtime?.pid
  const control = (request, timeout = 20_000) => rpc(handle.control, request, timeout)
  const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
  const logPath = path.join(handle.paths.userData, 'corral.ndjson')
  const logLines = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [])
  const until = async (label, fn, timeout = 10_000) => {
    const t0 = Date.now()
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() - t0 > timeout) throw new Error(`시간초과: ${label}`)
      await pause(150)
    }
  }

  await seedCorralRepo(handle, fixture, { expectedWorktrees: 1 })
  const real = fs.realpathSync(fixture)
  await evaluate((root) => window.corral.openWorktree({ repoRoot: root, path: root, isLinked: false }), real)
  const workspaceOf = async () => {
    const state = (await control({ cmd: 'state' })).state
    for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === real) return row.workspace ?? null
    return null
  }
  const ws = await until('fixture workspace', workspaceOf, 30_000)
  const created = await evaluate((input) => window.corral.createRow(input), { workspaceId: ws.workspaceId, kind: 'shell' })
  const paneA = created.paneId
  await control({ cmd: 'click', selector: `[data-worktree="${real}"] [data-worktree-card-surface]` })
  await pause(800)
  await control({ cmd: 'click', selector: `[data-main-tab="${created.tabId}"]` })
  await until('pane A box', () => evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, paneA))
  await pause(1200)
  const split = await evaluate((id) => window.corral.splitPane({ paneId: id, direction: 'right' }), paneA)
  const paneB = split?.paneId
  if (!paneB) throw new Error(`split 실패: ${JSON.stringify(split)}`)
  await until('pane B box', () => evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, paneB))
  await pause(1500)
  result.panes = { A: paneA, B: paneB, tabId: created.tabId }

  // A = 출력이 계속 나오는 셸(에이전트 출력 대역 — 킥오프 격리 3), B = 바이트 싱크.
  await evaluate((input) => window.corral.termInput(input), { paneId: paneA, data: 'while :; do date; sleep 0.2; done\r' })
  await evaluate((input) => window.corral.termInput(input), { paneId: paneB, data: `${NODE} ${SINK_SCRIPT} ${sinkFile} 0\r` })
  await until('sink start', () => sinkRows(sinkFile, 0).rows.some((row) => row.event === 'start'), 15_000)
  // 사용자처럼 B 를 눌러 포커스를 둔다(실제 클릭).
  await control({ cmd: 'click', selector: `[data-term-pane-box="${paneB}"] .xterm-screen` })
  await pause(1500)
  // xterm 인스턴스 표식 — 같은 DOM 요소가 끝까지 살아 있으면 재생성이 없었다.
  await evaluate(() => {
    for (const box of document.querySelectorAll('[data-term-pane-box]')) {
      const xterm = box.querySelector('.xterm')
      if (xterm) xterm.__l511 = `tag-${box.getAttribute('data-term-pane-box')}`
    }
    return true
  })

  let sinkAt = sinkRows(sinkFile, 0).next
  const takeSink = () => {
    const { rows, next } = sinkRows(sinkFile, sinkAt)
    sinkAt = next
    return rows.filter((row) => row.event === 'data').map((row) => row.text).join('')
  }
  const snapshot = async (name) => {
    const counters = (await control({ cmd: 'counters' })).counters
    const dom = await evaluate(() => ({
      panes: (window.corralPaneWrites?.() ?? []).map((pane) => ({ paneId: pane.paneId, cols: pane.cols, rows: pane.rows })),
      seq: Object.fromEntries((window.corralPaneWrites?.() ?? []).map((pane) => [pane.paneId, pane.lastSeq])),
      xterms: [...document.querySelectorAll('[data-term-pane-box]')].map((box) => ({ pane: box.getAttribute('data-term-pane-box'), tag: box.querySelector('.xterm')?.__l511 ?? null })),
      focusPane: document.activeElement?.closest?.('[data-term-pane-box]')?.getAttribute('data-term-pane-box') ?? null,
      activeTag: document.activeElement ? `${document.activeElement.tagName}.${document.activeElement.className}`.slice(0, 80) : null,
      settingsOpen: document.querySelector('[data-settings-page]') !== null,
      settingsSection: document.querySelector('[data-settings-section]')?.getAttribute('data-settings-section') ?? null,
      mainArea: (() => { const el = document.querySelector('[data-main-area]'); if (!el) return null; const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, display: getComputedStyle(el).display, visibility: getComputedStyle(el).visibility } })(),
      tabs: document.querySelectorAll('[data-main-tab]').length,
      linesB: window.corralTermProbe ? (({ paneId, lines }) => ({ paneId, lines }))(window.corralTermProbe.read()) : null,
    }))
    const lines = logLines()
    const entry = { name, at: Date.now(), gridRequests: counters.reduce((sum, row) => sum + (row.gridRequests ?? 0), 0), counters, logLength: lines.length, ...dom }
    result.steps.push(entry)
    save()
    console.log('[u1]', name, JSON.stringify({ grid: entry.gridRequests, panes: dom.panes, settings: dom.settingsOpen, focus: dom.focusPane, section: dom.settingsSection }))
    return entry
  }
  const syncRowsSince = (logLength) => logLines().slice(logLength).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((row) => row && /^stream\.sync/.test(String(row.tag ?? '')))
  const resizeLog = () => {
    const file = path.join(work, 'logs/corral-backend.log')
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => /resize/i.test(line)).length : null
  }

  const base = await snapshot('base')
  // B 의 화면 줄은 출력이 없는 동안 그대로여야 한다 — 기준을 잡을 때 B 가 프로브를 쥐고 있는지 본다.
  checks.require('probe-holds-B', base.linesB?.paneId === paneB, { probe: base.linesB?.paneId })
  checks.require('base-focus-B', base.focusPane === paneB, { focus: base.focusPane })
  const baseResizeLog = resizeLog()
  takeSink()

  const key = (keyCode, modifiers = []) => control({ cmd: 'key', keyCode, modifiers })
  const type = (text) => control({ cmd: 'type', text })
  const click = async (selector) => {
    const response = await control({ cmd: 'click', selector })
    checks.require(`click ${selector}`, response.ok === true, { response })
    return response
  }
  const expectOpen = async (label) => {
    const open = await until(`${label} 열림`, () => evaluate(() => document.querySelector('[data-settings-page]') !== null), 5_000).catch(() => false)
    checks.require(`${label}-opens`, open === true)
    await pause(400)
  }
  const expectClosed = async (label) => {
    const closed = await until(`${label} 닫힘`, () => evaluate(() => document.querySelector('[data-settings-page]') === null), 5_000).catch(() => false)
    checks.require(`${label}-closes`, closed === true)
    await pause(600)
  }
  /** 닫은 직후 포커스가 B 로 돌아왔고, 바로 친 글자가 B 의 PTY 에 그대로 가는가(K2ⓔ). */
  const expectFocusBack = async (label) => {
    takeSink()
    const after = await snapshot(`${label}-closed`)
    checks.require(`${label}-focus-B`, after.focusPane === paneB, { focus: after.focusPane, active: after.activeTag })
    await type('q')
    await pause(700)
    const got = takeSink()
    checks.require(`${label}-typed-to-B`, got === 'q', { got })
  }

  if (args.label === 'before') {
    // A1 실행 확인 — 제품에 설정 화면이 없으므로 숨김만 흉내 낸다.
    await evaluate(() => { document.querySelector('[data-main-area]').style.display = 'none'; return true })
    await pause(1500)
    const hidden = await snapshot('hidden')
    await evaluate(() => { document.querySelector('[data-main-area]').style.display = ''; return true })
    await pause(1500)
    const shown = await snapshot('shown')
    const syncRows = syncRowsSince(base.logLength)
    result.syncRows = syncRows
    result.backendResizeLines = { base: baseResizeLog, end: resizeLog() }
    result.a1 = {
      gridRequestsDuringHide: hidden.gridRequests - base.gridRequests,
      gridRequestsTotal: shown.gridRequests - base.gridRequests,
      colsRowsDuringHide: hidden.panes,
      syncDeclarations: syncRows.map((row) => row.groups ?? row),
      twoByOneDeclared: syncRows.some((row) => / 2x1|:2x1/.test(` ${row.groups ?? ''}`)),
    }
    // before 의 「통과」 = A1 이 실행으로 확인됐다(숨김이 격자 요청을 냈다).
    checks.require('A1-hide-sends-grid', result.a1.gridRequestsDuringHide > 0 && result.a1.twoByOneDeclared, result.a1)
  } else {
    // ── 1. ⚙ 실제 클릭(K1ⓐ) → 설정 화면에서 키 입력(K2ⓓ) → Esc 2단계(K6ⓓ)
    await click('[data-settings-open]')
    await expectOpen('gear')
    const open1 = await snapshot('gear-open')
    checks.require('gear-section-shortcuts', open1.settingsSection === 'shortcuts', { section: open1.settingsSection })
    // ⌘F → 설정 검색에 포커스(K5ⓑ). 글자는 검색창으로 간다.
    await key('F', ['meta'])
    await pause(200)
    const searchFocused = await evaluate(() => document.activeElement?.hasAttribute('data-settings-search') ?? false)
    checks.require('cmdF-focuses-search', searchFocused === true)
    // 섹션에 맞는 질의 — 맞지 않는 질의는 섹션을 걸러 「결과 없음」 이 된다(r4 실패 원인).
    await type('단축키')
    await pause(200)
    // 워크스페이스를 바꾸는 단축키는 설정이 열린 동안 막힌다(K2ⓕ) — ⌘T(새 탭)·⌘D(분할)·⌘W(닫기).
    await key('T', ['meta'])
    await key('D', ['meta'])
    await key('W', ['meta'])
    await pause(800)
    // 기록 중 키(K2ⓓ) — 첫 기록 버튼을 눌러 기록을 켜고 ⌃G 를 누른 뒤 Esc 로 저장하지 않고 둔다.
    await evaluate(() => { const input = document.querySelector('[data-settings-search]'); if (input) input.blur(); return true })
    await click('[data-record="sidebar.toggle"][data-variant="0"]')
    await key('G', ['control'])
    await pause(300)
    const recorded = await evaluate(() => document.querySelector('[data-save-binding]') !== null)
    checks.require('record-candidate-shown', recorded === true)
    await key('Escape')
    await pause(300)
    const stillOpen = await evaluate(() => document.querySelector('[data-settings-page]') !== null)
    checks.require('esc1-keeps-open', stillOpen === true)
    const confirmShown = await evaluate(() => document.querySelector('[data-settings-escape-confirm]') !== null)
    checks.require('esc1-shows-confirm', confirmShown === true)
    const during = await snapshot('gear-during')
    checks.require('gear-no-new-tab', during.tabs === base.tabs, { before: base.tabs, during: during.tabs })
    const sinkDuring = takeSink()
    checks.require('gear-pty-zero-bytes', sinkDuring === '', { got: sinkDuring })
    await key('Escape')
    await expectClosed('gear-esc2')
    await expectFocusBack('gear')

    // ── 2. ⌘, (K1ⓑ) → 「앱으로 돌아가기」(K2ⓑ)
    await key(',', ['meta'])
    await expectOpen('cmd-comma')
    await type('xyz')
    await pause(200)
    checks.require('comma-pty-zero', takeSink() === '')
    await click('[data-settings-back]')
    await expectClosed('back')
    await expectFocusBack('back')

    // ── 3. 팔레트(K1ⓒ) — 섹션 항목을 찾아 연다
    await key('K', ['meta'])
    await until('palette', () => evaluate(() => document.querySelector('[data-command-palette], .command-palette') !== null), 5_000)
    await type('단축키')
    await pause(300)
    const paletteHit = await evaluate(() => [...document.querySelectorAll('[data-palette-entry], [data-entry-id], [role="option"]')].slice(0, 5).map((el) => el.getAttribute('data-palette-entry') ?? el.getAttribute('data-entry-id') ?? el.textContent))
    result.paletteTop = paletteHit
    await key('Return')
    await expectOpen('palette')
    checks.require('palette-pty-zero', takeSink() === '')
    await key('Escape')
    await pause(200)
    await key('Escape')
    await expectClosed('palette-esc2')
    await expectFocusBack('palette')

    // ── 4. ? 메뉴 「단축키」(K1ⓓ)
    await click('[data-help-menu-toggle]')
    await until('help menu', () => evaluate(() => document.querySelector('[data-help-menu] [data-menu-action="shortcuts"]') !== null), 5_000)
    await click('[data-help-menu] [data-menu-action="shortcuts"]')
    await expectOpen('help')
    await click('[data-settings-back]')
    await expectClosed('help-back')
    await expectFocusBack('help')

    // ── 5. workspace-tools 「단축키」(K1ⓓ)
    await click('[data-shortcuts-open]')
    await expectOpen('tools')
    await click('[data-settings-back]')
    await expectClosed('tools-back')
    await expectFocusBack('tools')

    const end = await snapshot('end')
    const syncRows = syncRowsSince(base.logLength)
    result.syncRows = syncRows
    result.backendResizeLines = { base: baseResizeLog, end: resizeLog() }
    // A(셸 루프)가 측정 내내 출력하고 있었다 — 설정 열림 구간에도 프레임 번호가 올라간다(K2ⓒ 「출력 중인 pane」).
    const openSteps = result.steps.filter((step) => step.settingsOpen)
    checks.require('A-output-while-open', openSteps.length > 0 && openSteps.every((step) => (step.seq?.[paneA] ?? 0) > (base.seq?.[paneA] ?? 0)) && (end.seq?.[paneA] ?? 0) > Math.max(...openSteps.map((step) => step.seq?.[paneA] ?? 0)), { base: base.seq, open: openSteps.map((step) => step.seq), end: end.seq })
    checks.require('grid-requests-zero', end.gridRequests === base.gridRequests, { base: base.gridRequests, end: end.gridRequests })
    checks.require('stream-sync-zero', syncRows.length === 0, { rows: syncRows.length })
    checks.require('cols-rows-unchanged', JSON.stringify(end.panes) === JSON.stringify(base.panes), { base: base.panes, end: end.panes })
    checks.require('cols-rows-unchanged-during', result.steps.every((step) => JSON.stringify(step.panes) === JSON.stringify(base.panes)))
    checks.require('xterm-same-instance', end.xterms.every((row) => row.tag === `tag-${row.pane}`) && end.xterms.length === base.xterms.length, { base: base.xterms, end: end.xterms })
    // B 의 화면: 「got 1B」 줄(포커스 복귀 타이핑의 메아리)만 늘어난다 — 설정 중에는 아무 줄도 늘지 않았다는 것은 위 PTY 0바이트가 보인다.
    const echoes = (end.linesB?.lines ?? []).filter((line) => /^got 1B/.test(line.trim())).length
    checks.require('B-screen-only-echoes', echoes === 5, { echoes })
  }
  exitCode = checks.exitCode()
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.log('[u1] 예외', result.error)
  exitCode = 2
} finally {
  try { if (handle) await rpc(handle.control, { cmd: 'eval', code: 'true' }, 2000).catch(() => null) } catch { /* 무시 */ }
  // 소유한 것만 끈다 — 띄운 쪽이 PID 를 기록하고 끈다(킥오프 격리 7).
  const pids = owned.filter((entry) => entry.pid).map((entry) => entry.pid)
  result.owned = owned
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* 이미 끝남 */ } }
  await pause(2000)
  result.alive = pids.filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
  for (const pid of result.alive) { try { process.kill(pid, 'SIGKILL') } catch { /* 이미 끝남 */ } }
  const leftover = (() => { try { return execFileSync('pgrep', ['-fl', work], { encoding: 'utf8' }).trim() } catch { return '' } })()
  result.leftover = leftover
  if (leftover !== '') {
    for (const line of leftover.split('\n')) { const pid = Number(line.split(' ')[0]); try { process.kill(pid, 'SIGTERM') } catch { /* 이미 끝남 */ } }
  }
  result.finishedAt = new Date().toISOString()
  result.exitCode = exitCode
  save()
  const failed = checks.failed().map((row) => row.name)
  if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: exitCode, raw: path.relative(path.resolve(ledger, '../../../../..'), out), result: exitCode === 0 ? '통과' : `실패 — ${result.error ? result.error.split('\n')[0] : failed.join(', ')}` })
  console.log('[u1] exit', exitCode, failed)
  process.exit(exitCode)
}
