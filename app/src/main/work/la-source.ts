// LA(life-assistant) 작업 출처 (LIFE-600 킥오프 3 · C9) — MCP(`/mcp`, 무상태 Streamable HTTP) + 개인 토큰(PAT).
//
// 「LA 에서 스페이스 = project 일감」 은 **이 파일 안에서만** 안다(03-feature-plan §8.1 규칙 2):
//   - 열린(아카이브 아님 · 완료 분류 아님) project 일감 하나 = 스페이스 하나. 이름·색·설명이 스페이스 정보가 된다.
//   - 어느 프로젝트 트리에도 없는 일감(부모 없음)은 「미분류」 스페이스(`role: catch_all`)로 — 실재한다(00-analysis §3: 4건).
//   - 프로젝트를 부모로 둔 일감은 `parentId: null`(스페이스 바로 아래)로 낸다. 프로젝트 자신은 작업 목록에 섞이지 않는다.
//   - **보관(archive)** — 미보관 일감은 조상의 보관 여부와 무관하게 목록에 나온다(R2-C 계약). 조상 탐색(구조)은 보관 포함(`archived: 'all'`)으로,
//     표시는 미보관만. 보관된 부모는 보이지 않으므로 자식의 `parentId` 는 **가장 가까운 미보관 조상**(없으면 스페이스 바로 아래 = null)이다.
//     스페이스가 아닌 프로젝트(보관·완료) 아래 일감은 「미분류」 로 간다(01-criteria C9, 2026-10-13 사용자 재승인 — R3-D). 열린 수도 같은 규칙.
//     스페이스가 아니게 된 옛 프로젝트 키로 목록을 부르면 「스페이스 아님」(rejected).
// 상태: 모든 LA 스페이스가 같은 `status_list`. 앞으로 = `issue_transition`(forwardOnly) · 뒤로 = `issue_update(statusId)`(D6).
// 능력 꺼짐(L1 대기): 순서(L1f · LIFE-612) · 커서 페이지(L1c) · 조건부 수정(L1b) · 코멘트·이력(L1e) · 작업 링크 저장(L1a).
// 응답은 `la-shape.ts` 로 검증한 뒤에만 계약 타입으로 바꾼다(C3) — 어긋나면 `invalid_response`.
// LIFE-602 계약 확장: 필드 수정 = `issue_update`(title·description·priority·dueAt, PATCH) · 완료 갈래 = resolution(completed·cancelled) ·
// 자식 = `issue_list(parentId)`·`issue_create`(부모 규칙은 종류의 `childKinds` 로 알린다) · 연결 상대의 스페이스 = 상대의 부모 사슬(못 풀면 null) ·
// 이력은 꺼짐(L1e).
// LIFE-604 E10·E11: 만들기 = `issue_create`(description·statusId·priority·onBoard 명시) · 생성 메타 = 열린 상태 아무거나 · 필수 필드 없음.

import { createFieldsProblem } from '../../shared/work.js'
import type {
  WorkCall,
  WorkCreateMeta,
  WorkFieldPatch,
  WorkCapabilities,
  WorkError,
  WorkItem,
  WorkKind,
  WorkRelation,
  WorkResolutionChoice,
  WorkSourceDescriptor,
  WorkSpace,
  WorkStatus,
} from '../../shared/work.js'
import { unknownWriteOutcome, workError } from './errors.js'
import { readBySeq, readIssueCreated, readIssueDetail, readIssueSummaries, type LaIssueDetail, readIssueUpdated, readLink, readLinkDeleted, readStatuses, readTransition, LaShapeError, type LaIssue, type LaStatus } from './la-shape.js'
import { log } from '../log.js'
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
/** 같은 규칙의 작업 쪽 모양(E6) — 종류마다 그 아래에 만들 수 있는 자식 종류. task 는 잎. */
const CHILD_KINDS: Record<'checkpoint' | 'task' | 'bug', string[]> = { checkpoint: ['task', 'bug'], bug: ['task'], task: [] }
/** 연결 상대의 스페이스(E9)를 푸는 상한 — 넘는 상대는 null(모름). 단건 한 번에 RPC 가 끝없이 늘지 않게. */
const MAX_LINK_SPACES = 12
/** LA SDK 경로의 scope 부족 — HTTP 200 · `isError: true` · text `missing scope: issue:write`(mcp.service `ensureIssueScope`). */
const MISSING_SCOPE = /^missing scope: ([a-z_]+:[a-z_]+)$/
/** 문구에 옮겨도 되는 범위 이름 — 원격 글을 그대로 옮기지 않는다(R2-F). 이 밖의 범위도 권한 부족이지만 이름은 싣지 않는다. */
const KNOWN_SCOPES = new Set(['issue:read', 'issue:write'])
/** LA 사람 키 (E3) — `LIFE-<seq>`. 화면에는 descriptor 로 소스만 나간다. */
const LA_KEY = /^LIFE-(\d+)$/i

