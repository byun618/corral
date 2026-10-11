// LIFE-567 — 서버 격자로 xterm 을 resize 하되, 뷰포트를 버퍼 바닥에 붙여 둔다.
//
// xterm 6.0.0 normal 버퍼는 scrollback 0 이어도 reflow 가 켜져 있다(`Buffer._isReflowEnabled` 는 scrollback 값을 보지 않는다).
// 열을 줄이면 `_reflowSmaller` 가 새 폭보다 긴 줄마다 커서를 한 줄씩 아래로 밀고, 커서가 맨 아래에 닿은 뒤에도 긴 줄이 남으면
// `ybase++` 한다. scrollback 0 이라 버퍼에 자리가 없으니 **length = rows 인데 baseY 1** 이 되고, DOM 스크롤 영역에 끌려 viewportY 는 0 으로
// 내려온다. 그러면 ① 조합 상자(`buffer.y` 행)와 그려진 커서(`ybase + y − ydisp` 행)가 한 행 갈라지고 ② 프레임이 쓴 맨 아래 행이
// 버퍼 0번 줄로 감겨 들어가 화면 밖으로 밀린다(specs/LIFE-567-hangul-glyph/raw/claude/c1-base/notes.md).
//
// corral 의 xterm 은 순수 뷰포트라(프레임 = 전체 리페인트) 이 상태가 되면 버퍼를 비워 바닥 정합으로 되돌린다 — `clear()` 는 공개 API 이고
// 동기로 ybase·ydisp 를 0 으로 맞춘다. 지워진 내용은 바로 뒤 프레임이 다시 그린다.

/** 쓰는 xterm 공개 API 만 — `Terminal` 이 그대로 들어맞는다. */
export interface ResizableTerminal {
  readonly cols: number
  readonly rows: number
  resize(cols: number, rows: number): void
  clear(): void
  readonly buffer: { readonly active: { readonly baseY: number; readonly viewportY: number } }
}

/** scrollback 0 인 corral 뷰포트에서 정상 상태는 늘 baseY 0 = viewportY. */
export function viewportOffBottom(term: Pick<ResizableTerminal, 'buffer'>): boolean {
  const buffer = term.buffer.active
  return buffer.baseY !== 0 || buffer.viewportY !== buffer.baseY
}

/** 크기가 다를 때만 resize 하고, reflow 가 뷰포트를 바닥에서 떼어 놓았으면 버퍼를 비워 되돌린다. 되돌렸으면 true. */
export function resizeToFrame(term: ResizableTerminal, size: { cols: number; rows: number }): boolean {
  if (term.cols === size.cols && term.rows === size.rows) return false
  term.resize(size.cols, size.rows)
  if (!viewportOffBottom(term)) return false
  term.clear()
  return true
}
