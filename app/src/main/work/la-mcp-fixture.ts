// LA MCP 모의 서버 (LIFE-600 C2·C3·C5) — 테스트·격리 실행이 실제 LA 대신 붙는 HTTP 서버. 127.0.0.1 임시 포트에만 연다.
//
// 실측(00-analysis §3 · raw/coordinator/m01·m02)을 따른 것:
//   - 응답은 SSE(`text/event-stream`) 한 이벤트, protocol `2025-06-18`, 세션 헤더 없음(무상태).
//   - 토큰 없음·`life_pat_` 가 아닌 토큰 = 500 `INTERNAL_ERROR` · 형식 맞는 모르는 토큰 = 401 `UNAUTHORIZED`.
// 실측하지 못한 것(네이티브 C13 ② 에서 확인): scope 부족 = HTTP 403 `FORBIDDEN` 으로 둔다.
//
// 제어: `fault`(다음 요청들의 HTTP 상태 강제 · 소켓 끊기 · 지연) · `corrupt`(응답 한 칸 깨기 — 양성 대조) · `protocolVersion`.
// `requests` 에 받은 요청(메서드·도구 이름·토큰 접두사 여부)을 쌓는다 — 「보내기 전에 거절」 을 요청 0건으로 확인한다.
// 토큰 원문은 기록하지 않는다.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { isRecord, safeParse } from '../../shared/json.js'
import { readWorkRelationKind, type WorkCategory, type WorkRelationKind } from '../../shared/work.js'

export type FixtureScope = 'write' | 'read'
export type FixtureFault = { kind: 'http'; status: number; body: string } | { kind: 'drop' } | { kind: 'delay'; ms: number }
/** 양성 대조용 깨기 — `issue-statusId`: 일감 행의 statusId 를 숫자로 · `tool-error`: 도구 결과를 isError 로 · `drop-statusLabel`: statusLabel 칸 삭제. */
export type FixtureCorrupt = 'issue-statusId' | 'tool-error' | 'drop-statusLabel'

type FixtureStatus = { id: string; categoryKey: WorkCategory; label: string; color: string | null; position: number; isDefault: boolean }
type FixtureIssue = {
  id: string
  sequentialId: number
  kind: 'project' | 'checkpoint' | 'task' | 'bug'
  parentId: string | null
  title: string
  description: string | null
  priority: string | null
  statusId: string
  resolution: string | null
  color: string | null
  position: string
  onBoard: boolean
  dueAt: string | null
  archivedAt: string | null
  updatedAt: string
}
type FixtureLink = { id: string; from: string; to: string; relation: WorkRelationKind }

export type FixtureRequest = { method: string; tool: string | null; bearer: 'none' | 'life_pat' | 'other' }

const INVERSE: Record<WorkRelationKind, WorkRelationKind> = {
  is_blocked_by: 'blocks', blocks: 'is_blocked_by', duplicates: 'is_duplicated_by', is_duplicated_by: 'duplicates', relates_to: 'relates_to',
}
const WRITE_TOOLS = new Set(['issue_update', 'issue_transition', 'issue_link_create', 'issue_link_delete', 'issue_create'])

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const FIXTURE_STATUS = {
  todo: uuid(9001), analysis: uuid(9002), dev: uuid(9003), done: uuid(9004),
}

function seedStatuses(): FixtureStatus[] {
  return [
    { id: FIXTURE_STATUS.todo, categoryKey: 'todo', label: '할 일', color: null, position: 0, isDefault: true },
    { id: FIXTURE_STATUS.analysis, categoryKey: 'in_progress', label: '분석 중', color: null, position: 0, isDefault: true },
    { id: FIXTURE_STATUS.dev, categoryKey: 'in_progress', label: '개발 중', color: null, position: 1, isDefault: false },
    { id: FIXTURE_STATUS.done, categoryKey: 'done', label: '완료', color: null, position: 0, isDefault: true },
  ]
}

export const FIXTURE_IDS = {
  corral: uuid(337), lifeAssistant: uuid(2), doneProject: uuid(41),
  checkpoint: uuid(372), task600: uuid(600), task601: uuid(601), direct: uuid(500), orphanBug: uuid(385), archived: uuid(499), laTask: uuid(20),
}

