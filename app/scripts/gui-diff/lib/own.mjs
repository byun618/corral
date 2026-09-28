// 이 실행이 **소유한** 프로세스를 정하는 순수 규칙 (G1·G5). I/O 없음 — 그래서 단위 테스트가 붙는다.
//
// 왜 순수 함수로 떼어냈나: 소유 판정이 틀리면 **남의 프로세스에 SIGTERM 을 보낸다.** 그 경로를
// 실제 프로세스 없이 반례로 확인할 수 있어야 한다. 리뷰가 낸 반례가 바로 그것이다 —
// `pgrep -f /tmp/l443/corral-userdata` 는 `/tmp/l443/corral-userdata-other` 를 쓰는 Electron 도 잡는다.
//
// 소유 = **기동 때 받은 pid 와 그 자손(PPID 사슬)**, 그게 전부다. 경로 일치는 **신호 근거가 아니다** —
// 평탄한 명령줄에서 argv 경계를 복원할 수 없어(공백 든 경로) 남의 프로필을 소유로 만들 수 있다(R3-01).
// 그래서 `selectOwnedByPath` 는 이제 **진단 전용**이고, 신호는 `planSignals` 만 정한다 (H1).

/** macOS 는 같은 폴더를 `/tmp/...` 와 `/private/tmp/...` 두 이름으로 준다. 비교 전에 하나로 모은다. */
export function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  let out = value.replace(/^\/private(\/(tmp|var)\/)/, '$1')
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/** `a` 가 `b` 자신이거나 그 **아래**인가. 접두사 일치가 아니다 — 경계(`/`)까지 본다. */
export function isPathInside(a, b) {
  const x = normalizePath(a)
  const y = normalizePath(b)
  if (!x || !y) return false
  return x === y || x.startsWith(`${y}/`)
}

/**
 * 명령줄에서 **경로로 쓰인 토큰**을 뽑는다. `--opt=값` · `--opt 값` · 맨 토큰을 모두 본다.
 *
 * 왜 옵션 값을 따로 보나: Electron 의 프로필은 `--user-data-dir=<경로>` 로 들어오고, crashpad 는
 * `--database=<경로>/Crashpad` 로 들어온다. 문자열 포함 검사는 `<경로>-other` 도 참으로 만든다.
 */
export function commandPathTokens(command) {
  if (typeof command !== 'string') return []
  const tokens = command.split(/\s+/).filter(Boolean)
  const out = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    const eq = token.indexOf('=')
    if (token.startsWith('-') && eq > 0) {
      out.push(token.slice(eq + 1))
      continue
    }
    if (token.startsWith('-')) {
      const next = tokens[i + 1]
      if (next && !next.startsWith('-') && next.includes('/')) out.push(next)
      continue
    }
    if (token.includes('/')) out.push(token)
  }
  return out.filter(Boolean)
}

/** 명령줄이 **앱**(Electron·Orca·herdr)인가. 셸·pgrep·tail 은 우리가 남긴 것이 아니다. */
export function looksLikeApp(command) {
  if (typeof command !== 'string') return false
  if (/^\/bin\/(z|ba)?sh\b|^-?sh\b|\bpgrep\b|\btail\b|\bgrep\b|\bnode .*judge-criteria/.test(command)) return false
  return /Electron|electron|Orca|herdr|corral/.test(command)
}

/**
 * 경로 기준 **후보 추림 — 진단 전용**이다 (H1). 이 결과로 신호하지 않는다.
 *
 * 왜 남겨 두나: 「우리 경로를 쓰는 프로세스가 아직 살아 있다」는 사실은 정리 실패의 증거다.
 * 죽일 근거로는 못 쓰지만(argv 경계를 복원할 수 없다), **보고할 근거로는 쓴다** — `classifyPathSurvivors`.
 *
 * @param processes `[{pid, command}]` — 후보(넓게 훑은 결과여도 된다)
 * @param targets   이번 실행이 만든 절대경로들
 * @param exclude   소유가 아닌 pid (이번 실행 전부터 있던 것 — `--no-fresh` 재사용분)
 * @returns `{owned:[{pid,command,path}], rejected:[{pid,command,why}]}` — 거른 이유까지 남긴다
 */
export function selectOwnedByPath({ processes = [], targets = [], exclude = [], selfPid = null } = {}) {
  const wanted = targets.map(normalizePath).filter(Boolean)
  const skip = new Set(exclude.filter((pid) => Number.isFinite(pid)))
  const owned = []
  const rejected = []
  for (const entry of processes) {
    const pid = Number(entry?.pid)
    const command = entry?.command ?? ''
    if (!Number.isFinite(pid) || pid === selfPid) continue
    if (skip.has(pid)) {
      rejected.push({ pid, command, why: '이번 실행 전부터 있던 프로세스 — 소유 아님' })
      continue
    }
    if (!looksLikeApp(command)) {
      rejected.push({ pid, command, why: '앱 프로세스가 아니다 (셸·검색 명령 등)' })
      continue
    }
    const tokens = commandPathTokens(command)
    const hit = wanted.find((target) => tokens.some((token) => isPathInside(token, target)))
    if (!hit) {
      rejected.push({ pid, command, why: '소유 경로를 경계까지 일치하는 인자가 없다 (부분 문자열 일치는 소유가 아니다)' })
      continue
    }
    owned.push({ pid, command, path: hit })
  }
  return { owned, rejected }
}

