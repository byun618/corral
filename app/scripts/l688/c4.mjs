/* global fetch, WebSocket */
// LIFE-688 C4 오라클 — 패널 pane 행 툴팁의 「주 프로세스」 줄을 같은 시각 ps 와 대조한다. 코디가 사용자 입회로 돌린다(reviews.md 「C4 오라클 명세」).
// 설치본을 `--remote-debugging-port=<port>` 로 띄운 뒤, app/ 에서:
//   node scripts/l688/c4.mjs --port <port> --out <out-dir> [--max-captures 4] [--console-ms 10000]
//                            [--herdr-pid <pid>] [--herdr-path /Applications/corral.app/Contents/Resources/backend/herdr]
//   node scripts/l688/c4.mjs --fixture <fixture.json> --out <out-dir>      # 판별력 자기점검 — 가짜 입력, C4 통과가 아니다
// 하는 일(전부 읽기 — 사용자 pane 에 키·명령을 넣지 않는다. 패널이 닫혀 있으면 상태바 세그먼트를 DOM `.click()` 으로 연다):
//   한 캡처 = 렌더러가 받은 다음 스냅샷(IPC 값)과 같은 프레임의 패널 pane 행 DOM `title` 전부 → 바로 뒤 `LC_ALL=C ps -axo pid=,ppid=,tpgid=,ucomm=` 한 번.
//   셸 pid = 행 `measure.pids` 중 ppid 가 herdr 서버 pid 인 것(툴팁 PID 에서 거꾸로 만들지 않는다).
//   기대 = 셸 tpgid 가 그 행 pids 안이면 그 pid, 아니면 셸. 이름 = 그 pid 의 ucomm 뒤 공백을 뺀 값(ucomm 칸이 비면 이름 없음 → 툴팁은 PID 만).
//   측정된 행 전부가 대상 — 줄 없는 측정 행 = 불일치, 측정 불가 행에 줄 있음 = 불일치.
//   불일치 행은 다음 캡처에서 재표본, 두 캡처 연속 불일치만 실패. 최대 캡처 수 안에 재표본이 끝나지 않으면 미결.
// 종료코드: 0 = 불일치 없음(재표본으로 풀린 것 포함)·콘솔 오류 0 · 1 = 두 캡처 연속 불일치 행 있음 · 3 = 미결(재표본 못 끝냄) ·
//           4 = 행은 일치하나 렌더러 콘솔 오류 있음(C4ⓒ) · 2 = 사용법·연결 오류.
// 오라클은 제품 규칙을 다시 적은 것이라 배선 증거(herdr 셸 pid → ps → IPC → DOM)로만 판정표에 적는다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs), []))
const out = args.out
const maxCaptures = Number(args['max-captures'] ?? 4)
const consoleMs = Number(args['console-ms'] ?? 10000)
if (!out || (!args.port && !args.fixture) || !(maxCaptures >= 2)) {
  console.error('사용법: --port <port> --out <out-dir> [--max-captures n≥2] | --fixture <json> --out <out-dir>')
  process.exit(2)
}
fs.mkdirSync(out, { recursive: true })

const NAME_LIMIT = 16
const MAIN_LINE = /^주 프로세스 (?:(.*) · )?PID (\d+)$/

/** `pid ppid tpgid ucomm…` — ucomm 은 공백을 포함할 수 있고 뒤 공백 패딩이 붙는다. 비면 null. */
function parsePs(text) {
  const rows = new Map()
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(-?\d+)(?:\s(.*))?$/)
    if (!match) continue
    const name = (match[4] ?? '').trim()
    rows.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), tpgid: Number(match[3]), name: name === '' ? null : name })
  }
  return rows
}

/** 툴팁에서 주 프로세스 줄. 없으면 null, 둘 이상이면 `multiple`. */
function tooltipMain(title) {
  const lines = (title ?? '').split('\n').filter((line) => line.startsWith('주 프로세스'))
  if (lines.length === 0) return null
  if (lines.length > 1) return { multiple: true, lines }
  const match = lines[0].match(MAIN_LINE)
  if (!match) return { malformed: true, line: lines[0] }
  return { pid: Number(match[2]), name: match[1] ?? null, line: lines[0] }
}

