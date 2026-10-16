// Jira Cloud 출처 (LIFE-605 · LIFE-372 묶음 T6) — REST v3 + Jira Software agile. 연결 = 사이트 · 이메일 · API 토큰(D5).
//
// 대응(design-notes §2–§14):
// - 스페이스 = 프로젝트(`/project/search` 모든 쪽) · 상태 = 종류별 상태의 합집합(같은 id 하나, 분류 → 처음 나온 순) · 종류 = issuetype(`hierarchyLevel` 로 자식 종류)
// - 목록 = `/search/jql`(커서 = `nextPageToken` 그대로, 칸 없으면 끝) · 단건 = `/issue/{id}` · 키 찾기 = `/issue/{KEY}`(404 = null)
// - 상태 변경 = 허용 전이(`/transitions`) 중 그 상태로 가는 첫 「채울 수 있는」 전이 · 필수 필드를 묻는 전이는 이유와 함께 막는다
// - 본문·코멘트 = ADF ↔ markdown(`adf.ts`) · 바꿀 수 없는 요소가 있으면 본문 편집 잠금(`bodyLock`), 체크 칸은 그 칸 상태만 바꾼다
// - 순서 = `PUT /rest/agile/1.0/issue/rank`(207 = 실패) · **스페이스마다** 보드가 있을 때만 켠다 · 배치(보드/백로그)는 켜지 않는다(부작용 — §7)
// - 쓰기(수정·전이)에 `historyMetadata.extraData.corralWriteId` 를 싣고 이력에서 되돌려 받는다(G10)
// - 질의 검색 = JQL, 400 이면 텍스트(`text ~`)로 다시 찾고 거부 사유를 `note` 로
// **자격은 검증한 `*.atlassian.net` 사이트에만** 보낸다(`normalizeJiraSite`) — 측정 실행만 `baseUrlOf` 로 fixture 주소를 쓴다.

import { randomUUID } from 'node:crypto'
import {
  createFieldsProblem,
  WORK_PRIORITIES,
  type WorkCall,
  type WorkCapabilities,
  type WorkCapability,
  type WorkCategory,
  type WorkComment,
  type WorkCreateField,
  type WorkCreateMeta,
  type WorkError,
  type WorkHistoryEntry,
  type WorkHistoryField,
  type WorkItem,
  type WorkKind,
  type WorkPriority,
  type WorkRelation,
  type WorkRelationKind,
  type WorkResolution,
  type WorkSourceDescriptor,
  type WorkSpace,
  type WorkStatus,
} from '../../shared/work.js'
import { adfToMarkdown, adfView, markdownToAdf, taskStates, unsupportedLabel, withTaskStates, type AdfDoc, type AdfNode } from './adf.js'
import { workError } from './errors.js'
import { errorText, JiraHttp, type JiraMethod, type JiraReply } from './jira-http.js'
import {
  JiraShapeError,
  readBoardPage,
  readChangelogPage,
  readComment,
  readCommentPage,
  readCreated,
  readCreateMetaPage,
  readIssue,
  readLinkTypes,
  readMyself,
  readPriorityPage,
  readProject,
  readProjectPage,
  readProjectStatuses,
  readRankEntries,
  readSearch,
  readTransitions,
  type JiraFieldMeta,
  type JiraIssue,
  type JiraIssueType,
  type JiraLinkType,
  type JiraProject,
  type JiraStatus,
  type JiraTransition,
  type OffsetPage,
} from './jira-shape.js'
import type { WorkCallMeta, WorkCredentials, WorkOutcome, WorkSourceClient, WorkSourceEntry } from './source.js'

export const JIRA_SOURCE_ID = 'jira'

/** Jira 사람 키 — 프로젝트 키(대문자로 시작, 대문자·숫자·`_`, 2자 이상) + `-숫자`. */
const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/

export const JIRA_DESCRIPTOR: WorkSourceDescriptor = {
  id: JIRA_SOURCE_ID,
  name: 'Jira Cloud',
  mono: 'J',
  addLabel: '+ Jira Cloud',
  formTitle: 'Jira Cloud 연결',
  accountFields: [
    { key: 'site', label: '사이트 URL', placeholder: 'https://your-team.atlassian.net', hint: 'https://<이름>.atlassian.net 주소 — 사용자 지정 도메인은 아직 받지 않습니다.', input: 'url', shownIn: 'title', fixedOnReplace: true },
    { key: 'email', label: '이메일', placeholder: 'you@company.com', hint: 'API 토큰을 만든 Atlassian 계정 이메일', input: 'email', shownIn: 'meta', fixedOnReplace: false },
  ],
  tokenLabel: 'API 토큰',
  tokenHint: 'id.atlassian.com › 보안 › API 토큰에서 만든 스코프 없는 토큰. 기본 만료 1년.',
  tokenPrefix: null,
  keyPattern: '[A-Z][A-Z0-9_]+-\\d+',
  // 비교 연산자 · `in (` · `is [not] empty|null` · `order by` (R1-D — `project in (A, B)`·`assignee is EMPTY` 도 질의로). 글자만 있는 검색은 글로.
  queryPattern: '[=~<>]|\\b(?:not\\s+)?in\\s*\\(|\\bis\\s+(?:not\\s+)?(?:empty|null)\\b|\\border\\s+by\\b',
}

const ORDER_OFF_NO_SOFTWARE = '이 사이트에는 Jira Software(보드·Rank)가 없어 순서를 바꿀 수 없습니다.'
const ORDER_OFF_NO_BOARD = '이 스페이스(프로젝트)에 보드가 없어 순서(Rank)를 바꿀 수 없습니다 — Jira 에서 보드를 만들면 켜집니다.'
const ORDER_OFF_FORBIDDEN = '보드를 볼 권한이 없어 이 사이트의 순서(Rank)를 쓸 수 없습니다.'

export const JIRA_CAPABILITIES: WorkCapabilities = {
  transition: { mode: 'allowed' },
  placement: { state: 'disabled', reason: 'Jira 의 보드/백로그 이동은 상태 전이·스프린트를 함께 바꿉니다 — corral 은 옮기지 않습니다. Jira 에서 옮기세요.' },
  relations: { state: 'on' },
  parentChange: { state: 'on' },
  // 스페이스마다 좁힌다(보드 유무) — `WorkSpace.capabilities.order`.
  order: { state: 'on' },
  cursorPaging: { state: 'on' },
  conflictCheck: { state: 'disabled', reason: 'Jira 는 조건부 수정을 받지 않습니다 — 동시 편집 충돌을 검사하지 못합니다(마지막 저장이 남습니다).' },
  comments: { state: 'on' },
  history: { state: 'on' },
  workLinkStore: { state: 'disabled', reason: 'Jira 에는 작업 링크(worktree·브랜치)를 남기지 않습니다 — 로컬 경로가 팀이 보는 이슈에 자동으로 기록되기 때문입니다. 링크는 이 Mac 의 corral 에만 있습니다.' },
  resolution: { state: 'disabled', reason: 'Jira 의 해결(resolution) 값은 워크플로가 정합니다 — corral 은 「완료함/취소함」 을 고르지 않습니다.' },
  querySearch: { state: 'on' },
}

/**
 * 상태 분류 키 → 계약 분류. `undefined` 는 명세의 상태 분류 「No Category」(id 1) — 분류 없이 만든 옛 상태로, Jira 보드도 할 일 쪽에 둔다.
 * 그래서 명시 규칙으로 `todo`(R1-I). 이 넷 밖의 키는 정말 모르는 값이라 그 상태만 뺀다(아래 `statuses`).
 */
