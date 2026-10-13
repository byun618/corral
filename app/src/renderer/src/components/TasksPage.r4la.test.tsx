// @vitest-environment happy-dom
// LIFE-601 수정 r4 R4-A — 실제 LA adapter(`LaSource` + `McpHttpClient`)로 연산 하나가 RPC 여러 번이라 30초를 넘는 경우.
// 출발점: 리뷰어 프로브 `LA-TIME`(raw/review/codex-r4-raw/raw/new-probes.tsx). 네트워크는 쓰지 않는다 — 가짜 fetch 가 `LaMcpFixture` 의 도구 처리기를 부른다.
// RPC 하나는 11초(15초 한도 안), `setPlacement` = issue_update 뒤 issue_get 셋 → 44초에 성공. 렌더러와 main 을 함께 import 해 mixed 검사(tsconfig.mixed.json)에 둔다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkItem, WorkRequest, WorkResponse, WorkSettingsState } from '../../../shared/work.js'
import { LaSource } from '../../../main/work/la-source.js'
import { McpHttpClient } from '../../../main/work/mcp-http.js'
import { FIXTURE_IDS, LaMcpFixture } from '../../../main/work/la-mcp-fixture.js'
import { useTasksPage, type MoveNotice, type TasksPageModel } from '../hooks/useTasksPage.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let model: TasksPageModel
const notices: MoveNotice[] = []

function Probe(): null {
  model = useTasksPage({ open: true, repos: [], activeRepoRoot: null, notify: (notice) => notices.push(notice) })
  return null
}
const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const respond = (request: WorkRequest, result: Extract<WorkResponse, { ok: true }>['result']): WorkResponse => ({ requestId: request.requestId, connectionId: request.connectionId, ok: true, result })

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  notices.length = 0
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

it('LA-TIME 실제 adapter 연산이 44초(RPC 넷 × 11초)에 성공 → 30초엔 확인 지연 · 실패 토스트 없음 · 끝나면 화면 = 출처(backlog)', async () => {
  const fixture = new LaMcpFixture()
  let slow = false
  const fetchImpl = async (_url: unknown, options?: RequestInit): Promise<Response> => {
    const body: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } } = JSON.parse(String(options?.body))
    const tool = body.params?.name
    if (slow && tool !== undefined) await new Promise((resolve) => setTimeout(resolve, 11_000))
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const reply: { isError: boolean; text: string } | null = body.method === 'initialize' ? null : Reflect.get(fixture, 'tool').call(fixture, { tool, args: body.params?.arguments ?? {} })
    const result = reply === null ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: reply.text }], ...(reply.isError ? { isError: true } : {}) }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
  }
  const source = new LaSource(new McpHttpClient({ url: 'http://127.0.0.1:9/not-networked', token: 'fixture_synthetic', clientVersion: 'test', fetchImpl }))
  try {
    const got = await source.call({ op: 'getItem', itemId: FIXTURE_IDS.task601 })
    if (!got.ok || got.result.op !== 'getItem') throw new Error('fixture')
    const seed: WorkItem = got.result.item
    const placementOf = (): 'board' | 'backlog' => (fixture.issues.find((issue) => issue.id === seed.id)?.onBoard === true ? 'board' : 'backlog')
    const settings: WorkSettingsState = {
      sources: [{ id: 'la', name: 'LA', mono: 'LA', addLabel: '', formTitle: '', tokenLabel: '', tokenPrefix: null, keyPattern: null }],
      connections: [{
        id: 'c1', sourceId: 'la', name: 'LA', mono: 'LA', tokenTail: 'xxxx', addedAt: 0, generation: 1, status: 'ok', pending: null, error: null, checkedAt: 0,
        spaces: [{ key: seed.spaceKey, name: 'corral', color: null, openCount: 1, hidden: false }], hiddenSpaceKeys: [], capabilities: null,
      }],
      repoDefaults: [],
    }
    const statuses = fixture.statuses.map((status, index) => ({ key: status.id, label: status.label, category: status.categoryKey, order: index, color: null }))
    Reflect.set(window, 'corral', {
      getUiPrefs: async () => ({}),
      setUiPrefs: () => {},
      getWorkSettings: async () => settings,
      onWorkSettings: () => () => {},
      workRequest: async (request: WorkRequest): Promise<WorkResponse> => {
        const { call } = request
        switch (call.op) {
          case 'listStatuses': return respond(request, { op: 'listStatuses', statuses, kinds: [] })
          case 'listItems': return respond(request, { op: 'listItems', items: [{ ...seed, placement: placementOf() }], nextCursor: null, truncated: false })
          case 'setPlacement': return { ...(await source.call(call)), requestId: request.requestId, connectionId: request.connectionId }
          default: return { requestId: request.requestId, connectionId: request.connectionId, ok: false, error: { kind: 'rejected', message: call.op, status: null } }
        }
      },
    })
    act(() => root.render(createElement(Probe)))
    await settle()
    const row = model.rows.find((entry) => entry.item.id === seed.id)
    if (row === undefined) throw new Error('행 없음')
    expect(row.item.placement).toBe('board')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    slow = true
    act(() => { void model.move({ row, intent: { kind: 'placement', placement: 'backlog' } }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001) })
    expect(model.busy.size).toBe(0)
    expect(notices.map((notice) => notice.kind)).toEqual(['delayed'])
    expect(model.rows.find((entry) => entry.item.id === seed.id)?.item.placement).toBe('backlog')
    await act(async () => { await vi.advanceTimersByTimeAsync(14_500) })
    vi.useRealTimers()
    await settle()
    expect(placementOf()).toBe('backlog')
    expect(notices.some((notice) => notice.kind === 'failed')).toBe(false)
    expect(model.rows.find((entry) => entry.item.id === seed.id)?.item.placement).toBe('backlog')
  } finally {
    source.close()
  }
})
