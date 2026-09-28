// 이 실행이 **소유한** 프로세스를 정하는 순수 규칙 (G1·G5). I/O 없음 — 그래서 단위 테스트가 붙는다.
//
// 왜 순수 함수로 떼어냈나: 소유 판정이 틀리면 **남의 프로세스에 SIGTERM 을 보낸다.** 그 경로를
// 실제 프로세스 없이 반례로 확인할 수 있어야 한다. 리뷰가 낸 반례가 바로 그것이다 —
// `pgrep -f /tmp/l443/corral-userdata` 는 `/tmp/l443/corral-userdata-other` 를 쓰는 Electron 도 잡는다.
//
// 소유의 1순위는 **기동 때 받은 pid 와 그 자손(프로세스 그룹)** 이다. 경로 검사는 **보조**이고,
// 자손 추적이 놓치는 손자(crashpad 헬퍼 등)를 잇는 용도다. 그래서 경로 검사는 좁아야 한다.

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
 * 경로 기준 소유 판정. **소유 경로 아래를 실제로 쓰는 앱 프로세스만** 고른다.
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
