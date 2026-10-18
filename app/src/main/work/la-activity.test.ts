// LIFE-638 L1e — LA 쓰기 id 왕복(C4) · 변경 이력(C5) · 코멘트(C7) · 이력·코멘트 순회 상한(C8).
// 실제 경로: `WorkService.request`(쓰기 id 를 만들어 출처에 넘기고 활동 기록에 남긴다) → `LaSource` → `McpHttpClient` → `LaMcpFixture`(HTTP, 가짜 토큰).
// 패턴 밖 쓰기 id 는 서비스가 만들지 않으므로(UUID·하네스 `conn-N`) 출처를 직접 부른다 — `WorkSourceClient.call(call, { writeId })`.
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkResponse } from '../../shared/work.js'
import { FIXTURE_IDS, FIXTURE_STATUS } from './la-mcp-fixture.js'
import { LA_CAPABILITIES, laSourceEntry } from './la-source.js'
import { McpHttpClient } from './mcp-http.js'
import { FAKE_LA_TOKEN, laFixtureHarness } from './test-kit.js'

type Harness = Awaited<ReturnType<typeof laFixtureHarness>>

const opened: Harness[] = []
afterEach(async () => {
  for (const harness of opened.splice(0)) await harness.fixture.stop()
})

async function connect({ timeoutMs }: { timeoutMs?: number } = {}): Promise<{ harness: Harness; connectionId: string; send: (call: WorkCall) => Promise<WorkResponse> }> {
  const harness = await laFixtureHarness({ timeoutMs })
  opened.push(harness)
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  let n = 0
  return { harness, connectionId: added.connection.id, send: (call) => harness.service.request({ requestId: `a-${++n}`, connectionId: added.connection.id, call }) }
}

async function ok(response: Promise<WorkResponse>): Promise<Extract<WorkResponse, { ok: true }>['result']> {
  const got = await response
  if (!got.ok) throw new Error(`${got.error.kind} ${got.error.message}`)
  return got.result
}

const WRITE_TOOLS = ['issue_create', 'issue_update', 'issue_transition', 'issue_link_create', 'issue_link_delete']

