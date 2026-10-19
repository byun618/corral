// LIFE-651 — LA `issue_create` 응답의 position 은 숫자(task·bug)·null(project·checkpoint), 저장된 행(get·list·update)은 글자다(c11-la-source-contrast.md).
// C1: `readCore` 의 position 이 글자·null·정수 숫자를 받고 그 밖은 `LaShapeError(<경로>.position)` — create·update·목록 행 셋에서 같은 규칙.
// C2: K15 미달 5경로 모양(ⓐ–ⓔ)과 재조회 실패 갈래가 서비스 → la-source → 모의 MCP 실제 경로에서 ok, rank = 응답 숫자의 글자.
// 「숫자 응답」 시험은 모의 MCP 가 실제로 숫자를 보냈는지 HTTP 응답 본문에서 확인한다(모양과 무관하게 통과하는 가짜 대조 방지 — C4 ⓑ).
import { afterEach, describe, expect, it } from 'vitest'
import { isRecord } from '../../shared/json.js'
import type { WorkCall, WorkResponse } from '../../shared/work.js'
import { FIXTURE_IDS, FIXTURE_STATUS, LaMcpFixture } from './la-mcp-fixture.js'
import { LaShapeError, readIssueCreated, readIssueSummary, readIssueUpdated } from './la-shape.js'
import { laSourceEntry } from './la-source.js'
import { FAKE_LA_TOKEN, workHarness } from './test-kit.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  while (stops.length > 0) await stops.pop()?.()
})

/** 저장된 행 모양(DB 행 — position 글자). 시험마다 position 만 바꿔 넣는다. */
function row(position: unknown): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000651', sequentialId: 651, displayId: 'LIFE-651', kind: 'task', title: 't',
    statusId: FIXTURE_STATUS.todo, statusCategoryKey: 'todo', statusLabel: '할 일', resolution: null,
    parentId: null, priority: null, onBoard: true, position, dueAt: null, color: null, archivedAt: null,
    updatedAt: '2026-10-19T00:00:00.000Z', version: '1', description: null, openBlockers: [],
  }
}

const READERS = [
  { name: 'readIssueCreated', path: 'issue_create', read: readIssueCreated },
  { name: 'readIssueUpdated', path: 'issue_update', read: readIssueUpdated },
  { name: 'readIssueSummary(목록 행)', path: 'issue_list[0]', read: readIssueSummary },
] as const

describe('C1 — position 두 모양 수용 · 그 밖은 어긋남', () => {
  for (const { name, path, read } of READERS) {
    describe(name, () => {
      it.each([
        ['숫자 4 → "4"', 4, '4'],
        ['숫자 0 → "0"', 0, '0'],
        ['글자 "30" 그대로', '30', '30'],
        ['null 그대로', null, null],
      ])('%s', (_label, value, expected) => {
        expect(read(row(value), path).position).toBe(expected)
      })

      it.each([
        ['소수 1.5', 1.5],
        ['음수 -1', -1],
        ['안전 정수 밖 1e21', 1e21],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['불리언 true', true],
        ['객체', { n: 1 }],
        ['배열', [1]],
      ])('%s → LaShapeError(%s)', (_label, value) => {
        expect(() => read(row(value), path)).toThrow(new LaShapeError(`${path}.position`))
      })

      it('칸 없음 → LaShapeError(.position) — 조용히 null 로 접지 않는다', () => {
        const { position: _gone, ...rest } = row('1')
        void _gone
        expect(() => read(rest, path)).toThrow(new LaShapeError(`${path}.position`))
      })
    })
  }
})

let seq = 0

