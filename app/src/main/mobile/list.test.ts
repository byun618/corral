// 폰 목록 (LIFE-580) — L2ⓐ 동등 시험 · L1ⓑⓒ · L5ⓒⓘ · L8 · L9ⓓ.
//
// 동등 시험은 데스크톱 사이드바가 화면을 만드는 호출 순서(`Sidebar.tsx` 의 buildSidebarSections → nestSectionItems,
// `WorktreeBlock.tsx` 의 buildAgentRows)를 **여기서 따로** 밟아 기대값을 만들고, 폰 목록이 그것과 같은지 본다 — 정렬 모드·수동 순서·
// 데스크톱 장부(안 읽음)를 바꿔 가며. 폰 전용 규칙(숨김·셸 제외·서브에이전트 제외·보존 행 뒤로)은 기대값 쪽에 같은 말로 적었다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAgentRows, livePaneIdsOf, retainedByWorktree, type AgentRowNode } from '../../shared/sidebar-agents.js'
import { buildSidebarSections, lineageGraph, nestSectionItems } from '../../shared/sidebar-sections.js'
import { DEFAULT_SIDEBAR_VIEW } from '../../shared/sidebar-view.js'
import type { UiPrefs } from '../../shared/types.js'
import { worktreeDisplayName } from '../../shared/worktree-name.js'
import { UiPrefsStore } from '../ui-prefs.js'
import { buildMobileList, type MobileChannel, type MobileList } from './list.js'
import { FIXTURE_NOW, listFixture } from './list-fixture.js'
import type { ListState } from './list.js'

function prefs(patch: Partial<UiPrefs> = {}): UiPrefs {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l580p-'))
  const store = new UiPrefsStore(dir)
  store.load()
  const value = { ...store.get(), ...patch }
  fs.rmSync(dir, { recursive: true, force: true })
  return value
}

type Row = { group: string; title: string; dot: string; status: 'live' | 'closed' }

/** 데스크톱 사이드바가 같은 순간에 그릴 행 — 「레포로 묶기」 보기(필터·고정 끔) + 데스크톱 장부 `unread`. */
function desktopRows(input: { state: ListState; prefs: UiPrefs; unread: ReadonlySet<string> }): Row[] {
  const { state } = input
  const view = { ...DEFAULT_SIDEBAR_VIEW, sortBy: input.prefs.sidebarSortBy, projectOrderBy: input.prefs.sidebarProjectOrderBy, groupBy: 'repo' as const }
  const order = { repos: input.prefs.manualRepoOrder, worktrees: input.prefs.manualWorktreeOrder, all: input.prefs.manualFlatOrder }
  const sections = buildSidebarSections({ repos: state.repos, view, order, now: FIXTURE_NOW })
  const graph = lineageGraph(state.repos)
  const live = livePaneIdsOf(state.repos)
  const retainedOf = retainedByWorktree({ repos: state.repos, retained: state.retainedAgents })
  const out: Row[] = []
  for (const section of sections) {
    for (const unit of nestSectionItems({ items: section.items, collapsed: new Set(), graph })) {
      const group = `${section.kind === 'repo' ? section.repo.name : ''}/${worktreeDisplayName(unit.root.item.worktree)}`
      const rows: Row[] = []
      for (const worktree of [unit.root.item.worktree, ...unit.descendants.map((row) => row.item.worktree)]) {
        const roots = buildAgentRows({
          tabs: worktree.workspace?.tabs ?? [],
          retained: retainedOf.get(worktree.path) ?? [],
          lineage: state.orchestrationLineage,
          livePaneIds: live,
          integrations: state.integrations,
          home: state.home,
          unreadPanes: input.unread,
        })
        const flat: AgentRowNode[] = roots.flatMap((root) => [root, ...root.children])
        for (const node of flat) {
          // 폰은 세션(채널)만 — 서브에이전트 행(자기 pane 없음)과 셸은 뺀다.
          if (node.source === 'subagent' || node.kind === 'shell') continue
          rows.push({ group, title: node.full.label, dot: node.dot, status: node.source === 'retained' ? 'closed' : 'live' })
        }
      }
      // M3-b — 열린 AI 세션 없는 작업 숨김 · J2 — 보존 행은 그룹 끝.
      if (!rows.some((row) => row.status === 'live')) continue
      out.push(...rows.filter((row) => row.status === 'live'), ...rows.filter((row) => row.status === 'closed'))
    }
  }
  return out
}