describe('C4 쓰기 id 왕복 — 쓰기 5툴에 clientWriteId', () => {
  it('연산별(상태 앞·뒤 · 갈래만 · 필드 · 배치 · 부모 · 만들기 · 연결 추가·삭제) — 보낸 clientWriteId = 그 쓰기의 활동 기록 writeId · 읽기·작업 링크·코멘트 툴엔 없음', async () => {
    const { harness, connectionId, send } = await connect()
    const calls: { label: string; call: WorkCall; tools: string[] }[] = [
      { label: '상태 앞으로', call: { op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.dev, ifVersion: null }, tools: ['issue_transition'] },
      { label: '상태 뒤로', call: { op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.todo, ifVersion: null }, tools: ['issue_update'] },
      { label: '완료(앞으로)', call: { op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.done, resolution: 'completed', ifVersion: null }, tools: ['issue_transition'] },
      { label: '갈래만', call: { op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.done, resolution: 'cancelled', ifVersion: null }, tools: ['issue_update'] },
      { label: '필드', call: { op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: '새 제목', priority: 'low' }, ifVersion: null }, tools: ['issue_update'] },
      { label: '배치', call: { op: 'setPlacement', itemId: FIXTURE_IDS.task600, placement: 'backlog', ifVersion: null }, tools: ['issue_update'] },
      { label: '부모', call: { op: 'setParent', itemId: FIXTURE_IDS.task600, spaceKey: FIXTURE_IDS.corral, parentId: null, ifVersion: null }, tools: ['issue_update'] },
      { label: '만들기', call: { op: 'createItem', spaceKey: FIXTURE_IDS.corral, kindKey: 'task', title: '만든 것', parentId: FIXTURE_IDS.checkpoint }, tools: ['issue_create'] },
      { label: '연결 추가', call: { op: 'addRelation', itemId: FIXTURE_IDS.task600, kind: 'relates_to', otherKey: 'LIFE-601' }, tools: ['issue_link_create'] },
    ]
    for (const { label, call, tools } of calls) {
      const start = harness.fixture.toolCalls.length
      await ok(send(call))
      const sent = harness.fixture.toolCalls.slice(start)
      const writes = sent.filter((entry) => WRITE_TOOLS.includes(entry.tool))
      expect({ label, tools: writes.map((entry) => entry.tool) }).toEqual({ label, tools })
      const ids = new Set(writes.map((entry) => entry.args.clientWriteId))
      expect(ids.size).toBe(1)
      const [writeId] = [...ids]
      expect(typeof writeId).toBe('string')
      const records = harness.service.activity({ connectionId, itemId: call.op === 'createItem' ? FIXTURE_IDS.checkpoint : 'itemId' in call ? call.itemId : '' })
      if (!records.ok) throw new Error(records.error.message)
      expect({ label, paired: records.records.some((record) => record.writeId === writeId) }).toEqual({ label, paired: true })
      // 읽기 툴(issue_get·status_list·issue_list·issue_by_seq)에는 쓰기 id 가 실리지 않는다.
      expect(sent.filter((entry) => !WRITE_TOOLS.includes(entry.tool)).every((entry) => !('clientWriteId' in entry.args))).toBe(true)
    }
    const detail = await ok(send({ op: 'getItem', itemId: FIXTURE_IDS.task600 }))
    if (detail.op !== 'getItem') throw new Error(detail.op)
    const relation = detail.item.relations?.find((entry) => entry.other.key === 'LIFE-601')
    if (relation === undefined) throw new Error('연결 없음')
    const start = harness.fixture.toolCalls.length
    await ok(send({ op: 'removeRelation', itemId: FIXTURE_IDS.task600, relationId: relation.id }))
    const removed = harness.fixture.toolCalls.slice(start).find((entry) => entry.tool === 'issue_link_delete')
    expect(typeof removed?.args.clientWriteId).toBe('string')
    // 작업 링크·코멘트 툴(쓰기지만 이력에 안 남는다)은 clientWriteId 를 받지 않는다 — 싣지 않는다.
    const linkStart = harness.fixture.toolCalls.length
    await ok(send({ op: 'addComment', itemId: FIXTURE_IDS.task600, body: '코멘트' }))
    expect(harness.fixture.toolCalls.slice(linkStart).every((entry) => !('clientWriteId' in entry.args))).toBe(true)
  })

  it('전진 전이가 서버에서 no-op 이면 이어지는 issue_update 도 같은 쓰기 id(한 쓰기)', async () => {
    const { harness, send } = await connect()
    harness.fixture.transitionNoop = true
    const start = harness.fixture.toolCalls.length
    await ok(send({ op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.dev, ifVersion: null }))
    const writes = harness.fixture.toolCalls.slice(start).filter((entry) => WRITE_TOOLS.includes(entry.tool))
    expect(writes.map((entry) => entry.tool)).toEqual(['issue_transition', 'issue_update'])
    expect(new Set(writes.map((entry) => entry.args.clientWriteId)).size).toBe(1)
  })

  it.each([['a b'], ['x'.repeat(65)], [''], ['한글'], [null]] as const)('패턴 밖·없는 쓰기 id(%j)는 싣지 않고 쓰기는 성공', async (writeId) => {
    const { harness } = await connect()
    const client = laSourceEntry({ url: harness.url, clientVersion: 'test' }).create({ token: FAKE_LA_TOKEN, account: {} })
    const start = harness.fixture.toolCalls.length
    const outcome = await client.call({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: `패턴 밖 ${String(writeId).length}` }, ifVersion: null }, { writeId })
    expect(outcome.ok).toBe(true)
    const sent = harness.fixture.toolCalls.slice(start).find((entry) => entry.tool === 'issue_update')
    expect(sent === undefined ? 'missing' : 'clientWriteId' in sent.args).toBe(false)
    client.close()
  })

  it('패턴 안 끝값(64자 · 영숫자·_·-)은 그대로 싣는다', async () => {
    const { harness } = await connect()
    const client = laSourceEntry({ url: harness.url, clientVersion: 'test' }).create({ token: FAKE_LA_TOKEN, account: {} })
    const writeId = `A_-${'9'.repeat(61)}`
    expect(writeId).toHaveLength(64)
    const outcome = await client.call({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: '64자' }, ifVersion: null }, { writeId })
    expect(outcome.ok).toBe(true)
    expect(harness.fixture.toolCalls.findLast((entry) => entry.tool === 'issue_update')?.args.clientWriteId).toBe(writeId)
    client.close()
  })

  it('양성 대조 — fixture 는 패턴 밖 clientWriteId 를 -32602 로 거절한다(실으면 쓰기 전체가 실패 · 저장 0)', async () => {
    const { harness } = await connect()
    const mcp = new McpHttpClient({ url: harness.url, token: FAKE_LA_TOKEN, clientVersion: 'test' })
    const before = harness.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.task600)?.title
    const sent = await mcp.callTool({ name: 'issue_update', args: { id: FIXTURE_IDS.task600, title: '실으면', clientWriteId: 'a b' } })
    expect(sent.ok).toBe(false)
    if (!sent.ok) expect(sent.error.message).toContain('JSON-RPC -32602')
    expect(harness.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.task600)?.title).toBe(before)
    expect(harness.fixture.history).toHaveLength(0)
    mcp.close()
  })
})

