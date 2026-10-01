// 사이드바 목록 논리 단위 시험 (LIFE-470 K3·K4·K5·K6·K7·K8 · U1·U2·U3). 메뉴 조작·화면은 격리·네이티브 실행이 본다.

import { describe, expect, it } from 'vitest'
import { emptyAgentState } from '../../shared/agent-state.js'
import { DEFAULT_SIDEBAR_VIEW, readSidebarView, type SidebarView } from '../../shared/sidebar-view.js'
import { EMPTY_SESSION_DIGEST, type AgentStatus, type PaneRow, type RepoRow, type WorktreeRow } from '../../shared/types.js'
import { applyAllMove, applyWorktreeMove, EMPTY_MANUAL_ORDER, forgetRepo, materializeLayout, orderAll, reconcileManualOrder, type ManualOrder } from './manual-order.js'
import {
  activeFilterCount,
  AGENT_STATUS_STALE_AFTER_MS,
  applyShownLayout,
  buildSidebarSections,
  effectiveRepoFilter,
  filterBadgeLabel,
  isActivityDriven,
  layoutSignature,
  paneAttention,
  sectionLayout,
  settleDecision,
  visibleCardCount,
  worktreeAttention,
  worktreeRecentAt,
  type SidebarSection,
} from './sidebar-sections.js'

const NOW = 10_000_000
const GIT = { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }

function pane(input: { id: string; agent?: string | null; status?: AgentStatus; observedAt?: number; patch?: Partial<PaneRow> }): PaneRow {
  return {
    paneId: input.id,
    tabId: `t-${input.id}`,
    workspaceId: 'w',
    title: '',
    agent: input.agent === undefined ? 'claude' : input.agent,
    agentStatus: input.status ?? 'idle',
    agentState: { ...emptyAgentState(input.observedAt ?? 1000), observedVia: 'event' },
    cwd: null,
    focused: false,
    agentSession: null,
    digest: EMPTY_SESSION_DIGEST,
    ...input.patch,
  }
}

function wt(input: { path: string; branch: string | null; linked?: boolean; panes?: PaneRow[] }): WorktreeRow {
  const panes = input.panes ?? null
  return {
    path: input.path,
    branch: input.branch,
    isLinked: input.linked ?? true,
    openWorkspaceId: panes === null ? null : `w-${input.path}`,
    workspace:
      panes === null
        ? null
        : {
            workspaceId: `w-${input.path}`,
            label: '',
            number: 1,
            agentStatus: 'idle',
            focused: false,
            tabs: panes.map((row, index) => ({
              tabId: row.tabId,
              workspaceId: `w-${input.path}`,
              label: '',
              number: index + 1,
              order: index,
              agentStatus: row.agentStatus,
              focused: false,
              panes: [row],
              digest: EMPTY_SESSION_DIGEST,
            })),
          },
    gitStatus: { ...GIT, branch: input.branch },
  }
}

function repo(root: string, worktrees: WorktreeRow[], name?: string): RepoRow {
  return { root, name: name ?? root.split('/').pop() ?? root, error: null, worktrees }
}

const view = (patch: Partial<SidebarView> = {}): SidebarView => ({ ...DEFAULT_SIDEBAR_VIEW, ...patch })
const flat = (sections: readonly SidebarSection[]): string[] => sections.flatMap((section) => section.items.map((item) => item.worktree.path))
const headers = (sections: readonly SidebarSection[]): string[] => sections.map((section) => (section.kind === 'repo' ? section.repo.root : '*all'))

// 픽스처 — 레포 2개. /r/a 는 주 체크아웃(main) + 연결 3개(zeta·beta·detached), /r/b 는 주 + 1개.
function fixture(): RepoRow[] {
  return [
    repo('/r/a', [
      wt({ path: '/r/a', branch: 'main', linked: false }),
      wt({ path: '/r/a/z', branch: 'zeta' }),
      wt({ path: '/r/a/b', branch: 'beta' }),
      wt({ path: '/r/a/d', branch: '(detached)' }),
    ]),
    repo('/r/b', [wt({ path: '/r/b', branch: 'main', linked: false }), wt({ path: '/r/b/x', branch: 'xray' })]),
  ]
}

/** 469 사용자가 손으로 정한 순서 — 레포 b 먼저, a 안은 z → 주 → b → d. */
const MANUAL: ManualOrder = {
  repos: ['/r/b', '/r/a'],
  worktrees: { '/r/a': ['/r/a/z', '/r/a', '/r/a/b', '/r/a/d'], '/r/b': ['/r/b', '/r/b/x'] },
  all: [],
}

describe('K9ⓑ·K5ⓕ 기본값 = 이전 빌드 화면 그대로', () => {
  it('기본 옵션(Project·Manual·필터 없음)은 469 수동 순서를 그대로 그린다', () => {
    const sections = buildSidebarSections({ repos: fixture(), view: DEFAULT_SIDEBAR_VIEW, order: MANUAL, now: NOW })
    expect(DEFAULT_SIDEBAR_VIEW).toMatchObject({ groupBy: 'repo', sortBy: 'manual', projectOrderBy: 'manual' })
    expect(headers(sections)).toEqual(['/r/b', '/r/a'])
    expect(flat(sections)).toEqual(['/r/b', '/r/b/x', '/r/a/z', '/r/a', '/r/a/b', '/r/a/d'])
  })

  it('470 이전 prefs(칸 없음)를 읽으면 기본값이다 · 모르는 모드 문자열은 칸마다 기본값', () => {
    expect(readSidebarView({})).toEqual(DEFAULT_SIDEBAR_VIEW)
    expect(readSidebarView({ sidebarSortBy: 'activity', sidebarGroupBy: 'none', sidebarRepoFilter: 'x' })).toEqual({ ...DEFAULT_SIDEBAR_VIEW, groupBy: 'none' })
  })
})

