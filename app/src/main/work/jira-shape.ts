// Jira REST 응답 검증 (LIFE-605 C3) — 쓰는 칸만 읽고, 어긋나면 `JiraShapeError(경로)` → 출처가 `invalid_response` 로. 모양은 공식 명세
// (`raw/claude/fixture-spec-map.md` — platform v3 · software agile)에서 가져왔다. 모르는 칸은 무시하고, 쓰는 칸이 빠지거나 타입이 다르면 오류다.

import { isRecord } from '../../shared/json.js'
import { readAdfDoc, type AdfDoc } from './adf.js'

export class JiraShapeError extends Error {
  readonly path: string
  constructor(path: string) {
    super(path)
    this.path = path
  }
}

type Obj = Record<string, unknown>

function obj(value: unknown, path: string): Obj {
  if (!isRecord(value)) throw new JiraShapeError(path)
  return value
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new JiraShapeError(path)
  return value
}

function optStr(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new JiraShapeError(path)
  return value
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new JiraShapeError(path)
  return value
}

function optNum(value: unknown, path: string): number | null {
  return value === undefined || value === null ? null : num(value, path)
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new JiraShapeError(path)
  return value
}

function optBool(value: unknown, path: string): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw new JiraShapeError(path)
  return value
}

/** id 칸 — Jira 는 글(숫자 글)로 준다. 숫자로 오면 글로 맞춘다. */
function id(value: unknown, path: string): string {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  return str(value, path)
}

/** offset 페이지(`startAt`·`maxResults`·`total`·`isLast`) — 다음 쪽이 있나. 칸이 없으면 끝으로 본다.
 * 빈 쪽인데 `isLast: false`·`total` 이 더 있다고 하면 「더 있음」 그대로 돌려준다 — 순회 쪽이 응답 어긋남으로 멈춘다(R1-E). */
export type OffsetPage<T> = { values: T[]; more: boolean }

function offsetMore({ page, startAt, count, path }: { page: Obj; startAt: number; count: number; path: string }): boolean {
  const isLast = optBool(page.isLast, `${path}.isLast`)
  if (isLast !== null) return !isLast
  const total = optNum(page.total, `${path}.total`)
  if (total !== null) return startAt + count < total
  return false
}

// --- 내 정보 · 프로젝트 · 종류 · 상태 ---

export function readMyself(value: unknown): { accountId: string; displayName: string | null } {
  const root = obj(value, 'myself')
  return { accountId: str(root.accountId, 'myself.accountId'), displayName: optStr(root.displayName, 'myself.displayName') }
}

export type JiraIssueType = { id: string; name: string; subtask: boolean; hierarchyLevel: number }

export function readIssueType(value: unknown, path: string): JiraIssueType {
  const root = obj(value, path)
  const subtask = optBool(root.subtask, `${path}.subtask`) ?? false
  // hierarchyLevel 이 없으면(옛 응답) subtask 여부로 −1/0 — 실제 사이트 확인 칸(F19).
  const level = optNum(root.hierarchyLevel, `${path}.hierarchyLevel`) ?? (subtask ? -1 : 0)
  return { id: id(root.id, `${path}.id`), name: str(root.name, `${path}.name`), subtask, hierarchyLevel: level }
}

export type JiraProject = { id: string; key: string; name: string; description: string | null; issueTypes: JiraIssueType[] | null }

export function readProject(value: unknown, path: string): JiraProject {
  const root = obj(value, path)
  const types = root.issueTypes === undefined ? null : arr(root.issueTypes, `${path}.issueTypes`).map((entry, index) => readIssueType(entry, `${path}.issueTypes[${index}]`))
  return { id: id(root.id, `${path}.id`), key: str(root.key, `${path}.key`), name: str(root.name, `${path}.name`), description: optStr(root.description, `${path}.description`), issueTypes: types }
}

export function readProjectPage({ value, startAt }: { value: unknown; startAt: number }): OffsetPage<JiraProject> {
  const page = obj(value, 'projects')
  const values = arr(page.values, 'projects.values').map((entry, index) => readProject(entry, `projects.values[${index}]`))
  return { values, more: offsetMore({ page, startAt, count: values.length, path: 'projects' }) }
}

