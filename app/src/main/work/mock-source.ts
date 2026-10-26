// 모의 작업 출처 — Jira 형 (LIFE-600 킥오프 4 · C2). 계약 테스트 묶음이 LA 와 **같은 묶음**으로 이것을 돌린다.
// Jira 를 닮은 점: 스페이스마다 다른 상태 목록 · 허용 전이만(`transition: allowed`) · 순서(rank) 있음 · 코멘트 있음 · 커서 페이지 ·
// 조건부 수정(`ifVersion` → 저장 충돌). 작업 링크 저장은 T5 까지 꺼 둔다. 메모리에만 산다 — 앱 레지스트리에는 넣지 않는다.
//
// `defect` 는 양성 대조용(C2): 계약에서 한 곳을 어긋나게 만들어 묶음이 실패하는지 본다. 평시에는 `none`.
//
// LIFE-601 — 격리 앱 실행(`CORRAL_WORK_MOCK=1`, 측정 모드에서만)이 작업 페이지를 그릴 때 이 출처를 쓴다. 토큰 글자로 행동을 고른다
// (가짜 토큰만 — 원문 비밀이 아니다): `fault-auth|fault-forbidden|fault-network` = 목록·상태 요청이 그 오류(배너 양성 대조),
// `delay-<ms>` = 모든 요청을 그만큼 늦춤(불러오기·늦은 응답). 씨앗 `seedMockDemoState` 는 점선 칸(칸 없는 상태)·막힘·자식·빈 스페이스를 갖는다.
// 수정 r1(R1-T) — `reject-writes` = 쓰기(상태·배치·순서)를 출처가 거절(원위치 양성 대조) · `cap-<order|placement|cursorPaging>-<off|hide>` = 그 능력을
// disabled(이유)·hidden 으로 · `transition-any` = 전이 제한 없음(기본은 allowed) — 능력 표만이 아니라 **출처도** 어떤 전이든 받는다(R2-N).
// 응답 순서 뒤집기는 두 갈래로 나눈다(R2-O) — 홀수 번째 요청만 그만큼 늦춘다:
//   `flip-<ms>` = **응답 배달만** 늦춤(출처는 도착 순서대로 곧바로 적용 — 서버 값은 마지막에 보낸 요청)
//   `flipapply-<ms>` = **적용 자체를** 늦춤(늦춘 요청이 나중에 적용 — 서버 값은 먼저 보낸 요청일 수 있다).
//   경합 관문의 기대에는 화면만이 아니라 그 뒤 서버 재조회 값도 넣는다.
//
// LIFE-602 — 계약 확장 E4–E9 를 모의 출처도 한다: 필드 수정(`updateItem`) · 완료 갈래(resolution) · 자식 조회·만들기(종류별 `childKinds`) ·
// 충돌 오류의 현재 값·바꾼 쪽 · 변경 이력(`listHistory`, 쓰기 id 를 메타로 싣는다) · 연결 상대의 스페이스.
// `foreignEdit` = 다른 곳(모의 웹)에서 고친 것처럼 상태를 바꾼다 — 판이 오르고 이력에 쓰기 id 없이 남는다(충돌·중복 제거 양성 대조).
// 격리 실행 토큰 `drift` = 단건을 읽을 때마다(두 번째부터) 모의 웹이 우선순위를 바꾼다 — 저장 충돌 배너 재현용.

import { createFieldsProblem } from '../../shared/work.js'
import type {
  WorkCall,
  WorkCapabilities,
  WorkCreateField,
  WorkCreateMeta,
  WorkCapability,
  WorkComment,
  WorkFieldPatch,
  WorkHistoryEntry,
  WorkHistoryField,
  WorkItem,
  WorkKind,
  WorkLink,
  WorkRelation,
  WorkRelationKind,
  WorkResolution,
  WorkSourceDescriptor,
  WorkSpace,
  WorkStatus,
} from '../../shared/work.js'
import type { WorkErrorKind } from '../../shared/work.js'
import { unknownWriteOutcome, workError } from './errors.js'
import type { WorkCallMeta, WorkOutcome, WorkSourceClient, WorkSourceEntry } from './source.js'

export const MOCK_SOURCE_ID = 'mock-jira'
export const MOCK_TOKEN_PREFIX = 'mock_'

export type MockDefect = 'none' | 'status-category' | 'transition-ignored'

export const MOCK_DESCRIPTOR: WorkSourceDescriptor = {
  id: MOCK_SOURCE_ID,
  name: 'Mock Jira',
  mono: 'MJ',
  addLabel: '+ Mock',
  formTitle: 'Mock 연결',
  accountFields: [],
  tokenLabel: 'Mock 토큰',
  tokenHint: null,
  tokenPrefix: MOCK_TOKEN_PREFIX,
  keyPattern: '[A-Z][A-Z0-9]*-\\d+',
  queryPattern: null,
}

/** 토큰에서 읽는 행동 (LIFE-601) — 격리 실행 전용. 없으면 평시. */
export type MockBehavior = {
  fault: Extract<WorkErrorKind, 'auth' | 'forbidden' | 'network'> | null
  delayMs: number
  rejectWrites: boolean
  /** 응답 순서 뒤집기(R2-O) — 배달만 늦춤(`deliver`) · 적용을 늦춤(`apply`). */
  flip: { mode: 'deliver' | 'apply'; ms: number } | null
  /** 능력 표 덮어쓰기 — 없으면 `MOCK_CAPABILITIES` 그대로. */
  caps: Partial<WorkCapabilities>
  /** 단건을 두 번째 읽을 때부터 모의 웹이 그 작업을 고친다(LIFE-602 — 충돌 배너 재현). */
  drift: boolean
  /**
   * 생성 메타(LIFE-604) — `unsupported` = Epic 에 corral 이 채울 수 없는 모양의 필수 필드를 더함(양성 대조) ·
   * `fail` = 생성 메타 요청을 출처가 거절(메타 실패 → 다시 시도) · `placement-ignored` = 모든 종류에 배치가 적용되지 않음(R3-G — 인라인 배치 가드 시험용) ·
   * `unavailable` = Epic 을 이 스페이스에서 만들 수 없다고 메타가 말함(R4-F — LA 「미분류」 Checkpoint 와 같은 모양).
   */
  createMeta: 'plain' | 'unsupported' | 'fail' | 'placement-ignored' | 'unavailable'
  /** `create-lost`(LIFE-604 R1-A) — 만들기는 적용하고 답을 잃는다(결과를 모르는 실패, `maybeApplied`). */
  createLost: boolean
}