describe('K5ⓐ Sort by 5모드 — 198 `smart-sort.ts:104-161` 대응', () => {
  it('name = 표시 이름(브랜치 풀네임) 사전순 — 주 체크아웃도 이름으로 섞인다', () => {
    const sections = buildSidebarSections({ repos: fixture(), view: view({ sortBy: 'name' }), order: MANUAL, now: NOW })
    // '(detached)' < 'beta' < 'main' < 'zeta' (localeCompare)
    expect(sections.map((section) => section.items.map((item) => item.worktree.path))).toEqual([
      ['/r/b', '/r/b/x'],
      ['/r/a/d', '/r/a/b', '/r/a', '/r/a/z'],
    ])
  })

  it('recent = Recent 시각 내림차순, 같으면 이름 — 닫힌 워크트리(시각 0)는 뒤', () => {
    const repos = [
      repo('/r/a', [
        wt({ path: '/r/a', branch: 'main', linked: false }),
        wt({ path: '/r/a/old', branch: 'old', panes: [pane({ id: 'o', observedAt: 2000 })] }),
        wt({ path: '/r/a/new', branch: 'new', panes: [pane({ id: 'n', observedAt: 5000 })] }),
        wt({ path: '/r/a/dig', branch: 'dig', panes: [pane({ id: 'g', observedAt: 1000, patch: { digest: { ...EMPTY_SESSION_DIGEST, lastActivityAt: 9000 } } })] }),
      ]),
    ]
    const sections = buildSidebarSections({ repos, view: view({ sortBy: 'recent' }), order: EMPTY_MANUAL_ORDER, now: NOW })
    expect(flat(sections)).toEqual(['/r/a/dig', '/r/a/new', '/r/a/old', '/r/a'])
  })

  it('repo = 레포 이름, 같으면 이름 (None 그룹에서 레포가 섞일 때 뜻이 있다)', () => {
    const repos = [repo('/r/z', [wt({ path: '/r/z', branch: 'main', linked: false })], 'zulu'), repo('/r/a', [wt({ path: '/r/a', branch: 'main', linked: false }), wt({ path: '/r/a/k', branch: 'kilo' })], 'alpha')]
    const sections = buildSidebarSections({ repos, view: view({ groupBy: 'none', sortBy: 'repo' }), order: EMPTY_MANUAL_ORDER, now: NOW })
    expect(flat(sections)).toEqual(['/r/a/k', '/r/a', '/r/z'])
  })

  it('manual = 수동 순서 그대로', () => {
    const sections = buildSidebarSections({ repos: fixture(), view: view({ sortBy: 'manual' }), order: MANUAL, now: NOW })
    expect(sections[1]?.items.map((item) => item.worktree.path)).toEqual(['/r/a/z', '/r/a', '/r/a/b', '/r/a/d'])
  })

  it('smart = attention 클래스 → 클래스 안 시각 내림차순 → Recent → 이름', () => {
    const repos = [
      repo('/r/a', [
        wt({ path: '/r/a', branch: 'main', linked: false }),
        wt({ path: '/r/a/work', branch: 'work', panes: [pane({ id: 'w', status: 'working', observedAt: 9000 })] }),
        wt({ path: '/r/a/ask', branch: 'ask', panes: [pane({ id: 'q', status: 'blocked', observedAt: 3000, patch: { agentState: { ...emptyAgentState(3000), blockedReason: 'question' } } })] }),
        wt({ path: '/r/a/done', branch: 'done', panes: [pane({ id: 'd', status: 'done', observedAt: NOW - 4000, patch: { agentState: { ...emptyAgentState(NOW - 4000), enteredDoneAt: NOW - 4000 } } })] }),
        wt({ path: '/r/a/unk', branch: 'unk', panes: [pane({ id: 'u', status: 'unknown', observedAt: 8000 })] }),
        wt({ path: '/r/a/idle', branch: 'idle', panes: [pane({ id: 'i', status: 'idle', observedAt: 9500 })] }),
      ]),
    ]
    const sections = buildSidebarSections({ repos, view: view({ sortBy: 'smart' }), order: EMPTY_MANUAL_ORDER, now: NOW })
    // 1 ask → 2 done → 3 work → 4 unk → 5 idle(Recent 9500) → 5 main(시각 0)
    expect(flat(sections)).toEqual(['/r/a/ask', '/r/a/done', '/r/a/work', '/r/a/unk', '/r/a/idle', '/r/a'])
  })
})

