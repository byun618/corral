// LA MCP 응답 형태 검증 (LIFE-600 C3) — 도구 결과 JSON(unknown)을 **검증한 뒤에만** LA 모양으로 쓴다.
// 어긋나면 `LaShapeError(경로)` 를 던지고, 부르는 쪽(`la-source.ts`)이 `invalid_response` 로 바꾼다 — 조용히 지나가지 않는다.
// 칸 목록은 LA 도구 설명(issue_list·issue_get·status_list·issue_transition·issue_link_create)과 실측(u0-la.json)에서 왔다.
// **「null 허용」 과 「칸 없음」 을 가른다**(R1-F·R2-D) — 실제 LA 가 늘 싣는 칸은 값이 null 이어도 칸이 있어야 한다.
// 응답 계약은 셋이다(LA `issue.mapper.ts` · shared-types, 로컬 LA 4f8e273 대조):
//   - 목록 `issue_list` = `IssueSummary`(`toIssueSummary`) — 공통 칸 + `openBlockers`(원소 `{id, displayId, title, statusId, statusLabel}`), description 없음 → `readIssueSummary`
//   - 수정 `issue_update` = `IssueResponse`(`toIssueResponse`) — 공통 칸 + description, links·openBlockers 없음 → `readIssueUpdated`
//   - 단건 `issue_get` = `IssueResponse & { links }` — 공통 칸 + description + links → `readIssueDetail`
// 공통 칸: parentId·priority·onBoard·position·dueAt·color·archivedAt(값 null 허용, 칸 필수) · updatedAt(글자). LA 가 늘 주는 것 이상은 요구하지 않는다.

import { isRecord } from '../../shared/json.js'
import { readWorkCategory, readWorkPriority, readWorkRelationKind, type WorkCategory, type WorkPriority, type WorkRelationKind } from '../../shared/work.js'

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

/** 세 응답 계약이 늘 싣는 칸. */
export type LaIssueCore = LaIssueRef & {
  parentId: string | null
  priority: WorkPriority | null
  onBoard: boolean | null
  position: string | null
  dueAt: string | null
  color: string | null
  archivedAt: string | null
  updatedAt: string
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

/** 단건 — description 칸(null 허용)과 links 배열이 반드시 있다. */
export type LaIssueDetail = LaIssue & { links: LaLink[] }

export type LaStatus = { id: string; categoryKey: WorkCategory; label: string; color: string | null; position: number }

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

/** 도구가 배열을 그대로 주거나 `{ items: [...] }` 로 감싸 준다 — 둘만 받는다. */
export function readList(value: unknown, path: string): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value) && Array.isArray(value.items)) return value.items
  throw new LaShapeError(path)
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
    parentId: nullableStr(row, 'parentId', path),
    priority,
    onBoard,
    position: nullableStr(row, 'position', path),
    dueAt: nullableStr(row, 'dueAt', path),
    color: nullableStr(row, 'color', path),
    archivedAt: nullableStr(row, 'archivedAt', path),
    updatedAt: str(row, 'updatedAt', path),
  }
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

/** 단건(`IssueResponse & { links }`) — description 칸·links 배열 필수. 미해소 막힘은 links 에서 센다. */
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
  return { ...core, openBlockerCount: openBlockers.length, openBlockers, description, links }
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
    }
  })
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
