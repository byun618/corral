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
// 능력 꺼짐(L1 대기): 순서(L1f · LIFE-612).
// 커서 페이지(L1c · LIFE-638 · LA LIFE-610) 켜짐: 정규 스페이스 목록 한 쪽 = `issue_list({rootId: 스페이스, archived:'all', paginate:true, limit, cursor})` 한 번.
//   커서는 LA `nextCursor` 를 받은 글자 그대로 화면에 넘기고 그대로 돌려보낸다(만들거나 해석하지 않는다). LA 쪽은 seq 내림차순이라 부모가 자식보다 뒤 쪽에 온다 —
//   표시 부모 사슬은 쪽마다 같은 루트의 부모 가능 종류(checkpoint·bug, 보관 포함)를 따로 끝까지 받아 푼다(쪽당 RPC = 스페이스 확인 1 + 쪽 1 + 구조 2 — 구조(checkpoint·bug)가 각각 한 쪽(200) 이하일 때. 구조가 더 크면 그 쪽 수만큼 늘지만 작업 수와는 무관).
//   「미분류」 는 루트가 없어 지금처럼 한 번에(D3). LA `잘못된 cursor입니다.` = 낡은 목록 위치(rejected, D4). 빈 글자 커서는 LA 가 받지 않는 값이라
//   보내기 전에 같은 거절로(요청 0).
// 코멘트·이력(L1e · LIFE-638 · LA LIFE-611) 켜짐: `issue_comment_list`·`issue_history_list` 를 끝까지 받아 오래된 것부터 · `issue_comment_add`(결과 모름 재전송 없음).
//   쓰기 5툴(`issue_create`·`issue_update`·`issue_transition`·`issue_link_create`·`issue_link_delete`)에 corral 쓰기 id 를 `clientWriteId` 로 싣는다 —
//   LA 패턴 밖이면 싣지 않는다(쓰기 id 때문에 쓰기가 거절되지 않게). 이력 행 `writeId` 로 돌아와 활동 기록과 짝을 짓는다.
// 작업 링크 저장(L1a) 켜짐(LIFE-635 · LA LIFE-609): 저장 = `issue_work_link_add({issueId, link, machine, repo})` · 지우기 = `issue_work_link_remove({issueId, link, machine})`.
// LA 판별 = 종류 + 핵심 값 + machine — 같은 링크 재저장 = 한 행(repo·부가 값은 통째로 덮음), 없는 링크 지우기 = 오류 아님, 다른 machine 의 같은 경로는 별개 행.
// 결과 = 응답의 그 일감 링크 목록 전체. 단건(`issue_get`) 응답의 `workLinks` 가 `WorkItem.workLinks`(단건 모양에서만 — 목록 행에는 없다, LIFE-609 D2).
// 조건부 수정(L1b) 켜짐(LIFE-622 · LA LIFE-607): 응답 `version` = 판(불투명 글자) · 네 쓰기(필드·상태·배치·부모)에 `ifVersion` · 다르면 LA 가
// isError text JSON `{statusCode:409, code:"CONFLICT", current, …}` 로 거절(저장 0) → `conflict` + 단건 경로로 다시 읽은 지금 작업(by = null → 「다른 곳에서」).
// 응답은 `la-shape.ts` 로 검증한 뒤에만 계약 타입으로 바꾼다(C3) — 어긋나면 `invalid_response`.
// LIFE-602 계약 확장: 필드 수정 = `issue_update`(title·description·priority·dueAt, PATCH) · 완료 갈래 = resolution(completed·cancelled) ·
// 자식 = `issue_list(parentId)`·`issue_create`(부모 규칙은 종류의 `childKinds` 로 알린다) · 연결 상대의 스페이스 = 상대의 부모 사슬(못 풀면 null).
// LIFE-604 E10·E11: 만들기 = `issue_create`(description·statusId·priority·onBoard 명시) · 생성 메타 = 열린 상태 아무거나 · 필수 필드 없음.

import { isRecord, safeParse } from '../../shared/json.js'
import { createFieldsProblem, WORK_HISTORY_FIELDS } from '../../shared/work.js'
import type {
  WorkCall,
  WorkCreateMeta,
  WorkFieldPatch,
  WorkCapabilities,
  WorkError,
  WorkHistoryEntry,
  WorkHistoryField,
  WorkItem,
  WorkKind,
  WorkRelation,
  WorkResolutionChoice,
  WorkSourceDescriptor,
  WorkSpace,
  WorkStatus,
} from '../../shared/work.js'
import { appliedUnread, unknownWriteOutcome, workError } from './errors.js'
import { readBySeq, readComment, readCommentPage, readHistoryPage, readIssueCreated, readIssueDetail, readIssuePage, readIssueSummaries, type LaIssueDetail, readIssueUpdated, readLink, readLinkDeleted, readStatuses, readTransition, readWorkLinks, LaShapeError, type LaIssue, type LaPage, type LaStatus } from './la-shape.js'
import { log } from '../log.js'
import { McpHttpClient } from './mcp-http.js'
import type { WorkCallMeta, WorkOutcome, WorkSourceClient, WorkSourceEntry } from './source.js'

