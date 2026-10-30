// @vitest-environment happy-dom
// LIFE-683 S2·S3·S4·S7·S8·S9 — 소스 제어 보기: 줄 만들기(그룹·목록·트리·접기), 행 모양(글자·색·취소선·툴팁·부모 경로), 클릭·키보드 열기,
// 쓰기 입력 없음, 빈 상태 문구, 구독 참조 셈(두 보기가 같은 루트면 한 벌) · 폭 칸 공유.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScmChange } from '../../../shared/scm.js'
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

const api = (input: Partial<ScmApi> & { changes?: ScmChange[] | null; error?: string | null; total?: number }): ScmApi => ({
  root: '/r',
  state: input.changes === undefined && input.error === undefined ? null : { changes: input.changes ?? null, total: input.total ?? input.changes?.length ?? 0, error: input.error ?? null, stamp: 1 },
  version: 1,
  stampOf: () => 1,
  refresh: () => {},
  mode: 'list',
  setMode: () => {},
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
    expect([...host.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual(['트리로 보기', '새로고침', '모두 접기'])
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
