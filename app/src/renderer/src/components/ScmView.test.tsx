// @vitest-environment happy-dom
// LIFE-683 S2·S3·S4·S7·S8·S9 — 소스 제어 보기: 줄 만들기(그룹·목록·트리·접기), 행 모양(글자·색·취소선·툴팁·부모 경로), 클릭·키보드 열기,
// 쓰기 입력 없음, 빈 상태 문구, 구독 참조 셈(두 보기가 같은 루트면 한 벌) · 폭 칸 공유.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScmBasePush, ScmChange } from '../../../shared/scm.js'
import type { ScmApi } from '../hooks/useScm.js'
import { widthSlotOf } from '../hooks/useRightPanel.js'
import { acquireExplorerWatch } from '../explorer-watch-refs.js'
import { ScmView, scmRows, scmRowTitle } from './ScmView.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const c = (group: ScmChange['group'], status: ScmChange['status'], rel: string, orig: string | null = null): ScmChange => ({ group, status, rel, orig })
const CHANGES: ScmChange[] = [
  c('workingTree', 'MODIFIED', 'src/app/a.ts'),
  c('index', 'INDEX_MODIFIED', 'src/app/a.ts'),
  c('workingTree', 'UNTRACKED', 'new file.txt'),
  c('workingTree', 'DELETED', 'gone.ts'),
  c('index', 'INDEX_RENAMED', 'dir/새.ts', 'old.ts'),
  c('merge', 'BOTH_MODIFIED', 'conflict.txt'),
]