export const LA_SOURCE_ID = 'la'
export const LA_DEFAULT_MCP_URL = 'https://assistant-api.chaco.cloud/mcp'
export const LA_TOKEN_PREFIX = 'life_pat_'
/** 「미분류」 스페이스 키 — LA 일감 id(uuid)와 겹치지 않는다. */
export const LA_CATCH_ALL_KEY = 'la:unsorted'
/** `issue_list` 상한(도구 스키마 max 200). 한 번에 받는 목록(스페이스·미분류·자식)이 상한에 닿으면 `truncated` 로 알린다. */
const LIST_LIMIT = 200
/** 정규 스페이스 목록의 쪽 크기(LIFE-638 D1) — LA 상한. 200 이하 스페이스는 옛 동작처럼 첫 화면에 다 온다(f1 S1-7). 시험은 `pageSize` 로 줄인다. */
const LIST_PAGE_SIZE = 200
/** 정규 스페이스 목록 쪽 수 상한(D10) — 이 쪽을 넘어 커서가 이어지면 조용히 끊지 않고 오류. 100 × 200 = 2만 건. */
const MAX_LIST_PAGES = 100
/** 한 연산 안에서 끝까지 따라가는 쪽 목록(구조·코멘트·이력)의 쪽 크기(LA 상한 200)와 쪽 수 상한(D10) — 200 × 50 = 1만 행. */
const FOLLOW_PAGE_SIZE = 200
const MAX_FOLLOW_PAGES = 50
/** 목록 커서의 쪽 번호를 기억하는 수 — 쪽 수 상한을 연산 사이에서 세기 위함. 넘으면 오래된 것부터 잊는다(잊힌 커서는 2쪽으로 센다). */
const LIST_CURSOR_MEMORY = 256
/** LA `clientWriteId` 입력 패턴(611 mcp-schema) — 밖이면 LA 가 -32602 로 쓰기 전체를 거절하므로 싣지 않는다(D5). */
const CLIENT_WRITE_ID = /^[A-Za-z0-9_-]{1,64}$/
/** LA 의 낡은·깨진 커서 문구(610·611 고정 문구) — 이 글자일 때만 「목록 위치가 낡음」 으로 읽는다(D4). */
const INVALID_CURSOR = '잘못된 cursor입니다.'
/** 낡은·깨진 커서의 이쪽 말(D4) — LA 거절과 보내기 전 거절(빈 글자 커서)이 같은 문구. */
const STALE_CURSOR_MESSAGE = '목록 위치가 낡았습니다 — 처음부터 새로 고치세요.'
/** 코멘트 남기기 결과를 모름(D7) — 다시 보내지 않는다. */
const COMMENT_UNKNOWN_PREFIX = '코멘트가 남았는지 모릅니다(다시 보내지 말고 새로 고쳐 확인하세요)'
/** 프로젝트 → 체크포인트 → bug → task 를 넘는 깊이는 없다고 보지 않고, 넉넉히 내려가되 끝은 둔다. */
const MAX_DEPTH = 5
/**
 * LA 의 부모 규칙(issue.service `checkParentRule`): task 의 부모 = project·checkpoint·bug · bug 의 부모 = project·checkpoint(또는 없음)
 * · checkpoint 의 부모 = project · project 는 부모 없음(R1-A). 작업 쪽 모양(E6) — 종류마다 그 아래에 만들 수 있는 자식 종류. task 는 잎.
 * 목록의 표시 부모 사슬은 그래서 checkpoint·bug 만 따라가면 된다(LIFE-638 D2 — 구조 = 그 두 종류).
 */
const CHILD_KINDS: Record<'checkpoint' | 'task' | 'bug', string[]> = { checkpoint: ['task', 'bug'], bug: ['task'], task: [] }
/** 연결 상대의 스페이스(E9)를 푸는 상한 — 넘는 상대는 null(모름). 단건 한 번에 RPC 가 끝없이 늘지 않게. */
const MAX_LINK_SPACES = 12
/** LA SDK 경로의 scope 부족 — HTTP 200 · `isError: true` · text `missing scope: issue:write`(mcp.service `ensureIssueScope`). */
const MISSING_SCOPE = /^missing scope: ([a-z_]+:[a-z_]+)$/
/** 문구에 옮겨도 되는 범위 이름 — 원격 글을 그대로 옮기지 않는다(R2-F). 이 밖의 범위도 권한 부족이지만 이름은 싣지 않는다. */
const KNOWN_SCOPES = new Set(['issue:read', 'issue:write'])
/** LA 사람 키 (E3) — `LIFE-<seq>`. 화면에는 descriptor 로 소스만 나간다. */
const LA_KEY = /^LIFE-(\d+)$/i
/** 쓰기는 저장됐는데 바뀐 작업을 다시 읽지 못함(LIFE-632 R5-B) — Jira `WRITTEN_PREFIX` 와 같은 뜻. */
const WRITTEN_PREFIX = 'LA 에는 적용됐지만 바뀐 작업을 다시 읽지 못했습니다 — 다시 보내지 말고 새로 고치세요. '
/** 쓰기 호출 자체의 결과를 모름(F11) — 만들기의 「만들어졌는지 모릅니다」 와 같은 자리. */
const UNKNOWN_PREFIX = '적용됐는지 모릅니다'

