// LIFE-601 작업 페이지 순수 로직 — C2(스페이스 목록·첫 진입) · C3(영속 모양) · C5(빈 상태 원인) · C6(보드 칸·점선 칸·막힘 배지)
// · C7(늦은 응답 폐기·끌기 의도·낙관적 반영) · C9(정렬·그룹·프리셋) · C10(키 검색·필터) · C11(브랜치 키 감지).
import { describe, expect, it } from 'vitest'
import type { WorkConnectionSummary, WorkItem, WorkSettingsState, WorkStatus } from '../../shared/work.js'
import {
  DEFAULT_TASKS_PREFS,
  LatestGate,
  NO_FILTERS,
  activePreset,
  applyIntent,
  applyPreset,
  blockedLabel,
  boardBands,
  boardDropIntent,
  branchKey,
  detectWorking,
  dueTone,
  emptyCause,
  groupRows,
  imeComposing,
  initialSpace,
  passesFilters,
  passesText,
  readTasksPrefs,
  rowsOf,
  searchKey,
  sortRows,
  spaceGroups,
  viewsFor,
  writeBlock,
  type SpaceData,
} from './tasks-model.js'

const status = (key: string, category: WorkStatus['category'], order: number): WorkStatus => ({ key, label: key.toUpperCase(), category, order, color: null })
const STATUSES = [status('todo', 'todo', 0), status('doing', 'in_progress', 1), status('review', 'in_progress', 2), status('done', 'done', 3)]

const item = (over: Partial<WorkItem> & { id: string }): WorkItem => ({
  key: over.id.toUpperCase(), spaceKey: 'S', title: `title ${over.id}`, body: null, kind: { key: 'task', label: 'Task' }, statusKey: 'todo', category: 'todo',
  priority: 'medium', dueAt: null, parentId: null, placement: 'board', rank: null, openBlockerCount: 0, openBlockers: [], updatedAt: '', version: null, relations: null, workLinks: [],
  ...over,
})

const space = (items: WorkItem[]): SpaceData => ({ connectionId: 'c1', spaceKey: 'S', spaceName: 'Space', colorIndex: 1, color: null, statuses: STATUSES, kinds: [], items, nextCursor: null, truncated: false })

const connection = (over: Partial<WorkConnectionSummary> & { id: string }): WorkConnectionSummary => ({
  sourceId: 'la', name: 'LA', mono: 'LA', tokenTail: 'abcd', addedAt: 0, generation: 1, status: 'ok', pending: null, error: null, checkedAt: null,
  spaces: [], hiddenSpaceKeys: [], capabilities: null, ...over,
})

describe('C2 스페이스 목록', () => {
  const settings: WorkSettingsState = {
    sources: [],
    connections: [
      connection({ id: 'c1', tokenTail: '1111', spaces: [{ key: 'p1', name: 'corral', color: '#c7b28a', openCount: 3, hidden: false }, { key: 'p2', name: '숨김', color: null, openCount: 1, hidden: true }] }),
      connection({ id: 'c2', tokenTail: '2222', spaces: [{ key: 'q1', name: 'other', color: null, openCount: null, hidden: false }], hiddenSpaceKeys: [] }),
      connection({ id: 'c3', sourceId: 'mock', name: 'Mock', mono: 'MJ', spaces: null }),
    ],
    repoDefaults: [{ repoRoot: '/r/corral', connectionId: 'c1', spaceKey: 'p1' }],
  }

  it('같은 출처 연결 둘이면 머리 sub 에 끝 4자 · 숨긴 스페이스 제외 · 레포 기본 칩 · 색 없으면 --space-N 순서', () => {
    const groups = spaceGroups({ settings, repoRoot: '/r/corral' })
    expect(groups.map((group) => group.sub)).toEqual(['토큰 …1111', '토큰 …2222', 'MJ'])
    expect(groups[0]?.rows.map((row) => row.key)).toEqual(['p1'])
    expect(groups[0]?.rows[0]?.repoDefault).toBe(true)
    expect(groups[1]?.rows[0]).toMatchObject({ key: 'q1', color: null, colorIndex: 2, repoDefault: false })
  })

  it('첫 진입 = 활성 worktree 레포 기본 → 마지막으로 본 것 → 첫 스페이스', () => {
    const groups = spaceGroups({ settings, repoRoot: '/r/corral' })
    expect(initialSpace({ groups, settings, repoRoot: '/r/corral', last: { kind: 'space', connectionId: 'c2', spaceKey: 'q1' } })).toEqual({ kind: 'space', connectionId: 'c1', spaceKey: 'p1' })
    expect(initialSpace({ groups, settings, repoRoot: '/r/else', last: { kind: 'space', connectionId: 'c2', spaceKey: 'q1' } })).toEqual({ kind: 'space', connectionId: 'c2', spaceKey: 'q1' })
    expect(initialSpace({ groups, settings, repoRoot: null, last: { kind: 'all' } })).toEqual({ kind: 'all' })
    // 숨긴 스페이스는 마지막으로 봤어도 고르지 않는다.
    expect(initialSpace({ groups, settings, repoRoot: null, last: { kind: 'space', connectionId: 'c1', spaceKey: 'p2' } })).toEqual({ kind: 'space', connectionId: 'c1', spaceKey: 'p1' })
    // 스페이스 목록을 아직 못 받은 연결의 마지막 스페이스는 지우지 않는다.
    expect(initialSpace({ groups, settings, repoRoot: null, last: { kind: 'space', connectionId: 'c3', spaceKey: 'CORE' } })).toEqual({ kind: 'space', connectionId: 'c3', spaceKey: 'CORE' })
  })
})

