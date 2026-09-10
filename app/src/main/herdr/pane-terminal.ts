// 선택한 pane 하나의 살아 있는 터미널 — 스냅샷을 읽어 재생 프레임을 만들고, 입력을 되돌려 보낸다.
//
// 이 파일이 R 블록(재동기·복구) 정책의 구현체다. 정책 요약은 `03-result-claude.md` §R 에 있고
// 여기 상수와 1:1 로 대응한다.
//
// ## 갱신 정책 (R1)
//
// herdr 는 **델타를 주지 않는다.** 화면의 진실은 `pane.read` 스냅샷 한 장뿐이고, 그것을 언제
// 다시 읽을지가 정책의 전부다. 세 가지가 읽기를 부른다:
//
//   ① 이벤트 — `pane.updated` 가 그 pane 으로 오면 읽는다. **주 경로**다.
//      단 출력마다 오지 않는다 (LIFE-344 R2-3) — 그래서 이것만으로는 부족하다
//   ② 행동 — 키를 보낸 직후. 원인이 있는 재읽기라 폴링이 아니다 (01-criteria.md §4 단서).
//      즉시 한 번이 아니라 두 박자로 읽는다: PTY 에코가 왕복보다 늦을 수 있다
//   ③ 심장박동 — 아무 신호가 없어도 주기적으로 전체를 다시 읽는다. **이게 필수다.**
//      push 는 부하에서 흘리고 시퀀스도 유실 카운터도 없어서(LIFE-344) tmux control-mode 식
//      "유실을 알고 시드하기"가 불가능하다. 모르는 채로 회복하는 유일한 수단이 주기 재동기다
//
// 세 트리거가 모여도 요청은 **한 번에 하나만** 나간다. 나가 있는 동안 들어온 트리거는 dirty
// 플래그 하나로 접히고, 응답이 오면 한 번 더 읽는다. 그래서 초당 요청 수의 상한이
// `1 / 왕복시간` 으로 자연히 눌린다 (왕복 p50 은 LIFE-342 B5 에서 109ms).
//
// ## 유실 회복 (R2)
//
// 약속하는 창 = **심장박동 주기 + 왕복 1회**. 이벤트가 통째로 없어져도 그 안에 수렴한다.
// `CORRAL_INJECT_DROP_PANE_UPDATED=1` 이 이벤트 경로를 인위로 끊어 이걸 재게 한다.
//
// ## 세대 (R4)
//
// pane 을 바꾸는 도중 옛 pane 의 응답이 늦게 돌아온다 — `SessionLink.generation` 이 밟은 자리를
// 터미널이 다시 밟는다. 읽기는 자기 세대를 들고 다니고, 세대가 바뀌었으면 아무것도 안 한다.

import type {
  PaneGrid,
  TerminalFrame,
  TerminalReadReason,
  TerminalState,
} from '../../shared/types.js'
import { buildScreenFrame, buildScrollbackSeed, historyAbove, splitRows } from '../../shared/frame.js'
import { log } from '../log.js'
import { request } from './request.js'
import { isRecord, readNumber, readRecord, readString, type PushFrame } from './protocol.js'

/**
 * 심장박동 — 아무 신호가 없어도 이 주기로 전체를 다시 읽는다.
 *
 * **이 값이 사실상 터미널의 갱신 주기다.** 처음엔 이벤트가 주 경로이고 심장박동은 유실 대비
 * 안전망이라고 잡았는데, 실측이 그 전제를 뒤집었다:
 *
 *   `raw/claude/_runs/r1/app.ndjson` — 47초 동안(그중 20초는 50ms 마다 화면을 다시 그리는
 *   티커) 도착한 `pane_updated` 는 **0건**이다(구독은 `subscription_started` 로 정상).
 *   프레임 86장은 붙을 때 1장 + **심장박동 85장**이다. `pane.updated` 는 출력을 따라오지 않는다
 *   (LIFE-344 R2-3 의 "출력마다 오지는 않는다" 가 실제로는 "거의 안 온다" 였다).
 *
 * 그래서 값을 다시 잡았다. 근거:
 *   - **hot 250ms** — 출력이 흐르는 동안 사람이 보는 갱신률이 이 값이다. 초기값 1000ms 는
 *     1Hz 라 눈에 띄게 굼떴다. 왕복 p50 이 109ms 라 250ms 주기는 커넥션 하나의 듀티 ~44% 이고,
 *     요청 1건의 서버 비용은 0.3ms 다 (LIFE-342). 4Hz 를 그 값으로 산다
 *   - **idle 2000ms** — 아무 변화가 없는 판. 여기서는 "이벤트를 통째로 잃었을 때 얼마 만에
 *     회복하나"만 걸린다. 선행 사례의 하트비트는 3~30초인데(분석 ⓖ10) 그건 델타 스트림이
 *     살아 있는 전제의 값이다. corral 은 델타도 유실 카운터도 없어 그 범위보다 촘촘해야 한다
 *   - hot/idle 을 가르는 것은 최근 `HOT_WINDOW_MS` 안에 화면이 바뀐 적이 있는가다
 *
 * 요청은 한 번에 하나만 나가므로(in-flight 가드) 이 주기가 짧아도 초당 요청 수는
 * `1 / 왕복시간` 을 넘지 못한다.
 */
