// GroupSession 단위 시험 — **herdr 없이** 잴 수 있는 계약만 여기서 잰다.
//
// 실물 herdr 가 있어야 아는 것(프레임률·격자 수렴·무음 실패의 서버측 거동)은 하네스가 잰다.
// 여기서 지키는 것은 그 앞단의 약속이다: 누적 병합(R7/S6)·축출(R16)·크롭 skip 판정자(P1)·
// S1 가드·격자 요청 1회(R13)·줌 격자 복원(F2-3c)·자기정합 계산(S6).

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { GroupSession, countInconsistencies, type EndpointClientLike } from './group-session.js'
import type { EndpointSurface } from './vendor/endpoint-client.js'
import type { CellData, FrameData } from './vendor/frame-types.js'
import { silentLogger } from './vendor/logger.js'

type PaneSpec = { paneId: string; x: number; width: number; text?: string }

const CELL: CellData = { symbol: ' ', fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null }

/** 가로로 나란히 놓인 pane 들의 탭 격자 하나. `text` 가 그 pane 의 내용이 된다. */
function makeSurface(input: { width: number; height: number; panes: PaneSpec[]; full: boolean }): EndpointSurface {
  const cells: CellData[] = Array.from({ length: input.width * input.height }, () => ({ ...CELL }))
  for (const pane of input.panes) {
    const text = pane.text ?? ''
    for (let i = 0; i < text.length && i < pane.width; i++) {
      cells[pane.x + i] = { ...CELL, symbol: text[i] ?? ' ' }
    }
  }
  const frame: FrameData = { cells, width: input.width, height: input.height, cursor: null, hyperlinks: [] }
  return {
    frame,
    surfaceRevision: 1,
    full: input.full,
    panes: input.panes.map((pane) => ({
      paneId: pane.paneId,
      rect: { x: pane.x, y: 0, width: pane.width, height: input.height },
      innerRect: { x: pane.x, y: 0, width: pane.width, height: input.height },
      scroll: null,
      focused: false,
      mouseReporting: false,
    })),
  }
}

class FakeClient extends EventEmitter {
  surface: EndpointSurface | null = null
  readonly resizes: Array<{ cols: number; rows: number }> = []
  readonly inputs: Array<{ paneId: string; count: number }> = []
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  /** `pane.focus` 응답과 함께 흘려보낼 첫 서피스. */
  onFocusSurface: EndpointSurface | null = null

  get currentSurface(): EndpointSurface | null {
    return this.surface
  }

  async connect(): Promise<void> {}

  assertMethod(): void {}

  async callEndpoint(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    if (method === 'pane.focus' && this.onFocusSurface !== null) this.emitSurface(this.onFocusSurface)
    return {}
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }

  sendPaneInput(paneId: string, events: unknown[]): void {
    this.inputs.push({ paneId, count: events.length })
  }

  close(): void {}

  emitSurface(surface: EndpointSurface): void {
    this.surface = surface
    this.emit('surface', surface)
  }
}

type Harness = {
  client: FakeClient
  session: GroupSession
  frames: Array<{ paneId: string; cols: number; rows: number }>
}

async function attachedSession(input: { panes: PaneSpec[]; width?: number; height?: number }): Promise<Harness> {
  const client = new FakeClient()
  const frames: Harness['frames'] = []
  const width = input.width ?? 20
  const height = input.height ?? 3
  client.onFocusSurface = makeSurface({ width, height, panes: input.panes, full: true })
  const createClient = (): EndpointClientLike => client
  const session = new GroupSession({
    socketPath: '/tmp/fake.sock',
    logger: silentLogger,
    checkConsistency: true,
    createClient,
    hooks: {
      onFrame: (frame) => frames.push({ paneId: frame.paneId, cols: frame.cols, rows: frame.rows }),
      onLayout: () => {},
      onClipboard: () => {},
      onError: () => {},
      onClose: () => {},
    },
  })
  const first = input.panes[0]
  if (first === undefined) throw new Error('pane 이 하나는 있어야 한다')
  await session.attach({ tabId: 't1', paneId: first.paneId, grid: { cols: width, rows: height } })
  return { client, session, frames }
}

