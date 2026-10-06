// @vitest-environment happy-dom
/* global window, document */
// LIFE-516 fix2 R2-01 — 닫기 확인 창·콜백은 그 창을 띄운 요청의 것이다(실제 훅, 지연 IPC·지연 저장).
// 모달이 뜨기 전 두 요청(A·B)의 probe 가 겹치면: A 창 → A 확인(저장 대기) → B 의 늦은 needs-confirm 은 창을 바꾸지 않고 버린다(D10, 알림),
// A 의 닫힘은 A 콜백으로만 가고, 한 요청의 완료가 다른 요청의 창을 지우지 않는다. 확인 불필요 탭의 연속 닫기는 막지 않는다.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLOSE_DEFERRED_NOTICE, useLifecycleActions } from './useLifecycleActions.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const state = { home: '/h', repos: [] }
let host
let root
let hook = null
/** `corral.closeTabs` 호출마다 한 줄 — 테스트가 응답을 놓는다. */
const calls = []
const callbacks = []
function Harness() {
  hook = useLifecycleActions(state)
  return null
}
const defer = () => {
  let resolve = () => {}
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const settle = async (fn) => { await act(async () => { fn(); await Promise.resolve() }) }
const ask = (tabId) => hook.actions.closeTabs({ tabIds: [tabId], alwaysConfirm: false, onClosed: (closed) => callbacks.push({ owner: tabId, closed }) })
/** `index` 번째 호출을 찾는다 — 없으면 설명을 붙여 throw. */
const call = (index) => {
  const found = calls[index]
  if (found === undefined) throw new Error(`closeTabs 호출 ${index} 없음 (총 ${calls.length})`)
  return found
}
const needsConfirm = (index) => {
  const tabId = call(index).input.tabIds[0]
  call(index).resolve({ outcome: 'needs-confirm', closed: [], running: [{ tabId, paneId: `p-${tabId}`, foreground: ['sleep 600'] }] })
}
const closedReply = (index) => call(index).resolve({ outcome: 'closed', closed: call(index).input.tabIds, running: [] })
const confirmedCalls = () => calls.filter((row) => row.input.confirmed)
const shownTab = () => hook.pendingClose?.target.kind === 'tabs' ? hook.pendingClose.target.tabIds[0] : null

beforeEach(() => {
  calls.length = 0
  callbacks.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Reflect.set(window, 'corral', {
    closeTabs: (input) => {
      const pending = defer()
      calls.push({ input, resolve: pending.resolve })
      return pending.promise
    },
  })
  act(() => root.render(createElement(Harness)))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('닫기 확인 창의 주인 (fix2 R2-01)', () => {
  it('리뷰어 순서: A 창 → A 체크+확인(저장 대기) → B 늦은 needs-confirm → 저장 끝 → A 콜백만 ["A"], B 창은 버리고 알림, 창은 A 완료로 닫힘', async () => {
    await settle(() => { ask('A'); ask('B') })
    await settle(() => needsConfirm(0))
    expect(shownTab()).toBe('A')
    const save = defer()
    await settle(() => hook.confirmPendingClose({ before: () => save.promise }))
    await settle(() => needsConfirm(1))
    expect(shownTab()).toBe('A')
    expect(hook.lifecycleNotice).toEqual({ kind: 'info', message: CLOSE_DEFERRED_NOTICE })
    await settle(() => save.resolve())
    expect(confirmedCalls().map((row) => row.input.tabIds)).toEqual([['A']])
    await settle(() => closedReply(2))
    expect(callbacks).toEqual([{ owner: 'A', closed: ['A'] }])
    expect(hook.pendingClose).toBeNull()
    // B 는 닫히지 않았다 — 다시 닫으면 자기 창이 뜬다(확인 없이 닫는 경로 없음).
    await settle(() => ask('B'))
    await settle(() => needsConfirm(3))
    expect(shownTab()).toBe('B')
    expect(confirmedCalls()).toHaveLength(1)
  })

  it('저장 없는 변형: A 확인 닫기 IPC 대기 중 B needs-confirm 도착 → A 창 유지·A 콜백만', async () => {
    await settle(() => { ask('A'); ask('B') })
    await settle(() => needsConfirm(0))
    await settle(() => hook.confirmPendingClose())
    expect(confirmedCalls().map((row) => row.input.tabIds)).toEqual([['A']])
    await settle(() => needsConfirm(1))
    expect(shownTab()).toBe('A')
    await settle(() => closedReply(2))
    expect(callbacks).toEqual([{ owner: 'A', closed: ['A'] }])
    expect(hook.pendingClose).toBeNull()
  })

  it('창 A 가 떠 있는 동안 확인 불필요 초기 요청 C 의 응답이 와도 A 창은 그대로 · C 콜백은 ["C"]', async () => {
    await settle(() => { ask('A'); ask('C') })
    await settle(() => needsConfirm(0))
    await settle(() => closedReply(1))
    expect(shownTab()).toBe('A')
    expect(callbacks).toEqual([{ owner: 'C', closed: ['C'] }])
    await settle(() => hook.confirmPendingClose())
    await settle(() => closedReply(2))
    expect(callbacks).toEqual([{ owner: 'C', closed: ['C'] }, { owner: 'A', closed: ['A'] }])
    expect(hook.pendingClose).toBeNull()
  })

  it('창 A 가 떠 있는 동안 다른 초기 요청의 rejected 는 알림만, A 창은 그대로', async () => {
    await settle(() => { ask('A'); ask('D') })
    await settle(() => needsConfirm(0))
    await settle(() => call(1).resolve({ outcome: 'rejected', closed: [], rejection: { code: 'denied', message: 'no' } }))
    expect(shownTab()).toBe('A')
    expect(hook.lifecycleNotice?.kind).toBe('rejected')
  })

  it('회귀 금지(ⓓ): 확인 불필요 탭을 겹쳐 연속으로 닫으면 모두 닫히고 창·알림이 없다', async () => {
    await settle(() => { ask('x'); ask('y'); ask('z') })
    expect(calls).toHaveLength(3)
    await settle(() => closedReply(1))
    await settle(() => closedReply(0))
    await settle(() => closedReply(2))
    expect(callbacks).toEqual([{ owner: 'y', closed: ['y'] }, { owner: 'x', closed: ['x'] }, { owner: 'z', closed: ['z'] }])
    expect(hook.pendingClose).toBeNull()
    expect(hook.lifecycleNotice).toBeNull()
  })

  it('확인 뒤 main 이 새 실행 중으로 다시 묻는 것은 같은 요청 — 창을 다시 세우고 콜백도 그 요청 것', async () => {
    await settle(() => ask('A'))
    await settle(() => needsConfirm(0))
    await settle(() => hook.confirmPendingClose())
    await settle(() => needsConfirm(1))
    expect(shownTab()).toBe('A')
    expect(hook.lifecycleNotice).toBeNull()
    await settle(() => hook.confirmPendingClose())
    await settle(() => closedReply(2))
    expect(callbacks).toEqual([{ owner: 'A', closed: ['A'] }])
    expect(hook.pendingClose).toBeNull()
  })
})