export const LA_DESCRIPTOR: WorkSourceDescriptor = {
  id: LA_SOURCE_ID,
  name: 'LA',
  mono: 'LA',
  addLabel: '+ LA 토큰',
  formTitle: 'LA 연결',
  accountFields: [],
  tokenLabel: 'LA 개인 토큰',
  tokenHint: null,
  tokenPrefix: LA_TOKEN_PREFIX,
  keyPattern: 'LIFE-\\d+',
  queryPattern: null,
}

export const LA_CAPABILITIES: WorkCapabilities = {
  transition: { mode: 'any' },
  placement: { state: 'on' },
  relations: { state: 'on' },
  parentChange: { state: 'on' },
  order: { state: 'disabled', reason: 'LA 에는 순서를 바꾸는 MCP 도구가 없습니다 (LIFE-612).' },
  cursorPaging: { state: 'on' },
  conflictCheck: { state: 'on' },
  comments: { state: 'on' },
  history: { state: 'on' },
  workLinkStore: { state: 'on' },
  resolution: { state: 'on' },
  querySearch: { state: 'hidden' },
}

const KIND_LABELS: Record<'checkpoint' | 'task' | 'bug', string> = { checkpoint: 'Checkpoint', task: 'Task', bug: 'Bug' }
const KINDS: WorkKind[] = (['checkpoint', 'task', 'bug'] as const).map((key) => ({ key, label: KIND_LABELS[key], childKinds: [...CHILD_KINDS[key]] }))

type Step<T> = { ok: true; value: T } | { ok: false; outcome: WorkOutcome }

/** `pageSize` = 정규 스페이스 목록의 쪽 크기(기본 200 = LA 상한) — 시험이 여러 쪽을 만들 때만 바꾼다. */
export function laSourceEntry({ url, clientVersion, fetchImpl, timeoutMs, pageSize }: { url: string; clientVersion: string; fetchImpl?: typeof fetch; timeoutMs?: number; pageSize?: number }): WorkSourceEntry {
  return {
    descriptor: LA_DESCRIPTOR,
    create: ({ token }) => new LaSource({ mcp: new McpHttpClient({ url, token, clientVersion, fetchImpl, timeoutMs, toolError: laToolError }), pageSize }),
  }
}

/**
 * LA 도구 오류 중 아는 모양 — scope 부족은 권한 부족(R1-B). 범위 이름은 정해진 꼴(`issue:write`)만 문구에 옮긴다.
 * 저장 충돌(LIFE-622) = text JSON 의 `code: "CONFLICT"` **와** `statusCode: 409` **와** 레코드 `current` — 셋이 다 맞을 때만(닮은 다른 오류 —
 * 연결 중복의 CONFLICT 등 — 는 지금처럼 공통 분류). 원격 message 는 옮기지 않는다. 지금 작업(`conflict.current`)은 출처가 단건 경로로 붙인다(F4·F9).
 * 나머지는 공통 분류로.
 */
export function laToolError(text: string): WorkError | null {
  // 낡은·깨진 커서(D4) — 연결 상태를 바꾸지 않는 연산 실패. 원격 글을 옮기지 않고 이쪽 말로.
  if (text.trim() === INVALID_CURSOR) return workError({ kind: 'rejected', message: STALE_CURSOR_MESSAGE })
  const parsed = safeParse(text)
  if (isRecord(parsed) && parsed.code === 'CONFLICT' && parsed.statusCode === 409 && isRecord(parsed.current)) {
    return workError({ kind: 'conflict', status: 409, message: '다른 곳에서 먼저 바뀌었습니다 — 새로 불러오거나 덮어쓰세요.' })
  }
  const match = MISSING_SCOPE.exec(text.trim())
  if (match === null) return null
  const scope = match[1] !== undefined && KNOWN_SCOPES.has(match[1]) ? `${match[1]} ` : ''
  return workError({ kind: 'forbidden', message: `연결은 됐지만 이 토큰에 ${scope}범위가 없습니다. 토큰 범위(scope)를 확인하세요.` })
}

export class LaSource implements WorkSourceClient {
  private readonly mcp: McpHttpClient
  private readonly pageSize: number
  /** 목록 커서 → 그 커서가 여는 쪽 번호(2부터). 쪽 수 상한(D10)을 연산 사이에서 센다. 커서 글자는 LA 값 그대로 열쇠로만 쓴다. */
  private readonly listPages = new Map<string, number>()

  constructor({ mcp, pageSize = LIST_PAGE_SIZE }: { mcp: McpHttpClient; pageSize?: number }) {
    this.mcp = mcp
    this.pageSize = pageSize
  }

  capabilities(): WorkCapabilities {
    return LA_CAPABILITIES
  }

  close(): void {
    this.mcp.close()
  }

