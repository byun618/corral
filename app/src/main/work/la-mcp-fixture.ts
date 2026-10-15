// LA MCP 모의 서버 (LIFE-600 C2·C3·C5) — 테스트·격리 실행이 실제 LA 대신 붙는 HTTP 서버. 127.0.0.1 임시 포트에만 연다.
//
// 실측(00-analysis §3 · raw/coordinator/m01·m02)을 따른 것:
//   - 응답은 SSE(`text/event-stream`) 한 이벤트, protocol `2025-06-18`, 세션 헤더 없음(무상태).
//   - 토큰 없음·`life_pat_` 가 아닌 토큰 = 500 `INTERNAL_ERROR` · 형식 맞는 모르는 토큰 = 401 `UNAUTHORIZED`.
//   - scope 부족 = **HTTP 200 · SSE `result.isError: true` · text `missing scope: issue:write`**(LA 소스 mcp.service `ensureIssueScope` →
//     SDK 가 도구 오류로 감싼다 — 리뷰 r1 sdk-permission 와이어 실측). `scopeStyle: 'http'` 면 HTTP 403 `FORBIDDEN`(다른 서버 꼴 대조용).
//   - 부모 규칙(issue.service `checkParentRule`): task 의 부모 = project·checkpoint·bug — 씨앗에 bug 아래 task 를 둔다(R1-A).
//   - 완료 프로젝트 아래 열린 task 하나(R3-D — 미분류로, 옛 프로젝트 키 목록은 「스페이스 아님」).
//   - 보관(issue.service `archive`)은 그 행만 바꾼다 — 씨앗에 보관된 checkpoint 아래 미보관 task, 보관된 부모 없는 bug 아래 미보관 task 를 둔다(R2-C).
//   - 응답 계약(issue.mapper): 목록 = IssueSummary(openBlockers, description 없음) · 수정 = IssueResponse(description, links 없음) · 단건 = + links.
//
// 제어: `fault`(다음 요청들의 HTTP 상태 강제 · 소켓 끊기 · 지연) · `corrupt`(응답 한 칸 깨기 — 양성 대조) · `protocolVersion`
//   · `echo`(원격 오류 글에 받은 토큰을 되울리기 — R1-E 양성 대조) · `holdStream`(결과를 쓰고 스트림을 닫지 않기 — R1-H).
// `requests` 에 받은 요청(메서드·도구 이름·토큰 접두사 여부)을 쌓는다 — 「보내기 전에 거절」 을 요청 0건으로 확인한다.
// 토큰 원문은 기록하지 않는다.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { isRecord, safeParse } from '../../shared/json.js'
import { readWorkRelationKind, type WorkCategory, type WorkRelationKind } from '../../shared/work.js'

export type FixtureScope = 'write' | 'read'
/** `drop-after` = 도구를 처리한 **뒤** 소켓을 끊는다 — 요청은 닿았는데 답이 사라진 경우(LIFE-604 R1-A ⓑ). */
export type FixtureFault = { kind: 'http'; status: number; body: string } | { kind: 'drop' } | { kind: 'delay'; ms: number } | { kind: 'drop-after' }
/**
 * 양성 대조용 깨기 — `issue-statusId`: 일감 행의 statusId 를 숫자로 · `tool-error`: 도구 결과를 isError 로 · `drop-statusLabel`: statusLabel 칸 삭제
 * · `drop-<칸>`: 단건·목록 행에서 그 칸 삭제 · `isError-string`: isError 를 글자 'true' 로 · `rpc-wrong-version`: jsonrpc 를 'broken' 으로
 * · `rpc-error-string`: result 옆에 error: 'failed' 를 같이 · `list-drop-<칸>`: 목록 행에서 그 칸 삭제 · `list-bad-blocker`: openBlockers 를 [null, 42] 로(R2-D).
 */
