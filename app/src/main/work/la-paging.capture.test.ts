// LIFE-638 C2 — 목록 결과를 원자료로 뜬다(`L638_CAPTURE=<경로>` 일 때만). 수정 전 commit(BFS)에서 뜬 것이 C2 비교의 기준이다.
// 스페이스마다 커서를 끝까지 따라가 작업 집합(id · key · parentId · spaceKey)을 id 순으로 적는다. 커서가 꺼진 코드는 한 쪽에 끝난다. 수정 뒤 대조 = `L638_PAGE_SIZE=2`.
import { writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import type { WorkCall, WorkItem } from '../../shared/work.js'
import { pagingSeed } from './la-paging-seed.js'
import { FAKE_LA_TOKEN, laFixtureHarness } from './test-kit.js'

const out = process.env.L638_CAPTURE
/** 수정 뒤 커서 쪽 크기(`L638_PAGE_SIZE`) — 수정 전 commit 에는 이 옵션이 없어 무시된다. */
const pageSize = process.env.L638_PAGE_SIZE === undefined ? undefined : Number(process.env.L638_PAGE_SIZE)

it.skipIf(out === undefined)('목록 원자료 뜨기 — 기본 씨앗 · 페이지 씨앗', async () => {
  const capture: Record<string, unknown> = {}
  for (const seed of ['default', 'paging'] as const) {
    const harness = await laFixtureHarness({ pageSize })
    if (seed === 'paging') harness.fixture.issues = pagingSeed(harness.fixture.issues)
    const added = await harness.service.addConnection({ sourceId: 'la', token: FAKE_LA_TOKEN, replaceId: null })
    if (!added.ok) throw new Error(added.error.message)
    let n = 0
    const send = async (call: WorkCall) => {
      const response = await harness.service.request({ requestId: `cap-${++n}`, connectionId: added.connection.id, call })
      if (!response.ok) throw new Error(`${call.op}: ${response.error.kind} ${response.error.message}`)
      return response.result
    }
    const spaces = await send({ op: 'listSpaces' })
    if (spaces.op !== 'listSpaces') throw new Error(spaces.op)
    const bySpace: Record<string, { pages: number; truncated: boolean; items: Pick<WorkItem, 'id' | 'key' | 'parentId' | 'spaceKey'>[] }> = {}
    for (const space of spaces.spaces) {
      const items: WorkItem[] = []
      let cursor: string | null = null
      let pages = 0
      let truncated = false
      do {
        const page = await send({ op: 'listItems', spaceKey: space.key, cursor })
        if (page.op !== 'listItems') throw new Error(page.op)
        items.push(...page.items)
        truncated ||= page.truncated
        cursor = page.nextCursor
        pages += 1
      } while (cursor !== null && pages < 100)
      bySpace[space.key] = { pages, truncated, items: items.map(({ id, key, parentId, spaceKey }) => ({ id, key, parentId, spaceKey })).sort((a, b) => a.id.localeCompare(b.id)) }
    }
    capture[seed] = bySpace
    await harness.fixture.stop()
  }
  if (out !== undefined) writeFileSync(out, `${JSON.stringify(capture, null, 2)}\n`)
  expect(Object.keys(capture)).toHaveLength(2)
})
