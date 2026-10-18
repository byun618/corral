// LA MCP 응답 형태 검증 (LIFE-600 C3) — 도구 결과 JSON(unknown)을 **검증한 뒤에만** LA 모양으로 쓴다.
// 어긋나면 `LaShapeError(경로)` 를 던지고, 부르는 쪽(`la-source.ts`)이 `invalid_response` 로 바꾼다 — 조용히 지나가지 않는다.
// 칸 목록은 LA 도구 설명(issue_list·issue_get·status_list·issue_transition·issue_link_create)과 실측(u0-la.json)에서 왔다.
// **「null 허용」 과 「칸 없음」 을 가른다**(R1-F·R2-D) — 실제 LA 가 늘 싣는 칸은 값이 null 이어도 칸이 있어야 한다.
// 응답 계약은 셋이다(LA `issue.mapper.ts` · shared-types, 로컬 LA 4f8e273 대조):
//   - 목록 `issue_list` = `IssueSummary`(`toIssueSummary`) — 공통 칸 + `openBlockers`(원소 `{id, displayId, title, statusId, statusLabel}`), description 없음 → `readIssueSummary`
//   - 수정 `issue_update` = `IssueResponse`(`toIssueResponse`) — 공통 칸 + description, links·openBlockers 없음 → `readIssueUpdated`
//   - 단건 `issue_get` = `IssueResponse & { links, workLinks }` — 공통 칸 + description + links + 작업 링크(LIFE-609) → `readIssueDetail`
//   - 작업 링크 `issue_work_link_add`·`_remove`·`_list` = `{ workLinks: IssueWorkLinkResponse[] }` → `readWorkLinks`(LIFE-635 C1)
//   - 커서 쪽(LIFE-638 D11 — LA 610·611) = `{ items, nextCursor }` → `readIssuePage`·`readHistoryPage`·`readCommentPage`. `nextCursor` 는 비지 않은 글자 또는 null
//     (빈 글자는 LA `cursor` 입력이 받지 않는다 — 되돌려 보낼 수 없는 값이라 어긋남). 행 하나라도 어긋나면 쪽 전체가 어긋남.
// 공통 칸: parentId·priority·onBoard·position·dueAt·color·archivedAt(값 null 허용, 칸 필수) · updatedAt(글자) · version(글자 — LIFE-622, LA LIFE-607).
// LA 가 늘 주는 것 이상은 요구하지 않는다.

import { isRecord } from '../../shared/json.js'
import { readWorkCategory, readWorkPriority, readWorkRelationKind, type WorkCategory, type WorkComment, type WorkLink, type WorkLinkRecord, type WorkPriority, type WorkRelationKind, type WorkResolution } from '../../shared/work.js'

export class LaShapeError extends Error {
  readonly path: string
  constructor(path: string) {
    super(`LA 응답 모양이 어긋났습니다: ${path}`)
    this.path = path
  }
}

export const LA_KINDS = ['project', 'checkpoint', 'bug', 'task'] as const
export type LaKind = (typeof LA_KINDS)[number]

export type LaIssueRef = {
  id: string
  sequentialId: number
  displayId: string
  kind: LaKind
  title: string
  statusId: string
  statusCategoryKey: WorkCategory
  statusLabel: string
}

export type LaLink = { id: string; relation: WorkRelationKind; issue: LaIssueRef }

/** LA resolution 값(issue_update 스키마 enum) — 그 밖의 글자는 형태 어긋남이다(LIFE-602 E5). */
export const LA_RESOLUTIONS = ['completed', 'cancelled', 'archived', 'duplicate'] as const

/** 세 응답 계약이 늘 싣는 칸. */
export type LaIssueCore = LaIssueRef & {
  /** 완료 갈래(E5) — 완료함·취소함만 그대로, archived·duplicate 는 `other`. 칸이 없으면 null(옛 서버). */
  resolution: WorkResolution | null
  parentId: string | null
  priority: WorkPriority | null
  onBoard: boolean | null
  position: string | null
  dueAt: string | null
  color: string | null
  archivedAt: string | null
  updatedAt: string
  /** 판(LIFE-622) — LA `issue.mapper` 의 `String(issue.version)`. 불투명 글자: 산술·비교 없이 받은 그대로 `ifVersion` 으로 돌려보낸다. */
  version: string
}

/** 작업으로 바꿀 수 있는 일감 — 목록 행이면 description·links 가 null, 단건이면 채워진다. */
export type LaBlocker = { id: string; displayId: string; title: string }