const CATEGORY: Record<string, WorkCategory> = { undefined: 'todo', new: 'todo', indeterminate: 'in_progress', done: 'done' }
const CATEGORY_RANK: Record<WorkCategory, number> = { todo: 0, in_progress: 1, done: 2 }
/** 목록·검색이 받는 칸 — `/search/jql` 은 `fields` 기본이 `id` 뿐이다(F5). */
const LIST_FIELDS = ['summary', 'status', 'issuetype', 'parent', 'priority', 'duedate', 'resolution', 'project', 'updated', 'issuelinks']
const ITEM_FIELDS = [...LIST_FIELDS, 'description']
const PAGE_GUARD = 100
const CHILD_PAGE_GUARD = 20
const SEARCH_LIMIT = 100
const PRIORITY_NAME: Record<WorkPriority, string> = { highest: 'highest', high: 'high', medium: 'medium', low: 'low', lowest: 'lowest' }
/** Jira Cloud 기본 우선순위 id(1 Highest … 5 Lowest) — 이름은 사이트 언어로 번역돼 오므로(R1-J) 이름이 안 맞으면 id 로 대응한다. 실제 로케일 응답 대조는 F19. */
const PRIORITY_DEFAULT_ID: Record<WorkPriority, string> = { highest: '1', high: '2', medium: '3', low: '4', lowest: '5' }
/** 계약 연결 5종 ↔ Jira 기본 연결 종류(바깥·안쪽 글). 사이트가 바꾼 이름은 바깥·안쪽 글로 다시 찾는다(F14). */
const RELATION_TYPES: { name: string; outward: string; inward: string; outwardKind: WorkRelationKind; inwardKind: WorkRelationKind }[] = [
  { name: 'Blocks', outward: 'blocks', inward: 'is blocked by', outwardKind: 'blocks', inwardKind: 'is_blocked_by' },
  { name: 'Duplicate', outward: 'duplicates', inward: 'is duplicated by', outwardKind: 'duplicates', inwardKind: 'is_duplicated_by' },
  { name: 'Relates', outward: 'relates to', inward: 'relates to', outwardKind: 'relates_to', inwardKind: 'relates_to' },
]
/** 만들기에서 계약 칸으로 다루는 시스템 필드 — 메타의 필수 필드에서 뺀다(T4 §14 · C8②). */
const SYSTEM_CREATE_FIELDS = new Set(['project', 'issuetype', 'summary', 'description', 'priority', 'parent', 'reporter'])
const TEXT_FIELD = 'com.atlassian.jira.plugin.system.customfieldtypes:textfield'
const TEXTAREA_FIELD = 'com.atlassian.jira.plugin.system.customfieldtypes:textarea'

// --- 사이트 · 계정 ---

/**
 * 사이트 칸 → 호스트(`<이름>.atlassian.net`). 받는 꼴: `acme`·`acme.atlassian.net`·`https://acme.atlassian.net/`·브라우저 주소(경로·질의는 버린다)·대문자.
 * 거절: `*.atlassian.net` 밖 호스트(사용자 지정 도메인 포함) · `http://` 밖 스킴 · 포트 · 사용자 정보(`a@b`) · 빈 이름 · 겹 하위 도메인(`a.b.atlassian.net`).
 */
export function normalizeJiraSite(input: string): { ok: true; host: string } | { ok: false; message: string } {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { ok: false, message: '사이트 주소를 입력하세요.' }
  const bare = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(trimmed) ? `${trimmed}.atlassian.net` : trimmed
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(bare) ? bare : `https://${bare}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, message: '사이트 주소 모양이 아닙니다 — https://<이름>.atlassian.net' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, message: '사이트 주소는 https:// 여야 합니다.' }
  if (url.username !== '' || url.password !== '' || url.port !== '') return { ok: false, message: '사이트 주소에 사용자 정보·포트를 넣지 마세요 — https://<이름>.atlassian.net' }
  const host = url.hostname.toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/.test(host)) return { ok: false, message: 'Jira Cloud 사이트(<이름>.atlassian.net)만 연결합니다 — 사용자 지정 도메인은 아직 받지 않습니다. 보내지 않았습니다.' }
  return { ok: true, host }
}

export function checkJiraAccount(account: Record<string, string>): { ok: true; account: Record<string, string> } | { ok: false; message: string } {
  const site = normalizeJiraSite(account.site ?? '')
  if (!site.ok) return site
  const email = (account.email ?? '').trim()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: '이메일 모양이 아닙니다.' }
  return { ok: true, account: { site: site.host, email } }
}

/**
 * 측정 실행 전용 fixture 주소(LIFE-605) — **제어 소켓이 열린 격리 실행(`CORRAL_CONTROL_SOCKET`)에서 `CORRAL_JIRA_FIXTURE_URL` 이 `http://127.0.0.1:<포트>` 일 때만**.
 * 그 밖(평시 앱 · 다른 호스트 · https)은 null — 제품 경로에서 자격이 사이트 밖으로 가는 길이 열리지 않는다(시험).
 */
export function jiraFixtureBaseFromEnv(env: Record<string, string | undefined>): string | null {
  const socket = env.CORRAL_CONTROL_SOCKET ?? ''
  const url = env.CORRAL_JIRA_FIXTURE_URL ?? ''
  if (socket.length === 0 || !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(url)) return null
  return url
}

export type JiraSourceOptions = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 사이트 호스트 → 요청 바탕 주소. 기본 `https://<host>`. 측정 실행·시험만 바꾼다. */
  baseUrlOf?: (host: string) => string
  /** 페이지 크기(시험은 작게 — 여러 쪽). 기본은 엔드포인트별 상한 안. */
  pageSize?: number
  maxConcurrent?: number
  sleep?: (ms: number) => Promise<void>
}

export function jiraSourceEntry(options: JiraSourceOptions = {}): WorkSourceEntry {
  return {
    descriptor: JIRA_DESCRIPTOR,
    checkAccount: checkJiraAccount,
    secretsOf: ({ token, account }) => {
      const email = account.email ?? ''
      const basic = Buffer.from(`${email}:${token}`, 'utf8').toString('base64')
      return [basic, `Basic ${basic}`, email, `${email}:${token}`]
    },
    create: (credentials) => new JiraSource({ credentials, options }),
  }
}

// --- 출처 ---

type Step<T> = { ok: true; value: T } | { ok: false; outcome: WorkOutcome }
type ProjectInfo = { project: JiraProject; types: JiraIssueType[] }
type StatusInfo = { statuses: WorkStatus[]; byType: Map<string, JiraStatus[]> }

export class JiraSource implements WorkSourceClient {
  private readonly http: JiraHttp | null
  private readonly siteProblem: string | null
  private readonly pageSize: number
  private readonly projects = new Map<string, ProjectInfo>()
  private readonly statusCache = new Map<string, StatusInfo>()
  private readonly orderOf = new Map<string, WorkCapability>()
  private priorities: { id: string; name: string }[] | null = null
  private linkTypes: JiraLinkType[] | null = null

  constructor({ credentials, options }: { credentials: WorkCredentials; options: JiraSourceOptions }) {
    // 손검증을 다시 — 연결 파일·암호문이 어떤 값을 들고 와도 사이트 밖으로 보내지 않는다.
    const checked = checkJiraAccount(credentials.account)
    this.siteProblem = checked.ok ? null : checked.message
    this.pageSize = options.pageSize ?? 50
    this.http = !checked.ok
      ? null
      : new JiraHttp({ baseUrl: (options.baseUrlOf ?? ((host) => `https://${host}`))(checked.account.site ?? ''), email: checked.account.email ?? '', token: credentials.token, timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl, maxConcurrent: options.maxConcurrent, sleep: options.sleep })
  }

  capabilities(): WorkCapabilities {
    return JIRA_CAPABILITIES
  }

  close(): void {
    this.http?.close()
  }

  async call(call: WorkCall, meta?: WorkCallMeta): Promise<WorkOutcome> {
    if (this.http === null) return { ok: false, error: workError({ kind: 'invalid_request', message: this.siteProblem ?? '연결 칸이 잘못됐습니다.' }) }
    const writeId = meta?.writeId ?? null
    try {
      return await this.answer({ call, writeId })
    } catch (error) {
      if (error instanceof JiraShapeError) return { ok: false, error: workError({ kind: 'invalid_response', message: `Jira 응답 모양이 다릅니다 (${error.path.slice(0, 120)}).` }) }
      throw error
    }
  }

  private async answer({ call, writeId }: { call: WorkCall; writeId: string | null }): Promise<WorkOutcome> {
    switch (call.op) {
      case 'listSpaces': return this.listSpaces()
      case 'listStatuses': return this.listStatuses(call.spaceKey)
      case 'listItems': return this.listItems({ spaceKey: call.spaceKey, cursor: call.cursor })
      case 'getItem': return this.itemResult({ op: 'getItem', itemId: call.itemId })
      case 'findByKey': return this.findByKey(call.key)
      case 'listTransitions': return this.listTransitions(call.itemId)
      case 'changeStatus':
        if (call.ifVersion !== null) return closed('conflictCheck')
        if (call.resolution !== undefined && call.resolution !== null) return closed('resolution')
        return this.changeStatus({ itemId: call.itemId, statusKey: call.statusKey, writeId })
      case 'updateItem':
        if (call.ifVersion !== null) return closed('conflictCheck')
        return this.updateItem({ call, writeId })
      case 'listChildren': return this.listChildren(call.itemId)
      case 'createItem': return this.createItem({ call, writeId })
      case 'getCreateMeta': {
        const meta = await this.createMeta({ spaceKey: call.spaceKey, kindKey: call.kindKey, withParent: false })
        return meta.ok ? { ok: true, result: { op: 'getCreateMeta', meta: meta.value.meta } } : meta.outcome
      }
      case 'listHistory': return this.listHistory(call.itemId)
      case 'setPlacement': return closed('placement')
      case 'setParent':
        if (call.ifVersion !== null) return closed('conflictCheck')
        return this.setParent({ itemId: call.itemId, spaceKey: call.spaceKey, parentId: call.parentId, writeId })
      case 'reorder': return this.reorder({ itemId: call.itemId, afterId: call.afterId })
      case 'addRelation': return this.addRelation({ itemId: call.itemId, kind: call.kind, otherKey: call.otherKey })
      case 'removeRelation': return this.removeRelation(call.relationId)
      case 'listComments': return this.listComments(call.itemId)
      case 'addComment': return this.addComment({ itemId: call.itemId, body: call.body })
      case 'saveWorkLink':
      case 'removeWorkLink':
        return closed('workLinkStore')
      case 'searchItems': return this.searchItems({ spaceKeys: call.spaceKeys, query: call.query })
    }
  }

