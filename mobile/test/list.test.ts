// 대화방 목록 (LIFE-580) — 메시지 읽기 · 구독/재구독 · 늦은·역행 갱신 거절(L4ⓑ) · 안 읽음 장부(L7ⓐ) · 접힘(L5ⓓⓖ) · 화면 줄(L5ⓑⓖⓗⓘ · L8).
import { describe, expect, it } from 'vitest'
import { CollapseMemory, defaultCollapsed, readCollapseData, type CollapseData } from '../src/core/collapse'
import { ConnectionManager } from '../src/core/connection'
import { parseListMessage, type Channel, type ChannelList, type Dot } from '../src/core/list'
import { FLASH_MS, ListStore, SUBSCRIBE_DEADLINE_MS } from '../src/core/list-store'
import { buildListView, failureText, headerMeta, statusLabel } from '../src/core/list-view'
import { ConnectionLog } from '../src/core/log'
import { parseServerMessage } from '../src/core/protocol'
import { readUnreadData, UnreadLedger, type UnreadData } from '../src/core/unread'
import { FakeClock, FakeSocket, MemoryVault, SERVER, record } from './fakes'

function channel(id: string, patch: Partial<Channel> = {}): Channel {
  return {
    id,
    key: `s:${id}`,
    status: 'live',
    kind: 'claude',
    title: `제목 ${id}`,
    dot: 'idle',
    dotUnseen: 'idle',
    depth: 0,
    origin: null,
    spawnedBy: null,
    parent: null,
    preview: { kind: 'none' },
    waiting: null,
    model: null,
    timeAt: null,
    activityAt: 1_000,
    outcome: null,
    ...patch,
  }
}

function list(tasks: { id: string; name?: string; channels: Channel[] }[], waiting: string[] = []): Extract<ChannelList, { available: true }> {
  return { available: true, repos: [{ id: 'r1', name: 'corral', tasks: tasks.map((task) => ({ id: task.id, name: task.name ?? task.id, isDefault: false, channels: task.channels })) }], waiting }
}

function wire(seq: number, body: ChannelList, epoch = 'e1'): Record<string, unknown> {
  return { type: 'list', epoch, seq, at: 5_000 + seq, changedAt: 4_000 + seq, list: body }
}

class MemoryStore<T> {
  data: T | null = null
  saves = 0
  load(): T | null {
    return this.data === null ? null : JSON.parse(JSON.stringify(this.data))
  }
  save(data: T): void {
    this.saves += 1
    this.data = JSON.parse(JSON.stringify(data))
  }
}

describe('메시지 읽기', () => {
  it('정상 목록을 읽는다 · 모양이 틀린 칸이 하나라도 있으면 목록 전체를 버린다', () => {
    const ok = parseServerMessage(JSON.stringify(wire(1, list([{ id: 't', channels: [channel('a')] }]))))
    expect(ok.type).toBe('list')
    const broken = wire(1, list([{ id: 't', channels: [channel('a')] }]))
    const body = JSON.parse(JSON.stringify(broken))
    body.list.repos[0].tasks[0].channels[0].dot = 'sparkly'
    // R1-A4: 버리지 않고 목록 실패로 올린다(이전엔 'other' 로 사라졌다).
    expect(parseServerMessage(JSON.stringify(body))).toEqual({ type: 'list_invalid', seq: 1 })
    expect(parseListMessage({ epoch: 'e', seq: 'x', at: 1, list: { available: true, repos: [], waiting: [] } })).toBeNull()
  })

  it('「못 읽음」 목록은 빈 목록과 구분된다(L5ⓗ)', () => {
    const parsed = parseListMessage({ epoch: 'e', seq: 1, at: 1, changedAt: 1, list: { available: false, reason: 'reconnecting', repos: [], waiting: [] } })
    expect(parsed?.list).toEqual({ available: false, reason: 'reconnecting' })
  })
})