describe('C5 변경 이력', () => {
  it('능력 켜짐 · 끝까지(여러 쪽) · 오래된 것부터 · 계약 9칸만(kind·goal·archived·모르는 칸 버림) · body from/to null · writeId·author 그대로', async () => {
    expect(LA_CAPABILITIES.history.state).toBe('on')
    const { harness, send } = await connect()
    const issueId = FIXTURE_IDS.task600
    for (let n = 0; n < 430; n += 1) harness.fixture.plantHistory({ issueId, author: n % 2 === 0 ? '웹' : '모바일', field: 'title', from: `t${n}`, to: `t${n + 1}`, writeId: null, origin: n % 2 === 0 ? 'web' : 'mobile' })
    for (const field of ['kind', 'goal', 'archived', 'color']) harness.fixture.plantHistory({ issueId, author: '웹', field, from: null, to: 'x', writeId: null, origin: 'web' })
    harness.fixture.plantHistory({ issueId, author: 'macbook', field: 'body', from: 'old', to: 'new', writeId: null, origin: 'mcp' })
    const start = harness.fixture.toolCalls.length
    const result = await ok(send({ op: 'listHistory', itemId: issueId }))
    if (result.op !== 'listHistory') throw new Error(result.op)
    const pages = harness.fixture.toolCalls.slice(start).filter((entry) => entry.tool === 'issue_history_list')
    expect(pages.length).toBe(3)
    expect(pages[0]?.args).toEqual({ issueId, limit: 200 })
    expect(result.entries).toHaveLength(431)
    const stamps = result.entries.map((entry) => Date.parse(entry.at))
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
    expect(result.entries[0]?.from).toBe('t0')
    expect(result.entries.some((entry) => ['kind', 'goal', 'archived', 'color'].includes(entry.field))).toBe(false)
    const body = result.entries.at(-1)
    expect(body).toEqual({ id: expect.any(String), at: expect.any(String), author: 'macbook', field: 'body', from: null, to: null, writeId: null })
    expect(Object.keys(result.entries[0] ?? {}).sort()).toEqual(['at', 'author', 'field', 'from', 'id', 'to', 'writeId'])
  })

  it('한 쓰기의 여러 칸 = 같은 writeId 여러 행(활동 기록과 같은 id) · 값이 안 바뀐 쓰기 = 0행 · 거절된 쓰기 = 0행', async () => {
    const { harness, connectionId, send } = await connect()
    const issueId = FIXTURE_IDS.task600
    await ok(send({ op: 'updateItem', itemId: issueId, fields: { title: '두 칸', priority: 'low' }, ifVersion: null }))
    const history = async () => {
      const result = await ok(send({ op: 'listHistory', itemId: issueId }))
      if (result.op !== 'listHistory') throw new Error(result.op)
      return result.entries
    }
    const rows = await history()
    expect(rows.map((row) => row.field).sort()).toEqual(['priority', 'title'])
    expect(new Set(rows.map((row) => row.writeId)).size).toBe(1)
    expect(new Set(rows.map((row) => row.at)).size).toBe(1)
    expect(rows[0]?.author).toBe('fixture-pat')
    const activity = harness.service.activity({ connectionId, itemId: issueId })
    if (!activity.ok) throw new Error(activity.error.message)
    expect(activity.records.every((record) => record.writeId === rows[0]?.writeId)).toBe(true)
    // 같은 값을 다시 보내면 이력 0행.
    await ok(send({ op: 'updateItem', itemId: issueId, fields: { title: '두 칸' }, ifVersion: null }))
    expect(await history()).toHaveLength(2)
    // 낡은 판 = 거절(저장 0) → 이력 0행.
    const stale = await send({ op: 'updateItem', itemId: issueId, fields: { title: '낡은 판' }, ifVersion: '1' })
    expect(stale.ok ? null : stale.error.kind).toBe('conflict')
    expect(await history()).toHaveLength(2)
  })

  it('만들기 = 부모 child 행에만 쓰기 id(만든 작업 자신엔 행 없음) — corral 활동의 부모 child 줄과 같은 id · 코멘트·작업 링크는 이력에 없다', async () => {
    const { harness, connectionId, send } = await connect()
    const created = await ok(send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, kindKey: 'task', title: '자식', parentId: FIXTURE_IDS.checkpoint }))
    if (created.op !== 'createItem') throw new Error(created.op)
    const parentHistory = await ok(send({ op: 'listHistory', itemId: FIXTURE_IDS.checkpoint }))
    if (parentHistory.op !== 'listHistory') throw new Error(parentHistory.op)
    expect(parentHistory.entries).toEqual([expect.objectContaining({ field: 'child', from: null, to: `${created.item.key} 자식` })])
    const ownHistory = await ok(send({ op: 'listHistory', itemId: created.item.id }))
    expect(ownHistory.op === 'listHistory' ? ownHistory.entries : null).toEqual([])
    const activity = harness.service.activity({ connectionId, itemId: FIXTURE_IDS.checkpoint })
    if (!activity.ok) throw new Error(activity.error.message)
    expect(activity.records.find((record) => record.change.field === 'child')?.writeId).toBe(parentHistory.entries[0]?.writeId)
    await ok(send({ op: 'addComment', itemId: created.item.id, body: '코멘트' }))
    expect(harness.fixture.history.filter((row) => row.issueId === created.item.id)).toHaveLength(0)
  })

  it.each(['history-from-number', 'page-cursor-number', 'page-cursor-empty', 'page-items-object'] as const)('행·쪽 모양 깨짐(%s) → invalid_response(양성 대조: 깨기 전 통과)', async (corrupt) => {
    const { harness, send } = await connect()
    await ok(send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: '깨기 전' }, ifVersion: null }))
    expect((await send({ op: 'listHistory', itemId: FIXTURE_IDS.task600 })).ok).toBe(true)
    harness.fixture.corrupt = corrupt
    const broken = await send({ op: 'listHistory', itemId: FIXTURE_IDS.task600 })
    expect(broken.ok ? null : broken.error.kind).toBe('invalid_response')
  })

  it('fixture 이력이 LA 611 의미를 따른다 — 상태 행은 라벨(취소면 「· 취소함」) · 부모 바꾸기 = parent + 옛·새 부모 child · 연결 = 양쪽 relation 문장', async () => {
    const { harness, send } = await connect()
    await ok(send({ op: 'changeStatus', itemId: FIXTURE_IDS.task601, statusKey: FIXTURE_STATUS.done, resolution: 'cancelled', ifVersion: null }))
    await ok(send({ op: 'setParent', itemId: FIXTURE_IDS.task601, spaceKey: FIXTURE_IDS.corral, parentId: FIXTURE_IDS.bug, ifVersion: null }))
    await ok(send({ op: 'addRelation', itemId: FIXTURE_IDS.task601, kind: 'is_blocked_by', otherKey: 'LIFE-600' }))
    const rows = (issueId: string) => harness.fixture.history.filter((row) => row.issueId === issueId).map(({ field, from, to }) => ({ field, from, to }))
    expect(rows(FIXTURE_IDS.task601)).toEqual([
      { field: 'status', from: '할 일', to: '완료 · 취소함' },
      { field: 'parent', from: 'LIFE-372 LA 일감 연결', to: 'LIFE-386 프로젝트 아래 버그' },
      { field: 'relation', from: null, to: 'is blocked by LIFE-600' },
    ])
    expect(rows(FIXTURE_IDS.checkpoint)).toEqual([{ field: 'child', from: 'LIFE-601 작업 페이지', to: null }])
    expect(rows(FIXTURE_IDS.bug)).toEqual([{ field: 'child', from: null, to: 'LIFE-601 작업 페이지' }])
    expect(rows(FIXTURE_IDS.task600)).toEqual([{ field: 'relation', from: null, to: 'blocks LIFE-601' }])
  })
})

