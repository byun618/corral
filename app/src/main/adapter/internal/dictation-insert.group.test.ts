// LIFE-834 fix1 G1 — 받아쓰기 넣기를 **실제 GroupSession**(S1 가드·탭 전환 때 명부 비움) 위에서 본다. 시작 때 고정한 pane(p1, 탭 t1)이 있는 영역이
// 다른 탭(t2)으로 옮겨 가면 p1 은 붙은 명부에서 빠지고, 기존 stream 길(`input`)은 막혀 조용히 버려진다. 받아쓰기 넣기는 그때 guard `pane.send_text`
// 로 p1 에 보내 막히지 않아야 한다. main 배선(`index.ts`)과 같은 모양으로 묶는다: heldPaneIds = 연결이 쥔 pane, paste = 연결의 input.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createDictationInserter } from '../../dictation.js'
import { GroupSession, type EndpointClientLike } from './group-session.js'
import type { EndpointSurface } from './vendor/endpoint-client.js'
import type { CellData, FrameData } from './vendor/frame-types.js'
import { silentLogger } from './vendor/logger.js'

const CELL: CellData = { symbol: ' ', fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null }

function surface(paneIds: string[]): EndpointSurface {
  const width = 10 * paneIds.length
  const frame: FrameData = { cells: Array.from({ length: width * 3 }, () => ({ ...CELL })), width, height: 3, cursor: null, hyperlinks: [] }
  return {
    frame,
    surfaceRevision: 1,
    full: true,
    panes: paneIds.map((paneId, index) => ({
      paneId,
      rect: { x: index * 10, y: 0, width: 10, height: 3 },
      innerRect: { x: index * 10, y: 0, width: 10, height: 3 },
      scroll: null,
      focused: false,
      mouseReporting: false,
    })),
  }
}

class FakeClient extends EventEmitter {
  surface: EndpointSurface | null = null
  onFocusSurface: EndpointSurface | null = null
  readonly inputs: Array<{ paneId: string; count: number }> = []
  get currentSurface(): EndpointSurface | null {
    return this.surface
  }
  async connect(): Promise<void> {}
  assertMethod(): void {}
  async callEndpoint(method: string): Promise<unknown> {
    if (method === 'pane.focus' && this.onFocusSurface !== null) {
      this.surface = this.onFocusSurface
      this.emit('surface', this.onFocusSurface)
    }
    return {}
  }
  resize(): void {}
  sendPaneInput(paneId: string, events: unknown[]): void {
    this.inputs.push({ paneId, count: events.length })
  }
  close(): void {}
}

async function setup() {
  const client = new FakeClient()
  client.onFocusSurface = surface(['p1', 'p2'])
  const createClient = (): EndpointClientLike => client
  const session = new GroupSession({
    socketPath: '/tmp/fake.sock',
    logger: silentLogger,
    checkConsistency: true,
    createClient,
    hooks: { onFrame: () => {}, onLayout: () => {}, onClipboard: () => {}, onError: () => {}, onClose: () => {} },
  })
  await session.attach({ tabId: 't1', paneId: 'p1', grid: { cols: 20, rows: 3 } })
  const sent: Array<{ paneId: string; text: string }> = []
  const inserter = createDictationInserter({
    heldPaneIds: () => session.panes().map((pane) => pane.paneId),
    paste: ({ paneId, data }) => session.input({ paneId, data: Buffer.from(data, 'utf8') }),
    sendText: async (input) => {
      sent.push(input)
    },
    log: () => undefined,
  })
  return { client, session, sent, inserter }
}

describe('G1 — 실제 GroupSession: 다른 탭이 붙은 상태에서 고정 pane 으로 보낸 받아쓰기 입력이 막히지 않는다', () => {
  it('붙은 탭(t1)의 고정 pane p1 → stream 길로 들어간다(send_text 안 씀)', async () => {
    const h = await setup()
    expect(await h.inserter.insert({ paneId: 'p1', text: '워크트리 목록' })).toEqual({ ok: true, via: 'paste' })
    expect(h.client.inputs.map((input) => input.paneId)).toEqual(['p1'])
    expect(h.sent).toEqual([])
    expect(h.session.counterSnapshot().blockedInputs).toBe(0)
  })
  it('같은 영역이 탭 t2 로 옮겨 간 뒤 고정 pane p1 → S1 가드에 막히지 않고 send_text 로 p1 에 간다', async () => {
    const h = await setup()
    h.client.onFocusSurface = surface(['p3'])
    await h.session.focusTab({ tabId: 't2', paneId: 'p3' })
    // 전제: 실제 세션은 p1 을 더 이상 쥐지 않는다 — 기존 길이면 여기서 막혀 버려진다
    expect(h.session.hasPane('p1')).toBe(false)
    expect(await h.inserter.insert({ paneId: 'p1', text: '리뷰 결과를 요약해줘.' })).toEqual({ ok: true, via: 'send-text' })
    expect(h.sent).toEqual([{ paneId: 'p1', text: '리뷰 결과를 요약해줘.' }])
    expect(h.session.counterSnapshot().blockedInputs).toBe(0)
    // 지금 붙은 p3 로 새지 않는다
    expect(h.client.inputs).toEqual([])
  })
})
