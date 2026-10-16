// Jira Cloud REST fixture (LIFE-605 C3 · F18) — 실제 `node:http` 서버(127.0.0.1:0). 요청·응답 모양은 Atlassian 공식 OpenAPI 명세에서 가져왔다 —
// 엔드포인트 ↔ 명세 경로는 `specs/LIFE-605-jira-cloud/raw/claude/fixture-spec-map.md`. 명세에 없는 칸을 지어내지 않는다.
//
// - 옛 경로(`/rest/api/3/search` · `/rest/api/3/issue/createmeta`)는 **410** 으로 거절한다(양성 대조 — 출처가 부르면 시험이 깨진다).
// - 인증 = Basic `base64(이메일:토큰)` — `allow()` 로 넣은 자격만. 틀리면 401(+ `captcha` 면 `X-Seraph-LoginReason: AUTHENTICATION_DENIED`).
// - 검색 = 작은 JQL 해석기(이 출처가 보내는 꼴 + 시험 질의). `nextPageToken` 은 불투명 글(같은 질의만 받는다), 마지막 쪽은 칸이 없다 · `isLast` 는 기본으로 싣지 않는다(F5).
// - 요청 기록(`requests`)에는 자격을 남기지 않는다. 손잡이: `faults`(상태·헤더·끊김·지연) · `corrupt`(응답 모양 깨기 — `L605_BREAK`) · `captcha` · `agile` · `echoHistory`.
// 시험만 import 한다(앱 진입점이 닿지 않아 번들에 안 들어간다).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isRecord, safeParse } from '../../shared/json.js'

type Adf = { type: 'doc'; version: 1; content: unknown[] }
type FxType = { id: string; name: string; subtask: boolean; hierarchyLevel: number }
type FxStatus = { id: string; name: string; category: 'new' | 'indeterminate' | 'done' | string }
type FxTransition = { id: string; name: string; to: string; required?: { key: string; name: string }[] }
type FxProject = { id: string; key: string; name: string; types: FxType[]; statusesByType: Record<string, string[]>; workflow: Record<string, FxTransition[]>; initial: string; boards: number }
type FxIssue = {
  id: string; key: string; projectKey: string; summary: string; description: Adf | null; typeId: string; statusId: string; resolution: string | null; priorityId: string | null
  duedate: string | null; parentId: string | null; rank: number; created: number; updated: number; fieldValues: Record<string, unknown>
}
type FxLink = { id: string; typeId: string; inward: string; outward: string }
type FxHistory = { id: string; created: number; historyMetadata: Record<string, unknown> | null; items: { field: string; fieldId: string; fromString: string | null; toString: string | null }[] }
type FxComment = { id: string; body: Adf; created: number }
type FxCreateField = { fieldId: string; name: string; required: boolean; hasDefaultValue: boolean; schema: Record<string, unknown>; allowedValues?: { id: string; value: string }[] }

export type JiraFault = { match: (request: JiraFixtureRequest) => boolean; status?: number; headers?: Record<string, string>; body?: unknown; delayMs?: number; destroy?: 'before' | 'after'; once?: boolean }
export type JiraFixtureRequest = { method: string; path: string; query: Record<string, string>; body: unknown }
export type JiraCorrupt = 'none' | 'issue-no-status' | 'transition-no-to' | 'unknown-category' | 'rank-207' | 'project-no-key' | 'search-issues-object'

const STATUS: Record<string, FxStatus> = {
  '10000': { id: '10000', name: 'To Do', category: 'new' },
  '10001': { id: '10001', name: 'In Progress', category: 'indeterminate' },
  '10002': { id: '10002', name: 'In Review', category: 'indeterminate' },
  '10003': { id: '10003', name: 'Done', category: 'done' },
  '10005': { id: '10005', name: 'Blocked', category: 'indeterminate' },
  '10010': { id: '10010', name: 'Open', category: 'new' },
  '10011': { id: '10011', name: 'Closed', category: 'done' },
}
const CATEGORY_ID: Record<string, number> = { undefined: 1, new: 2, indeterminate: 4, done: 3 }
const PRIORITIES = [{ id: '1', name: 'Highest' }, { id: '2', name: 'High' }, { id: '3', name: 'Medium' }, { id: '4', name: 'Low' }, { id: '5', name: 'Lowest' }]
const LINK_TYPES = [
  { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
  { id: '10001', name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
  { id: '10002', name: 'Relates', inward: 'relates to', outward: 'relates to' },
  { id: '10003', name: 'Cloners', inward: 'is cloned by', outward: 'clones' },
]
const EPIC: FxType = { id: '10000', name: 'Epic', subtask: false, hierarchyLevel: 1 }
const STORY: FxType = { id: '10001', name: 'Story', subtask: false, hierarchyLevel: 0 }
const BUG: FxType = { id: '10002', name: 'Bug', subtask: false, hierarchyLevel: 0 }
const SUBTASK: FxType = { id: '10003', name: 'Subtask', subtask: true, hierarchyLevel: -1 }
const TASK: FxType = { id: '10004', name: 'Task', subtask: false, hierarchyLevel: 0 }

export const JIRA_FIXTURE_IDS = { epic: '20001', story: '20002', bug: '20003', review: '20004', subtask: '20005', done: '20006', web: '20101' } as const
export const JIRA_FIXTURE_VISIBLE = [JIRA_FIXTURE_IDS.epic, JIRA_FIXTURE_IDS.story, JIRA_FIXTURE_IDS.subtask, JIRA_FIXTURE_IDS.web]
export const JIRA_FIXTURE_RETIRED = ['GONE']

function text(value: string): Adf {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }] }
}

function coreWorkflow(): Record<string, FxTransition[]> {
  return {
    '10000': [{ id: '11', name: 'Start', to: '10001' }],
    '10001': [{ id: '21', name: 'Back', to: '10000' }, { id: '22', name: 'Review', to: '10002' }, { id: '23', name: 'Block', to: '10005', required: [{ key: 'customfield_10060', name: 'Blocker reason' }] }],
    '10002': [{ id: '31', name: 'Approve', to: '10003', required: [{ key: 'customfield_10061', name: 'Approver' }] }, { id: '32', name: 'Done', to: '10003' }, { id: '33', name: 'Rework', to: '10001' }],
    '10003': [{ id: '41', name: 'Reopen', to: '10002' }],
    '10005': [{ id: '51', name: 'Unblock', to: '10001' }],
  }
}

function simpleProject({ id, key, name }: { id: string; key: string; name: string }): FxProject {
  return { id, key, name, types: [TASK], statusesByType: { [TASK.id]: ['10010', '10011'] }, workflow: { '10010': [{ id: '61', name: 'Close', to: '10011' }], '10011': [{ id: '62', name: 'Reopen', to: '10010' }] }, initial: '10010', boards: 0 }
}

