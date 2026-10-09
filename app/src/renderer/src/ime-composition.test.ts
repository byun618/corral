// @vitest-environment happy-dom
// LIFE-566 — 조합 표시층의 계산(칸 수·위치·색)과 붙이기 계약(조합 중에만 클래스·변수, 확정·취소에 걷힘, 테마 변경 즉시 반영).
// xterm 은 happy-dom 에서 그리지 못한다 — xterm 이 조합 때 하는 일(상자에 `active`·글자·left)을 DOM 에 직접 일으킨다.
import { afterEach, describe, expect, it } from 'vitest'
import type { ITheme } from '@xterm/xterm'
import {
  attachImeComposition,
  compositionCells,
  compositionColors,
  compositionLayout,
  contrastRatio,
  CARET_MIN_CONTRAST,
  IME_COMPOSING_CLASS,
  type ImeTerminal,
} from './ime-composition.js'

const rgb = (hex: string): { r: number; g: number; b: number } => ({
  r: parseInt(hex.slice(1, 3), 16),
  g: parseInt(hex.slice(3, 5), 16),
  b: parseInt(hex.slice(5, 7), 16),
})

describe('compositionCells', () => {
  it('한글 음절·호환 자모는 2칸, 영문은 1칸', () => {
    expect(compositionCells('글')).toBe(2)
    expect(compositionCells('ㄱ')).toBe(2)
    expect(compositionCells('한글')).toBe(4)
    expect(compositionCells('a')).toBe(1)
    expect(compositionCells('')).toBe(0)
  })

  // r1 F5 — 폭 표의 범위마다 시작·끝은 2칸, 그 바로 바깥(±1)은 1칸. 3400 은 앞 범위(3041–33FF) 끝 +1 이자 다음 범위 시작이라 2칸.
  const ranges: Array<[number, number]> = [
    [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa960, 0xa97f],
    [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd],
  ]
  const inside = (code: number): boolean => ranges.some(([lo, hi]) => code >= lo && code <= hi)
  it.each(ranges.map(([lo, hi]) => [lo.toString(16), hi.toString(16), lo, hi]))('범위 %s–%s: 시작·끝 2칸, 바깥 ±1 은 표 밖이면 1칸', (_lo, _hi, lo, hi) => {
    expect(compositionCells(String.fromCodePoint(lo))).toBe(2)
    expect(compositionCells(String.fromCodePoint(hi))).toBe(2)
    for (const out of [lo - 1, hi + 1]) {
      expect(compositionCells(String.fromCodePoint(out))).toBe(inside(out) ? 2 : 1)
    }
  })
  it('경계 바로 바깥 대표값은 1칸 (표 밖 확인)', () => {
    for (const code of [0x10ff, 0x1160, 0x303f, 0x3040, 0x4dc0, 0x4dff, 0xa95f, 0xa980, 0xabff, 0xd7a4, 0xf8ff, 0xfb00, 0xfe2f, 0xfe50, 0xfeff, 0xff61, 0xffdf, 0xffe7, 0x1ffff, 0x3fffe]) {
      expect(compositionCells(String.fromCodePoint(code))).toBe(1)
    }
    expect(compositionCells(String.fromCodePoint(0x3400))).toBe(2)
  })
})

