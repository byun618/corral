// 에이전트 감지 결과 (LIFE-520 S33) — main 이 만들고 렌더러가 읽는다.
//
// 두 상태만 있다: `unknown` = 감지 전·실패(결과 없음, 화면은 base 와 같다) · `detected` = 감지가 끝났다(0개 포함).
// 0개(`detected` + 빈 목록)와 결과 없음(`unknown`)은 다른 값이다 — Orca #9011(빈 결과를 「없음」 으로 굳힘) 회피(E2).

export const DETECTABLE_AGENTS = ['claude', 'codex', 'grok'] as const
export type DetectableAgent = (typeof DETECTABLE_AGENTS)[number]

/** 어디서 찾았나 — 로그인 셸 PATH(`$SHELL -ilc`) 또는 사용자 설치 폴더 폴백. */
export type DetectionSource = 'login-shell' | 'fallback'

export type DetectedAgent = { agent: DetectableAgent; path: string; source: DetectionSource }

/** 로그인 셸 조회 결과 — 실패면 이유. 실패한 회차의 결과는 캐시하지 않는다(E2). `aborted` = 새로고침이 덮었거나 앱 종료로 끊은 회차(fix1 R1-06·R1-07). */
export type ShellProbeOutcome = { ok: true } | { ok: false; reason: 'timeout' | 'exit' | 'no-marker' | 'spawn-error' | 'aborted' }

export type AgentDetectionSnapshot =
  | { kind: 'unknown' }
  | { kind: 'detected'; agents: DetectedAgent[]; shell: ShellProbeOutcome; at: number }

/** IPC 채널 이름 — main 등록·preload 호출·푸시가 이 한 곳을 쓴다(fix2 R2-02). */
export const AGENT_DETECTION_CHANNEL = { get: 'corral:agentDetectionGet', refresh: 'corral:agentDetectionRefresh', push: 'corral:agentDetection' } as const

export const UNKNOWN_AGENT_DETECTION: AgentDetectionSnapshot = { kind: 'unknown' }

function isDetectableAgent(value: unknown): value is DetectableAgent {
  return DETECTABLE_AGENTS.some((agent) => agent === value)
}

function readDetectedAgent(value: unknown): DetectedAgent | null {
  if (typeof value !== 'object' || value === null) return null
  const agent = 'agent' in value ? value.agent : undefined
  const path = 'path' in value ? value.path : undefined
  const source = 'source' in value ? value.source : undefined
  if (!isDetectableAgent(agent) || typeof path !== 'string') return null
  if (source !== 'login-shell' && source !== 'fallback') return null
  return { agent, path, source }
}

function readShellOutcome(value: unknown): ShellProbeOutcome {
  if (typeof value === 'object' && value !== null && 'ok' in value && value.ok === true) return { ok: true }
  const reason = typeof value === 'object' && value !== null && 'reason' in value ? value.reason : undefined
  switch (reason) {
    case 'timeout':
    case 'exit':
    case 'no-marker':
    case 'spawn-error':
    case 'aborted':
      return { ok: false, reason }
    default:
      return { ok: false, reason: 'exit' }
  }
}

/** IPC 로 받은 값을 다시 읽는다 — 모양이 다르면 `unknown`(base 화면). */
export function readAgentDetection(value: unknown): AgentDetectionSnapshot {
  if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'detected') return UNKNOWN_AGENT_DETECTION
  const agents = 'agents' in value && Array.isArray(value.agents) ? value.agents.map(readDetectedAgent).filter((agent) => agent !== null) : []
  const shell = readShellOutcome('shell' in value ? value.shell : undefined)
  const at = 'at' in value && typeof value.at === 'number' ? value.at : 0
  return { kind: 'detected', agents, shell, at }
}
