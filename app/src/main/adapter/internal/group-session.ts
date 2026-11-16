// 어댑터 stream 층 ② — **영역 하나 = endpoint 연결 하나 = 탭 하나**.
//
// LIFE-353 의 `EndpointTerminalSession`(벤더)은 "연결 1개 = pane 1개"였다. 그 모양으로는 ② 를
// 못 짓는다: endpoint 서피스는 **탭 전체 격자**라 pane 마다 연결을 열면 같은 탭을 N 번 받게 되고,
// `pane.focus` 가 세션 전역 포커스를 움직여 서로 탭을 뺏는다(3차 스파이크 T3b).
// 그래서 연결의 단위를 pane 에서 **영역(=동시에 보이는 탭)** 으로 올린다 — 01-criteria §0-1
// "연결 수 = 동시에 보이는 탭 수 = 영역 수".
//
// 이 파일이 지는 계약 (근거: 01-criteria §10):
//   · **R7/S6 — 누적 병합**: patch 의 `panes` 는 *바뀐 pane 만* 싣는다(벤더 수정 ②의 `full`).
//     전체 서피스는 명부를 교체하고, patch 는 덮어쓴다. 명부에서 빠진 pane 은 **축출**한다 —
//     stale pane 이 남으면 S1 가드를 통과해 herdr 가 입력을 조용히 버린다
//   · **P1 — 크롭 skip**: 판정자는 **크롭 셀 해시**다. 서버의 "바뀐 pane" 목록은 후보를 좁히는
//     데만 쓰고 승격시키지 않는다. 해시가 같으면 xterm 에 아무것도 쓰지 않는다
//   · **S1 — 무음 실패 가드**: 붙어 있는 탭 밖 pane 으로 가는 입력은 herdr 가 **오류 없이 버린다**.
//     명부에 없는 pane 이면 보내기 전에 막고 센다
//   · **R13 — 격자 왕복 제거**: `fit()`→`termResize` 수렴 루프가 없다. 영역 상자 px 를 렌더러가
//     격자로 바꿔 **연결당 1회** 요청하고, 그 응답 rect 가 pane DOM 상자의 진실이 된다
//   · **R16 — C2 숨은 의존**: LIFE-353 관문 `s5-grid.mjs` 가 main 의 `vendor.debug` 두 줄
//     (`"resize request"`·`"surface"`)을 센다. **형식을 그대로 유지한다** — 지우면 LIFE-353 S5 가
//     행동이 맞아도 조용히 타임아웃한다
//   · **R8/F2-3c — 줌**: herdr 서피스는 줌을 반영하지 않는다(프리플라이트 ②). 클라이언트가
//     격자 역산으로 그리고, 해제 시에는 **줌 직전 요청 격자를 그대로 재전송**한다

import { EndpointClient, type EndpointSurface } from './vendor/endpoint-client.js'
import { cropFrame } from './vendor/endpoint-terminal-session.js'
import { frameToAnsi } from './vendor/frame-to-ansi.js'
import type { FrameData } from './vendor/frame-types.js'
import type { Logger } from './vendor/logger.js'
import { MOUSE_KIND, VtInputClassifier, type PaneInputEvent } from './vendor/vt-input-classifier.js'

/**
 * 이 클래스가 실제로 쓰는 endpoint 클라이언트의 표면.
 *
 * `EndpointClient` 가 구조적으로 이걸 만족한다. 테스트는 같은 모양의 가짜를 넣어 **herdr 없이**
 * 병합·축출·해시 skip·S1 가드를 잰다 (단언 캐스팅 없이).
 */