function harness(initial: UnreadData | null = null) {
  const clock = new FakeClock()
  const sockets: FakeSocket[] = []
  const log = new ConnectionLog(() => clock.now())
  const manager = new ConnectionManager({
    openSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    vault: new MemoryVault(record()),
    clock,
    log,
    appVersion: '0.1.0',
    deviceName: 'Z Flip7',
  })
  const unreadStore = new MemoryStore<UnreadData>()
  unreadStore.data = initial
  const ledger = new UnreadLedger({ store: unreadStore, now: () => clock.now() })
  const store = new ListStore({ connection: manager, ledger, now: () => clock.now(), timer: clock, log })
  const last = (): FakeSocket => {
    const socket = sockets[sockets.length - 1]
    if (socket === undefined) throw new Error('소켓 없음')
    return socket
  }
  const accept = (): FakeSocket => {
    const socket = last()
    socket.serverOpen()
    socket.serverSend({ type: 'hello', ok: true, protocol: 1, server: SERVER, device: { id: 'dev1', name: 'Z Flip7' } })
    return socket
  }
  return { clock, sockets, manager, store, ledger, unreadStore, last, accept, log }
}

const seqOf = (store: ListStore): number | null => {
  const phase = store.getSnapshot().phase
  return phase.kind === 'ready' ? phase.message.seq : null
}

describe('구독 · 재구독 (J8)', () => {
  it('hello 성공 직후 list.subscribe 를 보낸다 · 받기 전에는 waiting(「세션 0」 아님)', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    expect(socket.sent.map((message) => message.type)).toEqual(['hello', 'list.subscribe'])
    expect(t.store.getSnapshot().phase.kind).toBe('waiting')
    socket.serverSend(wire(1, list([{ id: 't', channels: [channel('a')] }])))
    expect(seqOf(t.store)).toBe(1)
  })

  it('L4ⓔ 연결이 살아 있어도 포그라운드 복귀 프로브가 성공하면 다시 구독한다', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    socket.serverSend(wire(1, list([{ id: 't', channels: [channel('a')] }])))
    t.manager.setForeground(false)
    t.clock.jump(120_000)
    t.manager.setForeground(true)
    expect(socket.lastSent()?.type).toBe('ping')
    socket.serverSend({ type: 'pong', id: 'x', at: 1 })
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    expect(socket.lastSent()?.type).toBe('list.subscribe')
    expect(socket.sent.filter((message) => message.type === 'list.subscribe')).toHaveLength(2)
  })

  it('목록 상태가 연결보다 늦게 생겨도(화면 모듈 지연 로드) 이미 인증된 연결이면 곧장 구독한다', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    const late = new ListStore({ connection: t.manager, ledger: t.ledger, now: () => t.clock.now(), timer: t.clock })
    expect(socket.sent.filter((message) => message.type === 'list.subscribe')).toHaveLength(2)
    socket.serverSend(wire(1, list([{ id: 't', channels: [channel('a')] }])))
    expect(seqOf(late)).toBe(1)
  })

  it('당겨서 새로고침은 구독을 다시 보낸다', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    expect(t.store.refresh()).toBe(true)
    expect(socket.sent.filter((message) => message.type === 'list.subscribe')).toHaveLength(2)
  })
})

