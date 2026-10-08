// 한글 IME 조합 표시층 (LIFE-566) — xterm 6.0.0 의 조합 상자(`.composition-view`)를 **실제로 그려진 커서 칸**에 맞추고,
// 조합 글자 **뒤**에 caret 을 그리고, 상자를 테마 색으로 칠한다. xterm 은 무수정이다 — 공개 API(`term.element`·`term.textarea`·
// `term.buffer`·`term.options`·`onRender`)와 DOM·CSS 만 쓴다.
//
// 왜 어긋났나 (C1 기준선 `raw/claude/c1-baseline/`): xterm 은 상자 left 를 `cursorX × 격자 칸(860/102 = 8.431px)` 으로 놓는데,
// DOM 렌더러가 실제로 그린 글자 칸은 8.281px 이다(행 letter-spacing·font-weight 500). 차가 열마다 쌓여 상자가 커서 칸보다 오른쪽에 서고,
// 그 틈으로 block 커서의 왼쪽 가장자리가 1px 막대로 드러났다(col 4: 0.47px · col 55: 한 칸). 그래서 xterm 의 left 를 덮어쓰지 않고
// **그려진 커서 span 의 위치와의 차이만큼 margin-left 로 옮긴다** — xterm 이 left 를 다시 써도 차이를 다시 재면 된다.
//
// 값은 CSS 변수로 `.xterm` 루트에 쓰고 모양은 `styles.css` 가 정한다. 조합 상자 자체의 style 속성은 건드리지 않는다
// (상자를 지켜보는 MutationObserver 가 제 쓰기에 다시 깨어나지 않게).
import type { ITheme } from '@xterm/xterm'

export const IME_COMPOSING_CLASS = 'corral-ime-composing'

/**
 * 조합 글자가 차지할 칸 수. 한글 음절·호환 자모·CJK 는 2칸, 나머지는 1칸.
 * xterm 의 폭 표는 공개 API 가 없다 — 조합 중에 오는 글자(한글·가나·한자)에 필요한 범위만 둔다.
 */
export function compositionCells(text: string): number {
  let cells = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    cells += isWide(code) ? 2 : 1
  }
  return cells
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // 한글 자모(초성)
    (code >= 0x2e80 && code <= 0x303e) || // CJK 부수·기호
    (code >= 0x3041 && code <= 0x33ff) || // 가나·호환 자모·CJK 호환
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) || // 한글 자모 확장-A
    (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/**
 * 상자를 어디로 옮기고 얼마나 넓힐지. 모두 `.xterm-screen` 기준 CSS px.
 *
 * - 상자 왼쪽 = 그려진 커서 칸 왼쪽(`anchorLeft`). 커서 span 이 없으면(앱이 커서를 숨김) xterm 자리 그대로.
 * - 상자 폭 = 칸 수 × 그려진 칸 폭 → caret(상자 바로 뒤)이 **확정 뒤 커서가 설 칸의 왼쪽**과 맞는다(C2ⓑ).
 * - 상자+caret 이 화면 오른쪽을 넘으면 그만큼 왼쪽으로 당긴다(C4ⓓ).
 * - caret 자리(상자 오른쪽 끝)는 device px 에 맞춘다 — 소수 px 에 걸린 1px caret 은 두 픽셀에 번져 흐리게 보인다(r0 실측). 차이는 0.5 device px 이하.
 */
export function compositionLayout(input: {
  xtermLeft: number
  anchorLeft: number | null
  cellWidth: number
  cells: number
  caretWidth: number
  screenWidth: number
  devicePixelRatio: number
}): { dx: number; width: number } {
  const span = input.cells * input.cellWidth
  const wanted = input.anchorLeft ?? input.xtermLeft
  const left = Math.max(0, Math.min(wanted, input.screenWidth - span - input.caretWidth))
  const dpr = input.devicePixelRatio > 0 ? input.devicePixelRatio : 1
  const caretX = Math.round((left + span) * dpr) / dpr
  return { dx: left - input.xtermLeft, width: Math.max(0, caretX - left) }
}

type Rgb = { r: number; g: number; b: number }

function parseColor(value: string): Rgb | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value.trim())?.[1]
  if (hex !== undefined) {
    // #rgb·#rgba 는 자리마다 두 번 써서 #rrggbb(aa) 로 편다. 알파는 버린다(상자는 불투명).
    const body = hex.length <= 4 ? hex.replace(/./g, (digit) => digit + digit) : hex
    if (body.length !== 6 && body.length !== 8) return null
    return { r: parseInt(body.slice(0, 2), 16), g: parseInt(body.slice(2, 4), 16), b: parseInt(body.slice(4, 6), 16) }
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value.trim())
  if (rgb !== null) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
  return null
}

function toHex({ r, g, b }: Rgb): string {
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')
}

