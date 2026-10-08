// LIFE-565 — 렌더러의 `window.open(url)` 을 외부 브라우저로 넘겨도 되는가. **허용 스킴의 유일한 술어**다 —
// 터미널 링크(평문·OSC 8)는 스킴을 거르지 않고 여기로 보낸다(렌더러에 두 번째 허용 목록 없음, D2: http + https).
export function isExternalOpenAllowed(url: string): boolean {
  return /^https?:\/\//.test(url)
}

/** 허용 로그에 남길 모양 — 쿼리·조각(토큰·OAuth state 가 들 수 있다)을 뺀 `origin + pathname`, 200자 상한. */
export function externalOpenLogUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return (parsed.origin + parsed.pathname).slice(0, 200)
  } catch {
    return '(unparsable)'
  }
}
