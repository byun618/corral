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

/**
 * 설치본(동봉 herdr)은 동봉 서버의 default 세션 하나에 고정한다 (LIFE-556 fix2 M2). 레포 guard 로 풀린 바인딩 없는 개발 실행도
 * 같다 (LIFE-561 G2) — `herdr-dev` 에는 다른 작업의 이름 세션(`life417-native` 등)이 돌고 있을 수 있다. 그 세션에는 명시 바인딩으로만 붙는다.
 * 동봉 바인딩은 CLI 의 terminal·orchestration 도 GUI 가 붙은 세션을 쓰게 하므로, GUI 가 다른 세션으로
 * 옮겨 갈 수 있으면 진행 중인 dispatch 의 sender 검사·관측·계보가 다른 세션을 보게 된다. 그래서 세션 목록에서
 * default 만 남긴다 — 고르기(`pickSessionName`)·기동 결정(`decideBackend`)·동봉 공급자가 모두 이 목록만 본다.
 * 명시 바인딩(`CORRAL_SESSION`)이 있으면 그 세션 규칙을 그대로 따른다(이 함수는 손대지 않는다).
 */
export function pinnedSessions<T extends Candidate>(input: { sessions: readonly T[]; pinDefault: boolean; bound: string | null }): T[] {
  if (!input.pinDefault || input.bound !== null) return [...input.sessions]
  return input.sessions.filter((session) => session.isDefault)
}