/** 한 캡처 판정 — 순수 함수(실측·fixture 공용). */
function judge({ snapshot, dom, psText, herdrPid }) {
  const ps = parsePs(psText)
  const titles = new Map(dom.map((row) => [row.paneId, row.title]))
  return snapshot.panes.map((pane) => {
    const domPresent = titles.has(pane.paneId)
    const shown = tooltipMain(titles.get(pane.paneId))
    const base = { paneId: pane.paneId, title: pane.title, agent: pane.agent ?? 'shell', state: pane.measure.state, domPresent, tooltipLine: shown?.line ?? null, snapshotMain: pane.main ?? null }
    if (!domPresent) return { ...base, ok: false, kind: 'domRowMissing' }
    if (pane.measure.state !== 'measured') return shown === null ? { ...base, ok: true, kind: 'unmeasuredNoLine' } : { ...base, ok: false, kind: 'lineOnUnmeasured' }
    const pids = pane.measure.pids
    const shells = pids.filter((pid) => ps.get(pid)?.ppid === herdrPid)
    if (shells.length !== 1) return { ...base, ok: false, kind: 'shellUnknown', shells }
    const shell = ps.get(shells[0])
    const expectedPid = shell.tpgid > 0 && pids.includes(shell.tpgid) ? shell.tpgid : shell.pid
    const expectedRow = ps.get(expectedPid)
    if (expectedRow === undefined) return { ...base, ok: false, kind: 'expectedPidGone', shell: shell.pid, shellTpgid: shell.tpgid, expectedPid }
    const expected = { pid: expectedPid, name: expectedRow.name }
    const truncated = expected.name !== null && expected.name.length >= NAME_LIMIT
    const common = { ...base, shell: shell.pid, shellTpgid: shell.tpgid, expected, truncated }
    if (shown === null) return { ...common, ok: false, kind: 'lineMissing' }
    if (shown.multiple || shown.malformed) return { ...common, ok: false, kind: 'lineMalformed' }
    if (shown.pid !== expected.pid) return { ...common, ok: false, kind: 'pidWrong', shown: { pid: shown.pid, name: shown.name } }
    if (shown.name !== expected.name) return { ...common, ok: false, kind: 'nameWrong', shown: { pid: shown.pid, name: shown.name } }
    return { ...common, ok: true, kind: 'match' }
  })
}

