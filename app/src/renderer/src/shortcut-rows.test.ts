// LIFE-511 K6ⓑⓒ — 단축키 섹션 표 모델: 그룹 매핑·필터 카운트·섹션 안 검색·저장 전 충돌.
import { describe, expect, it } from 'vitest'
import { ACTIONS, validateOverrides } from '../../shared/keybindings.js'
import { candidateStatus, SHORTCUT_GROUPS, shortcutFilterCounts, shortcutRows, visibleShortcutGroups, withSlot } from './shortcut-rows.js'

// 'tab.*' 액션 id 를 글자로 적지 않는다 — 경계 검사(check:boundary R4)가 herdr 메서드 이름으로 본다. ACTIONS 에서 뜻으로 찾는다.
const NTH_TAB = ACTIONS.find((action) => action.variants.length === 9)!.id
const groupIds = (title: string): readonly string[] => SHORTCUT_GROUPS.find((group) => group.title === title)!.ids

describe('그룹 매핑', () => {
  it('ACTIONS 의 모든 액션이 정확히 한 그룹에 한 번 든다', () => {
    const listed = SHORTCUT_GROUPS.flatMap((group) => group.ids)
    expect([...listed].sort()).toEqual(ACTIONS.map((action) => action.id).sort())
    expect(new Set(listed).size).toBe(listed.length)
    expect(SHORTCUT_GROUPS.map((group) => [group.title, group.ids.length])).toEqual([['전역', 6], ['탭', 3], ['탭 이동', 3], ['터미널 pane', 6]])
  })
  it('행 칸 수 = 기본 조합 수, 칸 이름 = variants', () => {
    const focus = shortcutRows({}).find((row) => row.action.id === 'terminal.focus')!
    expect(focus.slots).toHaveLength(8)
    expect(focus.slots.map((slot) => slot.label)).toEqual(['왼쪽', '오른쪽', '위', '아래', '왼쪽', '오른쪽', '위', '아래'])
  })
})

describe('필터 — All / Modified / Unassigned / Conflicts', () => {
  it('재정의 없으면 Modified 0 · Unassigned 0 · Conflicts 0', () => {
    expect(shortcutFilterCounts({ rows: shortcutRows({}), query: '' })).toEqual({ all: ACTIONS.length, modified: 0, unassigned: 0, conflicts: 0 })
  })
  it('재정의·끈 액션·비켜 선 기본값이 카운트에 든다', () => {
    // ⌘J 를 팔레트에 주면 「검색 (팔레트)」 기본값이 비켜 서지만(칸 null) 재정의는 아니다 — 모든 칸이 null 이라 Unassigned.
    const overrides = validateOverrides({ 'palette.open': ['Mod+J'], 'terminal.zoom': [null, null] })
    const rows = shortcutRows(overrides)
    expect(shortcutFilterCounts({ rows, query: '' })).toEqual({ all: ACTIONS.length, modified: 2, unassigned: 2, conflicts: 0 })
    expect(visibleShortcutGroups({ rows, filter: 'unassigned', query: '' }).flatMap((group) => group.rows.map((row) => row.action.id))).toEqual(['palette.search', 'terminal.zoom'])
    expect(visibleShortcutGroups({ rows, filter: 'modified', query: '' }).flatMap((group) => group.rows.map((row) => row.action.id))).toEqual(['palette.open', 'terminal.zoom'])
  })
  it('Conflicts — 지금 조합이 두 칸에 걸리면 센다(검증 안 된 재정의를 직접 넣은 경우)', () => {
    const rows = shortcutRows({ 'sidebar.toggle': ['Mod+K'] })
    expect(shortcutFilterCounts({ rows, query: '' }).conflicts).toBe(2)
    expect(rows.find((row) => row.action.id === 'sidebar.toggle')!.conflicts).toEqual(['⌘K'])
  })
})

