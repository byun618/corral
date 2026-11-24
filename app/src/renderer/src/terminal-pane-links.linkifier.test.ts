// @vitest-environment happy-dom
// LIFE-835 fix1 — 실제 xterm 6.0.0 Linkifier 위 시험(r1 E②④). TerminalPane 과 같은 등록 순서: OSC 8(생성자) → 평문 URL → refresh → pane 이름.
// happy-dom 은 레이아웃이 없어 마우스 좌표 → 칸 변환(`_mouseService.getCoords`)과 화면 사각형만 갈아 끼운다(`terminal-link-refresh.test.ts` 「실제 Linkifier 통합」과 같은 방식).
//   · D5 — URL·OSC 8 안의 이름은 URL 이 이긴다: ⌘ 한 번에 열림 1·이동 0
//   · C3ⓓ — 「요청 없이 상태가 오갔다」: 포인터 정지 → 집합에서 빠짐 → 밑줄·툴팁 0 / 포인터 정지 → 집합에 생김 → 밑줄
//   · C3ⓐ — 같은 행 안에서 벗어났다 돌아오기(그 사이 집합이 바뀜) — 지금 집합 기준
import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachLinkRefresh } from './terminal-link-refresh.js'
import { registerTerminalLinks, terminalLinkHandler } from './terminal-links.js'
import { publishLivePaneIds, registerPaneNameLinks, setPaneLinkDirectory } from './terminal-pane-links.js'

const live = new Set<string>()
const reveal = vi.fn()
const notifyGone = vi.fn()

type Harness = {
  write(data: string): Promise<void>
  move(cell: { x: number; y: number }): void
  leave(): void
  click(cell: { x: number; y: number }): void
  /** 지금 xterm 이 잡은 링크 글자(밑줄). 없으면 null. */
  current(): string | null
  tip(): string | null
  opened: string[]
  /** 살아 있는 집합을 바꾸고 App 처럼 발행한다 — 포인터는 그대로. */
  setLive(ids: string[]): void
  dispose(): void
}

