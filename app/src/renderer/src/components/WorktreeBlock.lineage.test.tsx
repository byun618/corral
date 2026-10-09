// 카드 계보 표시 (LIFE-576 K1ⓑ·K3ⓑ) — 「N 하위」 칩·셰브론, 부모 카드 행 안의 후손, 단계 들여쓰기, 상위 지정 드롭 강조.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { OrchestrationLineage, WorktreeRow } from '../../../shared/types.js'
import { NO_CARD_ACTIONS, NO_NEST, WorktreeBlock, type CardNest } from './WorktreeBlock.js'

const READY_EMPTY: OrchestrationLineage = { state: 'ready', entries: [] }
const noop = (): void => {}

function row(path: string): WorktreeRow {
  return {
    path, branch: path.slice(1), isLinked: true, head: null, repoName: 'repo', openWorkspaceId: null, workspace: null,
    gitStatus: { branch: path.slice(1), upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null },
    displayName: null, comment: null, parentPath: null,
  }
}

function card(path: string, nest: Partial<CardNest> = {}, parentName: string | null = null): React.JSX.Element {
  return createElement(WorktreeBlock, {
    key: path,
    worktree: row(path), reordering: false, dragging: false, onCardMouseDown: noop, selected: false, selectedPane: null, groupGlyph: null,
    integrations: [], home: '/home', now: 0, retained: [], lineage: READY_EMPTY, livePaneIds: new Set<string>(), groupExpanded: false,
    onToggleGroup: noop, onSelectBlock: noop, onSelectSession: noop, onCloseSession: noop, onCloseWorktree: noop, onCreateShell: noop, onCreateAgent: noop,
    card: { ...NO_CARD_ACTIONS, parentName },
    nest: { ...NO_NEST, ...nest },
  })
}

describe('「N 하위」 칩 + 셰브론 (Orca main `worktree-card-secondary-rows.tsx`)', () => {
  it('자식이 있으면 칩(직계 자식 수·펼침 상태) + 후손을 카드 행 안에 그린다', () => {
    const html = renderToStaticMarkup(card('/coord', { childCount: 2, children: [card('/impl', { depth: 1 }), card('/review', { depth: 1 })] }))
    expect(html).toContain('data-lineage-toggle="/coord"')
    expect(html).toContain('2 하위')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('data-lineage-children="/coord"')
    // 후손 행은 부모 행(`data-worktree="/coord"`) 안 — 부모 행이 닫히기 전에 나온다.
    const parentOpen = html.indexOf('data-worktree="/coord"')
    expect(html.indexOf('data-worktree="/impl"')).toBeGreaterThan(parentOpen)
    expect(html.indexOf('data-worktree="/review"')).toBeGreaterThan(html.indexOf('data-worktree="/impl"'))
    // 칩은 부모 자기 내용 영역 안(후손 묶음보다 앞)이다 — 끌기 hit 영역 계산이 이 순서를 믿는다.
    expect(html.indexOf('data-lineage-toggle="/coord"')).toBeLessThan(html.indexOf('data-lineage-children="/coord"'))
  })

  it('접히면 셰브론이 눕고 aria-expanded=false, 후손 묶음이 없다', () => {
    const html = renderToStaticMarkup(card('/coord', { childCount: 1, collapsed: true, children: null }))
    expect(html).toContain('1 하위')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('worktree-lineage-chip-caret is-collapsed')
    expect(html).not.toContain('data-lineage-children=')
  })

  it('자식이 없으면 칩도 묶음도 없다(기본값 = 옛 카드와 같다)', () => {
    const html = renderToStaticMarkup(card('/solo'))
    expect(html).not.toContain('data-lineage-toggle=')
    expect(html).not.toContain('data-lineage-children=')
    expect(html).not.toContain('data-lineage-depth=')
  })
})

describe('단계 들여쓰기 · 드롭 강조 · 상위 칩', () => {
  it('깊이 1·3 후손 — 18px 단계(최소 폭 상한 포함), 깊이 표식', () => {
    const one = renderToStaticMarkup(card('/c', { depth: 1 }))
    expect(one).toContain('data-lineage-depth="1"')
    expect(one).toContain('margin-left:max(0px, min(18px, calc(100% - 120px)))')
    const three = renderToStaticMarkup(card('/g', { depth: 3 }))
    expect(three).toContain('margin-left:max(0px, min(54px, calc(100% - 120px)))')
  })

  it('상위 지정 대상이면 카드 표면 강조', () => {
    expect(renderToStaticMarkup(card('/b', { dropTarget: true }))).toContain('data-lineage-drop-target=""')
    expect(renderToStaticMarkup(card('/b'))).not.toContain('data-lineage-drop-target')
  })

  it('부모가 안 보이는 카드는 `↳ 부모` 칩을 유지한다(D1)', () => {
    expect(renderToStaticMarkup(card('/x', {}, 'coord'))).toContain('↳ coord')
  })
})