describe('C3 영속 모양', () => {
  it('저장된 값을 칸마다 읽고 손상된 칸만 기본값', () => {
    const stored = { space: { kind: 'space', connectionId: 'c1', spaceKey: 'p1' }, view: 'list', filters: { kinds: ['bug', 3], priorities: ['high', 'nope'], blocked: true, working: 'x', dueWeek: true }, sort: 'due', group: 'bogus', density: 'compact', defaultPreset: 'week' }
    expect(readTasksPrefs(stored)).toEqual({
      space: { kind: 'space', connectionId: 'c1', spaceKey: 'p1' }, view: 'list',
      filters: { kinds: ['bug'], priorities: ['high'], blocked: true, working: false, dueWeek: true },
      sort: 'due', group: 'status', density: 'compact', defaultPreset: 'week',
    })
    expect(readTasksPrefs(undefined)).toEqual(DEFAULT_TASKS_PREFS)
    expect(readTasksPrefs({ space: { kind: 'space', connectionId: '' } }).space).toBeNull()
  })

  it('쓰고 읽으면 같다(재시작 왕복)', () => {
    const prefs = { ...DEFAULT_TASKS_PREFS, space: { kind: 'all' as const }, view: 'backlog' as const, sort: 'key' as const, group: 'none' as const, density: 'compact' as const, defaultPreset: 'blocked' as const, filters: { ...NO_FILTERS, working: true } }
    expect(readTasksPrefs(JSON.parse(JSON.stringify(prefs)))).toEqual(prefs)
  })
})

