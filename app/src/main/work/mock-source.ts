// 모의 작업 출처 — Jira 형 (LIFE-600 킥오프 4 · C2). 계약 테스트 묶음이 LA 와 **같은 묶음**으로 이것을 돌린다.
// Jira 를 닮은 점: 스페이스마다 다른 상태 목록 · 허용 전이만(`transition: allowed`) · 순서(rank) 있음 · 코멘트 있음 · 커서 페이지 ·
// 조건부 수정(`ifVersion` → 저장 충돌). 작업 링크 저장은 T5 까지 꺼 둔다. 메모리에만 산다 — 앱 레지스트리에는 넣지 않는다.
//
// `defect` 는 양성 대조용(C2): 계약에서 한 곳을 어긋나게 만들어 묶음이 실패하는지 본다. 평시에는 `none`.

import type {
  WorkCall,
  WorkCapabilities,
  WorkComment,
  WorkItem,
  WorkKind,
  WorkRelation,
  WorkRelationKind,
  WorkSourceDescriptor,
  WorkSpace,
  WorkStatus,
} from '../../shared/work.js'
import { workError } from './errors.js'
import type { WorkOutcome, WorkSourceClient, WorkSourceEntry } from './source.js'

export const MOCK_SOURCE_ID = 'mock-jira'
export const MOCK_TOKEN_PREFIX = 'mock_'

export type MockDefect = 'none' | 'status-category' | 'transition-ignored'

export const MOCK_DESCRIPTOR: WorkSourceDescriptor = {
  id: MOCK_SOURCE_ID,
  name: 'Mock Jira',
  mono: 'MJ',
  addLabel: '+ Mock',
  formTitle: 'Mock 연결',
  tokenLabel: 'Mock 토큰',
  tokenPrefix: MOCK_TOKEN_PREFIX,
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
  workLinkStore: { state: 'disabled', reason: '작업 링크 저장은 T5 에서 켭니다.' },
}

const PAIR: Record<WorkRelationKind, WorkRelationKind> = {
  is_blocked_by: 'blocks',
  blocks: 'is_blocked_by',
  duplicates: 'is_duplicated_by',
  is_duplicated_by: 'duplicates',
  relates_to: 'relates_to',
}

const KINDS: WorkKind[] = [{ key: 'epic', label: 'Epic' }, { key: 'story', label: 'Story' }, { key: 'bug', label: 'Bug' }]
const PAGE_SIZE = 2

type MockSpace = { space: WorkSpace; statuses: WorkStatus[]; transitions: Record<string, string[]> }
type MockItem = Omit<WorkItem, 'relations' | 'version' | 'category'> & { version: number }
type MockLink = { id: string; from: string; to: string; kind: WorkRelationKind }

export type MockState = { spaces: MockSpace[]; items: MockItem[]; links: MockLink[]; comments: Record<string, WorkComment[]>; seq: number }

function status({ key, label, category, order }: Omit<WorkStatus, 'color'>): WorkStatus {
  return { key, label, category, order, color: null }
}