export type LaIssue = LaIssueCore & {
  openBlockerCount: number
  /** 열린 막은 쪽 (E1 · LIFE-601) — 목록은 `openBlockers`, 단건은 links 의 완료 아닌 막힘에서. */
  openBlockers: LaBlocker[]
  description: string | null
  links: LaLink[] | null
}

/** 단건 — description 칸(null 허용)과 links·workLinks 배열이 반드시 있다. */
export type LaIssueDetail = LaIssue & { links: LaLink[]; workLinks: WorkLinkRecord[] }

/** `isDefault` = 그 분류의 기본 단계(LIFE-604 R2-G) — 칸이 없는 서버면 null. */
export type LaStatus = { id: string; categoryKey: WorkCategory; label: string; color: string | null; position: number; isDefault: boolean | null }

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new LaShapeError(path)
  return value
}

function str(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw new LaShapeError(`${path}.${key}`)
  return value
}

/** 칸이 있어야 한다(값은 null 일 수 있다). */
function present(source: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(source, key)) throw new LaShapeError(`${path}.${key}`)
  return source[key]
}

/** 칸이 있어야 하고 값은 글자 또는 null. */
function nullableStr(source: Record<string, unknown>, key: string, path: string): string | null {
  const value = present(source, key, path)
  if (value !== null && typeof value !== 'string') throw new LaShapeError(`${path}.${key}`)
  return value
}

/** 칸이 없어도 되는 글자(null 허용) — 계약이 늘 싣지 않는 칸만. */
function optionalStr(source: Record<string, unknown>, key: string, path: string): string | null {
  if (!Object.hasOwn(source, key)) return null
  return nullableStr(source, key, path)
}

function num(source: Record<string, unknown>, key: string, path: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new LaShapeError(`${path}.${key}`)
  return value
}

/** 상태 순서 — 숫자 또는 숫자 글자(일감 `position` 은 글자로 온다, u0-la.json). 그 밖은 어긋남. */
function position(source: Record<string, unknown>, path: string): number {
  const value = source.position
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) throw new LaShapeError(`${path}.position`)
  return parsed
}

function kindOf(value: unknown, path: string): LaKind {
  const kind = LA_KINDS.find((entry) => entry === value)
  if (kind === undefined) throw new LaShapeError(path)
  return kind
}

function categoryOf(value: unknown, path: string): WorkCategory {
  const category = readWorkCategory(value)
  if (category === null) throw new LaShapeError(path)
  return category
}

/**
 * 도구가 배열을 그대로 주거나 `{ items: [...] }` 로 감싸 준다 — 둘만 받는다. 감싼 모양에 다음 쪽(`nextCursor` 가 null 아님)이 있으면 어긋남이다 —
 * 한 번에 받는 자리에서 다음 쪽을 조용히 버리지 않는다(LIFE-638 F2). 쪽으로 받는 자리는 `readPage` 계열을 쓴다.
 */
export function readList(value: unknown, path: string): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value) && Array.isArray(value.items)) {
    if (value.nextCursor !== undefined && value.nextCursor !== null) throw new LaShapeError(`${path}.nextCursor`)
    return value.items
  }
  throw new LaShapeError(path)
}

/** 커서 쪽 하나 — 커서는 받은 글자 그대로(해석·변경 없음). */
export type LaPage<T> = { items: T[]; nextCursor: string | null }

function readPage<T>({ value, path, row }: { value: unknown; path: string; row: (value: unknown, path: string) => T }): LaPage<T> {
  const page = record(value, path)
  if (!Array.isArray(page.items)) throw new LaShapeError(`${path}.items`)
  const nextCursor = nullableStr(page, 'nextCursor', path)
  if (nextCursor === '') throw new LaShapeError(`${path}.nextCursor`)
  return { items: page.items.map((entry, index) => row(entry, `${path}.items[${index}]`)), nextCursor }
}

export function readIssueRef(value: unknown, path: string): LaIssueRef {
  const row = record(value, path)
  return {
    id: str(row, 'id', path),
    sequentialId: num(row, 'sequentialId', path),
    displayId: str(row, 'displayId', path),
    kind: kindOf(row.kind, `${path}.kind`),
    title: str(row, 'title', path),
    statusId: str(row, 'statusId', path),
    statusCategoryKey: categoryOf(row.statusCategoryKey, `${path}.statusCategoryKey`),
    statusLabel: str(row, 'statusLabel', path),
  }
}

