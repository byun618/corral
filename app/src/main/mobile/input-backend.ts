// 폰 쓰기의 herdr 쪽 (LIFE-582) — CLI `terminal prompt` 와 같은 guard 봉투(`TerminalBackend`)로 관측·넣기를 한다.
// CLI 경로(`runtime/terminal/index.ts`)는 건드리지 않는다: 이 파일은 AgentRecord 를 읽지도 쓰지도 않는다 — 관리되지 않은 pane(데스크톱 GUI 로 연 세션)도
// 같은 관문·같은 compare-and-submit 으로 받는다(P1). 소유 기록은 채널의 provider 세션 참조가 정한다(`input.ts` `resolveFile`).
// LIFE-597: herdr 관리 밖 pane(셸에서 직접 친 provider)은 guard 가 `unmanaged_agent` 를 알 때만 — 종류 결속 + settle 을 guard 가 같은 턴에서 본다.
import { TerminalBackend, type TerminalIdentity, type TerminalOperation } from '../adapter/index.js'
import { RuntimeError } from '../../runtime/contracts.js'
import { agentQuiescent, evaluateManifest } from '../../runtime/terminal/agent.js'
import { observedSessionKey, type InputBackend, type KeyResult, type PaneObservation, type ScreenRead, type SendResult } from './input.js'
import type { MobileAgentKind } from './list.js'

/** 한 호출의 마감 — 관측·넣기 모두 짧다. */
const CALL_MS = 8_000
/**
 * LIFE-597: 관리 밖 pane 의 settle — herdr `AGENT_START_SETTLE_DELAY`(관리 기동이 Active 가 되기 전 기다리는 값)와 같다.
 * guard 가 넣는 턴에서 같은 값으로 다시 잰다(못 넘으면 쓰지 않고 거절) — 여기서는 거절로 헛도는 대신 기다리려고 미리 본다.
 */
export const UNMANAGED_SETTLE_MS = 3_000

/** guard·herdr 가 **아무것도 쓰지 않고** 거절한 것 — 다시 기다려도 된다. 그 밖의 실패(시간 초과 등)는 썼을 수 있다(`unknown`). */
const REFUSED: ReadonlySet<string> = new Set(['agent_not_ready', 'agent_blocked', 'agent_state_changed', 'agent_not_found', 'stale_terminal', 'stale_backend', 'deadline_exceeded', 'invalid_request', 'unsupported', 'input_changed', 'input_recent', 'any_input_changed'])

export class HerdrInputBackend implements InputBackend {
  private readonly backend: TerminalBackend
  private epoch: string | null = null

  constructor(socket: string) {
    this.backend = new TerminalBackend(socket)
  }

  private ctx(): TerminalOperation {
    return { signal: new AbortController().signal, deadlineAt: Date.now() + CALL_MS }
  }

  private async currentEpoch(): Promise<string> {
    const epoch = await this.backend.epoch(this.ctx())
    this.epoch = epoch
    return epoch
  }

  async locate(paneId: string): Promise<TerminalIdentity | null> {
    const epoch = await this.currentEpoch()
    // agent 팔이 없는 백엔드(guard 아님)에는 쓰지 않는다 — CLI 와 같은 전제.
    if (!this.backend.agentCapable()) return null
    return (await this.backend.list(epoch, this.ctx())).find((pane) => pane.paneId === paneId) ?? null
  }

  async observe(pane: TerminalIdentity): Promise<PaneObservation> {
    try {
      const info = await this.backend.agentInfo(pane, this.ctx())
      const settled = info.status === 'idle' || info.status === 'done'
      const unmanaged = settled && !info.launchPending && !info.interactiveReady
      const unmanagedQuiet = unmanaged && this.backend.unmanagedPromptCapable() && (info.stateQuietMs ?? 0) >= UNMANAGED_SETTLE_MS
      // LIFE-598: herdr 가 지금 말하는 provider 세션 — 허브가 효과 직전 접수 때 묶은 세션과 대조한다(목록은 늦게 바뀐다).
      return { status: info.status, seq: info.stateChangeSeq, quiet: agentQuiescent(info) || unmanagedQuiet, unmanaged, input: info.input ?? null, anyInput: info.anyInput ?? null, session: info.session === null ? null : observedSessionKey(info.session) }
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'agent_not_found') return { status: 'none', seq: -1, quiet: false, unmanaged: false, input: null, anyInput: null, session: null }
      throw error
    }
  }

  unmanagedPrompt(): boolean {
    return this.backend.unmanagedPromptCapable()
  }

  async manifestVerified(kind: MobileAgentKind): Promise<boolean> {
    const epoch = this.epoch ?? (await this.currentEpoch())
    try {
      return evaluateManifest(kind, await this.backend.agentManifests(epoch, this.ctx()), null).verified
    } catch (error) {
      return evaluateManifest(kind, null, error instanceof Error ? error.message : String(error)).verified
    }
  }

  /** R2-A3: 화면과 같은 guard 턴의 입력 revision·조용한 시간·seq. */
  screen(pane: TerminalIdentity): Promise<ScreenRead> {
    return this.backend.screenRead(pane, this.ctx())
  }

  /** LIFE-582 R1-A3: 관측한 입력 revision·조용한 시간까지 guard 가 같은 턴에서 비교한다(`input_changed`·`input_recent` = 쓰지 않았다). */
  prompt(pane: TerminalIdentity, input: { text: string; seq: number; inputRevision: number; minIdleMs: number; unmanagedAgent: MobileAgentKind | null }): Promise<SendResult> {
    return this.effect(() => this.backend.promptAgentIfQuiet(pane, { text: input.text, expectedStateChangeSeq: input.seq, inputRevision: input.inputRevision, minIdleMs: input.minIdleMs, unmanagedAgent: input.unmanagedAgent }, this.ctx()))
  }

  /** seq 비교 + (주면) 입력 revision 울타리(R2-A1)·모든 입력 울타리(LIFE-708 r1). 쓴 뒤 두 revision 을 돌려준다 — 다음 키의 울타리. */
  async send(pane: TerminalIdentity, input: { text: string; seq: number; inputRevision: number | null; anyInputRevision: number | null }): Promise<KeyResult> {
    const { inputRevision } = input
    if (inputRevision === null) {
      const sent = await this.effect(() => this.backend.sendIfUnchanged(pane, input.text, input.seq, this.ctx()))
      return sent === 'sent' ? { kind: 'sent', revision: null, anyRevision: null } : { kind: sent }
    }
    let after: { revision: number | null; anyRevision: number | null } = { revision: null, anyRevision: null }
    const sent = await this.effect(async () => {
      after = await this.backend.sendFenced(pane, { text: input.text, expectedStateChangeSeq: input.seq, inputRevision, anyInputRevision: input.anyInputRevision }, this.ctx())
    })
    return sent === 'sent' ? { kind: 'sent', ...after } : { kind: sent }
  }

  private async effect(run: () => Promise<unknown>): Promise<SendResult> {
    try {
      await run()
      return 'sent'
    } catch (error) {
      if (error instanceof RuntimeError && REFUSED.has(error.code)) return 'refused'
      return 'unknown'
    }
  }
}