export function seedMockState(): MockState {
  const core: MockSpace = {
    space: { key: 'CORE', name: 'Core Platform', color: null, description: null, openCount: null, role: 'regular' },
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
    space: { key: 'WEB', name: 'Web', color: null, description: null, openCount: null, role: 'regular' },
    statuses: [status({ key: 'web-open', label: 'Open', category: 'todo', order: 0 }), status({ key: 'web-closed', label: 'Closed', category: 'done', order: 1 })],
    transitions: { 'web-open': ['web-closed'], 'web-closed': ['web-open'] },
  }
  const item = ({ id, key, spaceKey, title, kind, statusKey, parentId, rank, placement }: { id: string; key: string; spaceKey: string; title: string; kind: WorkKind; statusKey: string; parentId: string | null; rank: string; placement: 'board' | 'backlog' }): MockItem => ({
    id, key, spaceKey, title, body: `${title} 본문`, kind, statusKey, priority: 'medium', dueAt: null, parentId, placement, rank, openBlockerCount: 0,
    updatedAt: '2026-10-13T00:00:00.000Z', version: 1, workLinks: [],
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
    seq: 1,
  }
}

export function mockSourceEntry({ state = seedMockState(), defect = 'none' }: { state?: MockState; defect?: MockDefect } = {}): WorkSourceEntry {
  return { descriptor: MOCK_DESCRIPTOR, create: () => new MockSource({ state, defect }) }
}

export class MockSource implements WorkSourceClient {
  private readonly state: MockState
  private readonly defect: MockDefect
  private closed = false

  constructor({ state, defect }: { state: MockState; defect: MockDefect }) {
    this.state = state
    this.defect = defect
  }

  capabilities(): WorkCapabilities {
    return MOCK_CAPABILITIES
  }

  close(): void {
    this.closed = true
  }

  async call(call: WorkCall): Promise<WorkOutcome> {
    if (this.closed) return { ok: false, error: workError({ kind: 'not_connected', message: '연결이 해제됐거나 토큰이 바뀌어 요청을 보내지 않았습니다.' }) }
    switch (call.op) {
      case 'listSpaces':
        return { ok: true, result: { op: 'listSpaces', spaces: this.state.spaces.map((entry) => ({ ...entry.space, openCount: this.openCount(entry.space.key) })), capabilities: MOCK_CAPABILITIES } }
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
        const page = all.slice(start, start + PAGE_SIZE).map((item) => this.view({ item, withRelations: false }))
        const next = start + PAGE_SIZE < all.length ? String(start + PAGE_SIZE) : null
        return { ok: true, result: { op: 'listItems', items: page, nextCursor: next, truncated: false } }
      }
      case 'getItem': {
        const item = this.item(call.itemId)
        return item === null ? rejected('없는 작업입니다.') : { ok: true, result: { op: 'getItem', item: this.view({ item, withRelations: true }) } }
      }
      case 'listTransitions': {
        const item = this.item(call.itemId)
        if (item === null) return rejected('없는 작업입니다.')
        return { ok: true, result: { op: 'listTransitions', statusKeys: [...(this.space(item.spaceKey)?.transitions[item.statusKey] ?? [])] } }
      }
      case 'changeStatus': {
        const item = this.item(call.itemId)
        if (item === null) return rejected('없는 작업입니다.')
        const stale = this.stale({ item, ifVersion: call.ifVersion })
        if (stale !== null) return stale
        const allowed = this.space(item.spaceKey)?.transitions[item.statusKey] ?? []
        if (!allowed.includes(call.statusKey)) return rejected('워크플로에 이 전이가 없습니다.')
        if (this.defect !== 'transition-ignored') this.touch(item, { statusKey: call.statusKey })
        return { ok: true, result: { op: 'changeStatus', item: this.view({ item, withRelations: true }) } }
      }
      case 'setPlacement': {
        const item = this.item(call.itemId)
        if (item === null) return rejected('없는 작업입니다.')
        const stale = this.stale({ item, ifVersion: call.ifVersion })
        if (stale !== null) return stale
        this.touch(item, { placement: call.placement })
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
        this.touch(item, { parentId: call.parentId })
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
        this.touch(item, {})
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
        return { ok: true, result: { op: 'addRelation', relation: this.relationOf({ link, viewer: item.id }) } }
      }
      case 'removeRelation': {
        const index = this.state.links.findIndex((link) => link.id === call.relationId && (link.from === call.itemId || link.to === call.itemId))
        if (index < 0) return rejected('없는 연결입니다.')
        this.state.links.splice(index, 1)
        return { ok: true, result: { op: 'removeRelation', relationId: call.relationId } }
      }
      case 'listComments': {
        if (this.item(call.itemId) === null) return rejected('없는 작업입니다.')
        return { ok: true, result: { op: 'listComments', comments: [...(this.state.comments[call.itemId] ?? [])] } }
      }
      case 'addComment': {
        if (this.item(call.itemId) === null) return rejected('없는 작업입니다.')
        const comment: WorkComment = { id: `c-${this.state.seq++}`, author: 'mock', body: call.body, createdAt: new Date(0).toISOString() }
        this.state.comments[call.itemId] = [...(this.state.comments[call.itemId] ?? []), comment]
        return { ok: true, result: { op: 'addComment', comment } }
      }
    }
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

  private stale({ item, ifVersion }: { item: MockItem; ifVersion: string | null }): WorkOutcome | null {
    if (ifVersion === null || ifVersion === String(item.version)) return null
    return { ok: false, error: workError({ kind: 'conflict', message: `${item.key} 이(가) 연 뒤에 바뀌었습니다 — 새로 불러오거나 덮어쓰세요.` }) }
  }

  private touch(item: MockItem, patch: Partial<MockItem>): void {
    Object.assign(item, patch)
    item.version += 1
    item.updatedAt = new Date(Date.parse(item.updatedAt) + 1000).toISOString()
  }

  private relationOf({ link, viewer }: { link: MockLink; viewer: string }): WorkRelation {
    const outgoing = link.from === viewer
    const other = this.item(outgoing ? link.to : link.from)
    const status = other === null ? null : this.space(other.spaceKey)?.statuses.find((entry) => entry.key === other.statusKey) ?? null
    return {
      id: link.id,
      kind: outgoing ? link.kind : PAIR[link.kind],
      other: { id: other?.id ?? '', key: other?.key ?? '', title: other?.title ?? '', statusLabel: status?.label ?? '', category: status?.category ?? 'todo' },
    }
  }

  private view({ item, withRelations }: { item: MockItem; withRelations: boolean }): WorkItem {
    const relations = this.state.links.filter((link) => link.from === item.id || link.to === item.id).map((link) => this.relationOf({ link, viewer: item.id }))
    const openBlockerCount = relations.filter((relation) => relation.kind === 'is_blocked_by' && relation.other.category !== 'done').length
    return {
      ...item,
      body: withRelations ? item.body : null,
      category: this.categoryOf(item),
      version: String(item.version),
      openBlockerCount,
      relations: withRelations ? relations : null,
      workLinks: [...item.workLinks],
    }
  }
}

function rejected(message: string): WorkOutcome {
  return { ok: false, error: workError({ kind: 'rejected', message }) }
}