export interface EndpointClientLike {
  readonly currentSurface: EndpointSurface | null
  // 이벤트마다 페이로드를 박아 둔다 — EventEmitter 의 느슨한 `(...args: any[])` 리스너가
  // 이 좁은 모양에 그대로 들어맞고, 가짜 클라이언트도 같은 계약을 진다.
  on(event: 'surface', listener: (surface: EndpointSurface) => void): unknown
  on(event: 'clipboard', listener: (payload: { data: string }) => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
  off(event: 'surface', listener: (surface: EndpointSurface) => void): unknown
  off(event: 'close', listener: () => void): unknown
  connect(cols: number, rows: number): Promise<void>
  assertMethod(method: string): void
  callEndpoint(method: string, params: Record<string, unknown>): Promise<unknown>
  resize(cols: number, rows: number): void
  sendPaneInput(paneId: string, events: PaneInputEvent[]): void
  close(): void
}

const ESC_FLUSH_MS = 25
const FIRST_SURFACE_WAIT_MS = 10_000
const COMMAND_TIMEOUT_MS = 10_000

export type CellRect = { x: number; y: number; width: number; height: number }

/** 서피스가 말해 준 pane 하나의 기하 — 벤더 wire 모양을 corral 어휘로 옮긴 것. */
export type PaneView = {
  paneId: string
  /** 장식(테두리·스크롤바)까지 포함한 바깥 사각형, 탭 격자 기준 셀 좌표. */
  rect: CellRect
  /** 내용만. corral 이 크롭해 xterm 에 싣는 범위. */
  innerRect: CellRect
  focused: boolean
  mouseReporting: boolean
  scroll: { offsetFromBottom: number; maxOffsetFromBottom: number } | null
}

export type GroupFrame = {
  paneId: string
  seq: number
  cols: number
  rows: number
  mouseReporting: boolean
  bytes: Buffer
}

export type GroupSessionHooks = {
  /** 크롭 해시가 바뀐 pane 하나의 프레임. 안 바뀐 pane 은 여기로 오지 않는다 (P1). */
  onFrame: (frame: GroupFrame) => void
  /** 명부(pane 기하)가 갱신됐다 — 레이아웃 재계산 신호. */
  onLayout: (panes: PaneView[]) => void
  onClipboard: (text: string) => void
  onError: (message: string) => void
  onClose: () => void
}

/** pane 마다 따로 드는 입력 상태. 연결당 하나로 두면 두 pane 의 시퀀스가 섞인다 (§10-R16). */
type PaneIo = {
  classifier: VtInputClassifier
  pressedMouseButtons: Set<number>
  escFlushTimer: ReturnType<typeof setTimeout> | null
  seq: number
  /** 마지막으로 xterm 에 실은 크롭의 지문 (P1 판정자). null = 아직 실은 적 없음. */
  hash: { a: number; b: number } | null
}

export type GroupCounters = {
  /**
   * 이 연결이 실제로 받은 **서피스 수** (§10-R27-1).
   *
   * P2 의 분모다. 별도 연결로 잰 F 는 **그 관측자의 소화 속도**까지 같이 재 버린다 —
   * herdr 는 연결마다 따로 밀고, 느린 소비자에게는 뭉쳐서 준다. 그래서 "pane 당 렌더가
   * 탭 프레임률을 넘었다"를 가릴 유일한 자리는 **받은 쪽의 셈**이다.
   */
  surfaces: number
  /** 서피스에 실려 온 (pane × 프레임) 후보 수. */
  candidates: number
  /** 그중 해시가 같아 xterm 쓰기를 건너뛴 수 (P1 이 걷어낸 몫). */
  skipped: number
  /** S1 가드가 막은 입력 수 — 붙은 탭 밖 pane 으로 가려던 것. */
  blockedInputs: number
  /**
   * **모르는 pane 이라 조용히 지나간 수** (L11).
   *
   * 두 자리가 여기로 모인다 — `zoom()` 의 "붙은 탭 밖 pane 을 줌하려 했다" 와 `onSurface()` 의
   * "서피스에 실려 왔는데 이 연결의 meta 에 없다". 둘 다 `allows()` 와 달리 **카운터도 로그도
   * 없이** 되돌아가서, 화면이 조용히 안 움직일 때 ⓐ 안 왔다 ⓑ 왔는데 버렸다 를 가를 수 없었다.
   * 후보로조차 안 세는 자리라 `candidates` 로는 안 보인다.
   */
  unknownPanes: number
  /** 연결 내 자기정합 위반 (S6): rect 합 != frame · inner ⊄ rect · pane 간 겹침. */
  inconsistencies: number
  /** 이 연결이 보낸 `client.resize` 횟수 (S3·R13-b). */
  gridRequests: number
}

/**
 * 영역 하나가 붙어 있는 endpoint 연결.
 *
 * 수명: `attach()` 로 탭에 붙고 → 서피스가 흐르고 → `close()`. 탭을 바꾸면 `focusTab()` 으로
 * 같은 연결을 다시 스코프한다 (연결을 새로 열지 않는다 — S4 는 연결 수가 영역 수를 넘지 않기를 요구).
 */
export class GroupSession {
  private readonly client: EndpointClientLike
  private readonly logger: Logger
  private readonly hooks: GroupSessionHooks
  private readonly checkConsistency: boolean
  /** 붙어 있는 탭 (S1 가드의 기준). null = 아직 안 붙었다. */
  private attachedTabId: string | null = null
  /** 누적 pane 명부 — 전체 서피스가 교체, patch 가 덮어쓴다 (R7). */
  private meta = new Map<string, PaneView>()
  private io = new Map<string, PaneIo>()
  /** 영역 상자가 담을 수 있는 격자 (렌더러가 잰 것). 서버에 보내는 값은 여기에 가장자리 장식을 더한 것. */
  private boxGrid = { cols: 0, rows: 0 }
  /** 마지막으로 서버에 보낸 격자. */
  private requestedGrid = { cols: 0, rows: 0 }
  /**
   * **가장자리 장식** — 프레임에서 어떤 pane 의 내용도 덮지 않는 바깥쪽 셀 수 (상하/좌우 합).
   *
   * 프레임의 빈 셀은 두 종류다: pane **사이**의 것과 **가장자리**의 것. 사이의 것은 corral 이
   * 실제 간격으로 그리므로(§10-R12) 상자 안에서 자리를 차지한다 — 더해 주면 안 된다.
   * 가장자리의 것(스크롤바 열 등)은 아무도 안 그리므로 그만큼 **더 요청해야** 내용이 상자를
   * 꽉 채운다. 단일 pane 에서 이 값이 (1,0) 이고, 그래서 LIFE-353 과 같은 xterm 격자가 나온다(C2).
   *
   * 값은 서피스에서 배운다. pane 트리가 바뀔 때만 달라지므로 창 드래그 중에는 고정이다 —
   * 즉 드래그 1회당 요청은 연결당 1회로 남는다 (S3·R13-b).
   */
  private edgeWaste = { cols: 0, rows: 0 }
  private zoomedPaneId: string | null = null
  private closed = false
  /**
   * attach/탭 이동이 끝나기 전에 온 서피스는 **옛 탭의 것일 수 있다** — 그걸 명부에 섞으면
   * S1 가드가 남의 탭 pane 을 통과시킨다. 붙는 동안은 무시하고, 붙은 뒤 최신 서피스를 한 번
   * 되돌려 처리한다(focusTab 끝의 replay).
   */
  private attaching = false
  private commandChain: Promise<unknown> = Promise.resolve()
  private counters: GroupCounters = {
    surfaces: 0,
    candidates: 0,
    skipped: 0,
    blockedInputs: 0,
    unknownPanes: 0,
    inconsistencies: 0,
    gridRequests: 0,
  }