export type FixtureCorrupt =
  | 'issue-statusId' | 'tool-error' | 'drop-statusLabel' | 'status-no-default'
  | 'drop-links' | 'drop-description' | 'drop-onBoard' | 'drop-priority'
  | 'isError-string' | 'rpc-wrong-version' | 'rpc-error-string'
  | 'list-drop-position' | 'list-drop-dueAt' | 'list-drop-color' | 'list-drop-archivedAt' | 'list-drop-openBlockers' | 'list-bad-blocker'
  // LIFE-601 E1·E2 양성 대조 — 막은 쪽 행에서 displayId 를 지움 · `issue_by_seq` 의 data.id 를 숫자로.
  | 'blocker-no-displayId' | 'byseq-bad-id'
  // LIFE-602 수정 1 — E4 쓰기 응답(issue_update)만 title 을 숫자로.
  | 'update-bad-title'
  // LIFE-601 R1-P 양성 대조 — 모르는 kind · kind null 인데 data 있음.
  | 'byseq-unknown-kind' | 'byseq-null-kind-data'
  // LIFE-602 E5 양성 대조 — resolution 을 모르는 글자로.
  | 'resolution-unknown'
  // LIFE-604 C4 양성 대조 — issue_create 가 T3 까지의 모의처럼 description·priority·statusId 를 무시하고 고정값으로 만든다.
  | 'create-ignore-fields'
/** 받은 토큰을 되울리는 자리 — HTTP 오류 본문 · JSON-RPC error.message · 도구 isError 글. */
export type FixtureEcho = 'http-body' | 'rpc-error' | 'tool-error'

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
/** 실제 LA `issue_create` 입력 칸(LIFE-604 — life-assistant MCP 도구 정의). */
const CREATE_ARGS = new Set(['kind', 'title', 'description', 'priority', 'statusId', 'categoryKey', 'onBoard', 'dueAt', 'parentId', 'goalId', 'color'])
const PRIORITIES = new Set(['highest', 'high', 'medium', 'low', 'lowest'])

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
  bug: uuid(386), taskUnderBug: uuid(602), doneBug: uuid(387), taskUnderDoneBug: uuid(603),
  archivedCheckpoint: uuid(373), taskUnderArchived: uuid(604), archivedOrphanBug: uuid(388), taskUnderArchivedBug: uuid(605),
  taskUnderDoneProject: uuid(606),
}

/** 스페이스가 아닌(완료·보관) 프로젝트 키 — 목록 요청은 「스페이스 아님」 이어야 한다(R3-D). */
export const FIXTURE_RETIRED_SPACE_KEYS = [FIXTURE_IDS.doneProject]