describe('필터 카운트 = 검색 적용 뒤·상태 필터 전 집합 (r1 R1-03, Orca shortcut-row-visibility.ts:77)', () => {
  it('끈 액션이 있어도 검색이 그 행을 거르면 Modified·Unassigned 에 세지 않는다', () => {
    const rows = shortcutRows(validateOverrides({ 'terminal.zoom': [null, null] }))
    expect(shortcutFilterCounts({ rows, query: '' })).toEqual({ all: ACTIONS.length, modified: 1, unassigned: 1, conflicts: 0 })
    expect(shortcutFilterCounts({ rows, query: '설정' })).toEqual({ all: 1, modified: 0, unassigned: 0, conflicts: 0 })
    expect(shortcutFilterCounts({ rows, query: '줌' })).toEqual({ all: 1, modified: 1, unassigned: 1, conflicts: 0 })
  })
  it('카운트 = 그 필터를 눌렀을 때 보일 행 수', () => {
    const rows = shortcutRows(validateOverrides({ 'terminal.zoom': [null, null], 'palette.open': ['Mod+J'] }))
    for (const query of ['', '팔레트', 'pane', '없는 것']) {
      const counts = shortcutFilterCounts({ rows, query })
      for (const filter of ['all', 'modified', 'unassigned', 'conflicts'] as const) {
        const shown = visibleShortcutGroups({ rows, filter, query }).reduce((sum, group) => sum + group.rows.length, 0)
        expect([query, filter, counts[filter]]).toEqual([query, filter, shown])
      }
    }
  })
})

describe('섹션 안 검색 — 이름·id·그룹·칸·조합 기호', () => {
  const ids = (query: string): string[] => visibleShortcutGroups({ rows: shortcutRows({}), filter: 'all', query }).flatMap((group) => group.rows.map((row) => row.action.id))
  it.each([
    ['설정', ['settings.open']],
    ['⌘,', ['settings.open']],
    ['palette', ['palette.open', 'palette.search']],
    ['탭 이동', groupIds('탭 이동')],
    ['⌃tab', ['mru.open']],
    ['없는 것', []],
  ])('%s', (query, expected) => {
    expect(ids(query)).toEqual(expected)
  })
})

describe('저장 전 충돌 판정 (K6ⓒ)', () => {
  it('기본값을 쥔 다른 액션과 겹치면 conflict — 그 액션 이름이 문구에 있다', () => {
    const status = candidateStatus({ overrides: {}, id: 'sidebar.toggle', variant: 0, binding: 'Mod+K' })
    expect(status.kind).toBe('conflict')
    expect(status.kind === 'conflict' ? status.message : '').toMatch(/커맨드 팔레트/)
  })
  it('같은 액션의 다른 칸과 겹쳐도 conflict', () => {
    expect(candidateStatus({ overrides: {}, id: 'terminal.split', variant: 1, binding: 'Mod+D' }).kind).toBe('conflict')
  })
  it('양보 기본값이 쥔 조합이면 displaces — 그 액션은 「없음」 이 된다', () => {
    const status = candidateStatus({ overrides: {}, id: 'sidebar.toggle', variant: 0, binding: 'Mod+J' })
    expect(status.kind).toBe('displaces')
    expect(status.kind === 'displaces' ? status.title : '').toBe('검색 (팔레트)')
  })
  it('빈 조합이면 ok, 지금 조합과 같으면 same', () => {
    const ok = candidateStatus({ overrides: {}, id: 'sidebar.toggle', variant: 0, binding: 'Control+G' })
    expect(ok).toEqual({ kind: 'ok', next: { 'sidebar.toggle': ['Control+G'] } })
    expect(candidateStatus({ overrides: {}, id: 'sidebar.toggle', variant: 0, binding: 'Mod+B' })).toEqual({ kind: 'same' })
  })
  it('withSlot 은 비켜 선 빈 칸(null)을 빈 칸 그대로 둔다(LIFE-495 fix2 R2-01)', () => {
    const overrides = validateOverrides({ 'sidebar.toggle': ['Control+1'] })
    expect(withSlot({ overrides, id: NTH_TAB, variant: 1, binding: 'Control+G' })[NTH_TAB]?.slice(0, 3)).toEqual([null, 'Control+G', 'Control+3'])
  })
})