function phoneRows(input: { list: MobileList; unread: ReadonlySet<string>; idOf: (channel: MobileChannel) => string }): Row[] {
  return input.list.repos.flatMap((repo) =>
    repo.tasks.flatMap((task) =>
      task.channels.map((channel) => ({
        group: `${repo.name}/${task.name}`,
        title: channel.title,
        // 폰 장부로 두 값 중 하나를 고른다 — 폰이 하는 일은 이것뿐이다.
        dot: input.unread.has(input.idOf(channel)) ? channel.dotUnseen : channel.dot,
        status: channel.status,
      })),
    ),
  )
}

const paneOf = (channel: MobileChannel): string => channel.id.replace(/^retained:/, '')

function channels(list: MobileList): MobileChannel[] {
  return list.repos.flatMap((repo) => repo.tasks.flatMap((task) => task.channels))
}

function byTitle(list: MobileList, title: string): MobileChannel {
  const found = channels(list).find((channel) => channel.title === title)
  if (found === undefined) throw new Error(`채널 없음: ${title}`)
  return found
}

describe('L2ⓐ 같은 값 — 데스크톱 파생 함수 결과와 폰 목록이 같다', () => {
  const cases: { name: string; prefs: Partial<UiPrefs>; unread: string[] }[] = [
    { name: '기본(smart) · 장부 비어 있음', prefs: {}, unread: [] },
    { name: 'smart · 완료 둘 안 읽음 + 보존 행 안 읽음', prefs: {}, unread: ['p3', 'p21', 'r1'] },
    { name: 'name 정렬', prefs: { sidebarSortBy: 'name' }, unread: ['p3'] },
    { name: 'recent 정렬 + 프로젝트 순서 recent', prefs: { sidebarSortBy: 'recent', sidebarProjectOrderBy: 'recent' }, unread: [] },
    { name: 'repo 정렬', prefs: { sidebarSortBy: 'repo' }, unread: ['p21'] },
    {
      name: 'manual — 레포·워크트리 수동 순서',
      prefs: { sidebarSortBy: 'manual', manualRepoOrder: ['/fx/la', '/fx/corral'], manualWorktreeOrder: { '/fx/corral': ['/fx/corral/.wt/orphan', '/fx/corral/.wt/life-564', '/fx/corral/.wt/life-579'] } },
      unread: [],
    },
    { name: '데스크톱 필터·고정은 폰에 안 걸린다', prefs: { sidebarHideDefaultBranch: true, sidebarRepoFilter: ['/fx/la'], pinnedWorktrees: ['/fx/corral/.wt/orphan'] }, unread: [] },
  ]
  for (const item of cases) {
    it(item.name, () => {
      const state = listFixture()
      const value = prefs(item.prefs)
      const unread = new Set(item.unread)
      const list = buildMobileList({ state, prefs: value, now: FIXTURE_NOW })
      const expected = desktopRows({ state, prefs: { ...value, sidebarHideDefaultBranch: false, sidebarRepoFilter: [] }, unread })
      expect(phoneRows({ list, unread, idOf: paneOf })).toEqual(expected)
      expect(expected.length).toBeGreaterThanOrEqual(12)
    })
  }

  it('고정 상태 묶음이 ≥ 10종을 덮는다 — 점 종류·출처', () => {
    const list = buildMobileList({ state: listFixture(), prefs: null, now: FIXTURE_NOW })
    const dots = new Set(channels(list).flatMap((channel) => [channel.dot, channel.dotUnseen]))
    for (const dot of ['waiting', 'blocked', 'working', 'monitoring', 'interrupted', 'failed', 'done', 'unverifiable', 'idle']) expect(dots).toContain(dot)
    expect(channels(list).some((channel) => channel.status === 'closed')).toBe(true)
    expect(channels(list).some((channel) => channel.origin !== null)).toBe(true)
    expect(channels(list).some((channel) => channel.depth === 1 && channel.origin === null)).toBe(true)
  })
})