  // --- 전송 ---

  private async send({ method, path, query, body, write = false }: { method: JiraMethod; path: string; query?: Record<string, string>; body?: unknown; write?: boolean }): Promise<JiraReply> {
    if (this.http === null) return { ok: false, error: workError({ kind: 'invalid_request', message: '연결 칸이 잘못됐습니다.' }), unsent: true, status: null, body: null, retryAfterMs: null }
    return this.http.request({ method, path, query, body, write })
  }

  /** 읽기 — 성공 JSON 만, 404 는 `notFound` 문구로 거절(인증 실패가 아니다 — F15). */
  private async read<T>({ path, query, parse, notFound }: { path: string; query?: Record<string, string>; parse: (json: unknown) => T; notFound: string }): Promise<Step<T>> {
    const reply = await this.send({ method: 'GET', path, query })
    if (!reply.ok) return { ok: false, outcome: { ok: false, error: reply.status === 404 ? rejectedError(notFound, 404) : reply.status === 400 ? rejectedError(`Jira 가 요청을 거절했습니다 (400).`, 400) : reply.error } }
    return { ok: true, value: parse(reply.json) }
  }

  /** 쓰기 — 한 번만 보낸다. 닿았는지 모르는 실패(시간 초과·끊김·5xx·429)는 `maybeApplied`(C11). */
  private async write({ method, path, query, body, refused }: { method: JiraMethod; path: string; query?: Record<string, string>; body?: unknown; refused: string }): Promise<Step<JiraReply & { ok: true }>> {
    const reply = await this.send({ method, path, query, body, write: true })
    if (reply.ok) return { ok: true, value: reply }
    if (reply.status === 400 || reply.status === 404 || reply.status === 409 || reply.status === 422) return { ok: false, outcome: { ok: false, error: rejectedError(refused, reply.status) } }
    return { ok: false, outcome: { ok: false, error: maybeApplied({ error: reply.error, unsent: reply.unsent }) } }
  }

  /** offset 페이지 전부 — 상한(100쪽)에서 멈춘다. */
  private async pages<T>({ path, query, parse, notFound, maxResults }: { path: string; query?: Record<string, string>; parse: (input: { value: unknown; startAt: number }) => OffsetPage<T>; notFound: string; maxResults: number }): Promise<Step<T[]>> {
    const out: T[] = []
    let startAt = 0
    for (let page = 0; page < PAGE_GUARD; page += 1) {
      const step = await this.read({ path, query: { ...query, startAt: String(startAt), maxResults: String(maxResults) }, parse: (value) => parse({ value, startAt }), notFound })
      if (!step.ok) return step
      out.push(...step.value.values)
      if (!step.value.more) return { ok: true, value: out }
      if (step.value.values.length === 0) return { ok: false, outcome: { ok: false, error: pagingError(path) } }
      startAt += step.value.values.length
    }
    // 쪽 수 상한까지 끝나지 않으면 조용히 자르지 않는다(R1-E).
    return { ok: false, outcome: { ok: false, error: pagingError(path) } }
  }

  // --- 스페이스 · 상태 ---

  private async listSpaces(): Promise<WorkOutcome> {
    const me = await this.read({ path: '/rest/api/3/myself', parse: readMyself, notFound: 'Jira 사용자 정보를 찾지 못했습니다.' })
    if (!me.ok) return me.outcome
    const projects = await this.pages({ path: '/rest/api/3/project/search', query: { expand: 'issueTypes', orderBy: 'key' }, parse: readProjectPage, notFound: '프로젝트 목록을 찾지 못했습니다.', maxResults: Math.min(this.pageSize, 100) })
    if (!projects.ok) return projects.outcome
    for (const project of projects.value) this.projects.set(project.key, { project, types: project.issueTypes ?? [] })
    const boards = await this.boardsByProject()
    const spaces: WorkSpace[] = projects.value.map((project) => {
      const order: WorkCapability = boards.state === 'ok'
        ? ((boards.counts.get(project.key) ?? 0) > 0 ? { state: 'on' } : { state: 'disabled', reason: ORDER_OFF_NO_BOARD })
        : { state: 'disabled', reason: boards.state === 'absent' ? ORDER_OFF_NO_SOFTWARE : ORDER_OFF_FORBIDDEN }
      this.orderOf.set(project.key, order)
      return { key: project.key, name: project.name, color: null, description: project.description, openCount: null, role: 'regular', capabilities: order.state === 'on' ? {} : { order } }
    })
    return { ok: true, result: { op: 'listSpaces', spaces, capabilities: JIRA_CAPABILITIES } }
  }

  /** 프로젝트별 보드 수 — agile API 가 없으면(Jira Software 없음 · 404) `absent`, 권한 없음(401·403 밖)은 `forbidden`. */
  private async boardsByProject(): Promise<{ state: 'ok'; counts: Map<string, number> } | { state: 'absent' | 'forbidden' }> {
    const counts = new Map<string, number>()
    let startAt = 0
    for (let page = 0; page < 20; page += 1) {
      const reply = await this.send({ method: 'GET', path: '/rest/agile/1.0/board', query: { startAt: String(startAt), maxResults: String(Math.min(this.pageSize, 50)) } })
      if (!reply.ok) return { state: reply.status === 404 ? 'absent' : 'forbidden' }
      const boards = readBoardPage({ value: reply.json, startAt })
      for (const board of boards.values) if (board.projectKey !== null) counts.set(board.projectKey, (counts.get(board.projectKey) ?? 0) + 1)
      if (!boards.more) break
      startAt += boards.values.length
    }
    return { state: 'ok', counts }
  }

  private async project(spaceKey: string): Promise<Step<ProjectInfo>> {
    const known = this.projects.get(spaceKey)
    if (known !== undefined) return { ok: true, value: known }
    if (!PROJECT_KEY.test(spaceKey)) return { ok: false, outcome: rejected('스페이스가 아닙니다.') }
    const step = await this.read({ path: `/rest/api/3/project/${encodeURIComponent(spaceKey)}`, query: { expand: 'issueTypes' }, parse: (json) => readProject(json, 'project'), notFound: '스페이스가 아닙니다 — 없거나 볼 권한이 없는 프로젝트입니다.' })
    if (!step.ok) return step
    const info = { project: step.value, types: step.value.issueTypes ?? [] }
    this.projects.set(step.value.key, info)
    return { ok: true, value: info }
  }

  /**
   * 스페이스 상태 = 종류별 상태 합집합(같은 id 하나) · 순서 = 분류(할 일 → 진행 → 완료) 다음 처음 나온 순.
   * 모르는 분류 키는 **그 상태만** 목록에서 뺀다(R1-I — 스페이스 전체를 막지 않는다). 그 상태에 있는 작업은 `toItems` 가 응답 어긋남으로(어느 분류로도 넣지 않는다).
   */
  private async statuses(spaceKey: string): Promise<Step<StatusInfo>> {
    const cached = this.statusCache.get(spaceKey)
    if (cached !== undefined) return { ok: true, value: cached }
    const step = await this.read({ path: `/rest/api/3/project/${encodeURIComponent(spaceKey)}/statuses`, parse: readProjectStatuses, notFound: '스페이스가 아닙니다 — 없거나 볼 권한이 없는 프로젝트입니다.' })
    if (!step.ok) return step
    const seen = new Map<string, { status: JiraStatus; first: number }>()
    const byType = new Map<string, JiraStatus[]>()
    let at = 0
    for (const entry of step.value) {
      byType.set(entry.typeId, entry.statuses)
      for (const status of entry.statuses) {
        if (CATEGORY[status.categoryKey] === undefined) continue
        if (!seen.has(status.id)) seen.set(status.id, { status, first: at++ })
      }
    }
    const ordered = [...seen.values()].sort((a, b) => CATEGORY_RANK[categoryOf(a.status)] - CATEGORY_RANK[categoryOf(b.status)] || a.first - b.first)
    const statuses = ordered.map(({ status }, order) => ({ key: status.id, label: status.name, category: categoryOf(status), order, color: null }))
    const info = { statuses, byType }
    this.statusCache.set(spaceKey, info)
    return { ok: true, value: info }
  }

