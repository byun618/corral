// LA MCP 응답 형태 검증 (LIFE-600 C3) — 도구 결과 JSON(unknown)을 **검증한 뒤에만** LA 모양으로 쓴다.
// 어긋나면 `LaShapeError(경로)` 를 던지고, 부르는 쪽(`la-source.ts`)이 `invalid_response` 로 바꾼다 — 조용히 지나가지 않는다.
// 칸 목록은 LA 도구 설명(issue_list·issue_get·status_list·issue_transition·issue_link_create)과 실측(u0-la.json)에서 왔다.

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

export type LaIssue = LaIssueRef & {
  parentId: string | null
  priority: WorkPriority | null
  onBoard: boolean | null
  position: string | null
  dueAt: string | null
  color: string | null
  updatedAt: string
  openBlockerCount: number
  /** issue_get 에서만 — 목록에는 없다(없으면 null). */
  description: string | null
  links: LaLink[] | null
}

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

function nullableStr(source: Record<string, unknown>, key: string, path: string): string | null {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new LaShapeError(`${path}.${key}`)
  return value
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

export function readIssue(value: unknown, path: string): LaIssue {
  const row = record(value, path)
  const ref = readIssueRef(row, path)
  const priorityRaw = row.priority ?? null
  const priority = priorityRaw === null ? null : readWorkPriority(priorityRaw)
  if (priorityRaw !== null && priority === null) throw new LaShapeError(`${path}.priority`)
  const onBoard = row.onBoard ?? null
  if (onBoard !== null && typeof onBoard !== 'boolean') throw new LaShapeError(`${path}.onBoard`)
  const parentId = row.parentId
  if (parentId !== null && typeof parentId !== 'string') throw new LaShapeError(`${path}.parentId`)
  const blockers = row.openBlockers
  if (blockers !== undefined && !Array.isArray(blockers)) throw new LaShapeError(`${path}.openBlockers`)
  const links = row.links
  if (links !== undefined && !Array.isArray(links)) throw new LaShapeError(`${path}.links`)
  const readLinks = links === undefined ? null : links.map((link, index) => readLink(link, `${path}.links[${index}]`))
  return {
    ...ref,
    parentId,
    priority,
    onBoard,
    position: nullableStr(row, 'position', path),
    dueAt: nullableStr(row, 'dueAt', path),
    color: nullableStr(row, 'color', path),
    updatedAt: str(row, 'updatedAt', path),
    // 목록 행에는 openBlockers 가, 단건에는 links 가 있다 — 단건이면 미해소 막힘을 links 에서 센다.
    openBlockerCount: blockers !== undefined
      ? blockers.length
      : (readLinks ?? []).filter((link) => link.relation === 'is_blocked_by' && link.issue.statusCategoryKey !== 'done').length,
    description: nullableStr(row, 'description', path),
    links: readLinks,
  }
}

export function readIssues(value: unknown, path: string): LaIssue[] {
  return readList(value, path).map((row, index) => readIssue(row, `${path}[${index}]`))
}

export function readStatuses(value: unknown, path: string): LaStatus[] {
  return readList(value, path).map((entry, index) => {
    const at = `${path}[${index}]`
    const row = record(entry, at)
    return {
      id: str(row, 'id', at),
      categoryKey: categoryOf(row.categoryKey, `${at}.categoryKey`),
      label: str(row, 'label', at),
      color: nullableStr(row, 'color', at),
      position: position(row, at),
    }
  })
}

export function readTransition(value: unknown, path: string): { transitioned: boolean; reason: string | null } {
  const row = record(value, path)
  if (typeof row.transitioned !== 'boolean') throw new LaShapeError(`${path}.transitioned`)
  return { transitioned: row.transitioned, reason: nullableStr(row, 'reason', path) }
}

export function readLinkDeleted(value: unknown, path: string): string {
  const row = record(value, path)
  if (row.deleted !== true) throw new LaShapeError(`${path}.deleted`)
  return str(row, 'linkId', path)
}
