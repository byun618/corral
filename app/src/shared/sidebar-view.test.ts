// 카드 표시 칸 (LIFE-477 K4·K5·K7) — 읽기 규칙·프리셋·에이전트 목록 표시 판정.
import { describe, expect, it } from 'vitest'
import { cardLayoutPreset, DEFAULT_SIDEBAR_VIEW, normalizeCardProperties, readSidebarView, showsInlineAgents } from './sidebar-view.js'

describe('기본값 = 지금 화면 (K7ⓑ)', () => {
  it('카드 표시 칸이 없는 파일은 Detailed · 에이전트 활동 켬 · Compact 에이전트', () => {
    const view = readSidebarView({ sidebarGroupBy: 'none', sidebarSortBy: 'recent' })
    expect(view.cardLayout).toBe('detailed')
    expect(view.cardProperties).toEqual(['inline-agents'])
    expect(view.agentActivityLayout).toBe('compact')
    expect(showsInlineAgents(view)).toBe(true)
    expect(readSidebarView({})).toEqual(DEFAULT_SIDEBAR_VIEW)
  })
})

describe('속성 정규화 — 198 `normalizeWorktreeCardProperties` (K7ⓓ)', () => {
  it('모르는 id 버림 · 중복 제거 · 정규 순서', () => {
    expect(normalizeCardProperties(['branch', 'inline-agents', 'inline-agents', 3, null])).toEqual(['inline-agents'])
    expect(normalizeCardProperties(['status', 'unread', 'pr'])).toEqual([])
  })
  it('배열이 아니면 기본값, 빈 배열은 빈 배열(198 `[]` → 고정 속성만)', () => {
    expect(normalizeCardProperties(undefined)).toEqual(['inline-agents'])
    expect(normalizeCardProperties('inline-agents')).toEqual(['inline-agents'])
    expect(normalizeCardProperties({})).toEqual(['inline-agents'])
    expect(normalizeCardProperties([])).toEqual([])
  })
  it('모르는 레이아웃 문자열·타입 틀림은 칸마다 기본값', () => {
    const view = readSidebarView({ sidebarCardLayout: 'Compact', sidebarAgentActivityLayout: 'FULL', sidebarCardProperties: 7, sidebarSortBy: 'name' })
    expect(view.cardLayout).toBe('detailed')
    expect(view.agentActivityLayout).toBe('compact')
    expect(view.cardProperties).toEqual(['inline-agents'])
    expect(view.sortBy).toBe('name')
  })
})

describe('레이아웃 프리셋 — 198 `getWorktreeCardModeUpdates` (K5 · 게이트 ⓪ Q2)', () => {
  it('Compact → 에이전트 활동 끔, Detailed → 켬', () => {
    expect(cardLayoutPreset('compact')).toEqual({ cardLayout: 'compact', cardProperties: [] })
    expect(cardLayoutPreset('detailed')).toEqual({ cardLayout: 'detailed', cardProperties: ['inline-agents'] })
  })
  it('ⓒ 같은 레이아웃을 다시 골라도 다시 적용된다 — Detailed 에서 끈 에이전트 활동이 Detailed 재선택으로 켜진다', () => {
    const off = { ...DEFAULT_SIDEBAR_VIEW, cardProperties: [] }
    expect({ ...off, ...cardLayoutPreset('detailed') }.cardProperties).toEqual(['inline-agents'])
  })
  it('ⓑ 에이전트 활동 레이아웃·다른 칸은 프리셋이 건드리지 않는다', () => {
    expect(Object.keys(cardLayoutPreset('compact')).sort()).toEqual(['cardLayout', 'cardProperties'])
  })
  it('프리셋 결과는 매번 새 배열이다(공유 상수를 고치지 않는다)', () => {
    const a = cardLayoutPreset('detailed')
    a.cardProperties.push('inline-agents')
    expect(cardLayoutPreset('detailed').cardProperties).toEqual(['inline-agents'])
  })
})

describe('에이전트 목록 표시 — 198 `showInlineAgentList` (K4 · F4)', () => {
  it('Detailed + 에이전트 활동 켬일 때만', () => {
    expect(showsInlineAgents({ cardLayout: 'detailed', cardProperties: ['inline-agents'] })).toBe(true)
    expect(showsInlineAgents({ cardLayout: 'detailed', cardProperties: [] })).toBe(false)
  })
  it('ⓒ Compact 카드는 켜져 있어도 그리지 않는다(198 그대로)', () => {
    expect(showsInlineAgents({ cardLayout: 'compact', cardProperties: ['inline-agents'] })).toBe(false)
  })
})