export type JiraStatus = { id: string; name: string; categoryKey: string }

export function readStatus(value: unknown, path: string): JiraStatus {
  const root = obj(value, path)
  const category = obj(root.statusCategory, `${path}.statusCategory`)
  return { id: id(root.id, `${path}.id`), name: str(root.name, `${path}.name`), categoryKey: str(category.key, `${path}.statusCategory.key`) }
}

/** `/project/{p}/statuses` — 종류마다 상태 목록. */
export function readProjectStatuses(value: unknown): { typeId: string; statuses: JiraStatus[] }[] {
  return arr(value, 'statuses').map((entry, index) => {
    const root = obj(entry, `statuses[${index}]`)
    return { typeId: id(root.id, `statuses[${index}].id`), statuses: arr(root.statuses, `statuses[${index}].statuses`).map((status, at) => readStatus(status, `statuses[${index}].statuses[${at}]`)) }
  })
}

// --- 이슈 ---

export type JiraLinked = { id: string; key: string; summary: string; status: JiraStatus | null }
export type JiraLink = { id: string; typeName: string; inward: string; outward: string; direction: 'inward' | 'outward'; other: JiraLinked }

export type JiraIssue = {
  id: string
  key: string
  projectKey: string
  summary: string
  description: AdfDoc | null
  /** `description` 칸을 받았나 — 목록 요청은 싣지 않는다. */
  hasDescription: boolean
  issueType: JiraIssueType
  status: JiraStatus
  resolution: string | null
  /** 우선순위 — id 는 기본 우선순위(1–5) 대응에 쓴다(이름은 사이트 로케일 따라 바뀐다, R1-J). */
  priority: { id: string | null; name: string } | null
  duedate: string | null
  parentId: string | null
  updated: string
  /** 상태 분류가 마지막으로 바뀐 시각(ISO UTC) — `statuscategorychangedate`(비공식 칸, LIFE-711). 없거나 null·해석 불가면 null. */
  statusCategoryChangedAt: string | null
  links: JiraLink[]
  /** `issuelinks` 칸을 받았나(LIFE-623 R2-B) — 없으면 `links` 의 빈 배열은 「연결 없음」 이 아니라 「안 실음」 이다. */
  hasLinks: boolean
}

function readLinked(value: unknown, path: string): JiraLinked {
  const root = obj(value, path)
  const fields = root.fields === undefined ? {} : obj(root.fields, `${path}.fields`)
  return {
    id: id(root.id, `${path}.id`),
    key: str(root.key, `${path}.key`),
    summary: optStr(fields.summary, `${path}.fields.summary`) ?? '',
    status: fields.status === undefined || fields.status === null ? null : readStatus(fields.status, `${path}.fields.status`),
  }
}

function readLink(value: unknown, path: string): JiraLink {
  const root = obj(value, path)
  const type = obj(root.type, `${path}.type`)
  const inwardIssue = root.inwardIssue
  const outwardIssue = root.outwardIssue
  if ((inwardIssue === undefined) === (outwardIssue === undefined)) throw new JiraShapeError(`${path}.inwardIssue|outwardIssue`)
  return {
    id: id(root.id, `${path}.id`),
    typeName: str(type.name, `${path}.type.name`),
    inward: optStr(type.inward, `${path}.type.inward`) ?? '',
    outward: optStr(type.outward, `${path}.type.outward`) ?? '',
    direction: inwardIssue !== undefined ? 'inward' : 'outward',
    other: readLinked(inwardIssue ?? outwardIssue, `${path}.${inwardIssue !== undefined ? 'inwardIssue' : 'outwardIssue'}`),
  }
}

/**
 * 비공식 시각 칸(LIFE-711 `statuscategorychangedate`) — 모양이 어긋나도 이슈를 버리지 않는다: 문자열이 아니거나 Jira 시각 꼴로 해석되지 않으면 null.
 * 다른 칸처럼 `JiraShapeError` 로 던지면 칸 하나 때문에 목록 전체가 `invalid_response` 가 된다.
 * Jira 는 이 칸에 오프셋(`+0900` 꼴)을 싣는다고 가정한다 — 오프셋 없는 문자열은 `Date.parse` 가 실행 기계의 로컬 시각으로 읽는다.
 */
function instantOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

export function readIssue(value: unknown, path = 'issue'): JiraIssue {
  const root = obj(value, path)
  const fields = obj(root.fields, `${path}.fields`)
  const project = obj(fields.project, `${path}.fields.project`)
  const parent = fields.parent === undefined || fields.parent === null ? null : obj(fields.parent, `${path}.fields.parent`)
  const resolution = fields.resolution === undefined || fields.resolution === null ? null : str(obj(fields.resolution, `${path}.fields.resolution`).name, `${path}.fields.resolution.name`)
  const priorityBean = fields.priority === undefined || fields.priority === null ? null : obj(fields.priority, `${path}.fields.priority`)
  const priority = priorityBean === null ? null : { id: priorityBean.id === undefined || priorityBean.id === null ? null : id(priorityBean.id, `${path}.fields.priority.id`), name: str(priorityBean.name, `${path}.fields.priority.name`) }
  const hasDescription = Object.hasOwn(fields, 'description')
  let description: AdfDoc | null = null
  if (hasDescription) {
    description = readAdfDoc(fields.description)
    if (description === null) throw new JiraShapeError(`${path}.fields.description`)
  }
  const duedate = optStr(fields.duedate, `${path}.fields.duedate`)
  if (duedate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(duedate)) throw new JiraShapeError(`${path}.fields.duedate`)
  const updated = str(fields.updated, `${path}.fields.updated`)
  if (Number.isNaN(Date.parse(updated))) throw new JiraShapeError(`${path}.fields.updated`)
  return {
    id: id(root.id, `${path}.id`),
    key: str(root.key, `${path}.key`),
    projectKey: str(project.key, `${path}.fields.project.key`),
    summary: str(fields.summary, `${path}.fields.summary`),
    description,
    hasDescription,
    issueType: readIssueType(fields.issuetype, `${path}.fields.issuetype`),
    status: readStatus(fields.status, `${path}.fields.status`),
    resolution,
    priority,
    duedate,
    parentId: parent === null ? null : id(parent.id, `${path}.fields.parent.id`),
    updated,
    statusCategoryChangedAt: instantOrNull(fields.statuscategorychangedate),
    links: fields.issuelinks === undefined ? [] : arr(fields.issuelinks, `${path}.fields.issuelinks`).map((entry, index) => readLink(entry, `${path}.fields.issuelinks[${index}]`)),
    hasLinks: Object.hasOwn(fields, 'issuelinks'),
  }
}

/** `/search/jql` — 다음 쪽 토큰은 **칸이 없거나 null 이면 끝**(`isLast` 는 보지 않는다 — 안 오는 사례, F5). */
export function readSearch(value: unknown): { issues: JiraIssue[]; nextPageToken: string | null } {
  const root = obj(value, 'search')
  const issues = arr(root.issues, 'search.issues').map((entry, index) => readIssue(entry, `search.issues[${index}]`))
  const token = optStr(root.nextPageToken, 'search.nextPageToken')
  return { issues, nextPageToken: token === null || token.length === 0 ? null : token }
}

export function readCreated(value: unknown): { id: string; key: string } {
  const root = obj(value, 'created')
  return { id: id(root.id, 'created.id'), key: str(root.key, 'created.key') }
}

// --- 전이 ---

export type JiraFieldMeta = { key: string; name: string; required: boolean; hasDefaultValue: boolean; schemaType: string | null; schemaCustom: string | null; schemaSystem: string | null; allowedValues: { id: string; label: string }[] | null }