  constructor(input: {
    socketPath: string
    logger: Logger
    hooks: GroupSessionHooks
    /** 개발·계측 실행에서만 자기정합을 매 프레임 검사한다 (S6 런타임 assert). */
    checkConsistency: boolean
    /** 테스트가 가짜 클라이언트를 넣는 자리. 평시엔 실제 endpoint 소켓. */
    createClient?: (socketPath: string) => EndpointClientLike
  }) {
    this.logger = input.logger
    this.hooks = input.hooks
    this.checkConsistency = input.checkConsistency
    this.client = (input.createClient ?? ((socketPath: string) => new EndpointClient(socketPath)))(input.socketPath)
    this.client.on('surface', (surface: EndpointSurface) => this.onSurface(surface))
    this.client.on('clipboard', (payload: { data: string }) => {
      if (this.closed) return
      this.hooks.onClipboard(Buffer.from(payload.data, 'base64').toString('utf8'))
    })
    this.client.on('error', (error: unknown) => {
      if (this.closed) return
      this.hooks.onError(error instanceof Error ? error.message : String(error))
    })
    this.client.on('close', () => {
      this.close()
      this.hooks.onClose()
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  get tabId(): string | null {
    return this.attachedTabId
  }

  get grid(): { cols: number; rows: number } {
    return { ...this.requestedGrid }
  }

  get zoomedPane(): string | null {
    return this.zoomedPaneId
  }

  panes(): PaneView[] {
    return [...this.meta.values()]
  }

  hasPane(paneId: string): boolean {
    return this.meta.has(paneId)
  }

  counterSnapshot(): GroupCounters {
    return { ...this.counters }
  }

  /**
   * 연결을 열고 탭에 붙인다.
   *
   * `pane.focus` 는 **이 연결의 서피스를 그 pane 의 탭으로 좁히는 유일한 수단**이다(벤더 주석,
   * 3차 T3b). 그래서 attach 시점의 focus 는 구조적 비용으로 §10-R1 이 받아들였다 — S2 가 금지하는
   * 것은 *붙은 뒤*의 발사다.
   */
  async attach(input: { tabId: string; paneId: string; grid: { cols: number; rows: number } }): Promise<void> {
    if (this.closed) throw new Error('group session is closed')
    this.boxGrid = { cols: input.grid.cols, rows: input.grid.rows }
    this.requestedGrid = { cols: input.grid.cols, rows: input.grid.rows }
    await this.client.connect(input.grid.cols, input.grid.rows)
    this.client.assertMethod('pane.focus')
    this.logger.debug('resize request', { cols: input.grid.cols, rows: input.grid.rows, kind: 'attach' })
    this.counters.gridRequests += 1
    await this.focusTab({ tabId: input.tabId, paneId: input.paneId })
  }

  /**
   * 이 연결을 다른 탭으로 옮긴다 (영역이 보는 탭이 바뀌었다).
   *
   * 명부는 탭 단위라 통째로 비운다 — 옛 탭의 pane 이 남아 있으면 S1 가드가 그 pane 으로 가는
   * 입력을 통과시키고 herdr 가 조용히 버린다.
   */
  async focusTab(input: { tabId: string; paneId: string }): Promise<void> {
    if (this.closed) throw new Error('group session is closed')
    // LIFE-824 Zⓒ — 줌을 든 채 탭을 떠나면 로컬 줌만 풀리고 herdr `pane.zoom` 깃발은 켜진 채 남았다(base 실측 `raw/claude/z-base-2.jsonl`:
    // 탭 전환 뒤 local=null · herdr zoomed=true, 돌아와도 그대로). 떠나는 탭의 깃발도 끈다 — 붙기 전(`attaching` 동안이라 그 사이 서피스는 버린다).
    const leavingZoom = this.attachedTabId !== input.tabId ? this.zoomedPaneId : null
    if (this.attachedTabId !== input.tabId) {
      for (const paneId of [...this.io.keys()]) this.evictIo(paneId)
      this.meta.clear()
    }
    this.attachedTabId = input.tabId
    this.zoomedPaneId = null
    this.attaching = true
    try {
      if (leavingZoom !== null) {
        await this.enqueue(() => this.client.callEndpoint('pane.zoom', { pane_id: leavingZoom, mode: 'off' })).catch((error: unknown) => {
          // 깃발 정리는 정합용이다 — 실패해도 탭 전환은 계속한다(그림은 클라이언트가 그린다).
          this.logger.warn('zoom flag off on tab leave failed', { paneId: leavingZoom, error: error instanceof Error ? error.message : String(error) })
        })
      }
      await this.enqueue(() => this.client.callEndpoint('pane.focus', { pane_id: input.paneId }))
    } finally {
      this.attaching = false
    }
    const current = this.client.currentSurface
    if (current !== null && current.panes.some((pane) => pane.paneId === input.paneId)) this.onSurface(current)
    await this.waitForPane(input.paneId)
  }

  /**
   * **뷰어가 새로 붙었다 — 마지막 서피스를 그 pane 에 다시 그린다** (S6).
   *
   * 프레임은 내용이 바뀔 때만 나간다(크롭 해시). 그래서 탭을 바꾸면 이런 일이 생긴다:
   * main 은 붙자마자 프레임을 한 번 내보내는데, 렌더러의 그 pane 상자는 **그 다음 상태 전파에서야**
   * 생긴다(상자 좌표가 서피스에서 오므로). 새 xterm 은 이미 지나간 프레임을 못 듣고, pane 이
   * 놀고 있으면 다음 프레임도 안 와서 **빈 화면으로 남는다** — 실측: 탭 전환 10/10 이 빈 화면.
   *
   * 해시를 지우고 같은 서피스를 한 번 더 흘린다. 서버에는 아무것도 안 보낸다(격자 요청 0).
   */
  repaint(paneId: string): void {
    if (this.closed) return
    const surface = this.client.currentSurface
    const io = this.io.get(paneId)
    if (surface === null || surface === undefined || io === undefined) return
    io.hash = null
    this.onSurface(surface)
  }

  /**
   * 같은 탭 안에서 포커스 pane 을 옮긴다 (S2 — 클릭·명시 단축키에서만 부른다).
   *
   * herdr 의 `focused_pane_id` 를 corral 의 포커스와 맞추는 유일한 수단이고(S2-b), 0.9.0 의
   * per-client 포커스라 다른 클라이언트의 탭을 끌고 가지 않는다.
   */
  async focusPane(paneId: string): Promise<void> {
    if (!this.allows(paneId)) return
    await this.enqueue(() => this.client.callEndpoint('pane.focus', { pane_id: paneId }))
  }

  /**
   * 영역 상자가 정한 격자를 **1회** 요청한다 (R13).
   *
   * 같은 격자면 보내지 않는다 — 창 드래그 한 번에 연결당 요청 1회(S3)가 여기서 지켜진다.
   * `force` 는 뷰어 교체처럼 같은 크기 리페인트가 필요한 자리에서만.
   */
  requestGrid(input: { cols: number; rows: number; kind?: string; force?: boolean }): void {
    if (this.closed) return
    this.boxGrid = { cols: clampGrid(input.cols), rows: clampGrid(input.rows) }
    // 줌 중이면 격자의 뜻이 다르다 — 그 pane 의 inner 가 상자와 같아지도록 역산한다 (F2-3b).
    this.sendGrid({ ...input, cols: this.boxGrid.cols + this.edgeWaste.cols, rows: this.boxGrid.rows + this.edgeWaste.rows })
  }

  /** 서버에 보내는 마지막 관문 — 같은 격자면 안 보낸다 (S3). */
  private sendGrid(input: { cols: number; rows: number; kind?: string; force?: boolean }): void {
    const cols = clampGrid(input.cols)
    const rows = clampGrid(input.rows)
    if (!input.force && cols === this.requestedGrid.cols && rows === this.requestedGrid.rows) return
    this.requestedGrid = { cols, rows }
    // 벤더 수정 ③ 과 **같은 형식** — LIFE-353 S5 하네스가 이 줄을 센다 (§10-R16).
    this.logger.debug('resize request', { cols, rows, kind: input.kind ?? 'viewer' })
    this.counters.gridRequests += 1
    this.client.resize(cols, rows)
  }

  /**
   * 줌 — **서피스가 줌을 반영한다**. 그래서 격자는 늘 상자 격자(+가장자리 보정) 하나뿐이다.
   *
   * 프리플라이트 ② 는 "서버 rect 는 줌을 안 따른다"로 읽혔고 기준서도 그 문장을 실었지만,
   * 그건 **control 소켓(제3 오라클)이 보는 기본 배치**였다. endpoint 연결에서는 다르다 —
   * 실측: 줌을 켜면 그 연결의 서피스에 **pane 이 하나만** 실려 온다(나머지는 빠진다).
   * 그래서 역산이 필요 없다. 역산을 쓰면 1139×85 짜리 유령 서피스를 한 번 요청했다가
   * 보정으로 135×53 로 되돌아오는, 두 번 흔드는 길이 된다(실측 `보낸격자`).
   *
   * 끌 때도 **지금 상자 격자**다. 줌 직전 값을 캐시하지 않는 이유는 줌 중에 창을 끌 수 있기
   * 때문이고(F2-3b), 상자가 안 바뀌었으면 같은 수라 F2-3c 의 정확 복원이 그대로 선다.
   */
  zoom(input: { paneId: string | null; boxGrid: { cols: number; rows: number } }): void {
    if (this.closed) return
    if (input.paneId === null) {
      this.zoomedPaneId = null
      this.sendGrid({
        cols: this.boxGrid.cols + this.edgeWaste.cols,
        rows: this.boxGrid.rows + this.edgeWaste.rows,
        kind: 'zoom-off',
        force: true,
      })
      return
    }
    if (!this.meta.has(input.paneId)) {
      // `allows()` 와 같은 자리를 남긴다 (L11) — 조용히 되돌아가면 "줌이 안 먹었다"의 원인이 안 남는다.
      this.counters.unknownPanes += 1
      this.logger.warn('zoom target not in attached tab', { paneId: input.paneId, tab: this.attachedTabId ?? '' })
      return
    }
    this.zoomedPaneId = input.paneId
    this.boxGrid = { cols: clampGrid(input.boxGrid.cols), rows: clampGrid(input.boxGrid.rows) }
    this.sendGrid({
      cols: this.boxGrid.cols + this.edgeWaste.cols,
      rows: this.boxGrid.rows + this.edgeWaste.rows,
      kind: 'zoom-on',
      force: true,
    })
  }


  /**
   * S1 가드 — 붙어 있는 탭의 pane 인가. herdr 는 아니면 **오류 없이 버린다**(3차 T3a).
   * 막은 횟수를 세어 계측에 올린다.
   */
  private allows(paneId: string): boolean {
    if (this.closed) return false
    if (this.meta.has(paneId)) return true
    this.counters.blockedInputs += 1
    this.logger.warn('pane input blocked', { paneId, tab: this.attachedTabId ?? '', reason: 'pane not in attached tab' })
    return false
  }

  input(input: { paneId: string; data: Buffer }): void {
    if (!this.allows(input.paneId)) return
    const pane = this.meta.get(input.paneId)
    if (pane === undefined) return
    const io = this.ioFor(input.paneId)
    const events = io.classifier.feed(input.data).filter((event) => {
      if (event.type !== 'mouse') return true
      return this.acceptsMouse({ pane, io, event })
    })
    this.client.sendPaneInput(input.paneId, events)
    if (io.escFlushTimer !== null) clearTimeout(io.escFlushTimer)
    io.escFlushTimer = setTimeout(() => {
      io.escFlushTimer = null
      if (this.closed || !this.meta.has(input.paneId)) return
      this.client.sendPaneInput(input.paneId, io.classifier.flush())
    }, ESC_FLUSH_MS)
  }

  /** 마우스 이벤트를 pane 안으로 가둔다 — 벤더 세션의 판정을 pane 별 상태로 옮긴 것. */
  private acceptsMouse(input: {
    pane: PaneView
    io: PaneIo
    event: { kind?: number; button?: number | null; column: number; row: number }
  }): boolean {
    const { pane, io, event } = input
    if (!pane.mouseReporting || pane.innerRect.width < 1 || pane.innerRect.height < 1) {
      io.pressedMouseButtons.clear()
      return false
    }
    const inside = event.column < pane.innerRect.width && event.row < pane.innerRect.height
    const button = event.button ?? 0
    if (event.kind === MOUSE_KIND.Down) {
      io.pressedMouseButtons.delete(button)
      if (inside) io.pressedMouseButtons.add(button)
      return inside
    }
    if (event.kind === MOUSE_KIND.Drag || event.kind === MOUSE_KIND.Up) {
      if (!io.pressedMouseButtons.has(button)) return false
      // 캔버스가 크롭보다 클 수 있다 — 안에서 시작한 제스처는 바깥에서 놓아도 자기 릴리스를 갖는다.
      event.column = Math.min(event.column, pane.innerRect.width - 1)
      event.row = Math.min(event.row, pane.innerRect.height - 1)
      if (event.kind === MOUSE_KIND.Up) io.pressedMouseButtons.delete(button)
      return true
    }
    return inside
  }

  scroll(input: {
    paneId: string
    direction: 'up' | 'down'
    lines: number
    column?: number | null
    row?: number | null
  }): void {
    if (!this.allows(input.paneId)) return
    const pane = this.meta.get(input.paneId)
    if (pane === undefined || !Number.isFinite(input.lines) || input.lines <= 0) return
    const lines = Math.max(1, Math.min(65_535, Math.floor(input.lines)))
    if (pane.mouseReporting) {
      const column = input.column
      const row = input.row
      if (
        !Number.isInteger(column) ||
        !Number.isInteger(row) ||
        column === null ||
        row === null ||
        column === undefined ||
        row === undefined ||
        column < 0 ||
        row < 0 ||
        column >= pane.innerRect.width ||
        row >= pane.innerRect.height
      )
        return
      this.client.sendPaneInput(input.paneId, [
        {
          type: 'mouse',
          kind: input.direction === 'up' ? MOUSE_KIND.ScrollUp : MOUSE_KIND.ScrollDown,
          column,
          row,
          modifiers: 0,
          lines,
        },
      ])
      return
    }
    this.client.assertMethod('pane.scroll')
    if (pane.scroll === null) return
    const delta = input.direction === 'up' ? lines : -lines
    const offset = Math.max(0, Math.min(pane.scroll.maxOffsetFromBottom, pane.scroll.offsetFromBottom + delta))
    if (offset === pane.scroll.offsetFromBottom) return
    pane.scroll = { ...pane.scroll, offsetFromBottom: offset }
    this.enqueue(() =>
      this.client.callEndpoint('pane.scroll', { pane_id: input.paneId, offset_from_bottom: offset }),
    ).catch((error: unknown) =>
      this.logger.debug('endpoint pane.scroll failed', { error: error instanceof Error ? error.message : String(error) }),
    )
  }

  /** control 층이 pane 소실을 봤다 — 다음 전체 서피스를 기다리지 않고 명부에서 뺀다 (R16 축출). */
  evictPanes(paneIds: readonly string[]): void {
    for (const paneId of paneIds) {
      if (!this.meta.delete(paneId)) continue
      this.evictIo(paneId)
      this.logger.debug('pane evicted', { paneId, reason: 'control' })
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const paneId of [...this.io.keys()]) this.evictIo(paneId)
    this.meta.clear()
    this.client.close()
  }

  // --- 서피스 처리 -----------------------------------------------------------

  private onSurface(surface: EndpointSurface): void {
    if (this.closed || this.attaching) return
    this.counters.surfaces += 1
    this.mergeMeta(surface)
    if (this.checkConsistency) this.counters.inconsistencies += countInconsistencies(surface.frame, this.panes())

    this.learnEdgeWaste(surface)
    let layoutChanged = surface.full
    for (const raw of surface.panes) {
      const pane = this.meta.get(raw.paneId)
      if (pane === undefined) {
        // 서피스에 실려 왔는데 이 연결이 모르는 pane 이다 — **후보로도 안 센다**. 세어 두지 않으면
        // "왜 이 pane 만 안 그려지나"를 밖에서 물을 자리가 없다 (L11).
        this.counters.unknownPanes += 1
        continue
      }
      // 벤더 수정 ③ 과 **같은 형식** — LIFE-353 S5 하네스가 이 줄에서 innerRect 를 읽는다 (§10-R16).
      this.logger.debug('surface', {
        frame: `${surface.frame.width}x${surface.frame.height}`,
        innerRect: `${pane.innerRect.width}x${pane.innerRect.height}`,
        surfaceRevision: surface.surfaceRevision,
      })
      this.counters.candidates += 1
      const io = this.ioFor(pane.paneId)
      // P1 — 판정자는 크롭 셀 해시다. 서버가 이 pane 을 실어 보냈다는 사실은 후보일 뿐이다.
      const hash = hashCrop(surface.frame, pane.innerRect)
      if (io.hash !== null && io.hash.a === hash.a && io.hash.b === hash.b) {
        this.counters.skipped += 1
        continue
      }
      io.hash = hash
      io.seq += 1
      const cropped = cropFrame(surface.frame, pane.innerRect)
      this.hooks.onFrame({
        paneId: pane.paneId,
        seq: io.seq,
        cols: cropped.width,
        rows: cropped.height,
        mouseReporting: pane.mouseReporting,
        bytes: Buffer.from(frameToAnsi(cropped), 'utf8'),
      })
      layoutChanged = true
    }
    if (layoutChanged) this.hooks.onLayout(this.panes())
  }

  /**
   * 서피스에서 **가장자리 장식**을 배운다 (위 `edgeWaste` 주석 참고).
   *
   * 값이 달라졌을 때만 격자를 한 번 더 요청한다 — pane 을 나누거나 닫을 때뿐이고, 창 드래그
   * 중에는 안 바뀌므로 요청은 연결당 1회로 남는다.
   */
  private learnEdgeWaste(surface: EndpointSurface): void {
    const panes = this.panes()
    if (panes.length === 0) return
    let minX = Number.POSITIVE_INFINITY
    let maxX = 0
    let minY = Number.POSITIVE_INFINITY
    let maxY = 0
    for (const pane of panes) {
      minX = Math.min(minX, pane.innerRect.x)
      maxX = Math.max(maxX, pane.innerRect.x + pane.innerRect.width)
      minY = Math.min(minY, pane.innerRect.y)
      maxY = Math.max(maxY, pane.innerRect.y + pane.innerRect.height)
    }
    const next = {
      cols: Math.max(0, minX + (surface.frame.width - maxX)),
      rows: Math.max(0, minY + (surface.frame.height - maxY)),
    }
    if (next.cols === this.edgeWaste.cols && next.rows === this.edgeWaste.rows) return
    this.edgeWaste = next
    this.logger.debug('edge waste', { cols: next.cols, rows: next.rows })
    if (this.boxGrid.cols < 1 || this.boxGrid.rows < 1) return
    this.sendGrid({ cols: this.boxGrid.cols + next.cols, rows: this.boxGrid.rows + next.rows, kind: 'deco' })
  }

  /**
   * 누적 병합 (R7) — 전체 서피스는 명부를 **교체**하고, patch 는 실려 온 것만 **덮어쓴다**.
   *
   * patch 는 "사라진 pane"을 알려주지 않는다. 그래서 축출은 전체 서피스에서만 일어난다 —
   * 그 사이의 공백은 `evictPanes()`(control 층 교차 확인)가 메운다.
   */
  private mergeMeta(surface: EndpointSurface): void {
    if (surface.full) {
      const next = new Map<string, PaneView>()
      for (const pane of surface.panes) next.set(pane.paneId, toPaneView(pane))
      for (const paneId of this.meta.keys()) {
        if (next.has(paneId)) continue
        this.evictIo(paneId)
        this.logger.debug('pane evicted', { paneId, reason: 'full-surface' })
      }
      this.meta = next
      return
    }
    for (const pane of surface.panes) this.meta.set(pane.paneId, toPaneView(pane))
  }

  private ioFor(paneId: string): PaneIo {
    const existing = this.io.get(paneId)
    if (existing !== undefined) return existing
    const created: PaneIo = {
      classifier: new VtInputClassifier(),
      pressedMouseButtons: new Set(),
      escFlushTimer: null,
      seq: 0,
      hash: null,
    }
    this.io.set(paneId, created)
    return created
  }

  private evictIo(paneId: string): void {
    const io = this.io.get(paneId)
    if (io === undefined) return
    if (io.escFlushTimer !== null) clearTimeout(io.escFlushTimer)
    this.io.delete(paneId)
  }

  private waitForPane(paneId: string): Promise<void> {
    if (this.meta.has(paneId)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        this.client.off('surface', onSurface)
        this.client.off('close', onClose)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timed out waiting for endpoint surface of ${paneId}`))
      }, FIRST_SURFACE_WAIT_MS)
      const onSurface = (): void => {
        if (!this.meta.has(paneId)) return
        cleanup()
        resolve()
      }
      const onClose = (): void => {
        cleanup()
        reject(new Error('endpoint connection closed before first surface'))
      }
      this.client.on('surface', onSurface)
      this.client.on('close', onClose)
    })
  }

  /** endpoint RPC 는 한 줄로 세우고 시간 상한을 건다 — 벤더 세션의 `enqueueCommand` 와 같은 수법. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const bounded = async (): Promise<T> => {
      if (this.closed) throw new Error('group session is closed')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          run(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('Endpoint command timed out; check Herdr before retrying.'))
              this.close()
            }, COMMAND_TIMEOUT_MS)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    const task = this.commandChain.then(bounded, bounded)
    this.commandChain = task.catch(() => undefined)
    return task
  }
}

function clampGrid(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(65_535, Math.round(value)))
}

function toPaneView(pane: EndpointSurface['panes'][number]): PaneView {
  return {
    paneId: pane.paneId,
    rect: { ...pane.rect },
    innerRect: { ...pane.innerRect },
    focused: pane.focused,
    mouseReporting: pane.mouseReporting,
    scroll:
      pane.scroll === null || pane.scroll === undefined
        ? null
        : { offsetFromBottom: pane.scroll.offsetFromBottom, maxOffsetFromBottom: pane.scroll.maxOffsetFromBottom },
  }
}

/**
 * 크롭 하나의 지문 — `cropFrame` 이 xterm 에 싣는 것과 **같은 내용**을 본다 (P1 판정자).
 *
 * 32비트 하나로는 포화 부하에서 몇 달에 한 번 충돌이 나고 그 한 번이 "안 그려진 화면"이라,
 * 서로 다른 FNV-1a 두 갈래를 같은 순회에서 돌려 64비트로 쓴다. 폭·높이를 씨앗에 섞어
 * 내용이 같고 크기만 다른 경우를 가른다.
 */
function hashCrop(frame: FrameData, rect: CellRect): { a: number; b: number } {
  const width = Math.max(0, Math.min(rect.width, frame.width - rect.x))
  const height = Math.max(0, Math.min(rect.height, frame.height - rect.y))
  let a = Math.imul(0x811c9dc5 ^ width, 0x01000193) >>> 0
  let b = Math.imul(0x9e3779b9 ^ height, 0x85ebca6b) >>> 0
  const mix = (value: number): void => {
    a = Math.imul(a ^ value, 0x01000193) >>> 0
    b = Math.imul(b ^ value, 0x85ebca6b) >>> 0
  }
  for (let y = 0; y < height; y++) {
    const base = (rect.y + y) * frame.width + rect.x
    for (let x = 0; x < width; x++) {
      const cell = frame.cells[base + x]
      if (cell === undefined) {
        mix(0xffff)
        continue
      }
      const symbol = cell.symbol
      for (let i = 0; i < symbol.length; i++) mix(symbol.charCodeAt(i))
      mix(cell.fg)
      mix(cell.bg)
      mix(cell.modifier)
      mix(cell.skip ? 1 : 0)
    }
  }
  const cursor = frame.cursor
  if (cursor === null) {
    mix(0x5eed)
  } else {
    const cx = cursor.x - rect.x
    const cy = cursor.y - rect.y
    // 크롭 밖의 커서는 이 pane 의 그림을 바꾸지 않는다 — 안에 있을 때만 섞는다.
    if (cx >= 0 && cx < width && cy >= 0 && cy < height) {
      mix(cx)
      mix(cy)
      mix(cursor.visible ? 1 : 0)
      mix(cursor.shape)
    } else mix(0x5eed)
  }
  return { a, b }
}

/**
 * 연결 내 자기정합 (S6, §10-R14) — 이 연결의 격자 안에서만 성립해야 하는 것들.
 *
 * `pane.layout`(세션 `area` 기준)과의 절대 좌표 비교는 영역이 2개 이상이면 성립하지 않는다
 * (마지막 resizer 가 area 를 정한다). 반면 아래 셋은 **어느 연결에서나** 참이어야 한다.
 */
export function countInconsistencies(frame: { width: number; height: number }, panes: readonly PaneView[]): number {
  let violations = 0
  let area = 0
  for (const [index, pane] of panes.entries()) {
    area += pane.rect.width * pane.rect.height
    const inner = pane.innerRect
    const rect = pane.rect
    if (
      inner.x < rect.x ||
      inner.y < rect.y ||
      inner.x + inner.width > rect.x + rect.width ||
      inner.y + inner.height > rect.y + rect.height
    )
      violations += 1
    for (const other of panes.slice(index + 1)) {
      const overlaps =
        rect.x < other.rect.x + other.rect.width &&
        other.rect.x < rect.x + rect.width &&
        rect.y < other.rect.y + other.rect.height &&
        other.rect.y < rect.y + rect.height
      if (overlaps) violations += 1
    }
  }
  if (panes.length > 0 && area !== frame.width * frame.height) violations += 1
  return violations
}
