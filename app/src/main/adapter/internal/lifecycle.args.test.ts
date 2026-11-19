// LIFE-808 R1-9 — GUI 행 생성 `createRow` 가 `args`(세션 재개 `--resume <id>`)를 herdr `agent.start` 에 그대로 싣는다. 없으면 칸도 없다.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: { method: string; params: Record<string, unknown> }[] = []
vi.mock('./request.js', () => ({
  request: async (_socket: string, method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    if (method === 'tab.create') return { result: { root_pane: { pane_id: 'w1:p7' }, tab: { tab_id: 't7' } } }
    return { result: { agent: {} } }
  },
}))
vi.mock('./pane-env.js', () => ({ paneEnv: () => ({}) }))

const { createRow } = await import('./lifecycle.js')

beforeEach(() => {
  calls.length = 0
})

describe('createRow args → agent.start', () => {
  it('args 를 주면 agent.start params.args 로 실린다 · tab.create 에는 cwd', async () => {
    const outcome = await createRow('/sock', { workspaceId: 'w1', kind: 'claude', cwd: '/w/repo', args: ['--resume', '11111111-1111-4111-8111-111111111111'] })
    expect(outcome).toMatchObject({ ok: true, paneId: 'w1:p7', tabId: 't7' })
    expect(calls.map((call) => call.method)).toEqual(['tab.create', 'agent.start'])
    expect(calls[0]?.params).toMatchObject({ workspace_id: 'w1', cwd: '/w/repo' })
    expect(calls[1]?.params).toEqual({ name: 'corral-w1-p7', kind: 'claude', pane_id: 'w1:p7', args: ['--resume', '11111111-1111-4111-8111-111111111111'] })
  })
  it('args 가 없으면 agent.start 에 args 칸이 없다(기존 GUI 기동 그대로)', async () => {
    await createRow('/sock', { workspaceId: 'w1', kind: 'codex' })
    expect(calls[1]?.params).toEqual({ name: 'corral-w1-p7', kind: 'codex', pane_id: 'w1:p7' })
  })
})