  private async listStatuses(spaceKey: string): Promise<WorkOutcome> {
    const project = await this.project(spaceKey)
    if (!project.ok) return project.outcome
    const statuses = await this.statuses(spaceKey)
    if (!statuses.ok) return statuses.outcome
    return { ok: true, result: { op: 'listStatuses', statuses: statuses.value.statuses, kinds: project.value.types.map((type) => kindOf({ type, types: project.value.types })) } }
  }

  // --- 목록 · 단건 ---

  private async search({ jql, cursor, maxResults }: { jql: string; cursor: string | null; maxResults: number }): Promise<{ ok: true; issues: JiraIssue[]; next: string | null } | { ok: false; reply: JiraReply & { ok: false } }> {
    const query: Record<string, string> = { jql, maxResults: String(maxResults), fields: LIST_FIELDS.join(',') }
    if (cursor !== null) query.nextPageToken = cursor
    const reply = await this.send({ method: 'GET', path: '/rest/api/3/search/jql', query })
    if (!reply.ok) return { ok: false, reply }
    const page = readSearch(reply.json)
    return { ok: true, issues: page.issues, next: page.nextPageToken }
  }

  private orderClause(spaceKey: string): string {
    // Rank 는 Jira Software 필드 — 보드가 있는 스페이스만 Rank 로, 나머지는 만든 순.
    return this.orderOf.get(spaceKey)?.state === 'on' ? 'ORDER BY Rank ASC' : 'ORDER BY created ASC'
  }

  private async listItems({ spaceKey, cursor }: { spaceKey: string; cursor: string | null }): Promise<WorkOutcome> {
    const project = await this.project(spaceKey)
    if (!project.ok) return project.outcome
    const found = await this.search({ jql: `project = ${jqlString(spaceKey)} ${this.orderClause(spaceKey)}`, cursor, maxResults: this.pageSize })
    if (!found.ok) return { ok: false, error: found.reply.status === 400 ? rejectedError('스페이스 목록 질의를 Jira 가 거절했습니다 — 커서가 만료됐으면 처음부터 다시 불러오세요.', 400) : found.reply.error }
    const items = await this.toItems({ issues: found.issues, withBody: false })
    if (!items.ok) return items.outcome
    return { ok: true, result: { op: 'listItems', items: items.value, nextCursor: found.next, truncated: false } }
  }

  private async fetchIssue(itemIdOrKey: string): Promise<Step<JiraIssue>> {
    return this.read({ path: `/rest/api/3/issue/${encodeURIComponent(itemIdOrKey)}`, query: { fields: ITEM_FIELDS.join(',') }, parse: (json) => readIssue(json), notFound: '없는 작업이거나 볼 권한이 없습니다.' })
  }

  private async item(itemId: string): Promise<Step<WorkItem>> {
    const issue = await this.fetchIssue(itemId)
    if (!issue.ok) return issue
    return this.fullItem(issue.value)
  }

  private async fullItem(issue: JiraIssue): Promise<Step<WorkItem>> {
    const items = await this.toItems({ issues: [issue], withBody: true })
    if (!items.ok) return items
    const item = items.value[0]
    if (item === undefined) return { ok: false, outcome: rejected('없는 작업입니다.') }
    return { ok: true, value: item }
  }

  private async itemResult({ op, itemId }: { op: 'getItem' | 'changeStatus' | 'updateItem' | 'setParent' | 'reorder' | 'createItem'; itemId: string }): Promise<WorkOutcome> {
    const item = await this.item(itemId)
    if (!item.ok) return item.outcome
    return op === 'getItem' ? { ok: true, result: { op, item: item.value } } : { ok: true, result: { op, item: item.value } }
  }

  private async findByKey(key: string): Promise<WorkOutcome> {
    const upper = key.trim().toUpperCase()
    if (!JIRA_KEY.test(upper)) return { ok: true, result: { op: 'findByKey', item: null } }
    const reply = await this.send({ method: 'GET', path: `/rest/api/3/issue/${encodeURIComponent(upper)}`, query: { fields: ITEM_FIELDS.join(',') } })
    // 없음·못 봄은 Jira 가 둘 다 404 — 「없음」(오류 아님, E2).
    if (!reply.ok) return reply.status === 404 ? { ok: true, result: { op: 'findByKey', item: null } } : { ok: false, error: reply.error }
    const item = await this.fullItem(readIssue(reply.json))
    return item.ok ? { ok: true, result: { op: 'findByKey', item: item.value } } : item.outcome
  }

  /** Jira 이슈 → 계약 작업. 종류의 자식 규칙·상태 분류는 그 프로젝트에서. */
  private async toItems({ issues, withBody }: { issues: JiraIssue[]; withBody: boolean }): Promise<Step<WorkItem[]>> {
    const items: WorkItem[] = []
    for (const issue of issues) {
      const project = await this.project(issue.projectKey)
      if (!project.ok) return project
      const category = CATEGORY[issue.status.categoryKey]
      if (category === undefined) return { ok: false, outcome: { ok: false, error: workError({ kind: 'invalid_response', message: `${issue.key} 상태의 분류(${issue.status.categoryKey.slice(0, 20)})를 모릅니다.` }) } }
      const body = withBody ? adfView(issue.description ?? { type: 'doc', version: 1, content: [] }) : null
      const relations = withBody ? relationsOf(issue) : null
      const openBlockers = issue.links
        .filter((link) => relationKindOf(link) === 'is_blocked_by' && link.other.status !== null && CATEGORY[link.other.status.categoryKey] !== 'done')
        .map((link) => ({ id: link.other.id, key: link.other.key, title: link.other.summary }))
      items.push({
        id: issue.id,
        key: issue.key,
        spaceKey: issue.projectKey,
        title: issue.summary,
        body: body === null ? null : body.markdown,
        kind: kindOf({ type: issue.issueType, types: project.value.types }),
        statusKey: issue.status.id,
        category,
        resolution: category === 'done' ? resolutionOf(issue.resolution) : null,
        priority: priorityOf(issue.priority),
        dueAt: dueFromJira(issue.duedate),
        parentId: issue.parentId,
        placement: null,
        rank: null,
        openBlockerCount: openBlockers.length,
        openBlockers,
        updatedAt: new Date(issue.updated).toISOString(),
        version: null,
        relations,
        workLinks: [],
        bodyLock: body === null || body.unsupported.length === 0 ? null : lockReason(body.unsupported),
      })
    }
    return { ok: true, value: items }
  }

  // --- 전이 ---

  private async transitions(itemId: string): Promise<Step<JiraTransition[]>> {
    return this.read({ path: `/rest/api/3/issue/${encodeURIComponent(itemId)}/transitions`, query: { expand: 'transitions.fields' }, parse: readTransitions, notFound: '없는 작업이거나 볼 권한이 없습니다.' })
  }

  private async listTransitions(itemId: string): Promise<WorkOutcome> {
    const step = await this.transitions(itemId)
    if (!step.ok) return step.outcome
    const plan = transitionPlan(step.value)
    return { ok: true, result: { op: 'listTransitions', statusKeys: [...plan.open.keys()], blocked: [...plan.blocked.entries()].map(([statusKey, reason]) => ({ statusKey, reason })) } }
  }

  private async changeStatus({ itemId, statusKey, writeId }: { itemId: string; statusKey: string; writeId: string | null }): Promise<WorkOutcome> {
    const step = await this.transitions(itemId)
    if (!step.ok) return step.outcome
    const plan = transitionPlan(step.value)
    const transition = plan.open.get(statusKey)
    if (transition === undefined) {
      const current = await this.fetchIssue(itemId)
      if (current.ok && current.value.status.id === statusKey) return this.itemResult({ op: 'changeStatus', itemId })
      return rejected(plan.blocked.get(statusKey) ?? '지금 상태에서 그 상태로 가는 Jira 전이가 없습니다(허용 전이만).')
    }
    const sent = await this.write({ method: 'POST', path: `/rest/api/3/issue/${encodeURIComponent(itemId)}/transitions`, body: { transition: { id: transition.id }, ...historyOf(writeId) }, refused: `Jira 가 전이 「${transition.name.slice(0, 40)}」 를 거절했습니다 — 전이 조건·필수 필드를 Jira 에서 확인하세요.` })
    if (!sent.ok) return sent.outcome
    return this.itemResult({ op: 'changeStatus', itemId })
  }

  // --- 수정 ---