export const LA_DESCRIPTOR: WorkSourceDescriptor = {
  id: LA_SOURCE_ID,
  name: 'LA',
  mono: 'LA',
  addLabel: '+ LA 토큰',
  formTitle: 'LA 연결',
  tokenLabel: 'LA 개인 토큰',
  tokenPrefix: LA_TOKEN_PREFIX,
  keyPattern: 'LIFE-\\d+',
}

export const LA_CAPABILITIES: WorkCapabilities = {
  transition: { mode: 'any' },
  placement: { state: 'on' },
  relations: { state: 'on' },
  parentChange: { state: 'on' },
  order: { state: 'disabled', reason: 'LA 에는 순서를 바꾸는 MCP 도구가 없습니다 (LIFE-612).' },
  cursorPaging: { state: 'disabled', reason: 'LA 목록은 커서 페이지가 없습니다 — 한 번에 최대 200건 (L1c).' },
  conflictCheck: { state: 'disabled', reason: 'LA 는 조건부 수정을 받지 않습니다 — 동시 편집 충돌을 검사하지 못합니다 (L1b).' },
  comments: { state: 'disabled', reason: 'LA 에는 코멘트가 아직 없습니다 (L1e).' },
  history: { state: 'disabled', reason: 'LA 에는 변경 이력이 아직 없습니다 (L1e).' },
  workLinkStore: { state: 'disabled', reason: 'LA 에 작업 링크를 저장할 자리가 아직 없습니다 (L1a).' },
}

