// LIFE-710 — 에이전트가 붙은 채 세션만 바뀌면(`/clear`) 목록이 스냅샷 재동기를 기다리지 않고 따라온다 (C5).
//
// 저장소(`applyAgentSessions`)의 규칙과, link 의 세션 조회(`agent.list` 주기 호출)가 그 규칙을 거쳐
// 화면 갱신 신호를 내는지를 못박는다. 실측 원자료는 corral-specs LIFE-710 `raw/claude/` 쪽이다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceStore } from './store.js'

const requestMock = vi.hoisted(() => vi.fn())

vi.mock('../../log.js', () => ({ log: () => {} }))
vi.mock('./request.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./request.js')>()
  return { ...actual, request: requestMock }
})
vi.mock('./subscription.js', () => ({
  Subscription: class {
    async connect(): Promise<unknown> { return {} }
    close(): void {}
  },
}))

const { AGENT_SESSION_POLL_MS, SessionLink } = await import('./link.js')

const ref = (value: string) => ({ source: 'herdr:claude', agent: 'claude', kind: 'id', value })
const snapshot = (session: string | null, agent: string | null = 'claude'): unknown => ({
  workspaces: [{ workspace_id: 'w1', label: 'repo', number: 1, focused: true, agent_status: 'idle' }],
  tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 't1', number: 1, agent_status: 'idle' }],
  panes: [{
    pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', agent_status: 'idle', agent,
    ...(session === null ? {} : { agent_session: ref(session) }),
  }],
})
const agentList = (entries: Array<Record<string, unknown>>) => ({ type: 'agent_list', agents: entries })
const sessionOf = (store: WorkspaceStore, paneId = 'w1:p1') => {
  const pane = store.rows().flatMap((w) => w.tabs).flatMap((t) => t.panes).find((p) => p.paneId === paneId)
  const value = pane?.agentSession
  return value === undefined || value === null ? value : value.kind === 'id' ? value.id : value.path
}

describe('applyAgentSessions — 저장소 규칙', () => {
  it('ⓐ 스냅샷·pane_agent_detected 없이 세션 참조를 새 값으로 바꾼다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot('old'))
    const result = store.applyAgentSessions({ result: agentList([{ pane_id: 'w1:p1', agent_session: ref('new') }]), requestedAt: Date.now() + 1 })
    expect(result.changed).toBe(true)
    expect(sessionOf(store)).toBe('new')
  })

  it('ⓑ 같은 세션 값이면 바꾸지 않고 changed:false 다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot('same'))
    const result = store.applyAgentSessions({ result: agentList([{ pane_id: 'w1:p1', agent_session: ref('same') }]), requestedAt: Date.now() + 1 })
    expect(result.changed).toBe(false)
    expect(sessionOf(store)).toBe('same')
  })

  it('ⓒ 키가 없는 항목·모양이 아닌 답은 알던 세션을 지우지 않는다 — 키가 있고 null 이면 그게 답이다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot('kept'))
    const later = Date.now() + 1
    expect(store.applyAgentSessions({ result: agentList([{ pane_id: 'w1:p1' }]), requestedAt: later }).changed).toBe(false)
    expect(store.applyAgentSessions({ result: { error: 'x' }, requestedAt: later }).changed).toBe(false)
    expect(store.applyAgentSessions({ result: null, requestedAt: later }).changed).toBe(false)
    expect(sessionOf(store)).toBe('kept')
    expect(store.applyAgentSessions({ result: agentList([{ pane_id: 'w1:p1', agent_session: null }]), requestedAt: later }).changed).toBe(true)
    expect(sessionOf(store)).toBeNull()
  })

  it('ⓓ 닫힌 pane 을 되살리지 않는다 — 저장소에 없는 pane 은 행을 만들지 않는다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot('old'))
    store.applyEvent({ event: 'pane_closed', data: { pane_id: 'w1:p1', workspace_id: 'w1' } })
    const result = store.applyAgentSessions({
      result: agentList([{ pane_id: 'w1:p1', agent_session: ref('new') }, { pane_id: 'w1:p9', workspace_id: 'w1', tab_id: 'w1:t1', agent_session: ref('ghost') }]),
      requestedAt: Date.now() + 1,
    })
    expect(result.changed).toBe(false)
    expect(store.paneIds()).toEqual([])
  })

  it('요청 뒤에 스냅샷이 세션을 읽었으면 늦게 온 답이 덮지 않는다', () => {
    const store = new WorkspaceStore()
    const requestedAt = Date.now() - 10
    store.applySnapshot(snapshot('fresh'))
    const result = store.applyAgentSessions({ result: agentList([{ pane_id: 'w1:p1', agent_session: ref('stale') }]), requestedAt })
    expect(result.changed).toBe(false)
    expect(sessionOf(store)).toBe('fresh')
  })
})