/** 서비스 하네스 + `issue_create` 응답 본문의 position 기록(모의 MCP 가 보낸 그대로). */
async function setup() {
  const fixture = new LaMcpFixture()
  fixture.tokens.set(FAKE_LA_TOKEN, 'write')
  const url = await fixture.start()
  stops.push(() => fixture.stop())
  const createdPositions: unknown[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await fetch(input, init)
    if (typeof init?.body === 'string' && init.body.includes('"name":"issue_create"')) createdPositions.push(createPosition(await response.clone().text()))
    return response
  }
  const harness = workHarness({ entries: [laSourceEntry({ url, clientVersion: 'test', fetchImpl })] })
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  const send = (call: WorkCall): Promise<WorkResponse> => harness.service.request({ requestId: `p-${++seq}`, connectionId: added.connection.id, call })
  return { fixture, send, createdPositions }
}

/** JSON-RPC 결과(JSON 또는 SSE `data:` 줄)에서 도구 결과 글을 풀어 position 값을 꺼낸다. */
function createPosition(text: string): unknown {
  const payload = text.trimStart().startsWith('{') ? text : text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5)).join('')
  const rpc: unknown = JSON.parse(payload)
  if (!isRecord(rpc) || !isRecord(rpc.result) || !Array.isArray(rpc.result.content)) throw new Error('issue_create 결과 모양')
  const content: unknown = rpc.result.content[0]
  if (!isRecord(content) || typeof content.text !== 'string') throw new Error('issue_create 결과 글')
  const issue: unknown = JSON.parse(content.text)
  if (!isRecord(issue)) throw new Error('issue_create 결과 일감')
  return issue.position
}

async function created({ send, call }: { send: (call: WorkCall) => Promise<WorkResponse>; call: WorkCall }) {
  const response = await send(call)
  if (!response.ok || response.result.op !== 'createItem') throw new Error(`createItem 실패: ${JSON.stringify(response)}`)
  return response.result.item
}

describe('C2 — 숫자 position 응답에서 만들기 끝까지 (K15 미달 5경로 모양)', () => {
  it('ⓐ 체크포인트 아래 task(행 77 「+ 자식 추가」) — ok, rank = 응답 숫자의 글자', async () => {
    const { send, createdPositions } = await setup()
    const item = await created({ send, call: { op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: FIXTURE_IDS.checkpoint, kindKey: 'task', title: '자식 추가' } })
    expect(createdPositions).toHaveLength(1)
    expect(typeof createdPositions[0]).toBe('number')
    expect(item).toMatchObject({ title: '자식 추가', parentId: FIXTURE_IDS.checkpoint, rank: String(createdPositions[0]) })
  })

  it('ⓑ 프로젝트 직속 task · 본문·우선순위·상태 지정(행 93 만들기 모달) — ok', async () => {
    const { send, createdPositions } = await setup()
    const item = await created({ send, call: { op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'task', title: '모달', body: '본문 **굵게**', priority: 'high', statusKey: FIXTURE_STATUS.analysis, placement: 'backlog' } })
    expect(typeof createdPositions[0]).toBe('number')
    expect(item).toMatchObject({ title: '모달', body: '본문 **굵게**', priority: 'high', statusKey: FIXTURE_STATUS.analysis, placement: 'backlog', parentId: null, rank: String(createdPositions[0]) })
  })

  it('ⓒ 연속 2건(행 95 「하나 더」) — 둘 다 ok, 각자 응답 숫자', async () => {
    const { send, createdPositions } = await setup()
    const first = await created({ send, call: { op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'task', title: '하나', placement: 'board' } })
    const second = await created({ send, call: { op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'task', title: '하나 더', placement: 'board' } })
    expect(createdPositions.map((value) => typeof value)).toEqual(['number', 'number'])
    expect([first.rank, second.rank]).toEqual(createdPositions.map(String))
    expect(first.id).not.toBe(second.id)
  })

  it('ⓓ 상태 지정 task(행 97 칸 「+ 추가」) — ok, 그 상태로 만들어진다', async () => {
    const { send, createdPositions } = await setup()
    const item = await created({ send, call: { op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'task', title: '칸 추가', statusKey: FIXTURE_STATUS.analysis, placement: 'board' } })
    expect(typeof createdPositions[0]).toBe('number')
    expect(item).toMatchObject({ statusKey: FIXTURE_STATUS.analysis, rank: String(createdPositions[0]) })
  })

  it('ⓔ bug · onBoard 없음(행 98) — ok', async () => {
    const { fixture, send, createdPositions } = await setup()
    const item = await created({ send, call: { op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'bug', title: '버그' } })
    expect(fixture.createArgs.at(-1)).not.toHaveProperty('onBoard')
    expect(typeof createdPositions[0]).toBe('number')
    expect(item).toMatchObject({ kind: { key: 'bug' }, rank: String(createdPositions[0]) })
  })

  it('재조회 실패 갈래 — issue_get 이 끊겨도 생성 응답(숫자 position)만으로 작업을 만든다(toItem)', async () => {
    const { fixture, send, createdPositions } = await setup()
    fixture.toolFaults.set('issue_get', { kind: 'drop' })
    const item = await created({ send, call: { op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'task', title: '재조회 끊김', placement: 'board' } })
    expect(typeof createdPositions[0]).toBe('number')
    expect(item).toMatchObject({ title: '재조회 끊김', rank: String(createdPositions[0]), relations: [] })
  })

  it('checkpoint 만들기 — 응답 position null 그대로 ok, rank null', async () => {
    const { send, createdPositions } = await setup()
    const item = await created({ send, call: { op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'checkpoint', title: '체크포인트' } })
    expect(createdPositions).toEqual([null])
    expect(item.rank).toBeNull()
  })

  it('저장된 행은 글자 — 만든 뒤 재조회(issue_get) 의 position 은 글자, 생성 응답 숫자와 같은 값', async () => {
    const { fixture, send, createdPositions } = await setup()
    const item = await created({ send, call: { op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'task', title: '저장 행', placement: 'board' } })
    const stored = fixture.issues.find((issue) => issue.id === item.id)
    expect(stored?.position).toBe(String(createdPositions[0]))
  })
})