export class JiraRestFixture {
  readonly requests: JiraFixtureRequest[] = []
  readonly faults: JiraFault[] = []
  /** 분류가 「No Category」(`undefined`) 인 상태 id — 옛 워크플로·마이그레이션 사이트(R1-I). */
  readonly noCategory = new Set<string>()
  /** 사이트 우선순위 — 기본 id 1–5 · 영어 이름. 로케일 사이트(이름이 번역된) 시험은 이름만 바꾼다(R1-J). */
  readonly priorities: { id: string; name: string }[] = PRIORITIES.map((priority) => ({ ...priority }))
  corrupt: JiraCorrupt = 'none'
  captcha = false
  /** Jira Software(agile API) 가 있는 사이트인가 — 없으면 `/rest/agile/*` 가 404. */
  agile = true
  /** 쓰기의 `historyMetadata` 를 이력에 되돌려 주나(실제 사이트 확인 칸 F19 — 끄면 되돌아오지 않는 경우). */
  echoHistory = true
  /** `/search/jql` 응답에 `isLast` 를 싣나 — 기본 싣지 않는다(F5 사례). */
  sendIsLast = false
  active = 0
  maxActive = 0
  private readonly accounts = new Map<string, { accountId: string; email: string }>()
  private server: Server | null = null
  private seq = 30000
  projects: FxProject[] = []
  issues: FxIssue[] = []
  links: FxLink[] = []
  history = new Map<string, FxHistory[]>()
  comments = new Map<string, FxComment[]>()

  constructor() {
    this.seed()
  }

