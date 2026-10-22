// @vitest-environment happy-dom
// LIFE-691 R3·K5 — 실제 `useGroupLayout` 에서 영역별 탭 MRU 가 `mutate` 한 자리에서 기록되고, 저장(`setUiPrefs`)에는 실리지 않는다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useGroupLayout, type GroupLayoutApi } from './useGroupLayout.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let api: GroupLayoutApi | null = null
const setUiPrefs = vi.fn()
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setUiPrefs.mockClear()
  Reflect.set(window, 'corral', { setUiPrefs })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const stored = [{ worktreePath: '/r', layoutFormat: 2, layout: { activeGroupId: 'g1', root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['w1:a', 'w1:b', 'w1:c', 'w1:d'], activeTabId: 'w1:a' } } } }]
function Harness(props: { liveTabIds: string[]; pinned?: string[]; saved?: unknown[]; herdrTabIds?: string[] }): null {
  api = useGroupLayout({ worktreePath: '/r', liveTabIds: props.liveTabIds, ready: true, stored: props.saved ?? stored, pinned: new Set(props.pinned ?? []), herdrTabIds: props.herdrTabIds ?? null })
  return null
}
const show = (liveTabIds: string[]): void => act(() => root.render(createElement(Harness, { liveTabIds })))
const current = (): GroupLayoutApi => {
  if (api === null) throw new Error('훅이 아직 안 돌았다')
  return api
}
const active = (): string | null => current().groups[0]?.activeTabId ?? null

it('[A,B,C,D] B → D 방문 뒤 D(터미널) 닫기 = B — 클릭(setActiveTab)이 MRU 를 기록한다', () => {
  show(['w1:a', 'w1:b', 'w1:c', 'w1:d'])
  act(() => current().setActiveTab({ groupId: 'g1', tabId: 'w1:b' }))
  act(() => current().setActiveTab({ groupId: 'g1', tabId: 'w1:d' }))
  show(['w1:a', 'w1:b', 'w1:c'])
  expect(active()).toBe('w1:b')
})

it('재기동 직후(저장값 활성 A) 다른 탭 하나 방문 뒤 닫으면 A — 바꾸기 전 활성도 MRU 에 든다', () => {
  show(['w1:a', 'w1:b', 'w1:c', 'w1:d'])
  act(() => current().revealTab('w1:c'))
  show(['w1:a', 'w1:b', 'w1:d'])
  expect(active()).toBe('w1:a')
})

it('MRU 없이(재기동 직후, 저장값 활성 A) A 닫기 = 오른쪽 이웃', () => {
  show(['w1:a', 'w1:b', 'w1:c', 'w1:d'])
  show(['w1:b', 'w1:c', 'w1:d'])
  expect(active()).toBe('w1:b')
})

it('K5 — 저장 JSON 에 recentTabIds 가 없다(LAYOUT_FORMAT 2 그대로)', () => {
  show(['w1:a', 'w1:b', 'w1:c', 'w1:d'])
  act(() => current().setActiveTab({ groupId: 'g1', tabId: 'w1:b' }))
  act(() => current().setActiveTab({ groupId: 'g1', tabId: 'w1:c' }))
  const last = setUiPrefs.mock.calls.at(-1)?.[0]
  const json = JSON.stringify(last)
  console.log(`K5 setUiPrefs 덤프: ${json}`)
  expect(json).toContain('"layoutFormat":2')
  expect(json).toContain('"activeTabId":"w1:c"')
  expect(json).not.toContain('recentTabIds')
})

// f1 B — 핀으로 화면 순서 ≠ 저장 순서. 저장값 [A,B,C,D] 활성 D(MRU 없음 = 재기동 직후), 핀 C → 화면 [C*,A,B,D].
const savedD = [{ worktreePath: '/r', layoutFormat: 2, layout: { activeGroupId: 'g1', root: { kind: 'leaf', group: { groupId: 'g1', tabOrder: ['w1:a', 'w1:b', 'w1:c', 'w1:d'], activeTabId: 'w1:d' } } } }]
const showPinned = (props: { liveTabIds: string[]; herdrTabIds?: string[] }): void =>
  act(() => root.render(createElement(Harness, { ...props, pinned: ['w1:c'], saved: savedD })))

it('f1 B — 화면 [C*,A,B,D] 활성 D(터미널) 닫기 = 화면 왼쪽 B (화면 파생 shownLayout 경로)', () => {
  showPinned({ liveTabIds: ['w1:a', 'w1:b', 'w1:c', 'w1:d'] })
  expect(current().groups[0]?.tabOrder).toEqual(['w1:c', 'w1:a', 'w1:b', 'w1:d'])
  showPinned({ liveTabIds: ['w1:a', 'w1:b', 'w1:c'] })
  expect(active()).toBe('w1:b')
})

it('f1 B — 같은 닫기가 herdr 전체 목록으로 저장 배치에서 걷혀도(dropDeadTabs 경로) B', () => {
  showPinned({ liveTabIds: ['w1:a', 'w1:b', 'w1:c', 'w1:d'], herdrTabIds: ['w1:a', 'w1:b', 'w1:c', 'w1:d'] })
  showPinned({ liveTabIds: ['w1:a', 'w1:b', 'w1:c'], herdrTabIds: ['w1:a', 'w1:b', 'w1:c'] })
  expect(active()).toBe('w1:b')
})