/** 단건으로 열 수 있는 미보관 작업 전부 — 공통 묶음이 「각각 자기 스페이스 목록에 나온다」 를 본다(R1-A·R2-C). */
export const FIXTURE_VISIBLE_ITEMS = [
  FIXTURE_IDS.checkpoint, FIXTURE_IDS.task600, FIXTURE_IDS.task601, FIXTURE_IDS.direct, FIXTURE_IDS.bug, FIXTURE_IDS.taskUnderBug,
  FIXTURE_IDS.doneBug, FIXTURE_IDS.taskUnderDoneBug, FIXTURE_IDS.taskUnderArchived, FIXTURE_IDS.orphanBug, FIXTURE_IDS.taskUnderArchivedBug, FIXTURE_IDS.laTask,
  FIXTURE_IDS.taskUnderDoneProject,
]

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
    // bug 아래 task(R1-A) — 열린 bug 아래 열린 task, 완료된 bug 아래 열린 task(열린 수의 부모 사슬 — R1-I).
    { ...base, id: FIXTURE_IDS.bug, sequentialId: 386, kind: 'bug', parentId: FIXTURE_IDS.corral, title: '프로젝트 아래 버그', statusId: FIXTURE_STATUS.todo, position: '22' },
    { ...base, id: FIXTURE_IDS.taskUnderBug, sequentialId: 602, kind: 'task', parentId: FIXTURE_IDS.bug, title: '버그 아래 작업', statusId: FIXTURE_STATUS.todo, position: '23' },
    { ...base, id: FIXTURE_IDS.doneBug, sequentialId: 387, kind: 'bug', parentId: FIXTURE_IDS.checkpoint, title: '끝난 버그', statusId: FIXTURE_STATUS.done, position: '24', resolution: 'completed' },
    { ...base, id: FIXTURE_IDS.taskUnderDoneBug, sequentialId: 603, kind: 'task', parentId: FIXTURE_IDS.doneBug, title: '끝난 버그 아래 남은 작업', statusId: FIXTURE_STATUS.dev, position: '25' },
    // 보관된 부모 아래 미보관 작업(R2-C) — 보관은 그 행만 바꾼다. 프로젝트 아래 checkpoint, 부모 없는 bug(미분류) 두 갈래.
    { ...base, id: FIXTURE_IDS.archivedCheckpoint, sequentialId: 373, kind: 'checkpoint', parentId: FIXTURE_IDS.corral, title: '보관된 체크포인트', statusId: FIXTURE_STATUS.analysis, position: '26', archivedAt: '2026-10-02T00:00:00.000Z' },
    { ...base, id: FIXTURE_IDS.taskUnderArchived, sequentialId: 604, kind: 'task', parentId: FIXTURE_IDS.archivedCheckpoint, title: '보관된 체크포인트 아래 작업', statusId: FIXTURE_STATUS.todo, position: '27' },
    { ...base, id: FIXTURE_IDS.archivedOrphanBug, sequentialId: 388, kind: 'bug', parentId: null, title: '보관된 부모 없는 버그', statusId: FIXTURE_STATUS.todo, position: '31', archivedAt: '2026-10-02T00:00:00.000Z' },
    { ...base, id: FIXTURE_IDS.taskUnderArchivedBug, sequentialId: 605, kind: 'task', parentId: FIXTURE_IDS.archivedOrphanBug, title: '보관된 버그 아래 작업', statusId: FIXTURE_STATUS.dev, position: '32' },
    // 완료 프로젝트 아래 열린 작업(R3-D) — 미분류로 나온다.
    { ...base, id: FIXTURE_IDS.taskUnderDoneProject, sequentialId: 606, kind: 'task', parentId: FIXTURE_IDS.doneProject, title: '끝난 프로젝트 아래 남은 작업', statusId: FIXTURE_STATUS.todo, position: '33' },
    { ...base, id: FIXTURE_IDS.orphanBug, sequentialId: 385, kind: 'bug', parentId: null, title: '부모 없는 버그', statusId: FIXTURE_STATUS.todo, position: '30' },
    { ...base, id: FIXTURE_IDS.laTask, sequentialId: 20, kind: 'task', parentId: FIXTURE_IDS.lifeAssistant, title: 'LA 쪽 작업', statusId: FIXTURE_STATUS.done, position: '40', resolution: 'completed' },
  ]
}

export class LaMcpFixture {
  readonly tokens = new Map<string, FixtureScope>()
  readonly requests: FixtureRequest[] = []
  /** 받은 `issue_create` 인자(LIFE-604 C4) — 칸마다 무엇을 받았는지 본다. 토큰은 인자에 없다. */
  readonly createArgs: Record<string, unknown>[] = []
  statuses = seedStatuses()
  issues = seedIssues()
  links: FixtureLink[] = []
  fault: FixtureFault | null = null
  /** 도구 이름별 고장(LIFE-604 R1-A) — 그 도구 요청에만. 예: `issue_get` 만 끊어 생성 뒤 재조회 실패를 만든다. */
  readonly toolFaults = new Map<string, FixtureFault>()
  corrupt: FixtureCorrupt | null = null
  echo: FixtureEcho | null = null
  holdStream = false
  scopeStyle: 'sdk' | 'http' = 'sdk'
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