  private async updateItem({ call, writeId }: { call: Extract<WorkCall, { op: 'updateItem' }>; writeId: string | null }): Promise<WorkOutcome> {
    const fields: Record<string, unknown> = {}
    const patch = call.fields
    if (patch.title !== undefined) fields.summary = patch.title
    if (patch.priority !== undefined) {
      const priority = await this.priorityId(patch.priority)
      if (!priority.ok) return priority.outcome
      fields.priority = { id: priority.value }
    }
    if (patch.dueAt !== undefined) fields.duedate = patch.dueAt === null ? null : dueToJira(patch.dueAt)
    if (patch.body !== undefined) {
      const current = await this.fetchIssue(call.itemId)
      if (!current.ok) return current.outcome
      const description = bodyUpdate({ current: current.value.description ?? { type: 'doc', version: 1, content: [] }, next: patch.body })
      if (!description.ok) return rejected(description.message)
      if (description.doc !== undefined) fields.description = description.doc
    }
    if (Object.keys(fields).length > 0) {
      const sent = await this.write({ method: 'PUT', path: `/rest/api/3/issue/${encodeURIComponent(call.itemId)}`, body: { fields, ...historyOf(writeId) }, refused: 'Jira 가 수정을 거절했습니다 — 그 칸이 이 종류의 수정 화면에 없거나 값이 맞지 않습니다.' })
      if (!sent.ok) return sent.outcome
    }
    return this.itemResult({ op: 'updateItem', itemId: call.itemId })
  }

  /** 계약 5단 ↔ 사이트 우선순위 이름(대소문자 무시), 이름이 없으면 기본 id(R1-J). 대응 없는 값은 거절 — 비우기(null)는 Jira 가 받지 않는다(T4 §14-2). */
  private async priorityId(priority: WorkPriority | null): Promise<Step<string>> {
    if (priority === null) return { ok: false, outcome: rejected('Jira 는 우선순위를 비울 수 없습니다.') }
    if (this.priorities === null) {
      const step = await this.pages({ path: '/rest/api/3/priority/search', parse: readPriorityPage, notFound: '우선순위 목록을 찾지 못했습니다.', maxResults: 50 })
      if (!step.ok) return step
      this.priorities = step.value
    }
    const found = this.priorities.find((entry) => entry.name.trim().toLowerCase() === PRIORITY_NAME[priority])
      ?? this.priorities.find((entry) => entry.id === PRIORITY_DEFAULT_ID[priority] && priorityOf({ id: entry.id, name: entry.name }) === priority)
    return found === undefined ? { ok: false, outcome: rejected(`이 사이트에는 「${priority}」 우선순위가 없습니다.`) } : { ok: true, value: found.id }
  }

  // --- 부모 · 자식 ---

  private async listChildren(itemId: string): Promise<WorkOutcome> {
    if (!/^\d{1,18}$/.test(itemId)) return rejected('없는 작업입니다.')
    const issues: JiraIssue[] = []
    let cursor: string | null = null
    const seen = new Set<string>()
    for (let page = 0; ; page += 1) {
      // 같은 규칙(R1-E) — 빈 쪽 + 다음 표지 · 같은 표지 반복 · 쪽 수 상한은 조용히 자르지 않고 응답 어긋남.
      if (page >= CHILD_PAGE_GUARD) return { ok: false, error: pagingError('자식 목록') }
      const found = await this.search({ jql: `parent = ${itemId} ORDER BY created ASC`, cursor, maxResults: this.pageSize })
      if (!found.ok) return { ok: false, error: found.reply.status === 400 ? rejectedError('Jira 가 자식 질의를 거절했습니다.', 400) : found.reply.error }
      issues.push(...found.issues)
      cursor = found.next
      if (cursor === null) break
      if (found.issues.length === 0 || seen.has(cursor)) return { ok: false, error: pagingError('자식 목록') }
      seen.add(cursor)
    }
    const items = await this.toItems({ issues, withBody: false })
    return items.ok ? { ok: true, result: { op: 'listChildren', items: items.value } } : items.outcome
  }

  private async setParent({ itemId, spaceKey, parentId, writeId }: { itemId: string; spaceKey: string; parentId: string | null; writeId: string | null }): Promise<WorkOutcome> {
    const issue = await this.fetchIssue(itemId)
    if (!issue.ok) return issue.outcome
    // 스페이스(프로젝트)를 넘는 이동은 하지 않는다 — Cloud REST 에 단건 프로젝트 이동이 없다(00-analysis §2).
    if (issue.value.projectKey !== spaceKey) return rejected('Jira 에서는 다른 스페이스(프로젝트)로 옮기지 않습니다 — Jira 에서 이동하세요.')
    const project = await this.project(spaceKey)
    if (!project.ok) return project.outcome
    if (parentId === null) {
      if (issue.value.issueType.subtask) return rejected('하위 작업은 부모 없이 둘 수 없습니다.')
    } else {
      const parent = await this.fetchIssue(parentId)
      if (!parent.ok) return parent.outcome
      if (parent.value.projectKey !== spaceKey) return rejected('Jira 에서는 다른 스페이스의 작업을 부모로 두지 않습니다.')
      if (!kindOf({ type: parent.value.issueType, types: project.value.types }).childKinds.includes(issue.value.issueType.id)) return rejected(`${parent.value.issueType.name} 아래에는 ${issue.value.issueType.name} 를 둘 수 없습니다(Jira 계층).`)
    }
    const sent = await this.write({ method: 'PUT', path: `/rest/api/3/issue/${encodeURIComponent(itemId)}`, body: { fields: { parent: parentId === null ? null : { id: parentId } }, ...historyOf(writeId) }, refused: 'Jira 가 부모 변경을 거절했습니다.' })
    if (!sent.ok) return sent.outcome
    return this.itemResult({ op: 'setParent', itemId })
  }

  // --- 만들기 ---

  /** `textareas` = 여러 줄 글 커스텀 필드 키 — v3 은 그 값으로 ADF 를 받는다(만들기가 쓴다, 화면에는 안 나간다). */
  private async createMeta({ spaceKey, kindKey, withParent }: { spaceKey: string; kindKey: string; withParent: boolean }): Promise<Step<{ meta: WorkCreateMeta; textareas: Set<string> }>> {
    const project = await this.project(spaceKey)
    if (!project.ok) return project
    const type = project.value.types.find((entry) => entry.id === kindKey)
    if (type === undefined) return { ok: false, outcome: rejected('이 스페이스에 없는 종류입니다.') }
    const statuses = await this.statuses(spaceKey)
    if (!statuses.ok) return statuses
    const fields = await this.pages({ path: `/rest/api/3/issue/createmeta/${encodeURIComponent(spaceKey)}/issuetypes/${encodeURIComponent(kindKey)}`, parse: readCreateMetaPage, notFound: '이 종류의 생성 메타를 찾지 못했습니다.', maxResults: Math.min(this.pageSize, 200) })
    if (!fields.ok) return fields
    // 첫 상태 — 그 종류 상태 목록에서 할 일 분류의 첫 상태(워크플로 첫 상태를 API 가 주지 않는다, 실제 사이트 확인 칸 F19).
    const typeStatuses = statuses.value.byType.get(kindKey) ?? []
    const first = typeStatuses.find((status) => status.categoryKey === 'new') ?? typeStatuses.find((status) => status.categoryKey !== 'done')
    if (first === undefined) return { ok: false, outcome: rejected('이 종류에는 만들 수 있는 상태가 없습니다.') }
    const meta: WorkCreateMeta = {
      spaceKey,
      kindKey,
      statusKeys: [first.id],
      defaultStatusKey: first.id,
      placement: 'ignored',
      accepts: { body: fields.value.some((field) => field.key === 'description'), priority: fields.value.some((field) => field.key === 'priority') },
      fields: fields.value.filter((field) => field.required && !field.hasDefaultValue && !SYSTEM_CREATE_FIELDS.has(field.key)).map(createFieldOf),
    }
    if (type.subtask && !withParent) meta.unavailable = '하위 작업은 부모 작업의 「+ 자식 추가」 로 만듭니다.'
    return { ok: true, value: { meta, textareas: new Set(fields.value.filter((field) => field.schemaCustom === TEXTAREA_FIELD).map((field) => field.key)) } }
  }

