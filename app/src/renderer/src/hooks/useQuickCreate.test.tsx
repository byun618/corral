// @vitest-environment happy-dom
// LIFE-604 R1-F·R1-M — 초안 수명을 훅에서 직접 본다. 연결이 **해제**되면 그 연결의 초안이 맵에서 빠지고(다시 붙인 연결은 새 id 라
// 화면으로는 「복원 없음」 이 늘 참이다 — 판별력이 없다), 토큰 교체(세대만 오름)로는 빠지지 않는다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkCapabilities, WorkConnectionSummary, WorkCreateMeta, WorkItem, WorkKind, WorkRequest, WorkResponse, WorkSettingsState } from '../../../shared/work.js'
import type { SpaceData } from '../tasks-model.js'
import type { CreateSettled } from './useTasksPage.js'
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

const sentCreates: WorkCall[] = []
/** 가짜 페이지의 만들기 결과 — 기본 `stale`. 시험이 바꾼다(R5-B 인라인 거절). */
let createResult: CreateSettled = { kind: 'stale' }
function page(settings: WorkSettingsState | null, data: SpaceData[] = []): QuickCreatePage {
  return {
    settings,
    groups: [],
    load: { spaceId: null, phase: 'ready', data, error: null, loadingMore: false },
    createBusy: new Set(),
    createItem: async ({ call }) => { sentCreates.push(call); return createResult },
    reload: async () => [],
  }
}

