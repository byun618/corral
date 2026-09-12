// 어댑터 stream 층 — 벤더한 endpoint 코어(herdr-client.sock)를 corral 타입으로 감싼다.
//
// 02-rebuild-plan §1 의 두 번째 접촉면이다. control 층(link.ts, herdr.sock)과는 **다른 소켓의
// 별개 연결**이고, 순서 보장이 없다 (00-analysis §3-1 — 그 어긋남은 A3 가 관찰만 한다).
//
// 단일 뷰 원칙: 살아 있는 endpoint 연결은 **한 번에 하나**다. pane 을 바꾸면 이전 세션을 닫고
// 새로 연다 — Studio 는 pane 마다 세션을 캐시하지만(terminal-bridge 참고), corral R2 는
// 화면에 터미널이 하나뿐이라 연결 N개를 유지할 이유가 없다 (멀티 pane 비용은 R0 범위).
// 전환 비용은 S6 이 잰다 — p95 가 통과선(1초)을 넘으면 그때 캐시를 검토한다.
//
// DEC 2026 (synchronized output): 프레임을 BSU/ESU 로 감싼다. 근거 (A2 기록 대상):
//   · 프레임은 전체 리페인트라 IPC·xterm write 청크 분할 중간 페인트(티어링)가 보일 수 있고,
//     BSU/ESU 는 정확히 그걸 막는다 (xterm 6.0 내장 #5453, 외부 검증 — 00-analysis §4-4)
//   · ED2 의 뷰포트 리셋(#5801)은 sync 로 안 막히지만 corral 은 scrollback 0 이라 무력화
//   · 타임아웃 1초 하드코딩 — 프레임 하나를 한 번의 write 로 보내므로 걸릴 일이 없다

import { EndpointTerminalSession } from './vendor/endpoint-terminal-session.js'
import { corralLogger } from './vendor/logger.js'
import type { TerminalFrame, TerminalScroll, TerminalState } from '../../../shared/types.js'
import { log } from '../../log.js'

const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'
const textEncoder = new TextEncoder()

export type StreamHooks = {
  /** 프레임 하나가 왔다 — 그대로 renderer 로 민다. */
  onFrame: (frame: TerminalFrame) => void
  /** phase·오류가 바뀌었다 — AppState 재전송 신호. */
  onState: () => void
  /** pane 안에서 OSC 52 복사가 왔다 (base64 디코드 완료). */
  onClipboard: (text: string) => void
}

/**
 * 벤더 세션이 'terminal' 로 주는 페이로드 — 벤더 코드의 모양이라 이 파일 밖으로 안 낸다.
 * (frame 필드는 셀 격자인데 corral 은 ANSI 바이트만 쓴다 — 셀은 여기서 버린다.)
 */
type VendorTerminalEvent = {
  seq: number
  width: number
  height: number
  full: boolean
  mouseReporting: boolean
  bytes: Buffer
}

export class TerminalStream {
  private readonly hooks: StreamHooks
  private session: EndpointTerminalSession | null = null
  /** 세대 — 늦게 도착한 옛 세션의 이벤트가 새 상태를 덮지 않게 (link.ts 와 같은 수법). */
  private generation = 0
  private state: TerminalState = {
    paneId: null,
    phase: 'idle',
    cols: null,
    rows: null,
    mouseReporting: false,
    lastError: null,
  }

  constructor(hooks: StreamHooks) {
    this.hooks = hooks
  }

  terminalState(): TerminalState {
    return { ...this.state }
  }