  /** 받을 자격 — 가짜만(시험 비밀값 규칙). */
  allow({ email, token }: { email: string; token: string }): void {
    this.accounts.set(Buffer.from(`${email}:${token}`, 'utf8').toString('base64'), { accountId: `acc-${this.accounts.size + 1}`, email })
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture: 주소를 못 읽음')
    return `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server === null) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  issue(idOrKey: string): FxIssue | null {
    const upper = idOrKey.toUpperCase()
    return this.issues.find((issue) => issue.id === idOrKey || issue.key === upper) ?? null
  }

  /** 받은 요청 중 옛 경로 수 — 0 이어야 한다(410 양성 대조). */
  legacyCalls(): number {
    return this.requests.filter((request) => request.path === '/rest/api/3/search' || request.path === '/rest/api/3/issue/createmeta').length
  }

  private seed(): void {
    const core: FxProject = {
      id: '10000', key: 'CORE', name: 'Core Platform', types: [EPIC, STORY, BUG, SUBTASK],
      statusesByType: { [EPIC.id]: ['10000', '10001', '10003'], [STORY.id]: ['10000', '10001', '10002', '10005', '10003'], [BUG.id]: ['10000', '10001', '10002', '10005', '10003'], [SUBTASK.id]: ['10000', '10001', '10002', '10005', '10003'] },
      workflow: coreWorkflow(), initial: '10000', boards: 1,
    }
    this.projects = [core, simpleProject({ id: '10003', key: 'DOCS', name: 'Docs' }), simpleProject({ id: '10004', key: 'LAB', name: 'Lab' }), simpleProject({ id: '10002', key: 'OPS', name: 'Ops' }), simpleProject({ id: '10001', key: 'WEB', name: 'Web' })]
    const base = { resolution: null, priorityId: '3', duedate: null, created: Date.parse('2026-10-01T00:00:00.000Z'), updated: Date.parse('2026-10-10T00:00:00.000Z'), fieldValues: {} }
    const locked: Adf = {
      type: 'doc', version: 1, content: [
        { type: 'paragraph', content: [{ type: 'text', text: '재현: ' }, { type: 'mention', attrs: { id: 'acc-9', text: '@Kim' } }, { type: 'text', text: ' 확인' }] },
        { type: 'panel', attrs: { panelType: 'warning' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '운영 영향 있음' }] }] },
        { type: 'taskList', attrs: { localId: 'tl-1' }, content: [{ type: 'taskItem', attrs: { localId: 'ti-1', state: 'TODO' }, content: [{ type: 'text', text: '로그 확인' }] }, { type: 'taskItem', attrs: { localId: 'ti-2', state: 'TODO' }, content: [{ type: 'text', text: '고치기' }] }] },
      ],
    }
    this.issues = [
      { ...base, id: '20001', key: 'CORE-1', projectKey: 'CORE', summary: '결제 개편', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '결제 흐름을 ' }, { type: 'text', text: '다시', marks: [{ type: 'strong' }] }, { type: 'text', text: ' 짠다' }] }, { type: 'taskList', attrs: { localId: 'tl-0' }, content: [{ type: 'taskItem', attrs: { localId: 'ti-0', state: 'TODO' }, content: [{ type: 'text', text: '설계' }] }] }] }, typeId: EPIC.id, statusId: '10001', parentId: null, rank: 1 },
      { ...base, id: '20002', key: 'CORE-2', projectKey: 'CORE', summary: '카드 저장', description: text('카드 저장 본문'), typeId: STORY.id, statusId: '10000', parentId: '20001', rank: 2 },
      { ...base, id: '20003', key: 'CORE-3', projectKey: 'CORE', summary: '환불 버그', description: locked, typeId: BUG.id, statusId: '10000', parentId: null, rank: 3, priorityId: '1' },
      { ...base, id: '20004', key: 'CORE-4', projectKey: 'CORE', summary: '영수증 메일', description: null, typeId: STORY.id, statusId: '10002', parentId: '20001', rank: 4 },
      { ...base, id: '20005', key: 'CORE-5', projectKey: 'CORE', summary: '카드 저장 시험', description: null, typeId: SUBTASK.id, statusId: '10000', parentId: '20002', rank: 5 },
      { ...base, id: '20006', key: 'CORE-6', projectKey: 'CORE', summary: '정산 리포트', description: null, typeId: STORY.id, statusId: '10003', resolution: 'Done', parentId: null, rank: 6, duedate: '2026-11-01' },
      { ...base, id: '20101', key: 'WEB-1', projectKey: 'WEB', summary: '랜딩 문구', description: text('랜딩 본문'), typeId: TASK.id, statusId: '10010', parentId: null, rank: 1 },
    ]
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid')
      const raw = await readBody(request)
      const body = raw === '' ? null : safeParse(raw)
      const entry: JiraFixtureRequest = { method: request.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), body }
      this.requests.push(entry)
      const fault = this.faults.find((candidate) => candidate.match(entry))
      if (fault !== undefined) {
        if (fault.once === true) this.faults.splice(this.faults.indexOf(fault), 1)
        if (fault.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, fault.delayMs))
        if (fault.destroy === 'before') return void request.socket.destroy()
        if (fault.status !== undefined) return send({ response, status: fault.status, body: fault.body ?? { errorMessages: [`fixture fault ${fault.status}`] }, headers: fault.headers })
      }
      if (!this.authorized(request.headers.authorization)) {
        return send({ response, status: 401, body: { errorMessages: ['Client must be authenticated to access this resource.'] }, headers: this.captcha ? { 'X-Seraph-LoginReason': 'AUTHENTICATION_DENIED' } : {} })
      }
      const reply = this.route(entry)
      if (fault?.destroy === 'after') return void request.socket.destroy()
      send({ response, ...reply })
    } finally {
      this.active -= 1
    }
  }

  private authorized(header: string | undefined): boolean {
    if (header === undefined || !header.startsWith('Basic ')) return false
    return this.accounts.has(header.slice('Basic '.length))
  }

  private route(request: JiraFixtureRequest): Reply {
    const { method, path } = request
    // 옛 경로 — 제거된 API(명세 deprecated · KB 「완전히 제거」). 양성 대조.
    if (path === '/rest/api/3/search' || path === '/rest/api/3/issue/createmeta') return { status: 410, body: { errorMessages: ['The requested API has been removed. Please migrate to the /rest/api/3/search/jql API.'] } }
    if (path.startsWith('/rest/agile/') && !this.agile) return { status: 404, body: { errorMessages: ['Not found'] } }
    let match: RegExpExecArray | null
    if (method === 'GET' && path === '/rest/api/3/myself') return { status: 200, body: { accountId: 'acc-1', accountType: 'atlassian', active: true, displayName: 'Fixture User', timeZone: 'Asia/Seoul' } }
    if (method === 'GET' && path === '/rest/api/3/project/search') return this.projectSearch(request.query)
    if (method === 'GET' && (match = /^\/rest\/api\/3\/project\/([^/]+)$/.exec(path)) !== null) {
      const project = this.project(decodeURIComponent(match[1] ?? ''))
      return project === null ? notFound(`No project could be found with key '${match[1]}'.`) : { status: 200, body: this.projectBean(project, request.query.expand?.includes('issueTypes') ?? false) }
    }
    if (method === 'GET' && (match = /^\/rest\/api\/3\/project\/([^/]+)\/statuses$/.exec(path)) !== null) return this.projectStatuses(decodeURIComponent(match[1] ?? ''))
    if (method === 'GET' && path === '/rest/api/3/search/jql') return this.searchJql(request.query)
    if (method === 'POST' && path === '/rest/api/3/issue') return this.createIssue(request.body)
    if ((match = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path)) !== null) {
      const issue = this.issue(decodeURIComponent(match[1] ?? ''))
      if (issue === null) return notFound('Issue does not exist or you do not have permission to see it.')
      if (method === 'GET') return { status: 200, body: this.issueBean(issue, fieldList(request.query.fields)) }
      if (method === 'PUT') return this.editIssue(issue, request.body)
    }
    if ((match = /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/.exec(path)) !== null) {
      const issue = this.issue(decodeURIComponent(match[1] ?? ''))
      if (issue === null) return notFound('Issue does not exist or you do not have permission to see it.')
      if (method === 'GET') return { status: 200, body: { expand: 'transitions', transitions: this.transitions(issue, request.query.expand === 'transitions.fields') } }
      if (method === 'POST') return this.doTransition(issue, request.body)
    }
    if (method === 'GET' && (match = /^\/rest\/api\/3\/issue\/([^/]+)\/changelog$/.exec(path)) !== null) {
      const issue = this.issue(decodeURIComponent(match[1] ?? ''))
      if (issue === null) return notFound('Issue does not exist or you do not have permission to see it.')
      return offsetPage({ list: (this.history.get(issue.id) ?? []).map((entry) => this.historyBean(entry)), query: request.query, key: 'values', limit: 100 })
    }
    if ((match = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(path)) !== null) {
      const issue = this.issue(decodeURIComponent(match[1] ?? ''))
      if (issue === null) return notFound('Issue does not exist or you do not have permission to see it.')
      if (method === 'GET') return commentPage({ list: (this.comments.get(issue.id) ?? []).map(commentBean), query: request.query })
      if (method === 'POST') return this.addComment(issue, request.body)
    }
    if (method === 'GET' && path === '/rest/api/3/issueLinkType') return { status: 200, body: { issueLinkTypes: LINK_TYPES.map((type) => ({ ...type, self: `https://fixture.invalid/rest/api/3/issueLinkType/${type.id}` })) } }
    if (method === 'POST' && path === '/rest/api/3/issueLink') return this.addLink(request.body)
    if (method === 'DELETE' && (match = /^\/rest\/api\/3\/issueLink\/(\d+)$/.exec(path)) !== null) {
      const at = this.links.findIndex((link) => link.id === match?.[1])
      if (at < 0) return notFound('No issue link with id exists.')
      this.links.splice(at, 1)
      return { status: 204, body: null }
    }
    if (method === 'GET' && path === '/rest/api/3/priority/search') return offsetPage({ list: this.priorities.map((priority) => ({ ...priority, self: `https://fixture.invalid/rest/api/3/priority/${priority.id}`, statusColor: '#999999' })), query: request.query, key: 'values', limit: 50, isLast: true })
    if (method === 'GET' && (match = /^\/rest\/api\/3\/issue\/createmeta\/([^/]+)\/issuetypes\/([^/]+)$/.exec(path)) !== null) return this.createMeta(decodeURIComponent(match[1] ?? ''), decodeURIComponent(match[2] ?? ''), request.query)
    if (method === 'GET' && path === '/rest/agile/1.0/board') return this.boards(request.query)
    if (method === 'PUT' && path === '/rest/agile/1.0/issue/rank') return this.rank(request.body)
    return notFound(`fixture: no route ${method} ${path}`)
  }

  private project(key: string): FxProject | null {
    return this.projects.find((project) => project.key === key.toUpperCase() || project.id === key) ?? null
  }

  private projectBean(project: FxProject, withTypes: boolean): Record<string, unknown> {
    const bean: Record<string, unknown> = { self: `https://fixture.invalid/rest/api/3/project/${project.id}`, id: project.id, key: project.key, name: project.name, projectTypeKey: project.boards > 0 ? 'software' : 'business', simplified: false, style: 'classic', isPrivate: false }
    if (withTypes) bean.issueTypes = project.types.map((type) => ({ self: `https://fixture.invalid/rest/api/3/issuetype/${type.id}`, id: type.id, name: type.name, subtask: type.subtask, hierarchyLevel: type.hierarchyLevel, description: '', iconUrl: '' }))
    if (this.corrupt === 'project-no-key') delete bean.key
    return bean
  }