  private async createItem({ call, writeId }: { call: Extract<WorkCall, { op: 'createItem' }>; writeId: string | null }): Promise<WorkOutcome> {
    if (call.placement !== undefined) return closed('placement')
    const project = await this.project(call.spaceKey)
    if (!project.ok) return project.outcome
    const type = project.value.types.find((entry) => entry.id === call.kindKey)
    if (type === undefined) return rejected('이 스페이스에 없는 종류입니다.')
    if (call.parentId !== null) {
      const parent = await this.fetchIssue(call.parentId)
      if (!parent.ok) return parent.outcome
      if (parent.value.projectKey !== call.spaceKey) return rejected('부모로 쓸 수 없는 작업입니다 — 다른 스페이스입니다.')
      if (!kindOf({ type: parent.value.issueType, types: project.value.types }).childKinds.includes(type.id)) return rejected(`${parent.value.issueType.name} 아래에는 ${type.name} 를 만들 수 없습니다(Jira 계층).`)
    }
    const meta = await this.createMeta({ spaceKey: call.spaceKey, kindKey: call.kindKey, withParent: call.parentId !== null })
    if (!meta.ok) return meta.outcome
    const problem = createFieldsProblem({ call, meta: meta.value.meta })
    if (problem !== null) return rejected(problem)
    const fields: Record<string, unknown> = { project: { key: call.spaceKey }, issuetype: { id: type.id }, summary: call.title }
    if (call.parentId !== null) fields.parent = { id: call.parentId }
    if (call.body !== undefined && call.body.length > 0) fields.description = withLocalIds(markdownToAdf(call.body))
    if (call.priority !== undefined && call.priority !== null) {
      const priority = await this.priorityId(call.priority)
      if (!priority.ok) return priority.outcome
      fields.priority = { id: priority.value }
    }
    for (const value of call.fields ?? []) {
      const field = meta.value.meta.fields.find((entry) => entry.key === value.key)
      if (field === undefined) return rejected('이 종류에 없는 필드입니다.')
      fields[value.key] = field.shape === 'option' ? { id: value.value } : meta.value.textareas.has(value.key) ? withLocalIds(markdownToAdf(value.value)) : value.value
    }
    const sent = await this.write({ method: 'POST', path: '/rest/api/3/issue', body: { fields, ...historyOf(writeId) }, refused: 'Jira 가 만들기를 거절했습니다 — 필수 필드·값을 Jira 에서 확인하세요.' })
    if (!sent.ok) {
      const error = sent.outcome.ok ? null : sent.outcome.error
      return error !== null && error.maybeApplied === true ? { ok: false, error: { ...error, message: error.message.replace(APPLIED_PREFIX, CREATED_PREFIX) } } : sent.outcome
    }
    const created = readCreated(sent.value.json)
    const item = await this.item(created.id)
    if (item.ok) return { ok: true, result: { op: 'createItem', item: item.value } }
    // 만들었지만 다시 읽지 못했다 — 만든 응답으로 최소 작업(LIFE-604 규칙). 실패로 돌려주면 사용자가 다시 만든다.
    return { ok: true, result: { op: 'createItem', item: minimalItem({ created, call, type, types: project.value.types, statusKey: meta.value.meta.defaultStatusKey }) } }
  }

  // --- 이력 ---

  private async listHistory(itemId: string): Promise<WorkOutcome> {
    const step = await this.pages({ path: `/rest/api/3/issue/${encodeURIComponent(itemId)}/changelog`, parse: readChangelogPage, notFound: '없는 작업이거나 볼 권한이 없습니다.', maxResults: 100 })
    if (!step.ok) return step.outcome
    const entries: WorkHistoryEntry[] = []
    for (const history of step.value) {
      history.items.forEach((item, index) => {
        const field = historyFieldOf(item)
        if (field === null) return
        const text = field === 'body' ? { from: null, to: null } : { from: item.from, to: item.to }
        entries.push({ id: `${history.id}:${index}`, at: new Date(history.created).toISOString(), author: history.author, field, ...text, writeId: history.writeId })
      })
    }
    entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    return { ok: true, result: { op: 'listHistory', entries } }
  }

  // --- 순서 ---

  private async reorder({ itemId, afterId }: { itemId: string; afterId: string | null }): Promise<WorkOutcome> {
    const issue = await this.fetchIssue(itemId)
    if (!issue.ok) return issue.outcome
    const spaceKey = issue.value.projectKey
    if (!this.orderOf.has(spaceKey)) {
      const spaces = await this.listSpaces()
      if (!spaces.ok) return spaces
    }
    const order = this.orderOf.get(spaceKey) ?? { state: 'disabled', reason: ORDER_OFF_NO_BOARD }
    if (order.state !== 'on') return { ok: false, error: workError({ kind: 'unsupported', message: order.state === 'disabled' ? order.reason : ORDER_OFF_NO_BOARD }) }
    let body: Record<string, unknown>
    if (afterId === null) {
      // 맨 앞 = 지금 첫 작업 앞(계약 — afterId null).
      const first = await this.search({ jql: `project = ${jqlString(spaceKey)} ORDER BY Rank ASC`, cursor: null, maxResults: 1 })
      if (!first.ok) return { ok: false, error: first.reply.error }
      const head = first.issues[0]
      if (head === undefined || head.id === itemId) return this.itemResult({ op: 'reorder', itemId })
      body = { issues: [itemId], rankBeforeIssue: head.id }
    } else {
      if (afterId === itemId) return rejected('자기 자신 뒤로는 옮길 수 없습니다.')
      body = { issues: [itemId], rankAfterIssue: afterId }
    }
    const sent = await this.write({ method: 'PUT', path: '/rest/agile/1.0/issue/rank', body, refused: 'Jira 가 순서 변경을 거절했습니다.' })
    if (!sent.ok) return sent.outcome
    if (sent.value.status === 207) {
      // 207 = 이슈별 결과 — 하나라도 실패면 실패(성공으로 읽지 않는다, C7①).
      const entries = readRankEntries(sent.value.json)
      if (entries.length === 0 || entries.some((entry) => entry.status < 200 || entry.status >= 300)) return rejected('Jira 가 순서를 바꾸지 못했습니다(일부 실패 207) — 잠시 후 다시 시도하세요.', 207)
    }
    return this.itemResult({ op: 'reorder', itemId })
  }

  // --- 연결 ---

  private async linkTypeList(): Promise<Step<JiraLinkType[]>> {
    if (this.linkTypes !== null) return { ok: true, value: this.linkTypes }
    const step = await this.read({ path: '/rest/api/3/issueLinkType', parse: readLinkTypes, notFound: '연결 종류를 찾지 못했습니다 — 이 사이트는 이슈 연결을 껐습니다.' })
    if (!step.ok) return step
    this.linkTypes = step.value
    return step
  }

  private async addRelation({ itemId, kind, otherKey }: { itemId: string; kind: WorkRelationKind; otherKey: string }): Promise<WorkOutcome> {
    const issue = await this.fetchIssue(itemId)
    if (!issue.ok) return issue.outcome
    const upper = otherKey.trim().toUpperCase()
    if (upper === issue.value.key) return rejected('자기 자신과는 연결할 수 없습니다.')
    if (!JIRA_KEY.test(upper)) return rejected('작업 키 모양이 아닙니다.')
    const other = await this.fetchIssue(upper)
    if (!other.ok) return other.outcome
    if (other.value.id === issue.value.id) return rejected('자기 자신과는 연결할 수 없습니다.')
    const types = await this.linkTypeList()
    if (!types.ok) return types.outcome
    const spec = RELATION_TYPES.find((entry) => entry.outwardKind === kind || entry.inwardKind === kind)
    const type = spec === undefined ? undefined : findLinkType({ types: types.value, spec })
    if (spec === undefined || type === undefined) return rejected('이 사이트에는 그 연결 종류(Jira 이슈 연결 종류)가 없습니다.')
    if (relationsOf(issue.value).some((relation) => relation.kind === kind && relation.other.id === other.value.id)) return rejected('이미 있는 연결입니다.')
    // Jira: inwardIssue 가 바깥 글(blocks)의 주어다 — 「A blocks B」 = inward A · outward B (실제 사이트 확인 칸 F19).
    const outward = spec.outwardKind === kind
    const body = { type: { id: type.id }, inwardIssue: { id: outward ? issue.value.id : other.value.id }, outwardIssue: { id: outward ? other.value.id : issue.value.id } }
    const sent = await this.write({ method: 'POST', path: '/rest/api/3/issueLink', body, refused: 'Jira 가 연결을 거절했습니다.' })
    if (!sent.ok) return sent.outcome
    const after = await this.fetchIssue(itemId)
    if (!after.ok) return after.outcome
    const relation = relationsOf(after.value).find((entry) => entry.kind === kind && entry.other.id === other.value.id)
    if (relation === undefined) return { ok: false, error: workError({ kind: 'invalid_response', message: 'Jira 가 연결을 받았다고 했지만 이슈에 보이지 않습니다.' }) }
    return { ok: true, result: { op: 'addRelation', relation } }
  }

  private async removeRelation(relationId: string): Promise<WorkOutcome> {
    if (!/^\d{1,18}$/.test(relationId)) return rejected('없는 연결입니다.')
    const sent = await this.write({ method: 'DELETE', path: `/rest/api/3/issueLink/${relationId}`, refused: '없는 연결입니다.' })
    return sent.ok ? { ok: true, result: { op: 'removeRelation', relationId } } : sent.outcome
  }

  // --- 코멘트 ---

  private async listComments(itemId: string): Promise<WorkOutcome> {
    const step = await this.pages({ path: `/rest/api/3/issue/${encodeURIComponent(itemId)}/comment`, query: { orderBy: 'created' }, parse: readCommentPage, notFound: '없는 작업이거나 볼 권한이 없습니다.', maxResults: Math.min(this.pageSize, 100) })
    if (!step.ok) return step.outcome
    return { ok: true, result: { op: 'listComments', comments: step.value.map(commentOf) } }
  }