describe('C6 보드', () => {
  it('상태마다 칸(워크플로 순서) · 분류 밴드 · 상태 목록에 없는 상태는 마지막 점선 칸', () => {
    const rows = rowsOf([space([item({ id: 'a', statusKey: 'doing', category: 'in_progress' }), item({ id: 'b', statusKey: 'legal' }), item({ id: 'c' })])])
    const bands = boardBands({ rows, statuses: STATUSES, all: false })
    expect(bands.map((band) => band.category)).toEqual(['todo', 'in_progress', 'done'])
    expect(bands[1]?.columns.map((column) => column.id)).toEqual(['st:doing', 'st:review'])
    const last = bands[2]?.columns.at(-1)
    expect(last).toMatchObject({ id: 'st:__unmapped', unmapped: true })
    expect(last?.rows.map((row) => row.item.id)).toEqual(['b'])
    expect(bands.reduce((sum, band) => sum + band.count, 0)).toBe(3)
  })

  it('「전체」 = 분류 3칸', () => {
    const rows = rowsOf([space([item({ id: 'a', statusKey: 'doing', category: 'in_progress' }), item({ id: 'b', statusKey: 'done', category: 'done' })])])
    const bands = boardBands({ rows, statuses: [], all: true })
    expect(bands.map((band) => band.columns[0]?.id)).toEqual(['cat:todo', 'cat:in_progress', 'cat:done'])
    expect(bands[1]?.columns[0]?.rows.map((row) => row.item.id)).toEqual(['a'])
  })

  it('막힘 배지 — 「막힘 · KEY (외 N)」, 열린 막은 쪽 없으면 없음', () => {
    expect(blockedLabel(item({ id: 'a' }))).toBeNull()
    expect(blockedLabel(item({ id: 'a', openBlockerCount: 1, openBlockers: [{ id: 'x', key: 'LIFE-1', title: 't' }] }))).toBe('막힘 · LIFE-1')
    expect(blockedLabel(item({ id: 'a', openBlockerCount: 3, openBlockers: [{ id: 'x', key: 'LIFE-1', title: 't' }, { id: 'y', key: 'LIFE-2', title: 't' }, { id: 'z', key: 'LIFE-3', title: 't' }] }))).toBe('막힘 · LIFE-1 (외 2)')
  })

  it('마감 색 — 지남 · 2일 안만', () => {
    const now = Date.parse('2026-10-13T00:00:00Z')
    expect(dueTone({ dueAt: '2026-10-12T00:00:00Z', now })).toBe('over')
    expect(dueTone({ dueAt: '2026-10-14T00:00:00Z', now })).toBe('soon')
    expect(dueTone({ dueAt: '2026-10-20T00:00:00Z', now })).toBe('normal')
    expect(dueTone({ dueAt: null, now })).toBeNull()
  })
})

describe('C7 끌기·늦은 응답', () => {
  it('늦은 응답 폐기 — 같은 열쇠에 뒤 요청이 나가면 앞 응답은 받지 않는다(순서를 뒤집어도)', () => {
    const gate = new LatestGate()
    const first = gate.issue('item:c1:a')
    const second = gate.issue('item:c1:a')
    // 뒤 요청의 응답이 먼저 오고, 앞 요청의 응답이 늦게 온다.
    expect(gate.accepts({ key: 'item:c1:a', requestId: second })).toBe(true)
    expect(gate.accepts({ key: 'item:c1:a', requestId: first })).toBe(false)
    // 다른 작업은 서로 막지 않는다.
    const other = gate.issue('item:c1:b')
    expect(gate.accepts({ key: 'item:c1:b', requestId: other })).toBe(true)
    expect(gate.accepts({ key: 'item:c1:a', requestId: second })).toBe(true)
    gate.invalidate('item:c1:a')
    expect(gate.accepts({ key: 'item:c1:a', requestId: second })).toBe(false)
  })

  it('보드 놓기 → 다른 칸 = 상태 변경 · 같은 칸 = 순서 · 점선 칸 = 없음 · 「전체」 분류 칸 = 그 분류 첫 상태', () => {
    const rows = rowsOf([space([item({ id: 'a' })])])
    const row = rows[0]
    if (row === undefined) throw new Error('row')
    const bands = boardBands({ rows, statuses: STATUSES, all: false })
    const columns = bands.flatMap((band) => band.columns)
    const doing = columns.find((column) => column.id === 'st:doing')
    const todo = columns.find((column) => column.id === 'st:todo')
    if (doing === undefined || todo === undefined) throw new Error('columns')
    expect(boardDropIntent({ row, column: doing, afterId: null, statusesOf: () => STATUSES })).toEqual({ kind: 'status', statusKey: 'doing' })
    expect(boardDropIntent({ row, column: todo, afterId: 'z', statusesOf: () => STATUSES })).toEqual({ kind: 'reorder', afterId: 'z' })
    expect(boardDropIntent({ row, column: { ...todo, id: 'st:__unmapped', unmapped: true, statusKey: null }, afterId: null, statusesOf: () => STATUSES })).toEqual({ kind: 'none' })
    const all = boardBands({ rows, statuses: [], all: true }).flatMap((band) => band.columns)
    const doingCat = all.find((column) => column.id === 'cat:in_progress')
    if (doingCat === undefined) throw new Error('cat')
    expect(boardDropIntent({ row, column: doingCat, afterId: null, statusesOf: () => STATUSES })).toEqual({ kind: 'status', statusKey: 'doing' })
  })

  it('낙관적 반영 — 상태는 분류까지, 순서는 afterId 바로 뒤, 배치는 그 작업만', () => {
    const items = [item({ id: 'a', rank: '1' }), item({ id: 'b', rank: '2' }), item({ id: 'c', rank: '3' })]
    const moved = applyIntent({ items, itemId: 'a', intent: { kind: 'status', statusKey: 'done' }, statuses: STATUSES })
    expect(moved[0]).toMatchObject({ statusKey: 'done', category: 'done' })
    const reordered = applyIntent({ items, itemId: 'a', intent: { kind: 'reorder', afterId: 'c' }, statuses: STATUSES })
    expect(rowsOf([space(reordered)]).sort((x, y) => (x.item.rank ?? '').localeCompare(y.item.rank ?? '')).map((row) => row.item.id)).toEqual(['b', 'c', 'a'])
    const top = applyIntent({ items, itemId: 'c', intent: { kind: 'reorder', afterId: null }, statuses: STATUSES })
    expect([...top].sort((x, y) => (x.rank ?? '').localeCompare(y.rank ?? '')).map((entry) => entry.id)).toEqual(['c', 'a', 'b'])
    const placed = applyIntent({ items, itemId: 'b', intent: { kind: 'placement', placement: 'backlog' }, statuses: STATUSES })
    expect(placed.map((entry) => entry.placement)).toEqual(['board', 'backlog', 'board'])
  })

  it('쓰기 손잡이 — 권한 부족·끊김·인증은 흐림 + 이유, 연결됨은 없음', () => {
    expect(writeBlock('forbidden')?.reason).toContain('권한')
    expect(writeBlock('offline')?.reason).toContain('닿지')
    expect(writeBlock('ok')).toBeNull()
  })

  it('배치 능력 hidden 이면 백로그 보기가 없다', () => {
    const base = { transition: { mode: 'any' as const }, relations: { state: 'on' as const }, parentChange: { state: 'on' as const }, order: { state: 'on' as const }, cursorPaging: { state: 'on' as const }, conflictCheck: { state: 'on' as const }, comments: { state: 'on' as const }, workLinkStore: { state: 'on' as const } }
    expect(viewsFor([{ ...base, placement: { state: 'hidden' } }])).toEqual(['board', 'list', 'working'])
    expect(viewsFor([{ ...base, placement: { state: 'disabled', reason: 'x' } }])).toContain('backlog')
  })
})

