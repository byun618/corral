// 폰 쓰기의 herdr 쪽 (LIFE-582) — CLI `terminal prompt` 와 같은 guard 봉투(`TerminalBackend`)로 관측·넣기를 한다.
// CLI 경로(`runtime/terminal/index.ts`)는 건드리지 않는다: 이 파일은 AgentRecord 를 읽지도 쓰지도 않는다 — 관리되지 않은 pane(데스크톱 GUI 로 연 세션)도
// 같은 관문·같은 compare-and-submit 으로 받는다(P1). 소유 기록은 채널의 provider 세션 참조가 정한다(`input.ts` `resolveFile`).
import { TerminalBackend, type TerminalIdentity, type TerminalOperation } from '../adapter/index.js'
import { RuntimeError } from '../../runtime/contracts.js'
import { agentQuiescent, evaluateManifest } from '../../runtime/terminal/agent.js'
import type { InputBackend, KeyResult, PaneObservation, ScreenRead, SendResult } from './input.js'
import type { MobileAgentKind } from './list.js'

/** 한 호출의 마감 — 관측·넣기 모두 짧다. */
const CALL_MS = 8_000

/** guard·herdr 가 **아무것도 쓰지 않고** 거절한 것 — 다시 기다려도 된다. 그 밖의 실패(시간 초과 등)는 썼을 수 있다(`unknown`). */
const REFUSED: ReadonlySet<string> = new Set(['agent_not_ready', 'agent_blocked', 'agent_state_changed', 'agent_not_found', 'stale_terminal', 'stale_backend', 'deadline_exceeded', 'invalid_request', 'unsupported', 'input_changed', 'input_recent'])

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
      return { status: info.status, seq: info.stateChangeSeq, quiet: agentQuiescent(info), unmanaged: settled && !info.launchPending && !info.interactiveReady, input: info.input ?? null }
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'agent_not_found') return { status: 'none', seq: -1, quiet: false, unmanaged: false, input: null }
      throw error
    }
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
  prompt(pane: TerminalIdentity, input: { text: string; seq: number; inputRevision: number; minIdleMs: number }): Promise<SendResult> {
    return this.effect(() => this.backend.promptAgentIfQuiet(pane, { text: input.text, expectedStateChangeSeq: input.seq, inputRevision: input.inputRevision, minIdleMs: input.minIdleMs }, this.ctx()))
  }

  /** seq 비교 + (주면) 입력 revision 울타리(R2-A1). 쓴 뒤 revision 을 돌려준다 — 다음 키의 울타리. */
  async send(pane: TerminalIdentity, input: { text: string; seq: number; inputRevision: number | null }): Promise<KeyResult> {
    const { inputRevision } = input
    if (inputRevision === null) {
      const sent = await this.effect(() => this.backend.sendIfUnchanged(pane, input.text, input.seq, this.ctx()))
      return sent === 'sent' ? { kind: 'sent', revision: null } : { kind: sent }
    }
    let revision: number | null = null
    const sent = await this.effect(async () => {
      revision = (await this.backend.sendFenced(pane, { text: input.text, expectedStateChangeSeq: input.seq, inputRevision }, this.ctx())).revision
    })
    return sent === 'sent' ? { kind: 'sent', revision } : { kind: sent }
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
