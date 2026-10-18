// LIFE-638 L1c — LA 정규 스페이스 목록의 커서 쪽(C1) · 쪽을 이어 붙인 결과 = 수정 전 BFS 결과(C2) · 「미분류」·낡은 커서(C3) · 목록 순회 상한(C8).
// 실제 경로: `WorkService.request` → `LaSource` → `McpHttpClient` → `LaMcpFixture`(127.0.0.1 HTTP, 가짜 토큰). C2 기준 원자료는 수정 전 commit 에서
// `la-paging.capture.test.ts` 로 뜬 `specs/LIFE-638-la-cursor-activity/raw/claude/c2-before-bfs.json`.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkItem, WorkResponse } from '../../shared/work.js'
import { FIXTURE_IDS, FIXTURE_RETIRED_SPACE_KEYS } from './la-mcp-fixture.js'
import { pagingSeed } from './la-paging-seed.js'
import { LA_CAPABILITIES, LA_CATCH_ALL_KEY } from './la-source.js'
import { readList, LaShapeError } from './la-shape.js'
import { McpHttpClient } from './mcp-http.js'
import { FAKE_LA_TOKEN, laFixtureHarness } from './test-kit.js'

type Harness = Awaited<ReturnType<typeof laFixtureHarness>>
type Row = Pick<WorkItem, 'id' | 'key' | 'parentId' | 'spaceKey'>
type Capture = Record<'default' | 'paging', Record<string, { pages: number; truncated: boolean; items: Row[] }>>

const BEFORE: Capture = JSON.parse(readFileSync(new URL('../../../../specs/LIFE-638-la-cursor-activity/raw/claude/c2-before-bfs.json', import.meta.url), 'utf8'))

const opened: Harness[] = []
afterEach(async () => {
  for (const harness of opened.splice(0)) await harness.fixture.stop()
})

async function connect({ pageSize, seed = 'default' }: { pageSize?: number; seed?: 'default' | 'paging' } = {}): Promise<{ harness: Harness; send: (call: WorkCall) => Promise<WorkResponse> }> {
  const harness = await laFixtureHarness({ pageSize })
  opened.push(harness)
  if (seed === 'paging') harness.fixture.issues = pagingSeed(harness.fixture.issues)
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  let n = 0
  return { harness, send: (call) => harness.service.request({ requestId: `p-${++n}`, connectionId: added.connection.id, call }) }
}

async function page({ send, spaceKey, cursor }: { send: (call: WorkCall) => Promise<WorkResponse>; spaceKey: string; cursor: string | null }): Promise<{ items: WorkItem[]; nextCursor: string | null; truncated: boolean }> {
  const response = await send({ op: 'listItems', spaceKey, cursor })
  if (!response.ok) throw new Error(`${response.error.kind} ${response.error.message}`)
  if (response.result.op !== 'listItems') throw new Error(response.result.op)
  return response.result
}

/** 커서를 끝까지 — 쪽마다 받은 행 수와 그 쪽에 든 도구 호출 수를 같이 돌려준다. */
async function listAll({ harness, send, spaceKey }: { harness: Harness; send: (call: WorkCall) => Promise<WorkResponse>; spaceKey: string }): Promise<{ rows: Row[]; pages: { items: number; calls: number }[]; truncated: boolean }> {
  const rows: Row[] = []
  const pages: { items: number; calls: number }[] = []
  let cursor: string | null = null
  let truncated = false
  for (let index = 0; index < 200; index += 1) {
    const before = harness.fixture.toolCalls.length
    const got = await page({ send, spaceKey, cursor })
    pages.push({ items: got.items.length, calls: harness.fixture.toolCalls.length - before })
    rows.push(...got.items.map(({ id, key, parentId, spaceKey: space }) => ({ id, key, parentId, spaceKey: space })))
    truncated ||= got.truncated
    cursor = got.nextCursor
    if (cursor === null) return { rows: rows.sort((a, b) => a.id.localeCompare(b.id)), pages, truncated }
  }
  throw new Error('끝나지 않음')
}

const spaceKeys = (seed: 'default' | 'paging'): string[] => Object.keys(BEFORE[seed])