describe('C9 리스트', () => {
  const rows = rowsOf([space([
    item({ id: 'a', key: 'K-10', priority: 'low', dueAt: '2026-10-20T00:00:00Z', rank: '3' }),
    item({ id: 'b', key: 'K-2', priority: 'highest', dueAt: null, rank: '1', statusKey: 'doing', category: 'in_progress' }),
    item({ id: 'c', key: 'K-3', priority: null, dueAt: '2026-10-14T00:00:00Z', rank: '2', statusKey: 'legal' }),
  ])])
  it('정렬 4종', () => {
    expect(sortRows({ rows, sort: 'rank' }).map((row) => row.item.id)).toEqual(['b', 'c', 'a'])
    expect(sortRows({ rows, sort: 'priority' }).map((row) => row.item.id)).toEqual(['b', 'a', 'c'])
    expect(sortRows({ rows, sort: 'due' }).map((row) => row.item.id)).toEqual(['c', 'a', 'b'])
    expect(sortRows({ rows, sort: 'key' }).map((row) => row.item.key)).toEqual(['K-2', 'K-3', 'K-10'])
  })
  it('그룹 — 받아 둔 행 기준, 빈 그룹 없음, 칸 없는 상태도 그룹', () => {
    expect(groupRows({ rows, group: 'status', statuses: STATUSES, all: false }).map((group) => [group.id, group.rows.length])).toEqual([['st:todo', 1], ['st:doing', 1], ['st:__unmapped', 1]])
    expect(groupRows({ rows, group: 'priority', statuses: STATUSES, all: false }).map((group) => group.id)).toEqual(['prio:highest', 'prio:low', 'prio:none'])
    expect(groupRows({ rows, group: 'none', statuses: STATUSES, all: false })).toHaveLength(1)
  })
  it('프리셋 → 필터, 지금 필터가 어느 프리셋인지', () => {
    expect(applyPreset({ preset: 'week', sort: 'rank' })).toEqual({ filters: { ...NO_FILTERS, dueWeek: true }, sort: 'due' })
    expect(activePreset(applyPreset({ preset: 'blocked', sort: 'rank' }).filters)).toBe('blocked')
    expect(activePreset({ ...NO_FILTERS, kinds: ['bug'] })).toBeNull()
  })
})

