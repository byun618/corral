/* global window, document, getComputedStyle -- eval 로 렌더러 안에서 도는 클로저가 쓴다 */
// LIFE-511 fix1 **격리** 재실행 — r1 지적(R1-01·02·07, 부기 2·3)을 구현 빌드에서 실제 입력으로 본다.
// 격리 = launchCorral(/tmp/l511i* 아래 userData·herdr 세션·제어 소켓). 사용자 userData·herdr 기본 세션은 안 건드린다.
//
// 장면: fixture 워크트리 1개 · 탭 1개 · pane 2개 — **두 pane 모두 pane-sink**(입력 경계 계측, R1-07).
//   A = tick=1 출력 대역(에이전트 출력 대신) · B = tick=0 조용한 pane(포커스 대상·검증 타이핑 메아리).
// 단계:
//   ① K2 — iso-u1 의 5개 진입·닫기를 그대로 돈다. 판정은 k2-judge.mjs:
//       입력 경계(두 싱크가 받은 바이트 = B 에 'q'×5 뿐) · herdr pane.read(recent, 스크롤백 포함) 전후 안정 텍스트 ·
//       렌더러 xterm 화면 = herdr visible 일치 · 격자 요청 0 · cols/rows·xterm 인스턴스 불변
//   ② R1-01 — ? 메뉴를 실제 클릭으로 연 채 ⌘, → 메뉴가 닫히고 설정이 열린다. 팔레트 경로도 같다
//   ③ 부기 3 — 닫은 뒤 ⌃Tab 홀드(MRU)로 A 로 옮기고, ↻(트리 재조회) · Reveal(활성 카드 강조)이 돈다
//   ④ R1-02 + 부기 2 — 설정이 열린 채 창 폭 1180/800/680(높이 800)으로 바꾼다. 폭마다 레일이 목록 위로 쌓이고
//       편집 버튼이 실제 클릭·기록까지 닿는지, 마지막 행까지 닿는지. 숨은 워크스페이스는 진짜 크기를 요청하고(2x1 아님)
//       닫을 때는 추가 요청이 없다
//   ⑤ 입력 경계 전체 판정(전 구간 B 'q'×5 뿐) → **판별력 자기점검**: A 에 'z' 입력, B 에 0x18(텍스트 훼손)을 일부러 넣고
//       같은 판정 함수가 둘 다 잡는지(못 잡으면 실패)
// 사용: node iso-fix1.mjs --app <app 폴더> --work /tmp/l511iX --port 95NN --out <raw 폴더> [--ledger <runs.md>]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { backendRpc, launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { beginRun, finishRun } from '../gui-diff/lib/runs.mjs'
import { pause, requirements, sinkRows } from '../l497/lib.mjs'
import { judgeInputs, judgeOutputPane, judgeQuietPane } from './k2-judge.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l511i')) throw new Error('--work 는 /tmp/l511i*')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
const NODE = `${process.env.HOME}/.nvm/versions/node/v24.14.1/bin/node`
const SINK_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'pane-sink.mjs')
const STABLE = 60
const command = `node app/scripts/l511/iso-fix1.mjs ${process.argv.slice(2).join(' ')}`
const criterion = 'fix1 격리 — K2(R1-07 보강 판별) · R1-01 · R1-02 · 부기 2 · 부기 3'
const ledger = args.ledger ? path.resolve(args.ledger) : null
const rawRel = ledger ? path.relative(path.resolve(ledger, '../../../../..'), out) : out
const runId = ledger ? beginRun(ledger, { criterion, command, expectedExit: 0, raw: rawRel }) : null

// 504 가드 — 같은 격리 경로·herdr 세션 이름을 쓰는 프로세스가 있으면 띄우지 않는다.
const guard = (() => { try { return execFileSync('pgrep', ['-fl', `${work}|l443-gui-diff`], { encoding: 'utf8' }).trim() } catch { return '' } })()
fs.writeFileSync(path.join(out, 'guard-before.txt'), `pgrep -fl "${work}|l443-gui-diff" → ${guard === '' ? '(없음)' : `\n${guard}`}\n`)
if (guard !== '') {
  console.log('[fix1] 504 가드: 같은 경로·세션을 쓰는 프로세스가 있다 — 멈춘다\n' + guard)
  if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: 3, raw: rawRel, result: '실패 — 504 가드(프로세스 있음)' })
  process.exit(3)
}
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })

const fixture = path.join(work, 'fx')
fs.mkdirSync(fixture)
execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })

const result = { app: path.resolve(args.app), startedAt: new Date().toISOString(), steps: [], reads: {}, judges: {} }
const save = () => fs.writeFileSync(path.join(out, 'iso-fix1.json'), `${JSON.stringify(result, null, 1)}\n`)
const checks = requirements((row) => { if (!row.pass) console.log('[fix1] 필수 조건 실패', JSON.stringify(row).slice(0, 400)) })
result.requirements = checks.results
const owned = []
let exitCode = 0
let handle = null
const sinkFile = { A: path.join(work, 'sink-A.ndjson'), B: path.join(work, 'sink-B.ndjson') }

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
  const paneOf = { A: paneA, B: paneB }
  result.panes = { ...paneOf, tabId: created.tabId }

  // 두 pane 모두 싱크 — 셸 명령은 준비용 termInput(측정 전)이라 입력 경계 기준선 이전이다.
  await evaluate((input) => window.corral.termInput(input), { paneId: paneA, data: `${NODE} ${SINK_SCRIPT} ${sinkFile.A} A 1 ${STABLE}\r` })
  await evaluate((input) => window.corral.termInput(input), { paneId: paneB, data: `${NODE} ${SINK_SCRIPT} ${sinkFile.B} B 0 ${STABLE}\r` })
  for (const label of ['A', 'B']) await until(`sink ${label} start`, () => sinkRows(sinkFile[label], 0).rows.some((row) => row.event === 'start'), 15_000)
  await control({ cmd: 'click', selector: `[data-term-pane-box="${paneB}"] .xterm-screen` })
  await pause(1500)
  await evaluate(() => {
    for (const box of document.querySelectorAll('[data-term-pane-box]')) {
      const xterm = box.querySelector('.xterm')
      if (xterm) xterm.__l511 = `tag-${box.getAttribute('data-term-pane-box')}`
    }
    return true
  })

  // ── 관측 도구 ──────────────────────────────────────────────
  const sinkAt = { A: 0, B: 0 }
  const takeInputs = () => Object.fromEntries(['A', 'B'].map((label) => {
    const { rows, next } = sinkRows(sinkFile[label], sinkAt[label])
    sinkAt[label] = next
    return [label, rows.filter((row) => row.event === 'data').map((row) => row.text).join('')]
  }))
  const allInputs = { A: '', B: '' }
  const markInputs = () => { const got = takeInputs(); allInputs.A += got.A; allInputs.B += got.B; return got }
  markInputs()
  /** herdr 쪽 실물 — recent = 스크롤백 포함. 첫 성공한 형식을 기록하고 계속 쓴다. */
  let readForm = null
  const herdrRead = async (paneId, source) => {
    const forms = readForm && source === 'recent' ? [readForm] : source === 'recent'
      ? [{ source: 'recent', lines: 5000 }, { source: 'recent-unwrapped', lines: 5000 }, { source: 'recent' }]
      : [{ source }]
    const errors = []
    for (const form of forms) {
      try {
        const response = await backendRpc(handle, 'pane.read', { pane_id: paneId, format: 'text', strip_ansi: true, ...form })
        const text = typeof response === 'string' ? response : response?.text ?? response?.read?.text ?? response?.content ?? null
        if (typeof text === 'string') { if (source === 'recent') readForm = form; return text }
        errors.push({ form, shape: Object.keys(response ?? {}) })
      } catch (error) { errors.push({ form, error: String(error).slice(0, 200) }) }
    }
    throw new Error(`pane.read 실패 ${JSON.stringify(errors)}`)
  }
  const readAll = async (name) => {
    const entry = { A: await herdrRead(paneA, 'recent'), B: await herdrRead(paneB, 'recent') }
    result.reads[name] = { ...entry, form: readForm }
    fs.writeFileSync(path.join(out, `read-${name}-A.txt`), entry.A)
    fs.writeFileSync(path.join(out, `read-${name}-B.txt`), entry.B)
    return entry
  }
  /**
   * 렌더러 xterm 버퍼 화면이 herdr 화면과 같은가 — `term-read`(corralTermProbe = 마지막 마운트 pane = B)의 buffer.getLine 실물.
   * A 는 프로브가 없어 xterm 쪽은 못 본다(공백) — A 의 텍스트는 herdr recent 판정이 맡는다.
   * (R052: DOM `.xterm-rows` 는 빈 줄만 줘서 버렸다 — 이 빌드의 xterm 화면 실물이 아니다.)
   */
  const screensAgree = async (name) => {
    const term = (await control({ cmd: 'term-read' })).term
    const trim = (list) => { const copy = list.map((line) => line.replace(/\s+$/, '')); while (copy.length && copy[copy.length - 1] === '') copy.pop(); return copy }
    const herdrB = trim((await herdrRead(paneB, 'visible')).replace(/\r/g, '').split('\n'))
    const xtermB = trim(term?.lines ?? [])
    result.screens = { ...(result.screens ?? {}), [name]: { probePane: term?.paneId ?? null, xtermB, herdrB } }
    checks.require(`${name}-xterm-B-equals-herdr`, term?.paneId === paneB && xtermB.length > 0 && JSON.stringify(xtermB) === JSON.stringify(herdrB), { probe: term?.paneId, xtermB: xtermB.slice(-4), herdrB: herdrB.slice(-4) })
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
      menus: document.querySelectorAll('[data-help-menu], [data-repo-menu], [role="menu"]').length,
      tabs: document.querySelectorAll('[data-main-tab]').length,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    }))
    const entry = { name, at: Date.now(), gridRequests: counters.reduce((sum, row) => sum + (row.gridRequests ?? 0), 0), logLength: logLines().length, ...dom }
    result.steps.push(entry)
    save()
    console.log('[fix1]', name, JSON.stringify({ grid: entry.gridRequests, panes: dom.panes, settings: dom.settingsOpen, focus: dom.focusPane, vw: dom.viewport }))
    return entry
  }
  const syncRowsSince = (logLength) => logLines().slice(logLength).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((row) => row && /^stream\.sync/.test(String(row.tag ?? '')))

  const key = (keyCode, modifiers = [], type) => control({ cmd: 'key', keyCode, modifiers, ...(type ? { type } : {}) })
  const type = (text) => control({ cmd: 'type', text })
  const click = async (selector) => {
    const response = await control({ cmd: 'click', selector })
    checks.require(`click ${selector}`, response.ok === true, { response })
    return response
  }
  const isOpen = () => evaluate(() => document.querySelector('[data-settings-page]') !== null)
  const expectOpen = async (label) => {
    const open = await until(`${label} 열림`, isOpen, 5_000).catch(() => false)
    checks.require(`${label}-opens`, open === true)
    await pause(400)
  }
  const expectClosed = async (label) => {
    const closed = await until(`${label} 닫힘`, async () => !(await isOpen()), 5_000).catch(() => false)
    checks.require(`${label}-closes`, closed === true)
    await pause(600)
  }
  let echoes = 0
  /** 닫은 직후 포커스가 B 로 돌아왔고(부기 5 — 닫을 때 지금 활성 pane 으로), 바로 친 글자가 B 에만 가는가. */
  const expectFocusBack = async (label) => {
    const before = markInputs()
    checks.require(`${label}-inputs-while-open-zero`, before.A === '' && before.B === '', { got: before })
    const after = await snapshot(`${label}-closed`)
    checks.require(`${label}-focus-B`, after.focusPane === paneB, { focus: after.focusPane, active: after.activeTag })
    await type('q')
    echoes += 1
    await pause(700)
    const got = markInputs()
    checks.require(`${label}-typed-to-B-only`, got.B === 'q' && got.A === '', { got })
  }

  // ── ① K2 ──────────────────────────────────────────────
  const base = await snapshot('base')
  checks.require('R1-08-panes-observed', base.panes.length === 2 && base.xterms.length === 2 && base.focusPane === paneB, { panes: base.panes, xterms: base.xterms, focus: base.focusPane })
  const readBase = await readAll('k2-base')
  await screensAgree('k2-base')

  await click('[data-settings-open]')
  await expectOpen('gear')
  await key('F', ['meta'])
  await pause(200)
  await type('단축키')
  await pause(200)
  await key('T', ['meta'])
  await key('D', ['meta'])
  await key('W', ['meta'])
  await pause(800)
  await evaluate(() => { const input = document.querySelector('[data-settings-search]'); if (input) input.blur(); return true })
  await click('[data-record="sidebar.toggle"][data-variant="0"]')
  await key('G', ['control'])
  await pause(300)
  checks.require('record-candidate-shown', (await evaluate(() => document.querySelector('[data-save-binding]') !== null)) === true)
  await key('Escape')
  await pause(300)
  checks.require('esc1-shows-confirm', (await evaluate(() => document.querySelector('[data-settings-escape-confirm]') !== null)) === true)
  const during = await snapshot('gear-during')
  checks.require('gear-no-new-tab', during.tabs === base.tabs)
  await key('Escape')
  await expectClosed('gear-esc2')
  await expectFocusBack('gear')

  await key(',', ['meta'])
  await expectOpen('cmd-comma')
  await type('xyz')
  await pause(200)
  await click('[data-settings-back]')
  await expectClosed('back')
  await expectFocusBack('back')

  await key('K', ['meta'])
  await until('palette', () => evaluate(() => document.querySelector('[data-command-palette], .command-palette') !== null), 5_000)
  await type('단축키')
  await pause(300)
  await key('Return')
  await expectOpen('palette')
  await key('Escape')
  await pause(200)
  await key('Escape')
  await expectClosed('palette-esc2')
  await expectFocusBack('palette')

  await click('[data-help-menu-toggle]')
  await until('help menu', () => evaluate(() => document.querySelector('[data-help-menu] [data-menu-action="shortcuts"]') !== null), 5_000)
  await click('[data-help-menu] [data-menu-action="shortcuts"]')
  await expectOpen('help')
  await click('[data-settings-back]')
  await expectClosed('help-back')
  await expectFocusBack('help')

  await click('[data-shortcuts-open]')
  await expectOpen('tools')
  await click('[data-settings-back]')
  await expectClosed('tools-back')
  await expectFocusBack('tools')

  await pause(1000)
  const k2End = await snapshot('k2-end')
  const readK2 = await readAll('k2-end')
  await screensAgree('k2-end')
  const k2Sync = syncRowsSince(base.logLength)
  result.judges.k2 = {
    inputs: judgeInputs({ received: { ...allInputs }, expected: { B: 'q'.repeat(echoes) } }),
    A: judgeOutputPane({ before: readBase.A, after: readK2.A, label: 'A', stableCount: STABLE }),
    B: judgeQuietPane({ before: readBase.B, after: readK2.B, label: 'B', stableCount: STABLE, echoes }),
  }
  for (const [name, judge] of Object.entries(result.judges.k2)) checks.require(`K2-judge-${name}`, judge.pass, { problems: judge.problems ?? judge.bad })
  checks.require('K2-grid-requests-zero', k2End.gridRequests === base.gridRequests, { base: base.gridRequests, end: k2End.gridRequests })
  checks.require('K2-stream-sync-zero', k2Sync.length === 0, { rows: k2Sync.length })
  checks.require('K2-cols-rows-unchanged', result.steps.every((step) => JSON.stringify(step.panes) === JSON.stringify(base.panes)))
  checks.require('K2-xterm-same-instance', k2End.xterms.length === 2 && k2End.xterms.every((row) => row.tag === `tag-${row.pane}`), { end: k2End.xterms })

  // ── ② R1-01 — 메뉴가 열린 채 설정 진입 ──────────────────────────────────────────────
  for (const via of ['cmd-comma', 'palette']) {
    await click('[data-help-menu-toggle]')
    const menuOpen = await until('help menu', () => evaluate(() => document.querySelector('[data-help-menu]') !== null), 5_000).catch(() => false)
    checks.require(`R1-01-${via}-menu-open-before`, menuOpen === true)
    if (via === 'cmd-comma') await key(',', ['meta'])
    else {
      await key('K', ['meta'])
      await until('palette', () => evaluate(() => document.querySelector('[data-command-palette], .command-palette') !== null), 5_000)
      await type('단축키')
      await pause(300)
      await key('Return')
    }
    await expectOpen(`R1-01-${via}`)
    const state = await evaluate(() => ({ menu: document.querySelector('[data-help-menu]') !== null, hover: document.querySelectorAll('[data-hover-card], .hover-card').length }))
    checks.require(`R1-01-${via}-menu-closed`, state.menu === false && state.hover === 0, state)
    // 메뉴가 Esc 를 먹지 않는다 — 첫 Esc 가 바로 설정 확인을 띄운다(메뉴가 남아 있으면 그 Esc 가 메뉴 닫기에 쓰인다).
    await key('Escape')
    await pause(250)
    checks.require(`R1-01-${via}-esc1-confirm`, (await evaluate(() => document.querySelector('[data-settings-escape-confirm]') !== null)) === true)
    await key('Escape')
    await expectClosed(`R1-01-${via}-esc2`)
    await expectFocusBack(`R1-01-${via}`)
  }

  // ── ③ 부기 3 — 닫은 뒤 ⌃Tab MRU · ↻ · Reveal ──────────────────────────────────────────────
  await key('Control', ['control'], 'keyDown')
  await key('Tab', ['control'], 'keyDown')
  await pause(250)
  const mruShown = await evaluate(() => document.querySelector('[data-mru]') !== null)
  await key('Tab', ['control'], 'keyUp')
  await key('Control', [], 'keyUp')
  await pause(600)
  const afterMru = await snapshot('mru')
  checks.require('B3-mru-overlay-shown', mruShown === true)
  checks.require('B3-mru-moves-focus-to-A', afterMru.focusPane === paneA, { focus: afterMru.focusPane })
  checks.require('B3-mru-no-pty-input', JSON.stringify(markInputs()) === JSON.stringify({ A: '', B: '' }))
  const revisionBefore = (await control({ cmd: 'state' })).state.revision
  await click('[data-refresh-tree]')
  const revisionAfter = await until('revision', async () => { const revision = (await control({ cmd: 'state' })).state.revision; return revision > revisionBefore ? revision : null }, 5_000).catch(() => null)
  checks.require('B3-refresh-tree', revisionAfter !== null, { revisionBefore, revisionAfter })
  await click('[data-reveal-active]')
  const flashed = await until('reveal flash', () => evaluate(() => document.querySelector('.card-reveal-flash') !== null), 2_000).catch(() => false)
  checks.require('B3-reveal-flash', flashed === true)
  // 포커스를 B 로 되돌린다(실제 클릭) — 이후 단계의 검증 타이핑 대상.
  await click(`[data-term-pane-box="${paneB}"] .xterm-screen`)
  await pause(800)

  // ── ④ R1-02 + 부기 2 — 설정이 열린 채 창 폭을 바꾼다 ──────────────────────────────────────────────
  await key(',', ['meta'])
  await expectOpen('R1-02')
  const openBase = await snapshot('R1-02-open')
  result.widths = []
  for (const width of [1180, 800, 680]) {
    await control({ cmd: 'resize-window', width, height: 800 })
    const reached = await until(`viewport ${width}`, () => evaluate((w) => Math.abs(window.innerWidth - w) <= 2, width), 5_000).catch(() => false)
    await pause(1200)
    const windowSize = await evaluate(() => ({ inner: [window.innerWidth, window.innerHeight], outer: [window.outerWidth, window.outerHeight], avail: [window.screen.availWidth, window.screen.availHeight] }))
    checks.require(`R1-02-${width}-window-reached`, reached === true, windowSize)
    const layout = await evaluate(() => {
      const box = (selector) => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right } }
      const list = document.querySelector('[data-shortcuts-list]')
      // 가로 잘림 — 목록 안 모든 편집 버튼이 목록 상자 안에 들어오고 가로 스크롤이 생기지 않는가(R055: 임의 문턱 280px 대신).
      const listBox = list?.getBoundingClientRect()
      const clipped = listBox ? [...list.querySelectorAll('[data-record], [data-reset], [data-disable]')].filter((el) => { const r = el.getBoundingClientRect(); return r.x < listBox.x - 0.5 || r.right > listBox.right + 0.5 }).map((el) => el.getAttribute('data-record') ?? el.outerHTML.slice(0, 60)) : null
      return { vw: window.innerWidth, vh: window.innerHeight, rail: box('[data-shortcuts-rail]'), list: box('[data-shortcuts-list]'), listScroll: list ? { top: list.scrollTop, height: list.scrollHeight, client: list.clientHeight, scrollWidth: list.scrollWidth, clientWidth: list.clientWidth } : null, clipped, rows: getComputedStyle(document.querySelector('.shortcuts-layout')).gridTemplateRows, cols: getComputedStyle(document.querySelector('.shortcuts-layout')).gridTemplateColumns }
    })
    const stacked = layout.rail && layout.list && layout.rail.bottom <= layout.list.y + 1 && layout.list.w > 0 && layout.list.h > 0
    checks.require(`R1-02-${width}-stacked`, stacked === true, layout)
    checks.require(`R1-02-${width}-no-horizontal-clip`, layout.clipped?.length === 0 && layout.listScroll.scrollWidth <= layout.listScroll.clientWidth, { clipped: layout.clipped, listScroll: layout.listScroll })
    // 편집 버튼: 보이게 굴린 뒤(사용자의 휠에 해당) 실제 클릭 → ⌃G 기록 후보 → 취소
    await evaluate(() => { document.querySelector('[data-record="sidebar.toggle"][data-variant="0"]')?.scrollIntoView({ block: 'center' }); return true })
    await pause(200)
    const clicked = await control({ cmd: 'click', selector: '[data-record="sidebar.toggle"][data-variant="0"]' })
    await key('G', ['control'])
    await pause(300)
    const candidate = await evaluate(() => document.querySelector('[data-save-binding]') !== null)
    const cancel = candidate ? await control({ cmd: 'click', selector: '[data-cancel-binding]' }) : null
    await pause(200)
    checks.require(`R1-02-${width}-edit-reachable`, clicked.ok === true && candidate === true && cancel?.ok === true, { clicked: clicked.ok, blockedBy: clicked.blockedBy, candidate, cancel: cancel?.ok })
    // 마지막 행까지 닿는가
    const last = await evaluate(() => {
      const list = document.querySelector('[data-shortcuts-list]')
      const all = document.querySelectorAll('[data-record][data-variant="0"]')
      const target = all[all.length - 1]
      if (!list || !target) return null
      list.scrollTop = list.scrollHeight
      const r = target.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return { action: target.getAttribute('data-record'), hit: hit === target || target.contains(hit), inView: r.bottom <= window.innerHeight && r.y >= 0 }
    })
    checks.require(`R1-02-${width}-last-row-reachable`, last?.hit === true && last?.inView === true, last ?? {})
    await evaluate(() => { const list = document.querySelector('[data-shortcuts-list]'); if (list) list.scrollTop = 0; return true })
    result.widths.push({ width, windowSize, layout, clicked, candidate, last })
    save()
  }
  // R1-02 판별력 — 680 에서 수정 전 규칙(항상 2열)을 style 로 되살리면 같은 관측이 실패를 내야 한다. 확인 후 떼어 낸다.
  const oldRule = await evaluate(() => {
    const style = document.createElement('style')
    style.id = 'l511-old-rule'
    style.textContent = '.shortcuts-layout { grid-template-rows: none !important; grid-template-columns: var(--w-shortcut-rail) minmax(0, 1fr) !important; }'
    document.head.appendChild(style)
    const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right } }
    const rail = box('[data-shortcuts-rail]')
    const list = box('[data-shortcuts-list]')
    const target = document.querySelector('[data-record="sidebar.toggle"][data-variant="0"]')
    target.scrollIntoView({ block: 'center' })
    const r = target.getBoundingClientRect()
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    const out = { rail, list, stacked: rail.bottom <= list.y + 1 && list.w > 0, editHit: hit === target || target.contains(hit), editBox: { x: r.x, w: r.width, right: r.right } }
    style.remove()
    return out
  })
  result.r102OldRule = oldRule
  checks.require('R1-02-old-rule-detected-at-680', oldRule.stacked === false && (oldRule.editHit === false || oldRule.list.w < 50), oldRule)
  const resized = await snapshot('B2-resized-open')
  const openSync = syncRowsSince(openBase.logLength)
  result.b2 = { gridDuringOpen: resized.gridRequests - openBase.gridRequests, sync: openSync.map((row) => row.groups ?? row) }
  checks.require('B2-requests-while-open', resized.gridRequests > openBase.gridRequests && openSync.length > 0, result.b2)
  checks.require('B2-no-2x1', openSync.every((row) => !/(^|[ :])2x1\b/.test(` ${JSON.stringify(row.groups ?? row)}`)) && resized.panes.every((pane) => pane.cols > 2 && pane.rows > 1), { panes: resized.panes })
  checks.require('B2-real-size-applied', JSON.stringify(resized.panes) !== JSON.stringify(openBase.panes), { before: openBase.panes, after: resized.panes })
  await click('[data-settings-back]')
  await expectClosed('B2-close')
  const closedResized = await snapshot('B2-closed')
  checks.require('B2-no-request-on-close', closedResized.gridRequests === resized.gridRequests && syncRowsSince(resized.logLength).length === 0, { open: resized.gridRequests, closed: closedResized.gridRequests })
  checks.require('B2-cols-rows-kept-on-close', JSON.stringify(closedResized.panes) === JSON.stringify(resized.panes), { open: resized.panes, closed: closedResized.panes })
  await expectFocusBack('B2')

  // ── ⑤ 입력 경계 전 구간 + 판별력 자기점검 ──────────────────────────────────────────────
  markInputs()
  result.judges.whole = judgeInputs({ received: { ...allInputs }, expected: { B: 'q'.repeat(echoes) } })
  checks.require('whole-run-inputs', result.judges.whole.pass, { rows: result.judges.whole.rows })
  // 음성 대조 — 아무것도 넣지 않은 1.5초 전후는 같은 판정이 통과해야 한다(그래야 아래 실패가 주입 때문이다).
  const selfControl = await readAll('self-control')
  await pause(1500)
  const selfBefore = await readAll('self-before')
  result.judges.selfControl = {
    inputs: judgeInputs({ received: markInputs(), expected: {} }),
    A: judgeOutputPane({ before: selfControl.A, after: selfBefore.A, label: 'A', stableCount: STABLE }),
    B: judgeQuietPane({ before: selfControl.B, after: selfBefore.B, label: 'B', stableCount: STABLE, echoes: 0 }),
  }
  for (const [name, judge] of Object.entries(result.judges.selfControl)) checks.require(`self-control-${name}-passes`, judge.pass, { problems: judge.problems ?? judge.bad })
  await evaluate((input) => window.corral.termInput(input), { paneId: paneA, data: 'z' })
  await evaluate((input) => window.corral.termInput(input), { paneId: paneB, data: '\x18' })
  await pause(1200)
  const injected = markInputs()
  const selfAfter = await readAll('self-after')
  result.judges.self = {
    injected,
    inputs: judgeInputs({ received: injected, expected: {} }),
    A: judgeOutputPane({ before: selfBefore.A, after: selfAfter.A, label: 'A', stableCount: STABLE }),
    B: judgeQuietPane({ before: selfBefore.B, after: selfAfter.B, label: 'B', stableCount: STABLE, echoes: 0 }),
  }
  checks.require('self-check-input-boundary-detects', result.judges.self.inputs.pass === false && result.judges.self.inputs.bad.length === 2, { bad: result.judges.self.inputs.bad })
  checks.require('self-check-A-text-detects', result.judges.self.A.problems.some((problem) => problem.startsWith('출력 대역에 다른 줄')), { problems: result.judges.self.A.problems })
  checks.require('self-check-B-text-detects', result.judges.self.B.problems.some((problem) => problem.startsWith('전 텍스트가 그대로가 아니다')), { problems: result.judges.self.B.problems })
  exitCode = checks.exitCode()
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.log('[fix1] 예외', result.error)
  exitCode = 2
} finally {
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
  if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: exitCode, raw: rawRel, result: exitCode === 0 ? '통과' : `실패 — ${result.error ? result.error.split('\n')[0] : failed.join(', ')}` })
  console.log('[fix1] exit', exitCode, failed)
  process.exit(exitCode)
}