describe('GroupSession 누적 병합 (R7/S6)', () => {
  it('patch 는 실려 온 pane 만 덮어쓰고 나머지는 그대로 둔다', async () => {
    const { client, session } = await attachedSession({
      panes: [
        { paneId: 'p1', x: 0, width: 10, text: 'a' },
        { paneId: 'p2', x: 10, width: 10, text: 'b' },
      ],
    })
    expect(session.panes().map((pane) => pane.paneId)).toEqual(['p1', 'p2'])

    // patch — p1 만 실려 온다. p2 는 "없다"가 아니라 "안 바뀌었다"다.
    client.emitSurface(makeSurface({ width: 20, height: 3, panes: [{ paneId: 'p1', x: 0, width: 12, text: 'c' }], full: false }))
    expect(session.panes().map((pane) => pane.paneId)).toEqual(['p1', 'p2'])
    expect(session.panes().find((pane) => pane.paneId === 'p1')?.rect.width).toBe(12)
  })

  it('전체 서피스에서 빠진 pane 은 명부에서 축출된다', async () => {
    const { client, session } = await attachedSession({
      panes: [
        { paneId: 'p1', x: 0, width: 10 },
        { paneId: 'p2', x: 10, width: 10 },
      ],
    })
    client.emitSurface(makeSurface({ width: 20, height: 3, panes: [{ paneId: 'p1', x: 0, width: 20 }], full: true }))
    expect(session.hasPane('p2')).toBe(false)
  })

  it('control 층이 pane 소실을 보면 전체 서피스를 기다리지 않고 뺀다 (R16)', async () => {
    const { session } = await attachedSession({
      panes: [
        { paneId: 'p1', x: 0, width: 10 },
        { paneId: 'p2', x: 10, width: 10 },
      ],
    })
    session.evictPanes(['p2'])
    expect(session.hasPane('p2')).toBe(false)
    expect(session.hasPane('p1')).toBe(true)
  })
})

describe('크롭 skip 은 해시가 판정한다 (P1)', () => {
  it('서버가 실어 보내도 내용이 같으면 프레임을 내지 않는다', async () => {
    const { client, frames, session } = await attachedSession({ panes: [{ paneId: 'p1', x: 0, width: 10, text: 'a' }] })
    const afterAttach = frames.length
    expect(afterAttach).toBe(1)

    // 같은 내용을 patch 로 다시 실어 보낸다 — 서버는 "바뀌었다"고 말하지만 해시는 그대로다.
    client.emitSurface(makeSurface({ width: 20, height: 3, panes: [{ paneId: 'p1', x: 0, width: 10, text: 'a' }], full: false }))
    expect(frames.length).toBe(afterAttach)
    expect(session.counterSnapshot().skipped).toBe(1)

    // 내용이 바뀌면 낸다.
    client.emitSurface(makeSurface({ width: 20, height: 3, panes: [{ paneId: 'p1', x: 0, width: 10, text: 'z' }], full: false }))
    expect(frames.length).toBe(afterAttach + 1)
  })

  it('내용이 같아도 크기가 다르면 다시 낸다', async () => {
    const { client, frames } = await attachedSession({ panes: [{ paneId: 'p1', x: 0, width: 10, text: 'a' }] })
    const before = frames.length
    client.emitSurface(makeSurface({ width: 20, height: 3, panes: [{ paneId: 'p1', x: 0, width: 12, text: 'a' }], full: false }))
    expect(frames.length).toBe(before + 1)
    expect(frames[frames.length - 1]?.cols).toBe(12)
  })
})

