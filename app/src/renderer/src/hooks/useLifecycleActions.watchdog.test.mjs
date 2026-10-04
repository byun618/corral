// @vitest-environment happy-dom
// LIFE-496 K1ⓔ 기동 워치독 — `launchAgent` 의 응답과 state push 의 순서 (리뷰 r1 R1-04).
// main `createRowInWorkspace` 는 push 와 IPC 응답의 순서를 보장하지 않는다. 그래서 응답보다 먼저 도착한 감지도 성공으로 세야 한다.
// AppState 는 큰 타입이라 이 파일은 .mjs 로 둔다(테스트 자료에 `as` 를 쓰지 않으려고) — 훅이 읽는 칸(repos·workspace·tabs·panes)만 채운다.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LAUNCH_WATCHDOG_MS } from '../tab-create-menu.js'
import { useLifecycleActions } from './useLifecycleActions.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

/** pane `p` 하나가 든 탭 `t` — agent 가 undefined 면 아직 탭이 없다. */
const stateWith = (agent) => ({
  home: '/h',
  repos: [{
    root: '/r',
    worktrees: [{
      path: '/r',
      workspace: {
        workspaceId: 'w', focused: true,
        tabs: agent === undefined ? [] : [{ tabId: 't', workspaceId: 'w', focused: true, panes: [{ paneId: 'p', tabId: 't', workspaceId: 'w', agent, focused: true }] }],
      },
    }],
  }],
})

let host
let root
let hook = null
let resolveCreate = () => {}

function Harness({ state }) {
  hook = useLifecycleActions(state)
  return null
}
const render = (state) => act(() => root.render(createElement(Harness, { state })))

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Reflect.set(window, 'corral', {
    createRow: () => new Promise((resolve) => {
      resolveCreate = resolve
    }),
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('launchAgent 워치독 — 응답과 감지의 순서 (R1-04)', () => {
  it('응답보다 먼저 감지가 도착하고 곧 나가도 성공이다 — 10초 뒤 실패 알림이 없다', async () => {
    render(stateWith(undefined))
    act(() => hook.actions.launchAgent({ workspaceId: 'w', kind: 'claude', label: 'Claude' }))
    render(stateWith('claude'))
    await act(async () => resolveCreate({ ok: true, paneId: 'p', tabId: 't', error: null }))
    render(stateWith(null))
    act(() => vi.advanceTimersByTime(LAUNCH_WATCHDOG_MS + 100))
    expect(hook.lifecycleNotice).toBeNull()
  })

  it('응답 시점의 최신 state 에 이미 감지가 있으면 타이머를 걸지 않는다', async () => {
    render(stateWith(undefined))
    act(() => hook.actions.launchAgent({ workspaceId: 'w', kind: 'claude', label: 'Claude' }))
    render(stateWith('claude'))
    await act(async () => resolveCreate({ ok: true, paneId: 'p', tabId: 't', error: null }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('응답 전에 감지됐다가 응답 전에 사라져도 성공이다 — 감지→소멸→응답 (R2-01)', async () => {
    render(stateWith(undefined))
    act(() => hook.actions.launchAgent({ workspaceId: 'w', kind: 'claude', label: 'Claude' }))
    render(stateWith('claude'))
    render(stateWith(null))
    await act(async () => resolveCreate({ ok: true, paneId: 'p', tabId: 't', error: null }))
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(LAUNCH_WATCHDOG_MS + 100))
    expect(hook.lifecycleNotice).toBeNull()
  })

  it('대조: 감지가 끝내 오지 않으면 10초 뒤 알린다', async () => {
    render(stateWith(undefined))
    act(() => hook.actions.launchAgent({ workspaceId: 'w', kind: 'claude', label: 'Claude' }))
    render(stateWith(null))
    await act(async () => resolveCreate({ ok: true, paneId: 'p', tabId: 't', error: null }))
    act(() => vi.advanceTimersByTime(LAUNCH_WATCHDOG_MS + 100))
    expect(hook.lifecycleNotice?.message).toContain('Claude 실행 실패')
  })

  it('대조: 등록 뒤에 감지가 오면 성공이다', async () => {
    render(stateWith(undefined))
    act(() => hook.actions.launchAgent({ workspaceId: 'w', kind: 'claude', label: 'Claude' }))
    render(stateWith(null))
    await act(async () => resolveCreate({ ok: true, paneId: 'p', tabId: 't', error: null }))
    render(stateWith('claude'))
    render(stateWith(null))
    act(() => vi.advanceTimersByTime(LAUNCH_WATCHDOG_MS + 100))
    expect(hook.lifecycleNotice).toBeNull()
  })
})
