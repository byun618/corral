// @vitest-environment happy-dom
// LIFE-573 — 링크 행 캐시 무효화·정지 포인터 재평가(C1·C2·C3·C6 단위), 재질의 상한(C5), 비공개 모양 불일치 시 현재 동작(C4), dispose 정리(제약 5).
// Linkifier 는 xterm 6.0.0 의 캐시 규칙만 흉내 낸 가짜다 — 같은 칸이면 hover 를 건너뛰고, 같은 행이면 캐시를 쓴다(질의 0).
// 실제 Linkifier 경로(합성 마우스 → provider → `_handleNewLink` → 열림)는 끝의 「실제 Linkifier 통합」 블록이 본다(fix r1 F2) — 레이아웃이 없는 happy-dom 이라
// 마우스 좌표 → 칸 변환(`_mouseService.getCoords`)만 그 블록 안에서 갈아 끼운다. 렌더러 화면·OS 입력은 네이티브 관문 몫이다.
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachLinkRefresh, LINK_REFRESH_INTERVAL_MS, type LinkRefreshTerminal } from './terminal-link-refresh.js'
import { registerTerminalLinks, terminalLinkHandler } from './terminal-links.js'

type Cell = { x: number; y: number }

/** xterm 6.0.0 Linkifier 의 캐시 단락 ①·② 만 옮긴 가짜. `queries` = provider 를 다시 물은 횟수. clientX/Y 가 곧 칸(1 기반). */
class FakeLinkifier {
  _element: HTMLElement = document.createElement('div')
  _activeLine = -1
  _lastBufferCell: Cell | undefined = undefined
  _isMouseOut = true
  _lastMouseEvent: MouseEvent | undefined = undefined
  _currentLink: object | undefined = undefined
  queries = 0
  /** `_handleMouseMove` 가 불린 횟수(직접 move 포함). */
  moves = 0
  /** 터미널 사각형 — happy-dom 은 레이아웃이 없어 0 사각형이라 스텁한다(fix r2). 기본은 모든 칸을 덮는다. */
  rect = new DOMRect(0, 0, 1000, 1000)

  constructor() {
    this._element.getBoundingClientRect = () => this.rect
    this._element.addEventListener('mouseleave', () => {
      this._isMouseOut = true
      this._currentLink = undefined
    })
  }

  _handleMouseMove(event: MouseEvent): void {
    this.moves++
    this._lastMouseEvent = event
    this._isMouseOut = false
    const position = { x: event.clientX, y: event.clientY }
    const last = this._lastBufferCell
    if (last !== undefined && last.x === position.x && last.y === position.y) return
    if (this._activeLine !== position.y) {
      this.queries++
      this._activeLine = position.y
    }
    this._lastBufferCell = position
  }

  move(cell: Cell): void {
    this._handleMouseMove(new MouseEvent('mousemove', { clientX: cell.x, clientY: cell.y }))
  }
}

type FakeTerm = LinkRefreshTerminal & { _core: unknown; render(range?: { start: number; end: number }): void; listeners(): number }

function fakeTerm(input: { core: unknown; viewportY?: number; rows?: number }): FakeTerm {
  const listeners = new Set<(event: { start: number; end: number }) => void>()
  return {
    _core: input.core,
    rows: input.rows ?? 24,
    buffer: { active: { viewportY: input.viewportY ?? 0 } },
    onRender: (listener) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    render: (range = { start: 0, end: 23 }) => listeners.forEach((listener) => listener(range)),
    listeners: () => listeners.size,
  }
}