  private projectSearch(query: Record<string, string>): Reply {
    const list = [...this.projects].sort((a, b) => a.key.localeCompare(b.key)).map((project) => this.projectBean(project, query.expand?.includes('issueTypes') ?? false))
    return offsetPage({ list, query, key: 'values', limit: 100, isLast: true })
  }

  private projectStatuses(key: string): Reply {
    const project = this.project(key)
    if (project === null) return notFound(`No project could be found with key '${key}'.`)
    return {
      status: 200,
      body: project.types.map((type) => ({
        self: `https://fixture.invalid/rest/api/3/issuetype/${type.id}`, id: type.id, name: type.name, subtask: type.subtask,
        statuses: (project.statusesByType[type.id] ?? []).map((statusId) => this.statusBean(statusId)),
      })),
    }
  }

  private statusBean(statusId: string): Record<string, unknown> {
    const status = STATUS[statusId] ?? { id: statusId, name: statusId, category: 'new' }
    // `undefined` = 명세의 「No Category」 분류(id 1) — 깨진 응답이 아니다. 깨기는 명세에 없는 키로(R1-I).
    const category = this.corrupt === 'unknown-category' && status.category === 'done' ? 'mystery' : this.noCategory.has(status.id) ? 'undefined' : status.category
    return { self: `https://fixture.invalid/rest/api/3/status/${status.id}`, id: status.id, name: status.name, description: '', iconUrl: '', statusCategory: { self: `https://fixture.invalid/rest/api/3/statuscategory/${CATEGORY_ID[category] ?? 1}`, id: CATEGORY_ID[category] ?? 1, key: category, name: category, colorName: 'blue-gray' } }
  }

  private linkedBean(issue: FxIssue): Record<string, unknown> {
    return { id: issue.id, key: issue.key, self: `https://fixture.invalid/rest/api/3/issue/${issue.id}`, fields: { summary: issue.summary, status: this.statusBean(issue.statusId), priority: this.priorityBean(issue.priorityId), issuetype: this.typeBean(issue) } }
  }

  private typeBean(issue: FxIssue): Record<string, unknown> {
    const type = this.projects.flatMap((project) => project.types).find((entry) => entry.id === issue.typeId) ?? TASK
    return { self: `https://fixture.invalid/rest/api/3/issuetype/${type.id}`, id: type.id, name: type.name, subtask: type.subtask, hierarchyLevel: type.hierarchyLevel, iconUrl: '' }
  }

  private priorityBean(id: string | null): Record<string, unknown> | null {
    const priority = this.priorities.find((entry) => entry.id === id)
    return priority === undefined ? null : { self: `https://fixture.invalid/rest/api/3/priority/${priority.id}`, id: priority.id, name: priority.name, iconUrl: '' }
  }

  private issueBean(issue: FxIssue, fields: string[] | null): Record<string, unknown> {
    const project = this.project(issue.projectKey)
    const all: Record<string, unknown> = {
      summary: issue.summary,
      description: issue.description,
      status: this.statusBean(issue.statusId),
      issuetype: this.typeBean(issue),
      parent: issue.parentId === null ? undefined : (() => { const parent = this.issue(issue.parentId ?? ''); return parent === null ? undefined : this.linkedBean(parent) })(),
      priority: this.priorityBean(issue.priorityId),
      duedate: issue.duedate,
      resolution: issue.resolution === null ? null : { self: 'https://fixture.invalid/rest/api/3/resolution/10000', id: issue.resolution === 'Done' ? '10000' : '10001', name: issue.resolution, description: '' },
      project: project === null ? undefined : { self: `https://fixture.invalid/rest/api/3/project/${project.id}`, id: project.id, key: project.key, name: project.name },
      updated: new Date(issue.updated).toISOString().replace('Z', '+0000'),
      created: new Date(issue.created).toISOString().replace('Z', '+0000'),
      issuelinks: this.links.flatMap((link): unknown[] => {
        const type = LINK_TYPES.find((entry) => entry.id === link.typeId)
        if (type === undefined) return []
        // 「inward A · outward B」 = A <outward 글> B. A 의 목록에는 outwardIssue B, B 의 목록에는 inwardIssue A.
        if (link.inward === issue.id) { const other = this.issue(link.outward); return other === null ? [] : [{ id: link.id, self: `https://fixture.invalid/rest/api/3/issueLink/${link.id}`, type: { ...type, self: '' }, outwardIssue: this.linkedBean(other) }] }
        if (link.outward === issue.id) { const other = this.issue(link.inward); return other === null ? [] : [{ id: link.id, self: `https://fixture.invalid/rest/api/3/issueLink/${link.id}`, type: { ...type, self: '' }, inwardIssue: this.linkedBean(other) }] }
        return []
      }),
      ...issue.fieldValues,
    }
    if (this.corrupt === 'issue-no-status') delete all.status
    const picked = fields === null ? all : Object.fromEntries(Object.entries(all).filter(([key]) => fields.includes(key) || fields.includes('*all')))
    for (const key of Object.keys(picked)) if (picked[key] === undefined) delete picked[key]
    return { expand: 'renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations', id: issue.id, key: issue.key, self: `https://fixture.invalid/rest/api/3/issue/${issue.id}`, fields: picked }
  }

  private searchJql(query: Record<string, string>): Reply {
    const jql = query.jql ?? ''
    const parsed = parseJql(jql)
    if (!parsed.ok) return { status: 400, body: { errorMessages: [parsed.message], errors: {}, warningMessages: [] } }
    for (const field of parsed.fields) if (!JQL_FIELDS.has(field)) return { status: 400, body: { errorMessages: [`Field '${field}' does not exist or you do not have permission to view it.`], errors: {} } }
    if (parsed.order.some((entry) => entry.field === 'rank') && !this.agile) return { status: 400, body: { errorMessages: ["Field 'Rank' does not exist or you do not have permission to view it."], errors: {} } }
    for (const key of parsed.projects) if (this.project(key) === null) return { status: 400, body: { errorMessages: [`The value '${key}' does not exist for the field 'project'.`], errors: {} } }
    const max = Math.min(Number(query.maxResults ?? '50') || 50, 5000)
    const fingerprint = Buffer.from(jql).toString('base64url').slice(0, 24)
    let offset = 0
    if (query.nextPageToken !== undefined) {
      const decoded = safeParse(Buffer.from(query.nextPageToken, 'base64url').toString('utf8'))
      if (!isRecord(decoded) || decoded.q !== fingerprint || typeof decoded.o !== 'number') return { status: 400, body: { errorMessages: ['The provided next page token is invalid or expired.'], errors: {} } }
      offset = decoded.o
    }
    const matched = this.issues.filter((issue) => parsed.where(this.view(issue))).sort((a, b) => compareIssues({ a: this.view(a), b: this.view(b), order: parsed.order }))
    const page = matched.slice(offset, offset + max)
    const fields = fieldList(query.fields) ?? ['id']
    const body: Record<string, unknown> = { issues: page.map((issue) => fields.length === 1 && fields[0] === 'id' ? { id: issue.id, key: issue.key, fields: {} } : this.issueBean(issue, fields)) }
    if (offset + max < matched.length) body.nextPageToken = Buffer.from(JSON.stringify({ q: fingerprint, o: offset + max })).toString('base64url')
    else if (this.sendIsLast) body.isLast = true
    if (this.corrupt === 'search-issues-object') body.issues = {}
    return { status: 200, body }
  }