export const PLAIN_BEHAVIOR: MockBehavior = { fault: null, delayMs: 0, rejectWrites: false, flip: null, caps: {}, drift: false, createMeta: 'plain', createLost: false }

function capsOf(token: string): Partial<WorkCapabilities> {
  const caps: Partial<WorkCapabilities> = {}
  for (const match of token.matchAll(/cap-(order|placement|cursorPaging|relations|comments|history|conflictCheck|workLinkStore)-(off|hide)/g)) {
    const capability: WorkCapability = match[2] === 'hide' ? { state: 'hidden' } : { state: 'disabled', reason: `모의 출처가 이 능력을 껐습니다 (cap-${match[1]}-off).` }
    switch (match[1]) {
      case 'order': caps.order = capability; break
      case 'placement': caps.placement = capability; break
      case 'cursorPaging': caps.cursorPaging = capability; break
      case 'relations': caps.relations = capability; break
      case 'comments': caps.comments = capability; break
      case 'history': caps.history = capability; break
      case 'conflictCheck': caps.conflictCheck = capability; break
      case 'workLinkStore': caps.workLinkStore = capability; break
    }
  }
  if (token.includes('transition-any')) caps.transition = { mode: 'any' }
  return caps
}

export function mockBehaviorOf(token: string): MockBehavior {
  const fault = /fault-(auth|forbidden|network)/.exec(token)?.[1]
  const delay = /delay-(\d{1,5})/.exec(token)?.[1]
  const flip = /flip(apply)?-(\d{1,5})/.exec(token)
  return {
    fault: fault === 'auth' || fault === 'forbidden' || fault === 'network' ? fault : null,
    delayMs: delay === undefined ? 0 : Number(delay),
    rejectWrites: token.includes('reject-writes'),
    flip: flip === null ? null : { mode: flip[1] === undefined ? 'deliver' : 'apply', ms: Number(flip[2]) },
    caps: capsOf(token),
    drift: token.includes('drift'),
    createMeta: token.includes('createmeta-unsupported') ? 'unsupported' : token.includes('createmeta-fail') ? 'fail' : token.includes('createmeta-placement-ignored') ? 'placement-ignored'
      : token.includes('createmeta-unavailable') ? 'unavailable' : 'plain',
    createLost: token.includes('create-lost'),
  }
}

const FAULT_MESSAGE: Record<NonNullable<MockBehavior['fault']>, { message: string; status: number | null }> = {
  auth: { message: '인증에 실패했습니다 — 토큰을 다시 붙여넣으세요.', status: 401 },
  forbidden: { message: '이 토큰에는 이 스페이스를 볼 권한이 없습니다.', status: 403 },
  network: { message: '출처에 닿지 못했습니다.', status: null },
}

export const MOCK_CAPABILITIES: WorkCapabilities = {
  transition: { mode: 'allowed' },
  placement: { state: 'on' },
  relations: { state: 'on' },
  parentChange: { state: 'on' },
  order: { state: 'on' },
  cursorPaging: { state: 'on' },
  conflictCheck: { state: 'on' },
  comments: { state: 'on' },
  history: { state: 'on' },
  // LIFE-603 C14 — 모의 출처는 켠다(L1a 가 들어온 출처의 모양). `cap-workLinkStore-off` 토큰이면 끈다.
  workLinkStore: { state: 'on' },
  resolution: { state: 'on' },
  // LIFE-605 — 질의 검색은 Jira 출처만(모의는 숨김, 계약 묶음이 꺼진 쪽을 본다).
  querySearch: { state: 'hidden' },
}

const PAIR: Record<WorkRelationKind, WorkRelationKind> = {
  is_blocked_by: 'blocks',
  blocks: 'is_blocked_by',
  duplicates: 'is_duplicated_by',
  is_duplicated_by: 'duplicates',
  relates_to: 'relates_to',
}

/** Jira 형 — Epic 아래에 Story·Bug, Story·Bug 는 잎(E6). */
const KINDS: WorkKind[] = [{ key: 'epic', label: 'Epic', childKinds: ['story', 'bug'] }, { key: 'story', label: 'Story', childKinds: [] }, { key: 'bug', label: 'Bug', childKinds: [] }]
const KEY_SHAPE = /^[A-Z][A-Z0-9]*-\d+$/i

/**
 * Jira 형 필수 필드(LIFE-604 E11) — Bug 는 「Customer impact」(고르기 하나)가 필수. 목업의 「Customer impact」 흉내.
 * Story·Epic 은 필수 필드 없음. 상태는 워크플로의 첫 상태로만 만든다(Jira 생성은 첫 상태 고정).
 */
export const MOCK_CREATE_FIELDS: Record<string, WorkCreateField[]> = {
  bug: [{ key: 'customfield_impact', label: 'Customer impact', shape: 'option', options: [{ id: 'impact-low', label: 'Low' }, { id: 'impact-medium', label: 'Medium' }, { id: 'impact-high', label: 'High' }] }],
}
/** `createmeta-unsupported` 가 Epic 에 더하는 필드 — 사람 고르기는 corral 이 채우지 못한다(지원 밖 모양 양성 대조). */
export const MOCK_UNSUPPORTED_FIELD: WorkCreateField = { key: 'customfield_team', label: 'Team', shape: 'unsupported', sourceType: 'user' }
const PAGE_SIZE = 2

type MockSpace = { space: WorkSpace; statuses: WorkStatus[]; transitions: Record<string, string[]> }
type MockItem = Omit<WorkItem, 'relations' | 'version' | 'category' | 'bodyLock'> & { version: number; updatedBy: string | null }
type MockLink = { id: string; from: string; to: string; kind: WorkRelationKind }

