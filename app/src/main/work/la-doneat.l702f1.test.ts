// LIFE-702 수정 r1 — F2(LA 모의 서버의 done 진입 시각 = 실제/주입 시계) · F3(done→done 이면 doneAt 불변 — 모의 출처·LA 모의 서버).
// F3 양성 대조: 리뷰어 변이 m7a(모의 `doneAtFor` 가 done→done 도 새 시각) · m7b(LA 모의 서버 `markDone` 이 done→done 도 새 시각).
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCall, WorkItem } from '../../shared/work.js'
import { FIXTURE_IDS, FIXTURE_STATUS } from './la-mcp-fixture.js'
import { mockSourceEntry, seedMockState } from './mock-source.js'
import { FAKE_LA_TOKEN, FAKE_MOCK_TOKEN, laFixtureHarness, workHarness, type WorkHarness } from './test-kit.js'

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

const OLD = '2026-10-01T03:04:05.000Z'
/** LA 모의 서버에 두 번째 done 상태(취소)를 더한다 — done→done 이동 무대. */
const CANCEL_STATUS = '00000000-0000-4000-8000-000000009005'

let seq = 0
async function changed({ harness, connectionId, call }: { harness: WorkHarness; connectionId: string; call: WorkCall }): Promise<WorkItem> {
  const response = await harness.service.request({ requestId: `f1-${++seq}`, connectionId, call })
  if (!response.ok) throw new Error(`${call.op}: ${response.error.kind} ${response.error.message}`)
  if (response.result.op !== 'changeStatus') throw new Error(response.result.op)
  return response.result.item
}

async function laConnected() {
  const harness = await laFixtureHarness()
  stops.push(() => harness.fixture.stop())
  harness.fixture.statuses.push({ id: CANCEL_STATUS, categoryKey: 'done', label: '취소', color: null, position: 1, isDefault: false })
  const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
  if (!added.ok) throw new Error(added.error.message)
  return { ...harness, connectionId: added.connection.id }
}

describe('F2 LA 모의 서버 — done 진입 시각은 실제 지금(또는 주입한 시계)', () => {
  it('기본 시계 — 씨앗 가짜 시계(2026-10-13·18)가 아니라 지금', async () => {
    const h = await laConnected()
    const before = Date.now()
    const item = await changed({ harness: h, connectionId: h.connectionId, call: { op: 'changeStatus', itemId: FIXTURE_IDS.task600, statusKey: FIXTURE_STATUS.done, ifVersion: null, resolution: 'completed' } })
    const at = Date.parse(item.doneAt ?? '')
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('주입한 시계를 쓴다 · updatedAt 규칙은 그대로', async () => {
    const h = await laConnected()
    h.fixture.doneClock = () => Date.parse('2030-01-02T03:04:05.000Z')
    const item = await changed({ harness: h, connectionId: h.connectionId, call: { op: 'changeStatus', itemId: FIXTURE_IDS.task600, statusKey: FIXTURE_STATUS.done, ifVersion: null, resolution: 'completed' } })
    expect(item.doneAt).toBe('2030-01-02T03:04:05.000Z')
    expect(item.updatedAt.startsWith('2026-10-13')).toBe(true)
  })
})

describe('F3 done→done — doneAt 불변', () => {
  it('LA 모의 서버 — 완료 → 취소(다른 done 상태)로 옮겨도 doneAt 그대로', async () => {
    const h = await laConnected()
    const doneBug = h.fixture.issues.find((issue) => issue.id === FIXTURE_IDS.doneBug)
    if (doneBug === undefined) throw new Error('doneBug')
    doneBug.doneAt = OLD
    const item = await changed({ harness: h, connectionId: h.connectionId, call: { op: 'changeStatus', itemId: FIXTURE_IDS.doneBug, statusKey: CANCEL_STATUS, ifVersion: null, resolution: 'cancelled' } })
    expect(item.statusKey).toBe(CANCEL_STATUS)
    expect(item.category).toBe('done')
    expect(item.doneAt).toBe(OLD)
  })

  it('모의 출처 — Done → Cancelled(다른 done 상태) · 같은 상태의 완료함 → 취소함 모두 doneAt 그대로', async () => {
    const state = seedMockState()
    const core = state.spaces.find((space) => space.space.key === 'CORE')
    if (core === undefined) throw new Error('CORE')
    core.statuses.push({ key: 'core-cancelled', label: 'Cancelled', category: 'done', order: 4, color: null })
    core.transitions['core-done'] = [...(core.transitions['core-done'] ?? []), 'core-cancelled']
    core.transitions['core-cancelled'] = ['core-done']
    // 계약 씨앗엔 완료 작업이 없어 CORE 작업 하나를 완료(옛 doneAt)로 심는다.
    const target = state.items.find((entry) => entry.spaceKey === 'CORE')
    if (target === undefined) throw new Error('CORE 작업 없음')
    Object.assign(target, { statusKey: 'core-done', resolution: 'completed', doneAt: OLD })
    const harness = workHarness({ entries: [mockSourceEntry({ state })] })
    const added = await harness.service.addConnection({ sourceId: 'mock-jira', token: FAKE_MOCK_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    const connectionId = added.connection.id
    const recolored = await changed({ harness, connectionId, call: { op: 'changeStatus', itemId: target.id, statusKey: 'core-done', ifVersion: null, resolution: 'cancelled' } })
    expect(recolored.resolution).toBe('cancelled')
    expect(recolored.doneAt).toBe(OLD)
    const moved = await changed({ harness, connectionId, call: { op: 'changeStatus', itemId: target.id, statusKey: 'core-cancelled', ifVersion: null } })
    expect(moved.statusKey).toBe('core-cancelled')
    expect(moved.doneAt).toBe(OLD)
  })
})