  private async addComment({ itemId, body }: { itemId: string; body: string }): Promise<WorkOutcome> {
    const sent = await this.write({ method: 'POST', path: `/rest/api/3/issue/${encodeURIComponent(itemId)}/comment`, body: { body: withLocalIds(markdownToAdf(body)) }, refused: 'Jira 가 코멘트를 거절했습니다.' })
    if (!sent.ok) return sent.outcome
    return { ok: true, result: { op: 'addComment', comment: commentOf(readComment(sent.value.json)) } }
  }

  // --- 질의 검색 ---

  private async searchItems({ spaceKeys, query }: { spaceKeys: string[]; query: string }): Promise<WorkOutcome> {
    if (!spaceKeys.every((key) => PROJECT_KEY.test(key))) return rejected('스페이스 키 모양이 아닙니다.')
    const scope = `project in (${spaceKeys.map(jqlString).join(', ')})`
    const user = splitOrderBy(query.trim())
    let note: string
    if (user === null) {
      // 괄호·따옴표 짝이 맞지 않는 질의는 보내지 않는다 — `) OR (` 로 스페이스 조건을 벗어날 수 있다(R1-C). 텍스트로 찾는다.
      note = 'JQL 의 괄호·따옴표 짝이 맞지 않아 질의로 보내지 않고 텍스트로 찾았습니다.'
    } else {
      const queried = await this.collect(`${scope} AND (${user.where})${user.orderBy === null ? ' ORDER BY updated DESC' : ` ORDER BY ${user.orderBy}`}`)
      if (queried.ok) return { ok: true, result: { op: 'searchItems', items: queried.items, mode: 'query', note: null, truncated: queried.truncated } }
      if (queried.status !== 400) return { ok: false, error: queried.error }
      // 질의 거부 — 텍스트로 다시 찾고 사유를 보인다(C5③). 사유는 Jira 글이라 자격 지움 → 길이 상한 순서(R1-S).
      const reason = queried.reason
      note = `Jira 가 질의를 받지 않아 텍스트로 찾았습니다${reason === null ? '.' : ` — ${reason}`}`
    }
    const words = textSearchWords(query)
    if (words.length === 0) return { ok: true, result: { op: 'searchItems', items: [], mode: 'text', note, truncated: false } }
    const texted = await this.collect(`${scope} AND text ~ ${jqlString(words)} ORDER BY updated DESC`)
    if (!texted.ok) return { ok: false, error: texted.status === 400 ? rejectedError('Jira 가 텍스트 검색도 거절했습니다.', 400) : texted.error }
    return { ok: true, result: { op: 'searchItems', items: texted.items, mode: 'text', note, truncated: texted.truncated } }
  }

  /** Jira 가 준 거부 사유 — 자격을 먼저 지우고 그다음 자른다(자른 뒤 지우면 경계의 토큰 조각이 남는다, R1-S). */
  private remoteReason(body: unknown): string | null {
    return errorText({ body, redact: (text) => this.http?.redact(text) ?? text })
  }

  private async collect(jql: string): Promise<{ ok: true; items: WorkItem[]; truncated: boolean } | { ok: false; status: number | null; reason: string | null; error: WorkError }> {
    const issues: JiraIssue[] = []
    let cursor: string | null = null
    let truncated = false
    const seen = new Set<string>()
    // 쪽 상한 — 쪽마다 적어도 1건이면 SEARCH_LIMIT 쪽 안에 끝난다. 빈 쪽 + 다음 토큰 · 같은 토큰 반복은 응답 어긋남(R1-E — 무한 순회 금지).
    for (let page = 0; ; page += 1) {
      if (page >= SEARCH_LIMIT) return { ok: false, status: null, reason: null, error: pagingError('검색') }
      const found = await this.search({ jql, cursor, maxResults: Math.min(this.pageSize, SEARCH_LIMIT) })
      if (!found.ok) return { ok: false, status: found.reply.status, reason: found.reply.status === 400 ? this.remoteReason(found.reply.body) : null, error: found.reply.error }
      issues.push(...found.issues)
      cursor = found.next
      if (cursor === null) break
      if (found.issues.length === 0 || seen.has(cursor)) return { ok: false, status: null, reason: null, error: pagingError('검색') }
      seen.add(cursor)
      if (issues.length >= SEARCH_LIMIT) {
        truncated = true
        break
      }
    }
    const items = await this.toItems({ issues: issues.slice(0, SEARCH_LIMIT), withBody: false })
    if (!items.ok) return { ok: false, status: null, reason: null, error: items.outcome.ok ? workError({ kind: 'invalid_response', message: '검색 결과를 읽지 못했습니다.' }) : items.outcome.error }
    return { ok: true, items: items.value, truncated }
  }
}

// --- 도움 ---

function closed(name: 'conflictCheck' | 'placement' | 'resolution' | 'workLinkStore'): WorkOutcome {
  const capability = JIRA_CAPABILITIES[name]
  return { ok: false, error: workError({ kind: 'unsupported', message: capability.state === 'disabled' ? capability.reason : `Jira 에는 ${name} 능력이 없습니다.` }) }
}

function rejectedError(message: string, status: number | null = null): WorkError {
  return workError({ kind: 'rejected', message, status })
}

function rejected(message: string, status: number | null = null): WorkOutcome {
  return { ok: false, error: rejectedError(message, status) }
}

const APPLIED_PREFIX = '적용됐는지 모릅니다 — '
const CREATED_PREFIX = '만들어졌는지 모릅니다 — '

/** 닿았는지 모르는 쓰기 실패(LIFE-604 R1-A 의 넓힘) — 보내기 전 실패(`unsent`)·분명한 거절·인증·권한은 그대로. */
function maybeApplied({ error, unsent }: { error: WorkError; unsent: boolean }): WorkError {
  if (unsent || (error.kind !== 'network' && error.kind !== 'invalid_response')) return error
  return { ...error, message: `${APPLIED_PREFIX}${error.message}`, maybeApplied: true }
}

/** JQL 글 — 큰따옴표로 감싸고 `\` 와 `"` 를 막는다. 줄바꿈은 공백. */
export function jqlString(value: string): string {
  return `"${value.replace(/[\r\n]+/g, ' ').replace(/[\\"]/g, (char) => `\\${char}`)}"`
}

/** 텍스트 검색어 — Lucene 예약 글자(+ - & | ! ( ) { } [ ] ^ ~ * ? : \ / ")는 공백으로(검색 연산으로 읽히지 않게), 공백 정리. */
export function textSearchWords(query: string): string {
  return query.replace(/[+\-&|!(){}[\]^~*?:\\/"=<>]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 사용자 질의를 조건과 `ORDER BY` 로 나눈다(괄호 안의 ORDER BY 는 JQL 문법 오류라 스페이스 조건 뒤로 옮긴다).
 * **따옴표 밖** 괄호가 균형이고 깊이가 0 아래로 내려가지 않으며 따옴표가 닫혀야 한다 — 아니면 null(보내지 않는다, R1-C).
 * `ORDER BY` 도 따옴표 밖·깊이 0 에서만 찾는다(`summary ~ "order by"` 는 글).
 */
export function splitOrderBy(query: string): { where: string; orderBy: string | null } | null {
  let depth = 0
  let quote: string | null = null
  let orderAt = -1
  let orderLength = 0
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index] ?? ''
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth < 0) return null
    } else if (depth === 0 && orderAt < 0 && /[oO]/.test(char) && (index === 0 || /\s/.test(query[index - 1] ?? ''))) {
      const match = /^order\s+by\b/i.exec(query.slice(index))
      if (match !== null) {
        orderAt = index
        orderLength = match[0].length
      }
    }
  }
  if (depth !== 0 || quote !== null) return null
  if (orderAt < 0) return { where: query, orderBy: null }
  const where = query.slice(0, orderAt).trim()
  return { where: where.length === 0 ? 'issuekey IS NOT EMPTY' : where, orderBy: query.slice(orderAt + orderLength).trim() || 'updated DESC' }
}

function pagingError(what: string): WorkError {
  return workError({ kind: 'invalid_response', message: `Jira ${what} 쪽이 끝나지 않습니다(빈 쪽·같은 다음 쪽 표지·쪽 수 상한) — 응답 모양이 다릅니다.` })
}

function categoryOf(status: JiraStatus): WorkCategory {
  return CATEGORY[status.categoryKey] ?? 'todo'
}

/** 종류 — 자식 종류 = 같은 프로젝트에서 계층 한 단 아래(하위 작업 종류는 잎). */
function kindOf({ type, types }: { type: JiraIssueType; types: JiraIssueType[] }): WorkKind {
  const childKinds = type.hierarchyLevel < 0 ? [] : types.filter((entry) => entry.hierarchyLevel === type.hierarchyLevel - 1).map((entry) => entry.id)
  return { key: type.id, label: type.name, childKinds }
}

