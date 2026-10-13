// LA(life-assistant) 작업 출처 (LIFE-600 킥오프 3 · C9) — MCP(`/mcp`, 무상태 Streamable HTTP) + 개인 토큰(PAT).
//
// 「LA 에서 스페이스 = project 일감」 은 **이 파일 안에서만** 안다(03-feature-plan §8.1 규칙 2):
//   - 열린(아카이브 아님 · 완료 분류 아님) project 일감 하나 = 스페이스 하나. 이름·색·설명이 스페이스 정보가 된다.
//   - 어느 프로젝트 트리에도 없는 일감(부모 없음)은 「미분류」 스페이스(`role: catch_all`)로 — 실재한다(00-analysis §3: 4건).
//   - 프로젝트를 부모로 둔 일감은 `parentId: null`(스페이스 바로 아래)로 낸다. 프로젝트 자신은 작업 목록에 섞이지 않는다.
// 상태: 모든 LA 스페이스가 같은 `status_list`. 앞으로 = `issue_transition`(forwardOnly) · 뒤로 = `issue_update(statusId)`(D6).
// 능력 꺼짐(L1 대기): 순서(L1f · LIFE-612) · 커서 페이지(L1c) · 조건부 수정(L1b) · 코멘트·이력(L1e) · 작업 링크 저장(L1a).
// 응답은 `la-shape.ts` 로 검증한 뒤에만 계약 타입으로 바꾼다(C3) — 어긋나면 `invalid_response`.

import type {
  WorkCall,
  WorkCapabilities,
  WorkError,
  WorkItem,
  WorkKind,
  WorkRelation,
  WorkSourceDescriptor,
  WorkSpace,
  WorkStatus,
} from '../../shared/work.js'
import { workError } from './errors.js'
import { readIssue, readIssueDetail, readIssues, readLink, readLinkDeleted, readStatuses, readTransition, LaShapeError, type LaIssue, type LaStatus } from './la-shape.js'
import { McpHttpClient } from './mcp-http.js'
import type { WorkOutcome, WorkSourceClient, WorkSourceEntry } from './source.js'

export const LA_SOURCE_ID = 'la'
export const LA_DEFAULT_MCP_URL = 'https://assistant-api.chaco.cloud/mcp'
export const LA_TOKEN_PREFIX = 'life_pat_'
/** 「미분류」 스페이스 키 — LA 일감 id(uuid)와 겹치지 않는다. */
export const LA_CATCH_ALL_KEY = 'la:unsorted'
/** `issue_list` 상한(도구 스키마 max 200). 상한에 닿은 목록은 `truncated` 로 알린다 — 커서가 없다(L1c). */
const LIST_LIMIT = 200
/** 프로젝트 → 체크포인트 → bug → task 를 넘는 깊이는 없다고 보지 않고, 넉넉히 내려가되 끝은 둔다. */
const MAX_DEPTH = 5
/**
 * LA 의 부모 규칙(issue.service `checkParentRule`): task 의 부모 = project·checkpoint·bug · bug 의 부모 = project·checkpoint(또는 없음)
 * · checkpoint 의 부모 = project · project 는 부모 없음. → **자식을 가질 수 있는 것은 project·checkpoint·bug** 이고 task 만 잎이다(R1-A).
 */
const PARENT_KINDS = new Set<LaIssue['kind']>(['project', 'checkpoint', 'bug'])
/** LA SDK 경로의 scope 부족 — HTTP 200 · `isError: true` · text `missing scope: issue:write`(mcp.service `ensureIssueScope`). */
const MISSING_SCOPE = /^missing scope: ([a-z_]+:[a-z_]+)$/

export const LA_DESCRIPTOR: WorkSourceDescriptor = {
  id: LA_SOURCE_ID,
  name: 'LA',
  mono: 'LA',
  addLabel: '+ LA 토큰',
  formTitle: 'LA 연결',
  tokenLabel: 'LA 개인 토큰',
  tokenPrefix: LA_TOKEN_PREFIX,
}

