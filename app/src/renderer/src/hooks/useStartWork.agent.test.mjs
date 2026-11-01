// @vitest-environment happy-dom
/* global window, document */
// LIFE-520 fix1 K4ⓓ (리뷰 R1-03·R1-08) — 훅 `useStartWork` + `StartWorkModal` 을 실제로 마운트해 초기 에이전트 배선을 본다.
//   · `begin` 이 연 순간부터 선택이 자동 규칙이다 — 렌더마다 `form.agent` 를 기록해 「한 번이라도 미감지 claude 로 열렸나」 를 본다
//     (보정 effect 가 뒤따라 고쳐도, begin 배선을 base 의 'claude' 로 되돌린 변이는 첫 렌더에서 드러난다).
//   · 열린 뒤 감지가 바뀌어 선택이 선택지 밖이면 자동 규칙으로 보정한다(R1-08).
// TaskDetailModel 은 큰 타입이라 이 파일은 .mjs 로 둔다(App.default-agent.test.mjs 와 같은 걸음).
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UNKNOWN_AGENT_DETECTION } from '../../../shared/agent-detection.js'
import { resetAgentDetectionStoreForTest } from '../agent-detection-store.js'
import { StartWorkModal } from '../components/StartWorkModal.js'
import { useStartWork } from './useStartWork.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const detected = (...agents) => ({ kind: 'detected', agents: agents.map((agent) => ({ agent, path: `/x/${agent}`, source: 'login-shell' })), shell: { ok: true }, at: 1 })

const item = { id: 'i1', key: 'LIFE-1', title: 'agent detect', body: '', openBlockers: [], spaceKey: 'S', category: 'todo' }
const detail = {
  uid: 'u1', item, target: { connectionId: 'c1' }, parents: [], caps: null, transitions: null, statuses: [], blocked: null, connection: null,
  loadTransitions: async () => {},
}

let host
let root
let seen
let model
let pushes
let initial
let statusView

function Probe() {
  model = useStartWork({ detail, repos: [], repoDefaults: [], activeRepoRoot: null, sourceName: 'LA', notifyFailure: () => {} })
  if (model.form !== null) seen.push(model.form.agent)
  return createElement(StartWorkModal, { model, itemKey: item.key, itemTitle: item.title, repos: [], trees: [], onOpen: () => {} })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  seen = []
  pushes = []
  initial = UNKNOWN_AGENT_DETECTION
  statusView = null
  Reflect.set(window, 'corral', {
    startWorkStatus: async () => statusView,
    getAgentDetection: async () => initial,
    onAgentDetection: (listener) => { pushes.push(listener); return () => {} },
  })
  resetAgentDetectionStoreForTest()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'corral')
  resetAgentDetectionStoreForTest()
})

const mount = async () => {
  await act(async () => root.render(createElement(Probe)))
}
const open = async () => {
  await act(async () => model.begin('first'))
}
const checked = () => host.querySelector('[data-start-agent-option][aria-checked="true"]')?.getAttribute('data-start-agent-option') ?? null
const choices = () => [...host.querySelectorAll('[data-start-agent-option]')].map((node) => node.getAttribute('data-start-agent-option'))

describe('작업 시작 모달 초기 선택 — 훅·모달 마운트 (K4ⓓ, R1-03)', () => {
  it('Ⓩ — 열자마자 빈 터미널, claude 로 열린 렌더가 한 번도 없다', async () => {
    initial = detected()
    await mount()
    await open()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen).not.toContain('claude')
    expect(model.form.agent).toBe('shell')
    expect(choices()).toEqual(['shell'])
    expect(checked()).toBe('shell')
  })
  it('Ⓝ(claude 미감지) — 자동 규칙(codex), claude 로 열린 렌더가 없다', async () => {
    initial = detected('codex', 'grok')
    await mount()
    await open()
    expect(seen).not.toContain('claude')
    expect(model.form.agent).toBe('codex')
    expect(checked()).toBe('codex')
  })
  it('Ⓝ(claude 감지) — base 와 같은 claude', async () => {
    initial = detected('claude', 'grok')
    await mount()
    await open()
    expect([...new Set(seen)]).toEqual(['claude'])
  })
  it('Ⓟ — base(claude, 4칸)', async () => {
    await mount()
    await open()
    expect([...new Set(seen)]).toEqual(['claude'])
    expect(choices()).toEqual(['claude', 'codex', 'grok', 'shell'])
  })
})

describe('열린 뒤 감지가 바뀌면 선택 보정 (K4ⓓ, R1-08)', () => {
  it('Ⓟ 에서 claude 로 연 뒤 감지가 claude 를 빼면 자동 규칙(codex)으로 — 숨은 선택이 남지 않는다', async () => {
    await mount()
    await open()
    expect(model.form.agent).toBe('claude')
    act(() => { for (const push of pushes) push(detected('codex', 'grok')) })
    expect(model.form.agent).toBe('codex')
    expect(checked()).toBe('codex')
  })
  it('Ⓩ 로 바뀌면 빈 터미널 · 선택이 선택지 안이면 그대로', async () => {
    await mount()
    await open()
    await act(async () => model.update({ agent: 'grok' }))
    act(() => { for (const push of pushes) push(detected('grok')) })
    expect(model.form.agent).toBe('grok')
    act(() => { for (const push of pushes) push(detected()) })
    expect(model.form.agent).toBe('shell')
  })
})

describe('끝난 실패 시도를 복원하면 보정하지 않는다 (K4ⓓ, fix2 R2-06)', () => {
  it('복원한 시도의 에이전트(claude)가 지금 미감지여도 그대로 — 「다시 띄우기」 가 그 에이전트로 간다', async () => {
    const stage = (status) => ({ status, code: null, message: null })
    statusView = {
      attemptId: 'a1', repoRoot: '/r', name: 'LIFE-1-x', agent: 'claude', model: '', effort: '', submit: false,
      result: { attemptId: 'a1', joined: false, done: true, stages: { worktree: stage('completed'), agent: stage('failed'), prompt: stage('skipped') }, worktreePath: '/r/wt', linkSaved: true, sourceLink: null, refused: null },
    }
    initial = detected('codex', 'grok')
    await mount()
    await open()
    expect(model.result).not.toBeNull()
    expect(model.form.agent).toBe('claude')
    // 감지가 다시 바뀌어도(푸시) 복원한 결과 화면에서는 그대로다.
    act(() => { for (const push of pushes) push(detected('grok')) })
    expect(model.form.agent).toBe('claude')
  })
})
