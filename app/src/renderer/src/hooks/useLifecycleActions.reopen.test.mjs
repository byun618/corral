// @vitest-environment happy-dom
// LIFE-495 fix1 미확인 부기 — 다시 열기(⌘⇧T)의 만들기가 실패하면 `onFailed`(App 이 꺼낸 기록을 되돌린다), 성공하면 `onTab`.
// 지연 IPC: 두 요청이 겹쳐도 각 요청은 자기 콜백만 부른다. AppState 는 큰 타입이라 .mjs(watchdog 테스트와 같다).
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useLifecycleActions } from './useLifecycleActions.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const state = { home: '/h', repos: [{ root: '/r', worktrees: [{ path: '/r', workspace: { workspaceId: 'w', focused: true, tabs: [] } }] }] }
let host
let root
let hook = null
const resolvers = []
function Harness() {
  hook = useLifecycleActions(state)
  return null
}
beforeEach(() => {
  resolvers.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Reflect.set(window, 'corral', { createRow: () => new Promise((resolve) => resolvers.push(resolve)) })
  act(() => root.render(createElement(Harness)))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('reopenTab — 실패·지연 IPC (fix1)', () => {
  it('만들기 실패 → onFailed 한 번, onTab 없음', async () => {
    const calls = []
    act(() => hook.actions.reopenTab({ workspaceId: 'w', cwd: '/r/sub', label: 'x', onTab: (tabId) => calls.push(`tab:${tabId}`), onFailed: () => calls.push('failed') }))
    await act(async () => resolvers[0]({ ok: false, error: 'herdr down', tabId: null, paneId: null }))
    expect(calls).toEqual(['failed'])
  })
  it('겹친 두 요청이 거꾸로 끝나도 각자 자기 탭 id 로', async () => {
    const calls = []
    act(() => hook.actions.reopenTab({ workspaceId: 'w', cwd: null, label: 'a', onTab: (tabId) => calls.push(`a:${tabId}`), onFailed: () => calls.push('a:failed') }))
    act(() => hook.actions.reopenTab({ workspaceId: 'w', cwd: null, label: 'b', onTab: (tabId) => calls.push(`b:${tabId}`), onFailed: () => calls.push('b:failed') }))
    await act(async () => resolvers[1]({ ok: true, tabId: 'tB', paneId: 'pB' }))
    await act(async () => resolvers[0]({ ok: true, tabId: 'tA', paneId: 'pA' }))
    expect(calls).toEqual(['b:tB', 'a:tA'])
  })
})