export const LA_CAPABILITIES: WorkCapabilities = {
  transition: { mode: 'any' },
  placement: { state: 'on' },
  relations: { state: 'on' },
  parentChange: { state: 'on' },
  order: { state: 'disabled', reason: 'LA 에는 순서를 바꾸는 MCP 도구가 없습니다 (LIFE-612).' },
  cursorPaging: { state: 'disabled', reason: 'LA 목록은 커서 페이지가 없습니다 — 한 번에 최대 200건 (L1c).' },
  conflictCheck: { state: 'disabled', reason: 'LA 는 조건부 수정을 받지 않습니다 — 동시 편집 충돌을 검사하지 못합니다 (L1b).' },
  comments: { state: 'disabled', reason: 'LA 에는 코멘트·변경 이력이 아직 없습니다 (L1e).' },
  workLinkStore: { state: 'disabled', reason: 'LA 에 작업 링크를 저장할 자리가 아직 없습니다 (L1a).' },
}

const KIND_LABELS: Record<'checkpoint' | 'task' | 'bug', string> = { checkpoint: 'Checkpoint', task: 'Task', bug: 'Bug' }
const KINDS: WorkKind[] = Object.entries(KIND_LABELS).map(([key, label]) => ({ key, label }))

type Step<T> = { ok: true; value: T } | { ok: false; outcome: WorkOutcome }

export function laSourceEntry({ url, clientVersion, fetchImpl, timeoutMs }: { url: string; clientVersion: string; fetchImpl?: typeof fetch; timeoutMs?: number }): WorkSourceEntry {
  return {
    descriptor: LA_DESCRIPTOR,
    create: (token) => new LaSource(new McpHttpClient({ url, token, clientVersion, fetchImpl, timeoutMs, toolError: laToolError })),
  }
}

/** LA 도구 오류 중 아는 모양 — scope 부족은 권한 부족(R1-B). 범위 이름은 정해진 꼴(`issue:write`)만 문구에 옮긴다. 나머지는 공통 분류로. */
export function laToolError(text: string): WorkError | null {
  const match = MISSING_SCOPE.exec(text.trim())
  if (match === null) return null
  return workError({ kind: 'forbidden', message: `연결은 됐지만 이 토큰에 ${match[1]} 범위가 없습니다. 토큰 범위(scope)를 확인하세요.` })
}

export class LaSource implements WorkSourceClient {
  private readonly mcp: McpHttpClient

  constructor(mcp: McpHttpClient) {
    this.mcp = mcp
  }

  capabilities(): WorkCapabilities {
    return LA_CAPABILITIES
  }

  close(): void {
    this.mcp.close()
  }

  async call(call: WorkCall): Promise<WorkOutcome> {
    switch (call.op) {
      case 'listSpaces': return this.listSpaces()
      case 'listStatuses': {
        const statuses = await this.statuses()
        return statuses.ok ? { ok: true, result: { op: 'listStatuses', statuses: statuses.value.map(toStatus), kinds: KINDS } } : statuses.outcome
      }
      case 'listItems':
        if (call.cursor !== null) return unsupported('cursorPaging')
        return this.listItems(call.spaceKey)
      case 'getItem': {
        const item = await this.item(call.itemId)
        return item.ok ? { ok: true, result: { op: 'getItem', item: item.value } } : item.outcome
      }
      case 'listTransitions': {
        const statuses = await this.statuses()
        return statuses.ok ? { ok: true, result: { op: 'listTransitions', statusKeys: statuses.value.map((status) => status.id) } } : statuses.outcome
      }
      case 'changeStatus':
        if (call.ifVersion !== null) return unsupported('conflictCheck')
        return this.changeStatus({ itemId: call.itemId, statusKey: call.statusKey })
      case 'setPlacement': {
        if (call.ifVersion !== null) return unsupported('conflictCheck')
        const updated = await this.tool({ name: 'issue_update', args: { id: call.itemId, onBoard: call.placement === 'board' }, read: readIssue })
        return updated.ok ? this.itemResult({ op: 'setPlacement', itemId: call.itemId }) : updated.outcome
      }
      case 'setParent': {
        if (call.ifVersion !== null) return unsupported('conflictCheck')
        // 스페이스 바로 아래(null) = 그 프로젝트가 부모. 「미분류」 바로 아래 = 부모 없음.
        const parentId = call.parentId ?? (call.spaceKey === LA_CATCH_ALL_KEY ? null : call.spaceKey)
        const updated = await this.tool({ name: 'issue_update', args: { id: call.itemId, parentId }, read: readIssue })
        return updated.ok ? this.itemResult({ op: 'setParent', itemId: call.itemId }) : updated.outcome
      }
      case 'addRelation': return this.addRelation({ itemId: call.itemId, kind: call.kind, otherKey: call.otherKey })
      case 'removeRelation': {
        const deleted = await this.tool({ name: 'issue_link_delete', args: { linkId: call.relationId }, read: readLinkDeleted })
        return deleted.ok ? { ok: true, result: { op: 'removeRelation', relationId: deleted.value } } : deleted.outcome
      }
      case 'reorder': return unsupported('order')
      case 'listComments':
      case 'addComment':
        return unsupported('comments')
    }
  }

