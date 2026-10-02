// LIFE-478 K2ⓐ·K6ⓐ·K7ⓐⓑ — 카드 우클릭 메뉴 모델·상위 후보·삭제 대화 단추. 화면 조작은 격리·네이티브 실행이 본다.
import { describe, expect, it } from 'vitest'
import type { RepoRow, WorktreeRow } from '../../shared/types.js'
import { cardMenuEntries, deleteDecision, deleteResultNotice, filterCandidates, NO_PARENT_CANDIDATES, parentCandidates, PRIMARY_DELETE_DISABLED } from './card-menu.js'
import type { MenuEntry } from './components/ContextMenu.js'
import type { CardMenuAction } from './card-menu.js'

const GIT = { branch: null, upstream: null, ahead: null, behind: null, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, error: null }
const wt = (path: string, patch: Partial<WorktreeRow> = {}): WorktreeRow => ({
  path, branch: path.split('/').at(-1) ?? null, isLinked: true, openWorkspaceId: null, workspace: null, gitStatus: GIT, displayName: null, comment: null, parentPath: null, ...patch,
})
const shape = (entries: MenuEntry<CardMenuAction>[]): string[] =>
  entries.map((entry) => (entry.kind === 'item' ? `${entry.action}:${entry.label}${entry.disabled ? '(off)' : ''}${entry.submenu ? `[${entry.submenu.map((sub) => (sub.kind === 'item' ? sub.label : '')).join('|')}]` : ''}` : entry.kind === 'sep' ? '—' : `#${entry.label}`))
const base = { pinned: false, unread: false, deleting: false, candidateCount: 2, parentInTree: false, deleteShortcut: '⌘⇧⌫' }

describe('K2ⓐ 메뉴 항목·순서 = 198 단일 선택 메뉴 − 의도적 항목', () => {
  it('링크 워크트리 · 부모 없음', () => {
    expect(shape(cardMenuEntries({ ...base, worktree: wt('/r/a/x') }))).toEqual([
      '#워크스페이스', 'update:업데이트', '—', 'open-in:열기[Finder|VS Code]', 'copy-path:경로 복사', '—', 'toggle-pin:고정', 'toggle-unread:안 읽음으로 표시', '—',
      'set-parent:상위 워크트리 지정…', '—', 'delete:워크트리 삭제',
    ])
    const del = cardMenuEntries({ ...base, worktree: wt('/r/a/x') }).at(-1)
    expect(del).toMatchObject({ danger: true, shortcut: '⌘⇧⌫' })
  })
  it('부모 있음 → 변경… · 열기(트리에 있을 때만) · 빼기 · 고정 해제', () => {
    const entries = cardMenuEntries({ ...base, pinned: true, parentInTree: true, worktree: wt('/r/a/x', { parentPath: '/r/a' }) })
    expect(shape(entries).slice(6)).toEqual(['toggle-pin:고정 해제', 'toggle-unread:안 읽음으로 표시', '—', 'set-parent:상위 워크트리 변경…', 'open-parent:상위 워크트리 열기', 'remove-parent:상위에서 빼기', '—', 'delete:워크트리 삭제'])
    const orphan = cardMenuEntries({ ...base, parentInTree: false, worktree: wt('/r/a/x', { parentPath: '/gone' }) })
    expect(shape(orphan)).not.toContain('open-parent:상위 워크트리 열기')
    expect(shape(orphan)).toContain('remove-parent:상위에서 빼기')
  })
  it('ⓐ 후보 0 → 지정 항목 disabled + 사유', () => {
    const entry = cardMenuEntries({ ...base, candidateCount: 0, worktree: wt('/r/a/x') }).find((item) => item.kind === 'item' && item.action === 'set-parent')
    expect(entry).toMatchObject({ disabled: true, title: NO_PARENT_CANDIDATES })
  })
  it('K7ⓐ 주 체크아웃 → 삭제 disabled + 사유, 「프로젝트 제거」 항목은 없다(Orca #17645)', () => {
    const entries = cardMenuEntries({ ...base, worktree: wt('/r/a', { isLinked: false }) })
    expect(entries.at(-1)).toMatchObject({ kind: 'item', action: 'delete', disabled: true, title: PRIMARY_DELETE_DISABLED })
    // 항목(라벨·동작)으로는 없다 — disabled 사유 툴팁만 레포 ⋯ 를 가리킨다.
    expect(entries.filter((entry) => entry.kind === 'item').map((entry) => (entry.kind === 'item' ? `${entry.action}:${entry.label}` : ''))).not.toContainEqual(expect.stringMatching(/프로젝트|project/i))
    expect(entries.filter((entry) => entry.kind === 'item' && entry.danger === true)).toHaveLength(1)
  })
  it('K7ⓕ 삭제 중 → 삭제는 「삭제 중…」 disabled, 다른 항목도 disabled', () => {
    const entries = cardMenuEntries({ ...base, deleting: true, worktree: wt('/r/a/x') })
    expect(entries.at(-1)).toMatchObject({ label: '삭제 중…', disabled: true, shortcut: null })
    expect(entries.filter((entry) => entry.kind === 'item').every((entry) => entry.kind === 'item' && entry.disabled === true)).toBe(true)
  })
})

