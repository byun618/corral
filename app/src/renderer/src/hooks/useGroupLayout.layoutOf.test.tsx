// @vitest-environment happy-dom
// LIFE-495 fix2 R2-02 — 활성이 아닌 worktree 의 배치(다시 열기 스냅샷 자리)는 화면과 같은 파생(살아 있는 탭 reconcile + 핀 partition)을 거친 순서다.
// 실제 `useGroupLayout`. 메뉴 mousedown 의 `setActiveGroup`(핀을 바꾸기 **전** 순서를 저장)까지 밟는다(Codex r2 재현과 같은 걸음).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { groupOfTab } from '../group-tree.js'
import { useGroupLayout, type GroupLayoutApi } from './useGroupLayout.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let api: GroupLayoutApi | null = null
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Reflect.set(window, 'corral', { setUiPrefs: vi.fn() })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function Harness(props: { worktreePath: string; liveTabIds: string[]; pinned: string[] }): null {
  api = useGroupLayout({ worktreePath: props.worktreePath, liveTabIds: props.liveTabIds, ready: true, stored: [], pinned: new Set(props.pinned), herdrTabIds: null })
  return null
}
const show = (props: { worktreePath: string; liveTabIds: string[]; pinned: string[] }): void => act(() => root.render(createElement(Harness, props)))
const current = (): GroupLayoutApi => {
  if (api === null) throw new Error('훅이 아직 안 돌았다')
  return api
}

it('fix2 R2-02 B 에서 b2 를 고정하고 A 로 옮긴 뒤 — B 의 배치는 화면 순서 [b2,b0,b1], 그 자리(0)로 다시 열린다', () => {
  show({ worktreePath: '/B', liveTabIds: ['b0', 'b1', 'b2'], pinned: [] })
  act(() => current().setActiveGroup('g1')) // 메뉴 mousedown → 영역 활성(핀 바꾸기 전 순서를 저장)
  show({ worktreePath: '/B', liveTabIds: ['b0', 'b1', 'b2'], pinned: ['b2'] })
  expect(current().groups[0]?.tabOrder).toEqual(['b2', 'b0', 'b1'])
  show({ worktreePath: '/A', liveTabIds: ['a0'], pinned: ['b2'] })
  const inactive = current().layoutOf({ worktreePath: '/B', liveTabIds: ['b0', 'b1', 'b2'], pinned: new Set(['b2']) })
  const group = inactive === null ? null : groupOfTab(inactive.root, 'b2')
  expect(group?.tabOrder).toEqual(['b2', 'b0', 'b1'])
  const index = group?.tabOrder.indexOf('b2') ?? -1
  expect(index).toBe(0)
  // 닫은 뒤(핀 해제) B 로 돌아와 새 셸이 오면 그 자리에 놓는다.
  show({ worktreePath: '/B', liveTabIds: ['b0', 'b1', 'reopened'], pinned: [] })
  act(() => current().placeTab({ tabId: 'reopened', groupId: group?.groupId ?? 'g1', index }))
  expect(current().groups[0]?.tabOrder).toEqual(['reopened', 'b0', 'b1'])
})

it('fix2 R2-02 저장된 배치가 없는 비활성 worktree 도 살아 있는 탭 순서로 배치를 준다(스냅샷이 빠지지 않는다)', () => {
  show({ worktreePath: '/A', liveTabIds: ['a0'], pinned: [] })
  const inactive = current().layoutOf({ worktreePath: '/C', liveTabIds: ['c0', 'c1'], pinned: new Set(['c1']) })
  expect(inactive === null ? null : groupOfTab(inactive.root, 'c0')?.tabOrder).toEqual(['c1', 'c0'])
})