function seedIssues(): FixtureIssue[] {
  const base = { description: null, priority: 'medium', resolution: null, color: null, onBoard: true, dueAt: null, archivedAt: null, updatedAt: '2026-10-13T00:00:00.000Z' }
  return [
    { ...base, id: FIXTURE_IDS.corral, sequentialId: 337, kind: 'project', parentId: null, title: 'corral', statusId: FIXTURE_STATUS.dev, color: '#c7b28a', position: '1', onBoard: false },
    { ...base, id: FIXTURE_IDS.lifeAssistant, sequentialId: 2, kind: 'project', parentId: null, title: 'life-assistant', statusId: FIXTURE_STATUS.dev, position: '2', onBoard: false },
    { ...base, id: FIXTURE_IDS.doneProject, sequentialId: 41, kind: 'project', parentId: null, title: '끝난 프로젝트', statusId: FIXTURE_STATUS.done, position: '3', onBoard: false },
    { ...base, id: FIXTURE_IDS.checkpoint, sequentialId: 372, kind: 'checkpoint', parentId: FIXTURE_IDS.corral, title: 'LA 일감 연결', statusId: FIXTURE_STATUS.analysis, position: '10' },
    { ...base, id: FIXTURE_IDS.task600, sequentialId: 600, kind: 'task', parentId: FIXTURE_IDS.checkpoint, title: '작업 계약·연결·LA provider', description: '본문 600', priority: 'high', statusId: FIXTURE_STATUS.dev, position: '18' },
    { ...base, id: FIXTURE_IDS.task601, sequentialId: 601, kind: 'task', parentId: FIXTURE_IDS.checkpoint, title: '작업 페이지', statusId: FIXTURE_STATUS.todo, position: '19' },
    { ...base, id: FIXTURE_IDS.direct, sequentialId: 500, kind: 'task', parentId: FIXTURE_IDS.corral, title: '프로젝트 직속 작업', statusId: FIXTURE_STATUS.todo, position: '20', onBoard: false },
    { ...base, id: FIXTURE_IDS.archived, sequentialId: 499, kind: 'task', parentId: FIXTURE_IDS.corral, title: '보관된 작업', statusId: FIXTURE_STATUS.todo, position: '21', archivedAt: '2026-10-01T00:00:00.000Z' },
    { ...base, id: FIXTURE_IDS.orphanBug, sequentialId: 385, kind: 'bug', parentId: null, title: '부모 없는 버그', statusId: FIXTURE_STATUS.todo, position: '30' },
    { ...base, id: FIXTURE_IDS.laTask, sequentialId: 20, kind: 'task', parentId: FIXTURE_IDS.lifeAssistant, title: 'LA 쪽 작업', statusId: FIXTURE_STATUS.done, position: '40', resolution: 'completed' },
  ]
}

export class LaMcpFixture {
  readonly tokens = new Map<string, FixtureScope>()
  readonly requests: FixtureRequest[] = []
  statuses = seedStatuses()
  issues = seedIssues()
  links: FixtureLink[] = []
  fault: FixtureFault | null = null
  corrupt: FixtureCorrupt | null = null
  protocolVersion = '2025-06-18'
  private server: http.Server | null = null
  private seq = 1

  async start(): Promise<string> {
    const server = http.createServer((request, response) => void this.handle(request, response))
    this.server = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address: AddressInfo | string | null = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture address')
    return `http://127.0.0.1:${address.port}/mcp`
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server === null) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    const body = safeParse(Buffer.concat(chunks).toString('utf8'))
    const method = isRecord(body) && typeof body.method === 'string' ? body.method : ''
    const params = isRecord(body) && isRecord(body.params) ? body.params : {}
    const tool = method === 'tools/call' && typeof params.name === 'string' ? params.name : null
    const auth = request.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    this.requests.push({ method, tool, bearer: token === '' ? 'none' : token.startsWith('life_pat_') ? 'life_pat' : 'other' })

    const fault = this.fault
    if (fault !== null) {
      if (fault.kind === 'drop') { request.socket.destroy(); return }
      if (fault.kind === 'http') { this.json({ response, status: fault.status, value: safeParse(fault.body) ?? fault.body }); return }
      await new Promise((resolve) => setTimeout(resolve, fault.ms))
    }
    if (request.method !== 'POST' || request.url !== '/mcp') { this.json({ response, status: 404, value: { code: 'NOT_FOUND' } }); return }
    if (!token.startsWith('life_pat_')) { this.json({ response, status: 500, value: { code: 'INTERNAL_ERROR', message: '잠시 후 다시 시도해주세요' } }); return }
    const scope = this.tokens.get(token)
    if (scope === undefined) { this.json({ response, status: 401, value: { code: 'UNAUTHORIZED', message: '인증이 필요해요' } }); return }
    if (tool !== null && scope === 'read' && WRITE_TOOLS.has(tool)) { this.json({ response, status: 403, value: { code: 'FORBIDDEN', message: '권한이 없어요' } }); return }