describe('compositionLayout', () => {
  it('상자를 그려진 커서 칸으로 옮기고 칸 수만큼 넓힌다 (C1 기준선 col 4 값)', () => {
    // xterm 은 33.7255(= 4 × 8.431) 에 놓고, 그려진 커서 칸은 33.25 · 칸 폭 8.28125
    const { dx, width } = compositionLayout({ xtermLeft: 33.7255, anchorLeft: 33.25, cellWidth: 8.28125, cells: 2, caretWidth: 1, screenWidth: 860, devicePixelRatio: 1 })
    expect(33.7255 + dx).toBeCloseTo(33.25)
    // 33.25 + 16.5625 = 49.8125 → device px 50 에 맞춘 caret
    expect(33.25 + width).toBe(50)
  })
  it('caret 자리(상자 왼쪽 + 폭) = 확정 뒤 커서 칸 왼쪽 (C2ⓑ)', () => {
    const cell = 8.28125
    const { dx, width } = compositionLayout({ xtermLeft: 463.7, anchorLeft: 455, cellWidth: cell, cells: 2, caretWidth: 1, screenWidth: 860, devicePixelRatio: 1 })
    expect(Math.abs(463.7 + dx + width - (455 + 2 * cell))).toBeLessThanOrEqual(0.5)
  })
  it('caret 은 device px 에 선다 — DPR 2 면 0.5 px 단위', () => {
    const { dx, width } = compositionLayout({ xtermLeft: 33.7255, anchorLeft: 33.25, cellWidth: 8.28125, cells: 2, caretWidth: 1, screenWidth: 860, devicePixelRatio: 2 })
    const caretX = 33.7255 + dx + width
    expect(caretX * 2).toBe(Math.round(caretX * 2))
    expect(Math.abs(caretX - (33.25 + 2 * 8.28125))).toBeLessThanOrEqual(0.25)
  })
  it('커서 span 이 없으면 xterm 자리 그대로', () => {
    expect(compositionLayout({ xtermLeft: 40, anchorLeft: null, cellWidth: 8, cells: 2, caretWidth: 1, screenWidth: 800, devicePixelRatio: 1 }).dx).toBe(0)
  })
  it('마지막 열이면 상자+caret 이 화면 안에 들어오게 왼쪽으로 당긴다 (C4ⓓ)', () => {
    const { dx, width } = compositionLayout({ xtermLeft: 792, anchorLeft: 792, cellWidth: 8, cells: 2, caretWidth: 2, screenWidth: 800, devicePixelRatio: 1 })
    expect(792 + dx + width + 2).toBeLessThanOrEqual(800)
    expect(792 + dx).toBe(782)
  })
})

