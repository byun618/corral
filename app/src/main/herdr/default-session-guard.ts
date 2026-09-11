// 격리 가드 — corral 이 사용자의 `default` herdr 세션에 **쓰지 않는다**.
//
// LIFE-345 는 터미널 입력에만 이 가드가 필요했고 `PaneTerminal` 안에 있었다. LIFE-346 이
// 행 생성·종료라는 두 번째 쓰기 경로를 열면서 규칙이 두 군데로 갈라질 자리가 생겼다 —
// 그래서 한 파일로 모은다. 화이트리스트(`request.ts`)가 "어떤 메서드를 보내나" 를 막고
// 이쪽이 "어느 세션에 보내나" 를 막는다. 두 층은 서로를 대신하지 못한다.
//
// # 왜 함수가 둘인가 (1차 리뷰 M1 — codex·claude)
//
// 1회차는 함수가 하나였고 `CORRAL_ALLOW_DEFAULT_INPUT=1` 하나가 **입력과 생성·종료를 같이**
// 열었다. 이름은 `_INPUT` 인데 실제로는 `tab.create`·`agent.start`·`tab.close` 까지 열리는
// 상태였다 — 사용자의 진짜 세션에 가장 위험한 쓰기가 "입력 허용" 플래그에 딸려 갔다.
//
// 그래서 두 쓰기를 갈라 놓는다.
//   ① 입력(`pane.send_text`·`pane.send_keys`) — 되돌릴 수 있는 쓰기다. 플래그로 푼다
//   ② 생성·종료(`tab.create`·`agent.start`·`tab.close`) — **프로세스를 만들고 죽인다.**
//      되돌릴 수 없다. `default` 에서는 플래그와 무관하게 **항상** 막는다
// 열쇠를 하나 더 만들지 않는다: 열쇠가 있으면 언젠가 쓰인다. 측정은 격리 세션에서 한다.

const FLAG = 'CORRAL_ALLOW_DEFAULT_INPUT'

/** 입력 쓰기 — 플래그가 있으면 통과한다 (LIFE-345 와 같은 규칙). */
export function defaultSessionInputBlocked(isDefaultSession: boolean): string | null {
  if (!isDefaultSession) return null
  if (process.env[FLAG] === '1') return null
  return `default 세션 입력 금지 (${FLAG}=1 로만 푼다)`
}

/** 행의 생성·종료 — `default` 에서는 **푸는 방법이 없다.** */
export function defaultSessionLifecycleBlocked(isDefaultSession: boolean): string | null {
  if (!isDefaultSession) return null
  return 'default 세션에서는 행을 만들거나 종료하지 않는다 (푸는 플래그 없음)'
}
