// LIFE-565 C6ⓐ — corral 이 herdr 에 pane 을 만드는 4곳(tab.create ×2 · workspace.create ×2 · pane.split)의 요청 params 에
// `env.FORCE_HYPERLINK === '1'` 이 실리는지, 다른 env 키는 없는지 본다. herdr 요청은 가짜(`request` 모킹)로 받아 params 만 읽는다.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../../shared/json.js'

const sent = vi.hoisted(() => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  return { calls }
})

vi.mock('./request.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./request.js')>()
  return {
    ...actual,
    request: vi.fn(async (_socket: string, method: string, params: Record<string, unknown> = {}) => {
      sent.calls.push({ method, params })
      if (method === 'tab.create') return { id: 'x', result: { tab: { tab_id: 't1' }, root_pane: { pane_id: 'p1' } } }
      if (method === 'workspace.create') return { id: 'x', result: { workspace: { workspace_id: 'w1' } } }
      if (method === 'pane.split') return { id: 'x', result: { type: 'pane_info', pane: { pane_id: 'p2' } } }
      // TerminalBackend — corral.terminal 봉투. session.snapshot 은 이미 열린 /repo 하나와 새로 생긴 pane 을 보여 준다.
      const operation = isRecord(params['operation']) ? params['operation'] : null
      if (operation === null) return { id: 'x', result: { guard_version: 1, epoch: 'e' } }
      sent.calls.push({ method: String(operation['method']), params: isRecord(operation['params']) ? operation['params'] : {} })
      if (operation['method'] === 'session.snapshot') {
        const pane = (id: string, workspace: string, cwd: string) => ({ pane_id: id, tab_id: 't', workspace_id: workspace, terminal_id: 'term', corral_pty_generation: '1', cwd })
        // 새 workspace 의 pane 은 workspace.create 뒤에만 보인다 — 처음부터 보이면 「이미 열린 경로」로 읽혀 tab.create 를 탄다.
        const createdWorkspace = sent.calls.some((call) => call.method === 'workspace.create')
        const panes = [pane('p-old', 'w-old', '/repo'), pane('p1', 'w-old', '/repo'), ...(createdWorkspace ? [pane('p-new', 'w1', '/fresh')] : [])]
        return { id: 'x', result: { snapshot: { workspaces: [], tabs: [], panes } } }
      }
      return { id: 'x', result: { root_pane: { pane_id: 'p1' }, workspace: { workspace_id: 'w1' } } }
    }),
  }
})

const { createRow, openWorkspace } = await import('./lifecycle.js')
const { splitPane } = await import('./panes.js')
const { TerminalBackend } = await import('./terminal-backend.js')

const ctx = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 5000 })
const paramsOf = (method: string) => sent.calls.filter((call) => call.method === method).map((call) => call.params)

beforeEach(() => {
  sent.calls.length = 0
})

describe('C6ⓐ — 새 pane 요청에 FORCE_HYPERLINK=1 (다른 env 키 없음)', () => {
  it('lifecycle createRow → tab.create', async () => {
    await createRow('/sock', { workspaceId: 'w', kind: 'shell' })
    expect(paramsOf('tab.create').map((p) => p['env'])).toEqual([{ FORCE_HYPERLINK: '1' }])
  })

  it('lifecycle openWorkspace → workspace.create', async () => {
    await openWorkspace('/sock', '/repo')
    expect(paramsOf('workspace.create').map((p) => p['env'])).toEqual([{ FORCE_HYPERLINK: '1' }])
  })

  it('panes splitPane → pane.split', async () => {
    await splitPane({ socketPath: '/sock', paneId: 'p', direction: 'right' })
    expect(paramsOf('pane.split').map((p) => p['env'])).toEqual([{ FORCE_HYPERLINK: '1' }])
  })

  it('TerminalBackend.create — 이미 열린 경로면 tab.create', async () => {
    await new TerminalBackend('/sock').create('e', '/repo', 'title', ctx())
    expect(paramsOf('tab.create').map((p) => p['env'])).toEqual([{ FORCE_HYPERLINK: '1' }])
    expect(paramsOf('workspace.create')).toEqual([])
  })

  it('TerminalBackend.create — 처음 여는 경로면 workspace.create', async () => {
    await new TerminalBackend('/sock').create('e', '/fresh', undefined, ctx())
    expect(paramsOf('workspace.create').map((p) => p['env'])).toEqual([{ FORCE_HYPERLINK: '1' }])
    expect(paramsOf('tab.create')).toEqual([])
  })

  it('요청마다 새 객체 — 한 요청의 env 를 고쳐도 다음 요청에 번지지 않는다', async () => {
    await openWorkspace('/sock', '/a')
    const first = paramsOf('workspace.create')[0]?.['env']
    if (isRecord(first)) first['FORCE_HYPERLINK'] = 'mutated'
    await openWorkspace('/sock', '/b')
    expect(paramsOf('workspace.create')[1]?.['env']).toEqual({ FORCE_HYPERLINK: '1' })
  })
})
