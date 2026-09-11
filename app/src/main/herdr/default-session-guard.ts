// 격리 가드 — corral 이 사용자의 `default` herdr 세션에 **쓰지 않는다**.
//
// LIFE-345 는 터미널 입력에만 이 가드가 필요했고 `PaneTerminal` 안에 있었다. LIFE-346 이
// 행 생성·종료라는 두 번째 쓰기 경로를 열면서 규칙이 두 군데로 갈라질 자리가 생겼다 —
// 그래서 한 함수로 모은다. 화이트리스트(`request.ts`)가 "어떤 메서드를 보내나" 를 막고
// 이쪽이 "어느 세션에 보내나" 를 막는다. 두 층은 서로를 대신하지 못한다.
//
// 푸는 열쇠는 계속 하나다: `CORRAL_ALLOW_DEFAULT_INPUT=1`.

export function defaultSessionWriteBlocked(isDefaultSession: boolean): string | null {
  if (!isDefaultSession) return null
  if (process.env.CORRAL_ALLOW_DEFAULT_INPUT === '1') return null
  return 'default 세션 쓰기 금지 (CORRAL_ALLOW_DEFAULT_INPUT=1 로만 푼다)'
}