export function readLink(value: unknown, path: string): LaLink {
  const row = record(value, path)
  const relation = readWorkRelationKind(row.relation)
  if (relation === null) throw new LaShapeError(`${path}.relation`)
  return { id: str(row, 'id', path), relation, issue: readIssueRef(row.issue, `${path}.issue`) }
}

function readCore(row: Record<string, unknown>, path: string): LaIssueCore {
  const priorityRaw = present(row, 'priority', path)
  const priority = priorityRaw === null ? null : readWorkPriority(priorityRaw)
  if (priorityRaw !== null && priority === null) throw new LaShapeError(`${path}.priority`)
  const onBoard = present(row, 'onBoard', path)
  if (onBoard !== null && typeof onBoard !== 'boolean') throw new LaShapeError(`${path}.onBoard`)
  return {
    ...readIssueRef(row, path),
    resolution: readResolution(row, path),
    parentId: nullableStr(row, 'parentId', path),
    priority,
    onBoard,
    position: nullableStr(row, 'position', path),
    dueAt: nullableStr(row, 'dueAt', path),
    color: nullableStr(row, 'color', path),
    archivedAt: nullableStr(row, 'archivedAt', path),
    updatedAt: str(row, 'updatedAt', path),
    // 칸이 없거나 글자가 아니면 어긋남 — 조용히 null(판 없음 = 무조건 저장)로 접지 않는다(C1).
    version: str(row, 'version', path),
  }
}

/**
 * resolution 칸(E5 · LIFE-602) — 칸이 없으면 null(늘 싣는 칸이 아니라고 본다). 있으면 null 또는 LA enum 글자여야 한다 — 모르는 값은 어긋남
 * (새 값이 조용히 「없음」 이 되지 않게). archived·duplicate 는 완료함·취소함 어느 쪽으로도 꾸미지 않는 `other`(G12).
 */
function readResolution(row: Record<string, unknown>, path: string): WorkResolution | null {
  if (!Object.hasOwn(row, 'resolution') || row.resolution === null) return null
  const value = LA_RESOLUTIONS.find((entry) => entry === row.resolution)
  if (value === undefined) throw new LaShapeError(`${path}.resolution`)
  return value === 'completed' || value === 'cancelled' ? value : 'other'
}

/** openBlockers 원소 — `IssueBlockerRef` 의 다섯 칸이 글자여야 한다. 카드 배지에 쓰는 셋을 돌려준다(E1). */
function readBlocker(value: unknown, path: string): LaBlocker {
  const row = record(value, path)
  for (const key of ['statusId', 'statusLabel']) str(row, key, path)
  return { id: str(row, 'id', path), displayId: str(row, 'displayId', path), title: str(row, 'title', path) }
}

/** 목록 행(`IssueSummary`) — openBlockers 필수(빈 배열 = 안 막힘). description·links 는 없다. */
export function readIssueSummary(value: unknown, path: string): LaIssue {
  const row = record(value, path)
  const core = readCore(row, path)
  const blockers = present(row, 'openBlockers', path)
  if (!Array.isArray(blockers)) throw new LaShapeError(`${path}.openBlockers`)
  const openBlockers = blockers.map((blocker, index) => readBlocker(blocker, `${path}.openBlockers[${index}]`))
  return { ...core, openBlockerCount: openBlockers.length, openBlockers, description: null, links: null }
}

/** 수정 응답(`IssueResponse`) — description 칸 필수. 부르는 쪽은 성공만 보고 단건을 다시 읽는다. */
export function readIssueUpdated(value: unknown, path: string): LaIssueCore {
  const row = record(value, path)
  nullableStr(row, 'description', path)
  return readCore(row, path)
}

/**
 * 생성 응답(`IssueResponse`, LIFE-604 R1-A) — 단건 재조회가 실패했을 때 이 값으로 최소 작업을 만든다. 막 만든 일감은 연결·막힘이 없다
 * (`issue_create` 는 연결을 받지 않는다) — 막힘 0 · 연결 빈 배열로 둔다.
 */
export function readIssueCreated(value: unknown, path: string): LaIssue {
  const row = record(value, path)
  const description = nullableStr(row, 'description', path)
  return { ...readCore(row, path), description, openBlockerCount: 0, openBlockers: [], links: [] }
}

const PULL_REQUEST_STATES = ['open', 'merged', 'closed'] as const