describe('L4ⓑ 늦은·역행 갱신은 목록을 바꾸지 않는다', () => {
  it('같은 epoch 의 더 낮은 seq 는 버린다 · 같은 seq(재구독)와 높은 seq 는 받는다', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    socket.serverSend(wire(5, list([{ id: 't', channels: [channel('a', { title: '새 값' })] }])))
    socket.serverSend(wire(3, list([{ id: 't', channels: [channel('a', { title: '옛 값' })] }])))
    expect(seqOf(t.store)).toBe(5)
    expect(t.store.dropped).toBe(1)
    socket.serverSend(wire(5, list([{ id: 't', channels: [channel('a', { title: '새 값' })] }])))
    socket.serverSend(wire(6, list([{ id: 't', channels: [channel('a', { title: '더 새 값' })] }])))
    expect(seqOf(t.store)).toBe(6)
  })

  it('epoch 가 바뀌면(맥 재기동) 낮은 seq 라도 새 기준으로 받는다', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    socket.serverSend(wire(9, list([{ id: 't', channels: [channel('a')] }]), 'old'))
    socket.serverSend(wire(1, list([{ id: 't', channels: [channel('b')] }]), 'new'))
    expect(seqOf(t.store)).toBe(1)
  })

  it('이전 소켓의 늦은 목록은 버린다 — 새 연결이 받은 전체만 믿는다', async () => {
    const t = harness()
    await t.manager.start()
    const first = t.accept()
    first.serverSend(wire(1, list([{ id: 't', channels: [channel('a')] }])))
    // 망이 바뀌어 새 연결 — 이전 소켓의 핸들러는 떼어진다.
    first.serverClose(1006)
    t.clock.advance(5_000)
    const second = t.accept()
    expect(second).not.toBe(first)
    second.serverSend(wire(4, list([{ id: 't', channels: [channel('a', { title: '최신' })] }])))
    // 떼어진 핸들러 대신 직접 늦은 신호를 흉내 낸다 — 지금 시도가 아닌 번호의 목록.
    const stale = first.onmessage
    expect(stale).toBeNull()
    expect(seqOf(t.store)).toBe(4)
    const snapshot = t.store.getSnapshot().phase
    expect(snapshot.kind === 'ready' ? snapshot.message.list : null).toMatchObject({ repos: [{ tasks: [{ channels: [{ title: '최신' }] }] }] })
  })

  it('지금 시도가 아닌 번호의 list 신호는 버린다(경합 — 핸들러가 남아 있어도)', () => {
    const listeners: ((event: Parameters<Parameters<ConnectionManager['onSession']>[0]>[0]) => void)[] = []
    const sent: Record<string, unknown>[] = []
    const clock = new FakeClock()
    const store = new ListStore({
      connection: { onSession: (listener) => { listeners.push(listener); return () => {} }, liveAttempt: () => null, send: (message) => { sent.push(message); return true }, clockSample: () => null },
      ledger: new UnreadLedger({ store: new MemoryStore<UnreadData>(), now: () => clock.now() }),
      now: () => clock.now(),
      timer: clock,
    })
    const emit = (event: Parameters<(typeof listeners)[number]>[0]) => { for (const listener of listeners) listener(event) }
    const message = (seq: number) => {
      const parsed = parseListMessage(wire(seq, list([{ id: 't', channels: [channel('a')] }])))
      if (parsed === null) throw new Error('모양')
      return parsed
    }
    emit({ kind: 'live', attempt: 1, reason: 'connect' })
    emit({ kind: 'list', attempt: 1, message: message(1) })
    emit({ kind: 'live', attempt: 2, reason: 'connect' })
    emit({ kind: 'list', attempt: 1, message: message(7) })
    expect(seqOf(store)).toBe(1)
    expect(store.dropped).toBe(1)
    emit({ kind: 'list', attempt: 2, message: message(2) })
    expect(seqOf(store)).toBe(2)
    expect(sent).toEqual([{ type: 'list.subscribe' }, { type: 'list.subscribe' }])
  })
})

