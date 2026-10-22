// @vitest-environment happy-dom
/* global document, window -- happy-dom 환경 */
// LIFE-508 — 선택 pane 이 닫히면(분할 pane ⌘W) 그 탭에 남은 pane 으로 승격한다(화면 = 그 탭의 `pickPane`). 워크스페이스 전체의 herdr 포커스
// (다른 탭의 pane)로 가면 MRU 맨 앞이 화면의 pane 이 아니게 된다 — 격리 before 재현 `raw/claude/before/k2-iso-3.txt`(p1* 이 다른 탭).
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useLifecycleActions } from './useLifecycleActions.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const pane = (paneId, tabId, focused = false) => ({ paneId, tabId, workspaceId: 'w1', focused })
const tab = (tabId, panes) => ({ tabId, workspaceId: 'w1', panes })
/** w1(focused) — 탭 t1(p1, herdr 포커스) · t2(p2) · t3(분할 p3 + p4). `closed` 에 든 pane 은 뺀다. */
const stateOf = (closed = []) => ({
  home: '/h',
  repos: [{
    root: '/r',
    worktrees: [{
      path: '/r', isLinked: false, openWorkspaceId: 'w1',
      workspace: {
        workspaceId: 'w1', focused: true,
        tabs: [tab('t1', [pane('p1', 't1', true)]), tab('t2', [pane('p2', 't2')]), tab('t3', [pane('p3', 't3'), pane('p4', 't3')].filter((row) => !closed.includes(row.paneId)))].filter((row) => row.panes.length > 0),
      },
    }],
  }],
})

let host
let root
let hook = null
function Harness({ state }) {
  hook = useLifecycleActions(state)
  return null
}
const push = (state) => act(() => root.render(createElement(Harness, { state })))

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Reflect.set(window, 'corral', {})
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('닫힌 선택 pane 의 승격 (LIFE-508)', () => {
  it('분할 pane(p4)을 닫으면 같은 탭의 p3 — 다른 탭의 herdr 포커스(p1)가 아니다', () => {
    push(stateOf())
    act(() => hook.selectPane('p4'))
    push(stateOf())
    expect(hook.selectedPane).toBe('p4')
    push(stateOf(['p4']))
    expect(hook.selectedPane).toBe('p3')
  })
  it('그 탭이 통째로 없어지면 예전 규칙(herdr 포커스 → 첫 pane)', () => {
    push(stateOf())
    act(() => hook.selectPane('p4'))
    push(stateOf())
    push(stateOf(['p3', 'p4']))
    expect(hook.selectedPane).toBe('p1')
  })
  it('처음 떴을 때(선택 없음)는 예전 규칙 그대로 — herdr 포커스 pane', () => {
    push(stateOf())
    expect(hook.selectedPane).toBe('p1')
  })
})

describe('탭째 닫힌 선택 pane 은 화면이 보이는 탭으로 (LIFE-691 K2ⓑ)', () => {
  it('t3 을 닫으면 화면의 새 활성 탭(t2)의 pane — herdr 포커스(p1, 다른 탭)가 아니다', () => {
    push(stateOf())
    act(() => hook.selectPane('p4'))
    push(stateOf())
    hook.shownTabRef.current = 't2'
    push(stateOf(['p3', 'p4']))
    expect(hook.selectedPane).toBe('p2')
  })
  it('같은 탭 pane 이 남으면 LIFE-508 그대로 — 화면 탭보다 같은 탭', () => {
    push(stateOf())
    act(() => hook.selectPane('p4'))
    push(stateOf())
    hook.shownTabRef.current = 't2'
    push(stateOf(['p4']))
    expect(hook.selectedPane).toBe('p3')
  })
  it('화면 탭이 파일 탭(null)이면 예전 규칙(herdr 포커스)', () => {
    push(stateOf())
    act(() => hook.selectPane('p4'))
    push(stateOf())
    hook.shownTabRef.current = null
    push(stateOf(['p3', 'p4']))
    expect(hook.selectedPane).toBe('p1')
  })
})