describe('compositionColors', () => {
  it('상자 = 테마 배경·전경 (#000/#FFF 아님), caret = 테마 커서', () => {
    const colors = compositionColors({ background: '#282c34', foreground: '#ffffff', cursor: '#ffffff' })
    expect(colors).toEqual({ background: '#282c34', foreground: '#ffffff', caret: '#ffffff' })
  })
  it('배경 알파·짧은 hex 는 불투명 6자리로', () => {
    expect(compositionColors({ background: '#282c34cc', foreground: '#abc', cursor: '#abc' }).background).toBe('#282c34')
    expect(compositionColors({ background: '#fff', foreground: '#000', cursor: '#000' }).foreground).toBe('#000000')
  })
  it('커서 색 대비가 3 미만이면 보정한다 — 어두운 테마·밝은 테마', () => {
    const dark = compositionColors({ background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#333333' })
    expect(dark.caret).toBe('#d4d4d4')
    expect(contrastRatio(rgb(dark.caret), rgb('#1e1e1e'))).toBeGreaterThanOrEqual(CARET_MIN_CONTRAST)
    const light = compositionColors({ background: '#ffffff', foreground: '#eeeeee', cursor: '#f0f0f0' })
    expect(light.caret).toBe('#000000')
    expect(contrastRatio(rgb(light.caret), rgb('#ffffff'))).toBeGreaterThanOrEqual(CARET_MIN_CONTRAST)
  })
  it('테마가 비면 검정 배경·흰 전경', () => {
    expect(compositionColors(undefined)).toEqual({ background: '#000000', foreground: '#ffffff', caret: '#ffffff' })
  })
})

// --- 붙이기 ------------------------------------------------------------------------------------

const rect = (left: number, width: number): DOMRect => new DOMRect(left, 0, width, 16)

function fakeTerminal(theme: ITheme): { term: ImeTerminal; view: HTMLElement; root: HTMLElement; cursor: HTMLElement; renders: Array<() => void>; disposed: () => number } {
  const root = document.createElement('div')
  root.className = 'xterm'
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.getBoundingClientRect = () => rect(100, 860)
  const rows = document.createElement('div')
  rows.className = 'xterm-rows'
  const cursor = document.createElement('span')
  cursor.className = 'xterm-cursor xterm-cursor-block'
  cursor.getBoundingClientRect = () => rect(100 + 33.25, 8.28125)
  rows.appendChild(cursor)
  const view = document.createElement('div')
  view.className = 'composition-view'
  screen.append(rows, view)
  root.appendChild(screen)
  document.body.appendChild(root)
  const renders: Array<() => void> = []
  let disposeCount = 0
  const term: ImeTerminal = {
    element: root,
    cols: 102,
    options: { cursorWidth: 2, theme },
    buffer: { active: { baseY: 0, cursorX: 4, cursorY: 0, getLine: () => ({ getCell: () => ({ getWidth: () => 1 }) }) } },
    onRender: (listener) => {
      renders.push(listener)
      return { dispose: () => { disposeCount += 1 } }
    },
  }
  return { term, view, root, cursor, renders, disposed: () => disposeCount }
}

// MutationObserver 콜백은 마이크로태스크로 돈다.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** xterm `compositionupdate` 가 상자에 하는 일 그대로 — 글자·left·active. */
function xtermUpdate(view: HTMLElement, text: string): void {
  view.textContent = text
  view.style.left = '33.7255px'
  view.classList.add('active')
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('attachImeComposition', () => {
  it('조합 중에만 클래스와 위치·색·caret 변수를 쓰고, 확정(active 해제)에 걷는다', async () => {
    const { term, view, root } = fakeTerminal({ background: '#282c34', foreground: '#fafafa', cursor: '#ffcc00' })
    const detach = attachImeComposition({ term })
    expect(root.classList.contains(IME_COMPOSING_CLASS)).toBe(false)

    xtermUpdate(view, '글')
    await settle()
    expect(root.classList.contains(IME_COMPOSING_CLASS)).toBe(true)
    expect(Number.parseFloat(root.style.getPropertyValue('--corral-ime-dx'))).toBeCloseTo(33.25 - 33.7255)
    expect(33.25 + Number.parseFloat(root.style.getPropertyValue('--corral-ime-w'))).toBe(50)
    expect(root.style.getPropertyValue('--corral-ime-bg')).toBe('#282c34')
    expect(root.style.getPropertyValue('--corral-ime-fg')).toBe('#fafafa')
    expect(root.style.getPropertyValue('--corral-ime-caret')).toBe('#ffcc00')
    expect(root.style.getPropertyValue('--corral-ime-caret-w')).toBe('2px')

    view.classList.remove('active')
    await settle()
    expect(root.classList.contains(IME_COMPOSING_CLASS)).toBe(false)
    expect(root.style.getPropertyValue('--corral-ime-dx')).toBe('')
    detach()
  })

  it('테마를 바꾸면 재부착 없이 다음 조합부터 새 색 (C3ⓓ)', async () => {
    const { term, view, root } = fakeTerminal({ background: '#000000', foreground: '#ffffff', cursor: '#ffffff' })
    const detach = attachImeComposition({ term })
    xtermUpdate(view, '한')
    await settle()
    view.classList.remove('active')
    await settle()
    term.options.theme = { background: '#ffffff', foreground: '#111111', cursor: '#222222' }
    xtermUpdate(view, '글')
    await settle()
    expect(root.style.getPropertyValue('--corral-ime-bg')).toBe('#ffffff')
    expect(root.style.getPropertyValue('--corral-ime-caret')).toBe('#222222')
    detach()
  })

  it('조합 중 다시 그려지면(onRender) 커서 칸을 다시 잰다', async () => {
    const { term, view, root, cursor, renders } = fakeTerminal({})
    const detach = attachImeComposition({ term })
    xtermUpdate(view, '달')
    await settle()
    cursor.getBoundingClientRect = () => rect(100 + 41.53, 8.28125)
    for (const render of renders) render()
    expect(Number.parseFloat(root.style.getPropertyValue('--corral-ime-dx'))).toBeCloseTo(41.53 - 33.7255)
    detach()
  })

  it('떼면 구독을 풀고 흔적을 지운다', async () => {
    const { term, view, root, disposed } = fakeTerminal({})
    const detach = attachImeComposition({ term })
    xtermUpdate(view, '글')
    await settle()
    detach()
    expect(disposed()).toBe(1)
    expect(root.classList.contains(IME_COMPOSING_CLASS)).toBe(false)
    view.textContent = '달'
    await settle()
    expect(root.classList.contains(IME_COMPOSING_CLASS)).toBe(false)
  })

  it('xterm 이 아직 안 열렸으면(element 없음) 아무것도 하지 않는다', () => {
    const { term } = fakeTerminal({})
    const detach = attachImeComposition({ term: { ...term, element: undefined } })
    expect(() => detach()).not.toThrow()
  })
})
