// LIFE-812 — GroupSession 의 검색·결과 이동·프레임 scrollTop (herdr 없이 — 실호출은 G0 하네스).
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { GroupSession, type EndpointClientLike, type GroupFrame } from './group-session.js'
import type { EndpointSurface } from './vendor/endpoint-client.js'
import type { CellData } from './vendor/frame-types.js'
import { silentLogger } from './vendor/logger.js'

const CELL: CellData = { symbol: ' ', fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null }
const ADVERTISED = ['pane.focus', 'pane.scroll', 'pane.copy_motion', 'pane.copy_search']

function surface(input: { text: string; scroll: { offsetFromBottom: number; maxOffsetFromBottom: number } | null; rows?: number }): EndpointSurface {
  const width = 10
  const height = input.rows ?? 4
  const cells: CellData[] = Array.from({ length: width * height }, (_, index) => ({ ...CELL, symbol: index < input.text.length ? (input.text[index] ?? ' ') : ' ' }))
  return {
    frame: { cells, width, height, cursor: null, hyperlinks: [] },
    surfaceRevision: 1,
    full: true,
    panes: [{ paneId: 'p1', rect: { x: 0, y: 0, width, height }, innerRect: { x: 0, y: 0, width, height }, scroll: input.scroll === null ? null : { ...input.scroll, viewportRows: height }, focused: true, mouseReporting: false }],
  }
}

class FakeClient extends EventEmitter {
  current: EndpointSurface | null = null
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  advertised = ADVERTISED
  /** 메서드별 응답 — 함수면 부를 때마다 계산한다. */
  replies = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  first: EndpointSurface

  constructor(first: EndpointSurface) {
    super()
    this.first = first
  }

  get currentSurface(): EndpointSurface | null {
    return this.current
  }

  async connect(): Promise<void> {}

  assertMethod(method: string): void {
    if (!this.advertised.includes(method)) throw new Error(`Herdr endpoint does not advertise ${method}`)
  }

  async callEndpoint(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.assertMethod(method)
    this.calls.push({ method, params })
    if (method === 'pane.focus') this.emitSurface(this.first)
    const reply = this.replies.get(method)
    return reply === undefined ? {} : reply(params)
  }

  resize(): void {}
  sendPaneInput(): void {}
  close(): void {}

  emitSurface(next: EndpointSurface): void {
    this.current = next
    this.emit('surface', next)
  }
}

async function attached(first: EndpointSurface): Promise<{ client: FakeClient; session: GroupSession; frames: GroupFrame[] }> {
  const client = new FakeClient(first)
  const frames: GroupFrame[] = []
  const createClient = (): EndpointClientLike => client
  const session = new GroupSession({
    socketPath: '/tmp/fake.sock',
    logger: silentLogger,
    checkConsistency: false,
    createClient,
    hooks: { onFrame: (frame) => frames.push(frame), onLayout: () => {}, onClipboard: () => {}, onError: () => {}, onClose: () => {} },
  })
  await session.attach({ tabId: 't1', paneId: 'p1', grid: { cols: 10, rows: 4 } })
  return { client, session, frames }
}

const staleError = (): Error => Object.assign(new Error('pane content changed'), { code: 'stale_content' })

describe('LIFE-812 프레임 scrollTop — 강조의 기준 행', () => {
  it('프레임에 뷰포트 맨 위 절대 행(max − offset)을 싣는다, 스크롤 상태가 없으면 null', async () => {
    const { client, frames } = await attached(surface({ text: 'a', scroll: { offsetFromBottom: 30, maxOffsetFromBottom: 100 } }))
    expect(frames.at(-1)?.scrollTop).toBe(70)
    client.emitSurface(surface({ text: 'b', scroll: null }))
    expect(frames.at(-1)?.scrollTop).toBeNull()
  })

  it('fix1 R1-1 — 내용이 같아도 스크롤만 바뀌면 새 scrollTop 을 실은 프레임이 간다, 둘 다 같으면 건너뛴다(P1)', async () => {
    const { client, frames } = await attached(surface({ text: 'same', scroll: { offsetFromBottom: 7, maxOffsetFromBottom: 260 } }))
    expect(frames.at(-1)?.scrollTop).toBe(253)
    const before = frames.length
    // 같은 줄 반복 화면을 40행 더 올렸다 — 크롭은 같다(리뷰 r1-pr-8 재현 꼴)
    client.emitSurface(surface({ text: 'same', scroll: { offsetFromBottom: 47, maxOffsetFromBottom: 260 } }))
    expect(frames).toHaveLength(before + 1)
    expect(frames.at(-1)?.scrollTop).toBe(213)
    // 내용·스크롤 모두 같으면 여전히 건너뛴다
    client.emitSurface(surface({ text: 'same', scroll: { offsetFromBottom: 47, maxOffsetFromBottom: 260 } }))
    expect(frames).toHaveLength(before + 1)
  })
})

