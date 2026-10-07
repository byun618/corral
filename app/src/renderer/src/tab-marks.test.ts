// LIFE-495 K3ⓔ·K4ⓒ·K9ⓒ — 탭 핀·색 영속 칸의 읽기·쓰기·정리.
import { describe, expect, it } from 'vitest'
import { keepHerdrTabMarks, keepLiveTabMarks, markOf, pinnedTabIds, readTabMarks, setTabColor, setTabPinned, TAB_COLORS, type TabMark } from './tab-marks.js'

const at = { tabId: 'w1:t1', workspaceId: 'w1' }

describe('readTabMarks — 옛 파일·손상 칸', () => {
  it('칸이 없는 옛 ui-prefs(undefined)·배열 아님은 빈 목록이다(K9ⓒ)', () => {
    expect(readTabMarks(undefined)).toEqual([])
    expect(readTabMarks({ tabId: 'x' })).toEqual([])
  })
  it('모르는 색은 버리고, 빈 id·기본값·중복은 뺀다', () => {
    const rows = readTabMarks([
      { tabId: 'a', workspaceId: 'w', pinned: true, color: '#123456' },
      { tabId: '', workspaceId: 'w', pinned: true, color: null },
      { tabId: 'b', workspaceId: 'w', pinned: false, color: null },
      { tabId: 'c', workspaceId: 'w', pinned: false, color: '#22c55e' },
      { tabId: 'c', workspaceId: 'w', pinned: true, color: null },
      null,
    ])
    expect(rows).toEqual([
      { tabId: 'a', workspaceId: 'w', pinned: true, color: null },
      { tabId: 'c', workspaceId: 'w', pinned: false, color: '#22c55e' },
    ])
  })
})

describe('setTabPinned · setTabColor', () => {
  it('핀·색을 켜고 끈다 — 둘 다 기본값이 되면 칸이 사라진다(쌓이지 않는다)', () => {
    let marks: TabMark[] = []
    marks = setTabPinned({ marks, ...at, pinned: true })
    marks = setTabColor({ marks, ...at, color: '#3b82f6' })
    expect(markOf({ marks, ...at })).toEqual({ ...at, pinned: true, color: '#3b82f6' })
    expect(pinnedTabIds(marks)).toEqual(new Set(['w1:t1']))
    marks = setTabPinned({ marks, ...at, pinned: false })
    expect(markOf({ marks, ...at })).toEqual({ ...at, pinned: false, color: '#3b82f6' })
    marks = setTabColor({ marks, ...at, color: null })
    expect(marks).toEqual([])
  })
  it('목록에 없는 색 값은 없음으로 친다', () => {
    expect(setTabColor({ marks: [], ...at, color: 'red' })).toEqual([])
  })
  it('색 10개 = None + 220 9색', () => {
    expect(TAB_COLORS.map((entry) => entry.value)).toEqual([null, '#3b82f6', '#a855f7', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#9ca3af'])
  })
})

describe('keepLiveTabMarks — 닫힌 탭의 값이 쌓이지 않는다(K4ⓒ 정리 규칙)', () => {
  const marks: TabMark[] = [
    { tabId: 'w1:t1', workspaceId: 'w1', pinned: true, color: null },
    { tabId: 'w1:t2', workspaceId: 'w1', pinned: false, color: '#ef4444' },
    { tabId: 'w2:t1', workspaceId: 'w2', pinned: true, color: null },
  ]
  it('보이는 워크스페이스의 죽은 탭만 지운다', () => {
    expect(keepLiveTabMarks({ marks, liveTabIds: ['w1:t1'], shownWorkspaceIds: ['w1'] })).toEqual([marks[0], marks[2]])
  })
  it('보이지 않는 워크스페이스의 칸은 둔다 — 상태가 덜 온 순간 통째로 날아가지 않게', () => {
    expect(keepLiveTabMarks({ marks, liveTabIds: [], shownWorkspaceIds: [] })).toEqual(marks)
  })
})

describe('keepHerdrTabMarks — herdr 세션 전체에 없는 탭의 칸 (LIFE-507 K1)', () => {
  const marks: TabMark[] = [
    { tabId: 'w1:t1', workspaceId: 'w1', pinned: true, color: '#22c55e' },
    { tabId: 'w2:t3', workspaceId: 'w2', pinned: true, color: '#ef4444' },
    { tabId: 'w2:t4', workspaceId: 'w2', pinned: false, color: '#3b82f6' },
  ]
  it('닫힌 워크스페이스(w2)의 칸은 보이든 안 보이든 지운다 — 재기동 뒤 id 를 다시 받은 새 탭 w2:t3 에 붙지 않게', () => {
    expect(keepHerdrTabMarks({ marks, herdrTabIds: ['w1:t1', 'w1:t2'] })).toEqual([marks[0]])
  })
  it('herdr 에 있는 탭(등록 레포 밖 워크스페이스 포함)의 칸은 둔다 — 화면에 안 보여도', () => {
    expect(keepHerdrTabMarks({ marks, herdrTabIds: ['w1:t1', 'w2:t3', 'w2:t4', 'w9:t1'] })).toEqual(marks)
  })
  it('herdr 탭이 하나도 없으면(세션이 비었다 — live 의 빈 목록) 전부 지운다', () => {
    expect(keepHerdrTabMarks({ marks, herdrTabIds: [] })).toEqual([])
  })
  it('새 배열을 돌려준다(입력 불변)', () => {
    const next = keepHerdrTabMarks({ marks, herdrTabIds: ['w1:t1', 'w2:t3', 'w2:t4'] })
    expect(next).not.toBe(marks)
    expect(marks).toHaveLength(3)
  })
})
