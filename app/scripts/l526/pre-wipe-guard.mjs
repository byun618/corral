// LIFE-526 fix2 R2-01 — 격리 폴더를 지우기 **전에** 그 폴더·herdr 세션·포트를 쓰는 프로세스가 있는지 본다(킥오프 격리 4 · 504 가드).
// 점유가 있거나 확인을 못 하면(ps·lsof 실패) 호출자는 **아무것도 지우지 않고** nonzero 로 멈춘다. 판정은 순수 함수(judgePreWipe)라
// 가짜 프로세스·포트 목록으로 음성 대조를 돌릴 수 있다(pre-wipe-guard-control.mjs).
// 경로는 /tmp 와 /private/tmp 두 꼴을 다 본다(폴더가 아직 없으면 realpath 를 못 쓰니 문자열로 짝을 만든다).
//
// fix4 R4-01 — **조상 예외를 없앴다(실패 쪽으로 닫기).** R2-01(가드 없음) → fix2 가 조상 전체를 뺐다 → R3-01(조상 herdr·Electron 을 놓침) →
// fix3 가 셸 실행 파일 조상만 뺐다 → R4-01(셸 이름으로 띄운 다른 실행 파일을 셸로 오인) — 세 지적이 모두 「조상 예외」 에서 나왔다.
// 이제 조상이든 아니든, 셸이든 아니든 지울 경로(두 꼴)·세션 문자열이 명령줄에 나오면 hit → pass=false. 자기 자신(selfPid)만 뺀다.
// 거짓 hit 는 「멈춤」 쪽이라 받아들인다. **운영 규칙**: 드라이런·iso-smoke 를 띄우는 셸 명령줄에 격리 경로·세션 문자열을 쓰지 않는다
// (경로는 스크립트 안에 고정돼 있다) — 쓰면 그 셸이 hit 가 되어 가드가 멈춘다. ancestorsOf 는 진단용으로만 남긴다(hits 의 ancestor 표시, 판정에 안 씀).
import { spawnSync } from 'node:child_process'

/** /tmp/x ↔ /private/tmp/x 두 꼴. */
export function pathForms(dir) {
  if (dir.startsWith('/private/tmp/')) return [dir, dir.slice('/private'.length)]
  if (dir.startsWith('/tmp/')) return [dir, `/private${dir}`]
  return [dir]
}

/** 명령줄에 경로가 **경계까지** 나오는가 — `/tmp/l526i-dry` 가 `/tmp/l526i-dry2` 에 걸리지 않게(뒤가 끝·공백·/·따옴표·= 일 때만). */
const mentions = ({ line, dir }) => {
  let from = 0
  for (;;) {
    const at = line.indexOf(dir, from)
    if (at < 0) return false
    const next = line[at + dir.length]
    if (next === undefined || /[\s/'"=]/.test(next)) return true
    from = at + 1
  }
}

/** `ps -axo pid=,ppid=,command=` 한 줄 → { pid, ppid, command }. */
const parseLine = (line) => {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
  return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null
}

/** ps 줄 목록에서 selfPid 의 조상 pid 집합(부모부터 1 직전까지). */
export function ancestorsOf({ rows, selfPid }) {
  const ppidOf = new Map(rows.map((row) => [row.pid, row.ppid]))
  const out = new Set()
  let pid = ppidOf.get(selfPid)
  for (let i = 0; i < 64 && pid !== undefined && pid > 1 && !out.has(pid); i += 1) {
    out.add(pid)
    pid = ppidOf.get(pid)
  }
  return out
}

/**
 * 판정(순수). ps: { ok, lines, error } — lines 는 `pid ppid command` · ports: [{ port, ok, listeners, error }] · dirs: 지울 폴더 ·
 * session: herdr 세션 이름(없으면 null) · selfPid: 이 프로세스(뺀다).
 * 조상 예외 없음(fix4) — 자기 자신만 뺀다. 돌려주는 값: { pass, reasons, hits } — pass=false 면 지우지 않는다. hits[].ancestor 는 진단 표시일 뿐이다.
 */
export function judgePreWipe({ ps, ports, dirs, session, selfPid }) {
  const reasons = []
  const hits = []
  if (ps.ok !== true) reasons.push(`프로세스 목록을 못 읽었다: ${ps.error}`)
  const rows = (ps.ok === true ? ps.lines : []).map(parseLine).filter(Boolean)
  const ancestors = ancestorsOf({ rows, selfPid })
  const forms = dirs.flatMap(pathForms)
  for (const row of rows) {
    if (row.pid === selfPid) continue
    const dir = forms.find((form) => mentions({ line: row.command, dir: form }))
    const bySession = session !== null && row.command.includes(`--session ${session}`)
    if (!dir && !bySession) continue
    const why = dir ? `경로 ${dir}` : `herdr 세션 ${session}`
    hits.push({ pid: row.pid, ancestor: ancestors.has(row.pid), why, line: row.command.slice(0, 200) })
  }
  if (hits.length > 0) reasons.push(`같은 경로·세션을 쓰는 프로세스 ${hits.length}개`)
  for (const port of ports) {
    if (port.ok !== true) reasons.push(`포트 ${port.port} 확인 실패: ${port.error}`)
    else if (port.listeners.length > 0) reasons.push(`포트 ${port.port} 사용 중: ${port.listeners.join(' | ')}`)
  }
  return { pass: reasons.length === 0, reasons, hits }
}

/** 실제 수집 — ps 전체 목록(pid·ppid·명령) · lsof LISTEN(exit 1 + 빈 출력 = 비어 있음, 그 밖의 실패 = 확인 실패). */
export function collectPreWipe({ ports }) {
  const listed = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  const ps = listed.status === 0 ? { ok: true, lines: listed.stdout.split('\n').filter(Boolean), error: null } : { ok: false, lines: [], error: (listed.stderr || String(listed.error ?? listed.status)).trim() }
  const portRows = ports.map((port) => {
    const run = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    if (run.status === 0) return { port, ok: true, listeners: run.stdout.trim().split('\n').slice(1), error: null }
    if (run.status === 1 && run.stdout.trim() === '' && run.stderr.trim() === '') return { port, ok: true, listeners: [], error: null }
    return { port, ok: false, listeners: [], error: `lsof status=${run.status} ${run.error ?? ''} ${run.stderr}`.trim() }
  })
  return { ps, portRows, selfPid: process.pid }
}

/** 수집 + 판정. collect 는 대조용으로 바꿔 끼울 수 있다(기본 = 실제 ps·lsof). */
export function probePreWipe({ dirs, ports = [], session = null, collect = collectPreWipe }) {
  const { ps, portRows, selfPid } = collect({ ports })
  return { at: new Date().toISOString(), dirs, forms: dirs.flatMap(pathForms), ports, session, selfPid, ps: { ok: ps.ok, error: ps.error, count: ps.lines.length }, portRows, ...judgePreWipe({ ps, ports: portRows, dirs, session, selfPid }) }
}