describe('C1 목록 커서 쪽', () => {
  it('능력 켜짐 · 첫 쪽 호출 = issue_list({rootId, archived:all, paginate, limit}) · parentId 깊이 탐색 0 · 다음 쪽 = 받은 커서 그대로', async () => {
    expect(LA_CAPABILITIES.cursorPaging.state).toBe('on')
    const { harness, send } = await connect({ pageSize: 2 })
    const start = harness.fixture.toolCalls.length
    const first = await page({ send, spaceKey: FIXTURE_IDS.corral, cursor: null })
    const second = await page({ send, spaceKey: FIXTURE_IDS.corral, cursor: first.nextCursor })
    const lists = harness.fixture.toolCalls.slice(start).filter((call) => call.tool === 'issue_list')
    const main = lists.filter((call) => call.args.kind === undefined)
    expect(main.map((call) => call.args)).toEqual([
      { rootId: FIXTURE_IDS.corral, archived: 'all', paginate: true, limit: 2 },
      { rootId: FIXTURE_IDS.corral, archived: 'all', paginate: true, limit: 2, cursor: first.nextCursor },
    ])
    // 구조(표시 부모 사슬) = 같은 루트의 checkpoint·bug, 보관 포함 — 이것도 rootId 다.
    expect(lists.filter((call) => call.args.kind !== undefined).every((call) => call.args.rootId === FIXTURE_IDS.corral && call.args.archived === 'all' && call.args.paginate === true)).toBe(true)
    expect(lists.some((call) => call.args.parentId !== undefined)).toBe(false)
    expect(first.items).toHaveLength(2)
    expect(typeof first.nextCursor).toBe('string')
    expect(first.truncated).toBe(false)
    expect(second.items.map((item) => item.id)).not.toEqual(first.items.map((item) => item.id))
  })

  it('끝 = nextCursor null · 첫 쪽부터 끝까지 seq 내림차순 쪽 · 정규 스페이스 truncated 는 늘 false', async () => {
    const { harness, send } = await connect({ pageSize: 3 })
    const all = await listAll({ harness, send, spaceKey: FIXTURE_IDS.corral })
    expect(all.pages.length).toBeGreaterThan(1)
    expect(all.truncated).toBe(false)
    expect(all.pages.at(-1)?.items).toBeGreaterThan(0)
  })

  it('커서는 LA 값 그대로 — 다른 값(고친 커서 · 새로 만든 커서)을 넣으면 fixture 가 거절한다(낡은 위치)', async () => {
    const { send } = await connect({ pageSize: 2 })
    const first = await page({ send, spaceKey: FIXTURE_IDS.corral, cursor: null })
    const forged = Buffer.from(JSON.stringify({ seq: 600 }), 'utf8').toString('base64url')
    for (const cursor of [`${first.nextCursor}x`, forged]) {
      const response = await send({ op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor })
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error.kind).toBe('rejected')
    }
    // 양성 대조 — 받은 커서 그대로면 통과.
    expect((await send({ op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: first.nextCursor })).ok).toBe(true)
  })

  it.each([
    ['page-cursor-number'], ['page-cursor-empty'], ['page-cursor-missing'], ['page-items-object'], ['list-drop-version'], ['list-bad-blocker'],
  ] as const)('응답 검증(D11) — %s 면 invalid_response', async (corrupt) => {
    const { harness, send } = await connect({ pageSize: 2 })
    // 양성 대조: 깨기 전에는 통과.
    expect((await send({ op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null })).ok).toBe(true)
    harness.fixture.corrupt = corrupt
    const response = await send({ op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null })
    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.kind).toBe('invalid_response')
  })

  it('배열 응답 경로 무회귀 — 한 번에 받는 자리(스페이스·미분류·자식)는 배열 · 감싼 모양에 다음 쪽이 있으면 조용히 버리지 않고 어긋남', async () => {
    expect(readList([1, 2], 'x')).toEqual([1, 2])
    expect(readList({ items: [1] }, 'x')).toEqual([1])
    expect(readList({ items: [1], nextCursor: null }, 'x')).toEqual([1])
    expect(() => readList({ items: [1], nextCursor: 'more' }, 'x')).toThrow(LaShapeError)
    const { harness, send } = await connect()
    const start = harness.fixture.toolCalls.length
    const spaces = await send({ op: 'listSpaces' })
    expect(spaces.ok).toBe(true)
    const children = await send({ op: 'listChildren', itemId: FIXTURE_IDS.checkpoint })
    expect(children.ok).toBe(true)
    const arrays = harness.fixture.toolCalls.slice(start).filter((call) => call.tool === 'issue_list')
    expect(arrays.length).toBeGreaterThan(0)
    expect(arrays.every((call) => call.args.paginate === undefined && call.args.cursor === undefined && call.args.rootId === undefined)).toBe(true)
  })

  it('fixture 가 LA 610 의미를 따른다 — seq 내림차순 · 같은 필터 + cursor · 커서에 필터 없음 · 자손은 보관·종류 무관하게 내려감 · 비커서 = 배열', async () => {
    const { harness } = await connect()
    const mcp = new McpHttpClient({ url: harness.url, token: FAKE_LA_TOKEN, clientVersion: 'test' })
    const call = async (args: Record<string, unknown>): Promise<unknown> => {
      const outcome = await mcp.callTool({ name: 'issue_list', args })
      if (!outcome.ok) throw new Error(outcome.error.message)
      return outcome.value
    }
    const seqOf = (value: unknown): number[] => (Array.isArray(value) ? value : Reflect.get(Object(value), 'items')).map((row: { sequentialId: number }) => row.sequentialId)
    const first = await call({ rootId: FIXTURE_IDS.corral, archived: 'all', paginate: true, limit: 3 })
    const next = Reflect.get(Object(first), 'nextCursor')
    expect(typeof next).toBe('string')
    // 커서 안에는 seq 하나뿐 — 필터가 들어 있지 않다.
    expect(Object.keys(JSON.parse(Buffer.from(String(next), 'base64url').toString('utf8')))).toEqual(['seq'])
    const second = await call({ rootId: FIXTURE_IDS.corral, archived: 'all', paginate: true, limit: 3, cursor: next })
    const seqs = [...seqOf(first), ...seqOf(second)]
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a))
    // 보관된 checkpoint(373) 아래 미보관 task(604)가 자손으로 나온다 · 보관 행은 archived 필터로만 갈린다 · 루트 자신은 없다.
    const all = seqOf(await call({ rootId: FIXTURE_IDS.corral, archived: 'all', paginate: true, limit: 200 }))
    expect(all).toContain(604)
    expect(all).toContain(373)
    expect(all).not.toContain(337)
    const live = seqOf(await call({ rootId: FIXTURE_IDS.corral, archived: 'exclude', paginate: true, limit: 200 }))
    expect(live).toContain(604)
    expect(live).not.toContain(373)
    // 비커서 = 배열 그대로(rootId 만 줘도 배열).
    expect(Array.isArray(await call({ rootId: FIXTURE_IDS.corral, archived: 'all' }))).toBe(true)
    const both = await mcp.callTool({ name: 'issue_list', args: { rootId: FIXTURE_IDS.corral, parentId: FIXTURE_IDS.corral } })
    expect(both.ok).toBe(false)
    mcp.close()
  })
})