function readFieldMeta(value: unknown, key: string, path: string): JiraFieldMeta {
  const root = obj(value, path)
  const schema = root.schema === undefined ? {} : obj(root.schema, `${path}.schema`)
  const allowed = root.allowedValues === undefined ? null : arr(root.allowedValues, `${path}.allowedValues`).flatMap((entry, index) => {
    const option = obj(entry, `${path}.allowedValues[${index}]`)
    const label = optStr(option.value, `${path}.allowedValues[${index}].value`) ?? optStr(option.name, `${path}.allowedValues[${index}].name`)
    return option.id === undefined || label === null ? [] : [{ id: id(option.id, `${path}.allowedValues[${index}].id`), label }]
  })
  return {
    key: optStr(root.fieldId, `${path}.fieldId`) ?? optStr(root.key, `${path}.key`) ?? key,
    name: optStr(root.name, `${path}.name`) ?? key,
    required: optBool(root.required, `${path}.required`) ?? false,
    hasDefaultValue: optBool(root.hasDefaultValue, `${path}.hasDefaultValue`) ?? false,
    schemaType: optStr(schema.type, `${path}.schema.type`),
    schemaCustom: optStr(schema.custom, `${path}.schema.custom`),
    schemaSystem: optStr(schema.system, `${path}.schema.system`),
    allowedValues: allowed,
  }
}

export type JiraTransition = { id: string; name: string; to: JiraStatus; available: boolean; looped: boolean; fields: JiraFieldMeta[] }

export function readTransitions(value: unknown): JiraTransition[] {
  const root = obj(value, 'transitions')
  return arr(root.transitions, 'transitions.transitions').map((entry, index) => {
    const path = `transitions.transitions[${index}]`
    const transition = obj(entry, path)
    const fields = transition.fields === undefined ? {} : obj(transition.fields, `${path}.fields`)
    return {
      id: id(transition.id, `${path}.id`),
      name: optStr(transition.name, `${path}.name`) ?? '',
      to: readStatus(transition.to, `${path}.to`),
      available: optBool(transition.isAvailable, `${path}.isAvailable`) ?? true,
      looped: optBool(transition.looped, `${path}.looped`) ?? false,
      fields: Object.entries(fields).map(([key, field]) => readFieldMeta(field, key, `${path}.fields.${key}`)),
    }
  })
}

// --- 이력 · 코멘트 ---

export type JiraHistory = { id: string; created: string; author: string | null; writeId: string | null; items: { field: string; fieldId: string | null; from: string | null; to: string | null }[] }

const WRITE_ID = /^[A-Za-z0-9_-]{1,64}$/

export function readChangelogPage({ value, startAt }: { value: unknown; startAt: number }): OffsetPage<JiraHistory> {
  const page = obj(value, 'changelog')
  const values = arr(page.values, 'changelog.values').map((entry, index) => {
    const path = `changelog.values[${index}]`
    const history = obj(entry, path)
    const author = history.author === undefined || history.author === null ? null : optStr(obj(history.author, `${path}.author`).displayName, `${path}.author.displayName`)
    const meta = history.historyMetadata === undefined || history.historyMetadata === null ? null : obj(history.historyMetadata, `${path}.historyMetadata`)
    const extra = meta === null || meta.extraData === undefined ? null : obj(meta.extraData, `${path}.historyMetadata.extraData`)
    const raw = extra === null ? null : extra.corralWriteId
    const created = str(history.created, `${path}.created`)
    if (Number.isNaN(Date.parse(created))) throw new JiraShapeError(`${path}.created`)
    return {
      id: id(history.id, `${path}.id`),
      created,
      author,
      // 출처가 돌려준 메타 — 모양이 맞을 때만 쓰기 id 로 본다(지어낸 id 로 corral 기록을 지우지 않게).
      writeId: typeof raw === 'string' && WRITE_ID.test(raw) ? raw : null,
      items: arr(history.items, `${path}.items`).map((item, at) => {
        const row = obj(item, `${path}.items[${at}]`)
        return { field: str(row.field, `${path}.items[${at}].field`), fieldId: optStr(row.fieldId, `${path}.items[${at}].fieldId`), from: optStr(row.fromString, `${path}.items[${at}].fromString`), to: optStr(row.toString, `${path}.items[${at}].toString`) }
      }),
    }
  })
  return { values, more: offsetMore({ page, startAt, count: values.length, path: 'changelog' }) }
}

export type JiraComment = { id: string; author: string | null; body: AdfDoc; created: string }

