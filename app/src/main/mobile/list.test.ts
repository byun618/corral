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
import { buildMobileList, MASKED_UNDECODABLE, maskPaths, percentDecode, previewOf, type MobileChannel, type MobileList } from './list.js'
import { FIXTURE_NOW, fixturePane, listFixture } from './list-fixture.js'
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
      // LIFE-588 D1 — 워크트리(데스크톱 카드)마다 따로 모은다: 보존 행은 그 카드 끝, 열린 세션 없는 하위 카드의 보존 행은 루트 카드 끝.
      const parts: Row[][] = []
      const headless: Row[] = []
      for (const worktree of [unit.root.item.worktree, ...unit.descendants.map((row) => row.item.worktree)]) {
        const rows: Row[] = []
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
        const opened = rows.filter((row) => row.status === 'live')
        const closed = rows.filter((row) => row.status === 'closed')
        if (parts.length > 0 && opened.length === 0) headless.push(...closed)
        else parts.push([...opened, ...closed])
      }
      parts[0]?.push(...headless)
      const rows = parts.flat()
      // M3-b — 열린 AI 세션 없는 작업 숨김 · J2 — 보존 행은 그 묶음 끝(LIFE-588).
      if (!rows.some((row) => row.status === 'live')) continue
      out.push(...rows)
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
    // LIFE-588 D1 — 보존 행 r1(루트 워크트리)은 루트 묶음 끝, 하위 묶음(p5)보다 앞. 이전 기대: ['p1','p2','p3','p5','retained:r1'].
    expect(task?.channels.map((channel) => channel.id)).toEqual(['p1', 'p2', 'p3', 'retained:r1', 'p5'])
    // LIFE-588 D5 — 하위 출신이라고 들여 쓰지 않는다(depth 0, 이전 1) · 부모 p1 이 루트 쪽(다른 묶음)이라 띄운 세션이 붙는다(이전 null).
    expect(byTitle(list, '목록 행 구현')).toMatchObject({ origin: 'life-579-impl', depth: 0, spawnedBy: { title: '모바일 디자인 브리프 정리' } })
    expect(corral?.tasks.map((item) => item.name)).toContain('orphan-child')
  })

  it('L1ⓒ 워커 들여쓰기 · 띄운 세션은 다른 작업이거나 모를 때만', () => {
    expect(byTitle(list, '목록 화면 구현')).toMatchObject({ depth: 1, origin: null, spawnedBy: null })
    expect(byTitle(list, '다른 레포에서 띄운 워커').spawnedBy).toEqual({ title: '알림 모듈 리팩터' })
    expect(byTitle(list, '부모 모르는 워커').spawnedBy).toEqual({ title: null })
  })

  it('C2 대화 머리용 `parent` — 계보에 부모가 있으면 항상(같은 그룹 부모 포함), 없으면 null', () => {
    // 같은 워크트리 워커 — 목록 행엔 안 붙지만(spawnedBy null) 머리에는 붙는다.
    expect(byTitle(list, '목록 화면 구현')).toMatchObject({ spawnedBy: null, parent: { title: '모바일 디자인 브리프 정리' } })
    // 하위 워크트리 — LIFE-588 D5: 부모가 다른 묶음(루트 쪽)이라 목록 행에도 붙는다(이전 spawnedBy null). 머리 `parent` 는 그대로.
    expect(byTitle(list, '목록 행 구현')).toMatchObject({ spawnedBy: { title: '모바일 디자인 브리프 정리' }, parent: { title: '모바일 디자인 브리프 정리' } })
    expect(byTitle(list, '다른 레포에서 띄운 워커').parent).toEqual({ title: '알림 모듈 리팩터' })
    expect(byTitle(list, '부모 모르는 워커').parent).toEqual({ title: null })
    // 음성 대조: 계보에 없는 세션·보존 행.
    expect(byTitle(list, '재연결 정책 조사').parent).toBeNull()
    expect(byTitle(list, '닫은 리뷰 세션').parent).toBeNull()
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

describe('R1-A3 폰 표시 글의 경로 — 홈 아래 절대경로를 싣지 않는다 · 제목은 데스크톱과 같은 문자열', () => {
  it('maskPaths — worktree 안은 상대, 그 밖의 홈 아래는 `~/`, 홈 밖은 그대로, 경계를 본다', () => {
    const place = { worktree: '/Users/me/repos/app/.wt/feat', home: '/Users/me' }
    expect(maskPaths({ text: 'Read · /Users/me/repos/app/.wt/feat/src/a.ts', ...place })).toBe('Read · src/a.ts')
    expect(maskPaths({ text: 'cd /Users/me/repos/app/.wt/feat && ls', ...place })).toBe('cd . && ls')
    expect(maskPaths({ text: 'Read · /Users/me/.ssh/config', ...place })).toBe('Read · ~/.ssh/config')
    expect(maskPaths({ text: 'cat /Users/me', ...place })).toBe('cat ~')
    expect(maskPaths({ text: 'diff /Users/me/repos/app/.wt/feat-2/x /Users/me/repos/app/.wt/feat/y', ...place })).toBe('diff ~/repos/app/.wt/feat-2/x y')
    expect(maskPaths({ text: 'ls /Users/meow/x /tmp/y', ...place })).toBe('ls /Users/meow/x /tmp/y')
    expect(maskPaths({ text: 'Read · "/Users/me/a b.txt"', ...place })).toBe('Read · "~/a b.txt"')
  })

  const withPanes = (overrides: Parameters<typeof listFixture>[0]) => buildMobileList({ state: listFixture(overrides), prefs: null, now: FIXTURE_NOW })

  it('Read/Edit 절대경로 — 작업 worktree 안 → 상대, 홈 아래 다른 곳 → `~/`, 페이로드에 홈·worktree 절대경로 0', () => {
    const inside = withPanes({ p5: { digest: { providerTitle: '목록 행 구현', tool: { name: 'Read', input: '/fx/corral/.wt/life-579-impl/src/secret.ts' } } } })
    expect(byTitle(inside, '목록 행 구현').preview).toEqual({ kind: 'tool', text: 'Read · src/secret.ts' })
    const home = withPanes({ p5: { digest: { providerTitle: '목록 행 구현', tool: { name: 'Edit', input: '/fx/home/private/notes.md' } } } })
    expect(byTitle(home, '목록 행 구현').preview).toEqual({ kind: 'tool', text: 'Edit · ~/private/notes.md' })
    // 권한 대기·질문·지시·실패 사유도 같은 규칙.
    const all = withPanes({
      p20: { digest: { providerTitle: '알림 모듈 리팩터', tool: { name: 'Bash', input: 'rm -rf /fx/home/.cache/x' } } },
      p1: { digest: { providerTitle: '모바일 디자인 브리프 정리', pendingQuestions: [{ question: '/fx/home/notes 를 지울까요?', header: 'h', options: [], multiSelect: false }] } },
      p6: { digest: { firstPrompt: '재연결 정책 조사', lastPrompt: '/fx/corral/.wt/life-564/README.md 읽어 줘', lastActivityAt: FIXTURE_NOW } },
      p8: { digest: { providerTitle: '빌드 고치기', turnOutcome: { outcome: 'failed', error: 'ENOENT /fx/home/x.json' }, turnOutcomeAt: FIXTURE_NOW } },
    })
    expect(byTitle(all, '알림 모듈 리팩터').preview).toEqual({ kind: 'approval', text: 'Bash · rm -rf ~/.cache/x' })
    expect(byTitle(all, '모바일 디자인 브리프 정리').preview).toEqual({ kind: 'question', text: '~/notes 를 지울까요?' })
    expect(byTitle(all, '재연결 정책 조사').preview).toEqual({ kind: 'prompt', text: 'README.md 읽어 줘' })
    expect(byTitle(all, '빌드 고치기').preview).toEqual({ kind: 'error', text: 'ENOENT ~/x.json' })
    for (const payload of [inside, home, all]) {
      const text = JSON.stringify(payload)
      expect(text).not.toContain('/fx/home')
      expect(text).not.toContain('/fx/corral/.wt/')
    }
  })

  it('음성 대조 — 가림 없이 만들면 같은 입력이 절대경로를 싣는다(시험이 경로를 실제로 본다)', () => {
    const pane = fixturePane('x', 'claude', { agentStatus: 'working', digest: { tool: { name: 'Read', input: '/fx/home/private/notes.md' } } })
    expect(previewOf({ pane, dot: 'working', place: { worktree: null, home: '' } })).toEqual({ kind: 'tool', text: 'Read · /fx/home/private/notes.md' })
    expect(previewOf({ pane, dot: 'working', place: { worktree: null, home: '/fx/home' } })).toEqual({ kind: 'tool', text: 'Read · ~/private/notes.md' })
  })

  it('제목 = 데스크톱 사이드바와 같은 문자열 — 터미널 제목 폴백(경로 모양 · 셸 프롬프트 모양) 포함', () => {
    // providerTitle·firstPrompt 가 없는 AI pane — 데스크톱은 터미널 제목으로 폴백한다(홈 축약은 데스크톱 함수가 한다).
    const overrides = {
      p7: { title: '/tmp/secret', digest: { providerTitle: null } },
      p9: { title: 'byun@mac:~/repos/corral', cwd: '/fx/home/repos/corral', digest: { providerTitle: null } },
    }
    const state = listFixture(overrides)
    const value = prefs()
    const phone = phoneRows({ list: buildMobileList({ state, prefs: value, now: FIXTURE_NOW }), unread: new Set(), idOf: paneOf })
    const desktop = desktopRows({ state, prefs: value, unread: new Set() })
    expect(phone).toEqual(desktop)
    // 양성: 폴백 제목이 실제로 들어갔다(시험이 비교 대상 행을 갖고 있다).
    const titles = phone.map((row) => row.title)
    expect(titles).toContain('/tmp/secret')
    expect(titles).toContain('~/repos/corral')
    // 셸 프롬프트 제목의 사용자@호스트 원문·홈 절대경로는 싣지 않는다(데스크톱이 cwd 홈 축약으로 바꾼다).
    expect(titles.join('\n')).not.toContain('byun@mac')
    expect(titles.join('\n')).not.toContain('/fx/home')
  })
})

describe('R1-A5 미리보기 순서 — 두 재료가 함께 있을 때(코디 해석: 지금 순서 유지)', () => {
  const place = { worktree: null, home: '/fx/home' }
  it('작업 중 도구 + 마지막 지시 → 도구 · 작업이 끝나면(한가) 같은 재료에서 지시', () => {
    const pane = fixturePane('x', 'claude', { agentStatus: 'working', digest: { lastPrompt: 'Please fix the list', tool: { name: 'Read', input: 'src/a.ts' } } })
    expect(previewOf({ pane, dot: 'working', place })).toEqual({ kind: 'tool', text: 'Read · src/a.ts' })
    expect(previewOf({ pane, dot: 'idle', place })).toEqual({ kind: 'prompt', text: 'Please fix the list' })
  })
  it('실패 사유 + 마지막 지시 → 실패 사유 · 사유가 비면 지시', () => {
    const failed = fixturePane('y', 'claude', { digest: { lastPrompt: 'Please fix the list', turnOutcome: { outcome: 'failed', error: 'API Error: 529' } } })
    expect(previewOf({ pane: failed, dot: 'failed', place })).toEqual({ kind: 'error', text: 'API Error: 529' })
    const blank = fixturePane('z', 'claude', { digest: { lastPrompt: 'Please fix the list', turnOutcome: { outcome: 'failed', error: ' ' } } })
    expect(previewOf({ pane: blank, dot: 'failed', place })).toEqual({ kind: 'prompt', text: 'Please fix the list' })
  })
  it('claude 아닌 에이전트는 도구 재료를 쓰지 않는다 — 작업 중이어도 지시', () => {
    const pane = fixturePane('w', 'codex', { agentStatus: 'working', digest: { lastPrompt: '지시', tool: { name: 'Read', input: 'a' } } })
    expect(previewOf({ pane, dot: 'working', place })).toEqual({ kind: 'prompt', text: '지시' })
  })
})

describe('LIFE-581 X8 미리보기 — 에이전트 마지막 답은 「내 지시」 앞', () => {
  const place = { worktree: '/fx/home/repo', home: '/fx/home' }
  const reply = { state: 'text' as const, text: '답에 /fx/home/repo/src/a.ts 와 /fx/home/x 가 있다', at: 1 }
  const all = {
    lastPrompt: '내 지시',
    activity: reply,
    tool: { name: 'Read', input: 'src/a.ts' },
    pendingQuestions: [{ question: '질문?', header: null, options: [], multiSelect: null }],
    turnOutcome: { outcome: 'failed' as const, error: '실패 사유' },
  }
  it('질문 → 권한 → 실패 → 작업 중 도구 → 마지막 답 → 내 지시 → 도구 — 재료를 하나씩 덜어 내며 본다 · 답도 홈 경로를 가린다', () => {
    const waiting = fixturePane('q', 'claude', { agentStatus: 'blocked', agentState: { blockedReason: 'question' }, digest: all })
    expect(previewOf({ pane: waiting, dot: 'waiting', place })).toEqual({ kind: 'question', text: '질문?' })
    const approval = fixturePane('a', 'claude', { agentStatus: 'blocked', agentState: { blockedReason: 'permission' }, digest: all })
    expect(previewOf({ pane: approval, dot: 'waiting', place })).toEqual({ kind: 'approval', text: 'Read · src/a.ts' })
    const failed = fixturePane('f', 'claude', { digest: all })
    expect(previewOf({ pane: failed, dot: 'failed', place })).toEqual({ kind: 'error', text: '실패 사유' })
    const working = fixturePane('w', 'claude', { agentStatus: 'working', digest: all })
    expect(previewOf({ pane: working, dot: 'working', place })).toEqual({ kind: 'tool', text: 'Read · src/a.ts' })
    const idle = fixturePane('i', 'claude', { digest: all })
    expect(previewOf({ pane: idle, dot: 'idle', place })).toEqual({ kind: 'reply', text: '답에 src/a.ts 와 ~/x 가 있다' })
    const noReply = fixturePane('n', 'claude', { digest: { ...all, activity: { state: 'unknown-format' } } })
    expect(previewOf({ pane: noReply, dot: 'idle', place })).toEqual({ kind: 'prompt', text: '내 지시' })
    const toolOnly = fixturePane('t', 'claude', { digest: { tool: all.tool } })
    expect(previewOf({ pane: toolOnly, dot: 'idle', place })).toEqual({ kind: 'tool', text: 'Read · src/a.ts' })
  })
})

describe('R4-A1 경로 가림 — 한 규칙(디코딩 → 모든 위치 → 뒤 경계만) · 리뷰 r1~r4 사례 한 표 · 불변식', () => {
  const place = { worktree: '/Users/me/repos/app', home: '/Users/me' }
  // [입력, 기대, 출처]. 과잉 가림(앞 글자가 붙은 홈)은 허용 — 계약은 「결과에 홈 절대경로가 남지 않는다」 하나다.
  const cases: [string, string, string][] = [
    // r1 — 기본
    ['Read · /Users/me/.ssh/config', 'Read · ~/.ssh/config', 'r1'],
    ['cat /Users/me', 'cat ~', 'r1'],
    ['Read · "/Users/me/a b.txt"', 'Read · "~/a b.txt"', 'r1 따옴표'],
    // r2 — 대입·콜론·쉼표·셸 연결·괄호·따옴표·문장 끝
    ['PATH=/Users/me/.local/bin', 'PATH=~/.local/bin', 'r2 ='],
    ['Read:/Users/me/private/a.ts', 'Read:~/private/a.ts', 'r2 :'],
    ['cp /Users/me/a,/Users/me/b', 'cp ~/a,~/b', 'r2 쉼표'],
    ['/Users/me: error', '~: error', 'r2'],
    ['PATH=/Users/me/bin:/Users/me/.cargo/bin:/usr/bin', 'PATH=~/bin:~/.cargo/bin:/usr/bin', 'r2 콜론 목록'],
    ['--out=/Users/me/x;ls /Users/me', '--out=~/x;ls ~', 'r2 ;'],
    ['cat /Users/me/a|grep x>/Users/me/b', 'cat ~/a|grep x>~/b', 'r2 셸'],
    ['(see /Users/me/notes)', '(see ~/notes)', 'r2 괄호'],
    ["'/Users/me/a b.txt' `/Users/me/x`", "'~/a b.txt' `~/x`", 'r2 따옴표'],
    ['홈은 /Users/me.', '홈은 ~.', 'r2 문장 끝'],
    ['diff /Users/me/repos/app/a.ts,/Users/me/repos/app/b.ts', 'diff a.ts,b.ts', 'r2 worktree'],
    ['cd /Users/me/repos/app && ls', 'cd . && ls', 'r2 worktree 자신'],
    ['/Users/me/repos/app-other/x', '~/repos/app-other/x', 'r2 비슷한 worktree'],
    // r3 — URI authority·query·fragment·탭·줄바꿈·여러 홈
    ['file:///Users/me/private/a.ts', 'file://~/private/a.ts', 'r3 file:///'],
    ['file://localhost/Users/me/private/a.ts', 'file://localhost~/private/a.ts', 'r3 authority'],
    ['Open vscode://file/Users/me/private/b.ts:5:2', 'Open vscode://file~/private/b.ts:5:2', 'r3 줄:열'],
    ['file:///Users/me?x=1', 'file://~?x=1', 'r3 query'],
    ['file:///Users/me#section', 'file://~#section', 'r3 fragment'],
    ['https://h.example/open?path=/Users/me/a#/Users/me/b', 'https://h.example/open?path=~/a#~/b', 'r3 query·fragment 안'],
    ['vscode://file/Users/me/repos/app/src/x.ts:5:2', 'vscode://filesrc/x.ts:5:2', 'r3 uri worktree(과잉)'],
    ['a\t/Users/me/x\n/Users/me/y', 'a\t~/x\n~/y', 'r3 탭·줄바꿈'],
    ['/Users/me /Users/me/a /Users/me/b /Users/me', '~ ~/a ~/b ~', 'r3 홈 여럿'],
    ['Delete /Users/me? /Users/me! [/Users/me/a] {/Users/me/b} </Users/me/c>', 'Delete ~? ~! [~/a] {~/b} <~/c>', 'r3 구분자'],
    ['/Users/me에서 찾았다', '~에서 찾았다', 'r3 한글 조사'],
    ['scp host:/Users/me/a me@x:/Users/me/b', 'scp host:~/a me@x:~/b', 'r3 scp'],
    ['open?p=%2FUsers%2Fme%2Fprivate%2Fa.ts', 'open?p=~/private/a.ts', 'r3 퍼센트'],
    ['open?p=%2fUsers%2fme', 'open?p=~', 'r3 퍼센트 소문자'],
    ['file:///Users/John%20Smith/a.ts', 'file:///Users/John Smith/a.ts', 'r3 다른 홈(공백) 디코딩만'],
    // r4 — 부분·혼합 퍼센트 인코딩 · 앞 글자 붙은 홈 · 혼합 스킴
    ['file://localhost/Users/%6De/private/a.ts', 'file://localhost~/private/a.ts', 'r4 한 글자 인코딩'],
    ['file://localhost/%55sers/me/private/a.ts', 'file://localhost~/private/a.ts', 'r4 첫 글자 인코딩'],
    ['file://localhost/Users%2Fme/private/a.ts', 'file://localhost~/private/a.ts', 'r4 구분자만 인코딩'],
    ['%2FUsers/me/private/a.ts', '~/private/a.ts', 'r4 앞 / 만 인코딩'],
    ['/Users%2Fme/private/a.ts', '~/private/a.ts', 'r4 중간 / 만'],
    ['file%3A%2F%2F%2FUsers%2Fme%2Fprivate%2Fa.ts', 'file://~/private/a.ts', 'r4 전체 인코딩 URI'],
    ['p=%252FUsers%252Fme%252Fa', 'p=~/a', 'r4 이중 인코딩'],
    ['%FF%2FUsers%2Fme', '%FF~', 'r4 UTF-8 아닌 덩어리 안 ASCII'],
    ['cc -I/Users/me/include -L/Users/me/lib', 'cc -I~/include -L~/lib', 'r4 -I/-L'],
    ['//Users/me/private/a.ts', '/~/private/a.ts', 'r4 //'],
    ['file://localhost//Users/me/private/a.ts', 'file://localhost/~/private/a.ts', 'r4 authority //'],
    ['FiLe:///Users/me/a VsCoDe://file/Users/me/b', 'FiLe://~/a VsCoDe://file~/b', 'r4 혼합 스킴'],
    ['x/Users/me/a ./Users/me /opt/Users/me/b', 'x~/a .~ /opt~/b', 'r4 앞 글자 무관(과잉 가림 허용)'],
    // 그대로 — 이미 축약 · 비슷한 다른 홈(양성 대조) · 홈 밖 · Windows(범위 밖)
    ['~/already/x ~', '~/already/x ~', '이미 ~'],
    ['/Users/meow/x /Users/me2/y /Users/me-old/w /Users/me_x', '/Users/meow/x /Users/me2/y /Users/me-old/w /Users/me_x', '비슷한 다른 홈'],
    ['/Users/me.bak/z 홈은 /Users/me.file:///Users/me/a', '~.bak/z 홈은 ~.file://~/a', '점은 경계(과잉 가림)'],
    ['p=%2FUsers%2Fmeow', 'p=/Users/meow', '비슷한 다른 홈(인코딩)'],
    ['/tmp/x /opt/me', '/tmp/x /opt/me', '홈 밖'],
    ['C:\\Users\\me\\a', 'C:\\Users\\me\\a', '범위 밖 Windows'],
  ]
  for (const [input, expected, kind] of cases) {
    it(`${kind}: ${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(maskPaths({ text: input, ...place })).toBe(expected)
    })
  }

  it('percentDecode — 유효한 %XX 만, 고정점까지, 깨진 %는 그대로', () => {
    expect(percentDecode('a%20b%2')).toBe('a b%2')
    expect(percentDecode('%25%32%46')).toBe('/')
    expect(percentDecode('100%zz')).toBe('100%zz')
  })

  /**
   * 독립 디코더(R5-A1 리뷰 지적 — 검출기가 제품 `percentDecode` 를 쓰면 제품과 같은 횟수에서 같이 멈춘다). 횟수 상한 없이 고정점까지 푼다.
   */
  const oracleDecode = (text: string): string => {
    let out = text
    for (;;) {
      const next = out.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
        try {
          return decodeURIComponent(run)
        } catch {
          return run.replace(/%([0-7][0-9A-Fa-f])/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
        }
      })
      if (next === out) return out
      out = next
    }
  }

  /** 결과를 끝까지 디코딩한 글에 홈 경로(홈 + 끝·이름에 이어질 수 없는 글자)가 있나. 이름 글자가 이어지면 다른 이름이다(`/Users/me-I` 등). */
  const leaks = (output: string, home: string) => new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`).test(oracleDecode(output))

  it('불변식 — 무작위·조합 생성 입력 3000개에서 결과에 홈 절대경로(어느 인코딩으로도) 0', () => {
    let seed = 580
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const pick = (items: readonly string[]): string => items[Math.floor(rand() * items.length)] ?? ''
    const hex = (ch: string) => {
      const code = ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
      return rand() < 0.5 ? `%${code}` : `%${code.toLowerCase()}`
    }
    /** 홈 경로를 글자마다 확률적으로 인코딩(가끔 이중). */
    const encode = (text: string) =>
      [...text]
        .map((ch) => {
          const r = rand()
          if (r < 0.25) return hex(ch)
          if (r < 0.3) return hex(ch).replace('%', '%25')
          // R5-A1 — 깊은 중첩(2~32중). 9중 이상은 글 전체가 `…` 로 가려져야 한다.
          if (r < 0.33) return hex(ch).replace('%', `%${'25'.repeat(1 + Math.floor(rand() * 31))}`)
          return ch
        })
        .join('')
    const BEFORE = ['', ' ', 'x', '-I', '-L', '/', '//', 'file://', 'file://localhost', 'vscode://file', 'FiLe://', '"', "'", '`', '(', '[', '{', '<', '=', ':', ',', ';', '|', '&', '\t', '\n', '?p=', '#', '%FF', '경로', '/opt', '.']
    const AFTER = ['', '/', '/a.ts', '/a b.ts', '?x=1', '#s', ':5:2', '.', ')', ']', '"', ',', ' ', '\t', '\n', '에서', '%2Fa', '%2fa', '!', '?', '/./x', '//y']
    for (const placeCase of [place, { worktree: null, home: '/Users/me' }, { worktree: '/fx/corral/.wt/w', home: '/fx/home' }]) {
      const home = placeCase.home
      const roots = [home, ...(placeCase.worktree === null ? [] : [placeCase.worktree, `${placeCase.worktree}/src`])]
      for (let i = 0; i < 1_000; i += 1) {
        const pieces = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => `${pick(BEFORE)}${encode(pick(roots))}${pick(AFTER)}`)
        const input = pieces.join(pick(['', ' ', ',', ':', '\n']))
        const output = maskPaths({ text: input, ...placeCase })
        if (leaks(output, home)) throw new Error(`홈이 남음: ${JSON.stringify(input)} → ${JSON.stringify(output)}`)
      }
    }
  })

  it('양성 대조 — 같은 검사기가 가리지 않은 입력에서는 잡는다', () => {
    // 가림이 실제로 일어난 행(디코딩만 한 글과 결과가 다름)
    const changed = cases.filter(([input, expected]) => percentDecode(input) !== expected)
    expect(changed.length).toBeGreaterThan(40)
    for (const [input] of changed) expect(leaks(input, '/Users/me')).toBe(true)
    expect(leaks('file://localhost/Users/%6De/a', '/Users/me')).toBe(true)
  })

  const r4Payload = (home: string) =>
    buildMobileList({
      state: {
        ...listFixture({
          p5: { digest: { providerTitle: '목록 행 구현', tool: { name: 'Read', input: 'file://localhost/fx/%68ome/private/a.ts' } } },
          p6: { digest: { firstPrompt: '재연결 정책 조사', lastPrompt: 'Open file://localhost/fx%2Fhome/private/b.ts', lastActivityAt: FIXTURE_NOW } },
          p20: { digest: { providerTitle: '알림 모듈 리팩터', tool: { name: 'Bash', input: 'cc -I/fx/home/include PATH=/fx/home/.local/bin cp /fx/home/a,/fx/home/b' } } },
        }),
        home,
      },
      prefs: null,
      now: FIXTURE_NOW,
    })

  it('실제 buildMobileList 페이로드 — 부분 인코딩·-I·이어진 경로에서도 홈 절대경로 0', () => {
    const list = r4Payload('/fx/home')
    expect(byTitle(list, '목록 행 구현').preview).toEqual({ kind: 'tool', text: 'Read · file://localhost~/private/a.ts' })
    expect(byTitle(list, '재연결 정책 조사').preview).toEqual({ kind: 'prompt', text: 'Open file://localhost~/private/b.ts' })
    expect(byTitle(list, '알림 모듈 리팩터').preview).toEqual({ kind: 'approval', text: 'Bash · cc -I~/include PATH=~/.local/bin cp ~/a,~/b' })
    expect(percentDecode(JSON.stringify(list))).not.toContain('/fx/home')
  })

  it('음성 대조 — 같은 페이로드를 홈 없이(home "") 만들면 홈이 남는다(시험이 그 글을 실제로 본다)', () => {
    const wire = percentDecode(JSON.stringify(r4Payload('')))
    expect(wire).toContain('localhost/fx/home/private/a.ts')
    expect(wire).toContain('-I/fx/home/include')
  })
})

describe('R5-A1 깊은 중첩 퍼센트 인코딩 — 8중까지는 기존 가림, 9중 이상은 글 전체 `…`(fail-closed)', () => {
  const place = { worktree: '/Users/me/repos/app', home: '/Users/me' }
  /** 글자 하나를 n 중 인코딩 — `%6D` → `%256D` → `%25256D` … */
  const deep = (ch: string, n: number) => `%${'25'.repeat(n - 1)}${ch.charCodeAt(0).toString(16).toUpperCase()}`
  const oracle = (text: string): string => {
    let out = text
    for (;;) {
      const next = out.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => decodeURIComponent(run))
      if (next === out) return out
      out = next
    }
  }

  for (let n = 1; n <= 8; n += 1) {
    it(`${n}중 — 고정점에 닿아 기존과 같이 가린다`, () => {
      expect(maskPaths({ text: `file://localhost/Users/${deep('m', n)}e/private/a.ts`, ...place })).toBe('file://localhost~/private/a.ts')
      expect(maskPaths({ text: `cat ${deep('/', n)}Users/me/x`, ...place })).toBe('cat ~/x')
    })
  }

  it('9~32중 — 글 전체를 `…` 로 · 결과에 홈 경로·그 인코딩 형태 0(독립 디코더로 끝까지 풀어도)', () => {
    for (let n = 9; n <= 32; n += 1) {
      for (const text of [`file://localhost/Users/${deep('m', n)}e/private/a.ts`, `cat ${deep('/', n)}Users/me/x`, `Read · /${deep('U', n)}sers/me`]) {
        const out = maskPaths({ text, ...place })
        expect(out).toBe(MASKED_UNDECODABLE)
        expect(oracle(out)).not.toContain('/Users/me')
        // 양성 대조 — 같은 입력을 끝까지 풀면 홈이 있다
        expect(oracle(text)).toContain('/Users/me')
      }
    }
  })

  it('9중 이상이지만 홈이 없는 글도 가린다(남은 인코딩 안을 볼 수 없다) · 홈 없이(home "") 만들면 가리지 않는다', () => {
    expect(maskPaths({ text: `x ${deep('a', 12)}`, ...place })).toBe(MASKED_UNDECODABLE)
    expect(maskPaths({ text: `x ${deep('a', 12)}`, worktree: null, home: '' })).not.toBe(MASKED_UNDECODABLE)
  })

  const payload = (home: string) =>
    buildMobileList({
      state: { ...listFixture({ p5: { digest: { providerTitle: 'safe title', tool: { name: 'Read', input: 'file://localhost/fx/%252525252525252568ome/private/a.ts' } } } }), home },
      prefs: null,
      now: FIXTURE_NOW,
    })

  it('리뷰어 사례(h 9중) — 실제 buildMobileList 미리보기가 `…` · 전송 JSON 을 끝까지 풀어도 `/fx/home` 0', () => {
    const list = payload('/fx/home')
    expect(byTitle(list, 'safe title').preview).toEqual({ kind: 'tool', text: MASKED_UNDECODABLE })
    expect(oracle(JSON.stringify(list))).not.toContain('/fx/home')
  })

  it('음성 대조 — 홈 없이 만들면 같은 입력이 인코딩된 홈을 싣는다', () => {
    expect(oracle(JSON.stringify(payload('')))).toContain('/fx/home/private/a.ts')
  })
})