let model: QuickCreateModel | null = null
function Probe({ settings, connectionId, data = [] }: { settings: WorkSettingsState | null; connectionId: string; data?: SpaceData[] }): null {
  model = useQuickCreate({ page: page(settings, data), space: { kind: 'space', connectionId, spaceKey: 'CORE' }, writeBlockOf: () => null, onCreated: () => {}, openItem: () => {}, notifyFailure: () => {} })
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

describe('제출 직전 부모 검사 (R2-F)', () => {
  const epic: WorkKind = { key: 'epic', label: 'Epic', childKinds: ['story'] }
  const story: WorkKind = { key: 'story', label: 'Story', childKinds: [] }
  const item = (id: string, kind: WorkKind): WorkItem => ({
    id, key: id.toUpperCase(), spaceKey: 'CORE', title: id, body: null, kind, statusKey: 'todo', category: 'todo', resolution: null, priority: null, dueAt: null, parentId: null,
    placement: 'board', rank: null, openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [],
  })
  const space = (items: WorkItem[]): SpaceData => ({
    connectionId: 'c1', spaceKey: 'CORE', spaceName: 'Core', colorIndex: 0, color: null, statuses: [{ key: 'todo', label: 'todo', category: 'todo', order: 0, color: null }],
    kinds: [epic, story], items, nextCursor: null, truncated: false,
  })

  it('모달이 열린 동안 부모가 목록에서 사라지면 보내지 않고 비운다 — 칩과 요청이 어긋나지 않게', async () => {
    Reflect.set(window, 'corral', {
      workRequest: async (request: WorkRequest): Promise<WorkResponse> => ({
        requestId: request.requestId, connectionId: request.connectionId, ok: true,
        result: { op: 'getCreateMeta', meta: { spaceKey: 'CORE', kindKey: 'story', statusKeys: ['todo'], defaultStatusKey: 'todo', placement: 'applies', fields: [] } },
      }),
    })
    sentCreates.length = 0
    const settings = settingsOf([connection({ id: 'c1', generation: 1 })])
    act(() => root.render(createElement(Probe, { settings, connectionId: 'c1', data: [space([item('e1', epic)])] })))
    act(() => { current().openModal() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    act(() => { current().update({ title: '부모 있음', parentId: 'e1' }) })
    // 재조회로 부모가 빠졌다.
    act(() => root.render(createElement(Probe, { settings, connectionId: 'c1', data: [space([])] })))
    await act(async () => { await current().submit() })
    expect(sentCreates).toHaveLength(0)
    expect(current().modal?.form.parentId).toBeNull()
    expect(current().modal?.notice).toContain('부모가 지금 목록에 없어')
    // 비운 뒤에는 부모 없이 보낸다(양성 쪽 — 보낼 수 있는 상태였다).
    await act(async () => { await current().submit() })
    expect(sentCreates).toHaveLength(1)
    expect(sentCreates[0]).toMatchObject({ op: 'createItem', parentId: null })
  })
})

describe('배치가 적용되지 않는 종류 (R2-H)', () => {
  const on: WorkCapabilities = {
    transition: { mode: 'any' }, placement: { state: 'on' }, relations: { state: 'on' }, parentChange: { state: 'on' }, order: { state: 'on' }, cursorPaging: { state: 'on' },
    conflictCheck: { state: 'on' }, comments: { state: 'on' }, history: { state: 'on' }, workLinkStore: { state: 'on' },
  }
  const bug: WorkKind = { key: 'bug', label: 'Bug', childKinds: [] }
  const space: SpaceData = {
    connectionId: 'c1', spaceKey: 'CORE', spaceName: 'Core', colorIndex: 0, color: null, statuses: [{ key: 'todo', label: 'todo', category: 'todo', order: 0, color: null }],
    kinds: [bug], items: [], nextCursor: null, truncated: false,
  }
  const run = async (placement: 'applies' | 'ignored'): Promise<{ chip: unknown; sent: WorkCall | undefined }> => {
    Reflect.set(window, 'corral', {
      workRequest: async (request: WorkRequest): Promise<WorkResponse> => ({
        requestId: request.requestId, connectionId: request.connectionId, ok: true,
        result: { op: 'getCreateMeta', meta: { spaceKey: 'CORE', kindKey: 'bug', statusKeys: ['todo'], defaultStatusKey: 'todo', placement, fields: [] } },
      }),
    })
    sentCreates.length = 0
    const settings = settingsOf([{ ...connection({ id: 'c1', generation: 1 }), capabilities: on }])
    act(() => root.render(createElement(Probe, { settings, connectionId: 'c1', data: [space] })))
    act(() => { current().openModal() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    act(() => { current().update({ title: '버그', placement: 'backlog' }) })
    const chip = current().modalView?.placement
    await act(async () => { await current().submit() })
    act(() => { current().close() })
    return { chip, sent: sentCreates[0] }
  }

  it('메타가 ignored 면 배치 칩 흐림 + 이유, 요청에 placement 를 싣지 않는다 · applies 면 그대로(대조)', async () => {
    const ignored = await run('ignored')
    expect(ignored.chip).toMatchObject({ state: 'disabled', reason: expect.stringContaining('배치') })
    expect(ignored.sent).toBeDefined()
    expect(ignored.sent).not.toHaveProperty('placement')
    act(() => root.unmount())
    root = createRoot(host)
    const applies = await run('applies')
    expect(applies.chip).toEqual({ state: 'on' })
    expect(applies.sent).toMatchObject({ placement: 'backlog' })
  })
})

describe('인라인 갈래 (R5-B — 수정 4 R4-C·R4-F 의 인라인 쪽)', () => {
  const story: WorkKind = { key: 'story', label: 'Story', childKinds: [] }
  const space: SpaceData = {
    connectionId: 'c1', spaceKey: 'CORE', spaceName: 'Core', colorIndex: 0, color: null, statuses: [{ key: 'todo', label: 'todo', category: 'todo', order: 0, color: null }],
    kinds: [story], items: [], nextCursor: null, truncated: false,
  }
  const metaRequests: WorkRequest[] = []
  const serveMeta = (unavailable: string | null): void => {
    metaRequests.length = 0
    Reflect.set(window, 'corral', {
      workRequest: async (request: WorkRequest): Promise<WorkResponse> => {
        metaRequests.push(request)
        const meta: WorkCreateMeta = { spaceKey: 'CORE', kindKey: 'story', statusKeys: ['todo'], defaultStatusKey: 'todo', placement: 'applies', fields: [] }
        return { requestId: request.requestId, connectionId: request.connectionId, ok: true, result: { op: 'getCreateMeta', meta: unavailable === null ? meta : { ...meta, unavailable } } }
      },
    })
  }
  const tick = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
  const openWithText = async (text: string): Promise<void> => {
    act(() => root.render(createElement(Probe, { settings: settingsOf([connection({ id: 'c1', generation: 1 })]), connectionId: 'c1', data: [space] })))
    act(() => { current().openInline({ statusKey: 'todo', columnId: 'st:todo' }) })
    await tick()
    act(() => { current().setInlineText(text) })
  }

  it('R4-F 인라인 — 기본 종류 메타가 unavailable 이면 Enter 는 보내지 않고 그 이유를 보인다(출처 거절에 기대지 않음)', async () => {
    serveMeta('여기서는 Story 를 만들 수 없습니다')
    sentCreates.length = 0
    await openWithText('못 만드는 인라인')
    await act(async () => { await current().submitInline() })
    expect(sentCreates).toHaveLength(0)
    expect(current().inline?.error).toBe('여기서는 Story 를 만들 수 없습니다')
    expect(current().inline?.text).toBe('못 만드는 인라인')
  })

  it('R4-C 인라인 — 출처가 만들기를 거절하면 그 종류 메타를 다시 받는다 · 「모름」(maybeApplied)이면 다시 받지 않는다(대조)', async () => {
    serveMeta(null)
    sentCreates.length = 0
    try {
      createResult = { kind: 'failed', error: { kind: 'rejected', message: '없는 상태입니다', status: null } }
      await openWithText('거절될 인라인')
      const before = metaRequests.length
      await act(async () => { await current().submitInline() })
      await tick()
      expect(sentCreates).toHaveLength(1)
      expect(metaRequests.length).toBe(before + 1)
      act(() => root.unmount())
      root = createRoot(host)
      serveMeta(null)
      createResult = { kind: 'failed', error: { kind: 'network', message: '끊김', status: null, maybeApplied: true } }
      await openWithText('모르는 인라인')
      const unknownBefore = metaRequests.length
      await act(async () => { await current().submitInline() })
      await tick()
      expect(metaRequests.length).toBe(unknownBefore)
    } finally {
      createResult = { kind: 'stale' }
    }
  })
})