describe('LIFE-812 search — 광고 목록·revision·재시도', () => {
  it('copy_motion 으로 얻은 revision 을 copy_search 에 싣고, 새 질의는 뷰포트 바닥 바로 아래에서 위로 찾는다', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: { offsetFromBottom: 10, maxOffsetFromBottom: 100 } }))
    client.replies.set('pane.copy_motion', async () => ({ content_revision: 42 }))
    client.replies.set('pane.copy_search', async () => ({ total: 1, current: 0, current_global: 0, matches: [{ start: { row: 5, col: 1 }, end: { row: 5, col: 3 } }] }))
    const result = await session.search({ paneId: 'p1', query: 'abc', direction: 'backward', from: 'viewport' })
    expect(result).toEqual({ kind: 'found', total: 1, index: 0, current: { start: { row: 5, col: 1 }, end: { row: 5, col: 3 } }, matches: [{ start: { row: 5, col: 1 }, end: { row: 5, col: 3 } }], attempts: 1, token: expect.any(Number) })
    const search = client.calls.find((call) => call.method === 'pane.copy_search')
    // top = 100 − 10 = 90, rows 4 → 바닥 93, 커서 94
    expect(search?.params).toEqual({ pane_id: 'p1', query: 'abc', direction: 'backward', cursor: { row: 94, col: 0 }, previous: null, content_revision: 42 })
  })

  it('stale_content 면 새 revision 으로 다시 묻고 시도 수를 센다', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: { offsetFromBottom: 0, maxOffsetFromBottom: 0 } }))
    let revision = 0
    client.replies.set('pane.copy_motion', async () => ({ content_revision: ++revision }))
    client.replies.set('pane.copy_search', async (params) => {
      if (params['content_revision'] !== 3) throw staleError()
      return { total: 0, matches: [] }
    })
    expect(await session.search({ paneId: 'p1', query: 'x', direction: 'backward', from: 'viewport' })).toEqual({ kind: 'none', attempts: 3 })
  })

  it('상한까지 계속 거절되면 busy — 무한 반복하지 않는다(C4ⓗ)', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: null }))
    client.replies.set('pane.copy_motion', async () => ({ content_revision: 2 }))
    client.replies.set('pane.copy_search', async () => { throw staleError() })
    expect(await session.search({ paneId: 'p1', query: 'x', direction: 'forward', from: 'viewport' })).toEqual({ kind: 'busy', attempts: 5 })
    expect(client.calls.filter((call) => call.method === 'pane.copy_search')).toHaveLength(5)
  })

  it('fix1 R1-2 — 재시도 대기 중 새 검색이 오면 앞 검색은 더 묻지 않고 cancelled', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: null }))
    client.replies.set('pane.copy_motion', async () => ({ content_revision: 2 }))
    let first = true
    client.replies.set('pane.copy_search', async (params) => {
      if (params['query'] === 'old') {
        if (first) {
          first = false
          throw staleError()
        }
        throw new Error('낡은 검색이 다시 물었다')
      }
      return { total: 0, matches: [] }
    })
    const old = session.search({ paneId: 'p1', query: 'old', direction: 'forward', from: 'viewport' })
    await new Promise((resolve) => setTimeout(resolve, 10)) // 첫 거절 뒤 50ms 대기 중
    expect(await session.search({ paneId: 'p1', query: 'new', direction: 'forward', from: 'viewport' })).toEqual({ kind: 'none', attempts: 1 })
    expect(await old).toEqual({ kind: 'cancelled', attempts: 1 })
    expect(client.calls.filter((call) => call.method === 'pane.copy_search' && call.params['query'] === 'old')).toHaveLength(1)
  })

  it('fix1 R1-2 — 취소(막대 닫기 등)도 대기 중 재시도를 멈춘다', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: null }))
    client.replies.set('pane.copy_motion', async () => ({ content_revision: 2 }))
    client.replies.set('pane.copy_search', async () => { throw staleError() })
    const pending = session.search({ paneId: 'p1', query: 'x', direction: 'forward', from: 'viewport' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    session.cancelSearch('p1')
    expect(await pending).toEqual({ kind: 'cancelled', attempts: 1 })
    expect(client.calls.filter((call) => call.method === 'pane.copy_search')).toHaveLength(1)
  })

  it('광고되지 않은 메서드는 부르지 않는다(C1ⓕ) — 오류로 돌려준다', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: null }))
    client.advertised = ['pane.focus', 'pane.scroll']
    const result = await session.search({ paneId: 'p1', query: 'x', direction: 'forward', from: 'viewport' })
    expect(result).toEqual({ kind: 'error', message: 'Herdr endpoint does not advertise pane.copy_motion' })
    expect(client.calls.some((call) => call.method.startsWith('pane.copy'))).toBe(false)
  })

  it('붙은 탭 밖 pane 은 묻지 않는다', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: null }))
    expect((await session.search({ paneId: 'other', query: 'x', direction: 'forward', from: 'viewport' })).kind).toBe('error')
    expect(client.calls.some((call) => call.method.startsWith('pane.copy'))).toBe(false)
  })
})