    const id = isRecord(body) ? body.id : undefined
    if (method === 'notifications/initialized') { response.writeHead(202).end(); return }
    if (method === 'initialize') {
      this.sse({ response, value: { jsonrpc: '2.0', id, result: { protocolVersion: this.protocolVersion, serverInfo: { name: 'life-assistant', version: '1.0.0' }, capabilities: { tools: { listChanged: true } } } } })
      return
    }
    if (method !== 'tools/call' || tool === null) {
      this.sse({ response, value: { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } } })
      return
    }
    const args = isRecord(params.arguments) ? params.arguments : {}
    const result = this.corrupt === 'tool-error' ? { isError: true, text: JSON.stringify({ code: 'INTERNAL', message: '깨진 도구' }) } : this.tool({ tool, args })
    this.sse({ response, value: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) } } })
  }

  private json({ response, status, value }: { response: http.ServerResponse; status: number; value: unknown }): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value))
  }

  private sse({ response, value }: { response: http.ServerResponse; value: unknown }): void {
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify(value)}\n\n`)
  }

  private tool({ tool, args }: { tool: string; args: Record<string, unknown> }): { isError: boolean; text: string } {
    const ok = (value: unknown): { isError: boolean; text: string } => ({ isError: false, text: JSON.stringify(value) })
    const fail = (code: string, message: string): { isError: boolean; text: string } => ({ isError: true, text: JSON.stringify({ code, message }) })
    const find = (id: unknown): FixtureIssue | undefined => this.issues.find((issue) => issue.id === id)
    switch (tool) {
      case 'status_list': return ok(this.statuses)
      case 'issue_list': {
        const archived = args.archived ?? 'exclude'
        const limit = typeof args.limit === 'number' ? args.limit : 50
        const rows = this.issues
          .filter((issue) => (archived === 'all' ? true : archived === 'only' ? issue.archivedAt !== null : issue.archivedAt === null))
          .filter((issue) => args.kind === undefined || issue.kind === args.kind)
          .filter((issue) => args.parentId === undefined || issue.parentId === args.parentId)
          .filter((issue) => args.categoryKey === undefined || this.status(issue).categoryKey === args.categoryKey)
          .slice(0, limit)
        return ok(rows.map((issue) => this.summary(issue)))
      }
      case 'issue_get': {
        const issue = find(args.id)
        return issue === undefined ? fail('NOT_FOUND', '일감을 찾을 수 없어요') : ok(this.full(issue))
      }
      case 'issue_transition': {
        const issue = find(args.id)
        if (issue === undefined) return fail('NOT_FOUND', '일감을 찾을 수 없어요')
        const target = this.statuses.find((status) => status.label === args.toStatusLabel)
        if (target === undefined) return fail('BAD_REQUEST', `없는 label — ${this.statuses.map((status) => status.label).join(', ')}`)
        const from = this.status(issue)
        const order = (status: FixtureStatus): number => ({ todo: 0, in_progress: 1, done: 2 })[status.categoryKey] * 100 + status.position
        const fromLabel = { label: from.label, categoryKey: from.categoryKey }
        if (target.id === from.id) return ok({ transitioned: false, reason: 'same', from: fromLabel, to: fromLabel, issue: this.full(issue) })
        if (args.forwardOnly !== false && order(target) < order(from)) return ok({ transitioned: false, reason: 'backward', from: fromLabel, to: { label: target.label, categoryKey: target.categoryKey }, issue: this.full(issue) })
        issue.statusId = target.id
        if (typeof args.resolution === 'string' || args.resolution === null) issue.resolution = args.resolution
        this.touch(issue)
        return ok({ transitioned: true, from: fromLabel, to: { label: target.label, categoryKey: target.categoryKey }, issue: this.full(issue) })
      }
      case 'issue_update': {
        const issue = find(args.id)
        if (issue === undefined) return fail('NOT_FOUND', '일감을 찾을 수 없어요')
        if (typeof args.statusId === 'string') {
          if (!this.statuses.some((status) => status.id === args.statusId)) return fail('BAD_REQUEST', '없는 statusId')
          issue.statusId = args.statusId
        }
        if (typeof args.onBoard === 'boolean') issue.onBoard = args.onBoard
        if ('parentId' in args) {
          const parentId = args.parentId
          if (parentId !== null && (typeof parentId !== 'string' || find(parentId) === undefined)) return fail('BAD_REQUEST', '없는 부모')
          issue.parentId = parentId
        }
        if ('resolution' in args && (typeof args.resolution === 'string' || args.resolution === null)) issue.resolution = args.resolution
        this.touch(issue)
        return ok(this.full(issue))
      }
      case 'issue_link_create': {
        const from = this.issues.find((issue) => issue.sequentialId === args.seq)
        const to = this.issues.find((issue) => issue.sequentialId === args.otherSeq)
        const kind = readWorkRelationKind(args.relation)
        if (from === undefined || to === undefined) return fail('NOT_FOUND', '없는 LIFE-N')
        if (kind === null) return fail('BAD_REQUEST', '없는 relation')
        if (from.id === to.id) return fail('BAD_REQUEST', '자기 자신')
        if (this.links.some((link) => link.from === from.id && link.to === to.id && link.relation === kind)) return fail('CONFLICT', '이미 연결됨')
        const link: FixtureLink = { id: uuid(70000 + this.seq++), from: from.id, to: to.id, relation: kind }
        this.links.push(link)
        return ok({ id: link.id, relation: kind, issue: this.ref(to), createdAt: '2026-10-13T00:00:00.000Z' })
      }
      case 'issue_link_delete': {
        const index = this.links.findIndex((link) => link.id === args.linkId)
        if (index < 0) return fail('NOT_FOUND', '없는 링크')
        this.links.splice(index, 1)
        return ok({ deleted: true, linkId: args.linkId })
      }
      default:
        return fail('NOT_FOUND', `없는 도구 ${tool}`)
    }
  }

  private touch(issue: FixtureIssue): void {
    issue.updatedAt = new Date(Date.parse(issue.updatedAt) + 1000).toISOString()
  }

  private status(issue: FixtureIssue): FixtureStatus {
    const found = this.statuses.find((status) => status.id === issue.statusId)
    if (found === undefined) throw new Error('fixture status')
    return found
  }

  private ref(issue: FixtureIssue): Record<string, unknown> {
    const status = this.status(issue)
    const row: Record<string, unknown> = {
      id: issue.id, sequentialId: issue.sequentialId, displayId: `LIFE-${issue.sequentialId}`, kind: issue.kind, title: issue.title,
      statusId: this.corrupt === 'issue-statusId' ? 12345 : issue.statusId, statusCategoryKey: status.categoryKey, statusLabel: status.label,
      resolution: issue.resolution, archivedAt: issue.archivedAt,
    }
    if (this.corrupt === 'drop-statusLabel') delete row.statusLabel
    return row
  }

  private summary(issue: FixtureIssue): Record<string, unknown> {
    const openBlockers = this.linksOf(issue)
      .filter((link) => link.relation === 'is_blocked_by' && this.status(link.other).categoryKey !== 'done')
      .map((link) => ({ id: link.other.id, displayId: `LIFE-${link.other.sequentialId}`, title: link.other.title, statusId: link.other.statusId, statusLabel: this.status(link.other).label }))
    return {
      ...this.ref(issue), goalId: null, parentId: issue.parentId, priority: issue.priority, color: issue.color, position: issue.position, onBoard: issue.onBoard,
      startedAt: null, dueAt: issue.dueAt, doneAt: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: issue.updatedAt, openBlockers,
    }
  }

  private full(issue: FixtureIssue): Record<string, unknown> {
    const { openBlockers: _drop, ...summary } = this.summary(issue)
    void _drop
    return {
      ...summary,
      description: issue.description,
      links: this.linksOf(issue).map((link) => ({ id: link.id, relation: link.relation, issue: this.ref(link.other), createdAt: '2026-10-13T00:00:00.000Z' })),
    }
  }

  private linksOf(issue: FixtureIssue): { id: string; relation: WorkRelationKind; other: FixtureIssue }[] {
    return this.links.flatMap((link) => {
      const outgoing = link.from === issue.id
      if (!outgoing && link.to !== issue.id) return []
      const other = this.issues.find((row) => row.id === (outgoing ? link.to : link.from))
      return other === undefined ? [] : [{ id: link.id, relation: outgoing ? link.relation : INVERSE[link.relation], other }]
    })
  }
}