const KIND_LABELS: Record<'checkpoint' | 'task' | 'bug', string> = { checkpoint: 'Checkpoint', task: 'Task', bug: 'Bug' }
const KINDS: WorkKind[] = (['checkpoint', 'task', 'bug'] as const).map((key) => ({ key, label: KIND_LABELS[key], childKinds: [...CHILD_KINDS[key]] }))

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
  const scope = match[1] !== undefined && KNOWN_SCOPES.has(match[1]) ? `${match[1]} ` : ''
  return workError({ kind: 'forbidden', message: `연결은 됐지만 이 토큰에 ${scope}범위가 없습니다. 토큰 범위(scope)를 확인하세요.` })
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
      case 'findByKey': return this.findByKey(call.key)
      case 'listTransitions': {
        const statuses = await this.statuses()
        return statuses.ok ? { ok: true, result: { op: 'listTransitions', statusKeys: statuses.value.map((status) => status.id) } } : statuses.outcome
      }
      case 'changeStatus':
        if (call.ifVersion !== null) return unsupported('conflictCheck')
        return this.changeStatus({ itemId: call.itemId, statusKey: call.statusKey, resolution: call.resolution ?? null })
      case 'updateItem': {
        if (call.ifVersion !== null) return unsupported('conflictCheck')
        const updated = await this.tool({ name: 'issue_update', args: { id: call.itemId, ...updateArgs(call.fields) }, read: readIssueUpdated })
        return updated.ok ? this.itemResult({ op: 'updateItem', itemId: call.itemId }) : updated.outcome
      }
      case 'listChildren': return this.listChildren(call.itemId)
      case 'createItem': return this.createItem(call)
      case 'getCreateMeta': {
        const meta = await this.createMeta({ spaceKey: call.spaceKey, kindKey: call.kindKey })
        return meta.ok ? { ok: true, result: { op: 'getCreateMeta', meta: meta.value } } : meta.outcome
      }
      case 'listHistory': return unsupported('history')
      case 'setPlacement': {
        if (call.ifVersion !== null) return unsupported('conflictCheck')
        const updated = await this.tool({ name: 'issue_update', args: { id: call.itemId, onBoard: call.placement === 'board' }, read: readIssueUpdated })
        return updated.ok ? this.itemResult({ op: 'setPlacement', itemId: call.itemId }) : updated.outcome
      }
      case 'setParent': {
        if (call.ifVersion !== null) return unsupported('conflictCheck')
        // 스페이스 바로 아래(null) = 그 프로젝트가 부모. 「미분류」 바로 아래 = 부모 없음.
        const parentId = call.parentId ?? (call.spaceKey === LA_CATCH_ALL_KEY ? null : call.spaceKey)
        const updated = await this.tool({ name: 'issue_update', args: { id: call.itemId, parentId }, read: readIssueUpdated })
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
      case 'saveWorkLink':
      case 'removeWorkLink':
        return unsupported('workLinkStore')
    }
  }

  /** 자식(E6) — 이 일감을 부모로 둔 미보관 일감. 스페이스는 이 일감의 것(단건 경로로 푼다). */
  private async listChildren(itemId: string): Promise<WorkOutcome> {
    const parent = await this.item(itemId)
    if (!parent.ok) return parent.outcome
    const children = await this.list({ parentId: itemId, archived: 'exclude' })
    if (!children.ok) return children.outcome
    const items = children.value.filter((issue) => issue.kind !== 'project').map((issue) => toItem({ issue, spaceKey: parent.value.spaceKey, parentId: itemId }))
    return { ok: true, result: { op: 'listChildren', items } }
  }

  /**
   * 만들기(E6 · E10 LIFE-604). 부모 없음 = 스페이스 프로젝트 바로 아래(「미분류」 면 부모 없음).
   * 칸 전달: 본문 → description · 상태 → statusId · 우선순위 → priority · 배치 → onBoard. **onBoard 는 늘 명시한다(배치가 적용되는 task·checkpoint — bug 는 싣지 않음, R2-H)** — LA 기본이 백로그라
   * 미지정이면 보드 생성이 조용히 백로그로 간다(배치를 안 보낸 만들기 = 보드, T3 자식 추가 그대로). 상태를 안 보내면 LA 기본 상태.
   * 부모 규칙은 LA 서버가 다시 검증한다 — 여기서는 종류의 `childKinds` 밖·메타 밖 상태·필드를 보내기 전에 거절한다.
   */
  private async createItem(call: Extract<WorkCall, { op: 'createItem' }>): Promise<WorkOutcome> {
    const kind = laKind(call.kindKey)
    if (kind === null) return { ok: false, error: workError({ kind: 'rejected', message: '없는 종류입니다.' }) }
    const meta = await this.createMeta({ spaceKey: call.spaceKey, kindKey: kind })
    if (!meta.ok) return meta.outcome
    const problem = createFieldsProblem({ call, meta: meta.value })
    if (problem !== null) return { ok: false, error: workError({ kind: 'rejected', message: problem }) }
    if (call.parentId !== null) {
      const parent = await this.tool({ name: 'issue_get', args: { id: call.parentId }, read: readIssueDetail })
      if (!parent.ok) return parent.outcome
      const allowed = parent.value.kind === 'project' ? [] : CHILD_KINDS[parent.value.kind]
      if (!allowed.includes(kind)) return { ok: false, error: workError({ kind: 'rejected', message: `${KIND_LABELS[parent.value.kind === 'project' ? 'task' : parent.value.kind]} 아래에는 ${KIND_LABELS[kind]} 를 만들 수 없습니다.` }) }
    }
    const parentId = call.parentId ?? (call.spaceKey === LA_CATCH_ALL_KEY ? null : call.spaceKey)
    // 생성 요청은 다시 보내지 않는다 — 결과를 모르는 실패(시간 초과·끊김·깨진 답)는 「만들어졌을 수 있음」 으로 돌려준다(R1-A ⓑ).
    const sent = await this.mcp.callTool({ name: 'issue_create', args: createArgs({ call, kind, parentId }) })
    if (!sent.ok) return { ok: false, error: unknownWriteOutcome({ error: sent.error, unsent: sent.unsent === true }) }
    let created: LaIssue
    try {
      created = readIssueCreated(sent.value, 'issue_create')
    } catch (error) {
      if (error instanceof LaShapeError) return { ok: false, error: unknownWriteOutcome({ error: workError({ kind: 'invalid_response', message: error.message }), unsent: false }) }
      throw error
    }
    const item = await this.item(created.id)
    if (item.ok) return { ok: true, result: { op: 'createItem', item: item.value } }
    // 만들었는데 다시 읽지 못했다(R1-A ⓐ) — 실패로 돌려주면 사용자가 다시 만든다. 생성 응답과 보낸 스페이스·부모로 최소 작업을 돌려준다.
    log('work.create_reread_failed', { errorKind: item.outcome.ok ? null : item.outcome.error.kind })
    return { ok: true, result: { op: 'createItem', item: toItem({ issue: created, spaceKey: call.spaceKey, parentId: call.parentId }) } }
  }

  /** 생성 메타(E11) — LA 는 열린(완료 분류가 아닌) 상태 아무거나 · 기본 = 첫 할 일 상태 · 추가 필수 필드 없음. 종류만 확인한다. */
  private async createMeta({ spaceKey, kindKey }: { spaceKey: string; kindKey: string }): Promise<Step<WorkCreateMeta>> {
    if (laKind(kindKey) === null) return { ok: false, outcome: { ok: false, error: workError({ kind: 'rejected', message: '없는 종류입니다.' }) } }
    const statuses = await this.statuses()
    if (!statuses.ok) return statuses
    const open = statuses.value.filter((status) => status.categoryKey !== 'done')
    // 기본 = LA 가 정한 할 일 분류의 기본 단계(`isDefault`, R2-G — issue_create 의 「categoryKey 의 기본 단계」 와 같다). 칸이 없으면 위치 첫 할 일.
    const todo = open.filter((status) => status.categoryKey === 'todo')
    const first = todo.find((status) => status.isDefault === true) ?? todo[0] ?? open[0]
    if (first === undefined) return { ok: false, outcome: { ok: false, error: workError({ kind: 'rejected', message: '만들 수 있는 상태가 없습니다.' }) } }
    // 배치(R2-H): LA `onBoard` 는 task·checkpoint 만 의미(issue_create 스키마 설명) — bug 는 적용되지 않는다.
    const placement = kindKey === 'bug' ? 'ignored' : 'applies'
    const meta: WorkCreateMeta = { spaceKey, kindKey, statusKeys: open.map((status) => status.id), defaultStatusKey: first.id, placement, fields: [] }
    // 「미분류」 의 Checkpoint — LA 는 checkpoint 의 부모로 project 를 요구하는데 미분류에는 부모 프로젝트가 없다(R4-F). 화면은 그 종류를 흐린다.
    if (kindKey === 'checkpoint' && spaceKey === LA_CATCH_ALL_KEY) meta.unavailable = '「미분류」 에는 Checkpoint 를 만들 수 없습니다 — 부모 프로젝트가 필요합니다. 프로젝트 스페이스에서 만드세요.'
    return { ok: true, value: meta }
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

  /** 목록 — 기본은 보관 포함(조상 탐색용). 표시할 것만 고르는 일은 부르는 쪽이 `archivedAt` 으로 한다. */
  private list(args: Record<string, unknown>): Promise<Step<LaIssue[]>> {
    return this.tool({ name: 'issue_list', args: { archived: 'all', limit: LIST_LIMIT, ...args }, read: readIssueSummaries })
  }

  private async listSpaces(): Promise<WorkOutcome> {
    // 열린 수를 세려고 미보관 열린 task 와, 부모 사슬을 풀 수 있게 부모가 될 수 있는 것(project·checkpoint·bug) **전부**(완료·보관 포함)를 받는다 — 5번, 병렬.
    const steps = await Promise.all([
      this.list({ kind: 'project' }),
      this.list({ kind: 'checkpoint' }),
      this.list({ kind: 'bug' }),
      this.list({ kind: 'task', categoryKey: 'todo', archived: 'exclude' }),
      this.list({ kind: 'task', categoryKey: 'in_progress', archived: 'exclude' }),
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
    const openItems = [...checkpoints, ...bugs].filter((issue) => issue.statusCategoryKey !== 'done' && issue.archivedAt === null).concat(openTasks.flat())
    for (const issue of openItems) {
      const space = spaceOf({ issue, byId: parents })
      if (space === undefined) countable = false
      else counts.set(space, (counts.get(space) ?? 0) + 1)
    }
    const openCount = (key: string): number | null => (countable ? counts.get(key) ?? 0 : null)
    const spaces: WorkSpace[] = projects
      .filter(isSpace)
      .map((project) => ({ key: project.id, name: project.title, color: project.color, description: null, openCount: openCount(project.id), role: 'regular' }))
    spaces.push({ key: LA_CATCH_ALL_KEY, name: '미분류', color: null, description: '어느 프로젝트에도 속하지 않은 작업', openCount: openCount(LA_CATCH_ALL_KEY), role: 'catch_all' })
    return { ok: true, result: { op: 'listSpaces', spaces, capabilities: LA_CAPABILITIES } }
  }

  private async listItems(spaceKey: string): Promise<WorkOutcome> {
    if (spaceKey === LA_CATCH_ALL_KEY) return this.listCatchAll()
    const space = await this.tool({ name: 'issue_get', args: { id: spaceKey }, read: readIssueDetail })
    if (!space.ok) return space.outcome
    // 스페이스가 아닌 키(프로젝트가 아닌 일감 · 완료·보관돼 스페이스가 아니게 된 옛 프로젝트) = 「스페이스 아님」(R3-D) —
    // 그 아래 미보관 일감은 미분류에 나오고 단건도 미분류 키를 말한다. 옛 키로 그 프로젝트 키를 붙인 목록을 내지 않는다.
    if (!isSpace(space.value)) return { ok: false, error: workError({ kind: 'rejected', message: '이 키는 스페이스가 아닙니다 — 완료·보관된 프로젝트의 작업은 「미분류」 에 있습니다.' }) }
    const children = await this.list({ parentId: spaceKey })
    if (!children.ok) return children.outcome
    let truncated = children.value.length >= LIST_LIMIT
    // 구조는 보관 포함으로 내려간다 — 보관된 checkpoint·bug 아래 미보관 작업을 놓치지 않는다(R2-C).
    const collected = new Map<string, LaIssue>()
    let frontier = children.value.filter((issue) => issue.kind !== 'project')
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
    // 표시 부모를 풀 때 스페이스 프로젝트에 닿으면 바로 아래(null)다 — 사슬 지도에 프로젝트도 넣는다.
    const byId = new Map(collected).set(space.value.id, space.value)
    const items = [...collected.values()]
      .filter((issue) => issue.archivedAt === null)
      .map((issue) => toItem({ issue, spaceKey, parentId: visibleParent({ issue, byId }) }))
    return { ok: true, result: { op: 'listItems', items, nextCursor: null, truncated } }
  }

  /** 「미분류」 — 부모 사슬이 프로젝트에 닿지 않거나, 닿은 프로젝트가 스페이스가 아닌(보관·완료) 미보관 일감. 4번 받아 메모리에서 사슬을 푼다. */
  private async listCatchAll(): Promise<WorkOutcome> {
    const steps = await Promise.all(['project', 'checkpoint', 'task', 'bug'].map((kind) => this.list({ kind })))
    const failed = steps.find((step) => !step.ok)
    if (failed !== undefined && !failed.ok) return failed.outcome
    const lists = steps.map((step) => (step.ok ? step.value : []))
    const truncated = lists.some((list) => list.length >= LIST_LIMIT)
    const byId = new Map<string, LaIssue>()
    for (const issue of lists.flat()) byId.set(issue.id, issue)
    const items = [...byId.values()]
      .filter((issue) => issue.kind !== 'project' && issue.archivedAt === null && spaceOf({ issue, byId }) === LA_CATCH_ALL_KEY)
      .map((issue) => toItem({ issue, spaceKey: LA_CATCH_ALL_KEY, parentId: visibleParent({ issue, byId }) }))
    return { ok: true, result: { op: 'listItems', items, nextCursor: null, truncated } }
  }

  /** 단건 — 부모 사슬을 올라가 스페이스를 찾는다(스페이스인 프로젝트를 만나면 그 프로젝트, 아니면 미분류). 표시 부모 = 가장 가까운 미보관 조상. */
  private async item(itemId: string): Promise<Step<WorkItem>> {
    const memo: SpaceMemo = new Map()
    const got = await this.get({ id: itemId, memo })
    if (!got.ok) return got
    const issue = got.value
    if (issue.kind === 'project') {
      return { ok: false, outcome: { ok: false, error: workError({ kind: 'rejected', message: '스페이스(프로젝트)라 작업으로 열 수 없습니다.' }) } }
    }
    let parentId = issue.parentId
    let spaceKey = LA_CATCH_ALL_KEY
    let shownParent: string | null = null
    for (let depth = 0; depth < MAX_DEPTH && parentId !== null; depth += 1) {
      const parent = await this.get({ id: parentId, memo })
      if (!parent.ok) return parent
      if (parent.value.kind === 'project') {
        if (isSpace(parent.value)) spaceKey = parent.value.id
        break
      }
      if (shownParent === null && parent.value.archivedAt === null) shownParent = parent.value.id
      parentId = parent.value.parentId
    }
    const item = toItem({ issue, spaceKey, parentId: shownParent })
    // 연결 상대의 스페이스(E9) — 상대마다 부모 사슬을 올라간다(사슬은 memo 로 나눠 쓴다). 못 풀면 null(모름) — 단건 자체는 실패시키지 않는다.
    if (item.relations !== null && item.relations.length > 0) {
      const spaces = await Promise.all(item.relations.map((relation, index) => (index < MAX_LINK_SPACES ? this.spaceKeyOf({ id: relation.other.id, memo }) : Promise.resolve(null))))
      item.relations = item.relations.map((relation, index) => ({ ...relation, other: { ...relation.other, spaceKey: spaces[index] ?? null } }))
    }
    return { ok: true, value: item }
  }

  /** 단건 읽기 — 같은 연산 안에서 같은 id 를 두 번 읽지 않는다. */
  private get({ id, memo }: { id: string; memo: SpaceMemo }): Promise<Step<LaIssueDetail>> {
    const known = memo.get(id)
    if (known !== undefined) return known
    const pending = this.tool({ name: 'issue_get', args: { id }, read: readIssueDetail })
    memo.set(id, pending)
    return pending
  }

  /** 일감 하나의 스페이스 키 — 사슬이 스페이스 프로젝트에 닿으면 그 id, 부모 없음·스페이스 아닌 프로젝트면 미분류, 못 풀면 null. */
  private async spaceKeyOf({ id, memo }: { id: string; memo: SpaceMemo }): Promise<string | null> {
    let cursor: string | null = id
    for (let depth = 0; depth <= MAX_DEPTH && cursor !== null; depth += 1) {
      const step = await this.get({ id: cursor, memo })
      if (!step.ok) return null
      if (step.value.kind === 'project') return isSpace(step.value) ? step.value.id : LA_CATCH_ALL_KEY
      if (step.value.parentId === null) return LA_CATCH_ALL_KEY
      cursor = step.value.parentId
    }
    return null
  }

  /** 키로 찾기 (E2) — `issue_by_seq` 로 id 를 얻고 단건 경로(스페이스·표시 부모 풀기)로. 꼴이 아니거나 없으면 null(오류 아님). */
  private async findByKey(key: string): Promise<WorkOutcome> {
    const match = LA_KEY.exec(key.trim())
    if (match === null) return { ok: true, result: { op: 'findByKey', item: null } }
    const found = await this.tool({ name: 'issue_by_seq', args: { seq: Number(match[1]) }, read: readBySeq })
    if (!found.ok) return found.outcome
    if (found.value === null) return { ok: true, result: { op: 'findByKey', item: null } }
    const item = await this.item(found.value)
    return item.ok ? { ok: true, result: { op: 'findByKey', item: item.value } } : item.outcome
  }

  private async itemResult({ op, itemId }: { op: 'changeStatus' | 'setPlacement' | 'setParent' | 'updateItem'; itemId: string }): Promise<WorkOutcome> {
    const item = await this.item(itemId)
    return item.ok ? { ok: true, result: { op, item: item.value } } : item.outcome
  }

  /** `resolution` — 완료 분류로 갈 때의 갈래(E5). null 이면 완료함. 같은 완료 상태에서 갈래만 다르면 갈래만 바꾼다. */
  private async changeStatus({ itemId, statusKey, resolution }: { itemId: string; statusKey: string; resolution: WorkResolutionChoice | null }): Promise<WorkOutcome> {
    const [statuses, current] = await Promise.all([this.statuses(), this.tool({ name: 'issue_get', args: { id: itemId }, read: readIssueDetail })])
    if (!statuses.ok) return statuses.outcome
    if (!current.ok) return current.outcome
    const order = statuses.value
    const target = order.find((status) => status.id === statusKey)
    if (target === undefined) return { ok: false, error: workError({ kind: 'rejected', message: '없는 상태입니다.' }) }
    const from = order.findIndex((status) => status.id === current.value.statusId)
    const to = order.indexOf(target)
    const chosen = resolution ?? 'completed'
    if (from === to) {
      // 같은 상태 — 완료 분류에서 갈래만 다르면 갈래만 고친다(완료함 ↔ 취소함). 그 밖은 할 일 없음.
      if (target.categoryKey !== 'done' || resolution === null || current.value.resolution === resolution) return this.itemResult({ op: 'changeStatus', itemId })
      const updated = await this.tool({ name: 'issue_update', args: { id: itemId, resolution }, read: readIssueUpdated })
      return updated.ok ? this.itemResult({ op: 'changeStatus', itemId }) : updated.outcome
    }
    const labelUnique = order.filter((status) => status.label === target.label).length === 1
    if (to > from && labelUnique) {
      const args: Record<string, unknown> = { id: itemId, toStatusLabel: target.label, forwardOnly: true }
      if (target.categoryKey === 'done') args.resolution = chosen
      const moved = await this.tool({ name: 'issue_transition', args, read: readTransition })
      if (!moved.ok) return moved.outcome
      if (moved.value.transitioned) return this.itemResult({ op: 'changeStatus', itemId })
      // 서버가 「뒤로」 라고 보면(순서 해석이 갈림) 되돌리기 경로로 — D6 은 둘 다 허용한다.
    }
    const args: Record<string, unknown> = { id: itemId, statusId: target.id }
    if (target.categoryKey !== 'done' && current.value.statusCategoryKey === 'done') args.resolution = null
    if (target.categoryKey === 'done') args.resolution = chosen
    const updated = await this.tool({ name: 'issue_update', args, read: readIssueUpdated })
    return updated.ok ? this.itemResult({ op: 'changeStatus', itemId }) : updated.outcome
  }

  private async addRelation({ itemId, kind, otherKey }: { itemId: string; kind: WorkRelation['kind']; otherKey: string }): Promise<WorkOutcome> {
    const match = LA_KEY.exec(otherKey.trim())
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
        relation: {
          id: link.id,
          kind: link.relation,
          other: { id: link.issue.id, key: link.issue.displayId, title: link.issue.title, statusLabel: link.issue.statusLabel, category: link.issue.statusCategoryKey, spaceKey: await this.spaceKeyOf({ id: link.issue.id, memo: new Map() }) },
        },
      },
    }
  }
}