/** `pageSize` — 커서 한 쪽 크기. 계약 묶음 씨앗은 2(작업 5개로 여러 쪽), 데모 씨앗은 6(첫 쪽에 화면 재현이 다 들고 「더 불러오기」 가 남는다). */
export type MockState = {
  spaces: MockSpace[]
  items: MockItem[]
  links: MockLink[]
  comments: Record<string, WorkComment[]>
  /** 작업 id → 변경 이력(오래된 것부터). */
  history: Record<string, WorkHistoryEntry[]>
  seq: number
  pageSize?: number
  /** 이력·충돌의 시각 — 테스트가 고정할 수 있다. */
  clock?: () => number
  /** 받은 작업 링크 쓰기·지우기(LIFE-603 C14) — 요청 기록. */
  linkWrites?: { op: 'saveWorkLink' | 'removeWorkLink'; itemId: string; link: WorkLink; machine: string; repo: string | null }[]
  /** 받은 만들기 요청(LIFE-604 C9 — 연타에 생성 호출 1회를 센다). 거절된 요청도 쌓는다. */
  createCalls?: Extract<WorkCall, { op: 'createItem' }>[]
  /** 종류 → 필수 필드. 없으면 `MOCK_CREATE_FIELDS`. 테스트가 바꿀 수 있다. */
  createFields?: Record<string, WorkCreateField[]>
}

/** 이 모의 출처로 쓴 사람 — 이력의 author. */
const MOCK_AUTHOR = 'mock'

function status({ key, label, category, order }: Omit<WorkStatus, 'color'>): WorkStatus {
  return { key, label, category, order, color: null }
}

export function seedMockState(): MockState {
  const core: MockSpace = {
    space: { key: 'CORE', name: 'Core Platform', color: null, description: null, openCount: null, role: 'regular', capabilities: {} },
    statuses: [
      status({ key: 'core-todo', label: 'To Do', category: 'todo', order: 0 }),
      status({ key: 'core-doing', label: 'In Progress', category: 'in_progress', order: 1 }),
      status({ key: 'core-review', label: 'In Review', category: 'in_progress', order: 2 }),
      status({ key: 'core-done', label: 'Done', category: 'done', order: 3 }),
    ],
    // 허용 전이 — 뒤로는 한 칸만, 검토에서 할 일로 바로는 못 간다.
    transitions: {
      'core-todo': ['core-doing'],
      'core-doing': ['core-todo', 'core-review'],
      'core-review': ['core-doing', 'core-done'],
      'core-done': ['core-review'],
    },
  }
  const web: MockSpace = {
    space: { key: 'WEB', name: 'Web', color: null, description: null, openCount: null, role: 'regular', capabilities: {} },
    statuses: [status({ key: 'web-open', label: 'Open', category: 'todo', order: 0 }), status({ key: 'web-closed', label: 'Closed', category: 'done', order: 1 })],
    transitions: { 'web-open': ['web-closed'], 'web-closed': ['web-open'] },
  }
  const item = ({ id, key, spaceKey, title, kind, statusKey, parentId, rank, placement }: { id: string; key: string; spaceKey: string; title: string; kind: WorkKind; statusKey: string; parentId: string | null; rank: string; placement: 'board' | 'backlog' }): MockItem => ({
    id, key, spaceKey, title, body: `${title} 본문`, kind, statusKey, resolution: null, doneAt: null, priority: 'medium', dueAt: null, parentId, placement, rank, openBlockerCount: 0, openBlockers: [],
    updatedAt: '2026-10-13T00:00:00.000Z', version: 1, updatedBy: null, workLinks: [],
  })
  const [epic, story, bug] = KINDS
  if (epic === undefined || story === undefined || bug === undefined) throw new Error('mock kinds')
  return {
    spaces: [core, web],
    items: [
      item({ id: 'm-1', key: 'CORE-1', spaceKey: 'CORE', title: '결제 개편', kind: epic, statusKey: 'core-doing', parentId: null, rank: 'a', placement: 'board' }),
      item({ id: 'm-2', key: 'CORE-2', spaceKey: 'CORE', title: '카드 저장', kind: story, statusKey: 'core-todo', parentId: 'm-1', rank: 'b', placement: 'board' }),
      item({ id: 'm-3', key: 'CORE-3', spaceKey: 'CORE', title: '환불 버그', kind: bug, statusKey: 'core-todo', parentId: null, rank: 'c', placement: 'backlog' }),
      item({ id: 'm-4', key: 'CORE-4', spaceKey: 'CORE', title: '영수증 메일', kind: story, statusKey: 'core-review', parentId: 'm-1', rank: 'd', placement: 'board' }),
      item({ id: 'm-5', key: 'WEB-1', spaceKey: 'WEB', title: '랜딩 문구', kind: story, statusKey: 'web-open', parentId: null, rank: 'a', placement: 'board' }),
    ],
    links: [],
    comments: {},
    history: {},
    seq: 1,
  }
}

/**
 * 격리 앱 실행용 씨앗 (LIFE-601) — 계약 묶음 씨앗에 화면 재현을 더한다: 칸 없는 상태(「Blocked by Legal」 → 점선 칸) · 막힘(열린/완료 막은 쪽) ·
 * 자식 있는 Epic · 백로그 · 마감 · 우선순위 · 빈 스페이스. 계약 묶음은 `seedMockState` 를 그대로 쓴다.
 */