  private async tool<T>({ name, args, read }: { name: string; args: Record<string, unknown>; read: (value: unknown, path: string) => T }): Promise<Step<T>> {
    const outcome = await this.mcp.callTool({ name, args })
    if (!outcome.ok) return { ok: false, outcome: { ok: false, error: outcome.error } }
    try {
      return { ok: true, value: read(outcome.value, name) }
    } catch (error) {
      if (error instanceof LaShapeError) return { ok: false, outcome: { ok: false, error: workError({ kind: 'invalid_response', message: error.message }) } }
      throw error
    }
  }

  private statuses(): Promise<Step<LaStatus[]>> {
    return this.tool({ name: 'status_list', args: {}, read: readStatuses }).then((step) => (step.ok ? { ok: true, value: sortStatuses(step.value) } : step))
  }

  private list(args: Record<string, unknown>): Promise<Step<LaIssue[]>> {
    return this.tool({ name: 'issue_list', args: { archived: 'exclude', limit: LIST_LIMIT, ...args }, read: readIssues })
  }

  private async listSpaces(): Promise<WorkOutcome> {
    // 열린 수를 세려고 열린 task 와, 부모 사슬을 풀 수 있게 부모가 될 수 있는 것(project·checkpoint·bug) **전부**(완료 포함)를 받는다 — 5번, 병렬.
    const steps = await Promise.all([
      this.list({ kind: 'project' }),
      this.list({ kind: 'checkpoint' }),
      this.list({ kind: 'bug' }),
      this.list({ kind: 'task', categoryKey: 'todo' }),
      this.list({ kind: 'task', categoryKey: 'in_progress' }),
    ])
    const failed = steps.find((step) => !step.ok)
    if (failed !== undefined && !failed.ok) return failed.outcome
    const lists = steps.map((step) => (step.ok ? step.value : []))
    const [projects = [], checkpoints = [], bugs = [], ...openTasks] = lists
    const parents = new Map<string, LaIssue>()
    for (const issue of [...projects, ...checkpoints, ...bugs]) parents.set(issue.id, issue)
    const counts = new Map<string, number>()
    // 상한에 닿은 목록이 있거나 부모 사슬을 못 푼 열린 일감이 있으면 수를 믿을 수 없다 — 모든 스페이스의 수를 null(모름)로(R1-I).
    let countable = !lists.some((list) => list.length >= LIST_LIMIT)
    const openItems = [...checkpoints, ...bugs].filter((issue) => issue.statusCategoryKey !== 'done').concat(openTasks.flat())
    for (const issue of openItems) {
      const root = rootOf({ issue, parents })
      if (root === undefined) countable = false
      else counts.set(root, (counts.get(root) ?? 0) + 1)
    }
    const openCount = (key: string): number | null => (countable ? counts.get(key) ?? 0 : null)
    const spaces: WorkSpace[] = projects
      .filter((project) => project.kind === 'project' && project.statusCategoryKey !== 'done')
      .map((project) => ({ key: project.id, name: project.title, color: project.color, description: null, openCount: openCount(project.id), role: 'regular' }))
    spaces.push({ key: LA_CATCH_ALL_KEY, name: '미분류', color: null, description: '어느 프로젝트에도 속하지 않은 작업', openCount: openCount(LA_CATCH_ALL_KEY), role: 'catch_all' })
    return { ok: true, result: { op: 'listSpaces', spaces, capabilities: LA_CAPABILITIES } }
  }