describe('LIFE-471 K6 Mark Read/Unread — Pin 바로 아래 · 라벨 토글 · disabled = 삭제 중뿐', () => {
  it('ⓐ 벨 꺼짐 → 「안 읽음으로 표시」, 켜짐 → 「읽음으로 표시」 — 같은 자리(toggle-pin 다음, 같은 구분선 묶음)', () => {
    for (const unread of [false, true]) {
      const items = shape(cardMenuEntries({ ...base, unread, worktree: wt('/r/a/x') }))
      const pin = items.indexOf('toggle-pin:고정')
      expect(items[pin + 1]).toBe(unread ? 'toggle-unread:읽음으로 표시' : 'toggle-unread:안 읽음으로 표시')
      expect(items[pin + 2]).toBe('—')
    }
  })
  it('ⓑ 주 체크아웃에도 있다 · 삭제 중이면 disabled', () => {
    expect(shape(cardMenuEntries({ ...base, worktree: wt('/r/a', { isLinked: false }) }))).toContain('toggle-unread:안 읽음으로 표시')
    expect(shape(cardMenuEntries({ ...base, deleting: true, worktree: wt('/r/a/x') }))).toContain('toggle-unread:안 읽음으로 표시(off)')
  })
})

describe('K6ⓐ 상위 후보 (198 `worktree-parent-candidates.ts` · `worktree-parent-eligibility.ts`)', () => {
  const repo = (worktrees: WorktreeRow[]): RepoRow => ({ root: '/r/a', name: 'a', error: null, worktrees })
  it('같은 레포 · 자기·현재 부모·자기 후손 제외 · 주 체크아웃 가능', () => {
    const main = wt('/r/a', { isLinked: false, branch: 'main' })
    const x = wt('/r/a/x', { parentPath: '/r/a/p' })
    const p = wt('/r/a/p')
    const child = wt('/r/a/c', { parentPath: '/r/a/x' })
    const grandchild = wt('/r/a/g', { parentPath: '/r/a/c' })
    const other = wt('/r/a/o')
    const got = parentCandidates({ worktree: x, repo: repo([main, x, p, child, grandchild, other]) }).map((row) => row.path)
    expect(got).toEqual(['/r/a', '/r/a/o'])
  })
  it('이미 순환이 있는 사슬의 구성원은 뺀다', () => {
    const a = wt('/r/a/1', { parentPath: '/r/a/2' })
    const b = wt('/r/a/2', { parentPath: '/r/a/1' })
    const x = wt('/r/a/x')
    expect(parentCandidates({ worktree: x, repo: repo([a, b, x]) })).toEqual([])
  })
  it('검색 — 표시 이름·브랜치·경로 부분 일치(대소문자 무시)', () => {
    const rows = [wt('/r/a/alpha', { displayName: 'Payment fix' }), wt('/r/a/beta')]
    const nameOf = (row: WorktreeRow): string => row.displayName ?? row.branch ?? ''
    expect(filterCandidates({ candidates: rows, query: 'PAY', nameOf }).map((row) => row.path)).toEqual(['/r/a/alpha'])
    expect(filterCandidates({ candidates: rows, query: 'beta', nameOf }).map((row) => row.path)).toEqual(['/r/a/beta'])
    expect(filterCandidates({ candidates: rows, query: '  ', nameOf })).toHaveLength(2)
  })
  it('검색 — 이름으로는 안 맞고 경로·브랜치로만 맞는 입력(r2 R2B-09 M11·M12)', () => {
    // 이름(nameOf)을 표시 이름만 돌려주게 해서, 경로·브랜치 칸이 없으면 못 찾는 입력을 만든다.
    const rows = [wt('/r/a/payments-wt', { displayName: '결제', branch: 'feat/checkout' }), wt('/r/a/other', { displayName: '기타', branch: 'main' })]
    const nameOf = (row: WorktreeRow): string => row.displayName ?? ''
    expect(filterCandidates({ candidates: rows, query: 'payments-wt', nameOf }).map((row) => row.path)).toEqual(['/r/a/payments-wt'])
    expect(filterCandidates({ candidates: rows, query: 'CHECKOUT', nameOf }).map((row) => row.path)).toEqual(['/r/a/payments-wt'])
  })
})