describe('L7ⓐ 안 읽음 — 폰 장부', () => {
  const store = () => new MemoryStore<UnreadData>()

  it('첫 설치 뒤 첫 목록은 전부 읽음 · 새 활동이면 안 읽음 · 열면 읽음', () => {
    let now = 10_000
    const ledger = new UnreadLedger({ store: store(), now: () => now })
    const a = channel('a', { activityAt: 1_000, outcome: 'completed' })
    ledger.observe(list([{ id: 't', channels: [a] }]))
    expect(ledger.isUnread(a)).toBe(false)
    const later = { ...a, activityAt: 2_000 }
    now += 1
    expect(ledger.isUnread(later)).toBe(true)
    ledger.markRead(later)
    expect(ledger.isUnread(later)).toBe(false)
  })

  it('턴 결과가 바뀌면(완료→실패·중단) 안 읽음', () => {
    const ledger = new UnreadLedger({ store: store(), now: () => 1 })
    const a = channel('a', { activityAt: 1_000, outcome: 'completed' })
    ledger.observe(list([{ id: 't', channels: [a] }]))
    expect(ledger.isUnread({ ...a, outcome: 'failed' })).toBe(true)
    expect(ledger.isUnread({ ...a, outcome: 'interrupted' })).toBe(true)
  })

  it('첫 목록 뒤에 처음 보는 채널은 활동이 있으면 안 읽음, 없으면 읽음', () => {
    const ledger = new UnreadLedger({ store: store(), now: () => 1 })
    ledger.observe(list([{ id: 't', channels: [channel('a')] }]))
    const quiet = channel('b', { activityAt: null, outcome: null })
    const busy = channel('c', { activityAt: 5_000 })
    ledger.observe(list([{ id: 't', channels: [channel('a'), quiet, busy] }]))
    expect(ledger.isUnread(quiet)).toBe(false)
    expect(ledger.isUnread(busy)).toBe(true)
  })

  it('키는 세션 정체 — pane id(채널 id)가 바뀌어도 같은 key 면 장부가 이어진다', () => {
    const ledger = new UnreadLedger({ store: store(), now: () => 1 })
    const before = channel('p21', { key: 's:codex-session', activityAt: 1_000 })
    ledger.observe(list([{ id: 't', channels: [before] }]))
    const after = { ...before, id: 'p99' }
    expect(ledger.isUnread(after)).toBe(false)
    expect(ledger.isUnread({ ...after, activityAt: 3_000 })).toBe(true)
  })

  it('L7ⓒ 앱 재시작 뒤 유지 — 저장한 값을 다시 읽는다 · 닫힌 세션은 대상 아님', () => {
    const shared = store()
    const first = new UnreadLedger({ store: shared, now: () => 1 })
    const a = channel('a', { activityAt: 1_000 })
    first.observe(list([{ id: 't', channels: [a] }]))
    const restarted = new UnreadLedger({ store: shared, now: () => 2 })
    expect(restarted.isUnread({ ...a, activityAt: 2_000 })).toBe(true)
    expect(restarted.isUnread(a)).toBe(false)
    expect(restarted.isUnread({ ...a, status: 'closed', activityAt: 9_000 })).toBe(false)
    expect(readUnreadData({ v: 1, initialized: true, seen: { x: { activityAt: 'bad', lastSeenAt: 1 }, y: 'junk' } })).toEqual({ v: 1, initialized: true, seen: { x: { activityAt: null, outcome: null, lastSeenAt: 1 } } })
  })
})

describe('L5ⓓⓖ 접힘', () => {
  it('기본 — 한가·확인 불가만 있는 작업은 접힘, 그 외 펼침', () => {
    expect(defaultCollapsed(['idle', 'unverifiable'])).toBe(true)
    expect(defaultCollapsed(['idle', 'working'])).toBe(false)
    expect(defaultCollapsed(['done'])).toBe(false)
    expect(defaultCollapsed([])).toBe(false)
  })

  it('사용자 접힘은 기본보다 앞서고 앱 재시작 뒤에도 남는다', () => {
    const shared = new MemoryStore<CollapseData>()
    const dots: Dot[] = ['idle']
    const first = new CollapseMemory({ store: shared, now: () => 1 })
    expect(first.isCollapsed('t1', dots)).toBe(true)
    first.toggle('t1', dots)
    expect(first.isCollapsed('t1', dots)).toBe(false)
    const restarted = new CollapseMemory({ store: shared, now: () => 2 })
    expect(restarted.isCollapsed('t1', dots)).toBe(false)
    expect(restarted.isCollapsed('t2', dots)).toBe(true)
    expect(readCollapseData({ v: 1, tasks: { a: { collapsed: 'yes', at: 1 } } })).toEqual({ v: 1, tasks: {} })
  })
})

