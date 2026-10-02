// 렌더러 저장 화이트리스트 (LIFE-477 K7ⓔ · F10) — 옵션 칸을 바꾸면 그 칸이 `ui-prefs` 칸 이름으로 실린다. 빠지면 재시작 뒤 사라진다.
import { describe, expect, it } from 'vitest'
import { cardLayoutPreset, DEFAULT_SIDEBAR_VIEW, readSidebarView, sidebarViewToPrefs, type SidebarView } from '../../../shared/sidebar-view.js'
import { sidebarPrefsPatch } from './useSidebarView.js'

/** 칸마다 기본값과 다른 값 — 모든 칸이 한 번씩 바뀐다. */
const CHANGED: SidebarView = {
  groupBy: 'none',
  sortBy: 'smart',
  projectOrderBy: 'recent',
  repoFilter: ['/r/a'],
  hideDefaultBranch: true,
  hideDetachedHead: true,
  cardLayout: 'compact',
  cardProperties: [],
  agentActivityLayout: 'full',
}

describe('sidebarPrefsPatch — 저장 화이트리스트', () => {
  it('SidebarView 의 모든 칸이 빠짐없이 저장 칸으로 나간다(칸 하나씩)', () => {
    const keys = Object.keys(DEFAULT_SIDEBAR_VIEW)
    expect(keys).toHaveLength(Object.keys(sidebarViewToPrefs(DEFAULT_SIDEBAR_VIEW)).length)
    for (const key of keys) {
      const patch: Partial<SidebarView> = Object.fromEntries(Object.entries(CHANGED).filter(([name]) => name === key))
      const next = { ...DEFAULT_SIDEBAR_VIEW, ...patch }
      const written = sidebarPrefsPatch({ patch, next })
      expect(Object.keys(written), key).toHaveLength(1)
    }
  })

  it('K7ⓔ 왕복 — 쓴 칸을 저장 파일 모양으로 읽으면 같은 화면 값이다', () => {
    const written = sidebarPrefsPatch({ patch: CHANGED, next: CHANGED })
    expect(readSidebarView({ ...written })).toEqual(CHANGED)
  })

  it('레이아웃 프리셋은 레이아웃·속성 두 칸을 쓰고 에이전트 레이아웃은 안 쓴다(K5ⓑ)', () => {
    const next = { ...DEFAULT_SIDEBAR_VIEW, agentActivityLayout: 'full' as const, ...cardLayoutPreset('compact') }
    const written = sidebarPrefsPatch({ patch: cardLayoutPreset('compact'), next })
    expect(written).toEqual({ sidebarCardLayout: 'compact', sidebarCardProperties: [] })
  })
})