describe('K7ⓑⓓⓔ 삭제 대화 단추', () => {
  const clean = { isMain: false, locked: false, dirtyCount: 0, liveSessions: 0, backendError: null }
  it('깨끗·한가 = 「삭제」', () => expect(deleteDecision(clean)).toEqual({ kind: 'delete' }))
  it('dirty·바쁨 = 「강제 삭제」 + 넘기는 것을 하나씩(Orca #16526)', () => {
    expect(deleteDecision({ ...clean, dirtyCount: 3, liveSessions: 2 })).toEqual({ kind: 'force', warnings: ['커밋하지 않은 변경 3개가 디스크에서 사라집니다', '실행 중인 세션 2개가 종료됩니다'] })
    expect(deleteDecision({ ...clean, liveSessions: 1 })).toEqual({ kind: 'force', warnings: ['실행 중인 세션 1개가 종료됩니다'] })
    // 경계 1개(r2 R2B-09 M7) — 변경 하나도 강제다.
    expect(deleteDecision({ ...clean, dirtyCount: 1 })).toEqual({ kind: 'force', warnings: ['커밋하지 않은 변경 1개가 디스크에서 사라집니다'] })
  })
  it('잠김·herdr 링크 없음·주 체크아웃 = 막힘(강제 단추 없음)', () => {
    expect(deleteDecision({ ...clean, locked: true, dirtyCount: 5 }).kind).toBe('blocked')
    expect(deleteDecision({ ...clean, liveSessions: null, backendError: 'Desktop backend is not connected' })).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('herdr 연결이 없어') })
    expect(deleteDecision({ ...clean, isMain: true })).toEqual({ kind: 'blocked', reason: PRIMARY_DELETE_DISABLED })
  })
  it('K7ⓘ 결과 알림 — 브랜치가 남으면 말한다', () => {
    expect(deleteResultNotice({ name: 'x', preservedBranch: null, warning: null })).toBe('워크트리 x 를 삭제했습니다')
    expect(deleteResultNotice({ name: 'x', preservedBranch: 'feat/x', warning: null })).toBe('워크트리 x 를 삭제했습니다 — 브랜치 feat/x 는 남았습니다')
  })
})