  private view(issue: FxIssue): JqlRow {
    const status = STATUS[issue.statusId]
    const plain = JSON.stringify(issue.description ?? '').replace(/"type":"[^"]*"|"attrs":\{[^}]*\}|[{}[\]",:]/g, ' ')
    return { project: issue.projectKey, parent: issue.parentId ?? '', key: issue.key, id: issue.id, summary: issue.summary, text: `${issue.summary} ${plain}`, status: status?.name ?? '', statusCategory: status?.category ?? '', type: issue.typeId, priority: this.priorities.find((entry) => entry.id === issue.priorityId)?.name ?? '', rank: issue.rank, created: issue.created, updated: issue.updated }
  }

  private transitions(issue: FxIssue, withFields: boolean): unknown[] {
    const project = this.project(issue.projectKey)
    const list = project?.workflow[issue.statusId] ?? []
    return list.map((transition) => {
      const bean: Record<string, unknown> = { id: transition.id, name: transition.name, to: this.statusBean(transition.to), hasScreen: (transition.required ?? []).length > 0, isGlobal: false, isInitial: false, isAvailable: true, isConditional: false, looped: false }
      if (withFields) bean.fields = Object.fromEntries((transition.required ?? []).map((field) => [field.key, { required: true, schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield', customId: 10060 }, name: field.name, key: field.key, hasDefaultValue: false, operations: ['set'] }]))
      if (this.corrupt === 'transition-no-to') delete bean.to
      return bean
    })
  }

  private record({ issue, items, meta }: { issue: FxIssue; items: FxHistory['items']; meta: unknown }): void {
    if (items.length === 0) return
    issue.updated += 60_000
    const list = this.history.get(issue.id) ?? []
    list.push({ id: String(this.seq++), created: issue.updated, historyMetadata: this.echoHistory && isRecord(meta) ? meta : null, items })
    this.history.set(issue.id, list)
  }

  private historyBean(entry: FxHistory): Record<string, unknown> {
    const bean: Record<string, unknown> = { id: entry.id, author: { accountId: 'acc-1', displayName: 'Fixture User', active: true }, created: new Date(entry.created).toISOString().replace('Z', '+0000'), items: entry.items.map((item) => ({ ...item, fieldtype: 'jira', from: null, to: null })) }
    if (entry.historyMetadata !== null) bean.historyMetadata = entry.historyMetadata
    return bean
  }

  private doTransition(issue: FxIssue, body: unknown): Reply {
    if (!isRecord(body) || !isRecord(body.transition) || typeof body.transition.id !== 'string') return badRequest('Missing transition id.')
    const project = this.project(issue.projectKey)
    const transition = (project?.workflow[issue.statusId] ?? []).find((entry) => entry.id === (isRecord(body.transition) ? body.transition.id : ''))
    if (transition === undefined) return badRequest(`Transition id '${String(body.transition.id)}' is not valid for this issue.`)
    const given = isRecord(body.fields) ? body.fields : {}
    for (const field of transition.required ?? []) if (typeof given[field.key] !== 'string' || String(given[field.key]).trim() === '') return { status: 400, body: { errorMessages: [], errors: { [field.key]: `${field.name} is required.` } } }
    const from = STATUS[issue.statusId]
    const to = STATUS[transition.to]
    const items: FxHistory['items'] = [{ field: 'status', fieldId: 'status', fromString: from?.name ?? null, toString: to?.name ?? null }]
    issue.statusId = transition.to
    // 완료 분류로 가면 해결 = Done(워크플로 후처리), 나가면 비운다.
    const resolution = to?.category === 'done' ? 'Done' : null
    if (resolution !== issue.resolution) items.push({ field: 'resolution', fieldId: 'resolution', fromString: issue.resolution, toString: resolution })
    issue.resolution = resolution
    this.record({ issue, items, meta: body.historyMetadata })
    return { status: 204, body: null }
  }

  private editIssue(issue: FxIssue, body: unknown): Reply {
    if (!isRecord(body) || !isRecord(body.fields)) return badRequest('No fields.')
    const items: FxHistory['items'] = []
    for (const [key, value] of Object.entries(body.fields)) {
      switch (key) {
        case 'summary':
          if (typeof value !== 'string' || value.trim() === '') return { status: 400, body: { errorMessages: [], errors: { summary: 'You must specify a summary of the issue.' } } }
          items.push({ field: 'summary', fieldId: 'summary', fromString: issue.summary, toString: value })
          issue.summary = value
          break
        case 'description':
          if (value !== null && !isAdf(value)) return { status: 400, body: { errorMessages: [], errors: { description: 'Operation value must be an Atlassian Document (see the Atlassian Document Format).' } } }
          items.push({ field: 'description', fieldId: 'description', fromString: null, toString: null })
          issue.description = isAdf(value) ? value : null
          break
        case 'priority': {
          const id = isRecord(value) && typeof value.id === 'string' ? value.id : null
          if (id === null || !this.priorities.some((entry) => entry.id === id)) return { status: 400, body: { errorMessages: [], errors: { priority: 'Specify a valid priority.' } } }
          items.push({ field: 'priority', fieldId: 'priority', fromString: this.priorities.find((entry) => entry.id === issue.priorityId)?.name ?? null, toString: this.priorities.find((entry) => entry.id === id)?.name ?? null })
          issue.priorityId = id
          break
        }
        case 'duedate':
          if (value !== null && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))) return { status: 400, body: { errorMessages: [], errors: { duedate: 'Error parsing date string.' } } }
          items.push({ field: 'duedate', fieldId: 'duedate', fromString: issue.duedate, toString: typeof value === 'string' ? value : null })
          issue.duedate = typeof value === 'string' ? value : null
          break
        case 'parent': {
          const parentId = value === null ? null : isRecord(value) && typeof value.id === 'string' ? value.id : undefined
          if (parentId === undefined || (parentId !== null && this.issue(parentId) === null)) return { status: 400, body: { errorMessages: [], errors: { parent: 'Could not find issue by id or key.' } } }
          items.push({ field: 'IssueParentAssociation', fieldId: 'parent', fromString: issue.parentId === null ? null : this.issue(issue.parentId)?.key ?? null, toString: parentId === null ? null : this.issue(parentId)?.key ?? null })
          issue.parentId = parentId
          break
        }
        default:
          return { status: 400, body: { errorMessages: [], errors: { [key]: `Field '${key}' cannot be set. It is not on the appropriate screen, or unknown.` } } }
      }
    }
    this.record({ issue, items, meta: body.historyMetadata })
    return { status: 204, body: null }
  }

  private createFields(project: FxProject, typeId: string): FxCreateField[] {
    const system = (fieldId: string, name: string, required: boolean, schema: Record<string, unknown>, extra: Partial<FxCreateField> = {}): FxCreateField => ({ fieldId, name, required, hasDefaultValue: false, schema, ...extra })
    const fields: FxCreateField[] = [
      system('summary', 'Summary', true, { type: 'string', system: 'summary' }),
      system('issuetype', 'Issue Type', true, { type: 'issuetype', system: 'issuetype' }),
      system('project', 'Project', true, { type: 'project', system: 'project' }),
      system('description', 'Description', false, { type: 'string', system: 'description' }),
      // 보고자 — 필수지만 안 보내면 Jira 가 부른 사람으로 채운다. 실제 사이트의 `hasDefaultValue` 값은 모른다(F19) — 출처는 그 값에 기대지 않고 시스템 칸으로 뺀다(R1-F).
      system('reporter', 'Reporter', true, { type: 'user', system: 'reporter' }),
    ]
    if (typeId !== EPIC.id) fields.push(system('priority', 'Priority', false, { type: 'priority', system: 'priority' }, { allowedValues: this.priorities.map((entry) => ({ id: entry.id, value: entry.name })) }))
    if (typeId !== EPIC.id) fields.push(system('parent', 'Parent', typeId === SUBTASK.id, { type: 'issuelink', system: 'parent' }))
    if (typeId === BUG.id) {
      fields.push(system('customfield_10050', 'Severity', true, { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select', customId: 10050 }, { allowedValues: [{ id: '10100', value: 'S1' }, { id: '10101', value: 'S2' }, { id: '10102', value: 'S3' }] }))
      fields.push(system('environment', 'Environment', false, { type: 'string', system: 'environment' }))
    }
    void project
    return fields
  }

  private createMeta(projectKey: string, typeId: string, query: Record<string, string>): Reply {
    const project = this.project(projectKey)
    if (project === null || !project.types.some((type) => type.id === typeId)) return badRequest('Issue type with the given id does not exist in the project.')
    const list = this.createFields(project, typeId).map((field) => ({ ...field, key: field.fieldId, operations: ['set'] }))
    return offsetPage({ list, query, key: 'fields', limit: 200 })
  }

  private createIssue(body: unknown): Reply {
    if (!isRecord(body) || !isRecord(body.fields)) return badRequest('No fields.')
    const fields = body.fields
    const projectKey = isRecord(fields.project) && typeof fields.project.key === 'string' ? fields.project.key : ''
    const project = this.project(projectKey)
    const typeId = isRecord(fields.issuetype) && typeof fields.issuetype.id === 'string' ? fields.issuetype.id : ''
    if (project === null) return { status: 400, body: { errorMessages: [], errors: { project: 'valid project is required' } } }
    const type = project.types.find((entry) => entry.id === typeId)
    if (type === undefined) return { status: 400, body: { errorMessages: [], errors: { issuetype: 'valid issue type is required' } } }
    const meta = this.createFields(project, typeId)
    for (const key of Object.keys(fields)) if (!meta.some((field) => field.fieldId === key)) return { status: 400, body: { errorMessages: [], errors: { [key]: `Field '${key}' cannot be set. It is not on the appropriate screen, or unknown.` } } }
    for (const field of meta) if (field.required && !field.hasDefaultValue && field.fieldId !== 'reporter' && (fields[field.fieldId] === undefined || fields[field.fieldId] === null || fields[field.fieldId] === '')) return { status: 400, body: { errorMessages: [], errors: { [field.fieldId]: `${field.name} is required.` } } }
    if (typeof fields.summary !== 'string' || fields.summary.trim() === '') return { status: 400, body: { errorMessages: [], errors: { summary: 'You must specify a summary of the issue.' } } }
    if (fields.description !== undefined && !isAdf(fields.description)) return { status: 400, body: { errorMessages: [], errors: { description: 'Operation value must be an Atlassian Document (see the Atlassian Document Format).' } } }
    const parentId = isRecord(fields.parent) && typeof fields.parent.id === 'string' ? fields.parent.id : null
    const parent = parentId === null ? null : this.issue(parentId)
    if (parentId !== null && parent === null) return { status: 400, body: { errorMessages: [], errors: { parent: 'Could not find issue by id or key.' } } }
    const fieldValues: Record<string, unknown> = {}
    const severity = fields.customfield_10050
    if (severity !== undefined) {
      if (!isRecord(severity) || !['10100', '10101', '10102'].includes(String(severity.id))) return { status: 400, body: { errorMessages: [], errors: { customfield_10050: 'Specify a valid value for Severity' } } }
      fieldValues.customfield_10050 = { id: String(severity.id), value: { 10100: 'S1', 10101: 'S2', 10102: 'S3' }[String(severity.id)] }
    }
    const priorityId = isRecord(fields.priority) && typeof fields.priority.id === 'string' ? fields.priority.id : '3'
    const seq = this.issues.filter((issue) => issue.projectKey === project.key).length + 100
    const now = Date.parse('2026-10-16T00:00:00.000Z') + this.seq * 1000
    const issue: FxIssue = {
      id: String(this.seq++), key: `${project.key}-${seq}`, projectKey: project.key, summary: fields.summary, description: isAdf(fields.description) ? fields.description : null, typeId, statusId: project.initial,
      resolution: null, priorityId, duedate: null, parentId, rank: Math.max(0, ...this.issues.map((entry) => entry.rank)) + 1, created: now, updated: now, fieldValues,
    }
    this.issues.push(issue)
    return { status: 201, body: { id: issue.id, key: issue.key, self: `https://fixture.invalid/rest/api/3/issue/${issue.id}` } }
  }

  private addComment(issue: FxIssue, body: unknown): Reply {
    if (!isRecord(body) || !isAdf(body.body)) return { status: 400, body: { errorMessages: [], errors: { comment: 'Comment body can not be empty!' } } }
    const comment: FxComment = { id: String(this.seq++), body: body.body, created: Date.parse('2026-10-16T00:00:00.000Z') + this.seq * 1000 }
    this.comments.set(issue.id, [...(this.comments.get(issue.id) ?? []), comment])
    return { status: 201, body: commentBean(comment) }
  }

  private addLink(body: unknown): Reply {
    if (!isRecord(body) || !isRecord(body.type) || !isRecord(body.inwardIssue) || !isRecord(body.outwardIssue)) return badRequest('Link type, inward and outward issues are required.')
    const type = LINK_TYPES.find((entry) => entry.id === (isRecord(body.type) ? body.type.id : null) || entry.name === (isRecord(body.type) ? body.type.name : null))
    const ref = (value: Record<string, unknown>): FxIssue | null => this.issue(String(value.id ?? value.key ?? ''))
    const inward = ref(body.inwardIssue)
    const outward = ref(body.outwardIssue)
    if (type === undefined) return notFound('No issue link type with name or id exists.')
    if (inward === null || outward === null) return notFound('Issue does not exist or you do not have permission to see it.')
    this.links.push({ id: String(this.seq++), typeId: type.id, inward: inward.id, outward: outward.id })
    return { status: 201, body: null }
  }

  private boards(query: Record<string, string>): Reply {
    const list = this.projects.filter((project) => project.boards > 0).flatMap((project) => Array.from({ length: project.boards }, (_, index) => ({ id: Number(project.id) + index, self: '', name: `${project.key} board`, type: 'scrum', location: { projectId: Number(project.id), projectKey: project.key, projectName: project.name, displayName: project.name } })))
    return offsetPage({ list, query, key: 'values', limit: 50, isLast: true })
  }

  private rank(body: unknown): Reply {
    if (!isRecord(body) || !Array.isArray(body.issues) || body.issues.length === 0 || body.issues.length > 50) return badRequest('issues must contain 1..50 issues.')
    const anchorId = typeof body.rankAfterIssue === 'string' ? body.rankAfterIssue : typeof body.rankBeforeIssue === 'string' ? body.rankBeforeIssue : null
    const anchor = anchorId === null ? null : this.issue(anchorId)
    if (anchor === null) return badRequest('rankBeforeIssue or rankAfterIssue is required.')
    const moving = body.issues.map((entry) => this.issue(String(entry)))
    if (moving.some((entry) => entry === null)) return badRequest('Issue does not exist.')
    if (this.corrupt === 'rank-207') return { status: 207, body: { entries: moving.map((entry) => ({ issueId: Number(entry?.id), issueKey: entry?.key, status: 503, errors: ['JIRA Agile cannot execute the rank operation at this time. Please try again later.'] })) } }
    const ordered = [...this.issues].sort((a, b) => a.rank - b.rank).filter((issue) => !moving.includes(issue))
    const at = ordered.indexOf(anchor) + (typeof body.rankAfterIssue === 'string' ? 1 : 0)
    ordered.splice(at, 0, ...moving.filter((entry): entry is FxIssue => entry !== null))
    ordered.forEach((issue, index) => { issue.rank = index + 1 })
    return { status: 204, body: null }
  }
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> }

function send({ response, status, body, headers = {} }: { response: ServerResponse; status: number; body: unknown; headers?: Record<string, string> }): void {
  const text = body === null || status === 204 ? '' : JSON.stringify(body)
  response.writeHead(status, { ...(text === '' ? {} : { 'content-type': 'application/json;charset=UTF-8' }), ...headers })
  response.end(text)
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    request.on('data', (chunk) => { data += String(chunk) })
    request.on('end', () => resolve(data))
    request.on('error', () => resolve(data))
  })
}

function notFound(message: string): Reply {
  return { status: 404, body: { errorMessages: [message], errors: {} } }
}

function badRequest(message: string): Reply {
  return { status: 400, body: { errorMessages: [message], errors: {} } }
}

function isAdf(value: unknown): value is Adf {
  return isRecord(value) && value.type === 'doc' && value.version === 1 && Array.isArray(value.content)
}

function fieldList(value: string | undefined): string[] | null {
  return value === undefined ? null : value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

/** offset 페이지 — 명세 `PageBean*`(`startAt`·`maxResults`·`total`·`isLast`·`values`) 또는 `PageOf*`(`isLast` 없음). */
function offsetPage({ list, query, key, limit, isLast }: { list: unknown[]; query: Record<string, string>; key: string; limit: number; isLast?: boolean }): Reply {
  const startAt = Math.max(0, Number(query.startAt ?? '0') || 0)
  const maxResults = Math.min(limit, Math.max(1, Number(query.maxResults ?? String(limit)) || limit))
  const values = list.slice(startAt, startAt + maxResults)
  const body: Record<string, unknown> = { self: 'https://fixture.invalid/page', maxResults, startAt, total: list.length, [key]: values }
  if (isLast === true || key === 'values') body.isLast = startAt + values.length >= list.length
  return { status: 200, body }
}

function commentPage({ list, query }: { list: unknown[]; query: Record<string, string> }): Reply {
  const startAt = Math.max(0, Number(query.startAt ?? '0') || 0)
  const maxResults = Math.min(100, Math.max(1, Number(query.maxResults ?? '100') || 100))
  return { status: 200, body: { comments: list.slice(startAt, startAt + maxResults), maxResults, startAt, total: list.length } }
}

function commentBean(comment: FxComment): Record<string, unknown> {
  const at = new Date(comment.created).toISOString().replace('Z', '+0000')
  return { self: `https://fixture.invalid/rest/api/3/comment/${comment.id}`, id: comment.id, author: { accountId: 'acc-1', displayName: 'Fixture User', active: true }, body: comment.body, created: at, updated: at, jsdPublic: true }
}

// --- 작은 JQL ---

type JqlRow = Record<string, string | number>
type JqlOrder = { field: string; desc: boolean }
type JqlParsed = { ok: true; where: (row: JqlRow) => boolean; order: JqlOrder[]; fields: string[]; projects: string[] } | { ok: false; message: string }

const JQL_FIELDS = new Set(['project', 'parent', 'key', 'issuekey', 'id', 'summary', 'text', 'status', 'statuscategory', 'issuetype', 'type', 'priority', 'rank', 'created', 'updated'])
const FIELD_ALIAS: Record<string, string> = { issuekey: 'key', statuscategory: 'statusCategory', issuetype: 'type' }

type Token = { kind: 'word' | 'string' | 'op' | 'punct'; value: string }

function tokenize(jql: string): Token[] | string {
  const tokens: Token[] = []
  let index = 0
  while (index < jql.length) {
    const char = jql[index] ?? ''
    if (/\s/.test(char)) { index += 1; continue }
    if (char === '"' || char === "'") {
      let value = ''
      index += 1
      for (;;) {
        if (index >= jql.length) return `Error in the JQL Query: The quoted string '${value}' has not been completed.`
        const next = jql[index] ?? ''
        if (next === '\\') { value += jql[index + 1] ?? ''; index += 2; continue }
        if (next === char) { index += 1; break }
        value += next
        index += 1
      }
      tokens.push({ kind: 'string', value })
      continue
    }
    const op = /^(!=|!~|>=|<=|=|~|>|<)/.exec(jql.slice(index))
    if (op !== null) { tokens.push({ kind: 'op', value: op[0] }); index += op[0].length; continue }
    if (char === '(' || char === ')' || char === ',') { tokens.push({ kind: 'punct', value: char }); index += 1; continue }
    const word = /^[A-Za-z0-9_.-]+/.exec(jql.slice(index))
    if (word === null) return `Error in the JQL Query: The character '${char}' is a reserved JQL character.`
    tokens.push({ kind: 'word', value: word[0] })
    index += word[0].length
  }
  return tokens
}

export function parseJql(jql: string): JqlParsed {
  const tokens = tokenize(jql)
  if (typeof tokens === 'string') return { ok: false, message: tokens }
  let at = 0
  const fields: string[] = []
  const projects: string[] = []
  const peek = (): Token | undefined => tokens[at]
  const isWord = (value: string): boolean => peek()?.kind === 'word' && peek()?.value.toUpperCase() === value
  const fail = (message: string): never => { throw new Error(message) }
  const value = (): string => {
    const token = tokens[at++]
    if (token === undefined || (token.kind !== 'string' && token.kind !== 'word')) return fail(`Error in the JQL Query: Expecting a value but got '${token?.value ?? 'end'}'.`)
    return token.value
  }
  const clause = (): ((row: JqlRow) => boolean) => {
    if (peek()?.kind === 'punct' && peek()?.value === '(') {
      at += 1
      const inner = or()
      if (tokens[at++]?.value !== ')') fail("Error in the JQL Query: Expecting ')'.")
      return inner
    }
    if (isWord('NOT')) { at += 1; const inner = clause(); return (row) => !inner(row) }
    const fieldToken = tokens[at++]
    if (fieldToken === undefined || fieldToken.kind !== 'word') return fail(`Error in the JQL Query: Expecting a field name but got '${fieldToken?.value ?? 'end'}'.`)
    const name = fieldToken.value.toLowerCase()
    fields.push(name)
    const field = FIELD_ALIAS[name] ?? name
    if (isWord('IN')) {
      at += 1
      if (tokens[at++]?.value !== '(') fail("Error in the JQL Query: Expecting '(' after IN.")
      const values: string[] = []
      while (peek() !== undefined && peek()?.value !== ')') {
        values.push(value())
        if (peek()?.value === ',') at += 1
      }
      at += 1
      if (field === 'project') projects.push(...values)
      return (row) => values.some((entry) => String(row[field] ?? '').toUpperCase() === entry.toUpperCase())
    }
    if (isWord('IS')) {
      at += 1
      const negate = isWord('NOT')
      if (negate) at += 1
      if (!isWord('EMPTY') && !isWord('NULL')) fail('Error in the JQL Query: Expecting EMPTY after IS.')
      at += 1
      return (row) => (String(row[field] ?? '') === '') !== negate
    }
    const op = tokens[at++]
    if (op === undefined || op.kind !== 'op') return fail(`Error in the JQL Query: Expecting operator but got '${op?.value ?? 'end'}'.`)
    const target = value()
    if (field === 'project' && op.value === '=') projects.push(target)
    switch (op.value) {
      case '=': return (row) => String(row[field] ?? '').toUpperCase() === target.toUpperCase()
      case '!=': return (row) => String(row[field] ?? '').toUpperCase() !== target.toUpperCase()
      case '~': return (row) => target.toLowerCase().split(/\s+/).filter(Boolean).every((word) => String(row[field] ?? '').toLowerCase().includes(word))
      case '!~': return (row) => !String(row[field] ?? '').toLowerCase().includes(target.toLowerCase())
      default: return fail(`Error in the JQL Query: The operator '${op.value}' is not supported by the '${fieldToken.value}' field.`)
    }
  }
  const and = (): ((row: JqlRow) => boolean) => {
    let left = clause()
    while (isWord('AND')) { at += 1; const right = clause(); const prev = left; left = (row) => prev(row) && right(row) }
    return left
  }
  const or = (): ((row: JqlRow) => boolean) => {
    let left = and()
    while (isWord('OR')) { at += 1; const right = and(); const prev = left; left = (row) => prev(row) || right(row) }
    return left
  }
  try {
    const where = peek() === undefined || isWord('ORDER') ? () => true : or()
    const order: JqlOrder[] = []
    if (isWord('ORDER')) {
      at += 1
      if (!isWord('BY')) fail("Error in the JQL Query: Expecting 'by' after 'order'.")
      at += 1
      for (;;) {
        const field = tokens[at++]
        if (field === undefined || field.kind !== 'word') fail('Error in the JQL Query: Expecting a field name after ORDER BY.')
        const name = (field?.value ?? '').toLowerCase()
        if (!JQL_FIELDS.has(name)) fail(`Not able to sort using field '${field?.value ?? ''}'.`)
        let desc = false
        if (isWord('ASC') || isWord('DESC')) { desc = peek()?.value.toUpperCase() === 'DESC'; at += 1 }
        order.push({ field: FIELD_ALIAS[name] ?? name, desc })
        if (peek()?.value !== ',') break
        at += 1
      }
    }
    if (at < tokens.length) fail(`Error in the JQL Query: Expecting either 'OR' or 'AND' but got '${tokens[at]?.value ?? ''}'.`)
    return { ok: true, where, order, fields, projects }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function compareIssues({ a, b, order }: { a: JqlRow; b: JqlRow; order: JqlOrder[] }): number {
  for (const entry of order.length === 0 ? [{ field: 'created', desc: true }] : order) {
    const left = a[entry.field] ?? ''
    const right = b[entry.field] ?? ''
    const diff = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right))
    if (diff !== 0) return entry.desc ? -diff : diff
  }
  return Number(a.id) - Number(b.id)
}
