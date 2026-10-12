// 세션 글리프 표 — **상태 글리프**와 **에이전트 종류 아이콘** 두 축.
// `SessionRow`(사이드바) · 접힘 요약 행 · `MainTabBar` 가 같은 표를 공유한다. 한 군데서만
// 고치면 세 곳이 같이 움직인다 — 목록과 탭바가 다른 글리프를 쓰면 같은 세션이 달라 보인다.
import type { AgentKind, AgentStatus } from './types.js'

/**
 * §2.5 SessionRow **상태** 글리프 표. corral 의 `AgentStatus` **다섯 값**에 대응시킨다.
 *
 * `done` 은 LIFE-456 에서 생겼다 — 「끝났는데 아직 안 봄」이다. **이 작업은 표시를 새로
 * 그리지 않는다**(기준 S7 — 아이콘·색·배치는 LIFE-448·449 몫). 그래서 스펙이 적어 둔
 * 완료 `✓` 를 만들지 않고 **기존 글리프·톤 중 가장 가까운 것**을 임시로 쓴다:
 * 글리프는 idle·unknown 과 같은 `◉`, 톤은 `ok`(`--st-ok` 초록 — LIFE-594 D1 로 accent 에서 떼어 낸 상태 토큰)다.
 * 새 글자도 새 색도 늘리지 않으면서 idle 과 눈으로 갈린다. 대응표는 결과 문서에 있다.
 *
 * 스펙에 있으나 아직 **못 그리는 칸**(09-gate1-fix.md E — 만들지 않고 명시한다):
 *   · 에러 `✕` `--st-error` — `AgentStatus` 에 `error` 가 없다. 가장 가까운 `blocked` 는
 *     "막혔다"이지 "실패했다"가 아니라 같은 칸으로 셈하지 않는다 (출처는 LIFE-458 몫).
 * 미상은 §2.5 원문대로 `◉` + `--fg-faint` 다 (실행 중 `◉` 와 글리프가 같고 색으로 갈린다).
 */
export const GLYPH: Record<AgentStatus, { glyph: string; tone: 'ok' | 'dirty' | 'behind' | 'error' | 'faint' }> = {
  working: { glyph: '⚡', tone: 'dirty' },
  idle: { glyph: '◉', tone: 'behind' },
  blocked: { glyph: '!', tone: 'error' },
  /** 임시 대응 — 기존 `◉` + `--st-ok` 토큰 (위 주석, 448·449 가 바꿀 자리). */
  done: { glyph: '◉', tone: 'ok' },
  unknown: { glyph: '◉', tone: 'faint' },
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: '대기',
  working: '작업중',
  blocked: '막힘',
  done: '완료',
  unknown: '미상',
}

/**
 * **에이전트 종류** 아이콘 (10-gate1-fix2.md H-6). Orca 세션 행은 글리프가 둘이다 —
 * 상태(`⊙`) + 종류(`☀`). corral 도 두 칸으로 나눈다.
 *
 * `AgentKind` 에 **있는 네 값만** 다룬다. herdr 가 모르는 문자열을 주면 아이콘을 그리지
 * 않는다(`agentIcon` 이 null) — 없는 종류를 지어내지 않는다는 뜻이다.
 * 색은 전부 토큰(`--agent-*`)이고 CSS 에 리터럴 hex 를 두지 않는다.
 */
export const AGENT_ICON: Record<AgentKind, { glyph: string; label: string }> = {
  claude: { glyph: '✳', label: 'claude' },
  codex: { glyph: '◆', label: 'codex' },
  grok: { glyph: '✦', label: 'grok' },
  shell: { glyph: '$', label: '셸' },
}

function isAgentKind(value: string): value is AgentKind {
  return value === 'claude' || value === 'codex' || value === 'grok' || value === 'shell'
}

/** 모르는 종류면 `null` — 아이콘 칸 자체를 그리지 않는다(빈 칸이 아니라 부재). */
export function agentIcon(agent: string | null): { kind: AgentKind; glyph: string; label: string } | null {
  if (agent === null) return null
  if (!isAgentKind(agent)) return null
  return { kind: agent, ...AGENT_ICON[agent] }
}
