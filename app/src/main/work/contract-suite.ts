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
  type WorkItem,
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
}

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
        await expectClosed({ capability: capabilities.conflictCheck, call: { op: 'setPlacement', itemId: item.id, placement: 'board', ifVersion: 'stale' } })
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

    it('필드 수정(E4) — 제목·본문·우선순위·마감을 보낸 칸만 바꾸고 되돌린다, 본문은 바이트 그대로', async () => {
      const { items, capabilities } = await stage()
      const item = await getItem((items[0] ?? { id: '' }).id)
      const body = '# 제목\r\n\n- [ ] 한글 체크\n- [x] 끝\n\n```\n<b>raw</b>\n```\n  끝 공백  \n'
      const due = '2026-11-01T14:59:00.000Z'
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

    it('완료 갈래(E5) — 완료 분류로 「취소함」·「완료함」 을 고르고, 갈래만 바꾸고, 되돌리면 갈래가 비운다', async () => {
      const { items, statuses } = await stage()
      const item = await getItem((items.find((entry) => entry.category !== 'done') ?? items[0] ?? { id: '' }).id)
      const done = statuses.find((status) => status.category === 'done')
      const original = statuses.find((status) => status.key === item.statusKey)
      if (done === undefined || original === undefined) throw new Error('완료 상태가 없다')
      expect(item.resolution).toBeNull()
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
  })
}