describe('K5ⓑ attention 5클래스 ← corral 점 대응표 (U2)', () => {
  const at = (patch: Partial<PaneRow>, status: AgentStatus, observedAt = 5000): ReturnType<typeof paneAttention> =>
    paneAttention({ pane: pane({ id: 'p', status, observedAt, patch }), now: NOW })

  it('waiting(질문)·blocked = 1, 시각 = 상태 진입', () => {
    expect(at({ agentState: { ...emptyAgentState(5000), blockedReason: 'permission' } }, 'blocked')).toEqual({ cls: 1, at: 5000 })
    expect(at({}, 'blocked')).toEqual({ cls: 1, at: 5000 })
  })

  it('done 은 30분 안이면 2(완료 시각), 지나면 5 · interrupted 는 5 · failed 는 2(218 쪽)', () => {
    const doneAt = NOW - 1000
    expect(at({ agentState: { ...emptyAgentState(doneAt), enteredDoneAt: doneAt } }, 'done', doneAt)).toEqual({ cls: 2, at: doneAt })
    const stale = NOW - AGENT_STATUS_STALE_AFTER_MS - 1
    expect(at({ agentState: { ...emptyAgentState(stale), enteredDoneAt: stale } }, 'done', stale)).toEqual({ cls: 5, at: 0 })
    expect(at({ digest: { ...EMPTY_SESSION_DIGEST, turnOutcome: { outcome: 'interrupted', reason: null }, turnOutcomeAt: NOW - 10 } }, 'done', NOW - 10)).toEqual({ cls: 5, at: 0 })
    expect(at({ digest: { ...EMPTY_SESSION_DIGEST, turnOutcome: { outcome: 'failed', error: null }, turnOutcomeAt: NOW - 10 } }, 'done', NOW - 10)).toEqual({ cls: 2, at: NOW - 10 })
  })

  it('working = 3, 시각 = 지난 done/blocked(없으면 working 시작) · unknown = 4 · idle = 5', () => {
    const history = [{ status: 'done' as const, observedAt: 4200, observedVia: 'event' as const }, { status: 'working' as const, observedAt: 4100, observedVia: 'event' as const }]
    expect(at({ agentState: { ...emptyAgentState(5000), history } }, 'working')).toEqual({ cls: 3, at: 4200 })
    expect(at({}, 'working')).toEqual({ cls: 3, at: 5000 })
    expect(at({}, 'unknown')).toEqual({ cls: 4, at: 5000 })
    expect(at({}, 'idle')).toEqual({ cls: 5, at: 0 })
  })

  it('워크트리 = 가장 낮은 클래스, 같으면 늦은 시각 · 셸 pane(agent null)은 세지 않는다', () => {
    const worktree = wt({
      path: '/w',
      branch: 'w',
      panes: [pane({ id: 's', agent: null, status: 'unknown', observedAt: 9999 }), pane({ id: 'a', status: 'working', observedAt: 100 }), pane({ id: 'b', status: 'working', observedAt: 300 })],
    })
    expect(worktreeAttention({ worktree, now: NOW })).toEqual({ cls: 3, at: 300 })
    // Recent 시각은 셸 pane 도 센다(터미널 활동).
    expect(worktreeRecentAt(worktree)).toBe(9999)
  })
})

describe('K4 Group by None/Project', () => {
  it('None = 단일 「전체」 구획, 레포 헤더 없음 — 수동 순서는 레포 순서 → 레포 안 순서', () => {
    const sections = buildSidebarSections({ repos: fixture(), view: view({ groupBy: 'none' }), order: MANUAL, now: NOW })
    expect(headers(sections)).toEqual(['*all'])
    expect(flat(sections)).toEqual(['/r/b', '/r/b/x', '/r/a/z', '/r/a', '/r/a/b', '/r/a/d'])
    expect(sections[0]?.items[0]?.repoName).toBe('b')
  })

  it('None 에서도 정렬 모드가 걸린다(레포가 섞인다)', () => {
    const sections = buildSidebarSections({ repos: fixture(), view: view({ groupBy: 'none', sortBy: 'name' }), order: MANUAL, now: NOW })
    // 'main' 동률(두 주 체크아웃)은 안정 정렬로 수동 순서(b → a)를 지킨다.
    expect(flat(sections)).toEqual(['/r/a/d', '/r/a/b', '/r/b', '/r/a', '/r/b/x', '/r/a/z'])
  })
})

describe('K6 Project order', () => {
  it('Manual = 469 manualRepoOrder, Recent = 레포 안 최댓값 시각 내림차순(활동 없는 레포는 뒤, 그 안은 수동 순서)', () => {
    const repos = [
      repo('/r/a', [wt({ path: '/r/a', branch: 'main', linked: false, panes: [pane({ id: 'a', observedAt: 7000 })] })]),
      repo('/r/b', [wt({ path: '/r/b', branch: 'main', linked: false })]),
      repo('/r/c', [wt({ path: '/r/c', branch: 'main', linked: false, panes: [pane({ id: 'c', observedAt: 9000 })] })]),
      repo('/r/d', [wt({ path: '/r/d', branch: 'main', linked: false })]),
    ]
    const order: ManualOrder = { repos: ['/r/d', '/r/b', '/r/a', '/r/c'], worktrees: {}, all: [] }
    expect(headers(buildSidebarSections({ repos, view: view(), order, now: NOW }))).toEqual(['/r/d', '/r/b', '/r/a', '/r/c'])
    expect(headers(buildSidebarSections({ repos, view: view({ projectOrderBy: 'recent' }), order, now: NOW }))).toEqual(['/r/c', '/r/a', '/r/d', '/r/b'])
  })
})