/** `refresh: false` 는 변이 대조 — A 수정(재평가)을 끈 배선. */
function harness(input: { refresh: boolean } = { refresh: true }): Harness {
  const release = setPaneLinkDirectory({
    lookup: (paneId) => (live.has(paneId) ? { paneId, worktreeName: 'wt', tabTitle: 'tab', paneNumber: 1 } : null),
    reveal,
    notifyGone,
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const term = new Terminal({ cols: 60, rows: 6, scrollback: 0, allowProposedApi: true, linkHandler: terminalLinkHandler })
  term.open(host)
  const urls = registerTerminalLinks(term)
  const refresh = attachLinkRefresh({ term })
  expect(refresh.active).toBe(true)
  const panes = registerPaneNameLinks({ term, paneId: 'wZ4:p1', reevaluate: input.refresh ? refresh.reevaluate : () => {} })
  const core: unknown = Reflect.get(term, '_core')
  if (core === null || typeof core !== 'object') throw new Error('xterm 6.0.0 _core 없음')
  const mouse: unknown = Reflect.get(core, '_mouseService')
  const linkifier: unknown = Reflect.get(core, 'linkifier')
  if (mouse === null || typeof mouse !== 'object' || linkifier === null || typeof linkifier !== 'object') throw new Error('xterm 6.0.0 모양 아님')
  const screen: unknown = Reflect.get(linkifier, '_element')
  if (!(screen instanceof HTMLElement)) throw new Error('Linkifier _element 없음')
  // 1px = 1칸.
  const rect = new DOMRect(0, 0, 1000, 1000)
  screen.getBoundingClientRect = () => rect
  const clamp = (value: number, max: number): number => Math.min(Math.max(value, 1), max)
  Reflect.set(mouse, 'getCoords', (event: MouseEvent) => [clamp(event.clientX, term.cols), clamp(event.clientY, term.rows)])
  const opened: string[] = []
  vi.spyOn(window, 'open').mockImplementation((url) => {
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
    current: () => {
      const link: unknown = Reflect.get(linkifier, '_currentLink')
      if (link === null || typeof link !== 'object') return null
      const inner: unknown = Reflect.get(link, 'link')
      const text: unknown = inner !== null && typeof inner === 'object' ? Reflect.get(inner, 'text') : null
      return typeof text === 'string' ? text : null
    },
    tip: () => document.querySelector('[data-pane-link-tip]')?.textContent ?? null,
    opened,
    setLive: (ids) => {
      live.clear()
      for (const id of ids) live.add(id)
      publishLivePaneIds(ids)
    },
    dispose: () => {
      release()
      panes.dispose()
      refresh.dispose()
      urls.dispose()
      term.dispose()
      host.remove()
      vi.restoreAllMocks()
    },
  }
}

afterEach(() => {
  live.clear()
  publishLivePaneIds([])
  reveal.mockClear()
  notifyGone.mockClear()
  document.querySelectorAll('[data-pane-link-tip]').forEach((element) => element.remove())
})

const NAME = { x: 5, y: 1 } // `go wZ3:p1 now` 의 이름 칸
const SAME_ROW_ELSEWHERE = { x: 30, y: 1 }

describe('양성 대조', () => {
  it('살아 있는 이름 hover → 밑줄·툴팁, ⌘+클릭 → 이동 1', async () => {
    const h = harness()
    h.setLive(['wZ3:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    expect(h.current()).toBe('wZ3:p1')
    expect(h.tip()).toBe('wt · tab · pane 1⌘+클릭으로 이동')
    h.click(NAME)
    expect(reveal.mock.calls).toEqual([['wZ3:p1']])
    expect(h.opened).toEqual([])
    h.dispose()
  })
})

describe('D5 — URL·OSC 8 안의 이름은 URL 이 이긴다 (실제 Linkifier, r1 E②)', () => {
  it('평문 URL 안 이름 ⌘+클릭 → URL 열림 1 · 이동 0 · 툴팁 0', async () => {
    const h = harness()
    h.setLive(['wZ3:p1'])
    await h.write('\x1b[1;1Hsee https://example.com/a/wZ3:p1 ok')
    const onName = { x: 32, y: 1 } // `wZ3:p1` 글자 위
    h.move(onName)
    expect(h.current()).toBe('https://example.com/a/wZ3:p1')
    expect(h.tip()).toBeNull()
    h.click(onName)
    expect(h.opened).toEqual(['https://example.com/a/wZ3:p1'])
    expect(reveal).not.toHaveBeenCalled()
    h.dispose()
  })

  it('OSC 8 링크 글자가 이름이면 OSC 8 이 이긴다 → 그 URI 열림 1 · 이동 0', async () => {
    const h = harness()
    h.setLive(['wZ3:p1'])
    await h.write('\x1b[1;1Hgo \x1b]8;;https://example.com/osc\x07wZ3:p1\x1b]8;;\x07 now')
    h.move(NAME)
    expect(h.current()).toBe('https://example.com/osc')
    h.click(NAME)
    expect(h.opened).toEqual(['https://example.com/osc'])
    expect(reveal).not.toHaveBeenCalled()
    h.dispose()
  })
})

describe('C3ⓓ — 요청 없이 상태가 오갔다 (실제 Linkifier, r1 E④)', () => {
  it('포인터 정지 → 집합에서 빠짐 → 밑줄·툴팁 0 (mousemove 없이)', async () => {
    const h = harness()
    h.setLive(['wZ3:p1', 'wZ4:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    expect(h.current()).toBe('wZ3:p1')
    expect(h.tip()).not.toBeNull()
    h.setLive(['wZ4:p1'])
    expect(h.current()).toBeNull()
    expect(h.tip()).toBeNull()
    h.dispose()
  })

  it('포인터 정지 → 집합에 생김(늦은 상태) → 밑줄 (툴팁도 같은 갱신에)', async () => {
    const h = harness()
    h.setLive(['wZ4:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    expect(h.current()).toBeNull()
    h.setLive(['wZ4:p1', 'wZ3:p1'])
    expect(h.current()).toBe('wZ3:p1')
    expect(h.tip()).not.toBeNull()
    h.dispose()
  })

  it('같은 행 안에서 벗어났다 돌아옴 — 그 사이 닫혔으면 밑줄 0 (낡은 행 캐시 안 씀)', async () => {
    const h = harness()
    h.setLive(['wZ3:p1', 'wZ4:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    h.move(SAME_ROW_ELSEWHERE)
    h.setLive(['wZ4:p1'])
    h.move(NAME)
    expect(h.current()).toBeNull()
    expect(h.tip()).toBeNull()
    h.dispose()
  })

  it('같은 행 안에서 벗어났다 돌아옴 — 그 사이 살아났으면 밑줄', async () => {
    const h = harness()
    h.setLive(['wZ4:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    h.move(SAME_ROW_ELSEWHERE)
    h.setLive(['wZ4:p1', 'wZ3:p1'])
    h.move(NAME)
    expect(h.current()).toBe('wZ3:p1')
    h.dispose()
  })

  it('다른 행에서 돌아옴 — 닫혔으면 밑줄 0', async () => {
    const h = harness()
    h.setLive(['wZ3:p1', 'wZ4:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    h.move({ x: 5, y: 3 })
    h.setLive(['wZ4:p1'])
    h.move(NAME)
    expect(h.current()).toBeNull()
    h.dispose()
  })

  it('집합이 그대로인 발행은 재평가를 부르지 않는다 · 바뀐 발행은 1회', async () => {
    const h = harness()
    h.setLive(['wZ3:p1'])
    expect(publishLivePaneIds(['wZ3:p1'])).toBe(false)
    expect(publishLivePaneIds(['wZ3:p1', 'wZ4:p1'])).toBe(true)
    expect(publishLivePaneIds(['wZ4:p1', 'wZ3:p1'])).toBe(false) // 순서만 다름
    h.dispose()
  })

  it('포인터가 밖이면 재평가는 provider 를 묻지 않는다', async () => {
    const h = harness()
    h.setLive(['wZ3:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    h.leave()
    const lookups = vi.fn()
    const release = setPaneLinkDirectory({
      lookup: (paneId) => {
        lookups(paneId)
        return null
      },
      reveal,
      notifyGone,
    })
    h.setLive(['wZ4:p1'])
    expect(lookups).not.toHaveBeenCalled()
    release()
    h.dispose()
  })
})

describe('툴팁 유지 — 재평가에서 같은 이름이 다시 잡히면 같은 요소 (r2 H)', () => {
  it('무관한 pane 이 닫히거나 생겨도 포인터 아래 툴팁 요소는 그대로(새 진입 애니메이션 없음)', async () => {
    const h = harness()
    h.setLive(['wZ3:p1', 'wZ4:p1', 'wZ5:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    const before = document.querySelector('[data-pane-link-tip]')
    expect(before).not.toBeNull()
    h.setLive(['wZ3:p1', 'wZ4:p1']) // 무관한 것이 닫힘
    expect(h.current()).toBe('wZ3:p1')
    expect(document.querySelectorAll('[data-pane-link-tip]')).toHaveLength(1)
    expect(document.querySelector('[data-pane-link-tip]')).toBe(before)
    expect(before?.isConnected).toBe(true)
    h.setLive(['wZ3:p1', 'wZ4:p1', 'wZ6:p1']) // 무관한 것이 생김
    expect(document.querySelector('[data-pane-link-tip]')).toBe(before)
    h.dispose()
  })

  it('그 이름이 빠지면 지금처럼 걷는다', async () => {
    const h = harness()
    h.setLive(['wZ3:p1', 'wZ4:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    const before = document.querySelector('[data-pane-link-tip]')
    h.setLive(['wZ4:p1'])
    expect(h.tip()).toBeNull()
    expect(before?.isConnected).toBe(false)
    h.dispose()
  })
})

describe('C3ⓑ (r2 정정) — 밑줄이 걷힌 뒤 같은 칸 ⌘+클릭은 이동 0·안내 0', () => {
  it('hover → 집합에서 빠짐(밑줄 걷힘) → 같은 칸 ⌘+클릭 → reveal 0 · notifyGone 0 · URL 열림 0', async () => {
    const h = harness()
    h.setLive(['wZ3:p1', 'wZ4:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    expect(h.current()).toBe('wZ3:p1')
    h.setLive(['wZ4:p1'])
    expect(h.current()).toBeNull()
    h.click(NAME)
    expect(reveal).not.toHaveBeenCalled()
    expect(notifyGone).not.toHaveBeenCalled()
    expect(h.opened).toEqual([])
    h.dispose()
  })
})

describe('변이 대조 — 재평가를 끄면 C3ⓓ 장면이 실패한다 (판별력)', () => {
  it('재평가 없는 배선: 포인터 정지 + 집합에서 빠짐 → 밑줄이 남는다', async () => {
    const h = harness({ refresh: false })
    h.setLive(['wZ3:p1', 'wZ4:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    h.setLive(['wZ4:p1'])
    expect(h.current()).toBe('wZ3:p1')
    h.dispose()
  })

  it('재평가 없는 배선: 같은 행 복귀가 낡은 캐시로 밑줄을 되살린다', async () => {
    const h = harness({ refresh: false })
    h.setLive(['wZ3:p1', 'wZ4:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    h.move(SAME_ROW_ELSEWHERE)
    h.setLive(['wZ4:p1'])
    h.move(NAME)
    expect(h.current()).toBe('wZ3:p1')
    h.dispose()
  })
})

describe('툴팁 닫기 (C4ⓑ, r1 C)', () => {
  it('수식키 단독은 닫지 않고, 다른 키·창 blur 에는 닫는다', async () => {
    const h = harness()
    h.setLive(['wZ3:p1'])
    await h.write('\x1b[1;1Hgo wZ3:p1 now')
    h.move(NAME)
    expect(h.tip()).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta' }))
    expect(h.tip()).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(h.tip()).toBeNull()
    h.move({ x: 30, y: 2 })
    h.move(NAME)
    expect(h.tip()).not.toBeNull()
    window.dispatchEvent(new Event('blur'))
    expect(h.tip()).toBeNull()
    h.dispose()
  })
})