describe('C10 검색·필터', () => {
  it('키 모양은 출처가 준 패턴으로만 — 대소문자 무시, 모양 밖은 텍스트', () => {
    expect(searchKey({ query: ' life-601 ', pattern: 'LIFE-\\d+' })).toBe('LIFE-601')
    expect(searchKey({ query: 'life 601', pattern: 'LIFE-\\d+' })).toBeNull()
    expect(searchKey({ query: 'LIFE-601', pattern: null })).toBeNull()
    expect(searchKey({ query: 'x', pattern: '(' })).toBeNull()
  })
  it('필터 칩 4 + 텍스트', () => {
    const now = Date.parse('2026-10-13T00:00:00Z')
    const [row] = rowsOf([space([item({ id: 'a', key: 'LIFE-1', kind: { key: 'bug', label: 'Bug' }, priority: 'high', openBlockerCount: 1, dueAt: '2026-10-15T00:00:00Z' })])])
    if (row === undefined) throw new Error('row')
    const working = new Set(['LIFE-1'])
    expect(passesFilters({ row, filters: { ...NO_FILTERS, kinds: ['bug'], priorities: ['high'], blocked: true, working: true, dueWeek: true }, workingKeys: working, now })).toBe(true)
    expect(passesFilters({ row, filters: { ...NO_FILTERS, kinds: ['task'] }, workingKeys: working, now })).toBe(false)
    expect(passesFilters({ row, filters: { ...NO_FILTERS, working: true }, workingKeys: new Set(), now })).toBe(false)
    expect(passesText({ row, query: 'TITLE A' })).toBe(true)
    expect(passesText({ row, query: 'life-1' })).toBe(true)
    expect(passesText({ row, query: 'nothing' })).toBe(false)
  })
})

describe('C5 빈 상태 원인', () => {
  it('비어 있음 · 검색 · 필터 · 작업 중', () => {
    expect(emptyCause({ total: 0, afterFilter: 0, query: '', view: 'board' })).toBe('space')
    expect(emptyCause({ total: 5, afterFilter: 5, query: 'zz', view: 'list' })).toBe('search')
    expect(emptyCause({ total: 5, afterFilter: 0, query: '', view: 'board' })).toBe('filter')
    expect(emptyCause({ total: 5, afterFilter: 0, query: '', view: 'working' })).toBe('working')
  })
})

describe('C4·C11', () => {
  it('IME 조합 중 키', () => {
    expect(imeComposing({ isComposing: true, keyCode: 27 })).toBe(true)
    expect(imeComposing({ isComposing: false, keyCode: 229 })).toBe(true)
    expect(imeComposing({ isComposing: false, keyCode: 27 })).toBe(false)
  })
  it('브랜치 이름의 키 — 출처 패턴으로만, 연결마다', () => {
    expect(branchKey({ branch: 'LIFE-601-tasks-page-claude', pattern: 'LIFE-\\d+' })).toBe('LIFE-601')
    expect(branchKey({ branch: 'feature/LIFE-372-la-issue-link', pattern: 'LIFE-\\d+' })).toBe('LIFE-372')
    expect(branchKey({ branch: 'xLIFE-601', pattern: 'LIFE-\\d+' })).toBeNull()
    expect(branchKey({ branch: 'main', pattern: 'LIFE-\\d+' })).toBeNull()
    const trees = [
      { path: '/w/a', repoRoot: '/r', repoName: 'r', branch: 'LIFE-601-x', dot: null },
      { path: '/w/b', repoRoot: '/r', repoName: 'r', branch: 'LIFE-601-y', dot: 'working' as const },
      { path: '/w/c', repoRoot: '/r', repoName: 'r', branch: 'CORE-2-z', dot: null },
    ]
    const entries = detectWorking({ trees, patterns: [{ connectionId: 'la', pattern: 'LIFE-\\d+' }, { connectionId: 'mock', pattern: null }] })
    expect(entries).toEqual([{ key: 'LIFE-601', connectionId: 'la', trees: [trees[0], trees[1]] }])
  })
})