/** 검색을 한 번 해 그 pane 의 살아 있는 표를 얻는다. */
async function liveToken(client: FakeClient, session: GroupSession): Promise<number> {
  client.replies.set('pane.copy_motion', async () => ({ content_revision: 1 }))
  client.replies.set('pane.copy_search', async () => ({ total: 1, current: 0, current_global: 0, matches: [{ start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }] }))
  const result = await session.search({ paneId: 'p1', query: 'x', direction: 'forward', from: 'viewport' })
  if (result.kind !== 'found') throw new Error('표를 못 얻었다')
  return result.token
}

describe('LIFE-812 reveal — 절대 오프셋, 보이면 요청 0 (C2)', () => {
  it('이미 보이는 행이면 pane.scroll 을 보내지 않는다', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: { offsetFromBottom: 0, maxOffsetFromBottom: 100 } }))
    const token = await liveToken(client, session)
    // 보이는 행 = [100, 103]
    expect(await session.reveal({ paneId: 'p1', row: 102, token })).toEqual({ scrolled: false, top: 100 })
    expect(client.calls.some((call) => call.method === 'pane.scroll')).toBe(false)
  })

  it('안 보이면 그 행이 가운데쯤 오게 절대 오프셋을 보낸다 — 다음 휠은 그 자리에서 이어진다', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: { offsetFromBottom: 0, maxOffsetFromBottom: 100 } }))
    const token = await liveToken(client, session)
    expect(await session.reveal({ paneId: 'p1', row: 40, token })).toEqual({ scrolled: true, top: 38 })
    expect(client.calls.filter((call) => call.method === 'pane.scroll').map((call) => call.params)).toEqual([{ pane_id: 'p1', offset_from_bottom: 62 }])
    session.scroll({ paneId: 'p1', direction: 'down', lines: 2 })
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.calls.filter((call) => call.method === 'pane.scroll').map((call) => call.params).at(-1)).toEqual({ pane_id: 'p1', offset_from_bottom: 60 })
  })

  it('스크롤백 맨 위 근처는 상한(max)으로 자른다(C2ⓒ)', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: { offsetFromBottom: 0, maxOffsetFromBottom: 100 } }))
    const token = await liveToken(client, session)
    expect(await session.reveal({ paneId: 'p1', row: 0, token })).toEqual({ scrolled: true, top: 0 })
    expect(client.calls.filter((call) => call.method === 'pane.scroll').map((call) => call.params)).toEqual([{ pane_id: 'p1', offset_from_bottom: 100 }])
  })

  it('스크롤 상태가 없는 pane 은 이동하지 않는다', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: null }))
    const token = await liveToken(client, session)
    expect(await session.reveal({ paneId: 'p1', row: 3, token })).toEqual({ scrolled: false, top: null })
    expect(client.calls.some((call) => call.method === 'pane.scroll')).toBe(false)
  })

  it('fix1 R1-4 — 취소(닫기·질의 변경·탭 전환)나 새 검색 뒤의 이동 요청은 뷰포트를 움직이지 않는다', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: { offsetFromBottom: 0, maxOffsetFromBottom: 100 } }))
    const token = await liveToken(client, session)
    session.cancelSearch('p1')
    expect(await session.reveal({ paneId: 'p1', row: 40, token })).toEqual({ scrolled: false, top: null })
    const second = await liveToken(client, session)
    await liveToken(client, session) // 더 새 검색
    expect(await session.reveal({ paneId: 'p1', row: 40, token: second })).toEqual({ scrolled: false, top: null })
    expect(client.calls.some((call) => call.method === 'pane.scroll')).toBe(false)
  })

  it('fix1 R1-4 — 큐에서 기다리는 사이 취소가 오면 차례가 와도 움직이지 않는다(적용 시점 = 실행 시점)', async () => {
    const { client, session } = await attached(surface({ text: 'a', scroll: { offsetFromBottom: 0, maxOffsetFromBottom: 100 } }))
    const token = await liveToken(client, session)
    // 큐 앞자리를 pane.focus 가 잡고 답하지 않게 한다 — reveal 은 그 뒤에서 기다린다
    let release: () => void = () => {}
    client.replies.set('pane.focus', () => new Promise((resolve) => { release = () => resolve({}) }))
    const hold = session.focusPane('p1')
    const moving = session.reveal({ paneId: 'p1', row: 40, token })
    await new Promise((resolve) => setTimeout(resolve, 0))
    session.cancelSearch('p1')
    release()
    await hold
    expect(await moving).toEqual({ scrolled: false, top: null })
    expect(client.calls.some((call) => call.method === 'pane.scroll')).toBe(false)
  })
})
