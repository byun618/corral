/* global window, document, getComputedStyle -- eval 로 렌더러 안에서 도는 클로저가 쓴다 */
// LIFE-512 **격리** 실측 — K2ⓓⓔⓕⓖ · K3ⓕⓖ · K4ⓑⓒⓓ · K7 (U3·U4·U5). 격리 = launchCorral(/tmp/l512i* 아래 userData·herdr 세션·제어 소켓).
//
// 장면: fixture 워크트리 1 · 탭 1 · pane 2(A = `while :; do date; sleep 0.2; done` 출력 pane, B = 색 한 줄을 찍고 멈춘 셸 — 버퍼 비교용).
// 설정 변경은 **전부 실제 입력**이다(제어 소켓 click/key/type = sendInputEvent, 히트테스트는 Chromium). 저장소를 직접 쓰지 않는다.
// 관측점:
//   ① main `counters` gridRequests(herdr 로 실제로 나간 resize) · corral.ndjson `stream.sync`(렌더러 격자 선언)
//   ② pane 마다 xterm cols·rows(`corralPaneWrites`) · 외관 옵션·live 셀(`corralPaneAppearance`) · 오프스크린 측정 셀(`corralTermProbe.cell`)
//   ③ 기대 격자 = parseInt(영역 상자 content px) ÷ live 셀 (gridForBox 산식) — 선언 cols·rows 와 대조
//   ④ 계산 스타일(pane 배경·xterm 배경·글자색·투명도·전환·디바이더) · 커서 span 클래스 · pane 스크린샷(U4)
// --label before : before 빌드 — U3 before 관측(설정 화면·설정 저장소가 없다: 셀은 고정 상수 경로, 3초 동안 격자 요청 0·live==measured)
// --label after  : 구현 빌드 — 전 단계. 끝에 같은 userData·herdr 세션으로 정상 종료(SIGTERM)·재기동해 K2ⓔ·K7 을 본다.
// 사용: node iso-k2.mjs --app <app> --work /tmp/l512iX --port 95NN --out <raw> --label before|after [--ledger <runs.md>]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { launchCorral, rpc, seedCorralRepo } from '../gui-diff/lib/corral.mjs'
import { beginRun, finishRun } from '../gui-diff/lib/runs.mjs'
import { compareRoi, decodePng } from '../gui-diff/lib/png.mjs'
import { pause, requirements } from '../l497/lib.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const work = args.work
if (!work?.startsWith('/tmp/l512i')) throw new Error('--work 는 /tmp/l512i*')
if (!['before', 'after'].includes(args.label)) throw new Error('--label before|after')
const out = path.resolve(args.out)
fs.mkdirSync(out, { recursive: true })
const command = `node app/scripts/l512/iso-k2.mjs ${process.argv.slice(2).join(' ')}`
const criterion = args.label === 'before' ? 'U3 before (before 빌드 — 설정 재측정 트리거 없음)' : 'K2ⓓⓔⓕⓖ·K3ⓕⓖ·K4ⓑⓒⓓ·K5ⓐ·K7 (격리, U3·U4·U5)'
const ledger = args.ledger ? path.resolve(args.ledger) : null
const rawRel = ledger ? path.relative(path.resolve(ledger, '../../../../..'), out) : out
const runId = ledger ? beginRun(ledger, { criterion, command, expectedExit: 0, raw: rawRel }) : null

/** 이 드라이버를 띄운 조상 프로세스(셸 래퍼 등)는 명령줄에 작업 경로를 담고 있다 — 504 가드가 자기 자신을 잡지 않게 뺀다(r1 실측: zsh -c 래퍼가 걸렸다). */
const ancestors = (() => {
  const set = new Set([process.pid])
  let pid = process.ppid
  for (let i = 0; i < 20 && pid > 1; i += 1) {
    set.add(pid)
    try { pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()) } catch { break }
  }
  return set
})()
const pgrep = (pattern) => { try { return execFileSync('pgrep', ['-fl', pattern], { encoding: 'utf8' }).trim().split('\n').filter((line) => line !== '' && !ancestors.has(Number(line.split(' ')[0]))).join('\n') } catch { return '' } }
const guard = pgrep(`${work}|l443-gui-diff`)
fs.writeFileSync(path.join(out, 'guard-before.txt'), `pgrep -fl "${work}|l443-gui-diff" → ${guard === '' ? '(없음)' : `\n${guard}`}\n`)
if (guard !== '') {
  console.log('[k2] 504 가드: 같은 경로·세션을 쓰는 프로세스가 있다 — 멈춘다\n' + guard)
  if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: 3, raw: rawRel, result: '실패 — 504 가드(프로세스 있음)' })
  process.exit(3)
}
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(work, { recursive: true })
const fixture = path.join(work, 'fx')
fs.mkdirSync(fixture)
execFileSync('sh', ['-c', 'git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init'], { cwd: fixture })

const result = { label: args.label, app: path.resolve(args.app), startedAt: new Date().toISOString(), steps: [], checks: null, notes: [] }
const save = () => fs.writeFileSync(path.join(out, 'iso-k2.json'), `${JSON.stringify(result, null, 1)}\n`)
const checks = requirements((row) => { if (!row.pass) console.log('[k2] 필수 조건 실패', JSON.stringify(row).slice(0, 500)) })
result.checks = checks.results
const owned = []
let exitCode = 0
let handle = null

const B_LINE = "printf '\\033[31mRED\\033[0m \\033[32mGREEN\\033[0m \\033[34mBLUE\\033[0m \\033[93mBYELLOW\\033[0m PLAIN\\n'"