describe('C2 쪽을 이어 붙인 결과 = 수정 전 BFS 결과', () => {
  it.each([1, 2, 200])('쪽 크기 %i — 두 씨앗 · 모든 스페이스의 작업 집합·parentId·spaceKey 가 수정 전 원자료와 같다', async (pageSize) => {
    for (const seed of ['default', 'paging'] as const) {
      const { harness, send } = await connect({ pageSize, seed })
      for (const spaceKey of spaceKeys(seed)) {
        const all = await listAll({ harness, send, spaceKey })
        expect({ seed, spaceKey, rows: all.rows }).toEqual({ seed, spaceKey, rows: BEFORE[seed][spaceKey]?.items })
      }
    }
  })

  it('원자료가 C2 의 까다로운 경우를 담고 있다 — 부모가 뒤 쪽 · 보관 checkpoint·bug 아래 task · 보관 작업 행 0 · 3단', () => {
    const rows = BEFORE.paging[FIXTURE_IDS.corral]?.items ?? []
    const parentOf = (key: string): string | null | undefined => rows.find((row) => row.key === key)?.parentId
    expect(parentOf('LIFE-703')).toBe('00000000-0000-4000-8000-000000000702') // 보관 checkpoint → 미보관 bug → task (3단)
    expect(parentOf('LIFE-702')).toBeNull() // 보관 checkpoint 아래 bug = 스페이스 바로 아래
    expect(parentOf('LIFE-705')).toBe(FIXTURE_IDS.checkpoint) // 미보관 checkpoint → 보관 bug → task = 가장 가까운 미보관 조상
    expect(parentOf('LIFE-707')).toBeNull() // 스페이스 → 보관 bug → task
    expect(parentOf('LIFE-711')).toBe('00000000-0000-4000-8000-000000000710') // checkpoint → bug → task, 부모(710)가 자식(711)보다 뒤 쪽
    expect(rows.some((row) => row.key === 'LIFE-709' || row.key === 'LIFE-701' || row.key === 'LIFE-499')).toBe(false) // 보관 작업 자신은 행 0
  })

  it('쪽 하나의 RPC 수 — 쪽 크기 1 과 5 에서 같은 상한(작업 수에 비례하지 않음)', async () => {
    const counts: Record<number, number[]> = {}
    for (const pageSize of [1, 5]) {
      const { harness, send } = await connect({ pageSize, seed: 'paging' })
      const all = await listAll({ harness, send, spaceKey: FIXTURE_IDS.corral })
      counts[pageSize] = all.pages.map((entry) => entry.calls)
    }
    // 쪽마다 = 스페이스 확인 1 + 쪽 1 + 구조(checkpoint·bug) 각 1쪽 = 4. 쪽 크기를 다섯 배로 늘려도 쪽당 수는 그대로다.
    expect(new Set(counts[1])).toEqual(new Set([4]))
    expect(new Set(counts[5])).toEqual(new Set([4]))
    expect((counts[1] ?? []).length).toBeGreaterThan((counts[5] ?? []).length)
  })
})