  private async listItems(spaceKey: string): Promise<WorkOutcome> {
    let truncated = false
    let roots: LaIssue[]
    let rootParent: string | null
    if (spaceKey === LA_CATCH_ALL_KEY) {
      const steps = await Promise.all(['checkpoint', 'task', 'bug'].map((kind) => this.list({ kind })))
      const failed = steps.find((step) => !step.ok)
      if (failed !== undefined && !failed.ok) return failed.outcome
      const lists = steps.map((step) => (step.ok ? step.value : []))
      truncated = lists.some((list) => list.length >= LIST_LIMIT)
      roots = lists.flat().filter((issue) => issue.parentId === null)
      rootParent = null
    } else {
      const space = await this.tool({ name: 'issue_get', args: { id: spaceKey }, read: readIssueDetail })
      if (!space.ok) return space.outcome
      if (space.value.kind !== 'project') return { ok: false, error: workError({ kind: 'rejected', message: `${space.value.displayId} 는 스페이스(프로젝트)가 아닙니다.` }) }
      const children = await this.list({ parentId: spaceKey })
      if (!children.ok) return children.outcome
      truncated = children.value.length >= LIST_LIMIT
      roots = children.value
      rootParent = spaceKey
    }
    const collected = new Map<string, LaIssue>()
    let frontier = roots.filter((issue) => issue.kind !== 'project')
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
      for (const issue of frontier) collected.set(issue.id, issue)
      // 자식을 가질 수 있는 것만 내려간다 — task 만 잎이다(bug 아래에도 task 가 있다).
      const parents = frontier.filter((issue) => PARENT_KINDS.has(issue.kind))
      const steps = await Promise.all(parents.map((issue) => this.list({ parentId: issue.id })))
      const failed = steps.find((step) => !step.ok)
      if (failed !== undefined && !failed.ok) return failed.outcome
      const next = steps.flatMap((step) => (step.ok ? step.value : []))
      if (steps.some((step) => step.ok && step.value.length >= LIST_LIMIT)) truncated = true
      frontier = next.filter((issue) => issue.kind !== 'project' && !collected.has(issue.id))
    }
    const items = [...collected.values()].map((issue) => toItem({ issue, spaceKey, rootParent }))
    return { ok: true, result: { op: 'listItems', items, nextCursor: null, truncated } }
  }

  /** 단건 — 부모 사슬을 올라가 스페이스를 찾는다(프로젝트를 만나면 그 프로젝트, 부모가 끊기면 미분류). */
  private async item(itemId: string): Promise<Step<WorkItem>> {
    const got = await this.tool({ name: 'issue_get', args: { id: itemId }, read: readIssueDetail })
    if (!got.ok) return got
    const issue = got.value
    if (issue.kind === 'project') {
      return { ok: false, outcome: { ok: false, error: workError({ kind: 'rejected', message: `${issue.displayId} 는 스페이스(프로젝트)라 작업으로 열 수 없습니다.` }) } }
    }
    let parentId = issue.parentId
    let spaceKey = LA_CATCH_ALL_KEY
    let rootParent: string | null = null
    for (let depth = 0; depth < MAX_DEPTH && parentId !== null; depth += 1) {
      const parent = await this.tool({ name: 'issue_get', args: { id: parentId }, read: readIssueDetail })
      if (!parent.ok) return parent
      if (parent.value.kind === 'project') {
        spaceKey = parent.value.id
        rootParent = parent.value.id
        break
      }
      parentId = parent.value.parentId
    }
    return { ok: true, value: toItem({ issue, spaceKey, rootParent }) }
  }

  private async itemResult({ op, itemId }: { op: 'changeStatus' | 'setPlacement' | 'setParent'; itemId: string }): Promise<WorkOutcome> {
    const item = await this.item(itemId)
    return item.ok ? { ok: true, result: { op, item: item.value } } : item.outcome
  }

  private async changeStatus({ itemId, statusKey }: { itemId: string; statusKey: string }): Promise<WorkOutcome> {
    const [statuses, current] = await Promise.all([this.statuses(), this.tool({ name: 'issue_get', args: { id: itemId }, read: readIssueDetail })])
    if (!statuses.ok) return statuses.outcome
    if (!current.ok) return current.outcome
    const order = statuses.value
    const target = order.find((status) => status.id === statusKey)
    if (target === undefined) return { ok: false, error: workError({ kind: 'rejected', message: '없는 상태입니다.' }) }
    const from = order.findIndex((status) => status.id === current.value.statusId)
    const to = order.indexOf(target)
    if (from === to) return this.itemResult({ op: 'changeStatus', itemId })
    const labelUnique = order.filter((status) => status.label === target.label).length === 1
    if (to > from && labelUnique) {
      const args: Record<string, unknown> = { id: itemId, toStatusLabel: target.label, forwardOnly: true }
      if (target.categoryKey === 'done') args.resolution = 'completed'
      const moved = await this.tool({ name: 'issue_transition', args, read: readTransition })
      if (!moved.ok) return moved.outcome
      if (moved.value.transitioned) return this.itemResult({ op: 'changeStatus', itemId })
      // 서버가 「뒤로」 라고 보면(순서 해석이 갈림) 되돌리기 경로로 — D6 은 둘 다 허용한다.
    }
    const args: Record<string, unknown> = { id: itemId, statusId: target.id }
    if (target.categoryKey !== 'done' && current.value.statusCategoryKey === 'done') args.resolution = null
    if (target.categoryKey === 'done' && current.value.statusCategoryKey !== 'done') args.resolution = 'completed'
    const updated = await this.tool({ name: 'issue_update', args, read: readIssue })
    return updated.ok ? this.itemResult({ op: 'changeStatus', itemId }) : updated.outcome
  }

  private async addRelation({ itemId, kind, otherKey }: { itemId: string; kind: WorkRelation['kind']; otherKey: string }): Promise<WorkOutcome> {
    const match = /^LIFE-(\d+)$/i.exec(otherKey.trim())
    if (match === null) return { ok: false, error: workError({ kind: 'rejected', message: `LA 작업 키는 LIFE-N 꼴입니다 (${otherKey.slice(0, 40)}).` }) }
    const issue = await this.tool({ name: 'issue_get', args: { id: itemId }, read: readIssueDetail })
    if (!issue.ok) return issue.outcome
    const otherSeq = Number(match[1])
    if (otherSeq === issue.value.sequentialId) return { ok: false, error: workError({ kind: 'rejected', message: '자기 자신과는 연결할 수 없습니다.' }) }
    const created = await this.tool({ name: 'issue_link_create', args: { seq: issue.value.sequentialId, relation: kind, otherSeq }, read: readLink })
    if (!created.ok) return created.outcome
    const link = created.value
    return {
      ok: true,
      result: {
        op: 'addRelation',
        relation: { id: link.id, kind: link.relation, other: { id: link.issue.id, key: link.issue.displayId, title: link.issue.title, statusLabel: link.issue.statusLabel, category: link.issue.statusCategoryKey } },
      },
    }
  }
}