/**
 * 작업 링크 하나(LIFE-609 corral `WorkLink` 사본) — 종류마다 핵심 값(글자, 비지 않음) + 부가 값(칸 필수, null 허용). 모르는 종류·빠진 핵심 값·잘못된 타입은
 * 어긋남이다 — 조용히 버리지 않는다(LIFE-635 C1). 부가 값 칸이 없으면 어긋남(LA `toWorkLink` 는 늘 싣는다).
 */
function readWorkLink(value: unknown, path: string): WorkLink {
  const row = record(value, path)
  const key = (name: string): string => {
    const text = str(row, name, path)
    if (text.length === 0) throw new LaShapeError(`${path}.${name}`)
    return text
  }
  switch (row.kind) {
    case 'worktree': return { kind: 'worktree', path: key('path'), repoRoot: nullableStr(row, 'repoRoot', path) }
    case 'branch': return { kind: 'branch', name: key('name'), repoRoot: nullableStr(row, 'repoRoot', path) }
    case 'pull_request': {
      const state = present(row, 'state', path)
      const known = PULL_REQUEST_STATES.find((entry) => entry === state)
      if (state !== null && known === undefined) throw new LaShapeError(`${path}.state`)
      return { kind: 'pull_request', url: key('url'), state: known ?? null }
    }
    case 'agent_session': return { kind: 'agent_session', sessionId: key('sessionId'), agent: nullableStr(row, 'agent', path) }
    default: throw new LaShapeError(`${path}.kind`)
  }
}

/** 작업 링크 행(`IssueWorkLinkResponse`) — `{id, link, machine, repo, createdAt}`. machine·repo 는 칸 필수(null 허용) · createdAt 은 글자. */
function readWorkLinkRecord(value: unknown, path: string): WorkLinkRecord {
  const row = record(value, path)
  str(row, 'id', path)
  return { link: readWorkLink(row.link, `${path}.link`), machine: nullableStr(row, 'machine', path), repo: nullableStr(row, 'repo', path), createdAt: str(row, 'createdAt', path) }
}

/** `workLinks` 배열 칸 — 칸이 없거나 배열이 아니면 어긋남(빈 배열로 접지 않는다). 원소 하나라도 어긋나면 전체가 어긋남. */
function workLinksOf(row: Record<string, unknown>, path: string): WorkLinkRecord[] {
  const raw = present(row, 'workLinks', path)
  if (!Array.isArray(raw)) throw new LaShapeError(`${path}.workLinks`)
  return raw.map((entry, index) => readWorkLinkRecord(entry, `${path}.workLinks[${index}]`))
}

/** 작업 링크 도구 응답(`issue_work_link_add`·`_remove`·`_list`) — `{ workLinks: [...] }`. */
export function readWorkLinks(value: unknown, path: string): WorkLinkRecord[] {
  return workLinksOf(record(value, path), path)
}

/** 단건(`IssueResponse & { links, workLinks }`) — description 칸·links·workLinks 배열 필수. 미해소 막힘은 links 에서 센다. */
export function readIssueDetail(value: unknown, path: string): LaIssueDetail {
  const row = record(value, path)
  const core = readCore(row, path)
  const description = nullableStr(row, 'description', path)
  const raw = present(row, 'links', path)
  if (!Array.isArray(raw)) throw new LaShapeError(`${path}.links`)
  const links = raw.map((link, index) => readLink(link, `${path}.links[${index}]`))
  const openBlockers = links
    .filter((link) => link.relation === 'is_blocked_by' && link.issue.statusCategoryKey !== 'done')
    .map((link) => ({ id: link.issue.id, displayId: link.issue.displayId, title: link.issue.title }))
  return { ...core, openBlockerCount: openBlockers.length, openBlockers, description, links, workLinks: workLinksOf(row, path) }
}

/**
 * `issue_by_seq` — `{kind, data}`. 작업으로 쓸 수 있는 일감(checkpoint·bug·task)이면 그 id, 정상 제외(project·goal)·없음이면 null (E2).
 * 판별자를 검증한다(R1-P): 없음은 `{kind: null, data: null}` 일 때만 — kind 가 null 인데 data 가 있으면 모순이다. 모르는 kind 는 「없음」 이 아니라
 * 형태 오류다(LA 가 새 kind 를 들이면 조용히 「찾지 못함」 이 되지 않게). 제외 kind 도 data 는 레코드여야 한다.
 */
