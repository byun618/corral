// LIFE-565 — 렌더러의 `window.open(url)` 을 외부 브라우저로 넘겨도 되는가. **허용 스킴의 유일한 술어**다 —
// 터미널 링크(평문·OSC 8)는 스킴을 거르지 않고 여기로 보낸다(렌더러에 두 번째 허용 목록 없음, D2: http + https).
export function isExternalOpenAllowed(url: string): boolean {
  return /^https?:\/\//.test(url)
}

/**
 * 로그에 남길 모양 — 허용·거절 공통(R1-07·R2-02). 쿼리·조각·userinfo(토큰·비밀번호가 들 수 있다)를 뺀다.
 * 호스트가 있으면 `scheme://host[:port]/path`, `file:` 은 경로, 그 밖(`javascript:`·`data:` 등)은 스킴만. 200자 상한.
 * `about:blank` 는 그대로 — `javascript:` 링크가 핸들러에 그 모양으로 도착한다(reviews r1 R1-02 재현).
 */
export function externalOpenLogUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (url === 'about:blank') return url
    if (parsed.host !== '') return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 200)
    if (parsed.protocol === 'file:') return `file://${parsed.pathname}`.slice(0, 200)
    return parsed.protocol
  } catch {
    return '(unparsable)'
  }
}