function unsupported(name: 'order' | 'cursorPaging' | 'conflictCheck' | 'comments'): WorkOutcome {
  const capability = LA_CAPABILITIES[name]
  const reason = capability.state === 'disabled' ? capability.reason : 'LA 는 이 연산을 하지 않습니다.'
  return { ok: false, error: workError({ kind: 'unsupported', message: reason }) }
}

/** 분류(todo < in_progress < done) → position 순. `status_list` 도 이 순서로 주지만 기대지 않는다. */
function sortStatuses(statuses: LaStatus[]): LaStatus[] {
  const rank = { todo: 0, in_progress: 1, done: 2 }
  return [...statuses].sort((a, b) => rank[a.categoryKey] - rank[b.categoryKey] || a.position - b.position)
}

function toStatus(status: LaStatus, index: number): WorkStatus {
  return { key: status.id, label: status.label, category: status.categoryKey, order: index, color: status.color }
}

function rootOf({ issue, parents }: { issue: LaIssue; parents: Map<string, LaIssue> }): string | undefined {
  let cursor: LaIssue | undefined = issue
  for (let depth = 0; depth <= MAX_DEPTH && cursor !== undefined; depth += 1) {
    if (cursor.kind === 'project') return cursor.id
    if (cursor.parentId === null) return LA_CATCH_ALL_KEY
    cursor = parents.get(cursor.parentId)
  }
  return undefined
}

function toItem({ issue, spaceKey, rootParent }: { issue: LaIssue; spaceKey: string; rootParent: string | null }): WorkItem {
  const kindKey = issue.kind === 'project' ? 'task' : issue.kind
  return {
    id: issue.id,
    key: issue.displayId,
    spaceKey,
    title: issue.title,
    body: issue.description,
    kind: { key: kindKey, label: KIND_LABELS[kindKey] },
    statusKey: issue.statusId,
    category: issue.statusCategoryKey,
    priority: issue.priority,
    dueAt: issue.dueAt,
    parentId: issue.parentId === rootParent ? null : issue.parentId,
    placement: issue.onBoard === null ? null : issue.onBoard ? 'board' : 'backlog',
    rank: issue.position,
    openBlockerCount: issue.openBlockerCount,
    updatedAt: issue.updatedAt,
    version: null,
    relations: issue.links === null
      ? null
      : issue.links.map((link) => ({
          id: link.id,
          kind: link.relation,
          other: { id: link.issue.id, key: link.issue.displayId, title: link.issue.title, statusLabel: link.issue.statusLabel, category: link.issue.statusCategoryKey },
        })),
    workLinks: [],
  }
}