describe('화면 줄 (L5ⓑⓖⓘ · L8)', () => {
  const base = {
    isUnread: () => false,
    isCollapsed: (_id: string, dots: readonly Dot[]) => defaultCollapsed(dots),
    flashUntil: {},
    now: 10_000,
    waitingExpanded: false,
  }

  it('기다리는 채널은 위로, 원래 자리엔 자국 행 · 위 섹션 셋째 줄 `레포 › 작업` · 서버 순서 그대로', () => {
    const q = channel('q', { dot: 'waiting', dotUnseen: 'waiting', waiting: 'question', preview: { kind: 'question', text: '어느 안으로?' } })
    const w = channel('w', { dot: 'working', dotUnseen: 'working', depth: 1, origin: 'life-579-impl', preview: { kind: 'tool', text: 'Edit · a.ts' } })
    const view = buildListView({ ...base, list: list([{ id: 't', name: 'LIFE-579', channels: [q, w] }], ['q']) })
    expect(view.waiting.map((row) => [row.channel.id, row.prefix?.text, row.text, row.meta])).toEqual([['q', '질문', '어느 안으로?', 'corral › LIFE-579']])
    const rows = view.repos[0]?.tasks[0]?.rows ?? []
    expect(rows.map((row) => row.kind)).toEqual(['ghost', 'channel'])
    const worker = rows[1]
    expect(worker?.kind === 'channel' ? [worker.worker, worker.meta, worker.mono] : null).toEqual([true, '↳ life-579-impl', true])
  })

  it('기다림 4개 이상이면 3 + `N개 더 보기`, 펼치면 전부 · 0개면 한 줄 요약', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => channel(id, { dot: 'waiting', dotUnseen: 'waiting', waiting: 'question' }))
    const view = buildListView({ ...base, list: list([{ id: 't', channels: many }], many.map((item) => item.id)) })
    expect([view.waiting.length, view.waitingTotal, view.waitingMore]).toEqual([3, 6, 3])
    const open = buildListView({ ...base, waitingExpanded: true, list: list([{ id: 't', channels: many }], many.map((item) => item.id)) })
    expect([open.waiting.length, open.waitingMore]).toEqual([6, 0])
    const none = buildListView({ ...base, list: list([{ id: 't', channels: [channel('a', { dot: 'working', dotUnseen: 'working' }), channel('b')] }]) })
    expect(none.noWaitingSummary).toBe('기다리는 세션 없음 · 작업 중 1')
  })

  it('안 읽음이면 `dotUnseen`(완료) + 굵은 제목·점, 작업 머리 점(접혀도)', () => {
    const done = channel('d', { dot: 'idle', dotUnseen: 'done', outcome: 'completed' })
    const view = buildListView({ ...base, isUnread: (item) => item.id === 'd', list: list([{ id: 't', channels: [done, channel('i')] }]) })
    const task = view.repos[0]?.tasks[0]
    const row = task?.rows[0]
    expect(row?.kind === 'channel' ? [row.dot, row.unread, row.prefix?.text] : null).toEqual(['done', true, '완료'])
    expect(task?.unread).toBe(true)
    // 안 읽음 완료가 있으면 「한가만」 이 아니라 펼침, 장부가 읽음이면 같은 작업이 접힘.
    expect(task?.collapsed).toBe(false)
    const seen = buildListView({ ...base, list: list([{ id: 't', channels: [done, channel('i')] }]) })
    expect(seen.repos[0]?.tasks[0]?.collapsed).toBe(true)
  })

  it('접힌 머리 — 점 앞 4개 + `+N` + 개수', () => {
    const idle = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => channel(id))
    const task = buildListView({ ...base, list: list([{ id: 't', channels: idle }]) }).repos[0]?.tasks[0]
    expect([task?.collapsed, task?.dots.length, task?.extraDots, task?.count]).toEqual([true, 4, 2, 6])
  })

  it('L8 닫힌 세션 — `닫힌 세션` 글, 접두어·안 읽음 없음, 접힘 판정·개수에서 빠진다', () => {
    const closed = channel('retained:r1', { status: 'closed', dot: 'idle', dotUnseen: 'done', activityAt: null })
    const view = buildListView({ ...base, isUnread: () => true, list: list([{ id: 't', channels: [channel('w', { dot: 'working', dotUnseen: 'working' }), closed] }]) })
    const task = view.repos[0]?.tasks[0]
    const row = task?.rows[1]
    expect(row?.kind === 'channel' ? [row.closed, row.text, row.prefix] : null).toEqual([true, '닫힌 세션', null])
    expect(task?.count).toBe(1)
    expect(statusLabel({ dot: 'idle', waiting: null, closed: true })).toBe('닫힘')
  })

  it('L5ⓘ 미리보기 접두어 — 권한 대기는 `맥에서 승인`(도구 mono, 없으면 접두어만 — LIFE-587) · 내 지시는 `나` · 실패 사유', () => {
    const rows = buildListView({
      ...base,
      list: list(
        [
          {
            id: 't',
            channels: [
              channel('p', { dot: 'waiting', dotUnseen: 'waiting', waiting: 'approval', preview: { kind: 'approval', text: 'Bash · rm -rf x' } }),
              channel('p2', { dot: 'waiting', dotUnseen: 'waiting', waiting: 'approval', preview: { kind: 'approval', text: null } }),
              channel('m', { preview: { kind: 'prompt', text: '정리해 줘' } }),
              channel('f', { dot: 'failed', dotUnseen: 'failed', preview: { kind: 'error', text: '529' } }),
              channel('l', { dot: 'blocked', dotUnseen: 'blocked', waiting: 'login' }),
            ],
          },
        ],
        ['p', 'p2', 'l'],
      ),
    })
    expect(rows.waiting.map((row) => [row.prefix?.text, row.text, row.mono])).toEqual([
      ['맥에서 승인', 'Bash · rm -rf x', true],
      ['맥에서 승인', '', false],
      ['로그인 대기', '', false],
    ])
    const inGroup = rows.repos[0]?.tasks[0]?.rows.filter((row) => row.kind === 'channel') ?? []
    expect(inGroup.map((row) => (row.kind === 'channel' ? [row.prefix?.text ?? null, row.text] : null))).toEqual([
      ['나', '정리해 줘'],
      ['실패', '529'],
    ])
  })

  it('B5 방금 바뀜 — 점이 바뀐 채널은 1.5초 동안 flash + 시각 `방금`', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    socket.serverSend(wire(1, list([{ id: 't', channels: [channel('a', { dot: 'working', dotUnseen: 'working', timeAt: 1 })] }])))
    t.clock.advance(100)
    socket.serverSend(wire(2, list([{ id: 't', channels: [channel('a', { dot: 'idle', dotUnseen: 'done', timeAt: 1 })] }])))
    const snapshot = t.store.getSnapshot()
    expect(snapshot.flashUntil.a).toBe(t.clock.now() + FLASH_MS)
    const phase = snapshot.phase
    if (phase.kind !== 'ready' || !phase.message.list.available) throw new Error('목록')
    const row = buildListView({ ...base, list: phase.message.list, flashUntil: snapshot.flashUntil, now: t.clock.now() }).repos[0]?.tasks[0]?.rows[0]
    expect(row?.kind === 'channel' ? [row.flash, row.time] : null).toEqual([true, '방금'])
    const later = buildListView({ ...base, list: phase.message.list, flashUntil: snapshot.flashUntil, now: t.clock.now() + FLASH_MS + 1 }).repos[0]?.tasks[0]?.rows[0]
    expect(later?.kind === 'channel' ? later.flash : null).toBe(false)
  })

  it('폰 수신 기록 — list_recv 에 seq·서버 시각, 제목 없음(J5 원자료)', async () => {
    const t = harness()
    const lines: string[] = []
    t.log.addSink((_entry, line) => lines.push(line))
    await t.manager.start()
    t.accept().serverSend(wire(1, list([{ id: 't', channels: [channel('a', { title: '비밀 제목' })] }])))
    const recv = lines.find((line) => line.includes('list_recv'))
    expect(recv).toContain('"seq":1')
    expect(recv).toContain('"changedAt":4001')
    expect(lines.join('\n')).not.toContain('비밀 제목')
  })

  it('R3-A2 list_recv `changes` — 직전 목록 대비 점이 바뀐 채널만(첫 목록은 전부, 사라짐은 `=-`)', async () => {
    const t = harness()
    const recv: string[] = []
    t.log.addSink((entry) => {
      if (entry.event === 'list_recv') recv.push(String(entry.detail.changes))
    })
    await t.manager.start()
    const socket = t.accept()
    socket.serverSend(wire(1, list([{ id: 't', channels: [channel('a', { dot: 'idle' }), channel('b', { dot: 'idle' })] }])))
    socket.serverSend(wire(2, list([{ id: 't', channels: [channel('a', { dot: 'idle' }), channel('b', { dot: 'working' })] }])))
    socket.serverSend(wire(3, list([{ id: 't', channels: [channel('a', { dot: 'idle' }), channel('b', { dot: 'working' })] }])))
    socket.serverSend(wire(4, list([{ id: 't', channels: [channel('b', { dot: 'blocked' })] }])))
    expect(recv).toEqual(['a=idle,b=idle', 'b=working', '', 'b=blocked,a=-'])
  })
})