const HEARTBEAT_HOT_MS = 250
const HEARTBEAT_IDLE_MS = 2000
const HOT_WINDOW_MS = 10_000

/**
 * 입력 뒤 재읽기 — 두 박자. 첫 박자는 왕복(109ms)보다 짧게 잡아 "이미 에코가 와 있는" 경우를
 * 빨리 잡고, 둘째 박자는 왕복 뒤에 PTY 가 뱉는 경우를 잡는다. 이벤트가 오면 그쪽이 먼저 이긴다.
 */
const INPUT_FOLLOWUP_MS: readonly number[] = [40, 150]

/** 이벤트가 쏟아질 때 읽기를 뭉치는 시간. 왕복보다 훨씬 짧게 — in-flight 가드가 본 제동장치다. */
const EVENT_COALESCE_MS = 25

/** 스크롤백 회수 상한. 실측: `lines` 를 안 주면 80줄에서 truncated 로 잘린다. */
const SCROLLBACK_LINES = 2000

/**
 * 격자를 API 에 다시 물어보는 주기.
 *
 * 행 수(`viewport_rows`)와 layout 힌트는 `pane.get`·`pane.layout` **두 번의 왕복**이 든다.
 * 처음엔 프레임마다 물었는데 그것만으로 왕복 2회(약 200ms)가 붙어 **타이핑 왕복 p50 이
 * 380ms** 로 나왔다 (`20-input.json` 1차). 격자는 사람이 herdr 창을 만질 때나 바뀌므로
 * hot path 에서 뺀다 — 열 수는 스냅샷에서 공짜로 관측되고(네트워크 0회), 행 수만 이 주기로
 * 다시 확인한다.
 */
const GRID_REFRESH_MS = 5000

/**
 * 입력을 뭉치는 창.
 *
 * **순서 보장이 이 값의 존재 이유다.** 키 하나 = 요청 하나로 그냥 내보내면 요청마다 커넥션이
 * 따로라 herdr 도착 순서가 뒤집힌다 — 실측에서 `echo I2MARK0` 이 `ehcom...` 처럼 섞여 들어갔다
 * (`_runs/input/app.ndjson`, 1차). 그래서 나가 있는 전송이 있으면 그동안의 키를 **한 덩어리로
 * 모아** 다음 한 번에 보낸다. 순서도 지키고 왕복 수도 준다.
 */
const INPUT_COALESCE_MS = 8

export type PaneTerminalHooks = {
  onFrame: (frame: TerminalFrame) => void
  /** 상태(격자·생사·비용 카운터)가 바뀌었다 — main 이 AppState 를 다시 흘린다. */
  onChange: () => void
}

type Target = { paneId: string; socketPath: string; sessionName: string; isDefaultSession: boolean }