describe('SessionLink 세션 조회 — agent.list 주기 호출', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    requestMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function liveLink(input: { snapshot: unknown; onChange?: () => void }) {
    requestMock.mockImplementation(async (_socket: string, method: string) => {
      if (method === 'session.snapshot') return { id: 's', result: input.snapshot }
      throw new Error(`예상 밖 호출 ${method}`)
    })
    const link = new SessionLink({ onChange: input.onChange ?? (() => {}) })
    link.open({ name: 't', isDefault: false, running: true, socketPath: '/tmp/l710-unit.sock', sessionDir: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(link.linkState().phase).toBe('live')
    return link
  }
  const methods = () => requestMock.mock.calls.map((call) => call[1])

  it('ⓐ 스냅샷·pane_agent_detected 없이 다음 주기에 목록 세션이 새 값이 되고 onChange 가 나간다', async () => {
    const onChange = vi.fn()
    const link = await liveLink({ snapshot: snapshot('old'), onChange })
    requestMock.mockImplementation(async (_socket: string, method: string) => {
      if (method === 'agent.list') return { id: 'a', result: agentList([{ pane_id: 'w1:p1', agent_session: ref('new') }]) }
      throw new Error(`예상 밖 호출 ${method}`)
    })
    requestMock.mockClear()
    onChange.mockClear()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS)
    expect(methods()).toEqual(['agent.list'])
    expect(sessionOf(link.store)).toBe('new')
    expect(onChange).toHaveBeenCalledTimes(1)
    link.close()
  })

  it('ⓑ 같은 세션이면 바꾸지 않고 onChange 를 내지 않는다', async () => {
    const onChange = vi.fn()
    const link = await liveLink({ snapshot: snapshot('same'), onChange })
    requestMock.mockImplementation(async (_socket: string, method: string) => {
      if (method === 'agent.list') return { id: 'a', result: agentList([{ pane_id: 'w1:p1', agent_session: ref('same') }]) }
      throw new Error(`예상 밖 호출 ${method}`)
    })
    requestMock.mockClear()
    onChange.mockClear()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS * 3)
    expect(methods()).toEqual(['agent.list', 'agent.list', 'agent.list'])
    expect(onChange).not.toHaveBeenCalled()
    link.close()
  })

  it('ⓒ 조회 실패(오류 답·거절)는 알던 세션을 지우지 않는다', async () => {
    const onChange = vi.fn()
    const link = await liveLink({ snapshot: snapshot('kept'), onChange })
    let call = 0
    requestMock.mockImplementation(async (_socket: string, method: string) => {
      if (method !== 'agent.list') throw new Error(`예상 밖 호출 ${method}`)
      call += 1
      if (call === 1) return { id: 'a', error: { code: 'server_error', message: 'x' } }
      throw new Error('socket closed')
    })
    onChange.mockClear()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS * 2)
    expect(call).toBe(2)
    expect(sessionOf(link.store)).toBe('kept')
    expect(onChange).not.toHaveBeenCalled()
    link.close()
  })

  it('에이전트가 붙은 pane 이 없으면 요청을 보내지 않는다 — 조용할 때 비용 0', async () => {
    const link = await liveLink({ snapshot: snapshot(null, null) })
    requestMock.mockClear()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS * 4)
    expect(methods()).toEqual([])
    link.close()
  })

  it('close 뒤에는 조회하지 않는다', async () => {
    const link = await liveLink({ snapshot: snapshot('old') })
    link.close()
    requestMock.mockClear()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS * 3)
    expect(methods()).toEqual([])
  })
})