export function seedMockDemoState(): MockState {
  const state = seedMockState()
  const core = state.spaces[0]
  if (core !== undefined) core.transitions['core-legal'] = ['core-todo']
  state.spaces.push({
    space: { key: 'EMPTY', name: 'Empty Space', color: null, description: null, openCount: null, role: 'regular', capabilities: {} },
    statuses: [status({ key: 'empty-todo', label: 'To Do', category: 'todo', order: 0 }), status({ key: 'empty-done', label: 'Done', category: 'done', order: 1 })],
    transitions: { 'empty-todo': ['empty-done'], 'empty-done': ['empty-todo'] },
  })
  const [, story, bug] = KINDS
  if (story === undefined || bug === undefined) throw new Error('mock kinds')
  const base = { body: null, resolution: null, doneAt: null, priority: 'medium' as const, dueAt: null, parentId: null, openBlockerCount: 0, openBlockers: [], updatedAt: '2026-10-13T00:00:00.000Z', version: 1, updatedBy: null, workLinks: [] }
  const soon = new Date(Date.now() + 86_400_000).toISOString()
  state.items.push(
    { ...base, id: 'm-6', key: 'CORE-5', spaceKey: 'CORE', title: '법무 검토 대기 — 칸 없는 상태', kind: story, statusKey: 'core-legal', rank: 'e', placement: 'board' },
    { ...base, id: 'm-7', key: 'CORE-6', spaceKey: 'CORE', title: '정산 리포트', kind: story, statusKey: 'core-todo', rank: 'f', placement: 'board', priority: 'highest', dueAt: soon },
    { ...base, id: 'm-8', key: 'CORE-7', spaceKey: 'CORE', title: '구 결제 모듈 제거', kind: bug, statusKey: 'core-done', resolution: 'completed', parentId: 'm-1', rank: 'g', placement: 'board', priority: 'low' },
    { ...base, id: 'm-9', key: 'CORE-8', spaceKey: 'CORE', title: '백로그 아이디어', kind: story, statusKey: 'core-todo', rank: 'h', placement: 'backlog' },
  )
  // 막힘: CORE-6 ← CORE-2(열림) · CORE-6 ← CORE-7(완료 — 배지에 안 보임) · CORE-4 ← CORE-3(열림)
  // LIFE-602 상세 재현 — 본문 markdown(체크리스트·키 링크·외부 링크·raw HTML 은 글자로), 다른 스페이스 연결(CORE-1 ↔ WEB-1).
  const epic = state.items.find((row) => row.id === 'm-1')
  if (epic !== undefined) epic.body = DEMO_BODY
  state.pageSize = 6
  state.links.push({ id: 'l-demo-1', from: 'm-2', to: 'm-7', kind: 'blocks' }, { id: 'l-demo-2', from: 'm-8', to: 'm-7', kind: 'blocks' }, { id: 'l-demo-3', from: 'm-4', to: 'm-3', kind: 'is_blocked_by' }, { id: 'l-demo-4', from: 'm-1', to: 'm-5', kind: 'relates_to' })
  state.comments['m-1'] = [{ id: 'c-demo-1', author: '모의 웹', body: '결제 개편 범위는 **카드 저장**까지. CORE-2 먼저.', createdAt: '2026-10-13T00:00:30.000Z' }]
  state.history['m-1'] = [{ id: 'h-demo-1', at: '2026-10-13T00:00:10.000Z', author: '모의 웹', field: 'priority', from: 'low', to: 'medium', writeId: null }]
  return state
}

const DEMO_BODY = [
  '## 목표',
  '결제 흐름을 새 PG 로 옮긴다. 관련: CORE-2 · WEB-1',
  '',
  '- [x] PG 계약',
  '- [ ] 카드 저장 (**CORE-2**)',
  '- [ ] 환불 _재시도_',
  '',
  '> 링크: [설계 문서](https://example.com/design) · [로컬 파일](file:///etc/hosts)',
  '',
  '```ts',
  'const pg = createPg()',
  '```',
  '',
  '<img src=x onerror="alert(1)"> 는 글자로 보여야 한다.',
].join('\n')

/**
 * 다른 곳(모의 웹)에서 고친 것처럼 상태를 바꾼다 — 판이 오르고, 이력에 **쓰기 id 없이** 남는다(LIFE-602 양성 대조: 충돌 · 같은 값 변경 보존).
 * 테스트와 `drift` 행동이 쓴다.
 */
export function foreignEdit({ state, itemId, patch, author = '모의 웹' }: { state: MockState; itemId: string; patch: { title?: string; body?: string; priority?: WorkItem['priority']; statusKey?: string; placement?: WorkItem['placement'] }; author?: string }): void {
  const item = state.items.find((row) => row.id === itemId)
  if (item === undefined) throw new Error(`foreignEdit: 없는 작업 ${itemId}`)
  const space = state.spaces.find((entry) => entry.space.key === item.spaceKey)
  const labelOf = (key: string): string => space?.statuses.find((entry) => entry.key === key)?.label ?? key
  const entries: { field: WorkHistoryField; from: string | null; to: string | null }[] = []
  if (patch.title !== undefined) entries.push({ field: 'title', from: item.title, to: patch.title })
  if (patch.body !== undefined) entries.push({ field: 'body', from: null, to: null })
  if (patch.priority !== undefined) entries.push({ field: 'priority', from: item.priority, to: patch.priority })
  if (patch.statusKey !== undefined) entries.push({ field: 'status', from: labelOf(item.statusKey), to: labelOf(patch.statusKey) })
  if (patch.placement !== undefined) entries.push({ field: 'placement', from: item.placement, to: patch.placement })
  Object.assign(item, patch)
  bump({ state, item, author })
  for (const entry of entries) record({ state, itemId, author, writeId: null, ...entry })
}

function now(state: MockState): number {
  return state.clock?.() ?? Date.now()
}

function bump({ state, item, author }: { state: MockState; item: MockItem; author: string }): void {
  item.version += 1
  item.updatedBy = author
  // 시각은 늘 앞으로 — 같은 밀리초 안의 연속 쓰기도 순서가 보이게 이전 값 + 1초와 지금 중 늦은 쪽.
  item.updatedAt = new Date(Math.max(Date.parse(item.updatedAt) + 1000, now(state))).toISOString()
}

function record({ state, itemId, author, writeId, field, from, to }: { state: MockState; itemId: string; author: string; writeId: string | null; field: WorkHistoryField; from: string | null; to: string | null }): void {
  const at = new Date(now(state)).toISOString()
  state.history[itemId] = [...(state.history[itemId] ?? []), { id: `h-${state.seq++}`, at, author, field, from, to, writeId }]
}

/** done 진입 시각(LIFE-702) — LA `resolveDoneAt` 과 같다: 나가면 null, done→done 은 유지(비어 있으면 지금으로 채움 — H3), 들어가면 지금. */
function doneAtFor({ from, to, current, at }: { from: WorkStatus['category'] | null; to: WorkStatus['category']; current: string | null; at: number }): string | null {
  if (to !== 'done') return null
  if (from === 'done' && current !== null) return current
  return new Date(at).toISOString()
}

/** 완료 분류로 갈 때의 갈래 — 고른 것, 없으면 완료함. */
function resolutionFor({ category, chosen, current }: { category: WorkStatus['category']; chosen: WorkResolution | null | undefined; current: WorkResolution | null }): WorkResolution | null {
  if (category !== 'done') return null
  return chosen ?? current ?? 'completed'
}

export function mockSourceEntry({ state = seedMockState(), defect = 'none' }: { state?: MockState; defect?: MockDefect } = {}): WorkSourceEntry {
  return { descriptor: MOCK_DESCRIPTOR, create: ({ token }) => new MockSource({ state, defect, behavior: mockBehaviorOf(token) }) }
}