describe('C7 코멘트', () => {
  it('능력 켜짐 · 끝까지 · 오래된 것부터 · {id, author, body, createdAt} · 본문 바이트 그대로(앞뒤 공백·줄바꿈)', async () => {
    expect(LA_CAPABILITIES.comments.state).toBe('on')
    const { harness, send } = await connect()
    const issueId = FIXTURE_IDS.task600
    for (let n = 0; n < 250; n += 1) harness.fixture.plantComment({ issueId, author: '웹', body: `c${n}` })
    const body = '  앞뒤 공백\n\n**굵게**\r\n줄 끝 공백  \n'
    const added = await ok(send({ op: 'addComment', itemId: issueId, body }))
    if (added.op !== 'addComment') throw new Error(added.op)
    expect(added.comment).toEqual({ id: expect.any(String), author: 'fixture-pat', body, createdAt: expect.any(String) })
    expect(harness.fixture.toolCalls.filter((entry) => entry.tool === 'issue_comment_add').map((entry) => entry.args)).toEqual([{ issueId, body }])
    const listed = await ok(send({ op: 'listComments', itemId: issueId }))
    if (listed.op !== 'listComments') throw new Error(listed.op)
    expect(listed.comments).toHaveLength(251)
    expect(listed.comments[0]?.body).toBe('c0')
    expect(listed.comments.at(-1)).toEqual(added.comment)
    expect(Object.keys(listed.comments[0] ?? {}).sort()).toEqual(['author', 'body', 'createdAt', 'id'])
    expect(harness.fixture.toolCalls.filter((entry) => entry.tool === 'issue_comment_list')).toHaveLength(2)
  })

  it.each([
    ['끊김(처리 뒤)', { kind: 'drop-after' }],
    ['시간 초과', { kind: 'delay', ms: 400 }],
  ] as const)('보낸 뒤 결과 모름(%s) — 다시 보내지 않고(호출 1) 「남았는지 모름」', async (_label, fault) => {
    const { harness, send } = await connect({ timeoutMs: 200 })
    harness.fixture.toolFaults.set('issue_comment_add', fault)
    const response = await send({ op: 'addComment', itemId: FIXTURE_IDS.task600, body: '한 번만' })
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.maybeApplied).toBe(true)
    expect(response.error.message).toContain('코멘트가 남았는지 모릅니다')
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(harness.fixture.requests.filter((request) => request.tool === 'issue_comment_add')).toHaveLength(1)
  })

  it('깨진 답 — 결과 모름(maybeApplied) · 호출 1 · 양성 대조: 깨지 않으면 성공', async () => {
    const { harness, send } = await connect()
    expect((await send({ op: 'addComment', itemId: FIXTURE_IDS.task600, body: '정상' })).ok).toBe(true)
    harness.fixture.corrupt = 'comment-body-number'
    const response = await send({ op: 'addComment', itemId: FIXTURE_IDS.task600, body: '깨진 답' })
    expect(response.ok ? null : { kind: response.error.kind, maybe: response.error.maybeApplied }).toEqual({ kind: 'invalid_response', maybe: true })
    expect(harness.fixture.requests.filter((request) => request.tool === 'issue_comment_add')).toHaveLength(2)
  })

  it('공백만 본문 = LA 가 분명히 거절(rejected · 결과 모름 아님)', async () => {
    const { send } = await connect()
    const response = await send({ op: 'addComment', itemId: FIXTURE_IDS.task600, body: '   \n' })
    expect(response.ok ? null : { kind: response.error.kind, maybe: response.error.maybeApplied ?? false }).toEqual({ kind: 'rejected', maybe: false })
  })

  it('코멘트 추가는 판(version)을 바꾸지 않는다 — 추가 뒤 열린 상세의 조건부 저장이 conflict 로 막히지 않는다', async () => {
    const { send } = await connect()
    const opened = await ok(send({ op: 'getItem', itemId: FIXTURE_IDS.task600 }))
    if (opened.op !== 'getItem') throw new Error(opened.op)
    await ok(send({ op: 'addComment', itemId: FIXTURE_IDS.task600, body: '판 무관' }))
    const saved = await send({ op: 'updateItem', itemId: FIXTURE_IDS.task600, fields: { title: '조건부 저장' }, ifVersion: opened.item.version })
    expect(saved.ok).toBe(true)
  })
})