/**
 * **신호 대상 계획** (H1). 이번 실행이 spawn 한 pid 와 그 **자손(PPID 사슬)** 뿐이다.
 *
 * 왜 경로를 빼는가: 평탄한 명령줄 문자열은 argv 경계의 증거가 아니다 — 공백이 든 경로
 * (`--user-data-dir=/tmp/l443/corral-userdata backup`)는 토큰이 갈려 **남의 프로필**을 소유로
 * 만들고, 반대로 이번 실행의 Electron 을 놓친 채 `clean:true` 를 쓴다(리뷰 R3-01).
 * 그래서 경로 일치는 **신호 근거에서 내린다.** 경로는 `classifyPathSurvivors` 의 진단으로만 쓴다.
 *
 * @param owned `[{pid, label, group}]` — 기동 때 받은 pid (dev 러너처럼 detached 면 `group:true`)
 * @param descendantsOf `(pid) => number[]` — PPID 사슬 조회. **신호 전에** 부른다(부모를 끝내면 사슬이 끊긴다)
 * @returns 신호할 항목 배열. 이 배열 **밖으로는 신호하지 않는다**
 */
export function planSignals({ owned = [], descendantsOf = () => [] } = {}) {
  const out = []
  const seen = new Set()
  for (const entry of owned) {
    const pid = Number(entry?.pid)
    if (!Number.isFinite(pid) || seen.has(pid)) continue
    seen.add(pid)
    const label = entry?.label ?? 'spawn'
    const descendants = (descendantsOf(pid) ?? []).map(Number).filter((value) => Number.isFinite(value))
    out.push({ pid, label, group: Boolean(entry?.group), descendants, via: 'spawn' })
    for (const kid of descendants) {
      if (seen.has(kid)) continue
      seen.add(kid)
      out.push({ pid: kid, label: `${label} 의 자손`, group: false, viaParent: pid, via: 'descendant' })
    }
  }
  return out
}

/** 정규식 메타문자를 막는다 — 경로에 `+`·`(` 가 들어가도 그대로 찾는다. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 명령줄이 그 경로를 **경계까지** 언급하는가. 공백으로 쪼개지 않는다 (H1 보고 경로).
 *
 * 왜 토큰 분할을 버렸나: 평탄한 명령줄에서 argv 경계는 복원할 수 없다. 공백으로 쪼개면
 * `--user-data-dir=/virtual/my work/corral-userdata` 의 우리 프로필이 `/virtual/my` 로 잘려
 * **우리가 띄운 고아를 못 보고 `clean:true`** 를 쓴다(리뷰 R3-01 의 반대 방향). 그래서 보고 쪽은
 * 경로를 **문자열로** 찾되 앞뒤 경계를 본다 — 뒤가 `-` 면(`…-other`) 다른 경로다.
 */
export function commandMentionsPath(command, target) {
  const wanted = normalizePath(target)
  if (!wanted || typeof command !== 'string') return false
  const flat = command.replace(/\/private(\/(tmp|var)\/)/g, '$1')
  return new RegExp(`(^|[\\s='"])${escapeRegExp(wanted)}($|[\\s/'"])`).test(flat)
}

/**
 * 소유 경로를 쓰는 **생존** 프로세스 — **죽이지 않는다** (H1, fail closed).
 *
 * 신호 목록 밖인데 우리 경로가 명령줄에 보이면, 그것은 「우리가 놓쳤을 수도 있다」는 **신호가 아니라
 * 보고 사유**다. 경로가 맞다고 죽이면 R3-01 의 반례(공백 경로·남의 프로필)가 그대로 살아난다.
 * 그래서 목록으로만 남기고 회차를 미정리(`clean:false` → C12 실패)로 둔다.
 *
 * @param signalled 이미 신호한 pid 들 (`planSignals` 결과)
 * @param alive `(pid) => boolean` — 살아 있는지
 */
export function classifyPathSurvivors({
  processes = [],
  targets = [],
  exclude = [],
  signalled = [],
  selfPid = null,
  alive = () => true
} = {}) {
  const sent = new Set(signalled.map(Number).filter((value) => Number.isFinite(value)))
  const skip = new Set(exclude.filter((pid) => Number.isFinite(pid)))
  const survivors = []
  const rejected = []
  for (const entry of processes) {
    const pid = Number(entry?.pid)
    const command = entry?.command ?? ''
    if (!Number.isFinite(pid) || pid === selfPid) continue
    if (sent.has(pid)) continue
    if (skip.has(pid)) {
      rejected.push({ pid, command, why: '이번 실행 전부터 있던 프로세스 — 소유 아님' })
      continue
    }
    const hit = targets.find((target) => commandMentionsPath(command, target))
    if (!hit) {
      rejected.push({ pid, command, why: '소유 경로를 경계까지 가진 인자가 없다 (부분 문자열 일치는 소유가 아니다)' })
      continue
    }
    if (!alive(pid)) continue
    survivors.push({
      pid,
      command,
      path: normalizePath(hit),
      signalled: false,
      // **앱처럼 보이는가는 묻지 않는다.** 죽이는 판단이 아니라 보고이므로, 애매하면 보고하는 쪽
      // (fail closed)이 맞다 — `looksLikeApp()` 은 명령줄 전체를 봐서 `python3 …/inspect.py` 도
      // 앱으로 잡았고(리뷰 R3-01), 반대로 우리가 띄운 셸 래퍼를 앱이 아니라고 뺄 수도 있었다.
      why: '이번 실행이 spawn 한 pid 도 그 자손도 아닌데 소유 경로를 쓴다 — 신호하지 않고 미정리로 보고한다 (H1)'
    })
  }
  return { survivors, rejected }
}