describe('K3 Show › Projects · K8 Filters · 배지', () => {
  it('선택 없음 = 전체, 고르면 그 레포만 · 제거된 레포 id 는 개수·필터에서 무시', () => {
    const repos = fixture()
    expect(headers(buildSidebarSections({ repos, view: view({ repoFilter: ['/r/a'] }), order: MANUAL, now: NOW }))).toEqual(['/r/a'])
    const stale = view({ repoFilter: ['/gone'] })
    expect(effectiveRepoFilter({ view: stale, repos })).toEqual([])
    expect(activeFilterCount({ view: stale, repos })).toBe(0)
    expect(headers(buildSidebarSections({ repos, view: stale, order: MANUAL, now: NOW }))).toEqual(['/r/b', '/r/a'])
    expect(activeFilterCount({ view: view({ repoFilter: ['/r/a', '/gone', '/r/b'] }), repos })).toBe(2)
  })

  it('Hide default branch = 주 체크아웃(브랜치 있음) 숨김 · Hide detached HEAD = 브랜치 없음 숨김 · 둘 다 배지에 1씩', () => {
    const repos = fixture()
    const hideMain = buildSidebarSections({ repos, view: view({ hideDefaultBranch: true }), order: MANUAL, now: NOW })
    expect(flat(hideMain)).toEqual(['/r/b/x', '/r/a/z', '/r/a/b', '/r/a/d'])
    const hideDetached = buildSidebarSections({ repos, view: view({ hideDetachedHead: true }), order: MANUAL, now: NOW })
    expect(flat(hideDetached)).toEqual(['/r/b', '/r/b/x', '/r/a/z', '/r/a', '/r/a/b'])
    expect(activeFilterCount({ view: view({ hideDefaultBranch: true, hideDetachedHead: true, repoFilter: ['/r/a'] }), repos })).toBe(3)
  })

  it('주 체크아웃이 detached 면 Hide default branch 가 아니라 Hide detached HEAD 가 숨긴다(198 `isDefaultBranchWorkspace`)', () => {
    for (const branch of ['(detached)', null]) {
      const repos = [repo('/r/a', [wt({ path: '/r/a', branch, linked: false }), wt({ path: '/r/a/k', branch: 'k' })])]
      expect(flat(buildSidebarSections({ repos, view: view({ hideDefaultBranch: true }), order: EMPTY_MANUAL_ORDER, now: NOW }))).toEqual(['/r/a', '/r/a/k'])
      expect(flat(buildSidebarSections({ repos, view: view({ hideDetachedHead: true }), order: EMPTY_MANUAL_ORDER, now: NOW }))).toEqual(['/r/a/k'])
    }
  })

  it('스위치 필터로 카드가 0 인 레포는 헤더째 빠지고, 다 비면 빈 상태 판정(보이는 카드 0)', () => {
    const repos = [repo('/r/a', [wt({ path: '/r/a', branch: 'main', linked: false })]), repo('/r/b', [wt({ path: '/r/b', branch: 'main', linked: false }), wt({ path: '/r/b/x', branch: 'x' })])]
    const sections = buildSidebarSections({ repos, view: view({ hideDefaultBranch: true }), order: EMPTY_MANUAL_ORDER, now: NOW })
    expect(headers(sections)).toEqual(['/r/b'])
    const empty = buildSidebarSections({ repos: [repos[0]!], view: view({ hideDefaultBranch: true }), order: EMPTY_MANUAL_ORDER, now: NOW })
    expect(visibleCardCount(empty)).toBe(0)
  })

  it('필터가 없으면 워크트리 0 인 레포(git 오류 등)도 헤더를 남긴다 — 지금 화면과 같다', () => {
    const repos = [{ ...repo('/r/err', []), error: 'git failed' }]
    expect(headers(buildSidebarSections({ repos, view: view(), order: EMPTY_MANUAL_ORDER, now: NOW }))).toEqual(['/r/err'])
  })

  it('K8ⓔ 레포 추가·제거가 필터 값을 바꾸지 않는다 — 필터는 레포 목록과 독립 칸이고 계산은 읽기만 한다(Orca #20394 교정)', () => {
    const filters = view({ hideDefaultBranch: true, repoFilter: ['/r/a'] })
    const before = JSON.stringify(filters)
    buildSidebarSections({ repos: fixture(), view: filters, order: MANUAL, now: NOW })
    buildSidebarSections({ repos: [...fixture(), repo('/r/new', [wt({ path: '/r/new', branch: 'main', linked: false })])], view: filters, order: MANUAL, now: NOW })
    buildSidebarSections({ repos: fixture().slice(1), view: filters, order: MANUAL, now: NOW })
    expect(JSON.stringify(filters)).toBe(before)
    // 고른 레포가 사라졌다 다시 오면 다시 걸린다(값을 지우지 않았으니).
    expect(headers(buildSidebarSections({ repos: fixture(), view: filters, order: MANUAL, now: NOW }))).toEqual(['/r/a'])
  })

  it('배지 9+ 상한', () => {
    expect(filterBadgeLabel(9)).toBe('9')
    expect(filterBadgeLabel(10)).toBe('9+')
  })
})