/** Jira 해결 이름 → 갈래. 기본 이름만 대응한다 — 나머지는 `other`(꾸미지 않는다). */
function resolutionOf(name: string | null): WorkResolution | null {
  if (name === null) return null
  const lower = name.trim().toLowerCase()
  if (lower === 'done' || lower === 'fixed') return 'completed'
  if (lower === "won't do" || lower === "won't fix" || lower === 'cancelled' || lower === 'canceled' || lower === 'declined') return 'cancelled'
  return 'other'
}

/** 이름(영어 기본 이름) → 없으면 기본 id 1–5(로케일 사이트, R1-J) → 둘 다 아니면 null(꾸미지 않는다). */
function priorityOf(priority: { id: string | null; name: string } | null): WorkPriority | null {
  if (priority === null) return null
  const lower = priority.name.trim().toLowerCase()
  return WORK_PRIORITIES.find((known) => PRIORITY_NAME[known] === lower) ?? WORK_PRIORITIES.find((known) => PRIORITY_DEFAULT_ID[known] === priority.id) ?? null
}

/** Jira 마감은 날짜만 — 그날 로컬 23:59:59(화면 `dueFromInput` 과 같은 규칙). */
export function dueFromJira(date: string | null): string | null {
  if (date === null) return null
  const [year, month, day] = date.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined) return null
  return new Date(year, month - 1, day, 23, 59, 59).toISOString()
}

export function dueToJira(iso: string): string {
  const date = new Date(iso)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function relationKindOf(link: { typeName: string; inward: string; outward: string; direction: 'inward' | 'outward' }): WorkRelationKind | null {
  const spec = RELATION_TYPES.find((entry) => entry.name.toLowerCase() === link.typeName.toLowerCase() || (entry.outward === link.outward.toLowerCase() && entry.inward === link.inward.toLowerCase()))
  if (spec === undefined) return null
  // 이슈 X 의 issuelinks 항목에 outwardIssue Y 면 「X <바깥 글> Y」, inwardIssue Y 면 「X <안쪽 글> Y」.
  return link.direction === 'outward' ? spec.outwardKind : spec.inwardKind
}

function findLinkType({ types, spec }: { types: JiraLinkType[]; spec: (typeof RELATION_TYPES)[number] }): JiraLinkType | undefined {
  return types.find((type) => type.name.toLowerCase() === spec.name.toLowerCase()) ?? types.find((type) => type.outward.toLowerCase() === spec.outward && type.inward.toLowerCase() === spec.inward)
}

function relationsOf(issue: JiraIssue): WorkRelation[] {
  return issue.links.flatMap((link) => {
    const kind = relationKindOf(link)
    if (kind === null) return []
    const category = link.other.status === null ? 'todo' : categoryOf(link.other.status)
    const spaceKey = /^([A-Z][A-Z0-9_]+)-\d+$/.exec(link.other.key)?.[1] ?? null
    return [{ id: link.id, kind, other: { id: link.other.id, key: link.other.key, title: link.other.summary, statusLabel: link.other.status?.name ?? '', category, spaceKey } }]
  })
}

function lockReason(unsupported: string[]): string {
  const names = [...new Set(unsupported.map(unsupportedLabel))].slice(0, 5).join('·')
  return `이 본문에는 corral 이 markdown 으로 바꿀 수 없는 Jira 요소(${names})가 있어 편집을 막았습니다 — 저장하면 그 요소가 사라지기 때문입니다. Jira 에서 고치세요(체크 칸은 여기서 바꿀 수 있습니다).`
}

/**
 * 본문 저장(C6②③) — 바뀐 것이 없으면 보내지 않는다 · 체크 칸 상태만 바뀌었으면 원래 ADF 에서 그 상태만 바꾼다 ·
 * 그 밖의 바꿈은 바꿀 수 없는 요소가 없을 때만 새 ADF 로(있으면 거절 — 조용히 지우지 않는다).
 */
export function bodyUpdate({ current, next }: { current: AdfDoc; next: string }): { ok: true; doc?: AdfDoc | null } | { ok: false; message: string } {
  const shown = adfView(current)
  if (shown.markdown === next) return { ok: true }
  const toggled = withTaskStates({ doc: current, states: taskStates(markdownToAdf(next)) })
  if (toggled !== null && adfToMarkdown(toggled).markdown === next) return { ok: true, doc: toggled }
  if (shown.unsupported.length > 0) return { ok: false, message: lockReason(shown.unsupported) }
  return { ok: true, doc: next.trim().length === 0 ? null : withLocalIds(markdownToAdf(next)) }
}

/** ADF 할 일 목록의 빈 `localId` 를 채운다(Jira 가 요구). */
function withLocalIds(doc: AdfDoc): AdfDoc {
  const walk = (nodes: AdfNode[]): AdfNode[] => nodes.map((node) => {
    const next: AdfNode = { ...node }
    if ((node.type === 'taskList' || node.type === 'taskItem') && (typeof node.attrs?.localId !== 'string' || node.attrs.localId === '')) next.attrs = { ...(node.attrs ?? {}), localId: randomUUID() }
    if (node.content !== undefined) next.content = walk(node.content)
    return next
  })
  return { type: 'doc', version: 1, content: walk(doc.content) }
}

function historyOf(writeId: string | null): { historyMetadata?: Record<string, unknown> } {
  return writeId === null ? {} : { historyMetadata: { type: 'corral', description: 'corral', extraData: { corralWriteId: writeId } } }
}

/** changelog 칸 → 계약 이력 칸. 대응 없는 칸(담당자·라벨 …)은 싣지 않는다(design-notes §10). */
function historyFieldOf(item: { field: string; fieldId: string | null }): WorkHistoryField | null {
  const key = (item.fieldId ?? item.field).toLowerCase()
  switch (key) {
    case 'status': return 'status'
    case 'summary': return 'title'
    case 'description': return 'body'
    case 'priority': return 'priority'
    case 'duedate': return 'dueAt'
    case 'parent':
    case 'issueparentassociation': return 'parent'
    case 'issuelinks':
    case 'link': return 'relation'
    default: return item.field.toLowerCase() === 'link' ? 'relation' : null
  }
}

function commentOf(comment: { id: string; author: string | null; body: AdfDoc; created: string }): WorkComment {
  return { id: comment.id, author: comment.author, body: adfToMarkdown(comment.body).markdown, createdAt: new Date(comment.created).toISOString() }
}

function createFieldOf(field: JiraFieldMeta): WorkCreateField {
  if (field.schemaType === 'string' && field.allowedValues === null && (field.schemaCustom === TEXT_FIELD || field.schemaCustom === TEXTAREA_FIELD)) {
    return { key: field.key, label: field.name, shape: 'text' }
  }
  if (field.schemaType === 'option' && field.allowedValues !== null && field.allowedValues.length > 0) return { key: field.key, label: field.name, shape: 'option', options: field.allowedValues }
  return { key: field.key, label: field.name, shape: 'unsupported', sourceType: (field.schemaCustom ?? field.schemaSystem ?? field.schemaType ?? 'unknown').slice(0, 120) }
}

function minimalItem({ created, call, type, types, statusKey }: { created: { id: string; key: string }; call: Extract<WorkCall, { op: 'createItem' }>; type: JiraIssueType; types: JiraIssueType[]; statusKey: string }): WorkItem {
  return {
    id: created.id, key: created.key, spaceKey: call.spaceKey, title: call.title, body: call.body ?? '', kind: kindOf({ type, types }), statusKey, category: 'todo', resolution: null,
    priority: call.priority ?? null, dueAt: null, parentId: call.parentId, placement: null, rank: null, openBlockerCount: 0, openBlockers: [], updatedAt: new Date().toISOString(), version: null,
    relations: [], workLinks: [], bodyLock: null,
  }
}

/** 전이 → 상태별 계획 — 갈 수 있는 상태마다 첫 「채울 수 있는」 전이, 전부 필수 필드를 물으면 이유. 같은 상태로 가는 전이가 여럿이면 Jira 순서의 첫 것. */
export function transitionPlan(transitions: JiraTransition[]): { open: Map<string, JiraTransition>; blocked: Map<string, string> } {
  const open = new Map<string, JiraTransition>()
  const blocked = new Map<string, string>()
  for (const transition of transitions) {
    if (!transition.available || transition.looped) continue
    const statusKey = transition.to.id
    if (open.has(statusKey)) continue
    const needs = transition.fields.filter((field) => field.required && !field.hasDefaultValue)
    if (needs.length === 0) {
      open.set(statusKey, transition)
      blocked.delete(statusKey)
    } else if (!blocked.has(statusKey)) {
      blocked.set(statusKey, `전이 「${transition.name.slice(0, 40)}」 는 corral 이 채울 수 없는 필수 필드(${needs.map((field) => field.name.slice(0, 30)).slice(0, 3).join('·')})를 묻습니다 — Jira 에서 바꾸세요.`)
    }
  }
  return { open, blocked }
}