export function readBySeq(value: unknown, path: string): string | null {
  const row = record(value, path)
  const kind = row.kind
  if (kind === null) {
    if (row.data !== null) throw new LaShapeError(`${path}.data`)
    return null
  }
  if (typeof kind !== 'string') throw new LaShapeError(`${path}.kind`)
  const data = record(row.data, `${path}.data`)
  if (kind === 'project' || kind === 'goal') return null
  if (kind !== 'checkpoint' && kind !== 'bug' && kind !== 'task') throw new LaShapeError(`${path}.kind`)
  return str(data, 'id', `${path}.data`)
}

export function readIssueSummaries(value: unknown, path: string): LaIssue[] {
  return readList(value, path).map((row, index) => readIssueSummary(row, `${path}[${index}]`))
}

/** `issue_list` 커서 모드(LIFE-610) — 행은 배열 모드와 같은 `IssueSummary`. */
export function readIssuePage(value: unknown, path: string): LaPage<LaIssue> {
  return readPage({ value, path, row: readIssueSummary })
}

/**
 * 이력 한 행(LIFE-611 `IssueHistoryEntry`) — `{id, at, author, field, from, to, writeId, origin}`. 칸 이름은 글자로만 받고(계약 9칸 거르기는 출처가 한다),
 * from·to·writeId·author 는 칸 필수 · 글자 또는 null. `at` 은 날짜로 읽혀야 한다. `origin` 은 계약에 싣지 않아 보지 않는다(D8).
 */
export type LaHistoryEntry = { id: string; at: string; author: string | null; field: string; from: string | null; to: string | null; writeId: string | null }

function readHistoryEntry(value: unknown, path: string): LaHistoryEntry {
  const row = record(value, path)
  const at = str(row, 'at', path)
  if (!Number.isFinite(Date.parse(at))) throw new LaShapeError(`${path}.at`)
  return {
    id: str(row, 'id', path), at, author: nullableStr(row, 'author', path), field: str(row, 'field', path),
    from: nullableStr(row, 'from', path), to: nullableStr(row, 'to', path), writeId: nullableStr(row, 'writeId', path),
  }
}

export function readHistoryPage(value: unknown, path: string): LaPage<LaHistoryEntry> {
  return readPage({ value, path, row: readHistoryEntry })
}

/** 코멘트(LIFE-611 `IssueComment`) — 계약 `WorkComment` 네 칸만 읽는다. 본문은 받은 바이트 그대로(trim 없음). `createdAt` 은 이력 `at` 과 같이 날짜로 읽혀야 한다(r2 S2-2). */
export function readComment(value: unknown, path: string): WorkComment {
  const row = record(value, path)
  const createdAt = str(row, 'createdAt', path)
  if (!Number.isFinite(Date.parse(createdAt))) throw new LaShapeError(`${path}.createdAt`)
  return { id: str(row, 'id', path), author: nullableStr(row, 'author', path), body: str(row, 'body', path), createdAt }
}

export function readCommentPage(value: unknown, path: string): LaPage<WorkComment> {
  return readPage({ value, path, row: readComment })
}

export function readStatuses(value: unknown, path: string): LaStatus[] {
  return readList(value, path).map((entry, index) => {
    const at = `${path}[${index}]`
    const row = record(entry, at)
    return {
      id: str(row, 'id', at),
      categoryKey: categoryOf(row.categoryKey, `${at}.categoryKey`),
      label: str(row, 'label', at),
      color: optionalStr(row, 'color', at),
      position: position(row, at),
      isDefault: optionalBool(row, 'isDefault', at),
    }
  })
}

/** 칸이 없으면 null(옛 서버), 있으면 참·거짓만. */
function optionalBool(source: Record<string, unknown>, key: string, path: string): boolean | null {
  if (!Object.hasOwn(source, key)) return null
  const value = source[key]
  if (typeof value !== 'boolean') throw new LaShapeError(`${path}.${key}`)
  return value
}

export function readTransition(value: unknown, path: string): { transitioned: boolean; reason: string | null } {
  const row = record(value, path)
  if (typeof row.transitioned !== 'boolean') throw new LaShapeError(`${path}.transitioned`)
  return { transitioned: row.transitioned, reason: optionalStr(row, 'reason', path) }
}

export function readLinkDeleted(value: unknown, path: string): string {
  const row = record(value, path)
  if (row.deleted !== true) throw new LaShapeError(`${path}.deleted`)
  return str(row, 'linkId', path)
}
