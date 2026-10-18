// @vitest-environment happy-dom
// LIFE-635 C5 — 상세 「다른 곳의 링크」(읽기 전용): LA 가 가진 링크 중 이 Mac 의 로컬 worktree 로 합쳐지지 않는 것만 보인다.
// 실제 경로 React `TasksPage` → hook → `WorkService` → `LaSource` + `LaMcpFixture`(가짜 fetch · 가짜 토큰) — `TaskDetail.la-on.test.tsx` 와 같은 배선.
// 렌더러와 main 을 함께 import 하므로 mixed 검사에 둔다(tsconfig.mixed.json · tsconfig.web.json exclude).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RepoRow } from '../../../shared/types.js'
import type { WorkRequest, WorkSettingsState } from '../../../shared/work.js'
import { testRepo, testWorktree } from '../../../shared/test-rows.js'
import { FIXTURE_IDS, LaMcpFixture } from '../../../main/work/la-mcp-fixture.js'
import { laSourceEntry } from '../../../main/work/la-source.js'
import { FAKE_LA_TOKEN, FAKE_MACHINE, workHarness } from '../../../main/work/test-kit.js'
import { TasksPage } from './TasksPage.js'

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

const settle = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const WT = '/tmp/l635/repo/.claude/worktrees/LIFE-600-x'

/** 이 Mac 의 로컬 worktree(LIFE-600 에 명시 링크) — `local` false 면 레포 없음. */
function reposFor({ connectionId, local }: { connectionId: string; local: boolean }): RepoRow[] {
  if (!local) return []
  return [testRepo({ root: '/tmp/l635/repo', worktrees: [testWorktree({ path: WT, branch: 'refs/heads/LIFE-600-x', workLink: { mode: 'explicit', sourceId: 'la', connectionId, key: 'LIFE-600', itemId: FIXTURE_IDS.task600, connected: true } })] })]
}

/** fixture 에 링크 행을 직접(LA 검증을 지나지 않는 `javascript:` 꼴도 심을 수 있게). */
function plant(fixture: LaMcpFixture, row: { kind: 'worktree' | 'pull_request'; key: string; machine: string | null; extra?: Record<string, string | null> }): void {
  fixture.workLinks.push({
    id: `wl-${fixture.workLinks.length}`, issueId: FIXTURE_IDS.task600, kind: row.kind, key: row.key, extra: row.extra ?? (row.kind === 'worktree' ? { repoRoot: null } : { state: null }),
    machine: row.machine, repo: 'corral', createdAt: '2026-10-18T00:00:00.000Z',
  })
}

