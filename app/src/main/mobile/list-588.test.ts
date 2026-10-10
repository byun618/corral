// 폰 목록 하위 워크트리 묶음 · detached 라벨 (LIFE-588) — W1 · W2 · W4 · W5(서버 출신 글) · W6 고정본 동기.
//
// 기대값은 데스크톱 함수(`nestSectionItems`·`worktreeDisplayName`·`worktreeIdentity`·`distinctWorktreeName`)를 **여기서 따로** 불러 만든다.
// 기준선(수정 전 서버 출력)은 `specs/LIFE-588-worktree-label/raw/claude/b01-baseline.json` — 아래 BASE_* 는 그 파일에서 옮긴 값이다.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildSidebarSections, lineageGraph, nestSectionItems } from '../../shared/sidebar-sections.js'
import type { WorktreeRow } from '../../shared/types.js'
import { worktreeIdentity } from '../../shared/worktree-identity.js'
import { distinctWorktreeName, worktreeDisplayName } from '../../shared/worktree-name.js'
import type { ListMessage } from './feed.js'
import { buildMobileList, opaqueId, phoneOrder, phoneView, worktreeLabels, type MobileChannel, type MobileList, type MobileTask } from './list.js'
import { FIXTURE_NOW, fixtureWorktree } from './list-fixture.js'
import { DETACHED_ROOT_HEAD, DETACHED_SUB_HEAD, worktreeFixture } from './list-588-fixture.js'

const BASE_TASK_IDS = ['13a3525f97182867', '869a49d46f58cc50', '94015dca56a304f5']
const BASE_WAITING = ['f1', 'g2']
const BASE_CHANNELS = [
  ['h1'],
  ['r1'],
  ['f1', 'f2', 'd1', 'a1', 'a2', 'a3', 'g1', 'g2', 'b1', 'retained:rf', 'retained:ra', 'retained:rn'],
]
/** 기준선의 대화 머리 `parent` — W4ⓓ 는 이것과 같아야 한다. */
const BASE_PARENT: Record<string, { title: string | null } | null> = {
  h1: null,
  r1: null,
  f1: null,
  f2: { title: '묶음 코디' },
  d1: { title: null },
  a1: { title: '묶음 코디' },
  a2: { title: '581 코디' },
  a3: null,
  g1: { title: '581 코디' },
  g2: null,
  b1: null,
  'retained:rf': null,
  'retained:ra': null,
  'retained:rn': null,
}

function build(): Extract<MobileList, { available: true }> {
  const list = buildMobileList({ state: worktreeFixture(), prefs: null, now: FIXTURE_NOW })
  if (!list.available) throw new Error('목록 없음')
  return list
}

function tasks(list: Extract<MobileList, { available: true }>): MobileTask[] {
  return list.repos.flatMap((repo) => repo.tasks)
}

function channel(list: Extract<MobileList, { available: true }>, id: string): MobileChannel {
  const found = tasks(list)
    .flatMap((task) => task.channels)
    .find((item) => item.id === id)
  if (found === undefined) throw new Error(`채널 없음: ${id}`)
  return found
}

function feat(list: Extract<MobileList, { available: true }>): MobileTask {
  const found = tasks(list).find((task) => task.id === opaqueId('/fx588/wt/feat'))
  if (found === undefined) throw new Error('작업 없음')
  return found
}

/** 데스크톱 쪽 기대 — 머리 꼴 = 카드 제목 + 메타 배지 글(`WorktreeBlock` 과 같은 두 함수), 한 줄 꼴 = `distinctWorktreeName`. */
function desktopLabels(worktree: WorktreeRow): { name: string; label: string } {
  const identity = worktreeIdentity(worktree)
  return {
    name: distinctWorktreeName(worktree),
    label: identity?.kind === 'detached' ? `${worktreeDisplayName(worktree)} · ${identity.sidebarLabel}` : worktreeDisplayName(worktree),
  }
}