// ── 입력: 실측(CDP) 또는 fixture ──────────────────────────────────────────────
let source
let consoleErrors = []
if (args.fixture) {
  const fixture = JSON.parse(fs.readFileSync(args.fixture, 'utf8'))
  let index = 0
  source = {
    herdrPid: fixture.herdrPid,
    capture: async () => {
      const capture = fixture.captures[Math.min(index, fixture.captures.length - 1)]
      index += 1
      return { at: `fixture#${index}`, snapshot: capture.snapshot, dom: capture.dom, psText: capture.ps }
    },
    finish: async () => {},
  }
} else {
  const herdrPath = args['herdr-path'] ?? '/Applications/corral.app/Contents/Resources/backend/herdr'
  let herdrPid = args['herdr-pid'] === undefined ? null : Number(args['herdr-pid'])
  if (herdrPid === null) {
    const procs = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024 })
    const servers = procs.split('\n').filter((line) => line.includes(herdrPath) && / server(\s|$)/.test(line)).map((line) => Number(line.trim().split(/\s+/)[0]))
    if (servers.length !== 1) {
      console.error(`herdr 서버 pid 를 하나로 못 정했다 (${herdrPath} … server: ${servers.length}개) — --herdr-pid 로 준다`)
      process.exit(2)
    }
    herdrPid = servers[0]
  }
  const targets = await (await fetch(`http://127.0.0.1:${args.port}/json`)).json()
  const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'))
  if (!page) {
    console.error('renderer page 없음')
    process.exit(2)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') consoleErrors.push({ kind: 'console.error', text: data.params.args.map((a) => a.value ?? a.description ?? '').join(' ') })
    if (data.method === 'Runtime.exceptionThrown') consoleErrors.push({ kind: 'exception', text: data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text })
    if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') consoleErrors.push({ kind: `log.${data.params.entry.source}`, text: data.params.entry.text })
    if (data.id === undefined) return
    const p = pending.get(data.id)
    pending.delete(data.id)
    if (data.error) p.reject(new Error(JSON.stringify(data.error)))
    else p.resolve(data.result)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  await send('Runtime.enable')
  await send('Log.enable')
  consoleErrors = [] // enable 이 되감아 보내는 과거 기록은 빼고 이 실행 동안 새로 난 것만
  // 패널이 닫혀 있으면 세그먼트를 DOM 클릭으로 연다(키 입력 아님 — 다른 pane 으로 새지 않는다).
  const opened = await evaluate(`(() => { if (document.querySelector('[data-statusbar-resource-panel]')) return 'already-open'; const seg = document.querySelector('[data-statusbar-resource]'); if (!seg) return 'no-segment'; seg.click(); return 'clicked' })()`)
  source = {
    herdrPid,
    opened,
    capture: async () => {
      // 다음 푸시 → 두 프레임 뒤(그 스냅샷이 DOM 에 반영된 프레임) 행 title 전부.
      const { snapshot, dom } = await evaluate(`new Promise((resolve) => { const stop = window.corral.onResourceSnapshot((s) => { stop(); requestAnimationFrame(() => requestAnimationFrame(() => { const dom = [...document.querySelectorAll('[data-statusbar-resource-row]')].map((el) => ({ paneId: el.getAttribute('data-statusbar-resource-row'), title: el.getAttribute('title') })); resolve({ snapshot: s, dom }) })) }) })`)
      const psText = execFileSync('ps', ['-axo', 'pid=,ppid=,tpgid=,ucomm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024 })
      return { at: new Date().toISOString(), snapshot, dom, psText }
    },
    finish: async () => {
      await new Promise((resolve) => setTimeout(resolve, consoleMs))
      ws.close()
    },
  }
}

// ── 캡처·재표본 ──────────────────────────────────────────────────────────────
const captures = []
let carried = new Set() // 직전 캡처에서 불일치한 paneId
const failed = new Map() // 두 캡처 연속 불일치 → 마지막 판정
const resolved = []
for (let index = 1; index <= maxCaptures; index += 1) {
  const raw = await source.capture()
  const rows = judge({ snapshot: raw.snapshot, dom: raw.dom, psText: raw.psText, herdrPid: source.herdrPid })
  const file = path.join(out, `capture-${index}.json`)
  fs.writeFileSync(file, JSON.stringify({ index, at: raw.at, herdrPid: source.herdrPid, snapshotAt: raw.snapshot.collectedAt ?? null, rows, raw: { snapshotPanes: raw.snapshot.panes, dom: raw.dom, ps: raw.psText } }, null, 1))
  const mismatched = new Set(rows.filter((row) => !row.ok).map((row) => row.paneId))
  for (const paneId of carried) {
    if (mismatched.has(paneId)) failed.set(paneId, rows.find((row) => row.paneId === paneId))
    else resolved.push({ paneId, capture: index, now: rows.find((row) => row.paneId === paneId)?.kind ?? 'paneGone' })
  }
  captures.push({ index, at: raw.at, file, rows: rows.length, measured: rows.filter((row) => row.state === 'measured').length, mismatches: rows.filter((row) => !row.ok).map((row) => ({ paneId: row.paneId, kind: row.kind })) })
  // 이미 실패로 확정된 행은 더 재표본하지 않는다.
  carried = new Set([...mismatched].filter((paneId) => !failed.has(paneId)))
  if (carried.size === 0) break
}
await source.finish()

const first = captures[0]
const firstRows = JSON.parse(fs.readFileSync(first.file, 'utf8')).rows
const summary = {
  mode: args.fixture ? `fixture ${path.basename(args.fixture)}` : `cdp :${args.port}`,
  herdrPid: source.herdrPid,
  panelOpen: source.opened ?? null,
  rows: first.rows,
  measuredRows: first.measured,
  firstCaptureMismatches: first.mismatches.length,
  mismatchKinds: Object.fromEntries([...new Set(captures.flatMap((c) => c.mismatches.map((m) => m.kind)))].map((kind) => [kind, captures.flatMap((c) => c.mismatches).filter((m) => m.kind === kind).length])),
  truncatedNameRows: firstRows.filter((row) => row.truncated === true).length,
  captures: captures.length,
  resampleCaptures: captures.length - 1,
  resolvedOnResample: resolved,
  failed: [...failed.values()].map((row) => ({ paneId: row.paneId, kind: row.kind, expected: row.expected ?? null, shown: row.shown ?? null, tooltipLine: row.tooltipLine })),
  unresolved: [...carried],
  consoleErrors: args.fixture ? null : consoleErrors,
}
const exitCode = failed.size > 0 ? 1 : carried.size > 0 ? 3 : consoleErrors.length > 0 ? 4 : 0
summary.exitCode = exitCode
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ ...summary, capturesDetail: captures }, null, 1))
console.log(JSON.stringify(summary))
process.exit(exitCode)