type SpaceMemo = Map<string, Promise<Step<LaIssueDetail>>>

function laKind(key: string): 'checkpoint' | 'task' | 'bug' | null {
  return key === 'checkpoint' || key === 'task' || key === 'bug' ? key : null
}

/** 만들기 → `issue_create` 인자. 보낸 칸만 옮기고 onBoard 는 늘(배치 없음 = 보드). 필수 필드는 메타 검사에서 이미 막혔다(LA 는 없음). */
function createArgs({ call, kind, parentId }: { call: Extract<WorkCall, { op: 'createItem' }>; kind: 'checkpoint' | 'task' | 'bug'; parentId: string | null }): Record<string, unknown> {
  const args: Record<string, unknown> = { kind, title: call.title, parentId }
  // onBoard 는 배치가 적용되는 종류(task·checkpoint)에 늘 명시한다 — bug 는 싣지 않는다(LA 가 쓰지 않는 칸, R2-H).
  if (kind !== 'bug') args.onBoard = (call.placement ?? 'board') === 'board'
  if (call.body !== undefined) args.description = call.body
  if (call.statusKey !== undefined) args.statusId = call.statusKey
  if (call.priority !== undefined) args.priority = call.priority
  return args
}

/** 필드 부분 수정 → `issue_update` 인자(PATCH — 보낸 칸만). 본문은 description. */
function updateArgs(fields: WorkFieldPatch): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  if (fields.title !== undefined) args.title = fields.title
  if (fields.body !== undefined) args.description = fields.body
  if (fields.priority !== undefined) args.priority = fields.priority
  if (fields.dueAt !== undefined) args.dueAt = fields.dueAt
  return args
}

