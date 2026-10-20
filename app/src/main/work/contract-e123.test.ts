// LIFE-601 C12 — 계약 확장 E1(막은 쪽 참조)·E2(키로 찾기)의 LA 응답 형태 검증 양성 대조 + 모의 출처 토큰 행동.
// 새 칸이 어긋나면 main 이 `invalid_response` 로 막아야 한다 — 화면이 깨진 키·id 를 받지 않는다.
import { afterEach, describe, expect, it } from 'vitest'
import { FIXTURE_IDS } from './la-mcp-fixture.js'
import { LaShapeError, readBySeq } from './la-shape.js'
import { mockBehaviorOf, mockSourceEntry, seedMockDemoState } from './mock-source.js'
import { FAKE_LA_TOKEN, laFixtureHarness, workHarness } from './test-kit.js'

describe('LA 새 칸 형태 검증 (E1·E2)', () => {
  let stop: (() => Promise<void>) | null = null
  afterEach(async () => {
    await stop?.()
    stop = null
  })

  const connect = async () => {
    const harness = await laFixtureHarness()
    stop = () => harness.fixture.stop()
    const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    // 막힘 하나 — LIFE-600 이 LIFE-601 을 막는다(열림).
    harness.fixture.links.push({ id: 'link-e1', from: FIXTURE_IDS.task601, to: FIXTURE_IDS.task600, relation: 'is_blocked_by' })
    return { harness, connectionId: added.connection.id }
  }

  it('평시 — 목록 행이 막은 쪽 키를 싣는다(E1)', async () => {
    const { harness, connectionId } = await connect()
    const response = await harness.service.request({ requestId: 'r1', connectionId, call: { op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null } })
    if (!response.ok || response.result.op !== 'listItems') throw new Error('list')
    const row = response.result.items.find((item) => item.id === FIXTURE_IDS.task601)
    expect(row?.openBlockers).toEqual([{ id: FIXTURE_IDS.task600, key: 'LIFE-600', title: '작업 계약·연결·LA provider' }])
    expect(row?.openBlockerCount).toBe(1)
  })

  it('양성 대조 — 막은 쪽 displayId 가 빠지면 invalid_response (빈 목록으로 보이지 않는다)', async () => {
    const { harness, connectionId } = await connect()
    harness.fixture.corrupt = 'blocker-no-displayId'
    const response = await harness.service.request({ requestId: 'r2', connectionId, call: { op: 'listItems', spaceKey: FIXTURE_IDS.corral, cursor: null } })
    expect(response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
  })

  it('평시 — 키로 찾기는 보관 아닌 작업을 스페이스 키와 함께, project·없는 seq 는 null(E2)', async () => {
    const { harness, connectionId } = await connect()
    const send = (key: string) => harness.service.request({ requestId: `k-${key}`, connectionId, call: { op: 'findByKey', key } })
    expect(await send('LIFE-601')).toMatchObject({ ok: true, result: { op: 'findByKey', item: { id: FIXTURE_IDS.task601, spaceKey: FIXTURE_IDS.corral } } })
    expect(await send('LIFE-337')).toMatchObject({ ok: true, result: { op: 'findByKey', item: null } })
    expect(await send('LIFE-424242')).toMatchObject({ ok: true, result: { op: 'findByKey', item: null } })
  })

  it('양성 대조 — issue_by_seq 의 data.id 가 글자가 아니면 invalid_response', async () => {
    const { harness, connectionId } = await connect()
    harness.fixture.corrupt = 'byseq-bad-id'
    const response = await harness.service.request({ requestId: 'r3', connectionId, call: { op: 'findByKey', key: 'LIFE-601' } })
    expect(response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
  })
})

describe('모의 출처 — 격리 실행 행동(토큰 글자)', () => {
  it('fault·delay 를 읽는다', () => {
    expect(mockBehaviorOf('mock_plain')).toEqual({ fault: null, delayMs: 0, rejectWrites: false, flip: null, caps: {}, drift: false, createMeta: 'plain', createLost: false })
    expect(mockBehaviorOf('mock_fault-forbidden_delay-300')).toEqual({ fault: 'forbidden', delayMs: 300, rejectWrites: false, flip: null, caps: {}, drift: false, createMeta: 'plain', createLost: false })
    expect(mockBehaviorOf('mock_reject-writes_flip-80')).toEqual({ fault: null, delayMs: 0, rejectWrites: true, flip: { mode: 'deliver', ms: 80 }, caps: {}, drift: false, createMeta: 'plain', createLost: false })
    expect(mockBehaviorOf('mock_flipapply-80').flip).toEqual({ mode: 'apply', ms: 80 })
    expect(mockBehaviorOf('mock_cap-order-off_cap-placement-hide_transition-any').caps).toEqual({
      order: { state: 'disabled', reason: '모의 출처가 이 능력을 껐습니다 (cap-order-off).' }, placement: { state: 'hidden' }, transition: { mode: 'any' },
    })
  })

  it('reject-writes — 쓰기 3종은 rejected, 읽기는 그대로(원위치 양성 대조, R1-T)', async () => {
    const harness = workHarness({ entries: [mockSourceEntry({ state: seedMockDemoState() })] })
    const added = await harness.service.addConnection({ sourceId: 'mock-jira', token: 'mock_reject-writes', replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const connectionId = added.connection.id
    const list = await harness.service.request({ requestId: 'l', connectionId, call: { op: 'listItems', spaceKey: 'CORE', cursor: null } })
    expect(list.ok).toBe(true)
    const write = await harness.service.request({ requestId: 'w', connectionId, call: { op: 'setPlacement', itemId: 'm-1', placement: 'backlog', ifVersion: null } })
    expect(write).toMatchObject({ ok: false, error: { kind: 'rejected' } })
  })

  it('cap 토큰 — 연결의 능력 표가 그 상태로 선다(on/disabled/hidden 분기 양성 대조, R1-T)', async () => {
    const harness = workHarness({ entries: [mockSourceEntry({ state: seedMockDemoState() })] })
    const added = await harness.service.addConnection({ sourceId: 'mock-jira', token: 'mock_cap-placement-off', replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    expect(added.connection.capabilities?.placement).toEqual({ state: 'disabled', reason: '모의 출처가 이 능력을 껐습니다 (cap-placement-off).' })
    const write = await harness.service.request({ requestId: 'w', connectionId: added.connection.id, call: { op: 'setPlacement', itemId: 'm-1', placement: 'backlog', ifVersion: null } })
    expect(write.ok).toBe(false)
  })

  it('flip — 홀수 번째 요청만 늦어 뒤에 보낸 요청이 먼저 답한다(응답 순서 뒤집기, R1-T)', async () => {
    const harness = workHarness({ entries: [mockSourceEntry({ state: seedMockDemoState() })] })
    const added = await harness.service.addConnection({ sourceId: 'mock-jira', token: 'mock_flip-60', replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const connectionId = added.connection.id
    const order: string[] = []
    const ask = (id: string) => harness.service.request({ requestId: id, connectionId, call: { op: 'listStatuses', spaceKey: 'CORE' } }).then(() => { order.push(id) })
    // 연결 추가가 1회(listSpaces) 썼으므로 다음은 2(즉시)·3(늦음)·4(즉시) — 먼저 보낸 b 가 나중에 보낸 c 보다 늦게 답한다.
    await Promise.all([ask('a'), ask('b'), ask('c')])
    expect(order).toEqual(['a', 'c', 'b'])
  })

  // R2-O — 배달 뒤집기(flip)와 적용 뒤집기(flipapply)는 서버 값이 다르다. 경합 관문은 이 서버 재조회 값까지 기대에 넣는다.
  for (const { token, server } of [{ token: 'mock_flip-60', server: 'board' }, { token: 'mock_flipapply-60', server: 'backlog' }]) {
    it(`${token} — 응답은 뒤집혀 오고, 서버 값은 ${server}`, async () => {
      const harness = workHarness({ entries: [mockSourceEntry({ state: seedMockDemoState() })] })
      const added = await harness.service.addConnection({ sourceId: 'mock-jira', token, replaceId: null })
      if (!added.ok) throw new Error(added.error.message)
      const connectionId = added.connection.id
      await harness.service.request({ requestId: 'even', connectionId, call: { op: 'getItem', itemId: 'm-2' } })
      const order: string[] = []
      const write = ({ id, placement }: { id: string; placement: 'board' | 'backlog' }) =>
        harness.service.request({ requestId: id, connectionId, call: { op: 'setPlacement', itemId: 'm-2', placement, ifVersion: null } }).then(() => { order.push(id) })
      // 3번째(늦음) = backlog, 4번째(즉시) = board.
      await Promise.all([write({ id: 'a-backlog', placement: 'backlog' }), write({ id: 'b-board', placement: 'board' })])
      expect(order).toEqual(['b-board', 'a-backlog'])
      const after = await harness.service.request({ requestId: 'after', connectionId, call: { op: 'getItem', itemId: 'm-2' } })
      expect(after).toMatchObject({ ok: true, result: { op: 'getItem', item: { placement: server } } })
    })
  }

  it('transition-any — 능력 표만이 아니라 출처도 허용 목록 밖 전이를 받는다(R2-N) · 대조: 기본(allowed)은 거절', async () => {
    const outcomes: boolean[] = []
    for (const token of ['mock_plain', 'mock_transition-any']) {
      const harness = workHarness({ entries: [mockSourceEntry({ state: seedMockDemoState() })] })
      const added = await harness.service.addConnection({ sourceId: 'mock-jira', token, replaceId: null })
      if (!added.ok) throw new Error(added.error.message)
      const response = await harness.service.request({ requestId: 'any', connectionId: added.connection.id, call: { op: 'changeStatus', itemId: 'm-2', statusKey: 'core-done', ifVersion: null } })
      outcomes.push(response.ok)
    }
    expect(outcomes).toEqual([false, true])
  })

  it('fault 토큰이면 목록이 그 오류 — 스페이스 목록(연결 테스트)은 통과한다', async () => {
    const harness = workHarness({ entries: [mockSourceEntry({ state: seedMockDemoState() })] })
    const added = await harness.service.addConnection({ sourceId: 'mock-jira', token: 'mock_fault-network', replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const response = await harness.service.request({ requestId: 'f1', connectionId: added.connection.id, call: { op: 'listItems', spaceKey: 'CORE', cursor: null } })
    expect(response).toMatchObject({ ok: false, error: { kind: 'network' } })
  })

  it('데모 씨앗 — 칸 없는 상태의 작업이 목록에 있고 상태 목록에는 없다(점선 칸 재현)', async () => {
    const harness = workHarness({ entries: [mockSourceEntry({ state: seedMockDemoState() })] })
    const added = await harness.service.addConnection({ sourceId: 'mock-jira', token: 'mock_demo', replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const connectionId = added.connection.id
    const statuses = await harness.service.request({ requestId: 's', connectionId, call: { op: 'listStatuses', spaceKey: 'CORE' } })
    if (!statuses.ok || statuses.result.op !== 'listStatuses') throw new Error('statuses')
    const keys = statuses.result.statuses.map((status) => status.key)
    const items: string[] = []
    let cursor: string | null = null
    do {
      const page = await harness.service.request({ requestId: `p${items.length}`, connectionId, call: { op: 'listItems', spaceKey: 'CORE', cursor } })
      if (!page.ok || page.result.op !== 'listItems') throw new Error('page')
      items.push(...page.result.items.map((item) => item.statusKey))
      cursor = page.result.nextCursor
    } while (cursor !== null)
    expect(items).toContain('core-legal')
    expect(keys).not.toContain('core-legal')
  })
})

describe('R1-P issue_by_seq 판별자 검증 — 모르는 kind·모순된 null 은 「없음」 이 아니라 형태 오류', () => {
  it('작업 3종은 id · project·goal 은 null(정상 제외) · 없음은 {kind:null,data:null}', () => {
    expect(readBySeq({ kind: 'task', data: { id: 'x' } }, 'r')).toBe('x')
    expect(readBySeq({ kind: 'project', data: { id: 'p' } }, 'r')).toBeNull()
    expect(readBySeq({ kind: 'goal', data: { id: 'g' } }, 'r')).toBeNull()
    expect(readBySeq({ kind: null, data: null }, 'r')).toBeNull()
  })
  it('모르는 kind · kind null 인데 data 있음 · 제외 kind 인데 data 가 레코드 아님 → LaShapeError', () => {
    expect(() => readBySeq({ kind: 'unexpected-kind', data: { id: 'x' } }, 'r')).toThrow(LaShapeError)
    expect(() => readBySeq({ kind: null, data: { id: 'x' } }, 'r')).toThrow(LaShapeError)
    expect(() => readBySeq({ kind: 'project', data: null }, 'r')).toThrow(LaShapeError)
  })
  it('양성 대조(서비스 경로) — 픽스처가 모르는 kind·모순된 null 을 주면 invalid_response', async () => {
    const harness = await laFixtureHarness()
    try {
      const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
      if (!added.ok) throw new Error(added.error.message)
      const corrupts: ('byseq-unknown-kind' | 'byseq-null-kind-data')[] = ['byseq-unknown-kind', 'byseq-null-kind-data']
      for (const corrupt of corrupts) {
        harness.fixture.corrupt = corrupt
        const response = await harness.service.request({ requestId: `p-${corrupt}`, connectionId: added.connection.id, call: { op: 'findByKey', key: corrupt === 'byseq-unknown-kind' ? 'LIFE-601' : 'LIFE-424242' } })
        expect(response).toMatchObject({ ok: false, error: { kind: 'invalid_response' } })
      }
    } finally {
      await harness.fixture.stop()
    }
  })
})