describe('scmRows', () => {
  it('목록 — 그룹 머리(개수) + 경로순 파일, 같은 파일이 두 그룹에', () => {
    const { rows } = scmRows({ changes: CHANGES, mode: 'list', collapsed: new Set() })
    expect(rows.map((row) => (row.kind === 'group' ? `[${row.title} ${row.count}]` : row.kind === 'file' ? row.change.rel : row.path))).toEqual([
      '[병합 변경 사항 1]',
      'conflict.txt',
      '[스테이징된 변경 사항 2]',
      'dir/새.ts',
      'src/app/a.ts',
      '[변경 사항 3]',
      'gone.ts',
      'new file.txt',
      'src/app/a.ts',
    ])
  })
  it('트리 — 폴더 압축, 접힌 그룹·폴더의 자식은 빠진다', () => {
    const tree = scmRows({ changes: CHANGES, mode: 'tree', collapsed: new Set(['g:merge']) }).rows
    expect(tree.map((row) => (row.kind === 'group' ? `[${row.group}]` : row.kind === 'dir' ? `${row.depth}:${row.name}/` : `${row.depth}:${row.name}`))).toEqual([
      '[merge]',
      '[index]',
      '1:dir/',
      '2:새.ts',
      '1:src/app/',
      '2:a.ts',
      '[workingTree]',
      '1:src/app/',
      '2:a.ts',
      '1:gone.ts',
      '1:new file.txt',
    ])
    const folded = scmRows({ changes: CHANGES, mode: 'tree', collapsed: new Set(['d:workingTree:src/app']) }).rows
    expect(folded.filter((row) => row.group === 'workingTree').map((row) => row.key)).toEqual(['g:workingTree', 'd:workingTree:src/app', 'f:workingTree:gone.ts', 'f:workingTree:new file.txt'])
  })
  it('툴팁 — 상태 문구 + 이름 바뀜 원래 경로', () => {
    expect(scmRowTitle(c('index', 'INDEX_RENAMED', 'n.ts', 'o.ts'))).toBe('n.ts • 인덱스 이름 바뀜 (원래 o.ts)')
    expect(scmRowTitle(c('workingTree', 'UNTRACKED', 'u'))).toBe('u • 추적 안 함')
  })
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const api = (input: Partial<ScmApi> & { changes?: ScmChange[] | null; error?: string | null; total?: number; base?: ScmBasePush | null }): ScmApi => ({
  root: '/r',
  state:
    input.changes === undefined && input.error === undefined && input.base === undefined
      ? null
      : { changes: input.changes ?? null, total: input.total ?? input.changes?.length ?? 0, error: input.error ?? null, stamp: 1, base: input.base ?? null },
  version: 1,
  stampOf: () => 1,
  refresh: () => {},
  mode: 'list',
  setMode: () => {},
  compare: 'working',
  setCompare: () => {},
  ...input,
})

describe('ScmView', () => {
  it('행 모양 — 글자·색(탐색기 표)·취소선·흐린 부모 경로, 쓰기 단추·입력 없음', () => {
    act(() => root.render(createElement(ScmView, { scm: api({ changes: CHANGES }), title: 'wt', mode: 'list', onChangeMode: () => {}, focusToken: 0, onOpen: () => {} })))
    const deleted = host.querySelector<HTMLElement>('[data-scm-file="gone.ts"]')
    expect(deleted?.querySelector('[data-scm-letter]')?.textContent).toBe('D')
    expect(deleted?.querySelector('.scm-name')?.classList.contains('is-strike')).toBe(true)
    const nested = host.querySelector<HTMLElement>('[data-scm-file="src/app/a.ts"][data-scm-status="MODIFIED"]')
    expect(nested?.querySelector('.scm-desc')?.textContent).toBe('src/app')
    expect(nested?.querySelector<HTMLElement>('[data-scm-letter]')?.style.color).toBe('#e5ba7d')
    expect(host.querySelector('[data-scm-file="conflict.txt"] [data-scm-letter]')?.textContent).toBe('!')
    expect(host.querySelectorAll('input, textarea')).toHaveLength(0)
    expect([...host.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual(['base 대비로 보기', '트리로 보기', '새로고침', '모두 접기'])
  })
  it('클릭 = 미리보기 열기, 두 번 = 고정, Enter = 고정 · Space = 미리보기, ↓ 이동', () => {
    const onOpen = vi.fn()
    act(() => root.render(createElement(ScmView, { scm: api({ changes: CHANGES }), title: null, mode: 'list', onChangeMode: () => {}, focusToken: 0, onOpen })))
    const row = host.querySelector<HTMLElement>('[data-scm-file="gone.ts"]')
    act(() => row?.click())
    act(() => row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(onOpen.mock.calls.map(([input]) => [input.change.rel, input.preview])).toEqual([
      ['gone.ts', true],
      ['gone.ts', false],
    ])
    const list = host.querySelector<HTMLElement>('[data-scm-list]')
    act(() => list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    act(() => list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    act(() => list?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })))
    expect(onOpen.mock.calls.slice(2).map(([input]) => [input.change.rel, input.preview])).toEqual([
      ['new file.txt', false],
      ['new file.txt', true],
    ])
  })
  it('빈 상태 — worktree 없음 · git 아님 · 변경 없음', () => {
    act(() => root.render(createElement(ScmView, { scm: api({ root: null }), title: null, mode: 'list', onChangeMode: () => {}, focusToken: 0, onOpen: () => {} })))
    expect(host.querySelector('[data-scm-empty]')?.textContent).toBe('열린 worktree 가 없습니다.')
    act(() => root.render(createElement(ScmView, { scm: api({ error: 'fatal: not a git repository' }), title: null, mode: 'list', onChangeMode: () => {}, focusToken: 0, onOpen: () => {} })))
    expect(host.querySelector('[data-scm-empty]')?.textContent).toBe('현재 열린 폴더에 Git 리포지토리가 없습니다.')
    act(() => root.render(createElement(ScmView, { scm: api({ changes: [] }), title: null, mode: 'list', onChangeMode: () => {}, focusToken: 0, onOpen: () => {} })))
    expect(host.querySelector('[data-scm-empty]')?.textContent).toBe('변경 사항 없음')
  })
  it('모드 단추 = 반대 모드로 바꾸기', () => {
    const onChangeMode = vi.fn()
    act(() => root.render(createElement(ScmView, { scm: api({ changes: CHANGES }), title: null, mode: 'tree', onChangeMode, focusToken: 0, onOpen: () => {} })))
    act(() => host.querySelector<HTMLElement>('[data-scm-view-mode]')?.click())
    expect(onChangeMode).toHaveBeenCalledWith('list')
  })
})

describe('구독 참조 셈 (S8) · 폭 칸 (S1)', () => {
  it('같은 루트 두 보기 = on 한 번, 보기 전환(해제 → 구독)은 off·refresh 없이(F2-04), 마지막 해제 뒤 off 한 번', async () => {
    const calls: string[] = []
    Reflect.set(window, 'corral', {
      explorerWatch: async ({ on }: { on: boolean }) => {
        calls.push(on ? 'on' : 'off')
        return { ok: true }
      },
      explorerRefreshGit: () => calls.push('refresh'),
    })
    const explorer = acquireExplorerWatch('/r')
    const scm = acquireExplorerWatch('/r')
    explorer()
    explorer()
    await Promise.resolve()
    expect(calls).toEqual(['on', 'refresh'])
    scm()
    const again = acquireExplorerWatch('/r')
    await Promise.resolve()
    expect(calls).toEqual(['on', 'refresh'])
    again()
    await Promise.resolve()
    expect(calls).toEqual(['on', 'refresh', 'off'])
  })
  it('소스 제어는 탐색기 폭 칸을 쓴다', () => {
    expect(widthSlotOf('scm')).toBe('explorer')
    expect(widthSlotOf('explorer')).toBe('explorer')
    expect(widthSlotOf('detail')).toBe('detail')
  })
})

// LIFE-830 B1·B3·B4·B2ⓓ — 비교 기준 전환 단추 · base 표시(이름 · 출처 · merge-base 짧은 해시) · 그룹 하나 · 안내.
describe('ScmView base 대비 (LIFE-830)', () => {
  const info = { name: 'feature/LIFE-802-scm-write', source: 'parent' as const, mergeBase: '0123456789abcdef0123456789abcdef01234567' }
  const BASE_CHANGES: ScmChange[] = [
    { group: 'base', status: 'ADDED', rel: 'src/new.ts', orig: null },
    { group: 'base', status: 'RENAMED', rel: 'b.ts', orig: 'a.ts' },
    { group: 'base', status: 'UNTRACKED', rel: 'u.txt', orig: null },
  ]
  const view = (scm: ScmApi, onOpen: (input: { change: ScmChange; preview: boolean }) => void = () => {}) =>
    act(() => root.render(createElement(ScmView, { scm, title: null, mode: 'list', onChangeMode: () => {}, focusToken: 0, onOpen })))
  it('머리 단추가 비교 기준을 바꾼다 — 작업 트리 모드는 base 줄 없음, 지금과 같은 그룹', () => {
    const setCompare = vi.fn()
    view(api({ changes: CHANGES, base: { ok: true, info, changes: BASE_CHANGES, total: 3 }, setCompare }))
    expect(host.querySelector('[data-scm]')?.getAttribute('data-scm-compare')).toBe('working')
    expect(host.querySelector('[data-scm-base]')).toBeNull()
    expect([...host.querySelectorAll('[data-scm-group]')].map((group) => group.getAttribute('data-scm-group'))).not.toContain('base')
    act(() => host.querySelector<HTMLButtonElement>('[data-scm-compare-toggle="base"]')?.click())
    expect(setCompare).toHaveBeenCalledWith('base')
  })
  it('base 대비 — 그룹 하나·개수, base 이름 · 출처 · 짧은 해시, 이름 바뀜 툴팁, 클릭은 base 행을 연다', () => {
    const onOpen = vi.fn()
    view(api({ changes: CHANGES, compare: 'base', base: { ok: true, info, changes: BASE_CHANGES, total: 3 } }), onOpen)
    expect(host.querySelector('[data-scm]')?.getAttribute('data-scm-compare')).toBe('base')
    expect([...host.querySelectorAll('[data-scm-group]')].map((group) => [group.getAttribute('data-scm-group'), group.querySelector('.scm-group-title')?.textContent, group.querySelector('[data-scm-count]')?.textContent])).toEqual([['base', 'base 대비 변경 사항', '3']])
    expect(host.querySelector('[data-scm-base-name]')?.textContent).toBe('base feature/LIFE-802-scm-write')
    expect(host.querySelector('[data-scm-base]')?.getAttribute('data-scm-base-source')).toBe('parent')
    expect(host.querySelector('.scm-base-source')?.textContent).toBe('부모 worktree')
    expect(host.querySelector('[data-scm-base-hash]')?.textContent).toBe('0123456')
    expect(host.querySelector('[data-scm-file="b.ts"]')?.getAttribute('title')).toBe('b.ts • 이름 바뀜 (원래 a.ts)')
    expect(host.querySelector('[data-scm-file="u.txt"] [data-scm-letter]')?.textContent).toBe('U')
    expect(host.querySelector('[data-scm-compare-toggle="working"]')?.getAttribute('aria-label')).toBe('작업 트리로 보기')
    act(() => host.querySelector<HTMLElement>('[data-scm-file="b.ts"]')?.click())
    expect(onOpen.mock.calls[0]?.[0]).toEqual({ change: BASE_CHANGES[1], preview: true })
  })
  it('A1 — 같은 경로가 diff 의 D 와 추적 안 함 U 두 줄: 두 줄 유지 · key 고유(목록·트리) · ↓ 가 두 줄을 지나간다', () => {
    const same: ScmChange[] = [
      { group: 'base', status: 'DELETED', rel: 'dir/same.txt', orig: null },
      { group: 'base', status: 'UNTRACKED', rel: 'dir/same.txt', orig: null },
      { group: 'base', status: 'MODIFIED', rel: 'dir/z.ts', orig: null },
    ]
    for (const mode of ['list', 'tree'] as const) {
      const files = scmRows({ changes: same, mode, collapsed: new Set() }).rows.filter((row) => row.kind === 'file')
      expect(files).toHaveLength(3)
      expect(new Set(files.map((row) => row.key)).size).toBe(3)
    }
    // 작업 트리 그룹의 key 는 그대로(선택·접기 키 무변경).
    expect(scmRows({ changes: [{ group: 'workingTree', status: 'MODIFIED', rel: 'a.ts', orig: null }], mode: 'list', collapsed: new Set() }).rows[1]?.key).toBe('f:workingTree:a.ts')
    const onOpen = vi.fn()
    view(api({ changes: CHANGES, compare: 'base', base: { ok: true, info, changes: same, total: 3 } }), onOpen)
    const rows = [...host.querySelectorAll<HTMLElement>('[data-scm-file]')]
    expect(rows.map((row) => [row.getAttribute('data-scm-file'), row.querySelector('[data-scm-letter]')?.textContent])).toEqual([
      ['dir/same.txt', 'D'],
      ['dir/same.txt', 'U'],
      ['dir/z.ts', 'M'],
    ])
    act(() => rows[0]?.click())
    const list = host.querySelector<HTMLElement>('[data-scm-list]')
    for (let i = 0; i < 2; i += 1) {
      act(() => list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
      act(() => list?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    }
    expect(onOpen.mock.calls.map(([input]) => [input.change.status, input.change.rel])).toEqual([
      ['DELETED', 'dir/same.txt'],
      ['UNTRACKED', 'dir/same.txt'],
      ['MODIFIED', 'dir/z.ts'],
    ])
    expect(host.querySelectorAll('.scm-file.is-selected')).toHaveLength(1)
  })
  it('안내 — 읽는 중 · base 없음(정하는 방법) · 공통 조상 없음 · 변경 없음', () => {
    view(api({ changes: CHANGES, compare: 'base', base: null }))
    expect(host.querySelector('[data-scm-empty]')?.textContent).toBe('base 대비 목록을 읽는 중…')
    view(api({ changes: CHANGES, compare: 'base', base: { ok: false, reason: 'no_base', error: 'x' } }))
    expect(host.querySelector('[data-scm-empty]')?.textContent).toContain('corral repo set-base-ref')
    view(api({ changes: CHANGES, compare: 'base', base: { ok: false, reason: 'no_merge_base', error: 'main 와(과) 공통 조상이 없다' } }))
    expect(host.querySelector('[data-scm-empty]')?.textContent).toContain('공통 조상이 없어')
    view(api({ changes: CHANGES, compare: 'base', base: { ok: true, info, changes: [], total: 0 } }))
    expect(host.querySelector('[data-scm-empty]')?.textContent).toBe('base 대비 변경 사항 없음')
    expect(host.querySelector('[data-scm-base-hash]')?.textContent).toBe('0123456')
  })
})