describe('C1 거절 갈래 — 생성 응답 position 이 받지 않는 값이면 「만들어졌을 수 있음」(r1 S1-1)', () => {
  /** `issue_create` 응답 본문의 숫자 position 을 `bad` 로 바꿔 돌려주는 fetch — 바꾼 횟수를 센다(가짜 대조 방지). */
  async function setupRewriting(bad: string) {
    const fixture = new LaMcpFixture()
    fixture.tokens.set(FAKE_LA_TOKEN, 'write')
    const url = await fixture.start()
    stops.push(() => fixture.stop())
    const state = { rewrites: 0 }
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await fetch(input, init)
      if (typeof init?.body !== 'string' || !init.body.includes('"name":"issue_create"')) return response
      const text = await response.text()
      const rewritten = text.replace(/\\"position\\":\d+/g, () => {
        state.rewrites += 1
        return `\\"position\\":${bad}`
      })
      return new Response(rewritten, { status: response.status, headers: response.headers })
    }
    const harness = workHarness({ entries: [laSourceEntry({ url, clientVersion: 'test', fetchImpl })] })
    const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const send = (call: WorkCall): Promise<WorkResponse> => harness.service.request({ requestId: `x-${++seq}`, connectionId: added.connection.id, call })
    return { fixture, send, state }
  }

  it.each([['소수', '1.5'], ['음수', '-1'], ['불리언', 'true'], ['안전 정수 밖', '1e21']])('%s %s → invalid_response · maybeApplied · issue_create 1회(재전송 0)', async (_label, bad) => {
    const { fixture, send, state } = await setupRewriting(bad)
    const response = await send({ op: 'createItem', spaceKey: FIXTURE_IDS.corral, parentId: null, kindKey: 'task', title: '거절 값', placement: 'board' })
    expect(state.rewrites).toBe(1)
    expect(response).toMatchObject({ ok: false, error: { kind: 'invalid_response', maybeApplied: true } })
    if (response.ok) throw new Error('ok 이면 안 된다')
    expect(response.error.message).toContain('issue_create.position')
    expect(fixture.createArgs).toHaveLength(1)
    expect(fixture.requests.filter((request) => request.tool === 'issue_create')).toHaveLength(1)
  })
})