  async call(call: WorkCall, meta?: WorkCallMeta): Promise<WorkOutcome> {
    const writeId = clientWriteIdOf(meta?.writeId ?? null)
    switch (call.op) {
      case 'listSpaces': return this.listSpaces()
      case 'listStatuses': {
        const statuses = await this.statuses()
        return statuses.ok ? { ok: true, result: { op: 'listStatuses', statuses: statuses.value.map(toStatus), kinds: KINDS } } : statuses.outcome
      }
      case 'listItems':
        // 빈 글자 커서 — LA `cursor` 는 minLength 1 이라 보내면 입력 검증 거절. 보내기 전에 낡은 커서와 같은 거절로(S1-6, 두 스페이스 종류 모두).
        if (call.cursor === '') return { ok: false, error: workError({ kind: 'rejected', message: STALE_CURSOR_MESSAGE }) }
        if (call.spaceKey !== LA_CATCH_ALL_KEY) return this.listItems({ spaceKey: call.spaceKey, cursor: call.cursor })
        // 「미분류」 는 한 번에 다 준다(D3) — 커서가 오면 첫 쪽을 다시 주지 않고 거절.
        if (call.cursor !== null) return { ok: false, error: workError({ kind: 'rejected', message: '「미분류」 는 한 번에 다 받습니다 — 다음 쪽이 없습니다. 새로 고치세요.' }) }
        return this.listCatchAll()
      case 'getItem': {
        const item = await this.item(call.itemId)
        return item.ok ? { ok: true, result: { op: 'getItem', item: item.value } } : item.outcome
      }
      case 'findByKey': return this.findByKey(call.key)
      case 'listTransitions': {
        const statuses = await this.statuses()
        return statuses.ok ? { ok: true, result: { op: 'listTransitions', statusKeys: statuses.value.map((status) => status.id), blocked: [] } } : statuses.outcome
      }
      case 'changeStatus':
        return this.changeStatus({ itemId: call.itemId, statusKey: call.statusKey, resolution: call.resolution ?? null, ifVersion: call.ifVersion, writeId })
      case 'updateItem': {
        const updated = await this.writeTool({ name: 'issue_update', args: versioned({ args: { id: call.itemId, ...updateArgs(call.fields) }, ifVersion: call.ifVersion }), read: readIssueUpdated, writeId })
        return this.written({ op: 'updateItem', itemId: call.itemId, step: updated })
      }
      case 'listChildren': return this.listChildren(call.itemId)
      case 'createItem': return this.createItem({ call, writeId })
      case 'getCreateMeta': {
        const meta = await this.createMeta({ spaceKey: call.spaceKey, kindKey: call.kindKey })
        return meta.ok ? { ok: true, result: { op: 'getCreateMeta', meta: meta.value } } : meta.outcome
      }
      case 'listHistory': return this.listHistory(call.itemId)
      case 'setPlacement': {
        const updated = await this.writeTool({ name: 'issue_update', args: versioned({ args: { id: call.itemId, onBoard: call.placement === 'board' }, ifVersion: call.ifVersion }), read: readIssueUpdated, writeId })
        return this.written({ op: 'setPlacement', itemId: call.itemId, step: updated })
      }
      case 'setParent': {
        // 스페이스 바로 아래(null) = 그 프로젝트가 부모. 「미분류」 바로 아래 = 부모 없음.
        const parentId = call.parentId ?? (call.spaceKey === LA_CATCH_ALL_KEY ? null : call.spaceKey)
        const updated = await this.writeTool({ name: 'issue_update', args: versioned({ args: { id: call.itemId, parentId }, ifVersion: call.ifVersion }), read: readIssueUpdated, writeId })
        return this.written({ op: 'setParent', itemId: call.itemId, step: updated })
      }
      case 'addRelation': return this.addRelation({ itemId: call.itemId, kind: call.kind, otherKey: call.otherKey, writeId })
      case 'removeRelation': {
        const deleted = await this.tool({ name: 'issue_link_delete', args: withWriteId({ args: { linkId: call.relationId }, writeId }), read: readLinkDeleted })
        return deleted.ok ? { ok: true, result: { op: 'removeRelation', relationId: deleted.value } } : deleted.outcome
      }
      case 'reorder': return unsupported('order')
      case 'listComments': return this.listComments(call.itemId)
      case 'addComment': return this.addComment({ itemId: call.itemId, body: call.body })
      case 'saveWorkLink': {
        // repo 는 늘 싣는다(null 이어도) — 생략하면 LA 가 기존 repo 를 null 로 덮는 것과 같지만, 무엇을 보냈는지가 인자에 드러나게(F7).
        const saved = await this.tool({ name: 'issue_work_link_add', args: { issueId: call.itemId, link: call.link, machine: call.machine, repo: call.repo }, read: readWorkLinks })
        return saved.ok ? { ok: true, result: { op: 'saveWorkLink', workLinks: saved.value } } : saved.outcome
      }
      case 'removeWorkLink': {
        const removed = await this.tool({ name: 'issue_work_link_remove', args: { issueId: call.itemId, link: call.link, machine: call.machine }, read: readWorkLinks })
        return removed.ok ? { ok: true, result: { op: 'removeWorkLink', workLinks: removed.value } } : removed.outcome
      }
      case 'searchItems':
        return unsupported('querySearch')
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
   * 칸 전달: 본문 → description · 상태 → statusId · 우선순위 → priority · 배치 → onBoard. **onBoard 는 늘 명시한다(task·checkpoint·bug — LA LIFE-293 이후 bug 도 task 와 같다, LIFE-665)** — LA 기본이 백로그라
   * 미지정이면 보드 생성이 조용히 백로그로 간다(배치를 안 보낸 만들기 = 보드, T3 자식 추가 그대로). 상태를 안 보내면 LA 기본 상태.
   * 부모 규칙은 LA 서버가 다시 검증한다 — 여기서는 종류의 `childKinds` 밖·메타 밖 상태·필드를 보내기 전에 거절한다.
   */
  private async createItem({ call, writeId }: { call: Extract<WorkCall, { op: 'createItem' }>; writeId: string | null }): Promise<WorkOutcome> {
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
    // 쓰기 id 는 LA 가 부모의 `child` 이력 행에만 붙인다(611) — 만든 작업 자신에는 이력 행이 없다.
    const sent = await this.mcp.callTool({ name: 'issue_create', args: withWriteId({ args: createArgs({ call, kind, parentId }), writeId }) })
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
    // 배치: LA 는 세 종류 모두 `onBoard` 를 받는다 — bug 도 task 와 같다(LA LIFE-293 `issue.service.ts:447-452`, LIFE-665).
    // 옛 R2-H(bug = 적용 안 됨)는 LIFE-293 뒤 갱신 안 된 MCP 칸 설명을 근거로 삼았다(LIFE-665 `raw/coord/c11-la-source-contrast.txt`).
    const meta: WorkCreateMeta = { spaceKey, kindKey, statusKeys: open.map((status) => status.id), defaultStatusKey: first.id, placement: 'applies', accepts: { body: true, priority: true }, fields: [] }
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

  /**
   * 쓰기 도구(`issue_update`·`issue_transition`) — 보낸 뒤 결과를 모르는 실패(시간 초과·연결 뒤 끊김·깨진 답)는 「적용됐는지 모름」(LIFE-632 F11 —
   * 만들기 `unknownWriteOutcome` 과 같은 규칙). 보내지 않은 실패(`unsent`)·출처의 거절(권한·검증·충돌)은 그대로. 다시 보내지 않는다.
   */
  private async writeTool<T>({ name, args, read, writeId }: { name: string; args: Record<string, unknown>; read: (value: unknown, path: string) => T; writeId: string | null }): Promise<Step<T>> {
    const sent = await this.mcp.callTool({ name, args: withWriteId({ args, writeId }) })
    if (!sent.ok) return { ok: false, outcome: { ok: false, error: unknownWriteOutcome({ error: sent.error, unsent: sent.unsent === true, prefix: UNKNOWN_PREFIX }) } }
    try {
      return { ok: true, value: read(sent.value, name) }
    } catch (error) {
      if (error instanceof LaShapeError) return { ok: false, outcome: { ok: false, error: unknownWriteOutcome({ error: workError({ kind: 'invalid_response', message: error.message }), unsent: false, prefix: UNKNOWN_PREFIX }) } }
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
      .map((project) => ({ key: project.id, name: project.title, color: project.color, description: null, openCount: openCount(project.id), role: 'regular', capabilities: {} }))
    spaces.push({ key: LA_CATCH_ALL_KEY, name: '미분류', color: null, description: '어느 프로젝트에도 속하지 않은 작업', openCount: openCount(LA_CATCH_ALL_KEY), role: 'catch_all', capabilities: {} })
    return { ok: true, result: { op: 'listSpaces', spaces, capabilities: LA_CAPABILITIES } }
  }

  /**
   * 정규 스페이스 목록 한 쪽(LIFE-638 D1·D2). 스페이스 확인 → 그 쪽(`rootId` 커서 모드)과 구조(같은 루트의 checkpoint·bug 전부, 보관 포함)를 함께 받는다.
   * 쪽을 다 이어 붙인 결과는 옛 깊이별 탐색과 같다 — 같은 작업 집합(미보관 · 조상의 보관 무관, R2-C) · 같은 표시 부모(가장 가까운 미보관 조상, 스페이스면 null).
   * 부모가 뒤 쪽에 있어도 구조가 사슬을 풀어 준다. 커서는 LA 값 그대로 — 끝 = `nextCursor: null`, `truncated` 는 늘 false(끝은 커서가 말한다).
   */
  private async listItems({ spaceKey, cursor }: { spaceKey: string; cursor: string | null }): Promise<WorkOutcome> {
    const page = cursor === null ? 1 : this.listPages.get(cursor) ?? 2
    if (page > MAX_LIST_PAGES) return { ok: false, error: pagingError('목록') }
    const space = await this.tool({ name: 'issue_get', args: { id: spaceKey }, read: readIssueDetail })
    if (!space.ok) return space.outcome
    // 스페이스가 아닌 키(프로젝트가 아닌 일감 · 완료·보관돼 스페이스가 아니게 된 옛 프로젝트) = 「스페이스 아님」(R3-D) —
    // 그 아래 미보관 일감은 미분류에 나오고 단건도 미분류 키를 말한다. 옛 키로 그 프로젝트 키를 붙인 목록을 내지 않는다.
    if (!isSpace(space.value)) return { ok: false, error: workError({ kind: 'rejected', message: '이 키는 스페이스가 아닙니다 — 완료·보관된 프로젝트의 작업은 「미분류」 에 있습니다.' }) }
    const rootArgs = { rootId: spaceKey, archived: 'all', paginate: true }
    const [rows, checkpoints, bugs] = await Promise.all([
      this.tool({ name: 'issue_list', args: { ...rootArgs, limit: this.pageSize, ...(cursor === null ? {} : { cursor }) }, read: readIssuePage }),
      this.follow({ name: 'issue_list', args: { ...rootArgs, kind: 'checkpoint' }, read: readIssuePage, what: '목록 구조' }),
      this.follow({ name: 'issue_list', args: { ...rootArgs, kind: 'bug' }, read: readIssuePage, what: '목록 구조' }),
    ])
    if (!rows.ok) return rows.outcome
    if (!checkpoints.ok) return checkpoints.outcome
    if (!bugs.ok) return bugs.outcome
    const nextCursor = rows.value.nextCursor
    // 끝나지 않는 쪽(D10) — 빈 쪽인데 다음이 있음 · 받은 커서를 그대로 다시 줌. 조용히 끊지 않는다.
    if (nextCursor !== null && (rows.value.items.length === 0 || nextCursor === cursor)) return { ok: false, error: pagingError('목록') }
    if (nextCursor !== null) this.rememberListPage({ cursor: nextCursor, page: page + 1 })
    // 표시 부모를 풀 때 스페이스 프로젝트에 닿으면 바로 아래(null)다 — 사슬 지도에 프로젝트도 넣는다.
    const byId = new Map<string, LaIssue>()
    for (const issue of [...checkpoints.value, ...bugs.value]) byId.set(issue.id, issue)
    byId.set(space.value.id, space.value)
    const items = rows.value.items
      .filter((issue) => issue.kind !== 'project' && issue.archivedAt === null)
      .map((issue) => toItem({ issue, spaceKey, parentId: visibleParent({ issue, byId }) }))
    return { ok: true, result: { op: 'listItems', items, nextCursor, truncated: false } }
  }

  private rememberListPage({ cursor, page }: { cursor: string; page: number }): void {
    this.listPages.delete(cursor)
    this.listPages.set(cursor, page)
    if (this.listPages.size <= LIST_CURSOR_MEMORY) return
    const oldest = this.listPages.keys().next()
    if (oldest.done !== true) this.listPages.delete(oldest.value)
  }

  /**
   * 커서 쪽을 끝까지(D10) — 같은 인자 + `cursor: nextCursor`. 빈 쪽인데 다음이 있음 · 이미 받은 커서 · 쪽 수 상한 초과는 조용히 자르지 않고 오류(Jira `pagingError` 선례).
   */
  private async follow<T>({ name, args, read, what }: { name: string; args: Record<string, unknown>; read: (value: unknown, path: string) => LaPage<T>; what: string }): Promise<Step<T[]>> {
    const out: T[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < MAX_FOLLOW_PAGES; page += 1) {
      const step: Step<LaPage<T>> = await this.tool({ name, args: { ...args, limit: FOLLOW_PAGE_SIZE, ...(cursor === null ? {} : { cursor }) }, read })
      if (!step.ok) return step
      out.push(...step.value.items)
      const next: string | null = step.value.nextCursor
      if (next === null) return { ok: true, value: out }
      if (step.value.items.length === 0 || seen.has(next)) break
      seen.add(next)
      cursor = next
    }
    return { ok: false, outcome: { ok: false, error: pagingError(what) } }
  }

  /** 변경 이력(D6) — 끝까지 받아 **오래된 것부터**(LA 는 최신순). 계약 9칸만 · body 는 from/to null · 쓰기 id 그대로. `origin` 은 싣지 않는다(D8). */
  private async listHistory(itemId: string): Promise<WorkOutcome> {
    const rows = await this.follow({ name: 'issue_history_list', args: { issueId: itemId }, read: readHistoryPage, what: '변경 이력' })
    if (!rows.ok) return rows.outcome
    const entries: WorkHistoryEntry[] = []
    for (const row of rows.value) {
      const field = historyField(row.field)
      if (field === null) continue
      const text = field === 'body' ? { from: null, to: null } : { from: row.from, to: row.to }
      entries.push({ id: row.id, at: row.at, author: row.author, field, ...text, writeId: row.writeId })
    }
    return { ok: true, result: { op: 'listHistory', entries: entries.reverse() } }
  }

  /** 코멘트(D7) — 끝까지 받아 **오래된 것부터**. 본문은 받은 그대로. */
  private async listComments(itemId: string): Promise<WorkOutcome> {
    const rows = await this.follow({ name: 'issue_comment_list', args: { issueId: itemId }, read: readCommentPage, what: '코멘트' })
    return rows.ok ? { ok: true, result: { op: 'listComments', comments: [...rows.value].reverse() } } : rows.outcome
  }

  /** 코멘트 남기기(D7) — 한 번만 보낸다. 보낸 뒤 결과를 모르면(시간 초과·끊김·깨진 답) 「남았는지 모름」. 코멘트는 판을 올리지 않는다(611). */
  private async addComment({ itemId, body }: { itemId: string; body: string }): Promise<WorkOutcome> {
    const sent = await this.mcp.callTool({ name: 'issue_comment_add', args: { issueId: itemId, body } })
    if (!sent.ok) return { ok: false, error: unknownWriteOutcome({ error: sent.error, unsent: sent.unsent === true, prefix: COMMENT_UNKNOWN_PREFIX }) }
    try {
      return { ok: true, result: { op: 'addComment', comment: readComment(sent.value, 'issue_comment_add') } }
    } catch (error) {
      if (error instanceof LaShapeError) return { ok: false, error: unknownWriteOutcome({ error: workError({ kind: 'invalid_response', message: error.message }), unsent: false, prefix: COMMENT_UNKNOWN_PREFIX }) }
      throw error
    }
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

  /**
   * 결과 단건 읽기. `applied` = 이 연산이 방금 쓰기를 저장했다(LIFE-632 R5-B) — 그 뒤 읽기 실패는 「적용됐지만 정본 없음」 이라 `maybeApplied`.
   * 쓰기 없는 갈래(같은 상태·같은 갈래)는 `applied: false` — 읽기 실패는 그냥 실패다(적용할 것이 없었다). 읽기 함수는 앞의 쓰기를 모르므로 부르는 쪽이 넘긴다.
   */
  private async itemResult({ op, itemId, applied }: { op: 'changeStatus' | 'setPlacement' | 'setParent' | 'updateItem'; itemId: string; applied: boolean }): Promise<WorkOutcome> {
    const item = await this.item(itemId)
    if (item.ok) return { ok: true, result: { op, item: item.value } }
    if (!applied || item.outcome.ok) return item.outcome
    return { ok: false, error: appliedUnread({ error: item.outcome.error, prefix: WRITTEN_PREFIX }) }
  }

  /** 쓰기 한 단계의 끝 — 성공이면 단건으로 결과를(쓰기는 저장됐다), 실패면 충돌에 지금 작업을 붙여 그대로. */
  private written({ op, itemId, step }: { op: 'changeStatus' | 'setPlacement' | 'setParent' | 'updateItem'; itemId: string; step: Step<unknown> }): Promise<WorkOutcome> {
    return step.ok ? this.itemResult({ op, itemId, applied: true }) : this.withCurrent({ itemId, outcome: step.outcome })
  }

  /**
   * 저장 충돌이면 서버의 지금 작업을 **단건 경로로 다시 읽어** 싣는다(F4) — LA CONFLICT 의 `current` 는 수정 응답 모양이라 연결·막힘이 없고
   * 스페이스·표시 부모도 부모 사슬로 풀어야 한다. 다시 읽은 값이 충돌 뒤 더 바뀌었어도 그것이 「지금 서버 값」 이다. 다시 읽지 못하면 current 없이
   * conflict 그대로(화면은 실패로 알린다 — 성공으로 넘기지 않는다). 충돌이 아닌 실패는 손대지 않는다.
   */
  private async withCurrent({ itemId, outcome }: { itemId: string; outcome: WorkOutcome }): Promise<WorkOutcome> {
    if (outcome.ok || outcome.error.kind !== 'conflict') return outcome
    const current = await this.item(itemId)
    if (!current.ok) return outcome
    return { ok: false, error: { ...outcome.error, message: conflictMessage(current.value.key), conflict: { current: current.value, by: null } } }
  }

  /**
   * `resolution` — 완료 분류로 갈 때의 갈래(E5). null 이면 완료함. 같은 완료 상태에서 갈래만 다르면 갈래만 바꾼다.
   * `ifVersion`(LIFE-622) — 모든 쓰기 갈래에 싣는다: 전진 `issue_transition` · 서버 no-op 뒤 이어지는 `issue_update(statusId)`(no-op 전이는 판을
   * 소비하지 않으므로 같은 판, F5) · 뒤로 `issue_update(statusId)`(D6) · 갈래만 `issue_update(resolution)`. **쓰기가 없는 갈래**(같은 상태·같은 갈래)는
   * 서버가 판을 볼 기회가 없다(F7) — 이 연산이 막 읽은 단건의 판과 글자로 견줘 다르면 충돌로 돌려준다(낡은 판을 성공으로 넘기지 않는다).
   */
  private async changeStatus({ itemId, statusKey, resolution, ifVersion, writeId }: { itemId: string; statusKey: string; resolution: WorkResolutionChoice | null; ifVersion: string | null; writeId: string | null }): Promise<WorkOutcome> {
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
      if (target.categoryKey !== 'done' || resolution === null || current.value.resolution === resolution) {
        if (ifVersion !== null && ifVersion !== current.value.version) return this.withCurrent({ itemId, outcome: { ok: false, error: workError({ kind: 'conflict', status: 409, message: conflictMessage(current.value.displayId) }) } })
        return this.itemResult({ op: 'changeStatus', itemId, applied: false })
      }
      const updated = await this.writeTool({ name: 'issue_update', args: versioned({ args: { id: itemId, resolution }, ifVersion }), read: readIssueUpdated, writeId })
      return this.written({ op: 'changeStatus', itemId, step: updated })
    }
    const labelUnique = order.filter((status) => status.label === target.label).length === 1
    if (to > from && labelUnique) {
      const args: Record<string, unknown> = { id: itemId, toStatusLabel: target.label, forwardOnly: true }
      if (target.categoryKey === 'done') args.resolution = chosen
      const moved = await this.writeTool({ name: 'issue_transition', args: versioned({ args, ifVersion }), read: readTransition, writeId })
      if (!moved.ok) return this.withCurrent({ itemId, outcome: moved.outcome })
      if (moved.value.transitioned) return this.itemResult({ op: 'changeStatus', itemId, applied: true })
      // 서버가 「뒤로」 라고 보면(순서 해석이 갈림) 되돌리기 경로로 — D6 은 둘 다 허용한다.
    }
    const args: Record<string, unknown> = { id: itemId, statusId: target.id }
    if (target.categoryKey !== 'done' && current.value.statusCategoryKey === 'done') args.resolution = null
    if (target.categoryKey === 'done') args.resolution = chosen
    const updated = await this.writeTool({ name: 'issue_update', args: versioned({ args, ifVersion }), read: readIssueUpdated, writeId })
    return this.written({ op: 'changeStatus', itemId, step: updated })
  }

  private async addRelation({ itemId, kind, otherKey, writeId }: { itemId: string; kind: WorkRelation['kind']; otherKey: string; writeId: string | null }): Promise<WorkOutcome> {
    const match = LA_KEY.exec(otherKey.trim())
    if (match === null) return { ok: false, error: workError({ kind: 'rejected', message: `LA 작업 키는 LIFE-N 꼴입니다 (${otherKey.slice(0, 40)}).` }) }
    const issue = await this.tool({ name: 'issue_get', args: { id: itemId }, read: readIssueDetail })
    if (!issue.ok) return issue.outcome
    const otherSeq = Number(match[1])
    if (otherSeq === issue.value.sequentialId) return { ok: false, error: workError({ kind: 'rejected', message: '자기 자신과는 연결할 수 없습니다.' }) }
    const created = await this.tool({ name: 'issue_link_create', args: withWriteId({ args: { seq: issue.value.sequentialId, relation: kind, otherSeq }, writeId }), read: readLink })
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
  // onBoard 는 종류 무관 늘 명시한다 — bug 도 LA 가 쓰는 칸이다(LIFE-665). 안 실으면 LA 기본(백로그)으로 조용히 간다.
  const args: Record<string, unknown> = { kind, title: call.title, parentId, onBoard: (call.placement ?? 'board') === 'board' }
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

/** 조건부 쓰기 인자 — 판이 있으면 `ifVersion` 으로 받은 그대로 싣고, 없으면(null) 칸을 뺀다(LA: 생략 = 무조건 저장 — 「내 값으로 덮기」). */
function versioned({ args, ifVersion }: { args: Record<string, unknown>; ifVersion: string | null }): Record<string, unknown> {
  return ifVersion === null ? args : { ...args, ifVersion }
}

/** corral 쓰기 id → LA `clientWriteId` 값. 패턴 밖이거나 없으면 null(싣지 않는다, D5). */
function clientWriteIdOf(writeId: string | null): string | null {
  return writeId !== null && CLIENT_WRITE_ID.test(writeId) ? writeId : null
}

/** 쓰기 도구 인자에 `clientWriteId` 를 — 값이 없으면 칸을 뺀다(LA: 생략 = 이력 행 writeId null). */
function withWriteId({ args, writeId }: { args: Record<string, unknown>; writeId: string | null }): Record<string, unknown> {
  return writeId === null ? args : { ...args, clientWriteId: writeId }
}

/** LA 이력 칸 이름 → 계약 칸. 계약 밖(`kind`·`goal`·`archived`·모르는 이름)은 null(버린다). */
function historyField(field: string): WorkHistoryField | null {
  return WORK_HISTORY_FIELDS.find((known) => known === field) ?? null
}

function pagingError(what: string): WorkError {
  return workError({ kind: 'invalid_response', message: `LA ${what} 쪽이 끝나지 않습니다(빈 쪽·같은 다음 쪽 표지·쪽 수 상한) — 응답 모양이 다릅니다.` })
}

/** 충돌 문구 — 원격 message 를 옮기지 않고 이쪽 말로(모의 출처와 같은 꼴). */
function conflictMessage(key: string): string {
  return `${key} 이(가) 연 뒤에 바뀌었습니다 — 새로 불러오거나 덮어쓰세요.`
}

function unsupported(name: 'order' | 'querySearch'): WorkOutcome {
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

function toItem({ issue, spaceKey, parentId }: { issue: LaIssue | LaIssueDetail; spaceKey: string; parentId: string | null }): WorkItem {
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
    // 응답 값 그대로(LIFE-702) — 숨김 판정이 분류를 같이 본다.
    doneAt: issue.doneAt,
    priority: issue.priority,
    dueAt: issue.dueAt,
    parentId,
    placement: issue.onBoard === null ? null : issue.onBoard ? 'board' : 'backlog',
    rank: issue.position,
    openBlockerCount: issue.openBlockerCount,
    openBlockers: issue.openBlockers.map((blocker) => ({ id: blocker.id, key: blocker.displayId, title: blocker.title })),
    updatedAt: issue.updatedAt,
    version: issue.version,
    relations: issue.links === null
      ? null
      : issue.links.map((link) => ({
          id: link.id,
          kind: link.relation,
          other: { id: link.issue.id, key: link.issue.displayId, title: link.issue.title, statusLabel: link.issue.statusLabel, category: link.issue.statusCategoryKey, spaceKey: null },
        })),
    // 단건만 링크를 싣는다 — 목록 행·생성 응답은 링크가 없다(빈 배열 = 안 실음, `WorkItem.workLinks` 주석).
    workLinks: 'workLinks' in issue ? issue.workLinks : [],
    bodyLock: null,
  }
}
