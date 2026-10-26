// 작업 계약 테스트 묶음 (LIFE-600 C2) — **한 묶음**을 모든 출처가 통과해야 한다(LA = 모의 LA MCP 서버 상대, 모의 Jira 형).
// 요청은 main 의 `WorkService.request` 로 보낸다 — 손검증·능력 문·결과 대조까지 앱과 같은 길이다.
// 능력이 꺼진 연산은 건너뛰지 않는다: 꺼져 있으면 `unsupported` + 능력 표의 이유가 그대로 오는지 본다.
// 출처 이름으로 분기하지 않는다 — 묶음이 보는 것은 능력 표와 계약 모양뿐이다.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  WORK_CATEGORIES,
  type WorkCall,
  type WorkCapabilities,
  type WorkCapability,
  type WorkCapabilityName,
  type WorkCreateFieldValue,
  type WorkCreateMeta,
  type WorkItem,
  type WorkLink,
  type WorkLinkRecord,
  type WorkResponse,
  type WorkSpace,
  type WorkStatus,
} from '../../shared/work.js'
import type { WorkService } from './service.js'

export type ContractTarget = {
  service: WorkService
  connectionId: string
  close: () => Promise<void>
  /** 출처 픽스처가 아는 「목록에 보여야 할」 작업 id — 단건으로 연 스페이스의 목록에 각각 나와야 한다(조상이 보관·완료여도 — R1-A·R2-C). */
  visibleItems: string[]
  /** 스페이스가 아니게 된(완료·보관) 옛 스페이스 키 — 목록 요청은 거절(「스페이스 아님」)이어야 한다(R3-D). 없는 출처는 빈 배열. */
  retiredSpaceKeys: string[]
  /** 출처 키 모양에 맞지만 없는 키 — 키로 찾기(E2)는 오류가 아니라 null 이어야 한다(LIFE-601). */
  missingKey: string
  /** 다른 스페이스에 있는 작업 쌍(E9 · LIFE-602) — `itemId` 에서 `otherKey` 로 연결하면 상대의 스페이스가 `otherSpaceKey` 로 보여야 한다. */
  crossSpace: { itemId: string; otherKey: string; otherSpaceKey: string }
  /** 출처가 받은 요청 수(LIFE-603 C14 — 꺼진 능력은 요청 0). 셀 수 없는 출처는 없다. */
  sourceRequests?: () => number
  /**
   * 본문 왕복(LIFE-605 C6) — `exact` = 출처가 markdown 을 바이트 그대로 둔다(LA·모의, 기본). `canonical` = 출처 서식으로 바꿔 둔다(Jira ADF) —
   * 묶음은 정규형 본문(지원 표 안, CRLF·줄 끝 공백 없음)을 보내고 그 바이트가 그대로 돌아오는지 본다.
   */
  bodyRoundTrip?: 'exact' | 'canonical'
  /** 질의 검색(LIFE-605 C5) — 능력이 켜진 출처의 시험 질의: 맞는 질의와 그 결과 키 · 출처가 거부하는 질의와 텍스트로 찾히는 키. */
  querySearch?: { query: string; expectKey: string; badQuery: string; textHitKey: string }
  /**
   * 외부 본문 바꾸기(LIFE-623 C2) — 다른 편집기가 출처에서 본문을 바꾼 것처럼 픽스처를 직접 고친다. `null` = 출처가 주는 빈 본문(LA `description:null` ·
   * Jira description null · 모의 `body:null`), `''` = 빈 글, 그 밖 = 글. 묶음은 그 뒤 쓰기 결과의 본문·연결이 직후 단건과 같은지 본다.
   * 돌려주는 함수는 픽스처 본문을 바꾸기 전 원래 값(출처 서식 그대로 — Jira ADF)으로 되돌린다.
   */
  externalBody: ({ itemId, body }: { itemId: string; body: string | null }) => () => void
  /**
   * 다른 곳(폰·웹·다른 Mac)이 남긴 작업 링크를 출처에 직접 심는다(LIFE-635) — `workLinkStore` 가 켜진 출처는 있어야 한다(없으면 그 시험이 실패한다).
   * 꺼진 출처(Jira)는 없어도 된다.
   */
  plantWorkLink?: (input: { itemId: string; link: WorkLink; machine: string; repo: string | null }) => void
  /**
   * 이 출처가 작업 링크를 저장하는가(LIFE-635 X1-7) — 묶음은 능력 표가 이 값과 같은지 먼저 본다. 켜짐 출처가 능력을 끄면(옛 동작으로 돌아가면)
   * 링크 시험이 「꺼짐 갈래」 로 조용히 통과하지 않고 여기서 실패한다.
   */
  workLinkStore: 'on' | 'off'
  /**
   * 이 출처가 켠 커서·코멘트·이력 능력(LIFE-638 D9) — 묶음은 능력 표가 이 선언과 같은지 먼저 본다. 세 시험은 꺼진 출처를 「거절」 갈래로 통과시키므로,
   * 켜짐 출처가 실수로 능력을 끄면(옛 동작으로 돌아가면) 여기서 실패한다(635 `workLinkStore` 꼴).
   */
  declared: { cursorPaging: 'on' | 'off'; comments: 'on' | 'off'; history: 'on' | 'off' }
}

/** 정규형 본문(지원 표 안) — 출처 서식으로 바꿔 두는 출처도 바이트로 되돌려야 하는 꼴. */
const CANONICAL_BODY = '# 제목\n\n- [ ] 한글 체크\n- [x] 끝\n\n```\n<b>raw</b>\n```\n\n끝 줄'

const CAPABILITY_NAMES: WorkCapabilityName[] = ['placement', 'relations', 'parentChange', 'order', 'cursorPaging', 'conflictCheck', 'comments', 'history', 'workLinkStore']