export class MockSource implements WorkSourceClient {
  private readonly state: MockState
  private readonly defect: MockDefect
  private readonly behavior: MockBehavior
  private closed = false
  private calls = 0
  /** `drift` — 작업마다 단건을 읽은 수. */
  private readonly reads = new Map<string, number>()

  constructor({ state, defect, behavior = PLAIN_BEHAVIOR }: { state: MockState; defect: MockDefect; behavior?: MockBehavior }) {
    this.state = state
    this.defect = defect
    this.behavior = behavior
  }

  capabilities(): WorkCapabilities {
    return { ...MOCK_CAPABILITIES, ...this.behavior.caps }
  }

  close(): void {
    this.closed = true
  }

  async call(call: WorkCall, meta?: WorkCallMeta): Promise<WorkOutcome> {
    this.calls += 1
    const flip = this.behavior.flip !== null && this.calls % 2 === 1 ? this.behavior.flip : null
    const before = this.behavior.delayMs + (flip?.mode === 'apply' ? flip.ms : 0)
    if (before > 0) await new Promise((resolve) => setTimeout(resolve, before))
    const outcome = await this.decide({ call, writeId: meta?.writeId ?? null })
    if (flip?.mode === 'deliver') await new Promise((resolve) => setTimeout(resolve, flip.ms))
    return outcome
  }

  private async decide({ call, writeId }: { call: WorkCall; writeId: string | null }): Promise<WorkOutcome> {
    if (call.op === 'createItem') this.state.createCalls = [...(this.state.createCalls ?? []), call]
    if (this.behavior.rejectWrites && (call.op === 'changeStatus' || call.op === 'setPlacement' || call.op === 'reorder' || call.op === 'updateItem' || call.op === 'createItem')) {
      return rejected('모의 출처가 이 쓰기를 거절했습니다 (reject-writes).')
    }
    const fault = this.behavior.fault
    if (fault !== null && (call.op === 'listItems' || call.op === 'listStatuses')) {
      const { message, status } = FAULT_MESSAGE[fault]
      return { ok: false, error: workError({ kind: fault, message, status }) }
    }
    if (this.behavior.drift && call.op === 'getItem') this.driftOn(call.itemId)
    return this.answer({ call, writeId })
  }

  /** `drift` — 같은 작업을 두 번째 읽을 때부터, 읽은 뒤 곧 모의 웹이 우선순위를 바꾼다(다음 저장이 충돌). */
  private driftOn(itemId: string): void {
    const count = (this.reads.get(itemId) ?? 0) + 1
    this.reads.set(itemId, count)
    const item = this.item(itemId)
    if (item === null || count < 2) return
    const next = item.priority === 'highest' ? 'low' : 'highest'
    setTimeout(() => foreignEdit({ state: this.state, itemId, patch: { priority: next } }), 50)
  }