describe('C3 「미분류」·낡은 커서', () => {
  it('「미분류」 는 지금 그대로 — 한 번에 · 호출 모양(종류별 배열 4번) 무변경 · 커서가 오면 첫 쪽을 다시 주지 않고 거절(요청 0)', async () => {
    const { harness, send } = await connect({ pageSize: 1 })
    const start = harness.fixture.toolCalls.length
    const all = await page({ send, spaceKey: LA_CATCH_ALL_KEY, cursor: null })
    expect(all.nextCursor).toBeNull()
    expect(all.items.map((item) => item.id).sort()).toEqual(BEFORE.default[LA_CATCH_ALL_KEY]?.items.map((row) => row.id))
    expect(harness.fixture.toolCalls.slice(start).map((call) => call.args)).toEqual(['project', 'checkpoint', 'task', 'bug'].map((kind) => ({ archived: 'all', limit: 200, kind })))
    const before = harness.fixture.toolCalls.length
    const cursor = await send({ op: 'listItems', spaceKey: LA_CATCH_ALL_KEY, cursor: 'anything' })
    expect(cursor.ok).toBe(false)
    if (!cursor.ok) expect(cursor.error.kind).toBe('rejected')
    expect(harness.fixture.toolCalls.length).toBe(before)
  })

  it('「미분류」 상한 truncated 무회귀 — 한 종류가 200 이상이면 truncated', async () => {
    const { harness, send } = await connect()
    const template = harness.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.orphanBug)
    if (template === undefined) throw new Error('씨앗')
    for (let n = 0; n < 200; n += 1) harness.fixture.issues.push({ ...template, id: `00000000-0000-4000-8000-${String(90000 + n).padStart(12, '0')}`, sequentialId: 90000 + n })
    expect((await page({ send, spaceKey: LA_CATCH_ALL_KEY, cursor: null })).truncated).toBe(true)
  })

  it('LA `잘못된 cursor입니다.` = 연결 상태를 바꾸지 않는 rejected + 이쪽 말(원격 글 0) · auth·network 아님', async () => {
    const { harness, send } = await connect({ pageSize: 2 })
    const forged = Buffer.from(JSON.stringify({ seq: 1 }), 'utf8').toString('base64url')
    const response = await send({ op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: forged })
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.kind).toBe('rejected')
    expect(response.error.message).toBe('목록 위치가 낡았습니다 — 처음부터 새로 고치세요.')
    expect(response.error.message).not.toContain('잘못된 cursor')
    expect(harness.service.settings().connections[0]?.status).toBe('ok')
  })

  it('양성 대조 — 같은 거절의 글만 바꾸면 분류가 갈린다(다른 글 = 일반 거절 문구 · UNAUTHORIZED = auth)', async () => {
    const { harness, send } = await connect({ pageSize: 2 })
    const forged = Buffer.from(JSON.stringify({ seq: 1 }), 'utf8').toString('base64url')
    harness.fixture.invalidCursorText = 'cursor 를 읽지 못했습니다.'
    const other = await send({ op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: forged })
    expect(other.ok ? null : other.error.message).toBe('작업 출처가 요청을 거절했습니다.')
    harness.fixture.invalidCursorText = JSON.stringify({ code: 'UNAUTHORIZED', message: 'x' })
    const auth = await send({ op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: forged })
    expect(auth.ok ? null : auth.error.kind).toBe('auth')
  })

  it('옛 키(스페이스 아님) 거절 무회귀 — 첫 쪽·커서 쪽 모두 rejected, 그 키의 목록을 내지 않는다', async () => {
    const { harness, send } = await connect({ pageSize: 2 })
    for (const spaceKey of [...FIXTURE_RETIRED_SPACE_KEYS, FIXTURE_IDS.task600]) {
      const start = harness.fixture.toolCalls.length
      const response = await send({ op: 'listItems', spaceKey, cursor: null })
      expect(response.ok ? null : response.error.kind).toBe('rejected')
      expect(harness.fixture.toolCalls.slice(start).some((call) => call.tool === 'issue_list')).toBe(false)
    }
  })
})