export function workContractSuite({ name, setup }: { name: string; setup: () => Promise<ContractTarget> }): void {
  describe(`작업 계약 묶음 — ${name}`, () => {
    let target: ContractTarget
    let seq = 0
    const send = (call: WorkCall): Promise<WorkResponse> => target.service.request({ requestId: `req-${++seq}`, connectionId: target.connectionId, call })
    const okResult = async (call: WorkCall) => {
      const response = await send(call)
      if (!response.ok) throw new Error(`${call.op} 실패: ${response.error.kind} ${response.error.message}`)
      return response.result
    }
    const listSpaces = async (): Promise<{ spaces: WorkSpace[]; capabilities: WorkCapabilities }> => {
      const result = await okResult({ op: 'listSpaces' })
      if (result.op !== 'listSpaces') throw new Error(result.op)
      return result
    }
    const listStatuses = async (spaceKey: string): Promise<WorkStatus[]> => {
      const result = await okResult({ op: 'listStatuses', spaceKey })
      if (result.op !== 'listStatuses') throw new Error(result.op)
      return result.statuses
    }
    /** 커서가 켜진 출처는 끝까지 따라간다. 꺼진 출처는 한 번에 다 온다(nextCursor null). */
    const listAll = async (spaceKey: string): Promise<{ items: WorkItem[]; truncated: boolean }> => {
      const items: WorkItem[] = []
      let cursor: string | null = null
      let truncated = false
      for (let page = 0; page < 50; page += 1) {
        const result = await okResult({ op: 'listItems', spaceKey, cursor })
        if (result.op !== 'listItems') throw new Error(result.op)
        items.push(...result.items)
        truncated ||= result.truncated
        cursor = result.nextCursor
        if (cursor === null) return { items, truncated }
      }
      throw new Error('커서가 끝나지 않는다')
    }
    const getItem = async (itemId: string): Promise<WorkItem> => {
      const result = await okResult({ op: 'getItem', itemId })
      if (result.op !== 'getItem') throw new Error(result.op)
      return result.item
    }
    const findByKey = async (key: string): Promise<WorkItem | null> => {
      const result = await okResult({ op: 'findByKey', key })
      if (result.op !== 'findByKey') throw new Error(result.op)
      return result.item
    }
    /** 이 연결 출처의 키 모양(E3) — 화면이 받는 그 값(설정 상태의 descriptor). */
    const keyPattern = (): string | null => {
      const settings = target.service.settings()
      const sourceId = settings.connections.find((connection) => connection.id === target.connectionId)?.sourceId
      return settings.sources.find((source) => source.id === sourceId)?.keyPattern ?? null
    }
    const transitions = async (itemId: string): Promise<string[]> => {
      const result = await okResult({ op: 'listTransitions', itemId })
      if (result.op !== 'listTransitions') throw new Error(result.op)
      return result.statusKeys
    }
    /** 능력이 꺼졌으면 그 연산은 `unsupported` + 능력 표의 이유여야 한다. */
    const expectClosed = async ({ capability, call }: { capability: WorkCapability; call: WorkCall }): Promise<void> => {
      const response = await send(call)
      expect(response.ok).toBe(false)
      if (response.ok) return
      expect(response.error.kind).toBe('unsupported')
      if (capability.state === 'disabled') expect(response.error.message).toBe(capability.reason)
    }
    /** 작업이 둘 이상 있는 첫 스페이스 — 묶음이 쓸 무대. */
    const stage = async (): Promise<{ space: WorkSpace; items: WorkItem[]; statuses: WorkStatus[]; capabilities: WorkCapabilities }> => {
      const { spaces, capabilities } = await listSpaces()
      for (const space of spaces) {
        const { items } = await listAll(space.key)
        if (items.length >= 2) return { space, items, statuses: await listStatuses(space.key), capabilities }
      }
      throw new Error('작업이 둘 이상인 스페이스가 없다 — 픽스처를 확인')
    }

    /** 허용 전이를 따라 목표 상태까지 — `any` 면 한 번, `allowed` 면 목표 순서 쪽으로 한 칸씩(최대 6). 끝난 작업을 돌려준다. */
    const travel = async ({ itemId, goal, statuses }: { itemId: string; goal: WorkStatus; statuses: WorkStatus[] }): Promise<WorkItem> => {
      for (let step = 0; step < 6; step += 1) {
        const now = await getItem(itemId)
        if (now.statusKey === goal.key) return now
        const open = await transitions(itemId)
        if (open.includes(goal.key)) {
          await okResult({ op: 'changeStatus', itemId, statusKey: goal.key, ifVersion: null })
          continue
        }
        const order = statuses.find((status) => status.key === now.statusKey)?.order ?? 0
        const forward = goal.order > order
        const candidates = statuses.filter((status) => open.includes(status.key) && (forward ? status.order > order && status.order <= goal.order : status.order < order && status.order >= goal.order))
        const next = forward ? candidates.at(-1) : candidates[0]
        if (next === undefined) throw new Error(`${goal.label} 로 가는 전이가 없다`)
        await okResult({ op: 'changeStatus', itemId, statusKey: next.key, ifVersion: null })
      }
      throw new Error('전이가 끝나지 않는다')
    }
    const activityOf = (itemId: string) => {
      const result = target.service.activity({ connectionId: target.connectionId, itemId })
      if (!result.ok) throw new Error(result.error.message)
      return result.records
    }

    beforeAll(async () => {
      target = await setup()
    })
    afterAll(async () => {
      await target.close()
    })

    it('요청 id 를 그대로 돌려주고, 없는 연결은 not_connected', async () => {
      const response = await target.service.request({ requestId: 'echo-1', connectionId: target.connectionId, call: { op: 'listSpaces' } })
      expect(response.requestId).toBe('echo-1')
      expect(response.connectionId).toBe(target.connectionId)
      const missing = await target.service.request({ requestId: 'echo-2', connectionId: 'no-such', call: { op: 'listSpaces' } })
      expect(missing).toMatchObject({ requestId: 'echo-2', ok: false, error: { kind: 'not_connected' } })
      const malformed = await target.service.request({ requestId: 'echo-3', connectionId: target.connectionId, call: { op: 'listItems' } })
      expect(malformed).toMatchObject({ requestId: 'echo-3', ok: false, error: { kind: 'invalid_request' } })
    })

    it('능력 표 — 상태 변경 방식이 있고, 꺼진 능력은 이유가 있다', async () => {
      const { capabilities } = await listSpaces()
      expect(['any', 'allowed']).toContain(capabilities.transition.mode)
      for (const name of CAPABILITY_NAMES) {
        const capability = capabilities[name]
        expect(['on', 'hidden', 'disabled']).toContain(capability.state)
        if (capability.state === 'disabled') expect(capability.reason.length).toBeGreaterThan(0)
      }
    })

    it('doneAt(LIFE-702) — 목록·단건 모두 칸이 있고 null 또는 해석되는 시각 글자다', async () => {
      const { items } = await stage()
      const first = items[0]
      if (first === undefined) throw new Error('작업 없음')
      for (const item of [...items, await getItem(first.id)]) {
        expect(Object.hasOwn(item, 'doneAt'), item.key).toBe(true)
        if (item.doneAt !== null) expect(Number.isNaN(Date.parse(item.doneAt)), item.key).toBe(false)
      }
    })

    it('스페이스는 1급 — 목록이 따로고, 작업 목록에 스페이스가 섞이지 않는다', async () => {
      const { spaces } = await listSpaces()
      expect(spaces.length).toBeGreaterThan(0)
      const keys = spaces.map((space) => space.key)
      expect(new Set(keys).size).toBe(keys.length)
      for (const space of spaces) {
        expect(space.name.length).toBeGreaterThan(0)
        expect(['regular', 'catch_all']).toContain(space.role)
        const { items, truncated } = await listAll(space.key)
        const ids = new Set(items.map((item) => item.id))
        expect(ids.size).toBe(items.length)
        for (const item of items) {
          expect(keys).not.toContain(item.id)
          // E1 — 열린 막은 쪽 참조는 개수와 같고 키가 있다.
          expect(item.openBlockers).toHaveLength(item.openBlockerCount)
          for (const blocker of item.openBlockers) expect(blocker.key.length).toBeGreaterThan(0)
          expect(item.spaceKey).toBe(space.key)
          expect(WORK_CATEGORIES).toContain(item.category)
          expect(item.key.length).toBeGreaterThan(0)
          expect(Array.isArray(item.workLinks)).toBe(true)
          // 부모는 null(스페이스 바로 아래) 이거나 같은 스페이스의 작업이다.
          if (item.parentId !== null && !truncated) expect(ids.has(item.parentId)).toBe(true)
          expect(item.parentId).not.toBe(space.key)
        }
        if (space.openCount !== null) expect(space.openCount).toBe(items.filter((item) => item.category !== 'done').length)
      }
    })

    it('보여야 할 작업은 하나도 빠지지 않는다 — 단건의 스페이스 목록에 나오고, 부모는 그 목록 안이다', async () => {
      expect(target.visibleItems.length).toBeGreaterThan(0)
      const lists = new Map<string, WorkItem[]>()
      for (const itemId of target.visibleItems) {
        const item = await getItem(itemId)
        const items = lists.get(item.spaceKey) ?? (await listAll(item.spaceKey)).items
        lists.set(item.spaceKey, items)
        const row = items.find((entry) => entry.id === itemId)
        expect(row, `${item.key} 가 ${item.spaceKey} 목록에 없다`).toBeDefined()
        expect(row?.parentId).toBe(item.parentId)
      }
    })

    it('스페이스가 아니게 된 옛 키로 목록을 부르면 거절 — 스페이스 목록에도 없다', async () => {
      const { spaces } = await listSpaces()
      for (const key of target.retiredSpaceKeys) {
        expect(spaces.map((space) => space.key)).not.toContain(key)
        const response = await send({ op: 'listItems', spaceKey: key, cursor: null })
        expect(response).toMatchObject({ ok: false, error: { kind: 'rejected' } })
      }
    })

    it('상태 목록 — 분류 3종 안, 순서가 겹치지 않고, 작업의 상태가 목록 안에 있다', async () => {
      const { space, items, statuses } = await stage()
      expect(statuses.length).toBeGreaterThanOrEqual(2)
      const orders = statuses.map((status) => status.order)
      expect(new Set(orders).size).toBe(orders.length)
      for (const status of statuses) expect(WORK_CATEGORIES).toContain(status.category)
      for (const item of items) {
        const status = statuses.find((entry) => entry.key === item.statusKey)
        expect(status, `${space.key} ${item.key} 상태`).toBeDefined()
        expect(status?.category).toBe(item.category)
      }
    })

    it('단건 — 목록 행과 같은 작업, 연결 목록이 채워져 있다', async () => {
      const { items } = await stage()
      const first = items[0]
      if (first === undefined) throw new Error('no item')
      const item = await getItem(first.id)
      expect(item).toMatchObject({ id: first.id, key: first.key, spaceKey: first.spaceKey, statusKey: first.statusKey })
      expect(Array.isArray(item.relations)).toBe(true)
    })

    it('상태 변경 — 앞으로 가고 되돌린다(허용 전이만인 출처는 허용 밖을 거절)', async () => {
      const { items, statuses, capabilities } = await stage()
      const item = items.find((entry) => entry.category !== 'done') ?? items[0]
      if (item === undefined) throw new Error('no item')
      const allowed = await transitions(item.id)
      if (capabilities.transition.mode === 'any') expect([...allowed].sort()).toEqual(statuses.map((status) => status.key).sort())
      const current = statuses.find((status) => status.key === item.statusKey)
      if (current === undefined) throw new Error('no status')
      const forward = statuses.find((status) => status.order > current.order && allowed.includes(status.key)) ?? statuses.find((status) => status.key !== current.key && allowed.includes(status.key))
      if (forward === undefined) throw new Error('갈 수 있는 상태가 없다')
      const moved = await okResult({ op: 'changeStatus', itemId: item.id, statusKey: forward.key, ifVersion: null })
      expect(moved.op).toBe('changeStatus')
      if (moved.op === 'changeStatus') expect(moved.item.statusKey).toBe(forward.key)
      expect((await getItem(item.id)).statusKey).toBe(forward.key)
      expect((await getItem(item.id)).category).toBe(forward.category)

      const back = await transitions(item.id)
      if (back.includes(current.key)) {
        await okResult({ op: 'changeStatus', itemId: item.id, statusKey: current.key, ifVersion: null })
        expect((await getItem(item.id)).statusKey).toBe(current.key)
      } else {
        expect(capabilities.transition.mode).toBe('allowed')
      }
      if (capabilities.transition.mode === 'allowed') {
        const now = await getItem(item.id)
        const open = await transitions(item.id)
        const blocked = statuses.find((status) => status.key !== now.statusKey && !open.includes(status.key))
        if (blocked !== undefined) {
          const refused = await send({ op: 'changeStatus', itemId: item.id, statusKey: blocked.key, ifVersion: null })
          expect(refused).toMatchObject({ ok: false, error: { kind: 'rejected' } })
          expect((await getItem(item.id)).statusKey).toBe(now.statusKey)
        }
      }
    })

    it('배치 — 보드 ↔ 백로그', async () => {
      const { items, capabilities } = await stage()
      const item = items.find((entry) => entry.placement !== null) ?? items[0]
      if (item === undefined) throw new Error('no item')
      if (capabilities.placement.state !== 'on') {
        await expectClosed({ capability: capabilities.placement, call: { op: 'setPlacement', itemId: item.id, placement: 'board', ifVersion: null } })
        return
      }
      const original = item.placement ?? 'board'
      const flipped = original === 'board' ? 'backlog' : 'board'
      await okResult({ op: 'setPlacement', itemId: item.id, placement: flipped, ifVersion: null })
      expect((await getItem(item.id)).placement).toBe(flipped)
      await okResult({ op: 'setPlacement', itemId: item.id, placement: original, ifVersion: null })
      expect((await getItem(item.id)).placement).toBe(original)
    })

    it('연결 — 추가하면 양쪽에 짝으로 보이고, 지우면 사라진다', async () => {
      const { items, capabilities } = await stage()
      const [a, b] = items
      if (a === undefined || b === undefined) throw new Error('two items')
      if (capabilities.relations.state !== 'on') {
        await expectClosed({ capability: capabilities.relations, call: { op: 'addRelation', itemId: a.id, kind: 'blocks', otherKey: b.key } })
        return
      }
      const added = await okResult({ op: 'addRelation', itemId: a.id, kind: 'blocks', otherKey: b.key })
      if (added.op !== 'addRelation') throw new Error(added.op)
      expect(added.relation).toMatchObject({ kind: 'blocks', other: { id: b.id, key: b.key } })
      const onB = (await getItem(b.id)).relations ?? []
      expect(onB.some((relation) => relation.id === added.relation.id && relation.kind === 'is_blocked_by' && relation.other.id === a.id)).toBe(true)
      if (a.category !== 'done') {
        expect((await getItem(b.id)).openBlockerCount).toBeGreaterThanOrEqual(1)
        // E1 — 목록 행과 단건 모두 막은 쪽 키를 싣는다(카드 배지 「막힘 · KEY」).
        expect((await getItem(b.id)).openBlockers.map((blocker) => blocker.key)).toContain(a.key)
        const listed = (await listAll(b.spaceKey)).items.find((item) => item.id === b.id)
        expect(listed?.openBlockers.map((blocker) => blocker.key)).toContain(a.key)
      }
      const duplicate = await send({ op: 'addRelation', itemId: a.id, kind: 'blocks', otherKey: b.key })
      expect(duplicate).toMatchObject({ ok: false, error: { kind: 'rejected' } })
      const self = await send({ op: 'addRelation', itemId: a.id, kind: 'relates_to', otherKey: a.key })
      expect(self).toMatchObject({ ok: false, error: { kind: 'rejected' } })
      await okResult({ op: 'removeRelation', itemId: a.id, relationId: added.relation.id })
      expect(((await getItem(a.id)).relations ?? []).some((relation) => relation.id === added.relation.id)).toBe(false)
    })

    it('부모 변경 — 스페이스 바로 아래로 옮기고 되돌린다', async () => {
      const { space, items, capabilities } = await stage()
      const child = items.find((entry) => entry.parentId !== null)
      if (child === undefined || child.parentId === null) throw new Error('부모 있는 작업이 없다 — 픽스처를 확인')
      if (capabilities.parentChange.state !== 'on') {
        await expectClosed({ capability: capabilities.parentChange, call: { op: 'setParent', itemId: child.id, spaceKey: space.key, parentId: null, ifVersion: null } })
        return
      }
      const original = child.parentId
      const moved = await okResult({ op: 'setParent', itemId: child.id, spaceKey: space.key, parentId: null, ifVersion: null })
      if (moved.op === 'setParent') expect(moved.item).toMatchObject({ parentId: null, spaceKey: space.key })
      expect((await getItem(child.id)).parentId).toBeNull()
      await okResult({ op: 'setParent', itemId: child.id, spaceKey: space.key, parentId: original, ifVersion: null })
      expect((await getItem(child.id)).parentId).toBe(original)
    })

    it('순서 — 켜져 있으면 옮긴 자리가 목록에 보이고, 꺼져 있으면 이유와 함께 거절', async () => {
      const { space, items, capabilities } = await stage()
      const [first, second] = items
      if (first === undefined || second === undefined) throw new Error('two items')
      if (capabilities.order.state !== 'on') {
        await expectClosed({ capability: capabilities.order, call: { op: 'reorder', itemId: first.id, afterId: second.id } })
        return
      }
      await okResult({ op: 'reorder', itemId: first.id, afterId: second.id })
      const after = (await listAll(space.key)).items.map((item) => item.id)
      expect(after.indexOf(first.id)).toBe(after.indexOf(second.id) + 1)
    })

    it('커서 페이지 — 켜져 있으면 다음 쪽이 이어지고, 꺼져 있으면 커서를 거절', async () => {
      const { space, items, capabilities } = await stage()
      if (capabilities.cursorPaging.state !== 'on') {
        await expectClosed({ capability: capabilities.cursorPaging, call: { op: 'listItems', spaceKey: space.key, cursor: 'next' } })
        return
      }
      const first = await okResult({ op: 'listItems', spaceKey: space.key, cursor: null })
      if (first.op !== 'listItems') throw new Error(first.op)
      expect(first.nextCursor).not.toBeNull()
      expect(first.items.length).toBeLessThan(items.length)
    })

    it('저장 충돌 — 켜져 있으면 낡은 판은 conflict, 꺼져 있으면 판을 거절', async () => {
      const { items, statuses, capabilities } = await stage()
      const item = await getItem((items[0] ?? { id: '' }).id)
      const other = statuses.find((status) => status.key !== item.statusKey)
      if (other === undefined) throw new Error('status')
      if (capabilities.conflictCheck.state !== 'on') {
        expect(item.version).toBeNull()
        await expectClosed({ capability: capabilities.conflictCheck, call: { op: 'changeStatus', itemId: item.id, statusKey: other.key, ifVersion: 'stale' } })
        // 배치가 꺼진 출처는 배치 능력 이유가 먼저 온다(능력 문 순서) — 판 거절은 배치가 켜진 출처에서만 본다.
        if (capabilities.placement.state === 'on') await expectClosed({ capability: capabilities.conflictCheck, call: { op: 'setPlacement', itemId: item.id, placement: 'board', ifVersion: 'stale' } })
        return
      }
      expect(item.version).not.toBeNull()
      const stale = await send({ op: 'changeStatus', itemId: item.id, statusKey: other.key, ifVersion: `${item.version}-old` })
      expect(stale).toMatchObject({ ok: false, error: { kind: 'conflict' } })
      expect((await getItem(item.id)).statusKey).toBe(item.statusKey)
      // E7 — 충돌 오류는 서버의 지금 작업을 싣는다(화면이 「어떤 칸」 을 계산한다).
      if (!stale.ok) expect(stale.error.conflict?.current).toMatchObject({ id: item.id, statusKey: item.statusKey, version: item.version })
      const staleEdit = await send({ op: 'updateItem', itemId: item.id, fields: { title: '충돌 제목' }, ifVersion: `${item.version}-old` })
      expect(staleEdit).toMatchObject({ ok: false, error: { kind: 'conflict' } })
      expect((await getItem(item.id)).title).toBe(item.title)
      // 「내 값으로 덮기」 = 판 없이 다시 — 저장된다.
      await okResult({ op: 'updateItem', itemId: item.id, fields: { title: '덮은 제목' }, ifVersion: null })
      expect((await getItem(item.id)).title).toBe('덮은 제목')
      await okResult({ op: 'updateItem', itemId: item.id, fields: { title: item.title }, ifVersion: (await getItem(item.id)).version })
      expect((await getItem(item.id)).title).toBe(item.title)
    })

    it('저장 충돌(LIFE-622 C3) — 같은 상태 요청·배치·부모 변경의 낡은 판도 conflict(저장 0), 꺼져 있으면 판을 거절', async () => {
      const { space, items, capabilities } = await stage()
      const item = await getItem((items[0] ?? { id: '' }).id)
      const child = items.find((entry) => entry.parentId !== null)
      if (capabilities.conflictCheck.state !== 'on') {
        await expectClosed({ capability: capabilities.conflictCheck, call: { op: 'changeStatus', itemId: item.id, statusKey: item.statusKey, ifVersion: 'stale' } })
        if (capabilities.parentChange.state === 'on' && child !== undefined) await expectClosed({ capability: capabilities.conflictCheck, call: { op: 'setParent', itemId: child.id, spaceKey: space.key, parentId: null, ifVersion: 'stale' } })
        return
      }
      // F7 — 쓰기가 없는 같은 상태 요청도 낡은 판이면 성공으로 지나가지 않는다. 맞는 판이면 그대로 성공.
      expect(await send({ op: 'changeStatus', itemId: item.id, statusKey: item.statusKey, ifVersion: `${item.version}-old` })).toMatchObject({ ok: false, error: { kind: 'conflict' } })
      expect(await send({ op: 'changeStatus', itemId: item.id, statusKey: item.statusKey, ifVersion: item.version })).toMatchObject({ ok: true })
      if (capabilities.placement.state === 'on' && item.placement !== null) {
        const fresh = await getItem(item.id)
        expect(await send({ op: 'setPlacement', itemId: item.id, placement: item.placement === 'board' ? 'backlog' : 'board', ifVersion: `${fresh.version}-old` })).toMatchObject({ ok: false, error: { kind: 'conflict' } })
        expect((await getItem(item.id)).placement).toBe(item.placement)
      }
      if (capabilities.parentChange.state === 'on' && child !== undefined) {
        const fresh = await getItem(child.id)
        const stale = await send({ op: 'setParent', itemId: child.id, spaceKey: space.key, parentId: null, ifVersion: `${fresh.version}-old` })
        expect(stale).toMatchObject({ ok: false, error: { kind: 'conflict' } })
        if (!stale.ok) expect(stale.error.conflict?.current).toMatchObject({ id: child.id, parentId: fresh.parentId, version: fresh.version })
        expect((await getItem(child.id)).parentId).toBe(fresh.parentId)
      }
    })

    it('필드 수정(E4) — 제목·본문·우선순위·마감을 보낸 칸만 바꾸고 되돌린다, 본문은 바이트 그대로', async () => {
      const { items, capabilities } = await stage()
      const item = await getItem((items[0] ?? { id: '' }).id)
      const body = target.bodyRoundTrip === 'canonical' ? CANONICAL_BODY : '# 제목\r\n\n- [ ] 한글 체크\n- [x] 끝\n\n```\n<b>raw</b>\n```\n  끝 공백  \n'
      // 마감 = 그날 로컬 23:59:59(화면 날짜 칸 규칙) — 날짜만 두는 출처(Jira duedate)도 되돌린다.
      const due = new Date(2026, 10, 1, 23, 59, 59).toISOString()
      const edited = await okResult({ op: 'updateItem', itemId: item.id, fields: { title: `${item.title} (수정)`, body, priority: 'highest', dueAt: due }, ifVersion: null })
      if (edited.op !== 'updateItem') throw new Error(edited.op)
      const after = await getItem(item.id)
      expect(after).toMatchObject({ title: `${item.title} (수정)`, body, priority: 'highest', statusKey: item.statusKey })
      expect(Date.parse(after.dueAt ?? '')).toBe(Date.parse(due))
      // 보낸 칸만 — 제목만 보내면 본문은 그대로.
      await okResult({ op: 'updateItem', itemId: item.id, fields: { title: item.title }, ifVersion: null })
      expect((await getItem(item.id)).body).toBe(body)
      await okResult({ op: 'updateItem', itemId: item.id, fields: { body: item.body ?? '', priority: item.priority, dueAt: item.dueAt }, ifVersion: null })
      const back = await getItem(item.id)
      expect(back).toMatchObject({ title: item.title, priority: item.priority, dueAt: item.dueAt })
      expect(back.body ?? '').toBe(item.body ?? '')
      // 빈 제목·빈 수정·모르는 칸은 보내기 전에 거절.
      for (const fields of [{ title: '  ' }, {}, { color: 'red' }]) {
        expect(await send({ op: 'updateItem', itemId: item.id, fields, ifVersion: null })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
      }
      // 판(ifVersion)은 충돌 검사 능력이 켜진 출처에서만.
      if (capabilities.conflictCheck.state !== 'on') await expectClosed({ capability: capabilities.conflictCheck, call: { op: 'updateItem', itemId: item.id, fields: { title: 'x' }, ifVersion: 'v' } })
      // 활동(D9) — 성공한 쓰기만 「칸마다 한 줄」 로 남고, 같은 쓰기의 줄은 쓰기 id 를 나눈다.
      const records = activityOf(item.id)
      expect(records.filter((record) => record.change.field === 'title').map((record) => record.change.field === 'title' && record.change.to)).toEqual(expect.arrayContaining([`${item.title} (수정)`, item.title]))
      const first = records.find((record) => record.change.field === 'priority' && record.change.to === 'highest')
      expect(first).toBeDefined()
      expect(records.filter((record) => record.writeId === first?.writeId).map((record) => record.change.field).sort()).toEqual(['body', 'dueAt', 'priority', 'title'])
    })

    // 공유 픽스처를 쓰는 검사라 끝에 픽스처 본문을 처음 값(출처 서식 그대로)으로 되돌리고, 시작 때 단건 본문과 같은지 본다
    // (R1-C — 목록 행 `item.body` 는 「안 실음」 null 이라 되돌릴 값이 아니다).
    // 만든 임시 작업(`createItem`)은 남긴다 — 계약에 지우기 연산이 없다(E6 「계약 묶음 자식」 과 같다). 이름 「단건 모양 검사」 로 알아볼 수 있다.
    it.each([null, '', '외부 본문'])('쓰기 결과는 단건 모양(LIFE-623) — 외부 본문 %j 뒤 모든 쓰기 결과의 본문·연결 = 직후 단건, 「안 실음」 null 이 없다', async (external) => {
      const { space, items, statuses, capabilities } = await stage()
      const listed = items.find((entry) => entry.category !== 'done' && entry.parentId === null) ?? items[0]
      const listedChild = items.find((entry) => entry.parentId !== null)
      if (listed === undefined) throw new Error('no item')
      const item = await getItem(listed.id)
      const child = listedChild === undefined ? undefined : await getItem(listedChild.id)
      const restores = new Map<string, () => void>()
      const putExternal = (itemId: string): void => {
        const restore = target.externalBody({ itemId, body: external })
        if (!restores.has(itemId)) restores.set(itemId, restore)
      }
      /** 쓰기 하나 — 외부 본문을 가한 뒤 보내고, 결과 본문·연결 = 직후 단건. */
      const expectCanonical = async ({ call, itemId }: { call: WorkCall; itemId: string }): Promise<void> => {
        putExternal(itemId)
        const result = await okResult(call)
        if (!('item' in result) || result.item === null) throw new Error(`${call.op} 결과에 작업이 없다`)
        const canonical = await getItem(itemId)
        expect({ op: call.op, body: result.item.body }).toEqual({ op: call.op, body: canonical.body })
        expect({ op: call.op, relations: result.item.relations }).toEqual({ op: call.op, relations: canonical.relations })
        // 단건의 연결은 「안 실음」 이 아니다 — 빈 연결은 빈 배열.
        expect(canonical.relations).not.toBeNull()
        if (external !== null && external !== '') expect(canonical.body).toBe(external)
        else expect(canonical.body ?? '').toBe('')
      }
      const original = statuses.find((status) => status.key === item.statusKey)
      try {
        const writes: { call: WorkCall; itemId: string }[] = [{ call: { op: 'updateItem', itemId: item.id, fields: { title: `${item.title} ·` }, ifVersion: null }, itemId: item.id }]
        const allowed = await transitions(item.id)
        const forward = statuses.find((status) => status.key !== item.statusKey && status.category !== 'done' && allowed.includes(status.key)) ?? statuses.find((status) => status.key !== item.statusKey && allowed.includes(status.key))
        if (forward !== undefined) writes.push({ call: { op: 'changeStatus', itemId: item.id, statusKey: forward.key, ifVersion: null }, itemId: item.id })
        if (capabilities.placement.state === 'on') writes.push({ call: { op: 'setPlacement', itemId: item.id, placement: item.placement === 'board' ? 'backlog' : 'board', ifVersion: null }, itemId: item.id })
        if (capabilities.order.state === 'on') {
          const other = items.find((entry) => entry.id !== item.id)
          if (other !== undefined) writes.push({ call: { op: 'reorder', itemId: item.id, afterId: other.id }, itemId: item.id })
        }
        if (capabilities.parentChange.state === 'on' && child !== undefined) writes.push({ call: { op: 'setParent', itemId: child.id, spaceKey: space.key, parentId: child.parentId, ifVersion: null }, itemId: child.id })
        for (const write of writes) await expectCanonical(write)
        // 완료 갈래 전이(R1-B) — 완료 바로 앞까지 간 뒤 완료로(갈래 능력이 켜졌으면 「취소함」 을 실어). 결과 본문·연결 = 직후 단건.
        const done = statuses.find((status) => status.category === 'done')
        if (done !== undefined && original !== undefined) {
          // 완료로 가는 전이가 열릴 때까지 완료 아닌 상태로 한 칸씩(허용 전이만인 출처 — 들른 상태는 다시 가지 않는다).
          const seen = new Set<string>()
          for (let step = 0; step < 6; step += 1) {
            const now = await getItem(item.id)
            seen.add(now.statusKey)
            const open = await transitions(item.id)
            if (open.includes(done.key)) break
            const next = statuses.find((status) => status.category !== 'done' && open.includes(status.key) && !seen.has(status.key))
            if (next === undefined) throw new Error('완료로 가는 길이 없다')
            await okResult({ op: 'changeStatus', itemId: item.id, statusKey: next.key, ifVersion: null })
          }
          await expectCanonical({ call: { op: 'changeStatus', itemId: item.id, statusKey: done.key, ifVersion: null, ...(capabilities.resolution.state === 'on' ? { resolution: 'cancelled' as const } : {}) }, itemId: item.id })
          // 같은 완료 상태에서 갈래만 바꾸기(R3-C — 전이가 아닌 갈래만 바꾸는 길, 출처마다 따로 있다) — 결과 본문·연결 = 직후 단건.
          if (capabilities.resolution.state === 'on') await expectCanonical({ call: { op: 'changeStatus', itemId: item.id, statusKey: done.key, ifVersion: null, resolution: 'completed' }, itemId: item.id })
        }
        // 본문 쓰기 자체도 — 보낸 글이 결과에 그대로(빈 글 포함).
        putExternal(item.id)
        const cleared = await okResult({ op: 'updateItem', itemId: item.id, fields: { body: '' }, ifVersion: null })
        if (cleared.op !== 'updateItem') throw new Error(cleared.op)
        expect(cleared.item.body).toEqual((await getItem(item.id)).body)
        // 만들기(R1-B) — 자식을 받는 종류 아래 임시 작업. 본문 = 이 경우의 외부 본문(null 이면 본문 칸 없이). 결과 본문·연결 = 직후 단건.
        const kinds = await okResult({ op: 'listStatuses', spaceKey: space.key })
        if (kinds.op !== 'listStatuses') throw new Error(kinds.op)
        const parent = items.find((entry) => (kinds.kinds.find((kind) => kind.key === entry.kind.key)?.childKinds.length ?? 0) > 0)
        const kindKey = parent === undefined ? undefined : kinds.kinds.find((kind) => kind.key === parent.kind.key)?.childKinds[0]
        if (parent === undefined || kindKey === undefined) throw new Error('자식을 받는 작업이 없다 — 픽스처를 확인')
        const made = await okResult({ op: 'createItem', spaceKey: space.key, parentId: parent.id, kindKey, title: `단건 모양 검사 ${JSON.stringify(external)}`, ...(external === null ? {} : { body: external }) })
        if (made.op !== 'createItem') throw new Error(made.op)
        const madeCanonical = await getItem(made.item.id)
        expect({ op: 'createItem', body: made.item.body, relations: made.item.relations }).toEqual({ op: 'createItem', body: madeCanonical.body, relations: madeCanonical.relations })
        expect(madeCanonical.relations).not.toBeNull()
      } finally {
        // 되돌리기(실패해도 — 다음 경우가 같은 픽스처를 쓴다) — 제목·상태·배치, 그리고 본문은 픽스처를 시작 때 단건 본문으로(R1-C).
        await okResult({ op: 'updateItem', itemId: item.id, fields: { title: item.title }, ifVersion: null })
        if (original !== undefined) await travel({ itemId: item.id, goal: original, statuses })
        if (capabilities.placement.state === 'on' && item.placement !== null) await okResult({ op: 'setPlacement', itemId: item.id, placement: item.placement, ifVersion: null })
        for (const restore of restores.values()) restore()
        expect((await getItem(item.id)).body).toBe(item.body)
        if (child !== undefined) expect((await getItem(child.id)).body).toBe(child.body)
      }
      expect((await getItem(item.id)).resolution).toBe(item.resolution)
    })

    it('완료 갈래(E5) — 완료 분류로 「취소함」·「완료함」 을 고르고, 갈래만 바꾸고, 되돌리면 갈래가 비운다 · 갈래 능력이 꺼졌으면 갈래를 실은 변경은 이유와 함께 거절', async () => {
      const { items, statuses, capabilities } = await stage()
      const item = await getItem((items.find((entry) => entry.category !== 'done') ?? items[0] ?? { id: '' }).id)
      const done = statuses.find((status) => status.category === 'done')
      const original = statuses.find((status) => status.key === item.statusKey)
      if (done === undefined || original === undefined) throw new Error('완료 상태가 없다')
      expect(item.resolution).toBeNull()
      if (capabilities.resolution.state !== 'on') {
        // LIFE-605 C4⑥ — 갈래를 고르지 못하는 출처: 갈래를 실으면 출처에 닿기 전에 거절, 갈래 없이 완료로 가면 출처가 정한 값(또는 null)을 그대로 읽는다.
        await expectClosed({ capability: capabilities.resolution, call: { op: 'changeStatus', itemId: item.id, statusKey: done.key, ifVersion: null, resolution: 'cancelled' } })
        await travel({ itemId: item.id, goal: done, statuses })
        const finished = await getItem(item.id)
        expect(finished).toMatchObject({ statusKey: done.key, category: 'done' })
        expect([null, 'completed', 'cancelled', 'other']).toContain(finished.resolution)
        await travel({ itemId: item.id, goal: original, statuses })
        expect(await getItem(item.id)).toMatchObject({ statusKey: original.key, resolution: null })
        return
      }
      // 완료 바로 앞까지 간 뒤 갈래를 실어 완료로.
      const beforeDone = statuses.filter((status) => status.category !== 'done').at(-1)
      if (beforeDone !== undefined && (await transitions(item.id)).includes(done.key) === false) await travel({ itemId: item.id, goal: beforeDone, statuses })
      await okResult({ op: 'changeStatus', itemId: item.id, statusKey: done.key, ifVersion: null, resolution: 'cancelled' })
      expect(await getItem(item.id)).toMatchObject({ statusKey: done.key, category: 'done', resolution: 'cancelled' })
      await okResult({ op: 'changeStatus', itemId: item.id, statusKey: done.key, ifVersion: null, resolution: 'completed' })
      expect(await getItem(item.id)).toMatchObject({ statusKey: done.key, resolution: 'completed' })
      const statusRecords = activityOf(item.id).filter((record) => record.change.field === 'status')
      expect(statusRecords.at(-1)?.change).toMatchObject({ field: 'status', statusKey: done.key, resolution: 'completed' })
      await travel({ itemId: item.id, goal: original, statuses })
      expect(await getItem(item.id)).toMatchObject({ statusKey: original.key, resolution: null })
      // 모르는 갈래는 경계 검증에서 거절 — 타입 밖 값이라 raw 요청으로 보낸다.
      expect(await target.service.request({ requestId: 'req-wontfix', connectionId: target.connectionId, call: { op: 'changeStatus', itemId: item.id, statusKey: done.key, ifVersion: null, resolution: 'wontfix' } })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    })

    it('자식(E6) — 자식을 받는 종류 아래 제목만으로 만들면 목록에 나오고, 잎 종류 아래는 거절', async () => {
      const { space, items } = await stage()
      const kinds = (await okResult({ op: 'listStatuses', spaceKey: space.key }))
      if (kinds.op !== 'listStatuses') throw new Error(kinds.op)
      const childKindsOf = (key: string): string[] => kinds.kinds.find((kind) => kind.key === key)?.childKinds ?? []
      for (const kind of kinds.kinds) for (const child of kind.childKinds) expect(kinds.kinds.map((entry) => entry.key)).toContain(child)
      const parent = items.find((item) => childKindsOf(item.kind.key).length > 0)
      const leaf = items.find((item) => childKindsOf(item.kind.key).length === 0)
      if (parent === undefined || leaf === undefined) throw new Error('자식을 받는 작업·잎 작업이 다 있어야 한다 — 픽스처를 확인')
      // 작업의 종류에도 같은 childKinds 가 실린다(상세가 목록 없이도 안다).
      expect((await getItem(parent.id)).kind.childKinds).toEqual(childKindsOf(parent.kind.key))
      const kindKey = childKindsOf(parent.kind.key)[0] ?? ''
      const created = await okResult({ op: 'createItem', spaceKey: space.key, parentId: parent.id, kindKey, title: '계약 묶음 자식' })
      if (created.op !== 'createItem') throw new Error(created.op)
      expect(created.item).toMatchObject({ title: '계약 묶음 자식', parentId: parent.id, spaceKey: space.key, kind: { key: kindKey } })
      const children = await okResult({ op: 'listChildren', itemId: parent.id })
      if (children.op !== 'listChildren') throw new Error(children.op)
      expect(children.items.map((child) => child.id)).toContain(created.item.id)
      for (const child of children.items) expect(child.parentId).toBe(parent.id)
      expect((await getItem(created.item.id)).parentId).toBe(parent.id)
      expect(activityOf(parent.id).some((record) => record.change.field === 'child' && record.change.childKey === created.item.key)).toBe(true)
      const refused = await send({ op: 'createItem', spaceKey: space.key, parentId: leaf.id, kindKey: leaf.kind.key, title: '잎 아래' })
      expect(refused).toMatchObject({ ok: false, error: { kind: 'rejected' } })
      const blank = await send({ op: 'createItem', spaceKey: space.key, parentId: parent.id, kindKey, title: '   ' })
      expect(blank).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    })

    /** 메타의 필수 필드를 채운 값 — 글은 '계약 값', 고르기는 첫 선택지. 채울 수 없는 모양이 있으면 null. */
    const fillRequired = (meta: WorkCreateMeta): WorkCreateFieldValue[] | null => {
      const values: WorkCreateFieldValue[] = []
      for (const field of meta.fields) {
        if (field.shape === 'unsupported') return null
        values.push({ key: field.key, value: field.shape === 'text' ? '계약 값' : (field.options[0]?.id ?? '') })
      }
      return values
    }
    const createMeta = async ({ spaceKey, kindKey }: { spaceKey: string; kindKey: string }): Promise<WorkCreateMeta> => {
      const result = await okResult({ op: 'getCreateMeta', spaceKey, kindKey })
      if (result.op !== 'getCreateMeta') throw new Error(result.op)
      return result.meta
    }

    it('생성 메타(E11) — 종류마다 상태(완료 분류 제외)·기본 상태·필수 필드, 모르는 종류는 거절', async () => {
      const { space, statuses } = await stage()
      const kinds = await okResult({ op: 'listStatuses', spaceKey: space.key })
      if (kinds.op !== 'listStatuses') throw new Error(kinds.op)
      for (const kind of kinds.kinds) {
        const meta = await createMeta({ spaceKey: space.key, kindKey: kind.key })
        expect(meta).toMatchObject({ spaceKey: space.key, kindKey: kind.key })
        expect(meta.statusKeys.length).toBeGreaterThan(0)
        expect(meta.statusKeys).toContain(meta.defaultStatusKey)
        for (const key of meta.statusKeys) {
          const status = statuses.find((entry) => entry.key === key)
          expect(status, `메타 상태 ${key} 는 그 스페이스 상태 목록에 있어야 한다`).toBeDefined()
          expect(status?.category).not.toBe('done')
        }
      }
      expect(await send({ op: 'getCreateMeta', spaceKey: space.key, kindKey: 'no-such-kind' })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    })

    it('만들기 칸(E10) — 본문·상태·우선순위·배치·필수 필드가 그대로 들어가고, 「만들었음」 활동 1건', async () => {
      const { space, capabilities } = await stage()
      const kinds = await okResult({ op: 'listStatuses', spaceKey: space.key })
      if (kinds.op !== 'listStatuses') throw new Error(kinds.op)
      const createBody = target.bodyRoundTrip === 'canonical' ? '## 본문\n\n- [ ] 하나' : '## 본문\n- [ ] 하나'
      for (const kind of kinds.kinds) {
        const meta = await createMeta({ spaceKey: space.key, kindKey: kind.key })
        const fields = fillRequired(meta)
        if (fields === null) continue
        // 이 (스페이스, 종류)로는 못 만든다(LA 「미분류」 Checkpoint · Jira 하위 작업 맨 위) — 만들기는 거절이어야 한다.
        if (meta.unavailable !== undefined) {
          expect(await send({ op: 'createItem', spaceKey: space.key, parentId: null, kindKey: kind.key, title: '못 만듦', ...(fields.length === 0 ? {} : { fields }) })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
          continue
        }
        // 받지 않는 칸(LIFE-605 · T4 §14-1)은 싣지 않는다 — 실으면 거절이어야 한다(받는 척 금지).
        if (!meta.accepts.body) expect(await send({ op: 'createItem', spaceKey: space.key, parentId: null, kindKey: kind.key, title: '본문 실음', body: 'x', ...(fields.length === 0 ? {} : { fields }) })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
        if (!meta.accepts.priority) expect(await send({ op: 'createItem', spaceKey: space.key, parentId: null, kindKey: kind.key, title: '우선순위 실음', priority: 'high', ...(fields.length === 0 ? {} : { fields }) })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
        const statusKey = meta.statusKeys.at(-1) ?? meta.defaultStatusKey
        // 배치는 능력이 켜졌고 그 종류에 적용될 때만(R2-H). 적용 안 되는 종류에 실으면 거절이어야 한다(받는 척 금지).
        const placement = capabilities.placement.state === 'on' && meta.placement === 'applies' ? 'backlog' : undefined
        // LIFE-665: 지금 이 분기를 밟는 출처는 없다(LA bug 가 applies 로 바뀜 · Jira 는 배치 능력 disabled · 모의는 applies).
        // 그 거절의 덮개는 `create.test.ts` 「createmeta-placement-ignored」(모의 출처) — 분기는 미래 출처를 위해 둔다.
        if (capabilities.placement.state === 'on' && meta.placement === 'ignored') {
          expect(await send({ op: 'createItem', spaceKey: space.key, parentId: null, kindKey: kind.key, title: '배치 실음', placement: 'backlog', ...(fields.length === 0 ? {} : { fields }) })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
        }
        const body = meta.accepts.body ? { body: createBody } : {}
        const priority = meta.accepts.priority ? { priority: 'high' as const } : {}
        const created = await okResult({ op: 'createItem', spaceKey: space.key, parentId: null, kindKey: kind.key, title: `계약 만들기 ${kind.key}`, ...body, statusKey, ...priority, ...(placement === undefined ? {} : { placement }), ...(fields.length === 0 ? {} : { fields }) })
        if (created.op !== 'createItem') throw new Error(created.op)
        const again = await getItem(created.item.id)
        expect(again).toMatchObject({ title: `계약 만들기 ${kind.key}`, ...body, statusKey, ...priority, parentId: null, spaceKey: space.key, kind: { key: kind.key } })
        if (placement !== undefined) expect(again.placement).toBe('backlog')
        const records = activityOf(created.item.id).filter((record) => record.change.field === 'created')
        expect(records).toHaveLength(1)
        expect(records[0]?.change).toEqual({ field: 'created', kindLabel: kind.label })
        // 목록 재조회에도 서버 값으로 나온다(낙관 행 아님).
        expect((await listAll(space.key)).items.find((item) => item.id === created.item.id)).toMatchObject({ statusKey, ...priority })
      }
    })

    it('만들기 배치(E10) — 보드로 만들면 보드, 배치 능력이 꺼져 있으면 배치를 실은 만들기는 unsupported', async () => {
      const { space, capabilities } = await stage()
      const kinds = await okResult({ op: 'listStatuses', spaceKey: space.key })
      if (kinds.op !== 'listStatuses') throw new Error(kinds.op)
      if (capabilities.placement.state !== 'on') {
        const first = kinds.kinds[0]
        if (first === undefined) throw new Error('종류가 없다')
        await expectClosed({ capability: capabilities.placement, call: { op: 'createItem', spaceKey: space.key, parentId: null, kindKey: first.key, title: '계약 보드 만들기', placement: 'board' } })
        return
      }
      const kind = (await Promise.all(kinds.kinds.map(async (entry) => ({ entry, meta: await createMeta({ spaceKey: space.key, kindKey: entry.key }) })))).find(({ meta }) => meta.fields.length === 0 && meta.placement === 'applies')
      if (kind === undefined) throw new Error('필수 필드 없고 배치가 적용되는 종류가 하나는 있어야 한다 — 픽스처를 확인')
      const call: WorkCall = { op: 'createItem', spaceKey: space.key, parentId: null, kindKey: kind.entry.key, title: '계약 보드 만들기', placement: 'board' }
      if (capabilities.placement.state !== 'on') {
        await expectClosed({ capability: capabilities.placement, call })
        return
      }
      const created = await okResult(call)
      if (created.op !== 'createItem') throw new Error(created.op)
      expect((await getItem(created.item.id)).placement).toBe('board')
    })

    it('만들기 거절(E10) — 메타 밖 상태·모르는 필드·빠진 필수 필드는 rejected, 모르는 칸·잘못된 값은 invalid_request(조용히 버리지 않는다)', async () => {
      const { space, statuses } = await stage()
      const kinds = await okResult({ op: 'listStatuses', spaceKey: space.key })
      if (kinds.op !== 'listStatuses') throw new Error(kinds.op)
      const kind = kinds.kinds[0]
      if (kind === undefined) throw new Error('종류가 없다')
      const meta = await createMeta({ spaceKey: space.key, kindKey: kind.key })
      const fields = fillRequired(meta) ?? []
      const base: Extract<WorkCall, { op: 'createItem' }> = { op: 'createItem', spaceKey: space.key, parentId: null, kindKey: kind.key, title: '거절돼야 함', ...(fields.length === 0 ? {} : { fields }) }
      const done = statuses.find((status) => status.category === 'done')
      if (done !== undefined) expect(await send({ ...base, statusKey: done.key })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
      const outside = statuses.find((status) => !meta.statusKeys.includes(status.key) && status.category !== 'done')
      if (outside !== undefined) expect(await send({ ...base, statusKey: outside.key })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
      expect(await send({ ...base, fields: [...fields, { key: 'no-such-field', value: 'x' }] })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
      // 필수 필드가 있는 종류면 빠뜨린 만들기는 거절, 공백만 값도 거절.
      for (const entry of kinds.kinds) {
        const kindMeta = await createMeta({ spaceKey: space.key, kindKey: entry.key })
        const required = kindMeta.fields[0]
        if (required === undefined) continue
        expect(await send({ op: 'createItem', spaceKey: space.key, parentId: null, kindKey: entry.key, title: '필수 빠짐' })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
        expect(await send({ op: 'createItem', spaceKey: space.key, parentId: null, kindKey: entry.key, title: '필수 공백', fields: [{ key: required.key, value: '   ' }] })).toMatchObject({ ok: false, error: { kind: 'rejected' } })
      }
      const raw = (call: Record<string, unknown>) => target.service.request({ requestId: `req-raw-${++seq}`, connectionId: target.connectionId, call })
      expect(await raw({ ...base, dueAt: '2026-11-01T00:00:00.000Z' })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
      expect(await raw({ ...base, assignee: 'me' })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
      expect(await raw({ ...base, priority: 'urgent' })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
      expect(await raw({ ...base, placement: 'sideways' })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
      expect(await raw({ ...base, fields: [{ key: 'a', value: 'x', extra: 1 }] })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
      expect(await raw({ ...base, fields: [{ key: 'a', value: 'x' }, { key: 'a', value: 'y' }] })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
      // 어떤 거절도 작업을 만들지 않았다.
      expect((await listAll(space.key)).items.some((item) => item.title === '거절돼야 함' || item.title.startsWith('필수 '))).toBe(false)
    })

    it('변경 이력(E8) — 켜져 있으면 corral 쓰기가 쓰기 id 와 함께 나오고, 꺼져 있으면 이유와 함께 거절', async () => {
      const { items, capabilities } = await stage()
      const item = await getItem((items[1] ?? items[0] ?? { id: '' }).id)
      if (capabilities.history.state !== 'on') {
        await expectClosed({ capability: capabilities.history, call: { op: 'listHistory', itemId: item.id } })
        return
      }
      await okResult({ op: 'updateItem', itemId: item.id, fields: { title: `${item.title} (이력)` }, ifVersion: null })
      const history = await okResult({ op: 'listHistory', itemId: item.id })
      if (history.op !== 'listHistory') throw new Error(history.op)
      const entry = history.entries.find((row) => row.field === 'title' && row.to === `${item.title} (이력)`)
      expect(entry?.writeId).not.toBeNull()
      // 같은 변경의 corral 활동 기록과 쓰기 id 로 짝이 맞는다(G10 — 이 열쇠로만 합친다).
      expect(activityOf(item.id).some((record) => record.writeId === entry?.writeId && record.change.field === 'title')).toBe(true)
      await okResult({ op: 'updateItem', itemId: item.id, fields: { title: item.title }, ifVersion: null })
    })

    it('연결 상대의 스페이스(E9) — 다른 스페이스 상대는 그 스페이스 키, 같은 스페이스면 같은 키', async () => {
      const { capabilities } = await stage()
      const { itemId, otherKey, otherSpaceKey } = target.crossSpace
      if (capabilities.relations.state !== 'on') return
      const added = await okResult({ op: 'addRelation', itemId, kind: 'relates_to', otherKey })
      if (added.op !== 'addRelation') throw new Error(added.op)
      expect(added.relation.other.spaceKey).toBe(otherSpaceKey)
      const item = await getItem(itemId)
      expect(item.relations?.find((relation) => relation.id === added.relation.id)?.other.spaceKey).toBe(otherSpaceKey)
      const other = await findByKey(otherKey)
      expect(other?.relations?.find((relation) => relation.id === added.relation.id)?.other.spaceKey).toBe(item.spaceKey)
      expect(other?.spaceKey).toBe(otherSpaceKey)
      await okResult({ op: 'removeRelation', itemId, relationId: added.relation.id })
      // 떼기도 활동에 남고, 실패한 연결(자기 자신)은 남지 않는다.
      const records = activityOf(itemId).filter((record) => record.change.field === 'relation').slice(-2)
      expect(records.map((record) => record.change.field === 'relation' && record.change.action)).toEqual(['add', 'remove'])
      expect(records[1]?.change).toMatchObject({ otherKey, kind: 'relates_to' })
      const self = await send({ op: 'addRelation', itemId, kind: 'relates_to', otherKey: item.key })
      expect(self).toMatchObject({ ok: false })
      expect(activityOf(itemId).filter((record) => record.change.field === 'relation').slice(-2)).toEqual(records)
    })

    it('키 모양(E3) — 출처가 정규식 소스를 주고, 목록의 모든 키가 그 모양이다', async () => {
      const pattern = keyPattern()
      expect(pattern).not.toBeNull()
      if (pattern === null) return
      const whole = new RegExp(`^(?:${pattern})$`, 'i')
      const { spaces } = await listSpaces()
      for (const space of spaces) for (const item of (await listAll(space.key)).items) expect(item.key).toMatch(whole)
      expect(target.missingKey).toMatch(whole)
    })

    it('키로 찾기(E2) — 스페이스 무관하게 같은 작업, 대소문자 무시 · 없는 키·모양 밖은 null(오류 아님)', async () => {
      const { spaces } = await listSpaces()
      for (const space of spaces) {
        for (const item of (await listAll(space.key)).items.slice(0, 3)) {
          const found = await findByKey(item.key)
          expect(found, item.key).toMatchObject({ id: item.id, key: item.key, spaceKey: item.spaceKey, statusKey: item.statusKey })
          expect((await findByKey(item.key.toLowerCase()))?.id).toBe(item.id)
        }
      }
      expect(await findByKey(target.missingKey)).toBeNull()
      expect(await findByKey('not a key')).toBeNull()
      const malformed = await send({ op: 'findByKey', key: '' })
      expect(malformed).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    })

    it('코멘트 — 켜져 있으면 남기고 읽고, 꺼져 있으면 이유와 함께 거절', async () => {
      const { items, capabilities } = await stage()
      const item = items[0]
      if (item === undefined) throw new Error('no item')
      if (capabilities.comments.state !== 'on') {
        await expectClosed({ capability: capabilities.comments, call: { op: 'addComment', itemId: item.id, body: '계약 묶음' } })
        await expectClosed({ capability: capabilities.comments, call: { op: 'listComments', itemId: item.id } })
        return
      }
      await okResult({ op: 'addComment', itemId: item.id, body: '계약 묶음' })
      const listed = await okResult({ op: 'listComments', itemId: item.id })
      if (listed.op === 'listComments') expect(listed.comments.some((comment) => comment.body === '계약 묶음')).toBe(true)
    })

    it('질의 검색(LIFE-605 C5) — 켜져 있으면 질의로 찾고, 거부된 질의는 텍스트로 다시 찾아 사유를 준다 · 꺼져 있으면 이유와 함께 거절', async () => {
      const { space, capabilities } = await stage()
      if (capabilities.querySearch.state !== 'on') {
        await expectClosed({ capability: capabilities.querySearch, call: { op: 'searchItems', spaceKeys: [space.key], query: 'x = y' } })
        return
      }
      const plan = target.querySearch
      if (plan === undefined) throw new Error('질의 검색이 켜진 출처는 시험 질의를 줘야 한다 — ContractTarget.querySearch')
      const { spaces } = await listSpaces()
      const keys = spaces.map((entry) => entry.key)
      const queried = await okResult({ op: 'searchItems', spaceKeys: keys, query: plan.query })
      if (queried.op !== 'searchItems') throw new Error(queried.op)
      expect(queried).toMatchObject({ mode: 'query', note: null })
      expect(queried.items.map((item) => item.key)).toContain(plan.expectKey)
      for (const item of queried.items) expect(keys).toContain(item.spaceKey)
      const fallback = await okResult({ op: 'searchItems', spaceKeys: keys, query: plan.badQuery })
      if (fallback.op !== 'searchItems') throw new Error(fallback.op)
      expect(fallback.mode).toBe('text')
      expect(fallback.note?.length ?? 0).toBeGreaterThan(0)
      expect(fallback.items.map((item) => item.key)).toContain(plan.textHitKey)
      expect(await send({ op: 'searchItems', spaceKeys: [], query: 'x' })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
    })

    it('스페이스별 능력(LIFE-605 C7) — 스페이스는 연결 능력을 좁히기만 하고, 좁힌 스페이스의 작업 순서는 그 이유로 거절', async () => {
      const { spaces, capabilities } = await listSpaces()
      for (const space of spaces) {
        for (const name of ['order', 'placement'] as const) {
          const own = space.capabilities[name]
          if (own === undefined) continue
          // 연결에서 꺼진 능력을 스페이스가 켜지 않는다.
          if (capabilities[name].state !== 'on') expect(own.state).not.toBe('on')
          if (own.state === 'disabled') expect(own.reason.length).toBeGreaterThan(0)
        }
        const order = space.capabilities.order
        if (capabilities.order.state !== 'on' || order === undefined || order.state === 'on') continue
        const { items } = await listAll(space.key)
        const [first, second] = items
        if (first === undefined) continue
        const refused = await send({ op: 'reorder', itemId: first.id, afterId: second?.id ?? null })
        expect(refused).toMatchObject({ ok: false, error: { kind: 'unsupported' } })
        if (!refused.ok && order.state === 'disabled') expect(refused.error.message).toBe(order.reason)
      }
    })

    it('커서·코멘트·이력 능력(LIFE-638) — 능력 표가 이 출처의 선언과 같다(켜짐 출처가 꺼짐 갈래로 통과하지 않게)', async () => {
      const { capabilities } = await stage()
      const state = (capability: WorkCapability): 'on' | 'off' => (capability.state === 'on' ? 'on' : 'off')
      expect({ cursorPaging: state(capabilities.cursorPaging), comments: state(capabilities.comments), history: state(capabilities.history) }).toEqual(target.declared)
    })

    it('작업 링크 능력(LIFE-635) — 능력 표의 workLinkStore 가 이 출처의 선언과 같다(켜짐 출처가 꺼짐 갈래로 통과하지 않게)', async () => {
      const { capabilities } = await stage()
      expect(capabilities.workLinkStore.state === 'on' ? 'on' : 'off').toBe(target.workLinkStore)
    })

    // LIFE-603 C14 — 작업 링크 쓰기·지우기는 main 만 보낸다(`storeLink`). 렌더러 요청 모양으로는 받지 않는다.
    it('작업 링크(C14) — 켜져 있으면 저장·지우기가 단건에 보이고, 꺼져 있으면 skipped + 이유 · 출처 요청 0', async () => {
      const { items, capabilities } = await stage()
      const item = items[0]
      if (item === undefined) throw new Error('no item')
      const link: WorkLink = { kind: 'worktree', path: '/tmp/l603-contract/wt', repoRoot: '/tmp/l603-contract' }
      expect(await target.service.request({ requestId: `req-${++seq}`, connectionId: target.connectionId, call: { op: 'saveWorkLink', itemId: item.id, link } })).toMatchObject({ ok: false, error: { kind: 'invalid_request' } })
      const before = target.sourceRequests?.() ?? null
      const saved = await target.service.storeLink({ connectionId: target.connectionId, itemId: item.id, link, action: 'save' })
      if (capabilities.workLinkStore.state !== 'on') {
        expect(saved.state).toBe('skipped')
        if (capabilities.workLinkStore.state === 'disabled') expect(saved.message).toBe(capabilities.workLinkStore.reason)
        expect(await target.service.storeLink({ connectionId: target.connectionId, itemId: item.id, link, action: 'remove' })).toMatchObject({ state: 'skipped' })
        if (before !== null) expect(target.sourceRequests?.()).toBe(before)
        return
      }
      expect(saved).toEqual({ state: 'saved', message: null })
      // LIFE-635 — 단건에 그 링크가 이 Mac 의 이름·레포 표시 이름과 함께 보인다(계약 모양 `WorkLinkRecord`).
      const machine = await target.service.machine()
      const mine = (records: { link: WorkLink; machine: string | null }[]) => records.filter((record) => JSON.stringify(record.link) === JSON.stringify(link) && record.machine === machine)
      const after = await getItem(item.id)
      expect(mine(after.workLinks)).toEqual([expect.objectContaining({ link, machine, repo: 'l603-contract' })])
      expect(after.workLinks.every((record) => record.createdAt === null || Number.isFinite(Date.parse(record.createdAt)))).toBe(true)
      expect(await target.service.storeLink({ connectionId: target.connectionId, itemId: item.id, link, action: 'remove' })).toEqual({ state: 'saved', message: null })
      expect(mine((await getItem(item.id)).workLinks)).toEqual([])
    })

    // LIFE-635 C3 — 판별 = 종류 + 핵심 값 + machine. 같은 링크 재저장은 한 행, 다른 machine 의 같은 경로는 이 Mac 의 떼기로 지워지지 않는다.
    it('작업 링크 판별(LIFE-635) — 재저장은 한 행 · 다른 machine 의 같은 경로 링크는 이 Mac 의 떼기로 지워지지 않는다', async () => {
      const { items, capabilities } = await stage()
      const item = items[0]
      if (item === undefined) throw new Error('no item')
      if (capabilities.workLinkStore.state !== 'on') return
      const plant = target.plantWorkLink
      if (plant === undefined) throw new Error('workLinkStore 가 켜진 출처는 plantWorkLink 가 있어야 한다')
      const link: WorkLink = { kind: 'worktree', path: '/tmp/l635-contract/shared', repoRoot: '/tmp/l635-contract' }
      const same = (records: WorkLinkRecord[]) => records.filter((record) => record.link.kind === 'worktree' && record.link.path === link.path)
      plant({ itemId: item.id, link, machine: 'l635-other-mac', repo: 'other' })
      expect(await target.service.storeLink({ connectionId: target.connectionId, itemId: item.id, link, action: 'save' })).toEqual({ state: 'saved', message: null })
      expect(await target.service.storeLink({ connectionId: target.connectionId, itemId: item.id, link, action: 'save' })).toEqual({ state: 'saved', message: null })
      const machine = await target.service.machine()
      const both = same((await getItem(item.id)).workLinks)
      expect(both.map((record) => record.machine).sort()).toEqual([machine, 'l635-other-mac'].sort())
      expect(await target.service.storeLink({ connectionId: target.connectionId, itemId: item.id, link, action: 'remove' })).toEqual({ state: 'saved', message: null })
      // 없는 링크를 다시 지워도 오류가 아니다.
      expect(await target.service.storeLink({ connectionId: target.connectionId, itemId: item.id, link, action: 'remove' })).toEqual({ state: 'saved', message: null })
      expect(same((await getItem(item.id)).workLinks)).toEqual([expect.objectContaining({ link, machine: 'l635-other-mac', repo: 'other' })])
    })

    // LIFE-603 R1-I — 자동 연결(브랜치 키로 붙은 링크)도 출처에 남긴다. 키로 작업을 찾아 저장 · 꺼진 출처는 키 찾기도 보내지 않는다.
    it('자동 연결 출처 저장(C14 · R1-I) — 켜져 있으면 키로 찾아 저장, 없는 키는 failed, 꺼져 있으면 skipped · 출처 요청 0', async () => {
      const { items, capabilities } = await stage()
      const item = items[0]
      if (item === undefined) throw new Error('no item')
      const link: WorkLink = { kind: 'worktree', path: '/tmp/l603-contract/auto', repoRoot: '/tmp/l603-contract' }
      const before = target.sourceRequests?.() ?? null
      const saved = await target.service.storeAutoLink({ connectionId: target.connectionId, key: item.key, link })
      const missing = await target.service.storeAutoLink({ connectionId: target.connectionId, key: target.missingKey, link })
      if (capabilities.workLinkStore.state !== 'on') {
        expect(saved?.state).toBe('skipped')
        expect(missing?.state).toBe('skipped')
        if (before !== null) expect(target.sourceRequests?.()).toBe(before)
        return
      }
      expect(saved).toEqual({ state: 'saved', message: null })
      expect(missing?.state).toBe('failed')
      const machine = await target.service.machine()
      expect((await getItem(item.id)).workLinks).toContainEqual(expect.objectContaining({ link, machine }))
      await target.service.storeLink({ connectionId: target.connectionId, itemId: item.id, link, action: 'remove' })
    })
  })
}