  private async answer({ call, writeId }: { call: WorkCall; writeId: string | null }): Promise<WorkOutcome> {
    if (this.closed) return { ok: false, error: workError({ kind: 'not_connected', message: '연결이 해제됐거나 토큰이 바뀌어 요청을 보내지 않았습니다.' }) }
    switch (call.op) {
      case 'listSpaces':
        return { ok: true, result: { op: 'listSpaces', spaces: this.state.spaces.map((entry) => ({ ...entry.space, openCount: this.openCount(entry.space.key) })), capabilities: this.capabilities() } }
      case 'listStatuses': {
        const space = this.space(call.spaceKey)
        if (space === null) return rejected('없는 스페이스입니다.')
        const statuses = this.defect === 'status-category' ? space.statuses.map((entry): WorkStatus => ({ ...entry, category: 'todo' })) : space.statuses
        return { ok: true, result: { op: 'listStatuses', statuses, kinds: KINDS } }
      }
      case 'listItems': {
        if (this.space(call.spaceKey) === null) return rejected('없는 스페이스입니다.')
        const all = this.state.items.filter((item) => item.spaceKey === call.spaceKey).sort((a, b) => (a.rank ?? '').localeCompare(b.rank ?? ''))
        const start = call.cursor === null ? 0 : Number(call.cursor)
        if (!Number.isInteger(start) || start < 0 || start > all.length) return rejected('잘못된 커서입니다.')
        const size = this.state.pageSize ?? PAGE_SIZE
        const page = all.slice(start, start + size).map((item) => this.view({ item, withRelations: false }))
        const next = start + size < all.length ? String(start + size) : null
        return { ok: true, result: { op: 'listItems', items: page, nextCursor: next, truncated: false } }
      }
      case 'getItem': {
        const item = this.item(call.itemId)
        return item === null ? rejected('없는 작업입니다.') : { ok: true, result: { op: 'getItem', item: this.view({ item, withRelations: true }) } }
      }
      case 'findByKey': {
        if (!KEY_SHAPE.test(call.key.trim())) return { ok: true, result: { op: 'findByKey', item: null } }
        const item = this.state.items.find((row) => row.key.toUpperCase() === call.key.trim().toUpperCase()) ?? null
        return { ok: true, result: { op: 'findByKey', item: item === null ? null : this.view({ item, withRelations: true }) } }
      }
      case 'listTransitions': {
        const item = this.item(call.itemId)
        if (item === null) return rejected('없는 작업입니다.')
        return { ok: true, result: { op: 'listTransitions', statusKeys: [...(this.space(item.spaceKey)?.transitions[item.statusKey] ?? [])], blocked: [] } }
      }
      case 'changeStatus': {
        const item = this.item(call.itemId)
        if (item === null) return rejected('없는 작업입니다.')
        const stale = this.stale({ item, ifVersion: call.ifVersion })
        if (stale !== null) return stale
        const allowed = this.space(item.spaceKey)?.transitions[item.statusKey] ?? []
        const target = this.space(item.spaceKey)?.statuses.find((status) => status.key === call.statusKey) ?? null
        const resolution = resolutionFor({ category: target?.category ?? 'todo', chosen: call.resolution, current: call.statusKey === item.statusKey ? item.resolution : null })
        // 같은 상태 — 갈래만 바꾸는 것(완료함 ↔ 취소함)은 전이가 아니다(E5).
        if (call.statusKey === item.statusKey) {
          if (resolution !== item.resolution && this.defect !== 'transition-ignored') this.touch({ item, patch: { resolution }, writeId, fields: [{ field: 'status', from: this.statusText(item), to: this.statusText({ ...item, resolution }) }] })
          return { ok: true, result: { op: 'changeStatus', item: this.view({ item, withRelations: true }) } }
        }
        // `transition-any` 면 출처도 어떤 전이든 받는다(R2-N) — 능력 표만 any 이고 출처가 거절하면 any 분기를 볼 수 없다.
        if (this.capabilities().transition.mode === 'any' ? target === null : !allowed.includes(call.statusKey)) return rejected('워크플로에 이 전이가 없습니다.')
        if (this.defect !== 'transition-ignored') {
          const after = { ...item, statusKey: call.statusKey, resolution }
          const doneAt = doneAtFor({ from: this.categoryOf(item), to: target?.category ?? 'todo', current: item.doneAt, at: now(this.state) })
          this.touch({ item, patch: { statusKey: call.statusKey, resolution, doneAt }, writeId, fields: [{ field: 'status', from: this.statusText(item), to: this.statusText(after) }] })
        }
        return { ok: true, result: { op: 'changeStatus', item: this.view({ item, withRelations: true }) } }
      }
      case 'updateItem': {
        const item = this.item(call.itemId)
        if (item === null) return rejected('없는 작업입니다.')
        const stale = this.stale({ item, ifVersion: call.ifVersion })
        if (stale !== null) return stale
        this.touch({ item, patch: patchOf(call.fields), writeId, fields: fieldChanges({ item, fields: call.fields }) })
        return { ok: true, result: { op: 'updateItem', item: this.view({ item, withRelations: true }) } }
      }
      case 'listChildren': {
        const item = this.item(call.itemId)
        if (item === null) return rejected('없는 작업입니다.')
        const children = this.state.items.filter((row) => row.parentId === item.id).sort((a, b) => (a.rank ?? '').localeCompare(b.rank ?? ''))
        return { ok: true, result: { op: 'listChildren', items: children.map((row) => this.view({ item: row, withRelations: false })) } }
      }
      case 'getCreateMeta': {
        if (this.behavior.createMeta === 'fail') return rejected('모의 출처가 생성 메타를 주지 않았습니다 (createmeta-fail).')
        const meta = this.createMeta({ spaceKey: call.spaceKey, kindKey: call.kindKey })
        return meta.ok ? { ok: true, result: { op: 'getCreateMeta', meta: meta.meta } } : meta.outcome
      }
      case 'createItem': {
        const meta = this.createMeta({ spaceKey: call.spaceKey, kindKey: call.kindKey })
        if (!meta.ok) return meta.outcome
        const space = this.space(call.spaceKey)
        const kind = KINDS.find((entry) => entry.key === call.kindKey)
        if (space === null || kind === undefined) return rejected('없는 스페이스·종류입니다.')
        const parent = call.parentId === null ? null : this.item(call.parentId)
        if (call.parentId !== null && (parent === null || parent.spaceKey !== call.spaceKey)) return rejected('부모로 쓸 수 없는 작업입니다.')
        // 종류별 자식 규칙(E6) — 부모 종류의 childKinds 밖이면 거절.
        if (parent !== null && !(KINDS.find((entry) => entry.key === parent.kind.key)?.childKinds ?? []).includes(kind.key)) return rejected(`${parent.kind.label} 아래에는 ${kind.label} 를 만들 수 없습니다.`)
        // 메타 밖의 상태·필드, 빠진 필수 필드는 거절(E10 — 받는 척하지 않는다).
        const problem = createFieldsProblem({ call, meta: meta.meta })
        if (problem !== null) return rejected(problem)
        if (call.placement !== undefined && this.capabilities().placement.state !== 'on') return { ok: false, error: workError({ kind: 'unsupported', message: '이 출처는 배치를 받지 않습니다.' }) }
        const seq = this.state.items.filter((row) => row.spaceKey === call.spaceKey).length + 1
        const created: MockItem = {
          id: `m-new-${this.state.seq++}`, key: `${call.spaceKey}-${100 + seq}`, spaceKey: call.spaceKey, title: call.title, body: call.body ?? '', kind: { ...kind, childKinds: [...kind.childKinds] },
          statusKey: call.statusKey ?? meta.meta.defaultStatusKey, resolution: null, doneAt: doneAtFor({ from: null, to: space.statuses.find((status) => status.key === (call.statusKey ?? meta.meta.defaultStatusKey))?.category ?? 'todo', current: null, at: now(this.state) }), priority: call.priority ?? null, dueAt: null, parentId: call.parentId, placement: call.placement ?? 'board', rank: `z${this.state.seq}`,
          openBlockerCount: 0, openBlockers: [], updatedAt: new Date(now(this.state)).toISOString(), version: 1, updatedBy: MOCK_AUTHOR, workLinks: [],
        }
        this.state.items.push(created)
        if (parent !== null) this.touch({ item: parent, patch: {}, writeId, fields: [{ field: 'child', from: null, to: `${created.key} ${created.title}` }] })
        if (this.behavior.createLost) return { ok: false, error: unknownWriteOutcome({ error: workError({ kind: 'network', message: '모의 출처의 답이 끊겼습니다 (create-lost).' }), unsent: false }) }
        return { ok: true, result: { op: 'createItem', item: this.view({ item: created, withRelations: true }) } }
      }
      case 'searchItems':
        return { ok: false, error: workError({ kind: 'unsupported', message: '모의 출처에는 질의 검색이 없습니다.' }) }
      case 'listHistory': {
        if (this.item(call.itemId) === null) return rejected('없는 작업입니다.')
        return { ok: true, result: { op: 'listHistory', entries: [...(this.state.history[call.itemId] ?? [])] } }
      }
      case 'setPlacement': {
        const item = this.item(call.itemId)
        if (item === null) return rejected('없는 작업입니다.')
        const stale = this.stale({ item, ifVersion: call.ifVersion })
        if (stale !== null) return stale
        this.touch({ item, patch: { placement: call.placement }, writeId, fields: item.placement === call.placement ? [] : [{ field: 'placement', from: item.placement, to: call.placement }] })
        return { ok: true, result: { op: 'setPlacement', item: this.view({ item, withRelations: true }) } }
      }
      case 'setParent': {
        const item = this.item(call.itemId)
        if (item === null) return rejected('없는 작업입니다.')
        const stale = this.stale({ item, ifVersion: call.ifVersion })
        if (stale !== null) return stale
        // Jira 는 스페이스(프로젝트)를 옮기면 키가 바뀐다 — 모의 출처는 스페이스 안 이동만 받는다.
        if (call.spaceKey !== item.spaceKey) return rejected('다른 스페이스로 옮기려면 Jira 에서 이동하세요.')
        if (call.parentId !== null) {
          const parent = this.item(call.parentId)
          if (parent === null || parent.spaceKey !== item.spaceKey || parent.id === item.id) return rejected('부모로 쓸 수 없는 작업입니다.')
        }
        const keyOf = (id: string | null): string | null => (id === null ? null : this.item(id)?.key ?? id)
        this.touch({ item, patch: { parentId: call.parentId }, writeId, fields: [{ field: 'parent', from: keyOf(item.parentId), to: keyOf(call.parentId) }] })
        return { ok: true, result: { op: 'setParent', item: this.view({ item, withRelations: true }) } }
      }
      case 'reorder': {
        const item = this.item(call.itemId)
        if (item === null) return rejected('없는 작업입니다.')
        const ordered = this.state.items.filter((row) => row.spaceKey === item.spaceKey && row.id !== item.id).sort((a, b) => (a.rank ?? '').localeCompare(b.rank ?? ''))
        const at = call.afterId === null ? 0 : ordered.findIndex((row) => row.id === call.afterId) + 1
        if (call.afterId !== null && at === 0) return rejected('기준 작업이 같은 스페이스에 없습니다.')
        ordered.splice(at, 0, item)
        ordered.forEach((row, index) => { row.rank = String.fromCharCode(97 + index) })
        this.touch({ item, patch: {}, writeId, fields: [] })
        return { ok: true, result: { op: 'reorder', item: this.view({ item, withRelations: true }) } }
      }
      case 'addRelation': {
        const item = this.item(call.itemId)
        const other = this.state.items.find((row) => row.key === call.otherKey) ?? null
        if (item === null || other === null) return rejected('없는 작업입니다.')
        if (other.id === item.id) return rejected('자기 자신과는 연결할 수 없습니다.')
        if (this.state.links.some((link) => link.from === item.id && link.to === other.id && link.kind === call.kind)) return rejected('이미 연결됐습니다.')
        const link: MockLink = { id: `l-${this.state.seq++}`, from: item.id, to: other.id, kind: call.kind }
        this.state.links.push(link)
        record({ state: this.state, itemId: item.id, author: MOCK_AUTHOR, writeId, field: 'relation', from: null, to: `${call.kind} ${other.key}` })
        return { ok: true, result: { op: 'addRelation', relation: this.relationOf({ link, viewer: item.id }) } }
      }
      case 'removeRelation': {
        const index = this.state.links.findIndex((link) => link.id === call.relationId && (link.from === call.itemId || link.to === call.itemId))
        if (index < 0) return rejected('없는 연결입니다.')
        const [gone] = this.state.links.splice(index, 1)
        const otherId = gone === undefined ? null : gone.from === call.itemId ? gone.to : gone.from
        record({ state: this.state, itemId: call.itemId, author: MOCK_AUTHOR, writeId, field: 'relation', from: otherId === null ? null : (this.item(otherId)?.key ?? null), to: null })
        return { ok: true, result: { op: 'removeRelation', relationId: call.relationId } }
      }
      case 'listComments': {
        if (this.item(call.itemId) === null) return rejected('없는 작업입니다.')
        return { ok: true, result: { op: 'listComments', comments: [...(this.state.comments[call.itemId] ?? [])] } }
      }
      case 'saveWorkLink':
      case 'removeWorkLink': {
        const item = this.item(call.itemId)
        if (item === null) return rejected('없는 작업입니다.')
        const writes = this.state.linkWrites ?? []
        writes.push({ op: call.op, itemId: call.itemId, link: call.link, machine: call.machine, repo: call.op === 'saveWorkLink' ? call.repo : null })
        this.state.linkWrites = writes
        // LIFE-635 — LA 와 같은 판별(종류 + 핵심 값 + machine). 재저장 = 한 행(부가 값·repo 덮음, createdAt 유지) · 다른 machine 의 같은 경로는 별개 행.
        const id = workLinkIdentity({ link: call.link, machine: call.machine })
        const existing = item.workLinks.find((row) => workLinkIdentity(row) === id)
        if (call.op === 'removeWorkLink') item.workLinks = item.workLinks.filter((row) => workLinkIdentity(row) !== id)
        else if (existing !== undefined) item.workLinks = item.workLinks.map((row) => (row === existing ? { ...row, link: call.link, repo: call.repo } : row))
        else item.workLinks = [...item.workLinks, { link: call.link, machine: call.machine, repo: call.repo, createdAt: new Date(now(this.state)).toISOString() }]
        return { ok: true, result: { op: call.op, workLinks: item.workLinks.map((row) => ({ ...row })) } }
      }
      case 'addComment': {
        if (this.item(call.itemId) === null) return rejected('없는 작업입니다.')
        const comment: WorkComment = { id: `c-${this.state.seq++}`, author: MOCK_AUTHOR, body: call.body, createdAt: new Date(now(this.state)).toISOString() }
        this.state.comments[call.itemId] = [...(this.state.comments[call.itemId] ?? []), comment]
        return { ok: true, result: { op: 'addComment', comment } }
      }
    }
  }