describe('K7 끌면 Manual · 수동 데이터 보존', () => {
  it('ⓐ 비-manual 화면 순서에서 끌어 놓으면 그 순서가 수동 데이터에 적혀 Manual 화면에 그대로 남는다', () => {
    const repos = fixture()
    const nameView = view({ sortBy: 'name' })
    const shown = buildSidebarSections({ repos, view: nameView, order: MANUAL, now: NOW })[1]!.items.map((item) => item.worktree.path)
    expect(shown).toEqual(['/r/a/d', '/r/a/b', '/r/a', '/r/a/z'])
    // zeta 를 맨 앞으로(slot 0)
    const next = applyWorktreeMove({ order: MANUAL, repoRoot: '/r/a', worktrees: repos[0]!.worktrees, visiblePaths: shown, path: '/r/a/z', slot: 0 })
    expect(next).not.toBeNull()
    const manual = buildSidebarSections({ repos, view: view({ sortBy: 'manual' }), order: next!, now: NOW })
    expect(manual[1]?.items.map((item) => item.worktree.path)).toEqual(['/r/a/z', '/r/a/d', '/r/a/b', '/r/a'])
  })

  it('ⓑ 제자리 드롭은 null — 호출부가 모드를 안 바꾼다', () => {
    expect(applyWorktreeMove({ order: MANUAL, repoRoot: '/r/a', worktrees: fixture()[0]!.worktrees, visiblePaths: ['/r/a/z', '/r/a'], path: '/r/a/z', slot: 0 })).toBeNull()
    expect(applyAllMove({ order: MANUAL, repos: fixture(), visiblePaths: ['/r/a/z', '/r/a'], path: '/r/a', slot: 2 })).toBeNull()
  })

  it('ⓒ 모드를 왕복해도 수동 데이터는 그대로 — 계산은 order 를 읽기만 한다', () => {
    const before = JSON.stringify(MANUAL)
    for (const sortBy of ['name', 'smart', 'recent', 'repo', 'manual'] as const)
      for (const groupBy of ['none', 'repo'] as const) buildSidebarSections({ repos: fixture(), view: view({ sortBy, groupBy }), order: MANUAL, now: NOW })
    expect(JSON.stringify(MANUAL)).toBe(before)
    expect(flat(buildSidebarSections({ repos: fixture(), view: view(), order: MANUAL, now: NOW }))).toEqual(['/r/b', '/r/b/x', '/r/a/z', '/r/a', '/r/a/b', '/r/a/d'])
  })

  it('ⓓ 469 정규화(새 워크트리 자리)는 모드와 무관 — 새 워크트리는 Manual 레포 맨 위', () => {
    const repos = fixture()
    repos[1] = repo('/r/b', [...repos[1]!.worktrees, wt({ path: '/r/b/new', branch: 'new' })])
    const reconciled = reconcileManualOrder({ order: MANUAL, repos })
    expect(reconciled.order.worktrees['/r/b']).toEqual(['/r/b/new', '/r/b', '/r/b/x'])
    expect(reconciled.order.all).toEqual(MANUAL.all)
  })

  it('ⓔ Manual 에서는 에이전트 활동·선택·세션 열기/닫기가 순서를 바꾸지 않는다(#13847 교정)', () => {
    const quiet = fixture()
    const busy = fixture().map((row) => ({
      ...row,
      worktrees: row.worktrees.map((worktree, index) =>
        index === row.worktrees.length - 1
          ? { ...worktree, ...wt({ path: worktree.path, branch: worktree.branch, linked: worktree.isLinked, panes: [pane({ id: `p${worktree.path}`, status: 'blocked', observedAt: NOW })] }) }
          : worktree,
      ),
    }))
    for (const groupBy of ['none', 'repo'] as const) {
      const a = flat(buildSidebarSections({ repos: quiet, view: view({ groupBy }), order: MANUAL, now: NOW }))
      const b = flat(buildSidebarSections({ repos: busy, view: view({ groupBy }), order: MANUAL, now: NOW + 60_000 }))
      expect(b).toEqual(a)
    }
  })
})

describe('None 수동 순서 (orderAll · applyAllMove)', () => {
  it('저장 없음 = 레포 순서 → 레포 안 순서 · 저장 있으면 그 순서, 새것은 맨 위', () => {
    const repos = fixture()
    expect(orderAll({ repos, order: MANUAL }).map((item) => item.worktree.path)).toEqual(['/r/b', '/r/b/x', '/r/a/z', '/r/a', '/r/a/b', '/r/a/d'])
    const stored: ManualOrder = { ...MANUAL, all: ['/r/a/b', '/r/b', '/r/a/z', '/r/b/x', '/r/a', '/gone'] }
    expect(orderAll({ repos, order: stored }).map((item) => item.worktree.path)).toEqual(['/r/a/d', '/r/a/b', '/r/b', '/r/a/z', '/r/b/x', '/r/a'])
  })

  it('None 드롭은 None 순서를 적고, 옮긴 카드 레포의 레포별 목록에도 같은 상대 순서를 투영한다', () => {
    const repos = fixture()
    const visible = orderAll({ repos, order: MANUAL }).map((item) => item.worktree.path)
    // /r/a/d 를 맨 앞으로
    const next = applyAllMove({ order: MANUAL, repos, visiblePaths: visible, path: '/r/a/d', slot: 0 })
    expect(next?.all).toEqual(['/r/a/d', '/r/b', '/r/b/x', '/r/a/z', '/r/a', '/r/a/b'])
    expect(next?.worktrees['/r/a']).toEqual(['/r/a/d', '/r/a/z', '/r/a', '/r/a/b'])
    expect(next?.worktrees['/r/b']).toEqual(MANUAL.worktrees['/r/b'])
    expect(next?.repos).toEqual(MANUAL.repos)
    // None·Manual 화면이 놓은 순서 그대로
    expect(flat(buildSidebarSections({ repos, view: view({ groupBy: 'none' }), order: next!, now: NOW }))).toEqual(next!.all)
  })

  it('Project 드롭은 저장된 None 순서에서 그 레포 카드 자리를 새 순서로 다시 채운다', () => {
    const order: ManualOrder = { ...MANUAL, all: ['/r/a/z', '/r/b', '/r/a', '/r/b/x', '/r/a/b', '/r/a/d'] }
    const next = applyWorktreeMove({ order, repoRoot: '/r/a', worktrees: fixture()[0]!.worktrees, visiblePaths: ['/r/a/z', '/r/a', '/r/a/b', '/r/a/d'], path: '/r/a/d', slot: 0 })
    expect(next?.worktrees['/r/a']).toEqual(['/r/a/d', '/r/a/z', '/r/a', '/r/a/b'])
    expect(next?.all).toEqual(['/r/a/d', '/r/b', '/r/a/z', '/r/b/x', '/r/a', '/r/a/b'])
  })
})