describe('R1-A4 목록 실패 — 거절을 버리지 않는다', () => {
  const broken = (seq: number): Record<string, unknown> => {
    const body = JSON.parse(JSON.stringify(wire(seq, list([{ id: 't', channels: [channel('a')] }]))))
    body.list.repos[0].tasks[0].channels[0].dot = 'sparkly'
    return body
  }

  it('첫 응답을 읽지 못하면 waiting 이 아니라 실패(invalid · 호환 불가) — 다음 정상 목록이 지운다', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    socket.serverSend(broken(1))
    expect(t.store.getSnapshot().phase.kind).toBe('waiting')
    expect(t.store.getSnapshot().failure).toMatchObject({ reason: 'invalid', incompatible: true })
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
    expect(t.log.text()).toContain('list_invalid')
    socket.serverSend(wire(2, list([{ id: 't', channels: [channel('a')] }])))
    expect(t.store.getSnapshot().failure).toBeNull()
    expect(seqOf(t.store)).toBe(2)
  })

  it('정상 목록(빈 목록 포함) 뒤 읽지 못한 목록 — 이전 목록은 남기되 실패를 든다(오래된 값)', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    socket.serverSend(wire(1, list([])))
    socket.serverSend(broken(2))
    const snapshot = t.store.getSnapshot()
    expect(seqOf(t.store)).toBe(1)
    expect(snapshot.failure?.reason).toBe('invalid')
  })

  it('서버가 구독을 모르면(unknown_type — 옛 서버) rejected · 호환 불가', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    socket.serverSend({ type: 'error', code: 'unknown_type' })
    expect(t.store.getSnapshot().failure).toMatchObject({ reason: 'rejected', incompatible: true })
    expect(t.manager.getSnapshot().conn.kind).toBe('connected')
  })

  it('구독 뒤 마감 안에 목록이 없으면 timeout(호환 문제 아님) — 새로고침의 목록이 지운다 · 제때 오면 실패 없음', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    t.clock.advance(SUBSCRIBE_DEADLINE_MS - 1)
    expect(t.store.getSnapshot().failure).toBeNull()
    t.clock.advance(1)
    expect(t.store.getSnapshot().failure).toMatchObject({ reason: 'timeout', incompatible: false })
    expect(t.store.refresh()).toBe(true)
    socket.serverSend(wire(1, list([{ id: 't', channels: [channel('a')] }])))
    expect(t.store.getSnapshot().failure).toBeNull()
    t.clock.advance(SUBSCRIBE_DEADLINE_MS)
    expect(t.store.getSnapshot().failure).toBeNull()
  })

  it('연결이 끊겨 시도가 바뀐 뒤의 마감은 목록 실패로 세지 않는다(연결 띠 몫)', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    socket.serverClose(1006)
    t.clock.advance(SUBSCRIBE_DEADLINE_MS)
    expect(t.store.getSnapshot().failure).toBeNull()
  })

  it('안내 글 — 실패 이유마다 다르고 「받는 중」·「세션 0」 이 아니다', () => {
    for (const reason of ['invalid', 'rejected', 'timeout'] as const) {
      const text = failureText({ reason, at: 0, incompatible: reason !== 'timeout' })
      expect(`${text.title} ${text.body}`).not.toMatch(/받는 중|세션이 없습니다/)
    }
    expect(failureText({ reason: 'invalid', at: 0, incompatible: true }).body).toContain('업데이트')
    expect(failureText({ reason: 'rejected', at: 0, incompatible: true }).body).toContain('업데이트')
  })
})