  /** 생성 메타 — 상태는 워크플로의 첫 상태(첫 todo) 하나만, 필수 필드는 종류별. */
  private createMeta({ spaceKey, kindKey }: { spaceKey: string; kindKey: string }): { ok: true; meta: WorkCreateMeta } | { ok: false; outcome: WorkOutcome } {
    const space = this.space(spaceKey)
    if (space === null) return { ok: false, outcome: rejected('없는 스페이스입니다.') }
    if (!KINDS.some((entry) => entry.key === kindKey)) return { ok: false, outcome: rejected('없는 종류입니다.') }
    const first = space.statuses.find((status) => status.category === 'todo') ?? space.statuses[0]
    if (first === undefined) return { ok: false, outcome: rejected('상태가 없는 스페이스입니다.') }
    const base = (this.state.createFields ?? MOCK_CREATE_FIELDS)[kindKey] ?? []
    const fields = this.behavior.createMeta === 'unsupported' && kindKey === 'epic' ? [...base, MOCK_UNSUPPORTED_FIELD] : base
    const meta: WorkCreateMeta = { spaceKey, kindKey, statusKeys: [first.key], defaultStatusKey: first.key, placement: this.behavior.createMeta === 'placement-ignored' ? 'ignored' : 'applies', accepts: { body: true, priority: true }, fields: fields.map(copyField) }
    if (this.behavior.createMeta === 'unavailable' && kindKey === 'epic') meta.unavailable = '이 스페이스에는 Epic 을 만들 수 없습니다 (createmeta-unavailable).'
    return { ok: true, meta }
  }