function setup(): { linkifier: FakeLinkifier; term: FakeTerm; refresh: ReturnType<typeof attachLinkRefresh> } {
  const linkifier = new FakeLinkifier()
  const term = fakeTerm({ core: { linkifier } })
  const refresh = attachLinkRefresh({ term })
  return { linkifier, term, refresh }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('정지 포인터 재평가 (C1)', () => {
  it('간격은 100ms 이하 — 정지 포인터 아래 링크가 사람 눈에 늦지 않게 (fix r1 F1)', () => {
    expect(LINK_REFRESH_INTERVAL_MS).toBeGreaterThan(0)
    expect(LINK_REFRESH_INTERVAL_MS).toBeLessThanOrEqual(100)
  })

  it('렌더 뒤 간격이 지나면 마지막 포인터로 한 번 다시 묻는다', () => {
    const { linkifier, term, refresh } = setup()
    expect(refresh.active).toBe(true)
    linkifier.move({ x: 3, y: 5 })
    expect(linkifier.queries).toBe(1)
    term.render()
    // 캐시는 즉시 잊지만 질의는 아직 없다.
    expect(linkifier._activeLine).toBe(-1)
    expect(linkifier.queries).toBe(1)
    vi.advanceTimersByTime(LINK_REFRESH_INTERVAL_MS - 1)
    expect(linkifier.queries).toBe(1)
    vi.advanceTimersByTime(1)
    expect(linkifier.queries).toBe(2)
    expect(linkifier._activeLine).toBe(5)
    expect(linkifier._lastBufferCell).toEqual({ x: 3, y: 5 })
  })

  it('예약 중 렌더가 이어져도 예약을 미루지 않는다 — 스트리밍 중에도 간격마다 1회(C5ⓑ 상한)', () => {
    const { linkifier, term } = setup()
    linkifier.move({ x: 3, y: 5 })
    // 10초 동안 10ms 마다 전체 리페인트.
    for (let t = 0; t < 10_000; t += 10) {
      term.render()
      vi.advanceTimersByTime(10)
    }
    const requeries = linkifier.queries - 1
    expect(requeries).toBeLessThanOrEqual(10_000 / LINK_REFRESH_INTERVAL_MS)
    // 굶지 않는다 — 꼬리 디바운스였다면 0 이다.
    expect(requeries).toBeGreaterThanOrEqual(10_000 / LINK_REFRESH_INTERVAL_MS - 1)
  })
})

describe('같은 행 안 이동 (C2·C3)', () => {
  it('렌더 뒤 같은 행 다른 칸으로 옮기면 캐시를 쓰지 않고 다시 묻는다 — 예약은 겹쳐 묻지 않는다', () => {
    const { linkifier, term } = setup()
    linkifier.move({ x: 3, y: 5 })
    term.render()
    linkifier.move({ x: 12, y: 5 })
    expect(linkifier.queries).toBe(2)
    vi.advanceTimersByTime(LINK_REFRESH_INTERVAL_MS)
    expect(linkifier.queries).toBe(2)
  })

  it('렌더가 없으면 같은 행 이동은 여전히 캐시를 쓴다(질의 0)', () => {
    const { linkifier } = setup()
    linkifier.move({ x: 3, y: 5 })
    linkifier.move({ x: 12, y: 5 })
    vi.advanceTimersByTime(1000)
    expect(linkifier.queries).toBe(1)
  })
})

describe('#4298 경로와 겹치지 않음 (제약 4)', () => {
  it('링크가 잡혀 있으면 렌더에 아무것도 안 한다', () => {
    const { linkifier, term } = setup()
    linkifier.move({ x: 3, y: 5 })
    linkifier._currentLink = {}
    term.render()
    expect(linkifier._activeLine).toBe(5)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('예약 뒤 링크가 잡히면 예약된 재평가를 그만둔다', () => {
    const { linkifier, term } = setup()
    linkifier.move({ x: 3, y: 5 })
    term.render()
    linkifier._currentLink = {}
    vi.advanceTimersByTime(LINK_REFRESH_INTERVAL_MS)
    expect(linkifier.queries).toBe(1)
  })
})

describe('렌더 범위', () => {
  it('캐시된 행이 렌더 범위 밖이면 잊지 않는다', () => {
    const { linkifier, term } = setup()
    linkifier.move({ x: 3, y: 5 })
    // 0 기반 렌더 행 9..9 = 1 기반 버퍼 행 10.
    term.render({ start: 9, end: 9 })
    expect(linkifier._activeLine).toBe(5)
    expect(vi.getTimerCount()).toBe(0)
    // 0 기반 4 = 1 기반 5 — 범위 안.
    term.render({ start: 4, end: 4 })
    expect(linkifier._activeLine).toBe(-1)
  })

  it('viewportY 만큼 밀린 버퍼 행으로 비교한다', () => {
    const linkifier = new FakeLinkifier()
    const term = fakeTerm({ core: { linkifier }, viewportY: 10 })
    attachLinkRefresh({ term })
    linkifier.move({ x: 3, y: 15 })
    term.render({ start: 4, end: 4 })
    expect(linkifier._activeLine).toBe(-1)
  })

  // fix r1 F1 — 경계 양쪽. 캐시 행(1 기반 y)의 바로 위·바로 아래 행만 렌더되면 잊지 않고, 그 행이 렌더되면 잊는다.
  it.each([
    { viewportY: 0, y: 5 },
    { viewportY: 10, y: 15 },
  ])('경계: viewportY=$viewportY, 캐시 행 $y — 바로 위·아래 행 렌더는 그대로, 그 행 렌더는 잊는다', ({ viewportY, y }) => {
    const linkifier = new FakeLinkifier()
    const term = fakeTerm({ core: { linkifier }, viewportY })
    attachLinkRefresh({ term })
    linkifier.move({ x: 3, y })
    // 0 기반 화면 행 r = 1 기반 버퍼 행 viewportY + r + 1.
    const screenRow = y - viewportY - 1
    term.render({ start: screenRow - 1, end: screenRow - 1 })
    expect(linkifier._activeLine).toBe(y)
    term.render({ start: screenRow + 1, end: screenRow + 1 })
    expect(linkifier._activeLine).toBe(y)
    expect(vi.getTimerCount()).toBe(0)
    term.render({ start: screenRow, end: screenRow })
    expect(linkifier._activeLine).toBe(-1)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('캐시 행이 스크롤로 화면 밖이면 렌더 범위와 무관하게 잊고 예약한다 (fix r1 F4)', () => {
    const linkifier = new FakeLinkifier()
    // 6행 화면, 맨 윗 행(1)에 정지 포인터 → 출력이 6행 스크롤해 viewportY=6. 캐시 행 1 은 이제 화면 밖이다.
    const term = fakeTerm({ core: { linkifier }, rows: 6 })
    attachLinkRefresh({ term })
    linkifier.move({ x: 3, y: 1 })
    term.buffer.active.viewportY = 6
    // 화면 맨 윗 행(0 기반 0)이 아닌 일부만 렌더돼도 — 범위 검사로 건너뛰면 안 된다.
    term.render({ start: 3, end: 5 })
    expect(linkifier._activeLine).toBe(-1)
    expect(vi.getTimerCount()).toBe(1)
    // 화면 아래로 밀린 경우(viewportY 가 줄어 캐시 행이 bottom 밖)도 같다.
    linkifier.move({ x: 3, y: 12 })
    term.buffer.active.viewportY = 0
    term.render({ start: 0, end: 0 })
    expect(linkifier._activeLine).toBe(-1)
  })
})

describe('포인터가 밖 (C5ⓐ·C6)', () => {
  it('포인터가 밖이면 10초 스트리밍 동안 질의 0·예약 0', () => {
    const { linkifier, term } = setup()
    linkifier.move({ x: 3, y: 5 })
    linkifier._element.dispatchEvent(new MouseEvent('mouseleave'))
    const before = linkifier.queries
    for (let t = 0; t < 10_000; t += 16) {
      term.render()
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(16)
    }
    expect(linkifier.queries).toBe(before)
  })

  it('처음부터 포인터가 들어온 적이 없으면 렌더에 아무것도 안 한다', () => {
    const { linkifier, term } = setup()
    term.render()
    vi.advanceTimersByTime(1000)
    expect(linkifier.queries).toBe(0)
  })

  it('밖에 나갔다 같은 칸으로 돌아오면 다시 묻는다', () => {
    const { linkifier } = setup()
    linkifier.move({ x: 3, y: 5 })
    linkifier._element.dispatchEvent(new MouseEvent('mouseleave'))
    expect(linkifier.queries).toBe(1)
    linkifier.move({ x: 3, y: 5 })
    expect(linkifier.queries).toBe(2)
  })

  it('(양성 대조) 붙이지 않으면 같은 칸 복귀는 hover 를 건너뛴다', () => {
    const linkifier = new FakeLinkifier()
    linkifier.move({ x: 3, y: 5 })
    linkifier._element.dispatchEvent(new MouseEvent('mouseleave'))
    linkifier.move({ x: 3, y: 5 })
    expect(linkifier.queries).toBe(1)
  })
})

describe('dispose (제약 5)', () => {
  it('예약된 타이머·렌더 리스너·mouseleave 리스너를 거둔다', () => {
    const { linkifier, term, refresh } = setup()
    linkifier.move({ x: 3, y: 5 })
    term.render()
    expect(vi.getTimerCount()).toBe(1)
    expect(term.listeners()).toBe(1)
    refresh.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(term.listeners()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(linkifier.queries).toBe(1)
    // mouseleave 가 더는 캐시를 잊지 않는다.
    linkifier.move({ x: 4, y: 6 })
    linkifier._element.dispatchEvent(new MouseEvent('mouseleave'))
    expect(linkifier._activeLine).toBe(6)
  })
})

describe('비공개 모양 불일치 → 현재 동작 (C4)', () => {
  /** 모양 하나를 깨뜨린 Linkifier. 렌더·leave 가 예외 없이 아무것도 바꾸지 않아야 한다. */
  const broken: Array<[string, () => unknown]> = [
    ['_core 없음', () => undefined],
    ['linkifier 없음', () => ({})],
    ['linkifier 가 원시값', () => ({ linkifier: 1 })],
    ['_activeLine 이 문자열', () => ({ linkifier: Object.assign(new FakeLinkifier(), { _activeLine: '-1' }) })],
    ['_isMouseOut 없음', () => ({ linkifier: Object.assign(new FakeLinkifier(), { _isMouseOut: undefined }) })],
    ['_lastBufferCell 이 숫자', () => ({ linkifier: Object.assign(new FakeLinkifier(), { _lastBufferCell: 3 }) })],
    ['_currentLink 가 null', () => ({ linkifier: Object.assign(new FakeLinkifier(), { _currentLink: null }) })],
    ['_lastMouseEvent 가 문자열', () => ({ linkifier: Object.assign(new FakeLinkifier(), { _lastMouseEvent: 'x' }) })],
    ['_element 가 HTMLElement 아님', () => ({ linkifier: Object.assign(new FakeLinkifier(), { _element: {} }) })],
    ['_handleMouseMove 없음', () => ({ linkifier: Object.assign(new FakeLinkifier(), { _handleMouseMove: undefined }) })],
  ]

  it.each(broken)('%s — active false, 렌더해도 예외·변경 없음', (_name, core) => {
    const term = fakeTerm({ core: core() })
    const refresh = attachLinkRefresh({ term })
    expect(refresh.active).toBe(false)
    expect(term.listeners()).toBe(0)
    expect(() => term.render()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
    expect(() => refresh.dispose()).not.toThrow()
  })

  it('붙인 뒤 모양이 바뀌면 그때부터 아무것도 쓰지 않는다', () => {
    const { linkifier, term } = setup()
    linkifier.move({ x: 3, y: 5 })
    Reflect.set(linkifier, '_lastBufferCell', 'broken')
    expect(() => term.render()).not.toThrow()
    expect(linkifier._activeLine).toBe(5)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => linkifier._element.dispatchEvent(new MouseEvent('mouseleave'))).not.toThrow()
    expect(Reflect.get(linkifier, '_lastBufferCell')).toBe('broken')
  })

  it('예약 뒤 모양이 바뀌면 재평가를 부르지 않는다', () => {
    const { linkifier, term } = setup()
    linkifier.move({ x: 3, y: 5 })
    term.render()
    Reflect.set(linkifier, '_isMouseOut', 'no')
    expect(() => vi.advanceTimersByTime(LINK_REFRESH_INTERVAL_MS)).not.toThrow()
    expect(linkifier.queries).toBe(1)
  })
})

// fix r2 L4-4 — 저장된 포인터 좌표가 터미널 사각형 밖(레이아웃 변경, mouseleave 없음)이면 재평가가 `_handleMouseMove` 를 부르지 않는다.
describe('저장 좌표가 터미널 사각형 밖 (fix r2 L4-4)', () => {
  /** 사각형 left 10 · top 20 · right 110 · bottom 70. 포인터를 point 에 두고 렌더 → 간격 뒤 재평가로 불린 `_handleMouseMove` 횟수. */
  function rehoverCalls(point: { x: number; y: number }): number {
    const { linkifier, term } = setup()
    linkifier.rect = new DOMRect(10, 20, 100, 50)
    linkifier.move(point)
    const before = linkifier.moves
    term.render()
    vi.advanceTimersByTime(LINK_REFRESH_INTERVAL_MS)
    return linkifier.moves - before
  }

  it.each([
    ['왼쪽', { x: 5, y: 40 }],
    ['오른쪽', { x: 150, y: 40 }],
    ['위', { x: 50, y: 10 }],
    ['아래', { x: 50, y: 90 }],
  ])('%s 밖이면 0회', (_side, point) => {
    expect(rehoverCalls(point)).toBe(0)
  })

  it('안이면 1회 (양성 대조)', () => {
    expect(rehoverCalls({ x: 50, y: 40 })).toBe(1)
  })

  it.each([
    ['left 포함', 1, { x: 10, y: 40 }],
    ['left 바로 밖', 0, { x: 9.5, y: 40 }],
    ['top 포함', 1, { x: 50, y: 20 }],
    ['top 바로 밖', 0, { x: 50, y: 19.5 }],
    ['right 제외', 0, { x: 110, y: 40 }],
    ['right 바로 안', 1, { x: 109.5, y: 40 }],
    ['bottom 제외', 0, { x: 50, y: 70 }],
    ['bottom 바로 안', 1, { x: 50, y: 69.5 }],
  ])('경계 %s → %i회', (_name, calls, point) => {
    expect(rehoverCalls(point)).toBe(calls)
  })

  it.each([
    ['clientX 가 문자열', { clientX: '50', clientY: 40 }],
    ['clientY 없음', { clientX: 50 }],
  ])('%s 이면 0회 — 모양 불일치 = 현재 동작', (_name, event) => {
    const { linkifier, term } = setup()
    linkifier.move({ x: 50, y: 40 })
    Reflect.set(linkifier, '_lastMouseEvent', event)
    const before = linkifier.moves
    term.render()
    vi.advanceTimersByTime(LINK_REFRESH_INTERVAL_MS)
    expect(linkifier.moves - before).toBe(0)
  })
})

describe('실제 @xterm/xterm 6.0.0', () => {
  it('open 뒤 비공개 Linkifier 모양이 맞아 붙는다 — 버전이 바뀌어 이 건이 깨지면 이 모듈을 다시 본다', () => {
    vi.useRealTimers()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    try {
      term.open(host)
      const refresh = attachLinkRefresh({ term })
      expect(refresh.active).toBe(true)
      refresh.dispose()
    } finally {
      term.dispose()
      host.remove()
    }
  })

  it('open 전에는 Linkifier 가 없어 붙지 않는다(예외 없음)', () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    try {
      expect(attachLinkRefresh({ term }).active).toBe(false)
    } finally {
      term.dispose()
    }
  })
})

// fix r1 F2 — 실제 @xterm/xterm 6.0.0 Linkifier(가짜 아님) + 실제 평문 provider·OSC 8 처리기. 시나리오마다 **모듈 없이 / 있게** 같은 순서를 돌려
// 없을 때 실패(양성 대조 — 증상이 실제로 재현된다)·있을 때 통과를 한 테스트 안에서 본다. 리뷰어 r1 스크래치(`raw/review/claude-r1-raw/scratch-tests/zzreal.test.ts`) 를 옮겼다.
// 바꾸는 것은 `_mouseService.getCoords` 하나다 — happy-dom 은 레이아웃이 없어 clientX/Y 를 그대로 칸(1 기반)으로 본다. 제품 코드는 이 대체를 모른다.
describe('실제 Linkifier 통합 (C1·C2·C3·C6 양성 대조)', () => {
  /** 렌더(다음 animation frame)·재평가 간격을 넉넉히 넘기는 대기. */
  const SETTLE_MS = LINK_REFRESH_INTERVAL_MS * 4
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const at = (input: { row: number; col: number; text: string }): string => `\x1b[${input.row};${input.col}H${input.text}`

  type Harness = {
    write(data: string): Promise<void>
    move(cell: { x: number; y: number }): void
    leave(): void
    click(cell: { x: number; y: number }): void
    /** 터미널 사각형을 옮긴다(레이아웃 변경 — mouseleave 없음). */
    moveRect(rect: { left: number; top: number }): void
    hovered(): boolean
    opened: string[]
    dispose(): void
  }

  function harness(input: { attach: boolean }): Harness {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const term = new Terminal({ cols: 60, rows: 6, scrollback: 0, allowProposedApi: true, linkHandler: terminalLinkHandler })
    term.open(host)
    const links = registerTerminalLinks(term)
    const core: unknown = Reflect.get(term, '_core')
    if (core === null || typeof core !== 'object') throw new Error('xterm 6.0.0 _core 없음')
    const mouse: unknown = Reflect.get(core, '_mouseService')
    const linkifier: unknown = Reflect.get(core, 'linkifier')
    if (mouse === null || typeof mouse !== 'object' || linkifier === null || typeof linkifier !== 'object') throw new Error('xterm 6.0.0 모양 아님')
    const screen: unknown = Reflect.get(linkifier, '_element')
    if (!(screen instanceof HTMLElement)) throw new Error('Linkifier _element 없음')
    // 1px = 1칸. 사각형 기준 상대 좌표를 실제 getCoords 처럼 1..cols·1..rows 로 클램프한다 — 사각형이 (0,0) 이면 clientX/Y 가 곧 칸(fix r2).
    let rect = new DOMRect(0, 0, 1000, 1000)
    screen.getBoundingClientRect = () => rect
    const clamp = (value: number, max: number): number => Math.min(Math.max(value, 1), max)
    Reflect.set(mouse, 'getCoords', (event: MouseEvent) => [clamp(event.clientX - rect.left, term.cols), clamp(event.clientY - rect.top, term.rows)])
    const refresh = input.attach ? attachLinkRefresh({ term }) : null
    if (refresh !== null) expect(refresh.active).toBe(true)
    const opened: string[] = []
    const open = vi.spyOn(window, 'open').mockImplementation((url) => {
      opened.push(String(url))
      return null
    })
    const mouseAt = (type: string, cell: { x: number; y: number }, metaKey = false): void => {
      screen.dispatchEvent(new MouseEvent(type, { clientX: cell.x, clientY: cell.y, bubbles: true, metaKey }))
    }
    return {
      write: (data) => new Promise((resolve) => term.write(data, resolve)),
      move: (cell) => mouseAt('mousemove', cell),
      leave: () => screen.dispatchEvent(new MouseEvent('mouseleave')),
      click: (cell) => {
        mouseAt('mousedown', cell, true)
        mouseAt('mouseup', cell, true)
      },
      moveRect: (next) => {
        rect = new DOMRect(next.left, next.top, 1000, 1000)
      },
      hovered: () => Reflect.get(linkifier, '_currentLink') !== undefined,
      opened,
      dispose: () => {
        open.mockRestore()
        refresh?.dispose()
        links.dispose()
        term.dispose()
        host.remove()
      },
    }
  }

  /** 같은 시나리오를 모듈 없이·있게 돌려 각각 열린 URL 목록을 낸다. */
  async function both(scenario: (h: Harness) => Promise<void>): Promise<{ without: string[]; with: string[] }> {
    const result: { without: string[]; with: string[] } = { without: [], with: [] }
    for (const attach of [false, true]) {
      const h = harness({ attach })
      try {
        await scenario(h)
        if (attach) result.with = [...h.opened]
        else result.without = [...h.opened]
      } finally {
        h.dispose()
      }
    }
    return result
  }

  beforeEach(() => {
    vi.useRealTimers()
  })

  it('C1 평문 — 링크 없는 칸에 정지한 포인터 아래로 URL 이 온다 → 이동 없이 ⌘+클릭', async () => {
    const url = 'https://example.com/?l573=c1'
    const result = await both(async (h) => {
      await h.write(at({ row: 3, col: 1, text: '_'.repeat(10) }))
      await sleep(SETTLE_MS)
      h.move({ x: 8, y: 3 })
      await h.write(at({ row: 3, col: 5, text: url }))
      await sleep(SETTLE_MS)
      h.click({ x: 8, y: 3 })
    })
    expect(result.without).toEqual([])
    expect(result.with).toEqual([url])
  })

  it('C1 OSC 8 — 정지 포인터 아래로 OSC 8 링크가 온다', async () => {
    const url = 'https://example.com/?l573=c1osc'
    const result = await both(async (h) => {
      await h.write(at({ row: 3, col: 1, text: '_'.repeat(10) }))
      await sleep(SETTLE_MS)
      h.move({ x: 8, y: 3 })
      await h.write(at({ row: 3, col: 5, text: `\x1b]8;;${url}\x1b\\label-text\x1b]8;;\x1b\\` }))
      await sleep(SETTLE_MS)
      h.click({ x: 8, y: 3 })
    })
    expect(result.without).toEqual([])
    expect(result.with).toEqual([url])
  })

  it('C2 — 행이 바뀌어 다른 열에 새 URL, 같은 행 안에서 그 칸으로 이동 → ⌘+클릭', async () => {
    const url = 'https://example.com/?l573=c2'
    const result = await both(async (h) => {
      await h.write(at({ row: 3, col: 1, text: 'no link here' }))
      await sleep(SETTLE_MS)
      h.move({ x: 2, y: 3 })
      await h.write(at({ row: 3, col: 1, text: `\x1b[2Kabc ${url}` }))
      await sleep(SETTLE_MS)
      h.move({ x: 12, y: 3 })
      h.click({ x: 12, y: 3 })
    })
    expect(result.without).toEqual([])
    expect(result.with).toEqual([url])
  })

  it('C3 — 사라진 링크 A 의 옛 범위로 같은 행 이동 → ⌘+클릭 열림 0 (수정 전에는 A 가 열린다)', async () => {
    const stale = 'https://example.com/?l573=c3A'
    const result = await both(async (h) => {
      await h.write(at({ row: 3, col: 1, text: `abc ${stale}` }))
      await sleep(SETTLE_MS)
      h.move({ x: 2, y: 3 })
      await h.write(at({ row: 3, col: 1, text: '\x1b[2Kno link here' }))
      await sleep(SETTLE_MS)
      h.move({ x: 10, y: 3 })
      h.click({ x: 10, y: 3 })
    })
    expect(result.without).toEqual([stale])
    expect(result.with).toEqual([])
  })

  it('C6 — 밖에 나간 사이 같은 칸에 URL, 같은 칸으로 복귀 → ⌘+클릭', async () => {
    const url = 'https://example.com/?l573=c6'
    const result = await both(async (h) => {
      await h.write(at({ row: 3, col: 1, text: '_'.repeat(10) }))
      await sleep(SETTLE_MS)
      h.move({ x: 8, y: 3 })
      h.leave()
      await h.write(at({ row: 3, col: 5, text: url }))
      await sleep(SETTLE_MS)
      h.move({ x: 8, y: 3 })
      h.click({ x: 8, y: 3 })
    })
    expect(result.without).toEqual([])
    expect(result.with).toEqual([url])
  })

  it('수식키 없는 클릭은 열지 않는다 (C4 회귀 — 모듈이 있어도)', async () => {
    const h = harness({ attach: true })
    try {
      await h.write(at({ row: 3, col: 1, text: 'https://example.com/?l573=nometa' }))
      await sleep(SETTLE_MS)
      h.move({ x: 8, y: 3 })
      const screenCell = { clientX: 8, clientY: 3, bubbles: true }
      const target = document.querySelector('.xterm-screen')
      if (target === null) throw new Error('.xterm-screen 없음')
      target.dispatchEvent(new MouseEvent('mousedown', screenCell))
      target.dispatchEvent(new MouseEvent('mouseup', screenCell))
      expect(h.opened).toEqual([])
      // 양성 대조 — 같은 자리 ⌘+클릭은 연다(링크가 실제로 잡혀 있었다).
      h.click({ x: 8, y: 3 })
      expect(h.opened).toEqual(['https://example.com/?l573=nometa'])
    } finally {
      h.dispose()
    }
  })

  /** L4-4 — 포인터 정지 → 사각형 이동(mouseleave 없음) → 그 행 0열에 URL → 렌더·간격 대기 뒤 hover 여부를 모듈 없이·있게. */
  async function layoutShift(input: { pointer: { x: number; y: number }; left: number; url: string }): Promise<{ without: boolean; with: boolean }> {
    const result = { without: false, with: false }
    for (const attach of [false, true]) {
      const h = harness({ attach })
      try {
        await h.write(at({ row: 3, col: 1, text: '_'.repeat(10) }))
        await sleep(SETTLE_MS)
        h.move(input.pointer)
        h.moveRect({ left: input.left, top: 0 })
        await h.write(at({ row: 3, col: 1, text: input.url }))
        await sleep(SETTLE_MS)
        if (attach) result.with = h.hovered()
        else result.without = h.hovered()
      } finally {
        h.dispose()
      }
    }
    return result
  }

  it('L4-4 — 가장자리 칸에 정지 뒤 사각형이 옮겨 저장 좌표가 밖이면 0열 URL 을 hover 하지 않는다 (fix r2)', async () => {
    const result = await layoutShift({ pointer: { x: 1, y: 3 }, left: 100, url: 'https://example.com/?l573=l44' })
    expect(result).toEqual({ without: false, with: false })
  })

  it('L4-4 양성 대조 — 사각형이 옮겨도 저장 좌표가 안(다른 칸)이면 그 칸 링크를 hover 한다', async () => {
    // 저장 clientX 8 · left 5 → 3열, URL 은 1열부터.
    const result = await layoutShift({ pointer: { x: 8, y: 3 }, left: 5, url: 'https://example.com/?l573=l44pos' })
    expect(result).toEqual({ without: false, with: true })
  })
})
