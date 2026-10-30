// LIFE-520 K4ⓐ·ⓑ·ⓓ — 감지 결과를 쓰는 순수 함수. 상태 세 가지: Ⓟ 감지 전·실패(unknown) · Ⓝ 완료 n개 · Ⓩ 완료 0개.
import { describe, expect, it } from 'vitest'
import { UNKNOWN_AGENT_DETECTION, type AgentDetectionSnapshot, type DetectableAgent } from '../../shared/agent-detection.js'
import { DEFAULT_AGENT_VALUES, type DefaultAgent } from '../../shared/terminal-settings.js'
import { initialStartAgent, startAgentChoices } from './start-work-model.js'
import { autoAgent, buildAgentLaunchOptions, findMatchingAgentLaunchOptions, orderAgentLaunchOptions, resolveNewAgentTab, type NewAgentTabTarget } from './tab-create-menu.js'

const detected = (...agents: DetectableAgent[]): AgentDetectionSnapshot => ({
  kind: 'detected',
  agents: agents.map((agent) => ({ agent, path: `/x/${agent}`, source: 'login-shell' })),
  shell: { ok: true },
  at: 1,
})
const P = UNKNOWN_AGENT_DETECTION
const N = detected('codex', 'grok') // claude 미감지
const Z = detected()

const agentTab = (agent: 'claude' | 'codex' | 'grok'): NewAgentTabTarget => ({ kind: 'agent', agent })
const shellTab: NewAgentTabTarget = { kind: 'shell' }

describe('⌘⌥T resolveNewAgentTab (K4ⓐ) — 상태 3 × 기본값 5', () => {
  const table: Array<{ state: string; detection: AgentDetectionSnapshot; expected: Record<DefaultAgent, NewAgentTabTarget> }> = [
    // Ⓟ = base(`tab-create-menu.ts:118-129`) — 자동 Claude, 명시 그대로.
    { state: 'Ⓟ', detection: P, expected: { auto: agentTab('claude'), blank: shellTab, claude: agentTab('claude'), codex: agentTab('codex'), grok: agentTab('grok') } },
    // Ⓝ — 자동 = 감지된 것 중 카탈로그 순 첫 번째(codex). 명시 미감지(claude) = 자동 규칙.
    { state: 'Ⓝ', detection: N, expected: { auto: agentTab('codex'), blank: shellTab, claude: agentTab('codex'), codex: agentTab('codex'), grok: agentTab('grok') } },
    // Ⓩ — 자동·미감지 명시 = 빈 터미널(E4).
    { state: 'Ⓩ', detection: Z, expected: { auto: shellTab, blank: shellTab, claude: shellTab, codex: shellTab, grok: shellTab } },
  ]
  for (const row of table) {
    it(`${row.state}`, () => {
      for (const defaultAgent of DEFAULT_AGENT_VALUES) {
        expect([defaultAgent, resolveNewAgentTab({ defaultAgent, detection: row.detection })]).toEqual([defaultAgent, row.expected[defaultAgent]])
      }
    })
  }
  it('자동 = 감지 순서가 아니라 카탈로그 순서 — grok 이 먼저 감지돼도 claude 가 있으면 claude', () => {
    const outOfOrder: AgentDetectionSnapshot = { kind: 'detected', shell: { ok: true }, at: 1, agents: [{ agent: 'grok', path: '/g', source: 'fallback' }, { agent: 'claude', path: '/c', source: 'login-shell' }] }
    expect(autoAgent(outOfOrder)).toBe('claude')
    expect(resolveNewAgentTab({ defaultAgent: 'auto', detection: detected('grok') })).toEqual(agentTab('grok'))
  })
})

describe('+ 메뉴 목록 (K4ⓑ)', () => {
  const ids = (detection: AgentDetectionSnapshot): string[] => buildAgentLaunchOptions(detection).map((option) => option.agent)
  it('Ⓟ 면 3종(base `TabCreateMenu.tsx:149-153`) · 인자 없는 호출과 같다', () => {
    expect(ids(P)).toEqual(['claude', 'codex', 'grok'])
    expect(buildAgentLaunchOptions(P)).toEqual(buildAgentLaunchOptions())
  })
  it('Ⓝ 면 감지된 것만, 카탈로그 순서', () => {
    expect(ids(N)).toEqual(['codex', 'grok'])
    expect(ids(detected('grok', 'claude'))).toEqual(['claude', 'grok'])
  })
  it('Ⓩ 면 빈 목록', () => {
    expect(ids(Z)).toEqual([])
  })
  it('검색 결과도 감지된 것 안에서만 — 미감지 claude 는 정확한 별칭으로도 안 나온다', () => {
    expect(findMatchingAgentLaunchOptions({ query: 'claude', options: buildAgentLaunchOptions(N) })).toEqual([])
    expect(findMatchingAgentLaunchOptions({ query: 'codex', options: buildAgentLaunchOptions(N) }).map((option) => option.agent)).toEqual(['codex'])
  })
  it('명시 기본값 맨 앞 규칙은 감지된 것 안에서 유지, 미감지 명시값은 끼어들지 않는다', () => {
    const order = ({ detection, defaultAgent }: { detection: AgentDetectionSnapshot; defaultAgent: DefaultAgent }): string[] =>
      orderAgentLaunchOptions({ options: buildAgentLaunchOptions(detection), defaultAgent }).map((option) => option.agent)
    expect(order({ detection: N, defaultAgent: 'grok' })).toEqual(['grok', 'codex'])
    expect(order({ detection: N, defaultAgent: 'claude' })).toEqual(['codex', 'grok'])
    expect(order({ detection: P, defaultAgent: 'grok' })).toEqual(['grok', 'claude', 'codex'])
  })
})

describe('작업 시작 모달 에이전트 칸 (K4ⓓ 모델)', () => {
  it('선택지 = 감지된 것 + 빈 터미널, Ⓟ 면 base 4칸(`StartWorkModal.tsx:15-20`)', () => {
    expect(startAgentChoices(P)).toEqual(['claude', 'codex', 'grok', 'shell'])
    expect(startAgentChoices(N)).toEqual(['codex', 'grok', 'shell'])
    expect(startAgentChoices(Z)).toEqual(['shell'])
  })
  it('초기 선택 — 감지됐으면 그대로, 미감지면 자동 규칙, Ⓩ 면 빈 터미널', () => {
    expect(initialStartAgent({ preferred: 'claude', detection: P })).toBe('claude')
    expect(initialStartAgent({ preferred: 'claude', detection: detected('claude', 'grok') })).toBe('claude')
    expect(initialStartAgent({ preferred: 'claude', detection: N })).toBe('codex')
    expect(initialStartAgent({ preferred: 'claude', detection: Z })).toBe('shell')
    expect(initialStartAgent({ preferred: 'shell', detection: N })).toBe('shell')
  })
})
