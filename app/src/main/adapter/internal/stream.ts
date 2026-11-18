// 어댑터 stream 층 — 벤더한 endpoint 코어(herdr-client.sock)를 corral 타입으로 감싼다.
//
// 02-rebuild-plan §1 의 두 번째 접촉면이다. control 층(link.ts, herdr.sock)과는 **다른 소켓의
// 별개 연결**이고, 순서 보장이 없다 (00-analysis §3-1 — 그 어긋남은 A3 가 관찰만 한다).
//
// **LIFE-373 에서 단위가 바뀌었다**: 살아 있는 연결이 "한 번에 하나"가 아니라
// **영역마다 하나**다 (01-criteria §0-1 — 연결 수 = 동시에 보이는 탭 수 = 영역 수).
// 연결 하나가 탭 전체 격자를 받고 그 안에서 pane 을 크롭한다 (group-session.ts).
// 이 파일은 그 연결들의 **명부와 수명**만 본다: 선언(`sync`)을 받아 열고·닫고·탭을 옮기고·
// 격자를 맞춘다. 프레임·입력·크롭 skip 은 전부 GroupSession 안이다.
//
// DEC 2026 (synchronized output): 프레임을 BSU/ESU 로 감싼다. 근거 (A2 기록 대상):
//   · 프레임은 전체 리페인트라 IPC·xterm write 청크 분할 중간 페인트(티어링)가 보일 수 있고,
//     BSU/ESU 는 정확히 그걸 막는다 (xterm 6.0 내장 #5453, 외부 검증 — 00-analysis §4-4)
//   · ED2 의 뷰포트 리셋(#5801)은 sync 로 안 막히지만 corral 은 scrollback 0 이라 무력화
//   · 타임아웃 1초 하드코딩 — 프레임 하나를 한 번의 write 로 보내므로 걸릴 일이 없다

import { GroupSession, type GroupFrame, type PaneView } from './group-session.js'
import { corralLogger, quietLogger, type Logger } from './vendor/logger.js'
import type {
  TerminalFrame,
  TerminalGroupRequest,
  TerminalGroupState,
  TerminalPhase,
  TerminalScroll,
  TerminalState,
} from '../../../shared/types.js'
import type { TerminalRevealRequest, TerminalRevealResult, TerminalSearchRequest, TerminalSearchResult } from '../../../shared/terminal-search.js'
import { log } from '../../log.js'

const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'
const textEncoder = new TextEncoder()

export type StreamHooks = {
  /** 프레임 하나가 왔다 — 그대로 renderer 로 민다. */
  onFrame: (frame: TerminalFrame) => void
  /** phase·기하가 바뀌었다 — AppState 재전송 신호. */
  onState: () => void
  /** pane 안에서 OSC 52 복사가 왔다 (base64 디코드 완료). */
  onClipboard: (text: string) => void
}

type GroupEntry = {
  groupId: string
  session: GroupSession
  phase: TerminalPhase
  tabId: string | null
  activePaneId: string
  grid: { cols: number; rows: number }
  panes: PaneView[]
  lastError: string | null
  /** 마지막 프레임의 크기·마우스 보고 — pane 별. `terminal` 파생이 여기서 나온다. */
  frames: Map<string, { cols: number; rows: number; mouseReporting: boolean }>
}

/**
 * 영역별 endpoint 연결의 명부.
 *
 * 렌더러가 **선언**(`sync`)하면 이 클래스가 현재 연결과 대조해 필요한 것만 한다. 부팅 복원·
 * 재접속·worktree 전환이 전부 이 한 길로 들어오므로 attach 순서(S2-b: 활성 영역의 활성 pane 을
 * **마지막에** focus)가 한 곳에서만 지켜지면 된다.
 */