function injectedReadDelay(): number {
  const value = Number(process.env.CORRAL_INJECT_READ_DELAY_MS)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** `pane.updated` 경로를 인위로 끊는다 — R2 의 유실 재현 스위치. */
function dropsPaneEvents(): boolean {
  return process.env.CORRAL_INJECT_DROP_PANE_UPDATED === '1'
}

/**
 * 화면이 그대로여도 프레임을 보낸다 — T3 계측 스위치.
 *
 * 평시에는 같은 스냅샷이면 프레임을 안 보낸다(유휴 비용 0). 그런데 기준 T3 은 **"정지 화면에
 * 주기 재생을 20회 이상 반복해" 스크롤백 증가가 0줄인지**를 묻는다. 최적화 때문에 재생을 아예
 * 안 하면 "0줄"이 공짜로 나오고, 그건 재생 전략을 잰 것이 아니다. 그래서 계측에서는 이 스위치로
 * 최적화를 끄고 **진짜로 20번 다시 그린다**.
 */
function forcesRepaint(): boolean {
  return process.env.CORRAL_FORCE_REPAINT === '1'
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class PaneTerminal {
  private readonly hooks: PaneTerminalHooks
  private target: Target | null = null
  private generation = 0
  private seq = 0
  private reading = false
  private dirty: TerminalReadReason | null = null
  private timer: NodeJS.Timeout | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private followups: NodeJS.Timeout[] = []
  private lastChangeAt = 0
  private lastSnapshot = ''
  private grid: PaneGrid | null = null
  private observedCols = 0
  private alive = true
  private deadReason: string | null = null
  private seededLines: number | null = null
  private lastReadMs: number | null = null
  private lastFrameAt: number | null = null
  private frames = 0
  private reads = 0
  private gridCheckedAt = 0
  private apiRows: number | null = null
  private apiLayoutCols: number | null = null
  /** 아직 안 보낸 입력. 텍스트는 이어 붙이고 특수키는 순서를 지켜 따로 담는다. */
  private inputQueue: InputItem[] = []
  private inputSending = false
  private inputTimer: NodeJS.Timeout | null = null

  constructor(hooks: PaneTerminalHooks) {
    this.hooks = hooks
  }

  state(): TerminalState {
    return {
      paneId: this.target?.paneId ?? null,
      generation: this.generation,
      grid: this.grid,
      alive: this.alive,
      deadReason: this.deadReason,
      seededLines: this.seededLines,
      lastReadMs: this.lastReadMs,
      lastFrameAt: this.lastFrameAt,
      frames: this.frames,
      reads: this.reads,
      inputBlocked: this.inputBlocked(),
    }
  }

  /**
   * 입력을 막아야 하는 사유. 없으면 null.
   *
   * 격리 가드: 이 앱은 이 일감에서 **처음으로 herdr 에 쓰기를 한다**. 계측 중 실수로 사용자의
   * `default` 세션에 타이핑이 들어가면 기준 §0.1 위반으로 측정 전체가 무효다. 그래서 default
   * 세션에는 명시적 허용(`CORRAL_ALLOW_DEFAULT_INPUT=1`) 없이는 입력을 보내지 않는다.
   */
  private inputBlocked(): string | null {
    const target = this.target
    if (target === null) return 'pane 이 선택되지 않았다'
    if (!this.alive) return `pane 이 살아 있지 않다: ${this.deadReason ?? '알 수 없음'}`
    if (target.isDefaultSession && process.env.CORRAL_ALLOW_DEFAULT_INPUT !== '1') {
      return 'default 세션 쓰기 금지 (CORRAL_ALLOW_DEFAULT_INPUT=1 로만 푼다)'
    }
    return null
  }

  /** pane 선택. 세대를 올리고 화면을 처음부터 세운다. */
  attach(target: Target | null): void {
    this.detach()
    this.generation += 1
    this.target = target
    this.alive = true
    this.deadReason = null
    this.seededLines = null
    this.lastSnapshot = ''
    this.observedCols = 0
    this.grid = null
    this.gridCheckedAt = 0
    this.apiRows = null
    this.apiLayoutCols = null
    this.inputQueue = []
    this.frames = 0
    this.reads = 0
    this.lastReadMs = null
    this.lastFrameAt = null
    if (target === null) {
      log('term.detach', {})
      this.hooks.onChange()
      return
    }
    log('term.attach', { paneId: target.paneId, session: target.sessionName, generation: this.generation })
    this.hooks.onChange()
    void this.bootstrap(this.generation)
    this.scheduleHeartbeat()
  }

  detach(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.heartbeat) clearTimeout(this.heartbeat)
    this.heartbeat = null
    for (const timer of this.followups) clearTimeout(timer)
    this.followups = []
    if (this.inputTimer) clearTimeout(this.inputTimer)
    this.inputTimer = null
    this.inputQueue = []
    this.dirty = null
    this.target = null
  }

  /** 링크가 다시 live 가 됐다 — 터미널 층도 따라간다 (R3). */
  onLinkLive(): void {
    if (this.target === null) return
    log('term.relive', { paneId: this.target.paneId })
    void this.bootstrap(this.generation)
  }

  /**
   * 구독 push 를 본다. `pane.updated` 는 무파라미터 구독으로 이미 열려 있다 (SessionLink) —
   * 새 구독을 만들지 않고 그 흐름에 훅만 건다.
   */
  onPush(frame: PushFrame): void {
    const target = this.target
    if (target === null) return
    const paneId = paneIdOf(frame)
    if (paneId !== target.paneId) return

    if (frame.event === 'pane_closed') {
      this.die('pane_closed — pane 이 사라졌다')
      return
    }
    if (frame.event === 'pane_exited') {
      // pane 은 남고 프로세스만 끝난 것이다. 화면은 마지막 상태로 굳히고 입력만 막는다.
      this.die('pane_exited — 프로세스가 끝났다')
      return
    }
    if (frame.event !== 'pane_updated') return
    if (dropsPaneEvents()) {
      log('term.event.dropped_by_injection', { paneId, event: frame.event })
      return
    }
    this.markDirty('event')
  }

  /**
   * 목록 층이 "이 pane 은 이제 없다"고 판단했을 때 (LIFE-344 L4 의 선택 비우기 경로).
   *
   * 여기서 `attach(null)` 을 하면 화면이 통째로 사라져 **무엇이 죽었는지 사용자가 못 본다.**
   * 마지막 화면을 그대로 두고 죽었다는 표시만 얹는다 — 그리기는 멈추고 입력도 막힌다.
   */
  markGone(reason: string): void {
    if (this.target === null) return
    this.die(reason)
  }

  private die(reason: string): void {
    if (!this.alive) return
    this.alive = false
    this.deadReason = reason
    if (this.heartbeat) clearTimeout(this.heartbeat)
    this.heartbeat = null
    log('term.dead', { paneId: this.target?.paneId ?? null, reason })
    this.hooks.onChange()
  }

  private markDirty(reason: TerminalReadReason): void {
    if (this.target === null || !this.alive) return
    if (this.reading) {
      // 나가 있는 요청이 있으면 이유만 접어 둔다 — 응답이 오면 한 번 더 읽는다.
      this.dirty = this.dirty ?? reason
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.readOnce(reason, this.generation)
    }, EVENT_COALESCE_MS)
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeat) clearTimeout(this.heartbeat)
    if (this.target === null || !this.alive) return
    const hot = Date.now() - this.lastChangeAt < HOT_WINDOW_MS
    const delay = hot ? HEARTBEAT_HOT_MS : HEARTBEAT_IDLE_MS
    this.heartbeat = setTimeout(() => {
      this.heartbeat = null
      this.markDirty('heartbeat')
      this.scheduleHeartbeat()
    }, delay)
  }

  /** 정책이 약속하는 회복 창 — R2 판정이 이 값을 쓴다. */
  recoveryWindowMs(): number {
    return HEARTBEAT_IDLE_MS + (this.lastReadMs ?? 200)
  }

  policy(): Record<string, unknown> {
    return {
      heartbeatHotMs: HEARTBEAT_HOT_MS,
      heartbeatIdleMs: HEARTBEAT_IDLE_MS,
      hotWindowMs: HOT_WINDOW_MS,
      inputFollowupMs: [...INPUT_FOLLOWUP_MS],
      eventCoalesceMs: EVENT_COALESCE_MS,
      scrollbackLines: SCROLLBACK_LINES,
      recoveryWindowMs: this.recoveryWindowMs(),
    }
  }

  // --- 스냅샷 읽기 --------------------------------------------------------

  private async call(method: string, params: Record<string, unknown>, reason: string): Promise<unknown> {
    const target = this.target
    if (target === null) throw new Error('pane 이 없다')
    const delay = injectedReadDelay()
    if (delay > 0) await sleep(delay)
    const response = await request(target.socketPath, method, params, { reason, timeoutMs: 8000 })
    if (response.error) throw new Error(`${method}: ${response.error.code} ${response.error.message}`)
    return response.result
  }

  /** `pane.read` 응답은 `{type:'pane_read', read:{…}}` 로 한 겹 싸여 온다 (스파이크 실측). */
  private async readSnapshot(
    source: 'visible' | 'recent_unwrapped',
    reason: string,
  ): Promise<{ text: string; revision: number | null; truncated: boolean }> {
    const result = await this.call(
      'pane.read',
      {
        pane_id: this.target?.paneId,
        source,
        format: 'ansi',
        strip_ansi: false,
        ...(source === 'recent_unwrapped' ? { lines: SCROLLBACK_LINES } : {}),
      },
      reason,
    )
    const read = isRecord(result) ? (readRecord(result, 'read') ?? result) : null
    if (read === null) throw new Error('pane.read 응답 모양이 다르다')
    return {
      text: readString(read, 'text') ?? '',
      revision: readNumber(read, 'revision'),
      truncated: read['truncated'] === true,
    }
  }

  /**
   * 격자를 정한다. **rows 는 API 가 주고, cols 는 관측으로 자란다** (분석 §4-ⓐ·ⓓ).
   *
   * 열 수는 API 어디에도 없다 — 스키마 전문에 `grid_cols` 는 그래픽 배치용뿐이고
   * (`pane.graphics.info` 는 셀의 픽셀 크기만 준다), `pane.layout` 의 rect 는 herdr **창**의
   * 배치 기하라 pane 의 PTY 폭과 어긋난다. 실측 두 건:
   *   - 스플릿 뒤 rect 60/60 인데 PTY 는 119/120
   *   - 40x120 PTY 로 세션을 붙였더니 rect 120 · pane 의 PTY 93 (크롬이 27칸)
   *
   * 그래서 **스냅샷에서 관측한 폭**만 쓰고 하한 80 을 둔다. layout 힌트는 상태에 남겨 두되
   * 격자 계산에는 넣지 않는다 — 넣으면 크롬 폭만큼 빈 열을 그린다.
   *
   * 좁게 잡아 잘릴 걱정은 없다. 프레임은 전부 스냅샷 하나에서 나오고, 관측 폭은 **그 스냅샷을
   * 읽는 그 자리에서** 자란다. 지금 격자보다 넓은 줄이 있으면 그 줄을 그리기 **전에** 격자가
   * 먼저 넓어진다. 관측 폭은 줄지 않으므로 짧은 화면이 왔다고 다시 좁아지지도 않는다.
   */
  private async resolveGrid(snapshot: string, force = false): Promise<PaneGrid> {
    // 관측 폭은 **줄지 않는다.** 한 프레임에 짧은 줄만 있었다고 격자를 줄이면 다음 프레임의
    // 긴 줄이 잘린다 — 그게 ⓖ6 이 말한 재생 정합성 붕괴다. 이 계산은 네트워크를 안 쓴다.
    for (const line of splitRows(snapshot)) {
      const width = displayWidth(line)
      if (width > this.observedCols) this.observedCols = width
    }

    if (force || this.grid === null || Date.now() - this.gridCheckedAt > GRID_REFRESH_MS) {
      await this.refreshGridFromApi()
    }

    // **layout 힌트는 열 수의 오라클이 아니다.** rect 는 herdr 창의 배치 기하라 herdr 자신의
    // 크롬(사이드바·거터)을 포함한다 — 실측에서 rect 120 인데 pane 의 PTY 는 93칸이었다
    // (`40-grid-scrollback.json` → `t2`). 그걸 그대로 쓰면 오른쪽에 빈 열 27개를 그린다.
    //
    // 그래서 **관측 폭만 쓴다.** 잘릴 걱정은 없다: 모든 프레임은 스냅샷 하나에서 나오고,
    // 폭은 그 스냅샷을 보고 **같은 프레임 안에서** 자란다. 어떤 줄이 지금 격자보다 넓으면
    // 그 줄을 담은 스냅샷이 도착한 그 순간 격자가 먼저 넓어진다. 힌트는 첫 화면이 비어 있을 때
    // 쓰던 것인데, 그 자리는 하한 80 이 맡는다.
    const layoutCols = this.apiLayoutCols
    const cols = Math.max(this.observedCols, 80)
    const source: PaneGrid['source'] = this.observedCols >= 80 ? 'observed' : 'default'
    return { cols, rows: this.apiRows ?? 24, source, layoutCols, observedCols: this.observedCols }
  }

  /** 행 수와 layout 힌트만 API 에 묻는다 — 왕복 2회라 hot path 에서 뺐다. */
  private async refreshGridFromApi(): Promise<void> {
    const target = this.target
    if (target === null) return
    this.gridCheckedAt = Date.now()
    try {
      const info = await this.call('pane.get', { pane_id: target.paneId }, 'grid')
      const pane = isRecord(info) ? readRecord(info, 'pane') : null
      const scroll = pane === null ? null : readRecord(pane, 'scroll')
      if (scroll !== null) this.apiRows = readNumber(scroll, 'viewport_rows')
    } catch (error) {
      log('term.grid.pane_get_failed', { error: String(error) })
    }
    try {
      const layout = await this.call('pane.layout', { pane_id: target.paneId }, 'grid')
      const snapshotLayout = isRecord(layout) ? readRecord(layout, 'layout') : null
      const panes = snapshotLayout === null ? null : snapshotLayout['panes']
      if (Array.isArray(panes)) {
        for (const item of panes) {
          if (!isRecord(item)) continue
          if (readString(item, 'pane_id') !== target.paneId) continue
          const rect = readRecord(item, 'rect')
          if (rect !== null) this.apiLayoutCols = readNumber(rect, 'width')
        }
      }
    } catch (error) {
      log('term.grid.layout_failed', { error: String(error) })
    }
  }

  /** 붙을 때 한 번 — 스크롤백 씨앗 + 첫 화면. */
  private async bootstrap(generation: number): Promise<void> {
    const target = this.target
    if (target === null) return
    this.reading = true
    const startedAt = Date.now()
    // 세대가 바뀌었으면 여기서 버린다. **버렸다는 사실을 로그에 남긴다** — R4 는
    // "A 의 늦은 응답이 B 화면에 안 부어졌다"를 증명해야 하는데, 조용히 return 하면
    // 화면이 멀쩡한 것이 세대 가드 덕인지 애초에 경합이 없었던 것인지 구분이 안 된다.
    const stale = (at: string): boolean => {
      if (generation === this.generation) return false
      log('term.read.stale', { at, reason: 'attach', generation, current: this.generation })
      return true
    }
    try {
      const visible = await this.readSnapshot('visible', 'attach')
      if (stale('attach.visible')) return
      const grid = await this.resolveGrid(visible.text, true)
      if (stale('attach.grid')) return
      this.grid = grid

      // 스크롤백은 **일반 판에만** 있다. 알트스크린 판은 host 히스토리가 0줄이라
      // 아래 `historyAbove` 가 빈 배열을 돌려준다 — 그게 정답이다 (T5).
      let seed = ''
      let seededLines = 0
      try {
        const recent = await this.readSnapshot('recent_unwrapped', 'attach-scrollback')
        if (stale('attach.scrollback')) return
        const history = historyAbove(splitRows(recent.text), splitRows(visible.text), grid.rows)
        seededLines = history.length
        seed = buildScrollbackSeed(history, grid.rows)
        log('term.scrollback', {
          paneId: target.paneId,
          recentLines: splitRows(recent.text).length,
          truncated: recent.truncated,
          seededLines,
        })
      } catch (error) {
        log('term.scrollback.failed', { paneId: target.paneId, error: String(error) })
      }
      this.seededLines = seededLines

      this.lastSnapshot = visible.text
      this.lastChangeAt = Date.now()
      this.lastReadMs = Date.now() - startedAt
      this.reads += 1
      this.emit({
        kind: 'attach',
        bytes: seed + buildScreenFrame({ snapshot: visible.text, rows: grid.rows }),
        grid,
        reason: 'attach',
        revision: visible.revision,
      })
    } catch (error) {
      log('term.attach.failed', { paneId: target.paneId, error: String(error) })
    } finally {
      if (generation === this.generation) {
        this.reading = false
        this.hooks.onChange()
        if (this.dirty !== null) {
          const reason = this.dirty
          this.dirty = null
          this.markDirty(reason)
        }
      }
    }
  }

  private async readOnce(reason: TerminalReadReason, generation: number): Promise<void> {
    const target = this.target
    if (target === null || generation !== this.generation || !this.alive) return
    if (this.reading) {
      this.dirty = this.dirty ?? reason
      return
    }
    this.reading = true
    const startedAt = Date.now()
    try {
      const visible = await this.readSnapshot('visible', reason)
      // **세대 검사가 여기 있는 이유**: 이 아래부터 렌더러 화면을 건드린다. 느린 pane A 의
      // 응답이 B 를 고른 뒤 돌아오면 B 화면에 A 가 부어진다 (LIFE-344 R3 와 같은 자리).
      if (generation !== this.generation) {
        log('term.read.stale', { reason, generation, current: this.generation })
        return
      }
      this.reads += 1
      this.lastReadMs = Date.now() - startedAt
      const grid = await this.resolveGrid(visible.text)
      if (generation !== this.generation) return
      const gridChanged =
        this.grid === null || this.grid.cols !== grid.cols || this.grid.rows !== grid.rows
      this.grid = grid
      // 화면이 그대로면 프레임을 보내지 않는다 — 정지 화면의 유휴 비용이 여기서 0 이 된다.
      // 단 격자가 바뀌었으면 다시 그려야 한다.
      if (!gridChanged && visible.text === this.lastSnapshot && !forcesRepaint()) {
        log('term.read.unchanged', { reason, revision: visible.revision, ms: this.lastReadMs })
        return
      }
      this.lastSnapshot = visible.text
      this.lastChangeAt = Date.now()
      this.emit({
        kind: 'screen',
        bytes: buildScreenFrame({ snapshot: visible.text, rows: grid.rows }),
        grid,
        reason,
        revision: visible.revision,
      })
    } catch (error) {
      log('term.read.failed', { reason, paneId: target.paneId, error: String(error) })
    } finally {
      if (generation === this.generation) {
        this.reading = false
        this.hooks.onChange()
        if (this.dirty !== null) {
          const next = this.dirty
          this.dirty = null
          this.markDirty(next)
        }
      }
    }
  }

  private emit(part: Omit<TerminalFrame, 'paneId' | 'generation' | 'seq' | 'at'>): void {
    const target = this.target
    if (target === null) return
    this.seq += 1
    this.frames += 1
    this.lastFrameAt = Date.now()
    const frame: TerminalFrame = {
      ...part,
      paneId: target.paneId,
      generation: this.generation,
      seq: this.seq,
      at: this.lastFrameAt,
    }
    log('term.frame', {
      paneId: frame.paneId,
      generation: frame.generation,
      seq: frame.seq,
      kind: frame.kind,
      reason: frame.reason,
      revision: frame.revision,
      bytes: frame.bytes.length,
      cols: frame.grid.cols,
      rows: frame.grid.rows,
      gridSource: frame.grid.source,
    })
    this.hooks.onFrame(frame)
    this.hooks.onChange()
  }

  // --- 입력 --------------------------------------------------------------

  /**
   * 사용자가 친 글자. **로컬 에코가 없다** — herdr 를 돌아온 스냅샷에 그 글자가 실려야 보인다.
   * 그래서 보내자마자 두 박자로 다시 읽는다 (원인이 있는 재읽기다).
   */
  sendText(text: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueue({ kind: 'text', text })
  }

  /**
   * 특수키. `pane.send_text` 로 보내면 xterm.js 가 만든 바이트가 나가는데, 그건 **corral 쪽
   * 터미널의 모드**(DECCKM 등)로 만든 것이라 pane 안 TUI 가 기대하는 모양과 다를 수 있다.
   * 스냅샷에는 모드가 안 실리므로 corral 은 그 모드를 알 수 없다 — herdr 는 안다.
   * 그래서 방향키·Esc·Tab·Enter 는 이름으로 보낸다
   * (실측: `Home`·`PageUp` 은 거부되고 `Up`/`Down`/`Left`/`Right`/`Escape`/`Tab`/`Enter` 는 통과).
   */
  sendKeys(keys: readonly string[]): Promise<{ ok: boolean; error?: string }> {
    return this.enqueue({ kind: 'keys', keys: [...keys] })
  }

  /**
   * 입력을 **순서대로** 내보낸다.
   *
   * 키 하나 = 요청 하나로 그냥 보내면 요청마다 커넥션이 따로라 herdr 도착 순서가 뒤집힌다.
   * 실측에서 `echo I2MARK0` 이 뒤섞여 들어가 명령이 통째로 깨졌다. 그래서 큐를 하나 두고,
   * 나가 있는 전송이 끝날 때까지 들어온 글자는 **한 덩어리로 이어 붙인다** —
   * 순서가 지켜지고 왕복 수도 준다. 특수키는 덩어리 경계가 되어 텍스트 사이에 그대로 낀다.
   */
  private enqueue(item: { kind: 'text'; text: string } | { kind: 'keys'; keys: string[] }): Promise<{ ok: boolean; error?: string }> {
    const blocked = this.inputBlocked()
    if (blocked !== null) {
      log('term.input.blocked', { kind: item.kind, reason: blocked })
      return Promise.resolve({ ok: false, error: blocked })
    }
    return new Promise((resolve) => {
      const last = this.inputQueue[this.inputQueue.length - 1]
      if (item.kind === 'text' && last !== undefined && last.kind === 'text') {
        last.text += item.text
        last.waiters.push(resolve)
      } else if (item.kind === 'text') {
        this.inputQueue.push({ kind: 'text', text: item.text, waiters: [resolve] })
      } else {
        this.inputQueue.push({ kind: 'keys', keys: item.keys, waiters: [resolve] })
      }
      if (this.inputTimer === null && !this.inputSending) {
        this.inputTimer = setTimeout(() => {
          this.inputTimer = null
          void this.flushInput()
        }, INPUT_COALESCE_MS)
      }
    })
  }

  private async flushInput(): Promise<void> {
    if (this.inputSending) return
    this.inputSending = true
    try {
      for (;;) {
        const item = this.inputQueue.shift()
        if (item === undefined) return
        const target = this.target
        if (target === null) {
          for (const waiter of item.waiters) waiter({ ok: false, error: 'pane 이 없다' })
          continue
        }
        const generation = this.generation
        const method = item.kind === 'text' ? 'pane.send_text' : 'pane.send_keys'
        const params = item.kind === 'text' ? { text: item.text } : { keys: item.keys }
        const label = item.kind === 'text' ? `text:${JSON.stringify(item.text).slice(0, 80)}` : `keys:${item.keys.join(',')}`
        let result: { ok: boolean; error?: string }
        try {
          await this.call(method, { pane_id: target.paneId, ...params }, 'input')
          log('term.input.sent', { method, label, paneId: target.paneId, generation, batched: item.waiters.length })
          result = { ok: true }
        } catch (error) {
          log('term.input.failed', { method, label, error: String(error) })
          result = { ok: false, error: String(error) }
        }
        for (const waiter of item.waiters) waiter(result)
        if (result.ok) this.scheduleInputFollowups(generation)
      }
    } finally {
      this.inputSending = false
      if (this.inputQueue.length > 0 && this.inputTimer === null) {
        this.inputTimer = setTimeout(() => {
          this.inputTimer = null
          void this.flushInput()
        }, INPUT_COALESCE_MS)
      }
    }
  }

  /** 행동에 딸린 재읽기 — 폴링이 아니다 (01-criteria.md §4). */
  private scheduleInputFollowups(generation: number): void {
    for (const delay of INPUT_FOLLOWUP_MS) {
      const timer = setTimeout(() => {
        this.followups = this.followups.filter((item) => item !== timer)
        if (generation !== this.generation) return
        this.markDirty('input')
      }, delay)
      this.followups.push(timer)
    }
  }
}

