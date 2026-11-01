// LIFE-710 — 에이전트가 붙은 채 세션만 바뀌면(`/clear`) 목록이 스냅샷 재동기를 기다리지 않고 따라온다 (C5ⓐ~ⓗ).
//
// 저장소(`applyAgentSessions`·세션 시계)의 규칙과, link 의 세션 조회(`agent.list` 주기 호출)가 그 규칙을 거쳐
// 화면 갱신 신호를 내는지를 못박는다. 실측 원자료는 corral-specs LIFE-710 `raw/claude/` 쪽이다.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceStore } from './store.js'

type SubHooks = { label?: string; onPush: (frame: unknown, at: number) => void; onDrop: (reason: string, detail: string) => void }

const requestMock = vi.hoisted(() => vi.fn())
const logMock = vi.hoisted(() => vi.fn())
const subs = vi.hoisted(() => {
  const list: Array<{ hooks: SubHooks }> = []
  return list
})

vi.mock('../../log.js', () => ({ log: logMock }))
vi.mock('./request.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./request.js')>()
  return { ...actual, request: requestMock }
})
vi.mock('./subscription.js', () => ({
  Subscription: class {
    constructor(readonly hooks: SubHooks) {
      subs.push(this)
    }
    async connect(): Promise<unknown> { return {} }
    close(): void {}
  },
}))

const { AGENT_SESSION_POLL_MS, AGENT_SESSION_POLL_TIMEOUT_MS, SessionLink } = await import('./link.js')

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
const listOf = (session: string) => agentList([{ pane_id: 'w1:p1', agent_session: ref(session) }])
const sessionOf = (store: WorkspaceStore, paneId = 'w1:p1') => {
  const pane = store.rows().flatMap((w) => w.tabs).flatMap((t) => t.panes).find((p) => p.paneId === paneId)
  const value = pane?.agentSession
  return value === undefined || value === null ? value : value.kind === 'id' ? value.id : value.path
}
const tags = () => logMock.mock.calls.map((call) => String(call[0]))