  private space(key: string): MockSpace | null {
    return this.state.spaces.find((entry) => entry.space.key === key) ?? null
  }

  private item(id: string): MockItem | null {
    return this.state.items.find((item) => item.id === id) ?? null
  }

  private openCount(spaceKey: string): number {
    return this.state.items.filter((item) => item.spaceKey === spaceKey && this.categoryOf(item) !== 'done').length
  }

  private categoryOf(item: MockItem): WorkStatus['category'] {
    return this.space(item.spaceKey)?.statuses.find((entry) => entry.key === item.statusKey)?.category ?? 'todo'
  }

  /** 판이 다르면 충돌 — 서버의 지금 값과 마지막으로 바꾼 쪽을 싣는다(E7). */
  private stale({ item, ifVersion }: { item: MockItem; ifVersion: string | null }): WorkOutcome | null {
    if (ifVersion === null || ifVersion === String(item.version)) return null
    const error = workError({ kind: 'conflict', message: `${item.key} 이(가) 연 뒤에 바뀌었습니다 — 새로 불러오거나 덮어쓰세요.` })
    return { ok: false, error: { ...error, conflict: { current: this.view({ item, withRelations: true }), by: item.updatedBy } } }
  }

  private touch({ item, patch, writeId, fields }: { item: MockItem; patch: Partial<MockItem>; writeId: string | null; fields: { field: WorkHistoryField; from: string | null; to: string | null }[] }): void {
    Object.assign(item, patch)
    bump({ state: this.state, item, author: MOCK_AUTHOR })
    for (const entry of fields) record({ state: this.state, itemId: item.id, author: MOCK_AUTHOR, writeId, ...entry })
  }

  private statusText(item: Pick<MockItem, 'spaceKey' | 'statusKey' | 'resolution'>): string {
    const label = this.space(item.spaceKey)?.statuses.find((entry) => entry.key === item.statusKey)?.label ?? item.statusKey
    return item.resolution === 'cancelled' ? `${label} · 취소함` : label
  }

  private relationOf({ link, viewer }: { link: MockLink; viewer: string }): WorkRelation {
    const outgoing = link.from === viewer
    const other = this.item(outgoing ? link.to : link.from)
    const status = other === null ? null : this.space(other.spaceKey)?.statuses.find((entry) => entry.key === other.statusKey) ?? null
    return {
      id: link.id,
      kind: outgoing ? link.kind : PAIR[link.kind],
      other: { id: other?.id ?? '', key: other?.key ?? '', title: other?.title ?? '', statusLabel: status?.label ?? '', category: status?.category ?? 'todo', spaceKey: other?.spaceKey ?? null },
    }
  }

  private view({ item, withRelations }: { item: MockItem; withRelations: boolean }): WorkItem {
    const relations = this.state.links.filter((link) => link.from === item.id || link.to === item.id).map((link) => this.relationOf({ link, viewer: item.id }))
    const openBlockers = relations
      .filter((relation) => relation.kind === 'is_blocked_by' && relation.other.category !== 'done')
      .map((relation) => ({ id: relation.other.id, key: relation.other.key, title: relation.other.title }))
    const { updatedBy: _by, ...rest } = item
    void _by
    return {
      ...rest,
      kind: { ...item.kind, childKinds: [...item.kind.childKinds] },
      openBlockers,
      body: withRelations ? item.body : null,
      category: this.categoryOf(item),
      version: String(item.version),
      openBlockerCount: openBlockers.length,
      relations: withRelations ? relations : null,
      workLinks: item.workLinks.map((row) => ({ ...row })),
      bodyLock: null,
    }
  }
}

/** 작업 링크 판별 키(LIFE-635) — 종류 + 핵심 값 + machine. LA 판별과 같은 축·같은 정규화(X1-7: 핵심 값·machine trim, 빈 machine = null). */
function workLinkIdentity({ link, machine }: { link: WorkLink; machine: string | null }): string {
  const value = link.kind === 'worktree' ? link.path : link.kind === 'branch' ? link.name : link.kind === 'pull_request' ? link.url : link.sessionId
  const who = machine?.trim() ?? ''
  return JSON.stringify([link.kind, value.trim(), who.length > 0 ? who : null])
}

function copyField(field: WorkCreateField): WorkCreateField {
  return field.shape === 'option' ? { ...field, options: field.options.map((option) => ({ ...option })) } : { ...field }
}

function patchOf(fields: WorkFieldPatch): Partial<MockItem> {
  const patch: Partial<MockItem> = {}
  if (fields.title !== undefined) patch.title = fields.title
  if (fields.body !== undefined) patch.body = fields.body
  if (fields.priority !== undefined) patch.priority = fields.priority
  if (fields.dueAt !== undefined) patch.dueAt = fields.dueAt
  return patch
}

/** 바뀐 칸만 이력으로 — 같은 값을 다시 보내면 이력이 없다. */
function fieldChanges({ item, fields }: { item: MockItem; fields: WorkFieldPatch }): { field: WorkHistoryField; from: string | null; to: string | null }[] {
  const changes: { field: WorkHistoryField; from: string | null; to: string | null }[] = []
  if (fields.title !== undefined && fields.title !== item.title) changes.push({ field: 'title', from: item.title, to: fields.title })
  if (fields.body !== undefined && fields.body !== item.body) changes.push({ field: 'body', from: null, to: null })
  if (fields.priority !== undefined && fields.priority !== item.priority) changes.push({ field: 'priority', from: item.priority, to: fields.priority })
  if (fields.dueAt !== undefined && fields.dueAt !== item.dueAt) changes.push({ field: 'dueAt', from: item.dueAt, to: fields.dueAt })
  return changes
}

function rejected(message: string): WorkOutcome {
  return { ok: false, error: workError({ kind: 'rejected', message }) }
}