/** 큐에 담기는 입력 한 덩어리. 텍스트는 이어 붙고, 특수키는 덩어리 경계가 된다. */
type InputItem =
  | { kind: 'text'; text: string; waiters: Array<(result: { ok: boolean; error?: string }) => void> }
  | { kind: 'keys'; keys: string[]; waiters: Array<(result: { ok: boolean; error?: string }) => void> }

/** push 봉투에서 pane id 를 꺼낸다. 봉투 모양이 두 갈래다 (`pane` 객체 안 / 최상위). */
function paneIdOf(frame: PushFrame): string | null {
  const direct = readString(frame.data, 'pane_id')
  if (direct !== null) return direct
  const pane = readRecord(frame.data, 'pane')
  return pane === null ? null : readString(pane, 'pane_id')
}

/**
 * ANSI 가 섞인 행의 **표시 폭**. SGR 을 걷어내고 wide char 를 2칸으로 센다.
 *
 * 정밀한 유니코드 폭 계산은 xterm.js 가 렌더러에서 한다. 여기서 필요한 것은 격자를 정할
 * **하한**뿐이라 CJK·전각 구간만 2로 세는 근사로 충분하다 — 과소평가하면 격자가 작아져
 * 행이 접히므로, 애매하면 넓게 세는 쪽으로 기운다.
 */
export function displayWidth(line: string): number {
  // ANSI 제어열을 걷어낸다. 제어문자가 패턴에 들어가는 것이 이 함수의 목적이라 규칙을 끈다.
  // eslint-disable-next-line no-control-regex
  const csi = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g
  // eslint-disable-next-line no-control-regex
  const osc = /\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)?/g
  const plain = line.replace(csi, '').replace(osc, '')
  let width = 0
  for (const ch of plain) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x200d) continue
    width += isWide(code) ? 2 : 1
  }
  return width
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}