describe('L1 · L5 · L8 · L9 — 폰 전용 규칙', () => {
  const list = buildMobileList({ state: listFixture(), prefs: null, now: FIXTURE_NOW })

  it('L1ⓑ 셸 pane 0건 — 같은 워크트리에 섞인 셸도, 셸만 있는 작업도 안 온다', () => {
    const ids = channels(list).map((channel) => channel.id)
    expect(ids).not.toContain('s0')
    expect(ids).not.toContain('s1')
    expect(list.repos.flatMap((repo) => repo.tasks.map((task) => task.name))).not.toContain('main')
    // 양성 대조: 같은 워크트리의 에이전트는 온다.
    expect(ids).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']))
  })

  it('L1ⓒ 하위 워크트리는 최상위 조상 작업에 합쳐지고 출신이 붙는다 · 고아는 독립 그룹', () => {
    const corral = list.repos.find((repo) => repo.name === 'corral')
    const task = corral?.tasks.find((item) => item.name === 'LIFE-579-mobile-design')
    expect(task?.channels.map((channel) => channel.id)).toEqual(['p1', 'p2', 'p3', 'p5', 'retained:r1'])
    expect(byTitle(list, '목록 행 구현')).toMatchObject({ origin: 'life-579-impl', depth: 1, spawnedBy: null })
    expect(corral?.tasks.map((item) => item.name)).toContain('orphan-child')
  })

  it('L1ⓒ 워커 들여쓰기 · 띄운 세션은 다른 작업이거나 모를 때만', () => {
    expect(byTitle(list, '목록 화면 구현')).toMatchObject({ depth: 1, origin: null, spawnedBy: null })
    expect(byTitle(list, '다른 레포에서 띄운 워커').spawnedBy).toEqual({ title: '알림 모듈 리팩터' })
    expect(byTitle(list, '부모 모르는 워커').spawnedBy).toEqual({ title: null })
  })

  it('L5ⓒ · L8 — 닫힌 세션만 남은 작업 숨김, 보존 행은 그룹 끝 `closed`, 기다림 아님', () => {
    expect(list.repos.flatMap((repo) => repo.tasks.map((task) => task.name))).not.toContain('closed-only')
    const closed = byTitle(list, '닫은 리뷰 세션')
    expect(closed).toMatchObject({ status: 'closed', waiting: null, activityAt: null })
    expect(list.waiting).not.toContain(closed.id)
  })

  it('M3-a 「나를 기다리는 것」 — 질문 → 맥에서만 풀리는 대기(최근순)', () => {
    expect(list.waiting).toEqual(['p1', 'p22', 'p20'])
    expect(byTitle(list, '알림 모듈 리팩터').waiting).toBe('approval')
    expect(byTitle(list, '로그인 필요한 세션').waiting).toBe('login')
  })

  it('L5ⓘ 미리보기(J11) — 질문 내용 · 권한 도구(claude) · 진행 중 도구 · 내 마지막 지시 · 실패 사유', () => {
    expect(byTitle(list, '모바일 디자인 브리프 정리').preview).toEqual({ kind: 'question', text: '목록 상단 구조를 어느 안으로 갈까요?' })
    expect(byTitle(list, '알림 모듈 리팩터').preview).toEqual({ kind: 'approval', text: 'Bash · rm -rf .expo/cache' })
    expect(byTitle(list, '목록 행 구현').preview).toEqual({ kind: 'tool', text: 'Edit · mobile/app/home.tsx' })
    expect(byTitle(list, '재연결 정책 조사').preview).toEqual({ kind: 'prompt', text: '웹소켓 재연결 백오프 정리해 줘' })
    expect(byTitle(list, '빌드 고치기').preview).toEqual({ kind: 'error', text: 'API Error: 529 overloaded' })
    expect(byTitle(list, '상태 모르는 세션').preview).toEqual({ kind: 'none' })
  })

  it('J1 안 읽음 키 — provider 세션 참조가 있으면 pane id 와 무관한 해시', () => {
    const before = byTitle(list, '푸시 제거 테스트').key
    const moved = listFixture()
    // herdr 재기동 — 같은 세션이 다른 pane id 로 돌아온다.
    for (const repo of moved.repos) for (const worktree of repo.worktrees) for (const tab of worktree.workspace?.tabs ?? []) for (const pane of tab.panes) if (pane.paneId === 'p21') pane.paneId = 'p99'
    const after = byTitle(buildMobileList({ state: moved, prefs: null, now: FIXTURE_NOW }), '푸시 제거 테스트')
    expect(after.id).toBe('p99')
    expect(after.key).toBe(before)
    expect(before.startsWith('s:')).toBe(true)
    expect(byTitle(list, '상태 모르는 세션').key).toBe('pane:p7')
  })

  it('L9ⓓ 페이로드에 경로·셸 제목·홈이 없다', () => {
    const text = JSON.stringify(list)
    for (const secret of ['/fx/', 'byun@mac', 'zsh', 'sess-codex-21', '/fx/home']) expect(text).not.toContain(secret)
  })

  it('L5ⓗ herdr 링크가 live 가 아니면 「못 읽음」 — 빈 목록과 구분한다', () => {
    const state = listFixture()
    const down = buildMobileList({ state: { ...state, link: { ...state.link, phase: 'reconnecting' } }, prefs: null, now: FIXTURE_NOW })
    expect(down).toEqual({ available: false, reason: 'reconnecting', repos: [], waiting: [] })
    const empty = buildMobileList({ state: { ...state, repos: [], retainedAgents: [] }, prefs: null, now: FIXTURE_NOW })
    expect(empty).toEqual({ available: true, repos: [], waiting: [] })
  })
})
