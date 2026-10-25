// @vitest-environment happy-dom
// LIFE-696 C5 — 「닫힌 탭」 행의 hover ✕ (compact `SessionRow` · full `AgentFullRow`). 시간 칸과 한 자리, aria-label, 확인 대화 없음,
// 누르면 새 IPC(`dismissRetained`)로 그 paneId 만 보낸다 · 행 활성화로 번지지 않는다 · live·서브에이전트 행에는 ✕ 가 생기지 않는다.
// 걷은 뒤 DOM·공급에서 빠지는 것은 main store(`retention.test.ts` C5)·폰 목록(`list-694.test.ts`)이 맡고, 안 읽음 장부는 아래 ⓓ.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRowNode } from '../sidebar-agents.js'
import { EMPTY_UNREAD, ingest, type PaneObservation } from '../unread.js'
import { AgentFullRow } from './AgentFullRow.js'
import { SessionRow } from './SessionRow.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
const dismissRetained = vi.fn(async (input: { paneId: string }) => input.paneId.length > 0)

beforeEach(() => {
  dismissRetained.mockClear()
  Reflect.set(window, 'corral', { dismissRetained })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'corral')
})

function node(source: AgentRowNode['source'], paneId: string): AgentRowNode {
  return {
    key: source === 'retained' ? `retained:${paneId}` : paneId, source, paneId, tabId: 't1',
    // 산 보존 행(pane 이 다른 자리로 옮겨 살아 있음 — B2)이라 클릭하면 활성화가 일어나는 행으로 둔다(ⓖ 의 양성 대조).
    activationPaneId: paneId, kind: 'claude', showIcon: source !== 'subagent', dot: 'done', unseenDone: false,
    text: { leading: 'job', trailing: '닫힌 탭', full: 'job - 닫힌 탭' },
    full: { label: 'job', tool: { kind: 'none' }, interrupted: false, message: '닫힌 탭' },
    model: null, timeAt: 0, children: [],
  }
}

type Variant = 'compact' | 'full'
function mount(input: { variant: Variant; rows: AgentRowNode[]; onActivate: (paneId: string) => void; onClose: (paneId: string) => void }): void {
  act(() =>
    root.render(
      createElement(
        'div',
        null,
        ...input.rows.map((row) =>
          createElement(input.variant === 'compact' ? SessionRow : AgentFullRow, {
            key: row.key, node: row, now: 5 * 60_000, focused: false, child: row.source === 'subagent', disclosure: null, reserveGutter: false,
            onActivate: input.onActivate, onClose: input.onClose,
          }),
        ),
      ),
    ),
  )
}

const rowOf = (key: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(`[data-agent-row="${key}"]`)
  if (found === null) throw new Error(`행 없음: ${key}`)
  return found
}

describe.each<Variant>(['compact', 'full'])('보존 행 ✕ — %s 행', (variant) => {
  it('ⓐ 보존 행에만 ✕ — aria-label 있음, 시간 칸과 한 자리(hover 때 시간이 비켜 서고 ✕ 가 선다)', () => {
    mount({ variant, rows: [node('live', 'p1'), node('subagent', 'p2'), node('retained', 'p3')], onActivate: () => {}, onClose: () => {} })
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-dismiss-retained]')]
    expect(buttons.map((button) => button.dataset['dismissRetained'])).toEqual(['p3'])
    const button = buttons[0]!
    expect(button.getAttribute('aria-label')).toBe('닫힌 탭 걷기')
    // ⓒ live 의 기존 닫기 버튼은 그대로, 서브에이전트 행에는 닫기·걷기 둘 다 없다.
    expect(rowOf('p1').querySelector('[data-close-pane="p1"]')).not.toBeNull()
    expect(rowOf('p2').querySelector('button[data-close-pane], button[data-dismiss-retained]')).toBeNull()
    // 시간과 ✕ 가 같은 부모 칸에 있다.
    const time = rowOf('retained:p3').querySelector<HTMLElement>('[data-elapsed]')
    expect(time).not.toBeNull()
    expect(time?.parentElement).toBe(button.parentElement)
    expect(button.classList.contains('is-active')).toBe(false)
    act(() => rowOf('retained:p3').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(button.classList.contains('is-active')).toBe(true)
    expect(time?.classList.contains('is-hidden')).toBe(true)
  })

  it('ⓑ 누르면 그 paneId 로 IPC 한 번 · 확인 대화 없음 · ⓖ 행 활성화·닫기로 번지지 않는다', () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    mount({ variant, rows: [node('retained', 'p3'), node('retained', 'p4')], onActivate, onClose })
    // 양성 대조 — 행 자체를 누르면 활성화가 일어난다.
    act(() => rowOf('retained:p4').click())
    expect(onActivate).toHaveBeenCalledExactlyOnceWith('p4')
    onActivate.mockClear()
    act(() => host.querySelector<HTMLButtonElement>('[data-dismiss-retained="p3"]')!.click())
    expect(dismissRetained).toHaveBeenCalledExactlyOnceWith({ paneId: 'p3' })
    expect(onActivate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(host.querySelector('[role="dialog"], .modal')).toBeNull()
  })
})

describe('ⓓ 걷은 pane 의 안 읽음은 장부에서 빠진다', () => {
  it('보존 목록에 있는 동안은 남고, 걷어 목록에서 빠지면 지워진다', () => {
    const repos = [{ root: '/r', error: false, worktreePaths: ['/r/a'] }]
    const done: PaneObservation = { paneId: 'p1', worktreePath: '/r/a', status: 'done', enteredAt: 200, history: [{ status: 'working', enteredAt: 100 }], agent: null, sessionKey: null, promptSeen: false, judgeable: false }
    const step = (panes: PaneObservation[], retained: string[], model = EMPTY_UNREAD) =>
      ingest(model, { panes, retainedPaneIds: new Set(retained), repos, activeWorktree: null, attentive: false, watched: null })
    let model = step([{ ...done, status: 'working', enteredAt: 100, history: [] }], [])
    model = step([done], [], model)
    expect([...model.panes.keys()]).toEqual(['p1'])
    model = step([], ['p1'], model) // 탭이 닫혀 보존 행이 됨 — 안 읽음 유지
    expect([...model.panes.keys()]).toEqual(['p1'])
    model = step([], [], model) // ✕ 로 걷음 — 공급에서 빠짐
    expect([...model.panes.keys()]).toEqual([])
  })
})