describe('W1 서버 목록 — 하위 경계 보존 [D1·D2]', () => {
  const list = build()

  it('ⓐ 작업마다 하위 묶음이 nestSectionItems descendants 순서로 오고 이름이 데스크톱 함수 결과와 같다', () => {
    const state = worktreeFixture()
    const sections = buildSidebarSections({ repos: state.repos, view: phoneView(null), order: phoneOrder(null), now: FIXTURE_NOW })
    const graph = lineageGraph(state.repos)
    const expected = new Map<string, { id: string; name: string; label: string }[]>()
    for (const section of sections) {
      if (section.kind !== 'repo') continue
      for (const unit of nestSectionItems({ items: section.items, collapsed: new Set(), graph })) {
        const groups = unit.descendants
          .map((row) => row.item.worktree)
          // D2 — 열린 AI 세션 있는 하위만(이 묶음에서는 셸만 있는 `/fx588/wt/none`).
          .filter((worktree) => worktree.path !== '/fx588/wt/none')
          .map((worktree) => ({ id: opaqueId(worktree.path), ...desktopLabels(worktree) }))
        expected.set(opaqueId(unit.root.item.worktree.path), groups)
      }
    }
    for (const task of tasks(list)) expect(task.groups).toEqual(expected.get(task.id))
    // 양성 대조: 묶음이 실제로 있다 — 하위 2 + 손자 1 + detached 1, 손자는 부모 바로 뒤(깊이 우선).
    expect(feat(list).groups.map((group) => group.label)).toEqual([
      `corral · Detached HEAD @ ${DETACHED_SUB_HEAD.slice(0, 7)}`,
      'LIFE-581-mobile-chat',
      'LIFE-581-mobile-chat-claude',
      'LIFE-588-worktree-label',
    ])
  })

  it('ⓑ 채널 id 열 — 열린 행 순서는 기준과 같다 · 닫힌 행만 자기 묶음 끝으로(사유 RESULT.md W1ⓑ)', () => {
    const now = tasks(list).map((task) => task.channels.map((item) => item.id))
    // 같은 채널 집합(빠짐·더함 없음).
    expect(now.map((ids) => [...ids].sort())).toEqual(BASE_CHANNELS.map((ids) => [...ids].sort()))
    // 열린 행의 상대 순서는 기준 그대로.
    const liveOnly = (ids: readonly string[]): string[] => ids.filter((id) => !id.startsWith('retained:'))
    expect(now.map(liveOnly)).toEqual(BASE_CHANNELS.map(liveOnly))
    // 바뀐 자리: 루트 보존 행 rf · 머리 없는 하위의 보존 행 rn → 루트 묶음 끝, ra → 581 묶음 끝.
    expect(feat(list).channels.map((item) => item.id)).toEqual(['f1', 'f2', 'retained:rf', 'retained:rn', 'd1', 'a1', 'a2', 'a3', 'retained:ra', 'g1', 'g2', 'b1'])
    // 채널을 묶음 순서대로 펼치면 `channels` 그대로다 — 한 묶음의 채널은 이어져 있다(폰은 이 열을 순서대로 그린다).
    const runs = feat(list).channels.map((item) => item.group).filter((group, index, all) => index === 0 || all[index - 1] !== group)
    expect(runs).toEqual([null, ...feat(list).groups.map((group) => group.id)])
  })

  it('ⓒ 열린 세션 없는 하위 묶음 0건 — 그 하위의 보존 행은 머리 없이 `↳ 출신` 으로 남는다', () => {
    for (const task of tasks(list)) {
      for (const group of task.groups) expect(task.channels.some((item) => item.group === group.id && item.status === 'live')).toBe(true)
    }
    expect(feat(list).groups.map((group) => group.id)).not.toContain(opaqueId('/fx588/wt/none'))
    expect(channel(list, 'retained:rn')).toMatchObject({ group: null, origin: 'no-live-child' })
  })

  it('ⓓ 작업 수·작업 id·waiting 이 기준과 같다', () => {
    expect(tasks(list).map((task) => task.id)).toEqual(BASE_TASK_IDS)
    expect(list.waiting).toEqual(BASE_WAITING)
  })
})