function luminance({ r, g, b }: Rgb): number {
  const lin = (n: number): number => {
    const c = n / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** caret 이 배경 위에서 보여야 하는 최소 대비 — Orca 패치 `_styleCompositionCaret` 과 같은 값. */
export const CARET_MIN_CONTRAST = 3

/**
 * 조합 상자·caret 색. 상자 = 테마 배경(알파 제거)·전경, caret = 테마 커서 색.
 * caret 대비가 3 미만이면 전경 → 흑/백 중 대비가 3 이상인 첫 색으로 바꾼다(Orca 는 명도를 밀어 맞춘다 — 여기서는 후보 중에서 고른다).
 */
export function compositionColors(theme: ITheme | undefined): { background: string; foreground: string; caret: string } {
  const background = parseColor(theme?.background ?? '') ?? { r: 0, g: 0, b: 0 }
  const foreground = parseColor(theme?.foreground ?? '') ?? { r: 255, g: 255, b: 255 }
  const cursor = parseColor(theme?.cursor ?? '') ?? foreground
  const candidates = [cursor, foreground, { r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }]
  const caret =
    candidates.find((color) => contrastRatio(color, background) >= CARET_MIN_CONTRAST) ??
    candidates.reduce((best, color) => (contrastRatio(color, background) > contrastRatio(best, background) ? color : best))
  return { background: toHex(background), foreground: toHex(foreground), caret: toHex(caret) }
}

/** 이 모듈이 xterm 에서 읽는 공개 API 만 — 실제 `Terminal` 이 그대로 들어맞고, 테스트는 이 모양의 가짜를 넘긴다. */
export type ImeTerminal = {
  element: HTMLElement | undefined
  cols: number
  options: { cursorWidth?: number; theme?: ITheme }
  buffer: { active: { baseY: number; cursorX: number; cursorY: number; getLine(y: number): { getCell(x: number): { getWidth(): number } | undefined } | undefined } }
  onRender(listener: () => void): { dispose(): void }
}

/**
 * xterm 에 조합 표시층을 붙인다. `term.open()` 뒤에 부른다. 돌려준 함수로 뗀다.
 * 조합 중인지는 xterm 이 상자에 붙이는 `active` 클래스로 본다 — 조합 시작·갱신·확정·취소 모두 그 하나로 따라간다.
 */
export function attachImeComposition({ term }: { term: ImeTerminal }): () => void {
  const root = term.element
  const view = root?.querySelector<HTMLElement>('.composition-view') ?? null
  const screen = root?.querySelector<HTMLElement>('.xterm-screen') ?? null
  if (root === undefined || view === null || screen === null) return () => {}

  const vars = ['--corral-ime-dx', '--corral-ime-w', '--corral-ime-bg', '--corral-ime-fg', '--corral-ime-caret', '--corral-ime-caret-w']
  const clear = (): void => {
    root.classList.remove(IME_COMPOSING_CLASS)
    for (const name of vars) root.style.removeProperty(name)
  }

  const sync = (): void => {
    if (!view.classList.contains('active')) {
      clear()
      return
    }
    const screenRect = screen.getBoundingClientRect()
    const cursor = root.querySelector<HTMLElement>('.xterm-rows .xterm-cursor')
    const buffer = term.buffer.active
    let anchorLeft: number | null = null
    let cellWidth = term.cols > 0 ? screenRect.width / term.cols : 0
    if (cursor !== null) {
      const rect = cursor.getBoundingClientRect()
      const under = buffer.getLine(buffer.baseY + buffer.cursorY)?.getCell(buffer.cursorX)?.getWidth() ?? 1
      anchorLeft = rect.left - screenRect.left
      if (rect.width > 0) cellWidth = rect.width / Math.max(1, under)
    }
    const caretWidth = Math.max(1, term.options.cursorWidth ?? 1)
    const { dx, width } = compositionLayout({
      xtermLeft: Number.parseFloat(view.style.left) || 0,
      anchorLeft,
      cellWidth,
      cells: compositionCells(view.textContent ?? ''),
      caretWidth,
      screenWidth: screenRect.width,
      devicePixelRatio: window.devicePixelRatio,
    })
    const colors = compositionColors(term.options.theme)
    root.style.setProperty('--corral-ime-dx', `${dx}px`)
    root.style.setProperty('--corral-ime-w', `${width}px`)
    root.style.setProperty('--corral-ime-bg', colors.background)
    root.style.setProperty('--corral-ime-fg', colors.foreground)
    root.style.setProperty('--corral-ime-caret', colors.caret)
    root.style.setProperty('--corral-ime-caret-w', `${caretWidth}px`)
    root.classList.add(IME_COMPOSING_CLASS)
  }

  // xterm 은 조합 갱신 때 상자의 글자·left 를 바꾸고(동기 + setTimeout 0 한 번 더), 끝날 때 `active` 를 뗀다 — 그 변화마다 다시 잰다.
  const observer = new MutationObserver(sync)
  observer.observe(view, { attributes: true, attributeFilter: ['class', 'style'], childList: true, characterData: true, subtree: true })
  // 조합 중 화면이 다시 그려지면(커서 이동·프레임) 그려진 커서 칸도 다시 잰다.
  const render = term.onRender(() => {
    if (view.classList.contains('active')) sync()
  })
  return () => {
    observer.disconnect()
    render.dispose()
    clear()
  }
}