try {
  handle = await launchCorral({ appRoot: path.resolve(args.app), workDir: work, port: Number(args.port), logDir: path.join(work, 'logs'), onSpawn: (entry) => owned.push(entry) })
  result.appPid = handle.status?.runtime?.pid
  const control = (request, timeout = 20_000) => rpc(handle.control, request, timeout)
  const evaluate = async (fn, arg = null) => (await control({ cmd: 'eval', code: `(${fn.toString()})(${JSON.stringify(arg)})` }, 60_000)).result
  const logPath = path.join(handle.paths.userData, 'corral.ndjson')
  const logLines = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [])
  const syncRowsSince = (length) => logLines().slice(length).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter((row) => row && row.tag === 'stream.sync')
  const until = async (label, fn, timeout = 10_000) => {
    const t0 = Date.now()
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() - t0 > timeout) throw new Error(`시간초과: ${label}`)
      await pause(150)
    }
  }
  const click = async (selector) => {
    const response = await control({ cmd: 'click', selector })
    checks.require(`click ${selector}`, response.ok === true, { response })
    return response
  }
  const key = (keyCode, modifiers = []) => control({ cmd: 'key', keyCode, modifiers })
  const type = (text) => control({ cmd: 'type', text })
  /** 입력칸 비우기 — r2 실측: sendInputEvent 의 ⌘A 는 전체 선택이 되지 않아 값이 뒤에 붙었다. 끝으로 가서 지운다(실제 키). */
  const clearField = async () => { await key('End'); for (let i = 0; i < 24; i += 1) await key('Backspace') }

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
  await click(`[data-worktree="${real}"] [data-worktree-card-surface]`)
  await pause(800)
  await click(`[data-main-tab="${created.tabId}"]`)
  await until('pane A box', () => evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, paneA))
  await pause(1200)
  const split = await evaluate((id) => window.corral.splitPane({ paneId: id, direction: 'right' }), paneA)
  const paneB = split?.paneId
  if (!paneB) throw new Error(`split 실패: ${JSON.stringify(split)}`)
  await until('pane B box', () => evaluate((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null, paneB))
  await pause(1500)
  result.panes = { A: paneA, B: paneB, tabId: created.tabId }
  await evaluate((input) => window.corral.termInput(input), { paneId: paneA, data: 'while :; do date; sleep 0.2; done\r' })
  await evaluate((input) => window.corral.termInput(input), { paneId: paneB, data: `clear; ${B_LINE}\r` })
  await click(`[data-term-pane-box="${paneB}"] .xterm-screen`)
  await pause(1500)

  /** 한 시점의 관측 — 격자·셀·외관·계산 스타일. */
  const observe = async (name, extra = {}) => {
    const counters = (await control({ cmd: 'counters' })).counters
    const dom = await evaluate((ids) => {
      const cs = (el, props) => (el ? Object.fromEntries(props.map((p) => [p, getComputedStyle(el).getPropertyValue(p)])) : null)
      const box = document.querySelector('[data-term-box]')
      const boxStyle = box ? getComputedStyle(box) : null
      const panes = (window.corralPaneWrites?.() ?? []).map((pane) => ({ paneId: pane.paneId, cols: pane.cols, rows: pane.rows, lastSeq: pane.lastSeq }))
      const appearance = (window.corralPaneAppearance?.() ?? []).map((row) => ({ paneId: row.paneId, options: { ...row.options, theme: row.options.theme ? { background: row.options.theme.background, foreground: row.options.theme.foreground, red: row.options.theme.red, cursor: row.options.theme.cursor, selectionBackground: row.options.theme.selectionBackground } : null }, writes: row.writes, live: row.live }))
      const probeCell = window.corralTermProbe?.cell?.() ?? null
      const paneStyles = Object.fromEntries(ids.map((id) => {
        const paneBox = document.querySelector(`[data-term-pane-box="${id}"]`)
        const spans = paneBox ? [...paneBox.querySelectorAll('.xterm-rows span')].filter((s) => /^(RED|GREEN|BLUE|BYELLOW|PLAIN)$/.test(s.textContent.trim())).map((s) => ({ text: s.textContent.trim(), cls: s.className, color: getComputedStyle(s).color })) : []
        const cursor = paneBox?.querySelector('.xterm-cursor')
        return [id, {
          pane: cs(paneBox, ['background-color', 'opacity', 'transition-property', 'transition-duration']),
          paneSelected: paneBox?.classList.contains('is-selected') ?? null,
          inner: cs(paneBox?.querySelector('.term-pane-inner'), ['background-color']),
          host: cs(paneBox?.querySelector('.term-host'), ['background-color']),
          xterm: cs(paneBox?.querySelector('.xterm'), ['background-color', 'color']),
          viewport: cs(paneBox?.querySelector('.xterm-viewport'), ['background-color']),
          screen: cs(paneBox?.querySelector('.xterm-screen'), ['background-color']),
          rect: paneBox ? (({ x, y, width, height }) => ({ x, y, width, height }))(paneBox.getBoundingClientRect()) : null,
          screenRect: paneBox?.querySelector('.xterm-screen') ? (({ x, y, width, height }) => ({ x, y, width, height }))(paneBox.querySelector('.xterm-screen').getBoundingClientRect()) : null,
          spans,
          cursor: cursor ? cursor.className : null,
        }]
      }))
      const paneDivider = document.querySelector('.pane-divider')
      const groupDivider = document.querySelector('.group-divider')
      return {
        panes,
        appearance,
        probeCell,
        box: boxStyle ? { width: boxStyle.width, height: boxStyle.height } : null,
        surfaces: {
          stack: cs(box, ['background-color']),
          group: cs(document.querySelector('[data-term-group]'), ['background-color', 'padding-top', 'padding-left']),
          chrome: cs(document.querySelector('.terminal-chrome'), ['background-color']),
          tabBar: cs(document.querySelector('[data-main-tab]')?.parentElement ?? null, ['background-color']),
        },
        rootVars: Object.fromEntries(['--term-bg', '--term-inactive-opacity', '--term-divider-color', '--term-divider-w', '--bg-surface'].map((v) => [v, getComputedStyle(document.documentElement).getPropertyValue(v).trim()])),
        paneDivider: paneDivider ? { hit: cs(paneDivider, ['width', 'height']), line: cs(paneDivider.querySelector('.pane-divider-line'), ['background-color', 'width', 'height']) } : null,
        groupDivider: groupDivider ? { hit: cs(groupDivider, ['width', 'height']), line: cs(groupDivider.querySelector('.group-divider-line'), ['background-color', 'width', 'height']) } : null,
        paneStyles,
        settingsOpen: document.querySelector('[data-settings-page]') !== null,
        probeLines: window.corralTermProbe ? (({ paneId, lines, lastSeq }) => ({ paneId, lastSeq, lines }))(window.corralTermProbe.read()) : null,
      }
    }, [paneA, paneB])
    const gridRequests = counters.reduce((sum, row) => sum + (row.gridRequests ?? 0), 0)
    const entry = { name, at: Date.now(), gridRequests, logLength: logLines().length, ...dom, ...extra }
    result.steps.push(entry)
    save()
    console.log('[k2]', name, JSON.stringify({ grid: gridRequests, panes: dom.panes.map((p) => `${p.cols}x${p.rows}`), live: dom.appearance.map((a) => a.live && `${a.live.width.toFixed(2)}x${a.live.height}`), measured: dom.probeCell?.measured && `${dom.probeCell.measured.width.toFixed(2)}x${dom.probeCell.measured.height}` }))
    return entry
  }
  /** 조작 뒤 3초 동안 200ms 마다 격자 요청 수·cols·rows 를 본다 — 마지막 변화 시각으로 수렴을 판정한다(K2ⓓ 2초). */
  const timeline = async (name, actionAt) => {
    const samples = []
    const t0 = Date.now()
    while (Date.now() - t0 < 3200) {
      const counters = (await control({ cmd: 'counters' })).counters
      const panes = await evaluate(() => (window.corralPaneWrites?.() ?? []).map((pane) => `${pane.cols}x${pane.rows}`).join(' '))
      samples.push({ t: Date.now() - actionAt, grid: counters.reduce((sum, row) => sum + (row.gridRequests ?? 0), 0), panes })
      await pause(200)
    }
    let lastChange = 0
    for (let i = 1; i < samples.length; i += 1) if (samples[i].grid !== samples[i - 1].grid || samples[i].panes !== samples[i - 1].panes) lastChange = samples[i].t
    const row = { name, samples, lastChangeMs: lastChange }
    result.timelines = [...(result.timelines ?? []), row]
    return row
  }
  const expectedGrid = (entry) => {
    const live = entry.appearance.find((row) => row.live)?.live
    if (!live || !entry.box) return null
    return { cols: Math.max(2, Math.floor(Number.parseInt(entry.box.width, 10) / live.width)), rows: Math.max(1, Math.floor(Number.parseInt(entry.box.height, 10) / live.height)) }
  }
  const declared = (rows) => rows.map((row) => row.groups)
  // K2ⓓ 「live == measured」 — 코디 답 Q1(raw/claude/q1-answer.txt): 높이 정확 일치 + 폭 |Δ| < 0.05px(xterm DOM 렌더 반올림 범위).
  // pane 별 원값과 Δ 를 남긴다. before 빌드는 corralPaneAppearance 가 없어 probe 의 live 한 pane 으로 본다.
  const CELL_TOL = 0.05
  const cellRows = (entry, measured = entry.probeCell?.measured) => {
    const lives = entry.appearance.length > 0 ? entry.appearance.map((row) => ({ paneId: row.paneId, live: row.live })) : [{ paneId: 'probe', live: entry.probeCell?.live ?? null }]
    return lives.map((row) => ({ ...row, measured, dWidth: row.live && measured ? Math.abs(row.live.width - measured.width) : null, dHeight: row.live && measured ? Math.abs(row.live.height - measured.height) : null }))
  }
  const cellsAgreeRows = (rows) => rows.length >= 1 && rows.every((row) => row.dWidth !== null && row.dWidth < CELL_TOL && row.dHeight === 0)
  const cellsAgree = (entry) => {
    const rows = cellRows(entry)
    result.cellComparisons = [...(result.cellComparisons ?? []), { step: entry.name, rows }]
    return (args.label === 'before' || entry.appearance.length >= 2) && cellsAgreeRows(rows)
  }

  const base = await observe('base')
  checks.require('two-panes', base.panes.length === 2, { panes: base.panes })
  checks.require('base-live-eq-measured', cellsAgree(base), { appearance: base.appearance.map((r) => r.live), probe: base.probeCell })
  const baseExpected = expectedGrid(base)
  result.baseExpected = baseExpected

  if (args.label === 'before') {
    // U3 before — 설정 저장소·설정 화면이 없다(`getSettingsSync` 없음). 3초 놓아 두면 격자 요청 0. 셀은 상수 13px 경로.
    const idleAt = Date.now()
    const idle = await timeline('before-idle', idleAt)
    const after = await observe('before-idle-end')
    result.u3Before = {
      settingsApi: await evaluate(() => ({ getSettingsSync: typeof window.corral.getSettingsSync, setSettings: typeof window.corral.setSettings, exposed: window.corral.preloadEnv?.exposedMethods?.filter((m) => /setting/i.test(m)) ?? [] })),
      fontSize: base.appearance[0]?.options?.fontSize ?? null,
      gridRequestsIdle: after.gridRequests - base.gridRequests,
      lastChangeMs: idle.lastChangeMs,
    }
    checks.require('before-no-settings-api', result.u3Before.settingsApi.getSettingsSync === 'undefined', result.u3Before.settingsApi)
    checks.require('before-idle-grid-0', result.u3Before.gridRequestsIdle === 0, result.u3Before)
  } else {
    // ── 설정 열기(실제 클릭) → 외관 ─────────────────────────────────────────────
    await click('[data-settings-open]')
    await until('settings open', () => evaluate(() => document.querySelector('[data-settings-page]') !== null), 5_000)
    await pause(400)
    const openedAt = await observe('settings-open')
    checks.require('settings-open-no-grid', openedAt.gridRequests === base.gridRequests, { base: base.gridRequests, now: openedAt.gridRequests })
    await click('[data-settings-nav-item="appearance"]')
    await until('appearance shown', () => evaluate(() => document.querySelector('[data-settings-section="appearance"]') !== null), 5_000)
    await pause(300)
    result.navOrder = await evaluate(() => [...document.querySelectorAll('[data-settings-nav-item]')].map((el) => el.getAttribute('data-settings-nav-item')))
    checks.require('nav-appearance-above-shortcuts', JSON.stringify(result.navOrder) === JSON.stringify(['appearance', 'shortcuts']), { order: result.navOrder })

    // ── K2ⓓ 확정 변경 1회: + 한 번(14→15) ────────────────────────────────────
    const s0 = await observe('k2d-before-plus')
    const plusAt = Date.now()
    await click('[data-settings-font-size-step="1"]')
    const t1 = await timeline('k2d-plus-once', plusAt)
    const s1 = await observe('k2d-after-plus')
    const sync1 = syncRowsSince(s0.logLength)
    result.k2dOnce = { requests: s1.gridRequests - s0.gridRequests, syncDeclarations: declared(sync1), expected: expectedGrid(s1), panes: s1.panes, lastChangeMs: t1.lastChangeMs, fontSizes: s1.appearance.map((r) => r.options.fontSize) }
    checks.require('k2d-once-fontsize-15', s1.appearance.every((r) => r.options.fontSize === 15), result.k2dOnce.fontSizes)
    checks.require('k2d-once-requests-le-1', result.k2dOnce.requests <= 1 && result.k2dOnce.requests >= 1, result.k2dOnce)
    checks.require('k2d-once-live-eq-measured', cellsAgree(s1), { live: s1.appearance.map((r) => r.live), probe: s1.probeCell })
    // 양성 대조(코디 답 Q1 (2)): 같은 비교식이 「한쪽만 옛 글꼴」 을 실패로 잡는가 — 새 글꼴(15) live 대 옛 글꼴(14) measured.
    const stale = cellRows(s1, s0.probeCell?.measured)
    result.positiveControl = { kind: 'live(15px) vs measured(14px)', rows: stale, agreed: cellsAgreeRows(stale) }
    checks.require('k2d-positive-control-stale-font-fails', cellsAgreeRows(stale) === false && stale.every((row) => row.dWidth !== null && row.dWidth >= CELL_TOL), result.positiveControl)
    const decl1 = sync1.at(-1)?.groups ?? ''
    checks.require('k2d-once-declared-eq-gridForBox', result.k2dOnce.expected !== null && decl1.endsWith(`${result.k2dOnce.expected.cols}x${result.k2dOnce.expected.rows}`), { decl1, expected: result.k2dOnce.expected })
    // herdr 분배: 분할 오른쪽 — 두 pane cols 의 합과 선언 cols 의 차(경계 몫)가 base 와 같고, rows 는 선언 rows 와 같다.
    const gap = (entry, expected) => expected.cols - entry.panes.reduce((sum, p) => sum + p.cols, 0)
    result.k2dOnce.gap = { base: baseExpected && gap(base, baseExpected), now: result.k2dOnce.expected && gap(s1, result.k2dOnce.expected) }
    checks.require('k2d-once-herdr-distribution', result.k2dOnce.expected !== null && baseExpected !== null && result.k2dOnce.gap.now === result.k2dOnce.gap.base && s1.panes.every((p) => p.rows === result.k2dOnce.expected.rows), { panes: s1.panes, expected: result.k2dOnce.expected, gap: result.k2dOnce.gap })
    checks.require('k2d-once-converged-2s', t1.lastChangeMs <= 2000, { lastChangeMs: t1.lastChangeMs })

    // ── K2ⓓ 연속: + 5연타(1초 안) ─────────────────────────────────────────────
    const s2 = await observe('k2d-before-burst')
    const burstAt = Date.now()
    for (let i = 0; i < 5; i += 1) { await control({ cmd: 'click', selector: '[data-settings-font-size-step="1"]' }); await pause(120) }
    result.burstDurationMs = Date.now() - burstAt
    const t2 = await timeline('k2d-burst-5', burstAt)
    const s3 = await observe('k2d-after-burst')
    result.k2dBurst = { requests: s3.gridRequests - s2.gridRequests, syncDeclarations: declared(syncRowsSince(s2.logLength)), lastChangeMs: t2.lastChangeMs, fontSizes: s3.appearance.map((r) => r.options.fontSize), expected: expectedGrid(s3), panes: s3.panes, durationMs: result.burstDurationMs }
    checks.require('k2d-burst-within-1s', result.burstDurationMs <= 1000, { ms: result.burstDurationMs })
    checks.require('k2d-burst-fontsize-20', s3.appearance.every((r) => r.options.fontSize === 20), result.k2dBurst.fontSizes)
    checks.require('k2d-burst-requests-le-5', result.k2dBurst.requests <= 5, result.k2dBurst)
    checks.require('k2d-burst-converged-2s', t2.lastChangeMs <= 2000, { lastChangeMs: t2.lastChangeMs })
    checks.require('k2d-burst-live-eq-measured', cellsAgree(s3), { live: s3.appearance.map((r) => r.live), probe: s3.probeCell })
    // 진동 없음: 마지막 1초 샘플이 모두 같다.
    const tail = t2.samples.filter((s) => s.t >= t2.samples.at(-1).t - 1000)
    checks.require('k2d-burst-no-oscillation', new Set(tail.map((s) => `${s.grid}|${s.panes}`)).size === 1, { tail })

    // ── K2ⓓ 숫자 입력 「1」「6」 + Enter ───────────────────────────────────────
    const s4 = await observe('k2d-before-typing')
    await click('[data-settings-number="글꼴 크기"]')
    await clearField()
    const typeAt = Date.now()
    await type('1')
    await pause(250)
    await type('6')
    await pause(250)
    const midTyping = await observe('k2d-mid-typing')
    const enterAt = Date.now()
    await key('Return')
    const t3 = await timeline('k2d-typing-16', enterAt)
    const s5 = await observe('k2d-after-typing')
    result.k2dTyping = { requestsWhileTyping: midTyping.gridRequests - s4.gridRequests, requests: s5.gridRequests - s4.gridRequests, syncDeclarations: declared(syncRowsSince(s4.logLength)), lastChangeMs: t3.lastChangeMs, fontSizes: s5.appearance.map((r) => r.options.fontSize), expected: expectedGrid(s5), panes: s5.panes }
    checks.require('k2d-typing-none-before-enter', result.k2dTyping.requestsWhileTyping === 0, result.k2dTyping)
    checks.require('k2d-typing-fontsize-16', s5.appearance.every((r) => r.options.fontSize === 16), result.k2dTyping.fontSizes)
    checks.require('k2d-typing-requests-le-1', result.k2dTyping.requests <= 1, result.k2dTyping)
    result.k2dTyping.typingMs = enterAt - typeAt
    checks.require('k2d-typing-converged-2s', t3.lastChangeMs <= 2000, { lastChangeMs: t3.lastChangeMs })
    checks.require('k2d-typing-live-eq-measured', cellsAgree(s5), { live: s5.appearance.map((r) => r.live), probe: s5.probeCell })

    // ── K2ⓕ 셀을 안 바꾸는 설정 = 격자 요청 0 ────────────────────────────────
    const noGrid = async (name, act) => {
      const before = await observe(`${name}-before`)
      await act()
      await pause(1500)
      const after = await observe(`${name}-after`)
      const delta = after.gridRequests - before.gridRequests
      const syncs = syncRowsSince(before.logLength).length
      result.k2f = { ...(result.k2f ?? {}), [name]: { gridRequests: delta, syncDeclarations: syncs } }
      checks.require(`k2f-${name}-grid-0`, delta === 0 && syncs === 0, { delta, syncs })
      return { before, after }
    }
    await click('[data-settings-disclosure="typography"] .settings-disclosure-toggle')
    await pause(300)
    await noGrid('weight', async () => {
      await click('[data-settings-number="글꼴 두께"]')
      await clearField()
      await type('400')
      await key('Return')
    })
    // ── K3ⓕ 테마: Dracula(실제 입력 — 검색에 타이핑 → 클릭) ─────────────────
    const bufferBefore = (await observe('k3-buffer-before')).probeLines
    const theme = await noGrid('theme', async () => {
      await click('[data-settings-theme-search]')
      await type('Dracula')
      await pause(300)
      await click('[data-settings-theme-option="Dracula"]')
    })
    const bufferAfter = theme.after.probeLines
    result.k3f = {
      before: theme.before.appearance.map((r) => ({ paneId: r.paneId, theme: r.options.theme })),
      after: theme.after.appearance.map((r) => ({ paneId: r.paneId, theme: r.options.theme, writes: r.writes.slice(-3) })),
      bufferSame: JSON.stringify(bufferBefore?.lines) === JSON.stringify(bufferAfter?.lines),
      bufferSeq: { before: bufferBefore?.lastSeq, after: bufferAfter?.lastSeq },
      bufferPane: bufferAfter?.paneId,
      selectedText: await evaluate(() => document.querySelector('[data-settings-theme-selected]')?.textContent ?? null),
    }
    checks.require('k3f-all-panes-dracula', theme.after.appearance.every((r) => r.options.theme?.background === '#282a36' && r.options.theme?.red === '#ff5555'), result.k3f.after)
    checks.require('k3f-buffer-unchanged', result.k3f.bufferSame && result.k3f.bufferPane === paneB && bufferBefore?.lastSeq === bufferAfter?.lastSeq, { seq: result.k3f.bufferSeq })
    // 같은 테마를 다시 고른다 → theme 쓰기 없음.
    const writesBefore = theme.after.appearance.map((r) => r.writes.length)
    await click('[data-settings-theme-option="Dracula"]')
    await pause(800)
    const again = await observe('k3f-same-theme-again')
    result.k3f.sameAgainWrites = again.appearance.map((r, i) => r.writes.slice(writesBefore[i]))
    checks.require('k3f-same-theme-no-write', again.appearance.every((r, i) => r.writes.slice(writesBefore[i]).every((w) => !w.keys.includes('theme'))), result.k3f.sameAgainWrites)
    // ── 커서 bar·깜박임 끔 / 투명도 0.5 / 디바이더 색·두께 — 전부 격자 0 ─────
    await click('[data-settings-disclosure="advanced"] .settings-disclosure-toggle')
    await pause(300)
    await noGrid('cursor', async () => {
      await click('[data-settings-block="cursor"] [data-segment-value="bar"]')
      await click('[data-settings-block="cursor"] [data-settings-switch]')
    })
    await noGrid('opacity', async () => {
      await click('[data-settings-number="비활성 창 불투명도"]')
      await clearField()
      await type('0.5')
      await key('Return')
    })
    await noGrid('divider', async () => {
      await click('[data-settings-color="다크 디바이더 색상"]')
      await clearField()
      await type('#ff0000')
      await key('Return')
      await click('[data-settings-number="구분선 두께"]')
      await clearField()
      await type('8')
      await key('Return')
    })
    result.settingsFileAfterEdits = fs.existsSync(path.join(handle.paths.userData, 'settings.json')) ? JSON.parse(fs.readFileSync(path.join(handle.paths.userData, 'settings.json'), 'utf8')) : null
    // 설정 닫기 → 워크스페이스에서 계산 값 관측.
    await click('[data-settings-back]')
    await until('settings closed', () => evaluate(() => document.querySelector('[data-settings-page]') === null), 5_000)
    await pause(600)
    await click(`[data-term-pane-box="${paneB}"] .xterm-screen`)
    await pause(800)
    const ws1 = await observe('workspace-after-edits')
    result.k4 = {
      paneStyles: ws1.paneStyles,
      paneDivider: ws1.paneDivider,
      rootVars: ws1.rootVars,
    }
    const styles = ws1.paneStyles ?? {}
    checks.require('k4b-cursor-bar-no-blink-B', /xterm-cursor-bar/.test(styles[paneB]?.cursor ?? '') && !/xterm-cursor-blink/.test(styles[paneB]?.cursor ?? ''), { cursor: styles[paneB]?.cursor })
    checks.require('k4c-inactive-opacity-0.5', styles[paneA]?.pane?.opacity === '0.5' && styles[paneB]?.pane?.opacity === '1' && styles[paneB]?.paneSelected === true, { A: styles[paneA]?.pane, B: styles[paneB]?.pane })
    checks.require('k4c-transition-140ms', /opacity/.test(styles[paneA]?.pane?.['transition-property'] ?? '') && styles[paneA]?.pane?.['transition-duration'] === '0.14s', styles[paneA]?.pane)
    checks.require('k4d-pane-divider', ws1.paneDivider?.line?.['background-color'] === 'rgb(255, 0, 0)' && ws1.paneDivider?.line?.width === '8px' && ws1.paneDivider?.hit?.width === '12px', ws1.paneDivider)
    checks.require('k3g-pane-bg-theme', styles[paneA]?.pane?.['background-color'] === 'rgb(40, 42, 54)' && styles[paneB]?.pane?.['background-color'] === 'rgb(40, 42, 54)', { A: styles[paneA]?.pane, B: styles[paneB]?.pane })
    checks.require('k3f-red-span-dracula', (styles[paneB]?.spans ?? []).some((s) => s.text === 'RED' && s.color === 'rgb(255, 85, 85)'), styles[paneB]?.spans)
    // 영역 디바이더(⌘⌥D 로 영역 분할) — 이 조작 자체는 배치 변경이라 격자 요청이 나간다(관측만). 그 뒤 두께 변경은 0.
    await click(`[data-term-pane-box="${paneB}"] .xterm-screen`)
    await key('D', ['meta', 'alt'])
    await pause(1500)
    const grouped = await observe('group-split')
    result.k4.groupDivider = grouped.groupDivider
    checks.require('k4d-group-divider', grouped.groupDivider?.line?.['background-color'] === 'rgb(255, 0, 0)' && grouped.groupDivider?.line?.width === '8px' && grouped.groupDivider?.hit?.width === '12px', grouped.groupDivider)

    // ── U4: Menlo 400 대 500 (양성 대조: Menlo 500 대 SF Mono 500, Menlo 400 대 700) ──
    // 커서 깜박임은 이미 껐다. B 는 출력이 멈춘 pane 이다.
    const setTypography = async (patchLabel, steps) => {
      await click('[data-settings-open]')
      await until('settings open', () => evaluate(() => document.querySelector('[data-settings-page]') !== null), 5_000)
      await click('[data-settings-nav-item="appearance"]')
      await pause(300)
      for (const step of steps) await step()
      await click('[data-settings-back]')
      await until('settings closed', () => evaluate(() => document.querySelector('[data-settings-page]') === null), 5_000)
      await pause(1200)
      const shot = (await control({ cmd: 'shot', name: `u4-${patchLabel}`, selector: `[data-term-pane-box="${paneB}"] .xterm-screen` }, 30_000)).file
      const copy = path.join(out, `u4-${patchLabel}.png`)
      fs.copyFileSync(shot, copy)
      const opts = (await observe(`u4-${patchLabel}`)).appearance.find((r) => r.paneId === paneB)?.options
      return { file: copy, sha256: crypto.createHash('sha256').update(fs.readFileSync(copy)).digest('hex'), fontFamily: opts?.fontFamily, fontWeight: opts?.fontWeight }
    }
    const setNumber = (label, value) => async () => { await click(`[data-settings-number="${label}"]`); await clearField(); await type(String(value)); await key('Return'); await pause(300) }
    const openTypo = async () => { await click('[data-settings-disclosure="typography"] .settings-disclosure-toggle'); await pause(200) }
    const setFamily = (value) => async () => { await click('[data-settings-font-family]'); await clearField(); await type(value); await key('Return'); await pause(400) }
    const shots = {}
    shots.menlo400 = await setTypography('menlo-400', [setFamily('Menlo'), openTypo, setNumber('글꼴 두께', 400)])
    shots.menlo500 = await setTypography('menlo-500', [openTypo, setNumber('글꼴 두께', 500)])
    shots.menlo700 = await setTypography('menlo-700', [openTypo, setNumber('글꼴 두께', 700)])
    shots.monaco500 = await setTypography('monaco-500', [setFamily('Monaco'), openTypo, setNumber('글꼴 두께', 500)])
    shots.sfmono500 = await setTypography('sfmono-500', [setFamily('SF Mono'), openTypo, setNumber('글꼴 두께', 500)])
    // K7 은 글꼴군도 기본값(SF Mono)과 달라야 한다(r4 는 기본값 그대로 재기동했다 — r5 보강). 실제 입력으로 Menlo 로 두고 재기동한다.
    shots.k7family = await setTypography('k7-family-menlo', [setFamily('Menlo')])
    // 글꼴 이용 가능 여부 — 캔버스 폭이 폴백(monospace·serif) 둘 다와 같으면 그 이름은 렌더러에 없다(r3 실측: SF Mono 500 = Menlo 500 픽셀 동일).
    result.fontAvailability = await evaluate(() => {
      const ctx = document.createElement('canvas').getContext('2d')
      const width = (family) => { ctx.font = `20px ${family}`; return ctx.measureText('mmmmmmmmmmlli0O@#WWWW').width }
      return Object.fromEntries(['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code'].map((name) => {
        const vsMono = width(`"${name}", monospace`) !== width('monospace')
        const vsSerif = width(`"${name}", serif`) !== width('serif')
        return [name, { available: vsMono || vsSerif, width: width(`"${name}", serif`), monospace: width('monospace'), serif: width('serif') }]
      }))
    })
    const cmp = (a, b) => {
      const left = decodePng(fs.readFileSync(a.file))
      const right = decodePng(fs.readFileSync(b.file))
      const w = Math.min(left.width, right.width)
      const h = Math.min(left.height, right.height)
      return { sizes: [`${left.width}x${left.height}`, `${right.width}x${right.height}`], ...compareRoi(left, right, { x: 0, y: 0, w, h }, { x: 0, y: 0, w, h }) }
    }
    result.u4 = { shots, menlo400vs500: cmp(shots.menlo400, shots.menlo500), control_menlo500vsMonaco500: cmp(shots.menlo500, shots.monaco500), control_menlo400vs700: cmp(shots.menlo400, shots.menlo700), sfmono500vsMenlo500: cmp(shots.sfmono500, shots.menlo500) }
    checks.require('u4-positive-control-detects', result.u4.control_menlo500vsMonaco500.differing > 0 && result.u4.control_menlo400vs700.differing > 0, { a: result.u4.control_menlo500vsMonaco500, b: result.u4.control_menlo400vs700 })
    console.log('[k2] U4', JSON.stringify({ m400v500: result.u4.menlo400vs500.differing, ctlFamily: result.u4.control_menlo500vsMonaco500.differing, ctlBold: result.u4.control_menlo400vs700.differing, sfVsMenlo: result.u4.sfmono500vsMenlo500.differing, fonts: result.fontAvailability }))

    // ── K7·K2ⓔ 영속·재기동: 기본값과 다른 값으로 정상 종료(SIGTERM) → 같은 userData·herdr 로 재기동 ──
    // 지금 값: 글꼴 16 · Menlo · 굵기 500 · Dracula · bar·깜박임 끔 · 투명도 0.5 · 디바이더 #ff0000 8px (기본값: 14 · SF Mono · 500 · Ghostty · block·깜박임 · 0.9 · #3f3f46 3px).
    const settingsFile = path.join(handle.paths.userData, 'settings.json')
    const uiPrefsFile = path.join(handle.paths.userData, 'ui-prefs.json')
    result.k7 = { settingsBefore: JSON.parse(fs.readFileSync(settingsFile, 'utf8')), uiPrefsKeysBefore: fs.existsSync(uiPrefsFile) ? Object.keys(JSON.parse(fs.readFileSync(uiPrefsFile, 'utf8'))) : null }
    const lastSyncBefore = syncRowsSince(0).at(-1)?.groups ?? null
    result.k7.lastSyncBeforeQuit = lastSyncBefore
    const appPid = result.appPid
    process.kill(appPid, 'SIGTERM')
    await until('app exit', async () => { try { process.kill(appPid, 0); return false } catch { return true } }, 30_000)
    await until('control socket gone', () => !fs.existsSync(handle.control), 10_000).catch(() => false)
    const logLenAtQuit = logLines().length
    result.k7.quitLogTail = logLines().slice(-3)
    const reopened = spawnSync(process.execPath, [path.join(path.resolve(args.app), 'cli/corral.mjs'), 'open', '--json'], { env: handle.env, encoding: 'utf8', timeout: 120_000 })
    if (reopened.status !== 0) throw new Error(`재기동 실패 ${reopened.status}\n${reopened.stdout}\n${reopened.stderr}`)
    const status2 = JSON.parse(reopened.stdout).result
    owned.push({ pid: status2?.runtime?.pid ?? null, label: 'corral desktop (재기동)' })
    result.appPid2 = status2?.runtime?.pid
    await until('control socket', () => fs.existsSync(handle.control), 60_000)
    await until('link live', async () => (await rpc(handle.control, { cmd: 'state' }).catch(() => ({}))).state?.link?.phase === 'live', 60_000)
    // 사용자처럼 워크트리·탭을 고른다(재기동 뒤 첫 화면에서).
    await pause(1500)
    await click(`[data-worktree="${real}"] [data-worktree-card-surface]`).catch(() => null)
    await pause(800)
    await until('panes back', () => evaluate((ids) => ids.every((id) => document.querySelector(`[data-term-pane-box="${id}"]`) !== null), [paneA, paneB]), 20_000).catch(() => false)
    await pause(1500)
    const back = await observe('restart-workspace')
    // 첫 행은 영역이 아직 없는 빈 선언("")이다 — 격자 요청이 아니다. 비지 않은 첫 선언부터 본다.
    const syncAfterRestartAll = syncRowsSince(logLenAtQuit)
    const syncAfterRestart = syncAfterRestartAll.filter((row) => (row.groups ?? '') !== '')
    const restartExpected = expectedGrid(back)
    result.k2e = { syncDeclarationsAll: declared(syncAfterRestartAll), syncDeclarations: declared(syncAfterRestart), expectedWithSavedCell: restartExpected, defaultCellWouldBe: null, live: back.appearance.map((r) => r.live), probe: back.probeCell, fontSizes: back.appearance.map((r) => r.options.fontSize) }
    // 기본값(14) 셀이었다면 나왔을 격자 — 같은 상자에서 14px 셀 폭으로 계산(셀 크기는 측정 대신 base 관측의 14px live 를 쓴다).
    const baseLive = base.appearance.find((r) => r.live)?.live
    if (baseLive && back.box) result.k2e.defaultCellWouldBe = { cols: Math.floor(Number.parseInt(back.box.width, 10) / baseLive.width), rows: Math.floor(Number.parseInt(back.box.height, 10) / baseLive.height) }
    checks.require('k2e-first-sync-saved-cell', syncAfterRestart.length > 0 && restartExpected !== null && (syncAfterRestart[0].groups ?? '').split(' ').every((group) => group.endsWith(`${restartExpected.cols}x${restartExpected.rows}`)), { first: syncAfterRestart[0]?.groups, expected: restartExpected })
    checks.require('k2e-no-default-cell-sync', result.k2e.defaultCellWouldBe !== null && syncAfterRestart.every((row) => !(row.groups ?? '').includes(`${result.k2e.defaultCellWouldBe.cols}x${result.k2e.defaultCellWouldBe.rows}`)), { rows: declared(syncAfterRestart), defaultWouldBe: result.k2e.defaultCellWouldBe })
    // K7: 모든 값이 pane 에 그대로.
    const st = back.paneStyles
    result.k7.after = { appearance: back.appearance.map((r) => ({ paneId: r.paneId, options: r.options })), paneStyles: st, paneDivider: back.paneDivider, groupDivider: back.groupDivider, rootVars: back.rootVars }
    checks.require('k7-pane-values', back.appearance.length >= 2 && back.appearance.every((r) => r.options.fontSize === 16 && r.options.theme?.background === '#282a36' && r.options.cursorStyle === 'bar' && r.options.cursorBlink === false && r.options.fontWeight === 500 && String(r.options.fontFamily).startsWith('"Menlo"')), result.k7.after.appearance)
    checks.require('k7-css-values', back.rootVars['--term-inactive-opacity'] === '0.5' && back.rootVars['--term-divider-color'] === '#ff0000' && back.rootVars['--term-divider-w'] === '8px' && back.rootVars['--term-bg'] === '#282a36', back.rootVars)
    // 설정 화면에도 그대로(실제 클릭으로 연다).
    await click('[data-settings-open]')
    await until('settings open', () => evaluate(() => document.querySelector('[data-settings-page]') !== null), 5_000)
    await click('[data-settings-nav-item="appearance"]')
    await pause(300)
    await click('[data-settings-disclosure="typography"] .settings-disclosure-toggle')
    await click('[data-settings-disclosure="advanced"] .settings-disclosure-toggle')
    await pause(300)
    result.k7.screen = await evaluate(() => ({
      fontSize: document.querySelector('[data-settings-number="글꼴 크기"]')?.value,
      fontFamily: document.querySelector('[data-settings-font-family]')?.value,
      weight: document.querySelector('[data-settings-number="글꼴 두께"]')?.value,
      selectedTheme: document.querySelector('[data-settings-theme-selected]')?.textContent,
      cursor: document.querySelector('[data-settings-block="cursor"] [aria-checked="true"][data-segment-value]')?.getAttribute('data-segment-value'),
      blink: document.querySelector('[data-settings-block="cursor"] [data-settings-switch]')?.getAttribute('aria-checked'),
      opacity: document.querySelector('[data-settings-number="비활성 창 불투명도"]')?.value,
      dividerColor: document.querySelector('[data-settings-color="다크 디바이더 색상"]')?.value,
      dividerWidth: document.querySelector('[data-settings-number="구분선 두께"]')?.value,
    }))
    checks.require('k7-screen-values', JSON.stringify(result.k7.screen) === JSON.stringify({ fontSize: '16', fontFamily: 'Menlo', weight: '500', selectedTheme: '선택됨: Dracula', cursor: 'bar', blink: 'false', opacity: '0.5', dividerColor: '#ff0000', dividerWidth: '8' }), result.k7.screen)
    result.k7.settingsAfter = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    result.k7.uiPrefsKeysAfter = fs.existsSync(uiPrefsFile) ? Object.keys(JSON.parse(fs.readFileSync(uiPrefsFile, 'utf8'))) : null
    const settingKeys = Object.keys(result.k7.settingsAfter).filter((k) => k !== 'version')
    checks.require('k7-uiprefs-no-setting-keys', (result.k7.uiPrefsKeysAfter ?? []).every((k) => !settingKeys.includes(k)), { uiPrefs: result.k7.uiPrefsKeysAfter, settings: settingKeys })
    await click('[data-settings-back]')
  }
  exitCode = checks.exitCode()
} catch (error) {
  result.error = String(error?.stack ?? error)
  console.log('[k2] 예외', result.error)
  exitCode = 2
} finally {
  const pids = owned.filter((entry) => entry.pid).map((entry) => entry.pid)
  result.owned = owned
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* 이미 끝남 */ } }
  await pause(2000)
  result.alive = pids.filter((pid) => { try { process.kill(pid, 0); return true } catch { return false } })
  for (const pid of result.alive) { try { process.kill(pid, 'SIGKILL') } catch { /* 이미 끝남 */ } }
  const leftover = pgrep(work)
  result.leftover = leftover
  for (const line of leftover.split('\n').filter(Boolean)) { try { process.kill(Number(line.split(' ')[0]), 'SIGTERM') } catch { /* 이미 끝남 */ } }
  await pause(1000)
  const left = pgrep(`${work}|l443-gui-diff`)
  fs.writeFileSync(path.join(out, 'guard-after.txt'), `pgrep -fl "${work}|l443-gui-diff" → ${left === '' ? '(없음)' : `\n${left}`}\nowned=${JSON.stringify(owned)}\n`)
  result.finishedAt = new Date().toISOString()
  result.exitCode = exitCode
  save()
  const failed = checks.failed().map((row) => row.name)
  if (ledger) finishRun(ledger, runId, { criterion, command, expectedExit: 0, actualExit: exitCode, raw: rawRel, result: exitCode === 0 ? '통과' : `실패 — ${result.error ? result.error.split('\n')[0] : failed.join(', ')}` })
  console.log('[k2] exit', exitCode, failed)
  process.exit(exitCode)
}