export class TerminalStreams {
  private readonly hooks: StreamHooks
  /**
   * 측정 실행인가 (LIFE-353 수정 1회차 C1). 참일 때만 프레임당·스크롤당 로그를 남기고 세션에
   * 프레임마다 debug 를 찍는 corralLogger 를 물린다. 평시엔 quietLogger — error/warn 만 남는다.
   */
  private readonly measuring: boolean
  private readonly logger: Logger
  private readonly groups = new Map<string, GroupEntry>()
  /** 지금 포커스인 pane — `terminal`(LIFE-353 단일 pane 계약)이 여기서 파생된다. */
  private focusedPaneId: string | null = null
  /** 선언 처리 중복 방지 — attach 는 비동기라 앞선 sync 가 끝나기 전에 다음이 올 수 있다. */
  private syncChain: Promise<void> = Promise.resolve()
  private lastError: string | null = null

  constructor(input: { hooks: StreamHooks; measuring: boolean }) {
    this.hooks = input.hooks
    this.measuring = input.measuring
    this.logger = input.measuring ? corralLogger : quietLogger
  }

  /**
   * 포커스 pane 기준의 단일 pane 상태 — LIFE-353 이 보던 것과 같은 모양이다 (§10-R5).
   * 포커스 pane 이 속한 영역이 닫히면 `idle` 로 돌아간다 (C2 가 그 전이를 본다).
   */
  terminalState(): TerminalState {
    const paneId = this.focusedPaneId
    const entry = paneId === null ? undefined : this.entryForPane(paneId)
    if (paneId === null || entry === undefined) {
      return { paneId: null, phase: 'idle', cols: null, rows: null, mouseReporting: false, lastError: this.lastError }
    }
    const frame = entry.frames.get(paneId)
    return {
      paneId,
      phase: entry.phase,
      cols: frame?.cols ?? null,
      rows: frame?.rows ?? null,
      mouseReporting: frame?.mouseReporting ?? false,
      lastError: entry.lastError,
    }
  }

  groupStates(): TerminalGroupState[] {
    return [...this.groups.values()].map((entry) => ({
      groupId: entry.groupId,
      tabId: entry.tabId,
      phase: entry.phase,
      grid: entry.grid.cols > 0 ? { ...entry.grid } : null,
      panes: entry.panes.map((pane) => ({
        paneId: pane.paneId,
        rect: { ...pane.rect },
        innerRect: { ...pane.innerRect },
        focused: pane.focused,
        mouseReporting: pane.mouseReporting,
      })),
      // 줌은 세션이 쥔다 — 탭이 바뀌면 세션이 스스로 푼다(focusTab). 여기 따로 두면 어긋난다.
      zoomedPaneId: entry.session.zoomedPane,
      lastError: entry.lastError,
    }))
  }

  /** 계측용 — 연결별 카운터(크롭 skip·S1 차단·자기정합 위반·격자 요청). */
  counters(): Array<{ groupId: string } & ReturnType<GroupSession['counterSnapshot']>> {
    return [...this.groups.values()].map((entry) => ({ groupId: entry.groupId, ...entry.session.counterSnapshot() }))
  }

  /** 지금 어느 연결이든 명부에 들고 있는 pane 전부 — 축출 대조에 쓴다. */
  heldPaneIds(): string[] {
    const ids: string[] = []
    for (const entry of this.groups.values()) {
      for (const pane of entry.session.panes()) ids.push(pane.paneId)
    }
    return ids
  }

  setFocusedPane(paneId: string | null): void {
    this.focusedPaneId = paneId
  }

  /**
   * 영역 구성 선언을 반영한다.
   *
   * 순서가 계약이다 (S2-b): **닫기 → 열기/탭 이동 → 격자** 를 차례로 하고, `pane.focus` 는
   * 비활성 영역부터 쏘고 **활성 영역을 마지막에** 쏜다. `pane.focus` 는 세션 전역 포커스를
   * 움직이므로(3차 T3b) 마지막에 쏜 것이 herdr 의 `focused_pane_id` 로 남는다.
   */
  sync(input: { clientSocketPath: string; groups: readonly TerminalGroupRequest[] }): void {
    const groups = [...input.groups]
    this.syncChain = this.syncChain.then(() => this.applySync(input.clientSocketPath, groups)).catch((error: unknown) => {
      log('stream.sync_failed', { error: error instanceof Error ? error.message : String(error) })
    })
  }