// 수정 라운드 1 — 리뷰 r1 재현(review-codex.md `reproduce.mjs`)을 단위로 옮겼다. 픽스처는 리뷰와 같은 모양(레포 /r, 주 + a·b).
describe('R1-02 필터 중 드롭이 숨은 카드 자리를 지킨다', () => {
  const r = (keys: string[]): RepoRow[] => [repo('/r', keys.map((key) => wt({ path: key, branch: key === '/r' ? 'main' : key.split('/').pop()!, linked: key !== '/r' })))]
  const base: ManualOrder = { repos: ['/r'], worktrees: { '/r': ['/r/a', '/r/b', '/r'] }, all: [] }
  const none = view({ groupBy: 'none' })

  it('hidden-first — 첫 None 드롭(all 비어 있음)에서 숨은 주 체크아웃이 빠지지 않고 원래 자리(맨 뒤)를 지킨다', () => {
    const repos = r(['/r', '/r/a', '/r/b'])
    const next = applyAllMove({ order: base, repos, visiblePaths: ['/r/a', '/r/b'], path: '/r/b', slot: 0 })
    expect(next?.all).toEqual(['/r/b', '/r/a', '/r'])
    expect(flat(buildSidebarSections({ repos, view: { ...none, hideDefaultBranch: true }, order: next!, now: NOW }))).toEqual(['/r/b', '/r/a'])
    expect(flat(buildSidebarSections({ repos, view: none, order: next!, now: NOW }))).toEqual(['/r/b', '/r/a', '/r'])
    expect(next?.worktrees['/r']).toEqual(['/r/b', '/r/a', '/r'])
  })

  it('hidden-existing — 기존 None 순서가 있으면 숨은 카드는 그 슬롯 그대로', () => {
    const repos = r(['/r', '/r/a', '/r/b'])
    const next = applyAllMove({ order: { ...base, all: ['/r/a', '/r', '/r/b'] }, repos, visiblePaths: ['/r/a', '/r/b'], path: '/r/b', slot: 0 })
    expect(next?.all).toEqual(['/r/b', '/r', '/r/a'])
  })

  it('Project 드롭도 같다 — 필터에 가려진 카드는 레포 목록 자리를 지킨다(맨 뒤로 밀리지 않는다)', () => {
    const repos = r(['/r', '/r/a', '/r/b'])
    const order: ManualOrder = { repos: ['/r'], worktrees: { '/r': ['/r/a', '/r', '/r/b'] }, all: [] }
    const next = applyWorktreeMove({ order, repoRoot: '/r', worktrees: repos[0]!.worktrees, visiblePaths: ['/r/a', '/r/b'], path: '/r/b', slot: 0 })
    expect(next?.worktrees['/r']).toEqual(['/r/b', '/r', '/r/a'])
  })
})