describe('W2 detached 라벨 [D3] — 데스크톱 함수 결과 그대로', () => {
  const base = { repoName: 'corral', panes: null }
  const branch = fixtureWorktree({ ...base, path: '/x/branch', branch: 'LIFE-581-mobile-chat' })
  const detachedRow = { ...fixtureWorktree({ ...base, path: '/x/det', branch: 'x' }), branch: null, head: DETACHED_SUB_HEAD }
  const headless = { ...fixtureWorktree({ ...base, path: '/x/bare', branch: 'x' }), branch: null, head: null }

  it('4종 — detached 하위 · detached 루트 작업 · 브랜치 · HEAD 없음', () => {
    expect(worktreeLabels(detachedRow)).toEqual({ name: 'corral @ deadbee', label: 'corral · Detached HEAD @ deadbee' })
    expect(worktreeLabels(branch)).toEqual({ name: 'LIFE-581-mobile-chat', label: 'LIFE-581-mobile-chat' })
    expect(worktreeLabels(headless)).toEqual({ name: 'corral', label: 'corral' })
    for (const row of [branch, detachedRow, headless]) expect(worktreeLabels(row)).toEqual(desktopLabels(row))
    const list = build()
    const root = tasks(list).find((task) => task.id === opaqueId('/fx588/wt/det-root'))
    expect(root).toMatchObject({ name: `corral @ ${DETACHED_ROOT_HEAD.slice(0, 7)}`, label: `corral · Detached HEAD @ ${DETACHED_ROOT_HEAD.slice(0, 7)}` })
    const bare = tasks(list).find((task) => task.id === opaqueId('/fx588/wt/bare'))
    expect(bare).toMatchObject({ name: 'corral', label: 'corral' })
    expect(feat(list)).toMatchObject({ name: 'feature/LIFE-564-mobile', label: 'feature/LIFE-564-mobile' })
  })
})

describe('W4 들여쓰기 뜻 [D5]', () => {
  const list = build()

  it('ⓐ 계보 부모 없는 하위 출신 행은 들여 쓰지 않는다', () => {
    expect(channel(list, 'a3')).toMatchObject({ depth: 0, spawnedBy: null, origin: 'LIFE-581-mobile-chat' })
    expect(channel(list, 'b1')).toMatchObject({ depth: 0, spawnedBy: null })
  })

  it('ⓑ 같은 하위 묶음 안 계보 자식은 들여 쓴다(└)', () => {
    expect(channel(list, 'a2')).toMatchObject({ depth: 1, spawnedBy: null })
    // 양성 대조: 루트 묶음 안 워커도 그대로.
    expect(channel(list, 'f2')).toMatchObject({ depth: 1, spawnedBy: null })
  })

  it('ⓒ 부모가 다른 하위 묶음·루트 쪽이거나 모르면 `띄운 세션`', () => {
    expect(channel(list, 'a1')).toMatchObject({ depth: 0, spawnedBy: { title: '묶음 코디' } })
    expect(channel(list, 'g1')).toMatchObject({ depth: 0, spawnedBy: { title: '581 코디' } })
    expect(channel(list, 'd1')).toMatchObject({ depth: 0, spawnedBy: { title: null } })
  })

  it('ⓓ 대화 머리 `parent` 는 기준과 같다', () => {
    const now = Object.fromEntries(tasks(list).flatMap((task) => task.channels.map((item) => [item.id, item.parent])))
    expect(now).toEqual(BASE_PARENT)
  })
})

describe('W5 대화 머리 출신 글 [D3] — 서버가 짧은 꼴을 싣는다', () => {
  it('detached 출신 `origin` = `<제목> @ <7자>` · 브랜치 출신은 그대로', () => {
    const list = build()
    expect(channel(list, 'd1').origin).toBe('corral @ deadbee')
    expect(channel(list, 'g1').origin).toBe('LIFE-581-mobile-chat-claude')
  })
})

describe('W6 폰 시험 고정본 = 지금 서버 출력', () => {
  it('`mobile/test/fixtures/list-588-message.json` 의 list 가 buildMobileList 결과와 같다', () => {
    const raw: unknown = JSON.parse(fs.readFileSync(new URL('../../../../mobile/test/fixtures/list-588-message.json', import.meta.url), 'utf8'))
    const expected: ListMessage = { type: 'list', epoch: 'e588', seq: 1, at: FIXTURE_NOW, changedAt: FIXTURE_NOW, list: build() }
    expect(raw).toEqual(JSON.parse(JSON.stringify(expected)))
  })
})