  private async applySync(socketPath: string, groups: readonly TerminalGroupRequest[]): Promise<void> {
    const wanted = new Map(groups.map((group) => [group.groupId, group]))
    // ① 사라진 영역의 연결을 닫는다 (S4 — 유휴 연결 누수 0).
    for (const [groupId, entry] of [...this.groups]) {
      if (wanted.has(groupId)) continue
      log('stream.close', { groupId, tabId: entry.tabId })
      entry.session.close()
      this.groups.delete(groupId)
    }
    // ② 활성 영역을 **맨 뒤로** — 마지막 pane.focus 가 herdr 의 세션 포커스를 정한다 (S2-b).
    const ordered = [...groups].sort((a, b) => Number(a.active) - Number(b.active))
    for (const group of ordered) {
      await this.applyGroup(socketPath, group)
    }
    this.hooks.onState()
  }

  private async applyGroup(socketPath: string, group: TerminalGroupRequest): Promise<void> {
    const existing = this.groups.get(group.groupId)
    if (existing === undefined) {
      await this.openGroup(socketPath, group)
      return
    }
    if (existing.session.isClosed) {
      this.groups.delete(group.groupId)
      await this.openGroup(socketPath, group)
      return
    }
    existing.activePaneId = group.activePaneId
    if (existing.tabId !== group.tabId) {
      log('stream.refocus', { groupId: group.groupId, from: existing.tabId, to: group.tabId })
      existing.phase = 'connecting'
      existing.frames.clear()
      this.hooks.onState()
      try {
        await existing.session.focusTab({ tabId: group.tabId, paneId: group.activePaneId })
        existing.tabId = group.tabId
        existing.phase = 'streaming'
      } catch (error: unknown) {
        existing.phase = 'failed'
        existing.lastError = error instanceof Error ? error.message : String(error)
        log('stream.refocus_failed', { groupId: group.groupId, error: existing.lastError })
      }
    }
    if (group.cols !== existing.grid.cols || group.rows !== existing.grid.rows) {
      existing.grid = { cols: group.cols, rows: group.rows }
      existing.session.requestGrid({ cols: group.cols, rows: group.rows })
    }
  }

  private async openGroup(socketPath: string, group: TerminalGroupRequest): Promise<void> {
    const groupId = group.groupId
    // 훅은 groupId 로 명부를 되짚는다 — 세션과 entry 가 서로를 참조하는 매듭을 만들지 않는다.
    const session = new GroupSession({
      socketPath,
      logger: this.logger,
      checkConsistency: this.measuring,
      hooks: {
        onFrame: (frame) => this.onFrame(groupId, frame),
        onLayout: (panes) => {
          const entry = this.groups.get(groupId)
          if (entry === undefined) return
          entry.panes = panes
          this.hooks.onState()
        },
        onClipboard: (text) => {
          log('stream.clipboard', { groupId, bytes: text.length })
          this.hooks.onClipboard(text)
        },
        onError: (message) => {
          log('stream.error', { groupId, error: message })
          const entry = this.groups.get(groupId)
          if (entry !== undefined) entry.lastError = message
          this.lastError = message
          this.hooks.onState()
        },
        onClose: () => {
          log('stream.closed', { groupId })
          const entry = this.groups.get(groupId)
          if (entry === undefined || entry.phase === 'idle') return
          entry.phase = 'failed'
          this.hooks.onState()
        },
      },
    })
    const entry: GroupEntry = {
      groupId,
      session,
      phase: 'connecting',
      tabId: null,
      activePaneId: group.activePaneId,
      grid: { cols: group.cols, rows: group.rows },
      panes: [],
      lastError: null,
      frames: new Map(),
    }
    this.groups.set(groupId, entry)
    log('stream.open', { groupId, tabId: group.tabId, cols: group.cols, rows: group.rows })
    this.hooks.onState()
    try {
      await session.attach({ tabId: group.tabId, paneId: group.activePaneId, grid: { cols: group.cols, rows: group.rows } })
      entry.tabId = group.tabId
      entry.phase = 'streaming'
    } catch (error: unknown) {
      entry.phase = 'failed'
      entry.lastError = error instanceof Error ? error.message : String(error)
      this.lastError = entry.lastError
      log('stream.connect_failed', { groupId, error: entry.lastError })
    }
    this.hooks.onState()
  }