// 수정 라운드 2 — 리뷰 r2 재현(review-codex-r2.md `untouched-project-reordered`)을 단위로 옮겼다. App.onReorder 와 같은 순서:
// 화면 구획 → 배치 확정(materializeLayout) → 움직임 반영 → Sort by Manual 로 그린다.
describe('R2-01 비-manual → Manual 전환 드롭은 보이는 전 그룹의 배치를 확정한다', () => {
  const two = (): RepoRow[] => [
    repo('/r', [wt({ path: '/r', branch: 'main', linked: false }), wt({ path: '/r/a', branch: 'a' }), wt({ path: '/r/b', branch: 'b' })]),
    repo('/q', [wt({ path: '/q', branch: 'main', linked: false }), wt({ path: '/q/c', branch: 'c' }), wt({ path: '/q/d', branch: 'd' })]),
  ]
  const reverse: ManualOrder = { repos: ['/r', '/q'], worktrees: { '/r': ['/r/b', '/r/a', '/r'], '/q': ['/q/d', '/q/c', '/q'] }, all: [] }
  const groups = (sections: readonly SidebarSection[]): string[][] => sections.map((section) => section.items.map((item) => item.worktree.path))
  /** App.onReorder 경로 — 카드 드롭(Project) */
  const dropCard = (input: { repos: RepoRow[]; order: ManualOrder; shown: SidebarView; repoRoot: string; path: string; slot: number }) => {
    const sections = buildSidebarSections({ repos: input.repos, view: input.shown, order: input.order, now: NOW })
    const base = materializeLayout({ order: input.order, repos: input.repos, layout: sectionLayout(sections) })
    const visiblePaths = sections.find((section) => section.kind === 'repo' && section.repo.root === input.repoRoot)!.items.map((item) => item.worktree.path)
    const worktrees = input.repos.find((row) => row.root === input.repoRoot)!.worktrees
    return { before: sections, next: applyWorktreeMove({ order: base, repoRoot: input.repoRoot, worktrees, visiblePaths, path: input.path, slot: input.slot }) }
  }

  it('untouched-project-reordered — Name 정렬에서 /r 의 b 를 a 앞으로 끌어도 /q 는 Manual 화면에서 [c,d,main] 그대로', () => {
    const repos = two()
    const nameView = view({ sortBy: 'name' })
    const { before, next } = dropCard({ repos, order: reverse, shown: nameView, repoRoot: '/r', path: '/r/b', slot: 0 })
    expect(groups(before)).toEqual([['/r/a', '/r/b', '/r'], ['/q/c', '/q/d', '/q']])
    const after = buildSidebarSections({ repos, view: { ...nameView, sortBy: 'manual' }, order: next!, now: NOW })
    expect(groups(after)).toEqual([['/r/b', '/r/a', '/r'], ['/q/c', '/q/d', '/q']])
    // 레포 순서는 건드리지 않는다(Project order 는 별도 설정)
    expect(next?.repos).toEqual(reverse.repos)
  })

  it('음성 대조 — 배치 확정 없이(라운드 1 경로) 같은 드롭을 하면 /q 가 옛 수동 순서 [d,c,main] 으로 튄다', () => {
    const repos = two()
    const nameView = view({ sortBy: 'name' })
    const sections = buildSidebarSections({ repos, view: nameView, order: reverse, now: NOW })
    const next = applyWorktreeMove({ order: reverse, repoRoot: '/r', worktrees: repos[0]!.worktrees, visiblePaths: groups(sections)[0]!, path: '/r/b', slot: 0 })
    expect(groups(buildSidebarSections({ repos, view: { ...nameView, sortBy: 'manual' }, order: next!, now: NOW }))[1]).toEqual(['/q/d', '/q/c', '/q'])
  })

  it('필터에 가려진 카드는 확정에서도 자리를 지킨다(R1-02) — 끌지 않은 레포 포함', () => {
    const repos = two()
    // 기본 브랜치(main) 숨김 — 각 레포 주 체크아웃은 화면에 없다
    const shown = view({ sortBy: 'name', hideDefaultBranch: true })
    const order: ManualOrder = { repos: ['/r', '/q'], worktrees: { '/r': ['/r/b', '/r', '/r/a'], '/q': ['/q/d', '/q', '/q/c'] }, all: [] }
    const { before, next } = dropCard({ repos, order, shown, repoRoot: '/r', path: '/r/b', slot: 0 })
    expect(groups(before)).toEqual([['/r/a', '/r/b'], ['/q/c', '/q/d']])
    expect(next?.worktrees['/r']).toEqual(['/r/b', '/r', '/r/a'])
    expect(next?.worktrees['/q']).toEqual(['/q/c', '/q', '/q/d'])
    expect(groups(buildSidebarSections({ repos, view: { ...shown, sortBy: 'manual' }, order: next!, now: NOW }))).toEqual([['/r/b', '/r/a'], ['/q/c', '/q/d']])
  })

  it('Group None 도 같은 원칙 — 확정한 None 순서에 움직임만 반영되고, 레포별 목록에도 그 상대 순서가 투영된다', () => {
    const repos = two()
    const shown = view({ sortBy: 'name', groupBy: 'none' })
    const sections = buildSidebarSections({ repos, view: shown, order: reverse, now: NOW })
    const visible = groups(sections)[0]!
    const base = materializeLayout({ order: reverse, repos, layout: sectionLayout(sections) })
    // 이름순 화면 그대로 확정 — 끌기 전에도 Manual 로 그리면 같은 화면
    expect(base.all).toEqual(visible)
    // 맨 뒤 카드를 맨 앞으로
    const last = visible[visible.length - 1]!
    const next = applyAllMove({ order: base, repos, visiblePaths: visible, path: last, slot: 0 })
    expect(flat(buildSidebarSections({ repos, view: { ...shown, sortBy: 'manual' }, order: next!, now: NOW }))).toEqual([last, ...visible.slice(0, -1)])
    // 끌지 않은 레포(/r)도 이름순 상대 순서로 확정된다 — Project 로 돌아가도 None 에서 본 순서
    expect(next?.worktrees['/r']).toEqual(visible.filter((path) => path.startsWith('/r')))
  })

  it('이미 Manual 인 국소 드롭은 확정하지 않는다 — App 이 layout 을 넘기지 않으므로 다른 레포 수동 순서 그대로', () => {
    const repos = two()
    const manualView = view({ sortBy: 'manual' })
    const sections = buildSidebarSections({ repos, view: manualView, order: reverse, now: NOW })
    const next = applyWorktreeMove({ order: reverse, repoRoot: '/r', worktrees: repos[0]!.worktrees, visiblePaths: groups(sections)[0]!, path: '/r', slot: 0 })
    expect(next?.worktrees['/q']).toEqual(reverse.worktrees['/q'])
    // 화면 그대로 확정해도 Manual 화면은 이미 수동 순서라 값이 같다 — 확정이 국소 드롭 결과를 바꾸지 않는다
    expect(materializeLayout({ order: reverse, repos, layout: sectionLayout(sections) }).worktrees).toEqual(reverse.worktrees)
  })
})

describe('R1-03 None 순서도 469 정규화를 같은 권위 조건으로 받는다', () => {
  const r = (keys: string[], error: string | null = null): RepoRow[] => [
    { ...repo('/r', keys.map((key) => wt({ path: key, branch: key === '/r' ? 'main' : key.split('/').pop()!, linked: key !== '/r' }))), error },
  ]
  const none = view({ groupBy: 'none' })

  it('new-path-group-roundtrip — 새 카드를 Project 에서 맨 아래로 옮기면 None 에서도 맨 아래', () => {
    const order: ManualOrder = { repos: ['/r'], worktrees: { '/r': ['/r/a', '/r'] }, all: ['/r/a', '/r'] }
    const repos = r(['/r', '/r/a', '/r/new'])
    const normalized = reconcileManualOrder({ order, repos }).order
    expect(normalized.all).toEqual(['/r/new', '/r/a', '/r'])
    const moved = applyWorktreeMove({ order: normalized, repoRoot: '/r', worktrees: repos[0]!.worktrees, visiblePaths: normalized.worktrees['/r']!, path: '/r/new', slot: 3 })!
    expect(moved.worktrees['/r']).toEqual(['/r/a', '/r', '/r/new'])
    expect(flat(buildSidebarSections({ repos, view: none, order: moved, now: NOW }))).toEqual(['/r/a', '/r', '/r/new'])
  })

  it('recreated-path — 확실히 지운 경로는 None 에서도 빠지고, 다시 생기면 두 그룹 방식 모두 새것(맨 위)', () => {
    const repos = r(['/r', '/r/a', '/r/b'])
    const order: ManualOrder = { repos: ['/r'], worktrees: { '/r': ['/r/a', '/r/b', '/r'] }, all: ['/r/a', '/r', '/r/b'] }
    const afterDelete = reconcileManualOrder({ order, repos: r(['/r', '/r/a']) }).order
    expect(afterDelete.all).toEqual(['/r/a', '/r'])
    const afterRecreate = reconcileManualOrder({ order: afterDelete, repos }).order
    expect(afterRecreate.worktrees['/r']).toEqual(['/r/b', '/r/a', '/r'])
    expect(flat(buildSidebarSections({ repos, view: none, order: afterRecreate, now: NOW }))).toEqual(['/r/b', '/r/a', '/r'])
  })

  it('일시 오류·불완전 목록에서는 None 순서 키를 버리지 않는다 · 빈 None 순서는 그대로 비워 둔다', () => {
    const order: ManualOrder = { repos: ['/r'], worktrees: { '/r': ['/r/a', '/r/b', '/r'] }, all: ['/r/a', '/r', '/r/b'] }
    expect(reconcileManualOrder({ order, repos: r(['/r/a'], 'git 오류') }).order.all).toEqual(['/r/a', '/r', '/r/b'])
    expect(reconcileManualOrder({ order, repos: [] }).order.all).toEqual(['/r/a', '/r', '/r/b'])
    expect(reconcileManualOrder({ order: { ...order, all: [] }, repos: r(['/r', '/r/a', '/r/new']) }).order.all).toEqual([])
  })

  it('레포 제거(forgetRepo)는 그 레포 카드를 None 순서에서도 뺀다', () => {
    const order: ManualOrder = { repos: ['/r', '/q'], worktrees: { '/r': ['/r/a', '/r'], '/q': ['/q'] }, all: ['/r/a', '/q', '/r'] }
    expect(forgetRepo({ order, root: '/r' }).all).toEqual(['/q'])
  })
})