describe('C8 목록 순회 상한', () => {
  it.each(['repeat', 'empty', 'endless'] as const)('본 목록 %s → 무한 순회 없이 invalid_response(조용히 끊어 성공으로 주지 않는다)', async (mode) => {
    const { harness, send } = await connect({ pageSize: 2 })
    harness.fixture.pagingFault = { tool: 'issue_list', mode, when: (args) => args.kind === undefined }
    let cursor: string | null = null
    let failure: WorkResponse | null = null
    for (let index = 0; index < 150 && failure === null; index += 1) {
      const response = await send({ op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor })
      if (!response.ok) failure = response
      else if (response.result.op === 'listItems') {
        cursor = response.result.nextCursor
        if (cursor === null) break
      }
    }
    expect(failure?.ok).toBe(false)
    if (failure !== null && !failure.ok) {
      expect(failure.error.kind).toBe('invalid_response')
      expect(failure.error.message).toContain('쪽이 끝나지 않습니다')
    }
  })

  it.each(['repeat', 'empty', 'endless'] as const)('구조 목록 %s → 그 쪽이 invalid_response', async (mode) => {
    const { harness, send } = await connect({ pageSize: 2 })
    const template = harness.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.checkpoint)
    if (template === undefined) throw new Error('씨앗')
    // 구조 쪽(200)이 둘 이상 되게 checkpoint 를 늘린다.
    for (let n = 0; n < 210; n += 1) harness.fixture.issues.push({ ...template, id: `00000000-0000-4000-8000-${String(91000 + n).padStart(12, '0')}`, sequentialId: 91000 + n })
    harness.fixture.pagingFault = { tool: 'issue_list', mode, when: (args) => args.kind === 'checkpoint' }
    const response = await send({ op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null })
    expect(response.ok ? null : response.error.kind).toBe('invalid_response')
  })

  it('양성 대조 — 고장이 없으면 같은 씨앗을 끝까지 받는다', async () => {
    const { harness, send } = await connect({ pageSize: 2 })
    const all = await listAll({ harness, send, spaceKey: FIXTURE_IDS.corral })
    expect(all.rows).toEqual(BEFORE.default[FIXTURE_IDS.corral]?.items)
  })
})