  private onFrame(groupId: string, frame: GroupFrame): void {
    const entry = this.groups.get(groupId)
    if (entry === undefined) return
    // BSU/ESU 래핑 — 문자열 결합 대신 바이트로 한 번에 만든다.
    const head = textEncoder.encode(BSU)
    const tail = textEncoder.encode(ESU)
    const data = new Uint8Array(head.length + frame.bytes.length + tail.length)
    data.set(head, 0)
    data.set(frame.bytes, head.length)
    data.set(tail, head.length + frame.bytes.length)
    const previous = entry.frames.get(frame.paneId)
    const changed =
      entry.phase !== 'streaming' ||
      previous === undefined ||
      previous.cols !== frame.cols ||
      previous.rows !== frame.rows ||
      previous.mouseReporting !== frame.mouseReporting
    entry.phase = 'streaming'
    entry.frames.set(frame.paneId, { cols: frame.cols, rows: frame.rows, mouseReporting: frame.mouseReporting })
    // A4 스트림 비용 — **측정 실행에서만** 프레임당 한 줄. `bytes` 는 벤더가 준 원 페이로드
    // 길이다: BSU/ESU 래퍼(+16B)를 더한 `data.length` 가 아니라, 화면을 그린 실제 바이트를 센다.
    if (this.measuring) {
      log('stream.frame', {
        groupId: entry.groupId,
        paneId: frame.paneId,
        seq: frame.seq,
        cols: frame.cols,
        rows: frame.rows,
        bytes: frame.bytes.length,
        mouseReporting: frame.mouseReporting,
      })
    }
    this.hooks.onFrame({
      paneId: frame.paneId,
      seq: frame.seq,
      cols: frame.cols,
      rows: frame.rows,
      mouseReporting: frame.mouseReporting,
      scrollTop: frame.scrollTop,
      data,
    })
    if (changed) this.hooks.onState()
  }

  /**
   * 포커스 pane 을 옮긴다 — 화면 포커스(파생용)와 herdr `focused_pane_id` 를 같이 맞춘다.
   * `pane.focus` 는 **여기서만** 나간다 (S2: 클릭·MRU 확정·명시 단축키).
   */
  focusPane(paneId: string | null): void {
    this.focusedPaneId = paneId
    if (paneId === null) return
    const entry = this.entryForPane(paneId)
    // 계측 실행에서만 — S2-b 는 "쐈는데 안 갔나" 와 "애초에 안 쐈나" 를 갈라야 판정이 선다.
    if (this.measuring) log('stream.focus', { paneId, groupId: entry?.groupId ?? null, sent: entry !== undefined })
    if (entry === undefined) return
    void entry.session.focusPane(paneId).catch((error: unknown) => {
      log('stream.focus_failed', { paneId, error: error instanceof Error ? error.message : String(error) })
    })
  }

  /** 새로 붙은 뷰어에 마지막 화면을 다시 그린다 (S6 — 탭 전환 뒤 빈 화면 방지). */
  repaint(paneId: string): void {
    this.entryForPane(paneId)?.session.repaint(paneId)
  }

  /** xterm onData 그대로 — 분류(VtInputClassifier)는 pane 마다 따로 돈다. */
  input(request: { paneId: string; data: string }): void {
    const entry = this.entryForPane(request.paneId)
    if (entry === undefined) {
      // 어느 연결도 이 pane 을 안 보고 있다 — 보내면 herdr 가 조용히 버린다 (S1).
      log('stream.input_blocked', { paneId: request.paneId, reason: 'no group holds this pane' })
      return
    }
    entry.session.input({ paneId: request.paneId, data: Buffer.from(request.data, 'utf8') })
  }

  /** 영역 상자가 정한 탭 격자 1회 요청 (R13 — pane 별 fit 왕복이 없다). */
  resize(request: { groupId: string; cols: number; rows: number }): void {
    const entry = this.groups.get(request.groupId)
    if (entry === undefined) return
    if (this.measuring) log('stream.resize', { groupId: request.groupId, cols: request.cols, rows: request.rows })
    entry.grid = { cols: request.cols, rows: request.rows }
    entry.session.requestGrid({ cols: request.cols, rows: request.rows })
  }

