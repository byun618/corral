// @vitest-environment happy-dom
// LIFE-520 K4ⓑ·ⓒ·ⓓ·ⓔ · K2ⓑ — 감지 결과를 쓰는 화면 셋(설정 「기본 Agent」 · `+` 메뉴 · 작업 시작 모달)을 상태 세 가지(Ⓟ·Ⓝ·Ⓩ)로 본다.
// 감지 결과는 가짜 preload(`getAgentDetection`·`onAgentDetection`·`refreshAgentDetection`)로 넣는다. 저장 쓰기는 `setSettings` 호출로 센다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentDetectionSnapshot, DetectableAgent } from '../../../shared/agent-detection.js'
import type { StartAgent } from '../../../shared/agent-options.js'
import { DEFAULT_SETTINGS, type DefaultAgent, type Settings, type SettingsWriteResult } from '../../../shared/terminal-settings.js'
import { resetAgentDetectionStoreForTest } from '../agent-detection-store.js'
import { BindingLabels } from '../hooks/BindingLabels.js'
import type { StartWorkModel } from '../hooks/useStartWork.js'
import { resetSettingsStoreForTest } from '../settings-store.js'
import { AgentsSection } from './AgentsSection.js'
import { StartWorkModal } from './StartWorkModal.js'
import { TabCreateMenu } from './TabCreateMenu.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const detected = (...agents: DetectableAgent[]): AgentDetectionSnapshot => ({
  kind: 'detected',
  agents: agents.map((agent) => ({ agent, path: `/x/${agent}`, source: 'login-shell' })),
  shell: { ok: true },
  at: 1,
})
const N = detected('codex', 'grok')
const Z = detected()

let host: HTMLDivElement
let root: Root
let stored: Settings
const writes: Array<Partial<Settings>> = []
let detectionPushes: Array<(next: AgentDetectionSnapshot) => void>
let refreshCalls = 0
/** getAgentDetection 응답 — null 이면 영영 오지 않는다(감지 진행 중, K2ⓑ). */
let initial: AgentDetectionSnapshot | null
let refreshResult: AgentDetectionSnapshot

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  stored = { ...DEFAULT_SETTINGS }
  writes.length = 0
  detectionPushes = []
  refreshCalls = 0
  initial = null
  refreshResult = N
  Reflect.set(window, 'corral', {
    getSettingsSync: () => stored,
    onSettings: () => () => {},
    setSettings: async (patch: Partial<Settings>): Promise<SettingsWriteResult> => {
      writes.push(patch)
      stored = { ...stored, ...patch }
      return { status: 'saved', settings: stored }
    },
    getAgentDetection: () => (initial === null ? new Promise<AgentDetectionSnapshot>(() => {}) : Promise.resolve(initial)),
    onAgentDetection: (listener: (next: AgentDetectionSnapshot) => void) => {
      detectionPushes.push(listener)
      return () => {}
    },
    refreshAgentDetection: async (): Promise<AgentDetectionSnapshot> => {
      refreshCalls += 1
      return refreshResult
    },
  })
  resetSettingsStoreForTest(null)
  resetAgentDetectionStoreForTest()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'corral')
  resetSettingsStoreForTest(null)
  resetAgentDetectionStoreForTest()
})

const render = async (element: React.ReactElement): Promise<void> => {
  await act(async () => root.render(createElement(BindingLabels.Provider, { value: {} }, element)))
}
const push = (next: AgentDetectionSnapshot): void => act(() => { for (const listener of detectionPushes) listener(next) })
const withDefault = (defaultAgent: DefaultAgent): void => {
  stored = { ...DEFAULT_SETTINGS, defaultAgent }
}

// ── 설정 「기본 Agent」 (K4ⓒ) ──

const pillIds = (): Array<string | undefined> => [...host.querySelectorAll<HTMLButtonElement>('[data-default-agent]')].map((button) => button.dataset.defaultAgent)
const description = (): string => host.querySelector('[data-settings-subsection-header] p')?.textContent ?? ''

