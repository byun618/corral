// 폰 목록 하위 워크트리 묶음 · detached 라벨 (LIFE-588) — W3ⓐⓑⓒ · W4(폰 표시) · W5 · W6.
// 입력은 서버가 고정 상태 묶음으로 만든 실제 메시지(`fixtures/list-588-message.json` — app `list-588.test.ts` 가 서버 출력과 같은지 대조한다).
// 기준 화면은 기준 commit 3ce450656 의 파서·보기 사본(`fixtures/list-parser-base.ts`·`list-view-base.ts`)으로 만든다.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseListMessage, type ChannelList } from '../src/core/list'
import { buildListView, headerMeta, type ListView } from '../src/core/list-view'
import { parseListMessage as parseBase } from './fixtures/list-parser-base'
import { buildListView as buildBaseView } from './fixtures/list-view-base'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function loadMessage(): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/list-588-message.json'), 'utf8'))
  if (!isRecord(value)) throw new Error('고정본 모양')
  return value
}

/** 옛 서버 메시지 — 이 일감이 더한 칸(`label`·`groups`·채널 `group`)을 지운다. */
function withoutNewFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNewFields)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'label' && key !== 'groups' && key !== 'group')
      .map(([key, item]) => [key, withoutNewFields(item)]),
  )
}

function ready(list: ChannelList): Extract<ChannelList, { available: true }> {
  if (!list.available) throw new Error('목록 없음')
  return list
}

const base = { isUnread: () => false, isCollapsed: () => false, flashUntil: {}, now: 0, waitingExpanded: true }

function view(collapsed = false): ListView {
  const parsed = parseListMessage(loadMessage())
  if (parsed === null) throw new Error('파서 거절')
  return buildListView({ ...base, list: ready(parsed.list), isCollapsed: () => collapsed })
}

function featTask(value: ListView): ListView['repos'][number]['tasks'][number] {
  const found = value.repos[0]?.tasks.find((task) => task.name === 'feature/LIFE-564-mobile')
  if (found === undefined) throw new Error('작업 없음')
  return found
}

type Line = [kind: string, idOrLabel: string, worker: boolean | null, meta: string | null]

function lines(rows: ListView['repos'][number]['tasks'][number]['rows']): Line[] {
  return rows.map((row): Line => {
    switch (row.kind) {
      case 'group':
        return ['group', row.label, null, null]
      case 'ghost':
        return ['ghost', row.channel.id, row.worker, null]
      case 'channel':
        return ['channel', row.channel.id, row.worker, row.meta]
    }
  })
}

describe('W3 폰 보기 [D1·D4]', () => {
  it('ⓐ 하위 머리 행·순서 · 머리 아래 행 meta 에 `↳ ` 없음 · ⓑ 자국 행은 원래 하위 묶음 자리', () => {
    expect(lines(featTask(view()).rows)).toEqual([
      ['ghost', 'f1', false, null],
      ['channel', 'f2', true, null],
      ['channel', 'retained:rf', false, null],
      // 열린 세션 없는 하위의 보존 행 — 머리가 없어 `↳ 출신` 을 그대로 단다(D2).
      ['channel', 'retained:rn', false, '↳ no-live-child'],
      ['group', 'corral · Detached HEAD @ deadbee', null, null],
      ['channel', 'd1', false, '띄운 세션: 알 수 없음'],
      ['group', 'LIFE-581-mobile-chat', null, null],
      ['channel', 'a1', false, '띄운 세션: 묶음 코디'],
      ['channel', 'a2', true, null],
      ['channel', 'a3', false, null],
      ['channel', 'retained:ra', false, null],
      ['group', 'LIFE-581-mobile-chat-claude', null, null],
      ['channel', 'g1', false, '띄운 세션: 581 코디'],
      ['ghost', 'g2', false, null],
      ['group', 'LIFE-588-worktree-label', null, null],
      ['channel', 'b1', false, null],
    ])
  })

  it('ⓐ 위 섹션 crumb — 하위 출신은 `레포 › 작업 › 하위`, 루트 행은 `레포 › 작업`', () => {
    const value = view()
    expect(value.waiting.map((row) => [row.channel.id, row.meta])).toEqual([
      ['f1', 'corral › feature/LIFE-564-mobile'],
      ['g2', 'corral › feature/LIFE-564-mobile › LIFE-581-mobile-chat-claude'],
    ])
  })

  it('ⓐ 작업 머리 글 — detached 루트는 머리 꼴, 한 줄 자리(`name`)는 짧은 꼴', () => {
    const tasks = view().repos[0]?.tasks ?? []
    expect(tasks.map((task) => [task.name, task.label])).toEqual([
      ['corral', 'corral'],
      ['corral @ 7cb34f3', 'corral · Detached HEAD @ 7cb34f3'],
      ['feature/LIFE-564-mobile', 'feature/LIFE-564-mobile'],
    ])
  })

  it('ⓒ 작업 접힘 — 점·넘친 수·개수가 기준 보기와 같다(하위 세션 포함)', () => {
    const now = featTask(view(true))
    const parsedBase = parseBase(loadMessage())
    if (parsedBase === null || !parsedBase.list.available) throw new Error('기준 파서 거절')
    const old = buildBaseView({ ...base, list: parsedBase.list, isCollapsed: () => true }).repos[0]?.tasks.find((task) => task.name === 'feature/LIFE-564-mobile')
    expect(now.collapsed).toBe(true)
    expect({ dots: now.dots, extraDots: now.extraDots, count: now.count, liveDots: now.liveDots }).toEqual({
      dots: old?.dots,
      extraDots: old?.extraDots,
      count: old?.count,
      liveDots: old?.liveDots,
    })
    // 하위 세션이 개수에 든다: 루트 2 + 하위 7(d1·a1·a2·a3·g1·g2·b1).
    expect(now.count).toBe(9)
  })
})

