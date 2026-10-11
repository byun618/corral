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
//
// resize·clear 는 동기지만 프레임 write 는 다음 틱에 파싱된다 — 그 사이 렌더가 끼면 reflow 로 뒤섞인 화면이나 clear 가 남긴 한 줄짜리 화면이
// 그려진다(리뷰 r1 R1-01: 격리 fixture 80회 중 77회). 그래서 크기가 바뀌는 프레임은 **동기 출력 모드(DECSET 2026)를 먼저 켜고(파싱 완료까지 기다린 뒤)**
// resize·복구를 하고, 프레임 끝에서 모드를 끈다. xterm 6.0.0 RenderService 는 이 모드 동안 refreshRows·_renderRows 를 모두 보류했다가
// 끌 때 한 번에 그린다(모드가 1초 넘게 켜져 있으면 xterm 이 스스로 끈다). 서버 프레임(frame-to-ansi)은 이 모드를 쓰지 않는다.

/** 쓰는 xterm 공개 API 만 — `Terminal` 이 그대로 들어맞는다. */
export interface ResizableTerminal {
  readonly cols: number
  readonly rows: number
  resize(cols: number, rows: number): void
  clear(): void
  readonly buffer: { readonly active: { readonly baseY: number; readonly viewportY: number } }
}

export interface FrameTerminal extends ResizableTerminal {
  write(data: string, callback?: () => void): void
}

export const SYNC_OUTPUT_BEGIN = '\x1b[?2026h'
export const SYNC_OUTPUT_END = '\x1b[?2026l'

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

/**
 * 프레임 하나를 쓴다. 크기가 같으면 그대로 쓰고, 다르면 동기 출력 모드 안에서 resize·복구한 뒤 쓴다 —
 * resize·clear 와 프레임 파싱 사이의 중간 화면이 렌더되지 않는다. `alive` 가 false 면(사이에 pane 이 내려감) 멈춘다.
 */
export function writeFrame(
  term: FrameTerminal,
  input: { cols: number; rows: number; data: string; alive: () => boolean; done: () => void },
): void {
  if (term.cols === input.cols && term.rows === input.rows) {
    term.write(input.data, input.done)
    return
  }
  term.write(SYNC_OUTPUT_BEGIN, () => {
    if (!input.alive()) return
    resizeToFrame(term, input)
    term.write(input.data + SYNC_OUTPUT_END, input.done)
  })
}
