// 어느 herdr 세션에 붙을지 고른다 (수정 1회차 M6 — codex 2).
//
// **순수 함수다.** 소켓도 파일시스템도 안 만진다 — 고르는 규칙이 곧 채점 대상이라
// 멈춘 세션을 실제로 만들지 않고도 재생으로 증명할 수 있어야 한다.
//
// 1회차 규칙은 `CORRAL_SESSION` → default → 첫 세션이었고 `running` 을 안 봤다.
// `herdr session list --json` 은 **멈춘 세션도 그대로 싣는다**(LIFE-344 실측 34-session-running).
// 그래서 default 가 멈춰 있으면 앱이 죽은 소켓에 붙으려다 재시도 상태에 머물렀고,
// R1 에는 세션 선택 UI 가 없어 사용자가 화면에서 빠져나갈 길이 없었다.

export type SessionChoice = {
  /** 고른 세션 이름. 못 골랐으면 null. */
  name: string | null
  /** 왜 그것인가 / 왜 못 골랐나. 평시(그냥 돌아가는 세션 하나를 골랐을 때)는 null. */
  note: string | null
}

type Candidate = { name: string; isDefault: boolean; running: boolean }

export function pickSessionName(input: {
  sessions: readonly Candidate[]
  /** `CORRAL_SESSION` — 사용자가 명시한 세션. */
  wanted: string | undefined
}): SessionChoice {
  const { sessions, wanted } = input

  // ① 명시한 세션이 있으면 그것만 본다. 죽어 있어도 **다른 것으로 몰래 갈아타지 않는다** —
  //    사용자가 이름을 댄 이상 "그게 안 된다" 가 답이지 "대신 이걸 열었다" 가 아니다.
  if (wanted !== undefined && wanted.length > 0) {
    const named = sessions.find((session) => session.name === wanted)
    if (named === undefined) {
      return { name: null, note: `CORRAL_SESSION=${wanted} — 그런 세션이 없다` }
    }
    if (!named.running) {
      return { name: null, note: `CORRAL_SESSION=${wanted} — 세션이 멈춰 있다 (herdr session attach ${wanted})` }
    }
    return { name: named.name, note: null }
  }

  const running = sessions.filter((session) => session.running)
  if (running.length === 0) {
    const stopped = sessions.length
    return {
      name: null,
      note: stopped === 0 ? '열린 herdr 세션이 없다' : `herdr 세션 ${stopped}개가 전부 멈춰 있다`,
    }
  }

  // ② 돌아가는 것 중에서 default 우선, 없으면 첫 번째.
  const target = running.find((session) => session.isDefault) ?? running[0]
  if (target === undefined) return { name: null, note: '열린 herdr 세션이 없다' }
  const defaultStopped = sessions.some((session) => session.isDefault && !session.running)
  return {
    name: target.name,
    note: defaultStopped ? `default 가 멈춰 있어 ${target.name} 에 붙었다` : null,
  }
}