  /**
   * pane 하나로 스트림을 연다. 이전 세션은 닫는다.
   *
   * 벤더 세션의 terminalId 자리에는 paneId 를 그대로 넣는다 — Studio 는 terminalId → paneId
   * 조회가 필요했지만 corral 은 목록에서 이미 paneId 를 안다. lookup 은 즉시 반환.
   */
  open(input: { clientSocketPath: string; paneId: string; cols: number; rows: number }): void {
    this.close()
    this.generation += 1
    const generation = this.generation
    const stale = (): boolean => generation !== this.generation

    const session = new EndpointTerminalSession(
      input.clientSocketPath,
      input.paneId,
      async () => input.paneId,
      corralLogger,
    )
    this.session = session
    this.state = {
      paneId: input.paneId,
      phase: 'connecting',
      cols: null,
      rows: null,
      mouseReporting: false,
      lastError: null,
    }
    log('stream.open', { paneId: input.paneId, cols: input.cols, rows: input.rows, generation })
    this.hooks.onState()

    session.on('terminal', (event: VendorTerminalEvent) => {
      if (stale()) return
      // BSU/ESU 래핑 — 문자열 결합 대신 바이트로 한 번에 만든다.
      const head = textEncoder.encode(BSU)
      const tail = textEncoder.encode(ESU)
      const data = new Uint8Array(head.length + event.bytes.length + tail.length)
      data.set(head, 0)
      data.set(event.bytes, head.length)
      data.set(tail, head.length + event.bytes.length)
      const changed =
        this.state.phase !== 'streaming' ||
        this.state.cols !== event.width ||
        this.state.rows !== event.height ||
        this.state.mouseReporting !== event.mouseReporting
      this.state = {
        ...this.state,
        phase: 'streaming',
        cols: event.width,
        rows: event.height,
        mouseReporting: event.mouseReporting,
      }
      log('stream.frame', {
        paneId: input.paneId,
        seq: event.seq,
        cols: event.width,
        rows: event.height,
        bytes: event.bytes.length,
        mouseReporting: event.mouseReporting,
      })
      this.hooks.onFrame({
        paneId: input.paneId,
        seq: event.seq,
        cols: event.width,
        rows: event.height,
        mouseReporting: event.mouseReporting,
        data,
      })
      if (changed) this.hooks.onState()
    })

    session.on('clipboard', (payload: { data: string }) => {
      if (stale()) return
      // 벤더가 base64 유효성은 이미 걸렀다 (terminal-clipboard.ts). 여기서 UTF-8 로 푼다.
      const text = Buffer.from(payload.data, 'base64').toString('utf8')
      log('stream.clipboard', { paneId: input.paneId, bytes: text.length })
      this.hooks.onClipboard(text)
    })

    session.on('error', (error: unknown) => {
      if (stale()) return
      const message = error instanceof Error ? error.message : String(error)
      log('stream.error', { paneId: input.paneId, error: message })
      this.state = { ...this.state, lastError: message }
      this.hooks.onState()
    })

    session.on('close', () => {
      if (stale()) return
      log('stream.closed', { paneId: input.paneId })
      if (this.state.phase !== 'idle') {
        this.state = { ...this.state, phase: 'failed' }
        this.hooks.onState()
      }
    })

    session.connect(input.cols, input.rows).catch((error: unknown) => {
      if (stale()) return
      const message = error instanceof Error ? error.message : String(error)
      log('stream.connect_failed', { paneId: input.paneId, error: message })
      this.state = { ...this.state, phase: 'failed', lastError: message }
      this.hooks.onState()
    })
  }

  /** xterm onData 그대로 — 분류(VtInputClassifier)는 벤더 세션 안에서 돈다. */
  input(data: string): void {
    this.session?.input(Buffer.from(data, 'utf8'))
  }

  resize(size: { cols: number; rows: number }): void {
    if (this.session === null || this.session.isClosed) return
    log('stream.resize', { paneId: this.state.paneId, cols: size.cols, rows: size.rows })
    this.session.resize(size.cols, size.rows)
  }

  /** wheel → mouseReporting pane 은 마우스 이벤트로, 아니면 pane.scroll RPC — 벤더가 가른다. */
  scroll(scroll: TerminalScroll): void {
    log('stream.scroll', { paneId: this.state.paneId, ...scroll })
    this.session?.scroll(scroll.direction, scroll.lines, scroll.column, scroll.row, 'wheel')
  }

  close(): void {
    this.generation += 1
    if (this.session !== null) {
      log('stream.close', { paneId: this.state.paneId })
      this.session.close()
      this.session = null
    }
    this.state = { paneId: null, phase: 'idle', cols: null, rows: null, mouseReporting: false, lastError: null }
  }
}