describe('applyAgentSessions — 저장소 규칙', () => {
  it('ⓐ 스냅샷·pane_agent_detected 없이 세션 참조를 새 값으로 바꾼다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot('old'))
    const result = store.applyAgentSessions({ result: listOf('new'), requestedAt: Date.now() + 1 })
    expect(result.changed).toBe(true)
    expect(sessionOf(store)).toBe('new')
  })

  it('ⓑ 같은 세션 값이면 바꾸지 않고 changed:false 다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot('same'))
    const result = store.applyAgentSessions({ result: listOf('same'), requestedAt: Date.now() + 1 })
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

  describe('ⓓ 저장소에 없는 pane 은 만들거나 되살리지 않는다', () => {
    const answer = (paneId: string) => ({ result: agentList([{ pane_id: paneId, workspace_id: paneId.split(':')[0], tab_id: `${paneId.split(':')[0]}:t1`, agent_session: ref('ghost') }]), requestedAt: Date.now() + 1 })

    it('닫힌 pane', () => {
      const store = new WorkspaceStore()
      store.applySnapshot(snapshot('old'))
      store.applyEvent({ event: 'pane_closed', data: { pane_id: 'w1:p1', workspace_id: 'w1' } })
      expect(store.applyAgentSessions(answer('w1:p1')).changed).toBe(false)
      expect(store.paneIds()).toEqual([])
    })

    it('닫힌 탭의 pane', () => {
      const store = new WorkspaceStore()
      store.applySnapshot(snapshot('old'))
      store.applyEvent({ event: 'tab_closed', data: { tab_id: 'w1:t1', workspace_id: 'w1' } })
      expect(store.paneIds()).toEqual([])
      expect(store.applyAgentSessions(answer('w1:p1')).changed).toBe(false)
      expect(store.paneIds()).toEqual([])
    })

    it('보류함 pane(주인 workspace 가 아직 없음)·처음 보는 pane', () => {
      const store = new WorkspaceStore()
      store.applySnapshot(snapshot('old'))
      store.applyEvent({ event: 'pane_created', data: { pane: { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1', agent: 'claude' } } })
      expect(store.heldOrphans()).toEqual([{ workspaceId: 'w2', kind: 'pane' }])
      expect(store.applyAgentSessions(answer('w2:p1')).changed).toBe(false)
      expect(store.applyAgentSessions(answer('w1:p9')).changed).toBe(false)
      expect(store.paneIds()).toEqual(['w1:p1'])
    })
  })

  describe('ⓕ 세션 시계 — 요청 시각 기준', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('조회보다 먼저 요청된 재동기 스냅샷이 뒤늦게 적용돼도 조회가 쓴 새 세션을 되돌리지 않는다 (리뷰 r1 E 재현 시나리오)', () => {
      vi.useFakeTimers()
      const store = new WorkspaceStore()
      vi.setSystemTime(1_000_000)
      store.applySnapshot(snapshot('old'))
      expect(store.applyAgentSessions({ result: listOf('new'), requestedAt: 1_000_100 }).changed).toBe(true)
      vi.setSystemTime(1_000_200)
      store.reconcile(snapshot('old'), 1_000_050)
      expect(sessionOf(store)).toBe('new')
      // 적용 시각(1_000_200)이 아니라 요청 시각으로 잰다 — 그 사이 요청된 조회는 낡은 답이 아니다
      expect(store.applyAgentSessions({ result: listOf('newer'), requestedAt: 1_000_150 }).changed).toBe(true)
      expect(sessionOf(store)).toBe('newer')
    })

    it('조회보다 나중에 요청된 스냅샷의 값은 조회의 늦은 답이 덮지 않는다', () => {
      vi.useFakeTimers()
      const store = new WorkspaceStore()
      vi.setSystemTime(1_000_000)
      store.applySnapshot(snapshot('old'))
      vi.setSystemTime(1_000_400)
      store.reconcile(snapshot('snap'), 1_000_300)
      expect(sessionOf(store)).toBe('snap')
      expect(store.applyAgentSessions({ result: listOf('late'), requestedAt: 1_000_250 }).changed).toBe(false)
      expect(sessionOf(store)).toBe('snap')
    })

    it('부팅 스냅샷 뒤(적용 시각이 시계) 그보다 먼저 요청된 조회 답은 덮지 않는다', () => {
      const store = new WorkspaceStore()
      const requestedAt = Date.now() - 10
      store.applySnapshot(snapshot('fresh'))
      expect(store.applyAgentSessions({ result: listOf('stale'), requestedAt }).changed).toBe(false)
      expect(sessionOf(store)).toBe('fresh')
    })
  })

  it('ⓗ 스냅샷에 agent_session 키가 없던 pane 은 조회가 첫 참조를 채운다', () => {
    const store = new WorkspaceStore()
    store.applySnapshot(snapshot(null))
    expect(sessionOf(store)).toBeNull()
    expect(store.applyAgentSessions({ result: listOf('first'), requestedAt: Date.now() + 1 }).changed).toBe(true)
    expect(sessionOf(store)).toBe('first')
  })
})

describe('요청 경로 — agent.list 허용·조용한 성공', () => {
  // 아래 link 시험은 request 를 가짜로 바꾸므로 화이트리스트·로그를 지나지 않는다 — 실물 첫 회차가 화이트리스트에서 막혔다
  // (`method_not_allowed`, LIFE-710 raw/claude/feel-c1-r1). 실제 request 로 그 이음새를 따로 못박는다.
  beforeEach(() => {
    logMock.mockClear()
  })

  it('method_not_allowed 로 막히지 않는다 — 없는 소켓이라 연결 단계에서 실패한다', async () => {
    const actual = await vi.importActual<typeof import('./request.js')>('./request.js')
    const failure = await actual.request('/tmp/l710-unit-missing.sock', 'agent.list', {}, { timeoutMs: 500 }).then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof actual.HerdrRequestError ? failure.code : 'connect').not.toBe('method_not_allowed')
  })

  it('quiet 이면 성공한 요청의 req.* 줄을 남기지 않는다 — 양성 대조: quiet 없으면 남긴다', async () => {
    const actual = await vi.importActual<typeof import('./request.js')>('./request.js')
    const socketPath = path.join(os.tmpdir(), `l710-q-${process.pid}.sock`)
    fs.rmSync(socketPath, { force: true })
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.end(`${JSON.stringify({ id: 'x', result: agentList([]) })}\n`))
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
    try {
      await actual.request(socketPath, 'agent.list', {}, { timeoutMs: 1000, quiet: true })
      expect(tags().filter((tag) => tag.startsWith('req.'))).toEqual([])
      await actual.request(socketPath, 'agent.list', {}, { timeoutMs: 1000 })
      expect(tags()).toEqual(expect.arrayContaining(['req.conn.open', 'req.tx', 'req.rx', 'req.conn.close']))
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(socketPath, { force: true })
    }
  })
})

describe('SessionLink 세션 조회 — agent.list 주기 호출', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    requestMock.mockReset()
    logMock.mockClear()
    subs.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  type Reply = { id: string; result?: unknown; error?: { code?: string; message?: string } }
  function serve(input: { snapshot: () => unknown; agentList: () => Promise<Reply> }) {
    requestMock.mockImplementation(async (_socket: string, method: string) => {
      if (method === 'session.snapshot') return { id: 's', result: input.snapshot() }
      if (method === 'agent.list') return input.agentList()
      throw new Error(`예상 밖 호출 ${method}`)
    })
  }
  async function liveLink(input: { onChange?: () => void } = {}) {
    const link = new SessionLink({ onChange: input.onChange ?? (() => {}) })
    link.open({ name: 't', isDefault: false, running: true, socketPath: '/tmp/l710-unit.sock', sessionDir: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(link.linkState().phase).toBe('live')
    return link
  }
  const pollCalls = () => requestMock.mock.calls.filter((call) => call[1] === 'agent.list')
  const pollTags = () => tags().filter((tag) => tag.startsWith('agent_session.') || tag.startsWith('req.'))
  const mainSub = () => subs.find((sub) => sub.hooks.label === 'main')

  it('ⓐ 스냅샷·pane_agent_detected 없이 다음 주기에 목록 세션이 새 값이 되고 onChange·적용 로그가 나간다', async () => {
    const onChange = vi.fn()
    serve({ snapshot: () => snapshot('old'), agentList: async () => ({ id: 'a', result: listOf('new') }) })
    const link = await liveLink({ onChange })
    onChange.mockClear()
    logMock.mockClear()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS)
    expect(pollCalls()).toHaveLength(1)
    expect(requestMock.mock.calls.filter((call) => call[1] === 'session.snapshot')).toHaveLength(1)
    expect(sessionOf(link.store)).toBe('new')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(pollTags()).toEqual(['agent_session.poll.applied'])
    link.close()
  })

  it('ⓑ 같은 세션이면 바꾸지 않고 onChange 도 로그도 내지 않는다', async () => {
    const onChange = vi.fn()
    serve({ snapshot: () => snapshot('same'), agentList: async () => ({ id: 'a', result: listOf('same') }) })
    const link = await liveLink({ onChange })
    onChange.mockClear()
    logMock.mockClear()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS * 3)
    expect(pollCalls()).toHaveLength(3)
    expect(onChange).not.toHaveBeenCalled()
    expect(pollTags()).toEqual([])
    link.close()
  })

  it('ⓒ 조회 실패(오류 답·거절)는 알던 세션을 지우지 않고 실패 로그만 남긴다', async () => {
    const onChange = vi.fn()
    let call = 0
    serve({
      snapshot: () => snapshot('kept'),
      agentList: async () => {
        call += 1
        if (call === 1) return { id: 'a', error: { code: 'server_error', message: 'x' } }
        throw new Error('socket closed')
      },
    })
    const link = await liveLink({ onChange })
    onChange.mockClear()
    logMock.mockClear()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS * 2)
    expect(call).toBe(2)
    expect(sessionOf(link.store)).toBe('kept')
    expect(onChange).not.toHaveBeenCalled()
    expect(pollTags()).toEqual(['agent_session.poll.failed', 'agent_session.poll.failed'])
    link.close()
  })

  describe('ⓔ 주기·느린 응답', () => {
    it('주기 1.5 s·timeout 1.0 s 는 고정값이다 — 첫 조회는 live 뒤 정확히 한 주기에, timeout 은 주기보다 짧게·조용히 넘긴다', async () => {
      expect(AGENT_SESSION_POLL_MS).toBe(1_500)
      expect(AGENT_SESSION_POLL_TIMEOUT_MS).toBe(1_000)
      serve({ snapshot: () => snapshot('same'), agentList: async () => ({ id: 'a', result: listOf('same') }) })
      const link = await liveLink()
      await vi.advanceTimersByTimeAsync(1_499)
      expect(pollCalls()).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(pollCalls()).toHaveLength(1)
      const options = pollCalls()[0]?.[3]
      expect(options).toMatchObject({ timeoutMs: 1_000, quiet: true })
      expect(options.timeoutMs).toBeLessThan(AGENT_SESSION_POLL_MS)
      link.close()
    })

    it('응답이 오지 않는 동안 요청이 겹쳐 쌓이지 않는다 — 주기 ×3 동안 1건', async () => {
      serve({ snapshot: () => snapshot('same'), agentList: () => new Promise<Reply>(() => {}) })
      const link = await liveLink()
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS)
      expect(pollCalls()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS * 3)
      expect(pollCalls()).toHaveLength(1)
      link.close()
    })

    it('느린 응답(타임아웃)이 끝난 뒤 다음 조회는 앞 조회 시작 + 한 주기에 나간다 — 틱을 건너뛰지 않는다', async () => {
      let call = 0
      serve({
        snapshot: () => snapshot('same'),
        agentList: () => {
          call += 1
          if (call > 1) return Promise.resolve({ id: 'a', result: listOf('same') })
          return new Promise<Reply>((_resolve, reject) => setTimeout(() => reject(new Error('타임아웃')), AGENT_SESSION_POLL_TIMEOUT_MS))
        },
      })
      const link = await liveLink()
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS) // 첫 조회 시작
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS - 1)
      expect(pollCalls()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(pollCalls()).toHaveLength(2)
      link.close()
    })

    it('timeout 을 넘겨 답이 와도(가짜 지연 1.4 s) 다음 조회는 한 주기 안에 나간다', async () => {
      let call = 0
      serve({
        snapshot: () => snapshot('same'),
        agentList: () => {
          call += 1
          if (call > 1) return Promise.resolve({ id: 'a', result: listOf('same') })
          return new Promise<Reply>((resolve) => setTimeout(() => resolve({ id: 'a', result: listOf('same') }), 1_400))
        },
      })
      const link = await liveLink()
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS * 2)
      expect(pollCalls()).toHaveLength(2)
      link.close()
    })
  })

  describe('ⓖ 세대·타이머 정리', () => {
    it('재연결(세대 변경) 전에 나간 조회의 답은 새 저장소에 적용되지 않는다', async () => {
      const answers: Array<(reply: Reply) => void> = []
      let snap: string | null = 'old'
      serve({
        snapshot: () => snapshot(snap),
        agentList: () => new Promise<Reply>((resolve) => { answers.push(resolve) }),
      })
      const link = await liveLink()
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS)
      expect(answers).toHaveLength(1)
      // 새 세대의 부팅 스냅샷에는 세션 키가 없다(세션 시계 0) — 늦은 답을 막는 것은 세대 확인뿐이다
      snap = null
      mainSub()?.hooks.onDrop('eof', '시험 — 원격 끊김')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(link.linkState().phase).toBe('live')
      expect(sessionOf(link.store)).toBeNull()
      answers[0]?.({ id: 'a', result: listOf('stale-generation') })
      await vi.advanceTimersByTimeAsync(0)
      expect(sessionOf(link.store)).toBeNull()
      link.close()
    })

    it('close() 뒤 타이머가 남지 않는다(타이머 수 0)·조회도 없다', async () => {
      serve({ snapshot: () => snapshot('old'), agentList: async () => ({ id: 'a', result: listOf('old') }) })
      const link = await liveLink()
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS)
      link.close()
      expect(vi.getTimerCount()).toBe(0)
      requestMock.mockClear()
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS * 3)
      expect(pollCalls()).toHaveLength(0)
    })

    it('끊김(local) 뒤 타이머가 남지 않는다(타이머 수 0)', async () => {
      serve({ snapshot: () => snapshot('old'), agentList: async () => ({ id: 'a', result: listOf('old') }) })
      const link = await liveLink()
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS) // 상태 구독 디바운스(400 ms)도 지나간다
      mainSub()?.hooks.onDrop('local', '시험 — 로컬 끊김')
      expect(vi.getTimerCount()).toBe(0)
      link.close()
    })
  })

  it('ⓗ 에이전트 종료(released) 뒤에는 조회 대상이 아니고 목록 세션은 base 와 같이 그대로다', async () => {
    serve({ snapshot: () => snapshot('old'), agentList: async () => ({ id: 'a', result: agentList([]) }) })
    const link = await liveLink()
    mainSub()?.hooks.onPush({ event: 'pane_agent_detected', data: { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', released: true } }, Date.now())
    requestMock.mockClear()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS * 3)
    expect(pollCalls()).toHaveLength(0)
    // base(e06e9add) 의 store 도 released 에서 agent 만 지우고 세션 참조는 두었다 — 조회가 그 동작을 바꾸지 않는다
    expect(sessionOf(link.store)).toBe('old')
    link.close()
  })

  it('ⓗ 스냅샷에 세션 키가 없던 pane 은 조회가 첫 참조를 채운다', async () => {
    serve({ snapshot: () => snapshot(null), agentList: async () => ({ id: 'a', result: listOf('first') }) })
    const link = await liveLink()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS)
    expect(sessionOf(link.store)).toBe('first')
    link.close()
  })

  it('에이전트가 붙은 pane 이 없으면 요청을 보내지 않는다 — 조용할 때 비용 0', async () => {
    serve({ snapshot: () => snapshot(null, null), agentList: async () => ({ id: 'a', result: agentList([]) }) })
    const link = await liveLink()
    requestMock.mockClear()
    await vi.advanceTimersByTimeAsync(AGENT_SESSION_POLL_MS * 4)
    expect(pollCalls()).toHaveLength(0)
    link.close()
  })
})
