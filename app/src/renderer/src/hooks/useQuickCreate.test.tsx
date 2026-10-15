// @vitest-environment happy-dom
// LIFE-604 R1-F·R1-M — 초안 수명을 훅에서 직접 본다. 연결이 **해제**되면 그 연결의 초안이 맵에서 빠지고(다시 붙인 연결은 새 id 라
// 화면으로는 「복원 없음」 이 늘 참이다 — 판별력이 없다), 토큰 교체(세대만 오름)로는 빠지지 않는다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkConnectionSummary, WorkSettingsState } from '../../../shared/work.js'
import { useQuickCreate, type QuickCreateModel, type QuickCreatePage } from './useQuickCreate.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const connection = ({ id, generation }: { id: string; generation: number }): WorkConnectionSummary => ({
  id, sourceId: 'mock-jira', name: 'Mock', mono: 'M', tokenTail: '0000', addedAt: 0, generation, status: 'ok', pending: null, error: null, checkedAt: null,
  spaces: null, hiddenSpaceKeys: [], capabilities: null,
})
const settingsOf = (connections: WorkConnectionSummary[]): WorkSettingsState => ({ sources: [], connections, repoDefaults: [] })

function page(settings: WorkSettingsState | null): QuickCreatePage {
  return {
    settings,
    groups: [],
    load: { spaceId: null, phase: 'ready', data: [], error: null, loadingMore: false },
    createBusy: new Set(),
    createItem: async () => ({ kind: 'stale' }),
    reload: async () => {},
  }
}

let model: QuickCreateModel | null = null
function Probe({ settings, connectionId }: { settings: WorkSettingsState | null; connectionId: string }): null {
  model = useQuickCreate({ page: page(settings), space: { kind: 'space', connectionId, spaceKey: 'CORE' }, writeBlockOf: () => null, onCreated: () => {}, openItem: () => {}, notifyFailure: () => {} })
  return null
}
const current = (): QuickCreateModel => {
  if (model === null) throw new Error('훅 없음')
  return model
}

function leaveDraft(settings: WorkSettingsState): void {
  act(() => root.render(createElement(Probe, { settings, connectionId: 'c1' })))
  act(() => { current().openModal() })
  act(() => { current().update({ title: '남길 초안' }) })
  act(() => { current().close() })
}

describe('초안 수명 (R1-F·R1-M)', () => {
  it('연결이 해제되면 그 연결 초안이 맵에서 빠진다', () => {
    const live = settingsOf([connection({ id: 'c1', generation: 1 })])
    leaveDraft(live)
    expect(current().draftKeys()).toEqual(['c1::CORE'])
    act(() => root.render(createElement(Probe, { settings: settingsOf([]), connectionId: 'c1' })))
    expect(current().draftKeys()).toEqual([])
  })

  it('토큰 교체(세대만 오름)로는 초안을 버리지 않는다 — 다시 열면 그 글', () => {
    leaveDraft(settingsOf([connection({ id: 'c1', generation: 1 })]))
    act(() => root.render(createElement(Probe, { settings: settingsOf([connection({ id: 'c1', generation: 2 })]), connectionId: 'c1' })))
    expect(current().draftKeys()).toEqual(['c1::CORE'])
    act(() => { current().openModal() })
    expect(current().modal?.form.title).toBe('남길 초안')
  })

  it('연결 목록을 아직 못 받았으면(null) 버리지 않는다', () => {
    leaveDraft(settingsOf([connection({ id: 'c1', generation: 1 })]))
    act(() => root.render(createElement(Probe, { settings: null, connectionId: 'c1' })))
    expect(current().draftKeys()).toEqual(['c1::CORE'])
  })
})