function unsupported(name: 'order' | 'cursorPaging' | 'conflictCheck' | 'comments' | 'history' | 'workLinkStore'): WorkOutcome {
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

/** 스페이스가 되는 프로젝트 — 보관 아님 · 완료 분류 아님. */
function isSpace(issue: LaIssue): boolean {
  return issue.kind === 'project' && issue.archivedAt === null && issue.statusCategoryKey !== 'done'
}

/** 일감이 속한 스페이스 키 — 사슬이 스페이스 프로젝트에 닿으면 그 id, 부모 없음·스페이스 아닌 프로젝트면 미분류, 못 풀면 undefined. */
function spaceOf({ issue, byId }: { issue: LaIssue; byId: Map<string, LaIssue> }): string | undefined {
  let cursor: LaIssue | undefined = issue
  for (let depth = 0; depth <= MAX_DEPTH && cursor !== undefined; depth += 1) {
    if (cursor.kind === 'project') return isSpace(cursor) ? cursor.id : LA_CATCH_ALL_KEY
    if (cursor.parentId === null) return LA_CATCH_ALL_KEY
    cursor = byId.get(cursor.parentId)
  }
  return undefined
}

/** 화면의 부모 — 가장 가까운 미보관 조상 작업. 프로젝트·부모 없음에 닿으면 null(스페이스 바로 아래). 사슬이 끊기면 끊긴 id 를 그대로(목록은 truncated). */
function visibleParent({ issue, byId }: { issue: LaIssue; byId: Map<string, LaIssue> }): string | null {
  let parentId = issue.parentId
  for (let depth = 0; depth <= MAX_DEPTH && parentId !== null; depth += 1) {
    const parent = byId.get(parentId)
    if (parent === undefined) return parentId
    if (parent.kind === 'project') return null
    if (parent.archivedAt === null) return parent.id
    parentId = parent.parentId
  }
  return null
}

function toItem({ issue, spaceKey, parentId }: { issue: LaIssue; spaceKey: string; parentId: string | null }): WorkItem {
  const kindKey = issue.kind === 'project' ? 'task' : issue.kind
  return {
    id: issue.id,
    key: issue.displayId,
    spaceKey,
    title: issue.title,
    body: issue.description,
    kind: { key: kindKey, label: KIND_LABELS[kindKey], childKinds: [...CHILD_KINDS[kindKey]] },
    statusKey: issue.statusId,
    category: issue.statusCategoryKey,
    // 완료 갈래는 완료 분류일 때만 뜻이 있다 — 다른 분류에 남은 값은 버린다.
    resolution: issue.statusCategoryKey === 'done' ? issue.resolution : null,
    priority: issue.priority,
    dueAt: issue.dueAt,
    parentId,
    placement: issue.onBoard === null ? null : issue.onBoard ? 'board' : 'backlog',
    rank: issue.position,
    openBlockerCount: issue.openBlockerCount,
    openBlockers: issue.openBlockers.map((blocker) => ({ id: blocker.id, key: blocker.displayId, title: blocker.title })),
    updatedAt: issue.updatedAt,
    version: null,
    relations: issue.links === null
      ? null
      : issue.links.map((link) => ({
          id: link.id,
          kind: link.relation,
          other: { id: link.issue.id, key: link.issue.displayId, title: link.issue.title, statusLabel: link.issue.statusLabel, category: link.issue.statusCategoryKey, spaceKey: null },
        })),
    workLinks: [],
  }
}