describe('U3 재정렬 지연', () => {
  const sig = (sections: SidebarSection[], v: SidebarView = view({ sortBy: 'smart' })): ReturnType<typeof layoutSignature> => layoutSignature({ sections, view: v, order: EMPTY_MANUAL_ORDER })
  const repos = (statusOfZ: AgentStatus): RepoRow[] => [
    repo('/r/a', [
      wt({ path: '/r/a', branch: 'main', linked: false, panes: [pane({ id: 'm', status: 'working', observedAt: 100 })] }),
      wt({ path: '/r/a/z', branch: 'zeta', panes: [pane({ id: 'z', status: statusOfZ, observedAt: 200 })] }),
    ]),
  ]

  it('활동으로만 순서가 바뀌면 settle, 구성·옵션이 바뀌면 now, 같으면 same', () => {
    const v = view({ sortBy: 'smart' })
    const before = buildSidebarSections({ repos: repos('idle'), view: v, order: EMPTY_MANUAL_ORDER, now: NOW })
    const after = buildSidebarSections({ repos: repos('blocked'), view: v, order: EMPTY_MANUAL_ORDER, now: NOW })
    expect(flat(before)).toEqual(['/r/a', '/r/a/z'])
    expect(flat(after)).toEqual(['/r/a/z', '/r/a'])
    expect(settleDecision({ shown: sig(before), next: sig(after), activityDriven: true })).toBe('settle')
    expect(settleDecision({ shown: sig(before), next: sig(before), activityDriven: true })).toBe('same')
    expect(settleDecision({ shown: sig(before, view({ sortBy: 'name' })), next: sig(after), activityDriven: true })).toBe('now')
    const fewer = buildSidebarSections({ repos: repos('blocked'), view: view({ sortBy: 'smart', hideDefaultBranch: true }), order: EMPTY_MANUAL_ORDER, now: NOW })
    expect(settleDecision({ shown: sig(before), next: sig(fewer), activityDriven: true })).toBe('now')
    expect(settleDecision({ shown: sig(before), next: sig(after), activityDriven: false })).toBe('now')
    // R1-05 — 화면 순서가 같아도 옵션이 바뀌면 now(그린 배치의 옵션을 맞춘다), R1-04 — 수동 순서가 바뀌면 활동 모드여도 now.
    expect(settleDecision({ shown: sig(before, view({ sortBy: 'manual' })), next: sig(before), activityDriven: true })).toBe('now')
    const manualChanged = { ...sig(after), manual: JSON.stringify({ ...EMPTY_MANUAL_ORDER, repos: ['/r/a'] }) }
    expect(settleDecision({ shown: sig(before), next: manualChanged, activityDriven: true })).toBe('now')
  })

  it('지연 중에는 이전 자리에 최신 카드 내용을 채운다', () => {
    const v = view({ sortBy: 'smart' })
    const before = buildSidebarSections({ repos: repos('idle'), view: v, order: EMPTY_MANUAL_ORDER, now: NOW })
    const after = buildSidebarSections({ repos: repos('blocked'), view: v, order: EMPTY_MANUAL_ORDER, now: NOW })
    const held = applyShownLayout({ layout: sig(before).layout, sections: after })
    expect(flat(held)).toEqual(['/r/a', '/r/a/z'])
    expect(held[0]?.items[1]?.worktree.workspace?.tabs[0]?.panes[0]?.agentStatus).toBe('blocked')
  })

  it('지연을 거는 모드 = Agent Activity · Recent · (Project 그룹) Project order Recent', () => {
    expect(isActivityDriven(view({ sortBy: 'manual' }))).toBe(false)
    expect(isActivityDriven(view({ sortBy: 'name' }))).toBe(false)
    expect(isActivityDriven(view({ sortBy: 'smart' }))).toBe(true)
    expect(isActivityDriven(view({ sortBy: 'recent' }))).toBe(true)
    expect(isActivityDriven(view({ projectOrderBy: 'recent' }))).toBe(true)
    expect(isActivityDriven(view({ groupBy: 'none', projectOrderBy: 'recent' }))).toBe(false)
  })
})