export function readComment(value: unknown, path = 'comment'): JiraComment {
  const root = obj(value, path)
  const body = readAdfDoc(root.body)
  if (body === null) throw new JiraShapeError(`${path}.body`)
  const created = str(root.created, `${path}.created`)
  if (Number.isNaN(Date.parse(created))) throw new JiraShapeError(`${path}.created`)
  const author = root.author === undefined || root.author === null ? null : optStr(obj(root.author, `${path}.author`).displayName, `${path}.author.displayName`)
  return { id: id(root.id, `${path}.id`), author, body, created }
}

/** `PageOfComments` — `comments`·`startAt`·`total`(isLast 없음). */
export function readCommentPage({ value, startAt }: { value: unknown; startAt: number }): OffsetPage<JiraComment> {
  const page = obj(value, 'comments')
  const values = arr(page.comments, 'comments.comments').map((entry, index) => readComment(entry, `comments.comments[${index}]`))
  return { values, more: offsetMore({ page, startAt, count: values.length, path: 'comments' }) }
}

// --- 연결 종류 · 원격 링크 · 우선순위 · 생성 메타 · 보드 ---

export type JiraLinkType = { id: string; name: string; inward: string; outward: string }

export function readLinkTypes(value: unknown): JiraLinkType[] {
  const root = obj(value, 'issueLinkTypes')
  return arr(root.issueLinkTypes, 'issueLinkTypes.issueLinkTypes').map((entry, index) => {
    const path = `issueLinkTypes[${index}]`
    const type = obj(entry, path)
    return { id: id(type.id, `${path}.id`), name: str(type.name, `${path}.name`), inward: str(type.inward, `${path}.inward`), outward: str(type.outward, `${path}.outward`) }
  })
}

export function readPriorityPage({ value, startAt }: { value: unknown; startAt: number }): OffsetPage<{ id: string; name: string }> {
  const page = obj(value, 'priorities')
  const values = arr(page.values, 'priorities.values').map((entry, index) => {
    const priority = obj(entry, `priorities.values[${index}]`)
    return { id: id(priority.id, `priorities.values[${index}].id`), name: str(priority.name, `priorities.values[${index}].name`) }
  })
  return { values, more: offsetMore({ page, startAt, count: values.length, path: 'priorities' }) }
}

/** `/issue/createmeta/{p}/issuetypes/{id}` — 필드는 `fields`(명세 readOnly) 또는 `results`. */
export function readCreateMetaPage({ value, startAt }: { value: unknown; startAt: number }): OffsetPage<JiraFieldMeta> {
  const page = obj(value, 'createmeta')
  const raw = page.fields ?? page.results
  const values = arr(raw, 'createmeta.fields').map((entry, index) => readFieldMeta(entry, '', `createmeta.fields[${index}]`))
  if (values.some((field) => field.key === '')) throw new JiraShapeError('createmeta.fields[].fieldId')
  return { values, more: offsetMore({ page, startAt, count: values.length, path: 'createmeta' }) }
}

export function readBoardPage({ value, startAt }: { value: unknown; startAt: number }): OffsetPage<{ id: string; projectKey: string | null }> {
  const page = obj(value, 'boards')
  const values = arr(page.values, 'boards.values').map((entry, index) => {
    const board = obj(entry, `boards.values[${index}]`)
    const location = board.location === undefined || board.location === null ? null : obj(board.location, `boards.values[${index}].location`)
    return { id: id(board.id, `boards.values[${index}].id`), projectKey: location === null ? null : optStr(location.projectKey, `boards.values[${index}].location.projectKey`) }
  })
  return { values, more: offsetMore({ page, startAt, count: values.length, path: 'boards' }) }
}

/** Rank 207 — 이슈마다 상태. 하나라도 2xx 가 아니면 실패다. */
export function readRankEntries(value: unknown): { issueId: string; status: number }[] {
  const root = obj(value, 'rank')
  return arr(root.entries, 'rank.entries').map((entry, index) => {
    const row = obj(entry, `rank.entries[${index}]`)
    return { issueId: id(row.issueId, `rank.entries[${index}].issueId`), status: num(row.status, `rank.entries[${index}].status`) }
  })
}