describe('R1 C1 시계차 원자료 — pong.at → 오프셋, list_recv 와 같은 기록', () => {
  it('내가 보낸 ping 의 pong 에서 왕복 중간점 기준 오프셋을 잡고 list_recv 에 싣는다', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    t.clock.advance(8_000) // 정기 ping
    const ping = socket.lastSent()
    expect(ping?.type).toBe('ping')
    const sentAt = t.clock.now()
    t.clock.advance(40)
    // 서버 시계가 폰보다 250 ms 앞선다 — 중간점(sentAt+20) 기준 서버 시각 = sentAt+20+250.
    socket.serverSend({ type: 'pong', id: ping?.id, at: sentAt + 20 + 250 })
    expect(t.manager.clockSample()).toMatchObject({ offsetMs: 250, rttMs: 40 })
    socket.serverSend(wire(1, list([{ id: 't', channels: [channel('a')] }])))
    const recv = t.log.text().split('\n').find((line) => line.includes('list_recv'))
    expect(recv).toContain('"offsetMs":250')
    expect(recv).toContain('"rttMs":40')
    expect(t.log.text()).toContain('clock')
  })

  it('모르는 id · 서버 시각 없는 pong 은 표본이 아니다 — 표본 전 list_recv 의 오프셋은 null', async () => {
    const t = harness()
    await t.manager.start()
    const socket = t.accept()
    socket.serverSend({ type: 'pong', id: 999, at: 1 })
    socket.serverSend({ type: 'pong', id: 'x' })
    expect(t.manager.clockSample()).toBeNull()
    socket.serverSend(wire(1, list([{ id: 't', channels: [channel('a')] }])))
    expect(t.log.text().split('\n').find((line) => line.includes('list_recv'))).toContain('"offsetMs":null')
  })
})

describe('R1 C2 대화 머리 「띄운 세션」 — 부모가 있으면 항상', () => {
  it('같은 그룹 부모(목록 행엔 없음)도 머리에는 나온다 · 부모 모름 · 부모 없음', () => {
    expect(headerMeta(channel('a', { model: 'opus', spawnedBy: null, parent: { title: '코디' } }))).toBe('opus · 띄운 세션: 코디')
    expect(headerMeta(channel('a', { parent: { title: null }, origin: 'impl' }))).toBe('↳ impl · 띄운 세션: 알 수 없음')
    expect(headerMeta(channel('a'))).toBeNull()
  })

  it('`parent` 칸이 없는 목록(옛 서버)은 거절하지 않고 null 로 읽는다', () => {
    const body = JSON.parse(JSON.stringify(wire(1, list([{ id: 't', channels: [channel('a', { parent: { title: 'p' } })] }]))))
    delete body.list.repos[0].tasks[0].channels[0].parent
    const parsed = parseListMessage(body)
    expect(parsed?.list.available === true ? parsed.list.repos[0]?.tasks[0]?.channels[0]?.parent : 'x').toBeNull()
  })
})
