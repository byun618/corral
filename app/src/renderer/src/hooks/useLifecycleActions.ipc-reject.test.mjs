// @vitest-environment happy-dom
/* global window, document, process, setTimeout */
// LIFE-524 — 닫기 IPC 자체가 reject 하면(transport 오류 — 구조화된 결과가 아니다) unhandled rejection 이 없고, 알림이 뜨고,
// 확인 뒤 닫기였으면 확인창이 풀려 같은 탭 닫기를 다시 시도할 수 있다(재시도가 IPC 까지 간다). 516 codex-r2 「세부 확인 및 한계」 의 합성 reject 재현.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useLifecycleActions } from './useLifecycleActions.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const state = { home: '/h', repos: [] }
let host
let root
let hook = null
/** IPC 호출마다 한 줄 — 테스트가 resolve/reject 를 고른다. */
const calls = []
const unhandled = []
const onUnhandled = (reason) => unhandled.push(reason)
function Harness() {
  hook = useLifecycleActions(state)
  return null
}
const defer = () => {
  let resolve = () => {}
  let reject = () => {}
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
/** act 안에서 돌리고 마이크로태스크·매크로태스크를 한 바퀴 흘린다 — unhandled rejection 이 그 사이 보고된다. */
const settle = async (fn) => { await act(async () => { fn(); await new Promise((done) => setTimeout(done, 0)) }) }
const call = (index) => {
  const found = calls[index]
  if (found === undefined) throw new Error(`IPC 호출 ${index} 없음 (총 ${calls.length})`)
  return found
}
const transport = () => new Error('transport: ipc channel closed')

beforeEach(() => {
  calls.length = 0
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Reflect.set(window, 'corral', {
    closeTabs: (input) => {
      const pending = defer()
      calls.push({ kind: 'tabs', input, ...pending })
      return pending.promise
    },
    closeWorktree: (input) => {
      const pending = defer()
      calls.push({ kind: 'workspace', input, ...pending })
      return pending.promise
    },
  })
  act(() => root.render(createElement(Harness)))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  process.off('unhandledRejection', onUnhandled)
})

describe('닫기 IPC 자체 reject (LIFE-524)', () => {
  it('처음 닫기 요청의 closeTabs 가 reject — unhandled 0, 오류 알림', async () => {
    await settle(() => hook.actions.closeTabs({ tabIds: ['A'], alwaysConfirm: false, onClosed: () => {} }))
    await settle(() => call(0).reject(transport()))
    expect(unhandled).toEqual([])
    expect(hook.lifecycleNotice?.kind).toBe('error')
    expect(hook.lifecycleNotice?.message).toContain('transport: ipc channel closed')
  })

  it('확인 뒤 닫기의 closeTabs 가 reject — 확인창이 풀리고 알림, 같은 탭 닫기 재시도가 IPC 까지 간다', async () => {
    await settle(() => hook.actions.closeTabs({ tabIds: ['A'], alwaysConfirm: false, onClosed: () => {} }))
    await settle(() => call(0).resolve({ outcome: 'needs-confirm', closed: [], running: [{ tabId: 'A', paneId: 'p-A', foreground: ['sleep 600'] }] }))
    expect(hook.pendingClose?.target.kind).toBe('tabs')
    await settle(() => hook.confirmPendingClose())
    expect(call(1).input.confirmed).toBe(true)
    await settle(() => call(1).reject(transport()))
    expect(unhandled).toEqual([])
    expect(hook.pendingClose).toBeNull()
    expect(hook.lifecycleNotice?.kind).toBe('error')
    // 재시도 — 같은 탭 닫기가 IPC 까지 간다.
    await settle(() => hook.actions.closeTabs({ tabIds: ['A'], alwaysConfirm: false, onClosed: () => {} }))
    expect(calls.length).toBe(3)
    expect(call(2).input.tabIds).toEqual(['A'])
  })

  it('closeWorktree 가 reject — unhandled 0, 오류 알림, 확인 뒤였으면 창이 풀린다', async () => {
    await settle(() => hook.actions.closeWorktree('w1'))
    await settle(() => call(0).resolve({ outcome: 'needs-confirm', foreground: ['vim'] }))
    expect(hook.pendingClose?.target.kind).toBe('workspace')
    await settle(() => hook.confirmPendingClose())
    await settle(() => call(1).reject(transport()))
    expect(unhandled).toEqual([])
    expect(hook.pendingClose).toBeNull()
    expect(hook.lifecycleNotice?.kind).toBe('error')
    await settle(() => hook.actions.closeWorktree('w1'))
    expect(call(2).kind).toBe('workspace')
  })
})