describe('W5 대화 머리 [D3]', () => {
  it('detached 출신 채널의 headerMeta 가 `↳ <제목> @ <7자>`', () => {
    const parsed = parseListMessage(loadMessage())
    if (parsed === null || !parsed.list.available) throw new Error('파서 거절')
    const d1 = parsed.list.repos.flatMap((repo) => repo.tasks.flatMap((task) => task.channels)).find((channel) => channel.id === 'd1')
    if (d1 === undefined) throw new Error('채널 없음')
    expect(headerMeta(d1)).toBe('↳ corral @ deadbee · 띄운 세션: 알 수 없음')
  })
})

describe('W6 호환', () => {
  it('ⓐ 기준 commit 의 폰 파서가 새 서버 메시지를 거절하지 않는다', () => {
    const parsed = parseBase(loadMessage())
    expect(parsed).not.toBeNull()
    if (parsed === null || !parsed.list.available) throw new Error('기준 파서 거절')
    expect(parsed.list.repos.flatMap((repo) => repo.tasks.flatMap((task) => task.channels)).length).toBe(14)
    expect(parsed.list.waiting).toEqual(['f1', 'g2'])
  })

  it('ⓑ 새 폰이 하위 묶음 칸 없는 옛 메시지를 받으면 기준과 같은 화면(평탄 + `↳ 출신`)', () => {
    const old = withoutNewFields(loadMessage())
    if (!isRecord(old)) throw new Error('모양')
    const parsedNew = parseListMessage(old)
    const parsedOld = parseBase(old)
    if (parsedNew === null || parsedOld === null || !parsedNew.list.available || !parsedOld.list.available) throw new Error('거절')
    const now = buildListView({ ...base, list: parsedNew.list })
    const then = buildBaseView({ ...base, list: parsedOld.list })
    const rowsNow = now.repos.map((repo) => [repo.name, repo.tasks.map((task) => [task.name, lines(task.rows)])])
    const rowsThen = then.repos.map((repo) => [
      repo.name,
      repo.tasks.map((task) => [task.name, task.rows.map((row): Line => (row.kind === 'ghost' ? ['ghost', row.channel.id, row.worker, null] : ['channel', row.channel.id, row.worker, row.meta]))]),
    ])
    // 옛 메시지에는 묶음 머리가 하나도 없다.
    expect(now.repos.flatMap((repo) => repo.tasks.flatMap((task) => task.rows)).some((row) => row.kind === 'group')).toBe(false)
    expect(rowsNow).toEqual(rowsThen)
    expect(now.waiting.map((row) => row.meta)).toEqual(then.waiting.map((row) => row.meta))
    // 양성 대조: 평탄 행에 `↳ 출신` 이 실제로 붙는다.
    expect(lines(featTask(now).rows)).toContainEqual(['channel', 'a3', false, '↳ LIFE-581-mobile-chat'])
  })

  it('ⓑ 묶음 칸 모양이 틀려도 목록 전체를 거절하지 않는다 — 틀린 묶음만 버리고 그 채널은 평탄 행 + `↳ 출신`', () => {
    const detachedGroup = { id: 'ab37aaf4d00334c1', name: 'corral @ deadbee', label: 'corral · Detached HEAD @ deadbee' }
    const parsed = parseListMessage(withGroups(loadMessage(), [{ id: 5 }, 'x', { id: 'dfa7d11e93f9dac5' }, detachedGroup]))
    if (parsed === null || !parsed.list.available) throw new Error('거절')
    const rows = lines(featTask(buildListView({ ...base, list: parsed.list })).rows)
    expect(rows.filter(([kind]) => kind === 'group')).toEqual([['group', 'corral · Detached HEAD @ deadbee', null, null]])
    expect(rows).toContainEqual(['channel', 'a3', false, '↳ LIFE-581-mobile-chat'])
  })
})

/** feature 작업의 `groups` 를 바꾼 메시지. */
function withGroups(message: Record<string, unknown>, groups: unknown[]): Record<string, unknown> {
  const list = message.list
  if (!isRecord(list) || !Array.isArray(list.repos)) throw new Error('모양')
  return {
    ...message,
    list: {
      ...list,
      repos: list.repos.map((repo: unknown) => {
        if (!isRecord(repo) || !Array.isArray(repo.tasks)) return repo
        return { ...repo, tasks: repo.tasks.map((task: unknown) => (isRecord(task) && task.name === 'feature/LIFE-564-mobile' ? { ...task, groups } : task)) }
      }),
    },
  }
}