describe('설정 「기본 Agent」 (K4ⓒ)', () => {
  it('Ⓟ(감지 진행 중 — 응답이 아직 없다) = base pill 다섯·base 자동 설명 (K2ⓑ)', async () => {
    await render(createElement(AgentsSection))
    expect(pillIds()).toEqual(['auto', 'blank', 'claude', 'codex', 'grok'])
    expect(description()).toContain('자동은 목록의 첫 번째 agent(Claude)입니다.')
    expect(host.querySelector('[data-agent-detect-empty]')).toBeNull()
    expect(host.querySelector('[data-default-agent-missing]')).toBeNull()
  })
  it('Ⓝ = 자동·빈 terminal + 감지된 것, 자동 설명이 실제 대상(Codex)', async () => {
    initial = N
    await render(createElement(AgentsSection))
    expect(pillIds()).toEqual(['auto', 'blank', 'codex', 'grok'])
    expect(description()).toContain('자동은 감지된 agent 중 첫 번째(Codex)입니다.')
    expect(description()).not.toContain('Claude')
  })
  it('저장됐는데 미감지인 명시값은 pill 하나로 남고 「저장된 기본값이 감지되지 않음」, 활성이다', async () => {
    withDefault('claude')
    initial = N
    await render(createElement(AgentsSection))
    expect(pillIds()).toEqual(['auto', 'blank', 'codex', 'grok', 'claude'])
    const missing = host.querySelector<HTMLButtonElement>('[data-default-agent="claude"]')
    expect(missing?.getAttribute('aria-pressed')).toBe('true')
    expect(missing?.textContent).toContain('저장된 기본값이 감지되지 않음')
    expect(host.querySelectorAll('[data-default-agent-missing]')).toHaveLength(1)
  })
  it('Ⓩ = 「감지된 agents가 없습니다」, pill 은 자동·빈 terminal, 자동 설명은 빈 terminal', async () => {
    initial = Z
    await render(createElement(AgentsSection))
    expect(pillIds()).toEqual(['auto', 'blank'])
    expect(host.querySelector('[data-agent-detect-empty]')?.textContent).toBe('감지된 agents가 없습니다')
    expect(description()).toContain('감지된 agent가 없어 자동은 빈 terminal을 엽니다.')
  })
  it('푸시가 오면 따라간다 — Ⓟ → Ⓩ → Ⓝ', async () => {
    await render(createElement(AgentsSection))
    push(Z)
    expect(pillIds()).toEqual(['auto', 'blank'])
    push(detected('claude', 'codex', 'grok'))
    expect(pillIds()).toEqual(['auto', 'blank', 'claude', 'codex', 'grok'])
    expect(description()).toContain('자동은 감지된 agent 중 첫 번째(Claude)입니다.')
  })
  it('「다시 감지」 = 새로고침 호출(K3ⓑ), 응답으로 화면이 바뀐다', async () => {
    initial = Z
    await render(createElement(AgentsSection))
    const button = host.querySelector<HTMLButtonElement>('[data-agent-detect-refresh]')
    expect(button?.textContent).toBe('다시 감지')
    await act(async () => button?.click())
    expect(refreshCalls).toBe(1)
    expect(pillIds()).toEqual(['auto', 'blank', 'codex', 'grok'])
  })
})

// ── `+` 메뉴 (K4ⓑ) ──

const menu = (): React.ReactElement =>
  createElement(TabCreateMenu, {
    groupId: 'g1',
    anchor: { left: 0, bottom: 0 },
    entries: [],
    newTerminalShortcut: '⌘T',
    newAgentShortcut: '⌘⌥T',
    onNewTerminal: () => {},
    onLaunchAgent: () => {},
    onOpenAgentSettings: () => {},
    onActivateTab: () => {},
    onDismiss: () => {},
  })
const quickLaunch = (): Array<string | undefined> =>
  [...host.querySelectorAll<HTMLElement>('[data-tab-create-item^="agent:"]')].map((item) => item.dataset.tabCreateItem)