async function rig({ local, machineKnown = true, arrange }: { local: boolean; machineKnown?: boolean; arrange: (fixture: LaMcpFixture) => void }): Promise<void> {
  const fixture = new LaMcpFixture()
  arrange(fixture)
  const fetchImpl = async (_url: unknown, options?: RequestInit): Promise<Response> => {
    const body: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } } = JSON.parse(String(options?.body))
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const reply: { isError: boolean; text: string } | null = body.method === 'initialize' ? null : Reflect.get(fixture, 'tool').call(fixture, { tool: body.params?.name, args: body.params?.arguments ?? {} })
    const result = reply === null ? { protocolVersion: '2025-06-18' } : { content: [{ type: 'text', text: reply.text }], ...(reply.isError ? { isError: true } : {}) }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } })
  }
  const harness = workHarness({ entries: [laSourceEntry({ url: 'http://127.0.0.1:9/not-networked', clientVersion: 'test', fetchImpl })] })
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error('LA 모의 연결 실패')
  if (machineKnown) await harness.service.machine()
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => ({}), setUiPrefs: () => {}, getWorkSettings: async () => harness.service.settings(),
    onWorkSettings: (_next: (value: WorkSettingsState) => void) => () => {},
    workRequest: (request: WorkRequest) => harness.service.request(request),
    workActivity: async (query: unknown) => harness.service.activity(query),
  })
  const repos = reposFor({ connectionId: added.connection.id, local })
  act(() => root.render(createElement(TasksPage, { open: true, repos, activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} })))
  await settle(30)
  const card = document.querySelector('[data-tasks-board] [data-issue-card="LIFE-600"]')
  if (!(card instanceof HTMLElement)) throw new Error('카드 없음')
  act(() => { card.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await settle(30)
  if (document.querySelector('[data-issue-detail="LIFE-600"]') === null) throw new Error('상세 없음')
}

const remoteRows = (): { kind: string | null; value: string; machine: string; href: string | null }[] =>
  [...document.querySelectorAll('[data-issue-remote-links] [data-remote-link]')].map((row) => ({
    kind: row.getAttribute('data-remote-link'),
    value: row.querySelector('.issue-remote-value')?.textContent ?? '',
    machine: row.querySelector('[data-remote-machine]')?.textContent ?? '',
    href: row.querySelector('a[data-remote-href]')?.getAttribute('href') ?? null,
  }))
const localTrees = (): number => document.querySelectorAll('[data-issue-work] [data-work-tree]').length

describe('LIFE-635 C5 상세 — 다른 곳의 링크(읽기 전용)', () => {
  it('로컬만 — LA 의 같은 링크(같은 경로 · 이 Mac)는 로컬 칩 쪽 하나로, 원격 목록 없음', async () => {
    await rig({ local: true, arrange: (fixture) => plant(fixture, { kind: 'worktree', key: WT, machine: FAKE_MACHINE }) })
    expect(localTrees()).toBe(1)
    expect(document.querySelector('[data-issue-remote-links]')).toBeNull()
  })

  it('원격만 — 로컬 worktree 없이 LA 링크(다른 Mac)가 종류 · 값 · machine · 만든 시각으로 보인다 · 편집·떼기 없음', async () => {
    await rig({ local: false, arrange: (fixture) => plant(fixture, { kind: 'worktree', key: '/Users/other/wt', machine: 'mac-studio' }) })
    expect(localTrees()).toBe(0)
    expect(remoteRows()).toEqual([{ kind: 'worktree', value: '/Users/other/wt', machine: 'mac-studio', href: null }])
    expect(document.querySelector('[data-issue-remote-links] [data-remote-at]')?.textContent).toBeTruthy()
    expect(document.querySelectorAll('[data-issue-remote-links] button')).toHaveLength(0)
  })

  it('둘 다 같은 링크 + 다른 링크 — 같은 링크는 한 번만(로컬), 다른 것만 원격', async () => {
    await rig({ local: true, arrange: (fixture) => {
      plant(fixture, { kind: 'worktree', key: WT, machine: FAKE_MACHINE })
      plant(fixture, { kind: 'pull_request', key: 'https://github.com/o/r/pull/7', machine: null, extra: { state: 'open' } })
    } })
    expect(localTrees()).toBe(1)
    expect(remoteRows()).toEqual([{ kind: 'PR', value: 'https://github.com/o/r/pull/7', machine: '기기 모름', href: 'https://github.com/o/r/pull/7' }])
  })

  it('다른 machine 의 같은 경로 — 로컬과 합치지 않고 원격에 보인다', async () => {
    await rig({ local: true, arrange: (fixture) => plant(fixture, { kind: 'worktree', key: WT, machine: 'other-mac' }) })
    expect(localTrees()).toBe(1)
    expect(remoteRows()).toEqual([{ kind: 'worktree', value: WT, machine: 'other-mac', href: null }])
  })

  it('`javascript:` PR url — 링크가 아니라 글자로만 · 양성 대조: https 는 링크', async () => {
    await rig({ local: false, arrange: (fixture) => {
      plant(fixture, { kind: 'pull_request', key: 'javascript:alert(1)', machine: null })
      plant(fixture, { kind: 'pull_request', key: 'https://github.com/o/r/pull/8', machine: null })
    } })
    expect(remoteRows().map((row) => [row.value, row.href])).toEqual([['javascript:alert(1)', null], ['https://github.com/o/r/pull/8', 'https://github.com/o/r/pull/8']])
    expect(document.querySelectorAll('[data-issue-remote-links] a')).toHaveLength(1)
  })

  it('이 Mac 이름을 아직 모르면 원격 목록을 그리지 않는다(내 링크를 남의 것으로 보이지 않게) · 양성 대조: 알면 보인다', async () => {
    await rig({ local: true, machineKnown: false, arrange: (fixture) => plant(fixture, { kind: 'worktree', key: WT, machine: FAKE_MACHINE }) })
    expect(document.querySelector('[data-issue-remote-links]')).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await rig({ local: false, machineKnown: false, arrange: (fixture) => plant(fixture, { kind: 'worktree', key: '/Users/other/wt', machine: 'mac-studio' }) })
    expect(document.querySelector('[data-issue-remote-links]')).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await rig({ local: false, arrange: (fixture) => plant(fixture, { kind: 'worktree', key: '/Users/other/wt', machine: 'mac-studio' }) })
    expect(remoteRows()).toHaveLength(1)
  })
})
