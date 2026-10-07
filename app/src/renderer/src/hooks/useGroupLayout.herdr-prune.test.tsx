// @vitest-environment happy-dom
// LIFE-507 K1ⓔ — 저장 배치에서 herdr 세션 전체에 없는 탭을 걷는다(실제 `useGroupLayout`). 닫힌 워크스페이스의 탭만 든 worktree 배치는 버려지고
// 저장(`setUiPrefs({ groupLayouts })`)에도 빠진다. `herdrTabIds` 가 null(링크 live 아님)이면 손대지 않는다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { splitGroup, singleLayout } from '../group-tree.js'
import { useGroupLayout } from './useGroupLayout.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let saves: unknown[] = []
const stored = [
  { worktreePath: '/P', layout: singleLayout({ groupId: 'g1', tabOrder: ['w1:t1'], activeTabId: 'w1:t1' }) },
  { worktreePath: '/Q', layout: splitGroup({ layout: singleLayout({ groupId: 'g1', tabOrder: ['w2:t3', 'w2:t4'], activeTabId: 'w2:t3' }), groupId: 'g1', tabId: 'w2:t4', direction: 'row', newGroupId: 'g2' }) },
]
beforeEach(() => {
  saves = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Reflect.set(window, 'corral', { setUiPrefs: vi.fn((patch: { groupLayouts?: unknown }) => saves.push(patch.groupLayouts)) })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function Harness(props: { herdrTabIds: string[] | null; worktreePath: string; liveTabIds: string[] }): null {
  useGroupLayout({ worktreePath: props.worktreePath, liveTabIds: props.liveTabIds, ready: true, stored, pinned: new Set(), herdrTabIds: props.herdrTabIds })
  return null
}
const show = (props: { herdrTabIds: string[] | null; worktreePath: string; liveTabIds: string[] }): void => act(() => root.render(createElement(Harness, props)))
const savedPaths = (): string[] | null => {
  const last = saves.at(-1)
  return Array.isArray(last) ? last.map((row: { worktreePath: string }) => row.worktreePath) : null
}

it('링크 live 아님(null) — 저장 배치를 손대지 않는다(싣은 값 그대로 — 싣기 뒤 한 번 쓰는 것은 예전 동작)', () => {
  show({ herdrTabIds: null, worktreePath: '/P', liveTabIds: ['w1:t1'] })
  expect(savedPaths()).toEqual(['/P', '/Q'])
})
it('닫힌 워크스페이스(w2)의 탭만 든 /Q 배치는 버려지고 저장에서 빠진다 — /P 는 그대로', () => {
  show({ herdrTabIds: ['w1:t1'], worktreePath: '/P', liveTabIds: ['w1:t1'] })
  expect(savedPaths()).toEqual(['/P'])
})
it('K1ⓒ 잔여 고정 — corral 이 꺼진 동안 닫힘·재기동·id 재사용이 다 일어나면, 새로 뜬 훅은 새 w2:t3·t4 를 옛 배치의 탭과 가릴 수 없다(2 영역)', () => {
  let groups = 0
  function Probe(): null {
    groups = useGroupLayout({ worktreePath: '/Q', liveTabIds: ['w2:t1', 'w2:t2', 'w2:t3', 'w2:t4'], ready: true, stored, pinned: new Set(), herdrTabIds: ['w1:t1', 'w2:t1', 'w2:t2', 'w2:t3', 'w2:t4'] }).groups.length
    return null
  }
  // 새 인스턴스(= corral 을 새로 띄움)가 싣자마자 본 herdr 목록에 새 w2:t3·t4 가 **있으면** 옛 배치의 id 와 겹쳐 걷히지 않는다 — 걷기는
  // 「닫힌 뒤 corral 이 한 번이라도 live 목록을 본 때」 일어나야 한다(앱 시나리오 k1 은 corral 실행 중 닫는다). 이 칸은 그 한계를 고정한다.
  act(() => root.render(createElement(Probe)))
  expect(groups).toBe(2)
})