const typeQuery = (value: string): void => {
  const input = host.querySelector<HTMLInputElement>('[data-tab-create-input]')
  if (input === null) throw new Error('입력창 없음')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const results = (): Array<string | undefined> => [...host.querySelectorAll<HTMLElement>('[data-tab-create-result]')].map((item) => item.dataset.tabCreateResult)

describe('+ 메뉴 (K4ⓑ)', () => {
  it('Ⓟ = Quick-launch 3종(base)', async () => {
    await render(menu())
    expect(quickLaunch()).toEqual(['agent:claude', 'agent:codex', 'agent:grok'])
    expect(host.querySelector('[data-tab-create-no-agents]')).toBeNull()
  })
  it('Ⓝ = 감지된 것만 · 명시 기본값(grok) 맨 앞 · 검색도 감지된 것만', async () => {
    withDefault('grok')
    initial = N
    await render(menu())
    expect(quickLaunch()).toEqual(['agent:grok', 'agent:codex'])
    typeQuery('claude')
    expect(results()).not.toContain('agent:claude')
    typeQuery('codex')
    expect(results()).toContain('agent:codex')
  })
  it('Ⓩ = 「감지된 agents가 없습니다」, 「Agent 설정…」 은 남는다', async () => {
    initial = Z
    await render(menu())
    expect(quickLaunch()).toEqual([])
    expect(host.querySelector('[data-tab-create-no-agents]')?.textContent).toBe('감지된 agents가 없습니다')
    expect(host.querySelector('[data-tab-create-item="agent-settings"]')).not.toBeNull()
    expect(host.querySelector('[data-tab-create-item="new-terminal"]')).not.toBeNull()
  })
})

// ── 작업 시작 모달 (K4ⓓ) ──

const modalModel = (agent: StartAgent): StartWorkModel => ({
  open: true,
  mode: 'first',
  proceed: true,
  setProceed: () => {},
  form: { repoRoot: '/r', name: 'LIFE-1-x', agent, model: '', effort: '', submit: false, moveStatus: false },
  update: () => {},
  prompt: null,
  statusTarget: null,
  nameProblem: null,
  canStart: false,
  running: false,
  result: null,
  move: { state: 'idle' },
  begin: () => {},
  start: async () => {},
  relaunch: async () => {},
  close: () => true,
})
const modal = (agent: StartAgent): React.ReactElement =>
  createElement(StartWorkModal, { model: modalModel(agent), itemKey: 'LIFE-1', itemTitle: 'x', repos: [], trees: [], onOpen: () => {} })
const agentOptions = (): Array<string | undefined> => [...host.querySelectorAll<HTMLElement>('[data-start-agent-option]')].map((item) => item.dataset.startAgentOption)

describe('작업 시작 모달 에이전트 칸 (K4ⓓ)', () => {
  it('Ⓟ = base 4칸(Claude·Codex·Grok·빈 터미널)', async () => {
    await render(modal('claude'))
    expect(agentOptions()).toEqual(['claude', 'codex', 'grok', 'shell'])
  })
  it('Ⓝ = 감지된 것 + 빈 터미널, 다른 칸(레포·이름·모델)은 그대로', async () => {
    initial = N
    await render(modal('codex'))
    expect(agentOptions()).toEqual(['codex', 'grok', 'shell'])
    expect(host.querySelector('[data-start-repo]')).not.toBeNull()
    expect(host.querySelector('[data-start-name]')).not.toBeNull()
    expect(host.querySelector('[data-start-model]')).not.toBeNull()
  })
  it('Ⓩ = 빈 터미널만', async () => {
    initial = Z
    await render(modal('shell'))
    expect(agentOptions()).toEqual(['shell'])
  })
})

// ── 저장값 무변경 (K4ⓔ) ──

describe('감지 결과로 defaultAgent 를 쓰지 않는다 (K4ⓔ)', () => {
  it('미감지 명시값 — 설정·메뉴를 렌더하고 감지가 바뀌어도 setSettings 0회', async () => {
    withDefault('claude')
    initial = N
    await render(createElement('div', null, createElement(AgentsSection), menu()))
    push(Z)
    push(detected('grok'))
    await act(async () => host.querySelector<HTMLButtonElement>('[data-agent-detect-refresh]')?.click())
    await act(async () => host.querySelector<HTMLButtonElement>('[data-tab-create-item^="agent:"]')?.click())
    expect(writes).toEqual([])
    expect(stored.defaultAgent).toBe('claude')
  })
})