describe('C8 이력·코멘트 순회 상한', () => {
  it.each([
    ['issue_history_list', 'repeat'], ['issue_history_list', 'empty'], ['issue_history_list', 'endless'],
    ['issue_comment_list', 'repeat'], ['issue_comment_list', 'empty'], ['issue_comment_list', 'endless'],
  ] as const)('%s %s → 무한 순회 없이 invalid_response', async (tool, mode) => {
    const { harness, send } = await connect()
    const issueId = FIXTURE_IDS.task600
    for (let n = 0; n < 250; n += 1) {
      harness.fixture.plantHistory({ issueId, author: '웹', field: 'title', from: null, to: `t${n}`, writeId: null, origin: 'web' })
      harness.fixture.plantComment({ issueId, author: '웹', body: `c${n}` })
    }
    const call: WorkCall = tool === 'issue_history_list' ? { op: 'listHistory', itemId: issueId } : { op: 'listComments', itemId: issueId }
    // 양성 대조: 고장이 없으면 끝까지 받는다.
    expect((await send(call)).ok).toBe(true)
    harness.fixture.pagingFault = { tool, mode }
    const response = await send(call)
    expect(response.ok ? null : response.error.kind).toBe('invalid_response')
    if (!response.ok) expect(response.error.message).toContain('쪽이 끝나지 않습니다')
    expect(harness.fixture.toolCalls.filter((entry) => entry.tool === tool).length).toBeLessThanOrEqual(2 + 50)
  })
})