    const fault = (tool === null ? undefined : this.toolFaults.get(tool)) ?? this.fault
    if (fault !== null && fault.kind !== 'drop-after') {
      if (fault.kind === 'drop') { request.socket.destroy(); return }
      if (fault.kind === 'http') { this.json({ response, status: fault.status, value: safeParse(fault.body) ?? fault.body }); return }
      await new Promise((resolve) => setTimeout(resolve, fault.ms))
    }
    const id = isRecord(body) ? body.id : undefined
    if (this.echo === 'http-body' && method === 'tools/call') { this.json({ response, status: 401, value: { code: 'UNAUTHORIZED', message: `bad bearer ${token}` } }); return }
    if (this.echo === 'rpc-error' && method === 'tools/call') { this.sse({ response, value: { jsonrpc: '2.0', id, error: { code: -32000, message: `rejected bearer ${token}` } } }); return }
    if (this.echo === 'tool-error' && method === 'tools/call') {
      this.sse({ response, value: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ code: 'BAD_REQUEST', message: `token ${token} is not allowed` }) }], isError: true } } })
      return
    }
    if (request.method !== 'POST' || request.url !== '/mcp') { this.json({ response, status: 404, value: { code: 'NOT_FOUND' } }); return }
    if (!token.startsWith('life_pat_')) { this.json({ response, status: 500, value: { code: 'INTERNAL_ERROR', message: '잠시 후 다시 시도해주세요' } }); return }
    const scope = this.tokens.get(token)
    if (scope === undefined) { this.json({ response, status: 401, value: { code: 'UNAUTHORIZED', message: '인증이 필요해요' } }); return }
    if (tool !== null && scope === 'read' && WRITE_TOOLS.has(tool)) {
      if (this.scopeStyle === 'http') this.json({ response, status: 403, value: { code: 'FORBIDDEN', message: '권한이 없어요' } })
      else this.sse({ response, value: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'missing scope: issue:write' }], isError: true } } })
      return
    }

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
    const toolResult: Record<string, unknown> = { content: [{ type: 'text', text: result.text }] }
    if (result.isError) toolResult.isError = true
    if (this.corrupt === 'isError-string') toolResult.isError = 'true'
    const rpc: Record<string, unknown> = { jsonrpc: this.corrupt === 'rpc-wrong-version' ? 'broken' : '2.0', id, result: toolResult }
    if (this.corrupt === 'rpc-error-string') rpc.error = 'failed'
    if (fault?.kind === 'drop-after') { request.socket.destroy(); return }
    this.sse({ response, value: rpc })
  }

  private json({ response, status, value }: { response: http.ServerResponse; status: number; value: unknown }): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value))
  }

  private sse({ response, value }: { response: http.ServerResponse; value: unknown }): void {
    const event = `event: message\ndata: ${JSON.stringify(value)}\n\n`
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    // 결과를 쓰고 스트림을 열어 둔다 — 클라이언트가 결과만으로 끝내야 한다(R1-H).
    if (this.holdStream) response.write(event)
    else response.end(event)
  }

  private tool({ tool, args }: { tool: string; args: Record<string, unknown> }): { isError: boolean; text: string } {
    const ok = (value: unknown): { isError: boolean; text: string } => ({ isError: false, text: JSON.stringify(value) })
    const fail = (code: string, message: string): { isError: boolean; text: string } => ({ isError: true, text: JSON.stringify({ code, message }) })
    const find = (id: unknown): FixtureIssue | undefined => this.issues.find((issue) => issue.id === id)
    switch (tool) {
      // `status-no-default` — 옛 서버처럼 isDefault 칸이 없다(R2-G 대조).
      case 'status_list': return ok(this.corrupt === 'status-no-default' ? this.statuses.map((status) => { const { isDefault: _gone, ...rest } = status; void _gone; return rest }) : this.statuses)
      case 'issue_list': {
        const archived = args.archived ?? 'exclude'
        const limit = typeof args.limit === 'number' ? args.limit : 50
        const rows = this.issues
          .filter((issue) => (archived === 'all' ? true : archived === 'only' ? issue.archivedAt !== null : issue.archivedAt === null))
          .filter((issue) => args.kind === undefined || issue.kind === args.kind)
          .filter((issue) => args.parentId === undefined || issue.parentId === args.parentId)
          .filter((issue) => args.categoryKey === undefined || this.status(issue).categoryKey === args.categoryKey)
          .slice(0, limit)
        return ok(rows.map((issue) => this.listRow(issue)))
      }
      case 'issue_get': {
        const issue = find(args.id)
        return issue === undefined ? fail('NOT_FOUND', '일감을 찾을 수 없어요') : ok(this.full(issue))
      }
      // LIFE-601 E2 — LA `issue_by_seq` 응답 `{kind, data}`. 못 찾으면 `{kind: null, data: null}`(오류 아님). 보관 일감도 찾는다.
      case 'issue_by_seq': {
        const issue = this.issues.find((row) => row.sequentialId === args.seq)
        if (issue === undefined) return ok({ kind: null, data: this.corrupt === 'byseq-null-kind-data' ? { id: 'ghost' } : null })
        const data = this.full(issue)
        if (this.corrupt === 'byseq-unknown-kind') return ok({ kind: 'initiative', data })
        return ok({ kind: issue.kind, data: this.corrupt === 'byseq-bad-id' ? { ...data, id: 42 } : data })
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
        // LIFE-602 E4 — PATCH: 보낸 칸만. title 은 minLength 1(스키마).
        if ('title' in args) {
          if (typeof args.title !== 'string' || args.title.length === 0) return fail('BAD_REQUEST', 'title')
          issue.title = args.title
        }
        if ('description' in args && (typeof args.description === 'string' || args.description === null)) issue.description = args.description
        if ('priority' in args && (typeof args.priority === 'string' || args.priority === null)) issue.priority = args.priority
        if ('dueAt' in args && (typeof args.dueAt === 'string' || args.dueAt === null)) issue.dueAt = args.dueAt
        this.touch(issue)
        // LIFE-602 수정 1 — 쓰기 응답(E4 issue_update) 하나만 어긋나게: 읽기(issue_get·list)는 멀쩡하다(양성 대조 범위를 쓰기 응답으로 좁힌다).
        if (this.corrupt === 'update-bad-title') return ok({ ...this.response(issue), title: 42 })
        return ok(this.response(issue))
      }
      // LIFE-602 E6 — 부모 규칙(issue.service checkParentRule): checkpoint=부모 project 必 · bug=project|checkpoint|없음 · task=project|checkpoint|bug|없음.
      case 'issue_create': {
        // LIFE-604 C4 — 실제 LA `issue_create` 스키마대로 칸을 받는다: kind·title(필수) · description · priority(5단|null) · statusId(uuid, categoryKey 보다 우선)
        // · categoryKey · onBoard(기본 false = 백로그) · dueAt · parentId · goalId · color. 모르는 칸은 BAD_REQUEST(받는 척 금지 — 이름이 틀린 칸이 조용히 사라지지 않게).
        this.createArgs.push({ ...args })
        const unknown = Object.keys(args).find((key) => !CREATE_ARGS.has(key))
        if (unknown !== undefined) return fail('BAD_REQUEST', `모르는 칸 ${unknown}`)
        const kind = args.kind
        if (kind !== 'project' && kind !== 'checkpoint' && kind !== 'task' && kind !== 'bug') return fail('BAD_REQUEST', 'kind')
        if (typeof args.title !== 'string' || args.title.length === 0) return fail('BAD_REQUEST', 'title')
        if ('description' in args && typeof args.description !== 'string' && args.description !== null) return fail('BAD_REQUEST', 'description')
        if ('priority' in args && args.priority !== null && !PRIORITIES.has(String(args.priority))) return fail('BAD_REQUEST', 'priority')
        if ('onBoard' in args && typeof args.onBoard !== 'boolean') return fail('BAD_REQUEST', 'onBoard')
        if ('statusId' in args && !this.statuses.some((status) => status.id === args.statusId)) return fail('BAD_REQUEST', '없는 statusId')
        if ('categoryKey' in args && !this.statuses.some((status) => status.categoryKey === args.categoryKey)) return fail('BAD_REQUEST', 'categoryKey')
        const parentId = typeof args.parentId === 'string' ? args.parentId : null
        const parent = parentId === null ? null : find(parentId)
        if (parentId !== null && parent === undefined) return fail('BAD_REQUEST', '없는 부모')
        const parentKind = parent?.kind ?? null
        const allowed = kind === 'project' ? parentKind === null
          : kind === 'checkpoint' ? parentKind === 'project'
            : kind === 'bug' ? parentKind === null || parentKind === 'project' || parentKind === 'checkpoint'
              : parentKind === null || parentKind === 'project' || parentKind === 'checkpoint' || parentKind === 'bug'
        if (!allowed) return fail('BAD_REQUEST', '부모 규칙 위반')
        // 상태: statusId 우선 → categoryKey 의 기본 → todo 기본(LA issue.service 순서).
        const byCategory = (key: unknown): FixtureStatus | undefined => this.statuses.find((status) => status.categoryKey === key && status.isDefault) ?? this.statuses.find((status) => status.categoryKey === key)
        const ignore = this.corrupt === 'create-ignore-fields'
        const statusId = !ignore && typeof args.statusId === 'string' ? args.statusId : (byCategory(args.categoryKey ?? 'todo')?.id ?? FIXTURE_STATUS.todo)
        const sequentialId = Math.max(...this.issues.map((issue) => issue.sequentialId)) + 1
        const created: FixtureIssue = {
          id: uuid(80000 + this.seq++), sequentialId, kind, parentId, title: args.title,
          description: !ignore && typeof args.description === 'string' ? args.description : null, priority: !ignore && typeof args.priority === 'string' ? args.priority : null, statusId,
          resolution: null, color: null, position: String(100 + sequentialId), onBoard: args.onBoard === true, dueAt: typeof args.dueAt === 'string' ? args.dueAt : null, archivedAt: null, updatedAt: '2026-10-14T00:00:00.000Z',
        }
        this.issues.push(created)
        return ok(this.response(created))
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
      resolution: this.corrupt === 'resolution-unknown' ? 'wontfix' : issue.resolution, archivedAt: issue.archivedAt,
    }
    if (this.corrupt === 'drop-statusLabel') delete row.statusLabel
    return row
  }

  private summary(issue: FixtureIssue): Record<string, unknown> {
    const openBlockers = this.linksOf(issue)
      .filter((link) => link.relation === 'is_blocked_by' && this.status(link.other).categoryKey !== 'done')
      .map((link) => ({ id: link.other.id, displayId: `LIFE-${link.other.sequentialId}`, title: link.other.title, statusId: link.other.statusId, statusLabel: this.status(link.other).label }))
      .map(({ displayId, ...rest }) => (this.corrupt === 'blocker-no-displayId' ? rest : { ...rest, displayId }))
    return {
      ...this.ref(issue), goalId: null, parentId: issue.parentId, priority: issue.priority, color: issue.color, position: issue.position, onBoard: issue.onBoard,
      startedAt: null, dueAt: issue.dueAt, doneAt: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: issue.updatedAt, openBlockers,
    }
  }

  /** 목록 행 — `list-*` 깨기를 건다(R2-D). */
  private listRow(issue: FixtureIssue): Record<string, unknown> {
    const row = this.summary(issue)
    if (this.corrupt === 'list-bad-blocker') return { ...row, openBlockers: [null, 42] }
    const field = this.corrupt?.startsWith('list-drop-') ? this.corrupt.slice('list-drop-'.length) : null
    if (field === null) return row
    const { [field]: _gone, ...rest } = row
    void _gone
    return rest
  }

  /** 수정 응답(IssueResponse) — 단건에서 links 를 뺀 모양. */
  private response(issue: FixtureIssue): Record<string, unknown> {
    const { links: _links, ...rest } = this.full(issue)
    void _links
    return rest
  }

  /** `drop-<칸>` 깨기 — 그 칸을 지운 사본. */
  private dropped(row: Record<string, unknown>): Record<string, unknown> {
    const field = this.corrupt?.startsWith('drop-') && this.corrupt !== 'drop-statusLabel' ? this.corrupt.slice(5) : null
    if (field === null) return row
    const { [field]: _gone, ...rest } = row
    void _gone
    return rest
  }

  private full(issue: FixtureIssue): Record<string, unknown> {
    const { openBlockers: _drop, ...summary } = this.summary(issue)
    void _drop
    return this.dropped({
      ...summary,
      description: issue.description,
      links: this.linksOf(issue).map((link) => ({ id: link.id, relation: link.relation, issue: this.ref(link.other), createdAt: '2026-10-13T00:00:00.000Z' })),
    })
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