describe('S1 무음 실패 가드', () => {
  it('붙은 탭에 없는 pane 으로 가는 입력은 보내기 전에 막고 센다', async () => {
    const { client, session } = await attachedSession({ panes: [{ paneId: 'p1', x: 0, width: 10 }] })
    session.input({ paneId: 'ghost', data: Buffer.from('ls\r', 'utf8') })
    expect(client.inputs).toHaveLength(0)
    expect(session.counterSnapshot().blockedInputs).toBe(1)

    session.input({ paneId: 'p1', data: Buffer.from('ls\r', 'utf8') })
    expect(client.inputs).toHaveLength(1)
    expect(client.inputs[0]?.paneId).toBe('p1')
  })

  it('축출된 pane 으로 가는 입력도 막는다 (patch 가 소실을 안 알려 주는 구간)', async () => {
    const { client, session } = await attachedSession({
      panes: [
        { paneId: 'p1', x: 0, width: 10 },
        { paneId: 'p2', x: 10, width: 10 },
      ],
    })
    session.evictPanes(['p2'])
    session.input({ paneId: 'p2', data: Buffer.from('x', 'utf8') })
    expect(client.inputs).toHaveLength(0)
    expect(session.counterSnapshot().blockedInputs).toBe(1)
  })
})

describe('격자 요청 (R13·S3)', () => {
  it('같은 격자는 다시 보내지 않는다', async () => {
    const { client, session } = await attachedSession({ panes: [{ paneId: 'p1', x: 0, width: 10 }] })
    const before = { resizes: client.resizes.length, counted: session.counterSnapshot().gridRequests }
    session.requestGrid({ cols: 40, rows: 10 })
    session.requestGrid({ cols: 40, rows: 10 })
    expect(client.resizes.length).toBe(before.resizes + 1)
    expect(session.counterSnapshot().gridRequests).toBe(before.counted + 1)
  })

  it('줌 해제는 줌 직전 격자를 그대로 되돌린다 (F2-3c)', async () => {
    const { client, session } = await attachedSession({
      panes: [
        { paneId: 'p1', x: 0, width: 10 },
        { paneId: 'p2', x: 10, width: 10 },
      ],
    })
    session.requestGrid({ cols: 40, rows: 12 })
    session.zoom({ paneId: 'p1', boxGrid: { cols: 40, rows: 12 } })
    const zoomed = client.resizes[client.resizes.length - 1]
    expect(zoomed).not.toEqual({ cols: 40, rows: 12 })
    session.zoom({ paneId: null, boxGrid: { cols: 40, rows: 12 } })
    expect(client.resizes[client.resizes.length - 1]).toEqual({ cols: 40, rows: 12 })
  })
})

describe('연결 내 자기정합 (S6 — §10-R14)', () => {
  const frame = { width: 20, height: 4 }
  const pane = (input: { x: number; width: number; innerX?: number; innerWidth?: number }) => ({
    paneId: `p${input.x}`,
    rect: { x: input.x, y: 0, width: input.width, height: 4 },
    innerRect: { x: input.innerX ?? input.x, y: 0, width: input.innerWidth ?? input.width, height: 4 },
    focused: false,
    mouseReporting: false,
    scroll: null,
  })

  it('빈틈 없이 나눠 덮으면 위반 0', () => {
    expect(countInconsistencies(frame, [pane({ x: 0, width: 10 }), pane({ x: 10, width: 10 })])).toBe(0)
  })

  it('겹치면 잡는다', () => {
    expect(countInconsistencies(frame, [pane({ x: 0, width: 12 }), pane({ x: 10, width: 10 })])).toBeGreaterThan(0)
  })

  it('inner 가 rect 를 벗어나면 잡는다', () => {
    expect(countInconsistencies(frame, [pane({ x: 0, width: 20, innerWidth: 24 })])).toBeGreaterThan(0)
  })

  it('합이 프레임을 못 채우면 잡는다 (stale rect)', () => {
    expect(countInconsistencies(frame, [pane({ x: 0, width: 10 })])).toBeGreaterThan(0)
  })
})