  scroll(request: { paneId: string } & TerminalScroll): void {
    const entry = this.entryForPane(request.paneId)
    if (entry === undefined) {
      log('stream.scroll_blocked', { paneId: request.paneId, reason: 'no group holds this pane' })
      return
    }
    if (this.measuring) log('stream.scroll', { paneId: request.paneId, direction: request.direction, lines: request.lines })
    entry.session.scroll({
      paneId: request.paneId,
      direction: request.direction,
      lines: request.lines,
      column: request.column,
      row: request.row,
    })
  }

  /**
   * LIFE-812 — pane 의 스크롤백 검색. 그 pane 을 붙든 연결이 없으면 묻지 않는다(입력·스크롤과 같은 S1 이유).
   * 한 줄 로그는 결과 갈래·시도 수만 남긴다(질의 내용은 남기지 않는다) — 출력이 흐르는 pane 의 재시도 계수(C7ⓒ)가 여기서 나온다.
   */
  async search(request: TerminalSearchRequest): Promise<TerminalSearchResult> {
    const entry = this.entryForPane(request.paneId)
    const result: TerminalSearchResult =
      entry === undefined ? { kind: 'error', message: '이 pane 을 보고 있는 연결이 없습니다' } : await entry.session.search(request)
    log('stream.search', {
      paneId: request.paneId,
      direction: request.direction,
      from: request.from === 'viewport' ? 'viewport' : 'match',
      kind: result.kind,
      attempts: result.kind === 'error' ? null : result.attempts,
    })
    return result
  }

  /** LIFE-812 — 절대 행을 보이게 스크롤한다(이미 보이면 그대로). */
  async reveal(request: TerminalRevealRequest): Promise<TerminalRevealResult> {
    const entry = this.entryForPane(request.paneId)
    if (entry === undefined) return { scrolled: false, top: null }
    return entry.session.reveal(request)
  }

  /** LIFE-812 fix1 — 막대 닫기·질의 변경·탭 전환: 그 pane 의 대기 중 재시도·이동을 낡게 한다. 붙든 연결이 없으면 할 일이 없다. */
  cancelSearch(paneId: string): void {
    this.entryForPane(paneId)?.session.cancelSearch(paneId)
  }

  /** 이 영역이 지금 줌 중인 pane — 해제 시 서버 플래그를 끌 대상이다. */
  zoomedPaneOf(groupId: string): string | null {
    return this.groups.get(groupId)?.session.zoomedPane ?? null
  }

  zoom(request: { groupId: string; paneId: string | null; cols: number; rows: number }): void {
    const entry = this.groups.get(request.groupId)
    if (entry === undefined) return
    log('stream.zoom', { groupId: request.groupId, paneId: request.paneId ?? '' })
    entry.session.zoom({ paneId: request.paneId, boxGrid: { cols: request.cols, rows: request.rows } })
    this.hooks.onState()
  }

  /**
   * control 층이 pane 소실을 봤다 — 모든 연결의 명부에서 뺀다 (§10-R16 축출).
   *
   * patch 는 사라진 pane 을 알려주지 않으므로 다음 **전체** 서피스까지 stale 이 남는다.
   * 그 사이 입력이 그 pane 으로 가면 S1 가드를 그냥 통과해 herdr 가 조용히 버린다.
   */
  evictPanes(paneIds: readonly string[]): void {
    if (paneIds.length === 0) return
    for (const entry of this.groups.values()) entry.session.evictPanes(paneIds)
    for (const paneId of paneIds) {
      for (const entry of this.groups.values()) entry.frames.delete(paneId)
    }
  }

  /** 어느 연결이 이 pane 을 보고 있나 — 없으면 undefined (그게 곧 S1 차단 근거다). */
  private entryForPane(paneId: string): GroupEntry | undefined {
    for (const entry of this.groups.values()) {
      if (entry.session.hasPane(paneId)) return entry
    }
    return undefined
  }

  closeAll(): void {
    for (const [groupId, entry] of this.groups) {
      log('stream.close', { groupId, tabId: entry.tabId })
      entry.session.close()
    }
    this.groups.clear()
    this.focusedPaneId = null
  }
}
