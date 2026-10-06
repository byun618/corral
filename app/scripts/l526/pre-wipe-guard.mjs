// LIFE-526 fix2 R2-01 — 격리 폴더를 지우기 **전에** 그 폴더·herdr 세션·포트를 쓰는 프로세스가 있는지 본다(킥오프 격리 4 · 504 가드).
// 점유가 있거나 확인을 못 하면(ps·lsof 실패) 호출자는 **아무것도 지우지 않고** nonzero 로 멈춘다. 판정은 순수 함수(judgePreWipe)라
// 가짜 프로세스·포트 목록으로 음성 대조를 돌릴 수 있다(pre-wipe-guard-control.mjs).
// 경로는 /tmp 와 /private/tmp 두 꼴을 다 본다(폴더가 아직 없으면 realpath 를 못 쓰니 문자열로 짝을 만든다).
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

/**
 * 판정(순수). ps: { ok, lines, error } · ports: [{ port, ok, listeners, error }] · dirs: 지울 폴더 · session: herdr 세션 이름(없으면 null) · self: 뺄 pid.
 * 돌려주는 값: { pass, reasons, hits } — pass=false 면 지우지 않는다.
 */
export function judgePreWipe({ ps, ports, dirs, session, self }) {
  const reasons = []
  const hits = []
  if (ps.ok !== true) reasons.push(`프로세스 목록을 못 읽었다: ${ps.error}`)
  const forms = dirs.flatMap(pathForms)
  for (const line of ps.ok === true ? ps.lines : []) {
    const pid = Number(line.trim().split(/\s+/)[0])
    if (self.includes(pid)) continue
    const dir = forms.find((form) => mentions({ line, dir: form }))
    const bySession = session !== null && line.includes(`--session ${session}`)
    if (dir || bySession) hits.push({ pid, why: dir ? `경로 ${dir}` : `herdr 세션 ${session}`, line: line.slice(0, 200) })
  }
  if (hits.length > 0) reasons.push(`같은 경로·세션을 쓰는 프로세스 ${hits.length}개`)
  for (const port of ports) {
    if (port.ok !== true) reasons.push(`포트 ${port.port} 확인 실패: ${port.error}`)
    else if (port.listeners.length > 0) reasons.push(`포트 ${port.port} 사용 중: ${port.listeners.join(' | ')}`)
  }
  return { pass: reasons.length === 0, reasons, hits }
}

/** 실제 수집 — ps 전체 목록 · lsof LISTEN(exit 1 + 빈 출력 = 비어 있음, 그 밖의 실패 = 확인 실패). */
export function probePreWipe({ dirs, ports = [], session = null }) {
  const listed = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  const ps = listed.status === 0 ? { ok: true, lines: listed.stdout.split('\n').filter(Boolean), error: null } : { ok: false, lines: [], error: (listed.stderr || String(listed.error ?? listed.status)).trim() }
  const portRows = ports.map((port) => {
    const run = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    if (run.status === 0) return { port, ok: true, listeners: run.stdout.trim().split('\n').slice(1), error: null }
    if (run.status === 1 && run.stdout.trim() === '' && run.stderr.trim() === '') return { port, ok: true, listeners: [], error: null }
    return { port, ok: false, listeners: [], error: `lsof status=${run.status} ${run.error ?? ''} ${run.stderr}`.trim() }
  })
  // 조상 사슬 전체를 뺀다 — 이 스크립트를 띄운 셸(조부모 이상 포함)의 명령줄에 경로 문자열이 들어 있을 뿐 그 폴더를 쓰는 인스턴스가 아니다
  // (fix2 대조 run2 실측: 조부모 zsh -c 의 명령 글자가 /tmp/l526i-dry 를 담아 걸렸다). l516 iso-k8 의 ancestors 와 같은 방식.
  const self = [process.pid]
  let pid = process.ppid
  for (let i = 0; i < 20 && pid > 1; i += 1) {
    self.push(pid)
    pid = Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()) || 1
  }
  return { at: new Date().toISOString(), dirs, forms: dirs.flatMap(pathForms), ports, session, self, ps: { ok: ps.ok, error: ps.error, count: ps.lines.length }, portRows, ...judgePreWipe({ ps, ports: portRows, dirs, session, self }) }
}
