/**
 * orchestration 계보를 `AppState` 로 흘리는 main 쪽 끝 (LIFE-459).
 *
 * 런타임은 main 안에서 in-process 로 돌지만 저장소에 변경 이벤트가 없다 — `state.json` 을 atomic
 * rename 으로 쓸 뿐이다. 그래서 **주기 조회**로 안다: 파일 지문(`stat`)이 같으면 다시 파싱하지 않고,
 * 워커 pane 이 화면 세션에 하나도 살아 있지 않으면 백엔드도 부르지 않는다. 세대 대조에 필요한
 * pane 목록은 그때만 한 번 본다. 결과가 **바뀌었을 때만** `onChange` 를 부른다 — 바뀐 게 없는데
 * emit 하면 화면 전체를 다시 그리게 된다.
 */
import type { OrchestrationLineage } from '../shared/types.js'
import type { PaneSnapshot } from '../runtime/orchestration/index.js'
import { resolveLineage } from '../runtime/orchestration/lineage.js'
import type { OrchestrationState } from '../runtime/orchestration/model.js'

export interface LineageSource {
  /** 런타임이 모는 백엔드 소켓·세션 (`CORRAL_BACKEND_SOCKET`·`CORRAL_SESSION`). */
  runtimeBackend: () => { socket: string; session: string } | null
  /** 화면이 붙은 세션의 소켓 — `PaneRow.paneId` 가 이 세션의 것이다. */
  guiSocket: () => string | null
  /** 화면 세션에 지금 살아 있는 pane id. */
  livePaneIds: () => ReadonlySet<string>
  /** `state.json` 의 지문. 파일이 없으면 null. */
  stamp: () => string | null
  read: () => OrchestrationState
  observe: () => Promise<PaneSnapshot>
  /** 두 소켓 경로가 같은 파일인가 (심링크·`/private` 접두를 푼다). */
  sameSocket: (a: string, b: string) => boolean
}

export class LineageFeed {
  private lineage: OrchestrationLineage = { state: 'unavailable', reason: 'unobserved' }
  private cached: { stamp: string; state: OrchestrationState } | null = null

  constructor(private readonly source: LineageSource, private readonly onChange: () => void) {}

  current(): OrchestrationLineage { return this.lineage }

  private refreshing = false

  /** 앞 회차가 백엔드를 기다리는 중이면 이번 회차는 건너뛴다 — 겹쳐 돌면 늦은 쪽이 새 값을 덮는다. */
  async refresh(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      const next = await this.compute()
      if (JSON.stringify(next) === JSON.stringify(this.lineage)) return
      this.lineage = next
      this.onChange()
    } finally { this.refreshing = false }
  }

  private async compute(): Promise<OrchestrationLineage> {
    const backend = this.source.runtimeBackend()
    if (backend === null) return { state: 'unavailable', reason: 'no_backend' }
    const gui = this.source.guiSocket()
    // 런타임과 화면이 다른 세션이면 pane id 가 다른 이름공간이다 — 같은 `w1:p1` 이 다른 pane 이다.
    if (gui === null || !this.source.sameSocket(gui, backend.socket)) return { state: 'unavailable', reason: 'session_mismatch' }
    const stamp = this.source.stamp()
    if (stamp === null) return { state: 'ready', entries: [] }
    let state: OrchestrationState
    try {
      if (this.cached?.stamp !== stamp) this.cached = { stamp, state: this.source.read() }
      state = this.cached.state
    } catch {
      this.cached = null
      return { state: 'unavailable', reason: 'store_unreadable' }
    }
    const live = this.source.livePaneIds()
    if (!state.dispatches.some(entry => entry.worker !== null && live.has(entry.target.paneId))) return { state: 'ready', entries: [] }
    const seen = await this.source.observe()
    if (!seen.observed) return { state: 'unavailable', reason: 'unobserved' }
    return { state: 'ready', entries: resolveLineage(state, { session: backend.session, epoch: seen.epoch, panes: seen.panes }) }
  }
}
