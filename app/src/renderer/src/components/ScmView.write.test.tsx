// @vitest-environment happy-dom
// LIFE-829 — 소스 제어 쓰기 UI: 행·그룹 inline 단추(V1·V2)가 행 클릭으로 새지 않고 그룹이 정한 요청을 보낸다 · 입력란 ⌘Enter·▾ 「커밋(수정)」 ·
// K12 — 결과(입력란 비우기·오류 안내)는 요청 루트의 상태에만 적용된다(지금 보이는 다른 루트는 그대로).
// K14 — base 대비(LIFE-830)에서는 쓰기 단추·입력란이 DOM 에 없고, 작업 트리로 돌아오면 초안·안내·진행 중 쓰기 결과가 그 루트에 그대로다.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScmBasePush, ScmChange } from '../../../shared/scm.js'
import { discardRequest, stageRequest, type ScmWriteInput, type ScmWriteResult } from '../../../shared/scm-write.js'
import { useScm, type ScmApi } from '../hooks/useScm.js'
import { SCM_GROUP_TRUNCATED_TITLE, ScmView, scmActionsOf } from './ScmView.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const c = (group: ScmChange['group'], status: ScmChange['status'], rel: string, orig: string | null = null): ScmChange => ({ group, status, rel, orig })
const CHANGES: ScmChange[] = [
  c('workingTree', 'MODIFIED', 'src/a.ts'),
  c('workingTree', 'UNTRACKED', 'u.txt'),
  c('index', 'INDEX_RENAMED', 'new.ts', 'old.ts'),
  c('index', 'INDEX_MODIFIED', 'src/a.ts'),
  c('merge', 'BOTH_MODIFIED', 'conflict.txt'),
]

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

const api = (input: Partial<ScmApi>): ScmApi => ({
  root: '/r',
  state: { changes: CHANGES, total: CHANGES.length, error: null, stamp: 1, base: null },
  version: 1,
  stampOf: () => 1,
  refresh: () => {},
  mode: 'list',
  setMode: () => {},
  compare: 'working',
  setCompare: () => {},
  write: { message: '', notice: null, committing: false },
  setMessage: () => {},
  dismissNotice: () => {},
  run: async () => {},
  remote: null,
  runRemote: async () => {},
  cancelRemote: () => {},
  ...input,
})
const render = (scm: ScmApi, onOpen = vi.fn()): void => act(() => root.render(createElement(ScmView, { scm, title: null, mode: 'list', onChangeMode: () => {}, focusToken: 0, onOpen })))
const actionsIn = (selector: string): string[] => [...host.querySelectorAll(`${selector} [data-scm-action]`)].map((button) => button.getAttribute('data-scm-action') ?? '')

describe('inline 단추 (K1·K2 — V1·V2)', () => {
  it('그룹마다 단추가 다르다 — 변경: discard·stage · 스테이지: unstage · 병합: stage (행·그룹 머리 둘 다)', () => {
    expect(scmActionsOf('workingTree')).toEqual(['discard', 'stage'])
    expect(scmActionsOf('index')).toEqual(['unstage'])
    expect(scmActionsOf('merge')).toEqual(['stage'])
    render(api({}))
    expect(actionsIn('[data-scm-group="workingTree"]')).toEqual(['discard', 'stage'])
    expect(actionsIn('[data-scm-group="index"]')).toEqual(['unstage'])
    expect(actionsIn('[data-scm-group="merge"]')).toEqual(['stage'])
    expect(actionsIn('[data-scm-file="src/a.ts"][data-scm-status="MODIFIED"]')).toEqual(['discard', 'stage'])
    expect(actionsIn('[data-scm-file="src/a.ts"][data-scm-status="INDEX_MODIFIED"]')).toEqual(['unstage'])
    expect(actionsIn('[data-scm-file="conflict.txt"]')).toEqual(['stage'])
    // 스테이지 그룹엔 discard 가 없다(V3).
    expect(host.querySelectorAll('[data-scm-group="index"] [data-scm-action="discard"], [data-scm-status^="INDEX_"] [data-scm-action="discard"]')).toHaveLength(0)
  })
  it('행 단추 클릭 = 그 행 요청만, 행 클릭(diff 열기)·더블클릭으로 새지 않는다', () => {
    const run = vi.fn<(input: ScmWriteInput) => Promise<void>>(async () => {})
    const onOpen = vi.fn()
    render(api({ run }), onOpen)
    const stage = host.querySelector<HTMLElement>('[data-scm-file="src/a.ts"][data-scm-status="MODIFIED"] [data-scm-action="stage"]')
    act(() => stage?.click())
    act(() => stage?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    const unstage = host.querySelector<HTMLElement>('[data-scm-file="new.ts"] [data-scm-action="unstage"]')
    act(() => unstage?.click())
    const discard = host.querySelector<HTMLElement>('[data-scm-file="u.txt"] [data-scm-action="discard"]')
    act(() => discard?.click())
    const merge = host.querySelector<HTMLElement>('[data-scm-file="conflict.txt"] [data-scm-action="stage"]')
    act(() => merge?.click())
    expect(onOpen).not.toHaveBeenCalled()
    expect(run.mock.calls.map(([input]) => input)).toEqual([
      { action: 'stage', root: '/r', paths: ['src/a.ts'] },
      // 이름 바뀜 unstage 는 원래 경로도(D4).
      { action: 'unstage', root: '/r', paths: ['new.ts', 'old.ts'] },
      { action: 'discard', root: '/r', tracked: [], untracked: ['u.txt'] },
      { action: 'stageMerge', root: '/r', paths: ['conflict.txt'] },
    ])
  })
  it('그룹 단추 = 그 그룹 전부, 접기로 새지 않는다', () => {
    const run = vi.fn<(input: ScmWriteInput) => Promise<void>>(async () => {})
    render(api({ run }))
    act(() => host.querySelector<HTMLElement>('[data-scm-group="workingTree"] [data-scm-action="discard"]')?.click())
    act(() => host.querySelector<HTMLElement>('[data-scm-group="workingTree"] [data-scm-action="stage"]')?.click())
    act(() => host.querySelector<HTMLElement>('[data-scm-group="index"] [data-scm-action="unstage"]')?.click())
    expect(run.mock.calls.map(([input]) => input)).toEqual([
      { action: 'discard', root: '/r', tracked: ['src/a.ts'], untracked: ['u.txt'] },
      { action: 'stage', root: '/r', paths: ['src/a.ts', 'u.txt'] },
      { action: 'unstage', root: '/r', paths: ['new.ts', 'old.ts', 'src/a.ts'] },
    ])
    // 그룹이 접히지 않았다 — 파일 행이 그대로 보인다.
    expect(host.querySelector('[data-scm-group="workingTree"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[data-scm-file="u.txt"]')).not.toBeNull()
  })
  it('목록이 상한에서 잘리면 그룹 단추는 꺼지고 툴팁이 이유를 말한다 — 행 단추는 그대로(D2)', () => {
    const run = vi.fn<(input: ScmWriteInput) => Promise<void>>(async () => {})
    render(api({ run, state: { changes: CHANGES, total: 20_000, error: null, stamp: 1, base: null } }))
    expect(host.querySelector('[data-scm-truncated]')).not.toBeNull()
    const groupButtons = [...host.querySelectorAll<HTMLElement>('[data-scm-actions="group"] [data-scm-action]')]
    expect(groupButtons).toHaveLength(4)
    for (const button of groupButtons) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
      expect(button.getAttribute('title')).toBe(SCM_GROUP_TRUNCATED_TITLE)
      act(() => button.click())
    }
    expect(run).not.toHaveBeenCalled()
    const rowStage = host.querySelector<HTMLElement>('[data-scm-file="u.txt"] [data-scm-action="stage"]')
    expect(rowStage?.getAttribute('aria-disabled')).toBeNull()
    expect(rowStage?.getAttribute('title')).toBe('변경 내용 스테이징')
    act(() => rowStage?.click())
    expect(run.mock.calls.map(([input]) => input)).toEqual([{ action: 'stage', root: '/r', paths: ['u.txt'] }])
    // 잘리지 않으면 그룹 단추는 켜져 있다(음성 대조).
    render(api({ run }))
    expect(host.querySelectorAll('[data-scm-actions="group"] [aria-disabled]')).toHaveLength(0)
  })
  it('요청 만들기 — stageRequest·discardRequest', () => {
    expect(stageRequest({ root: '/r', group: 'workingTree', changes: [CHANGES[0], CHANGES[0]].filter((item): item is ScmChange => item !== undefined) })).toEqual({ action: 'stage', root: '/r', paths: ['src/a.ts'] })
    expect(discardRequest({ root: '/r', changes: CHANGES })).toEqual({ action: 'discard', root: '/r', tracked: ['src/a.ts'], untracked: ['u.txt'] })
  })
  it('discardRequest — 추가 예정·이름 바꾸기 예정의 새 경로는 휴지통 쪽, 이름 바꾸기 예정의 원래 경로는 되돌림 쪽(B1)', () => {
    const changes: ScmChange[] = [
      { group: 'workingTree', status: 'MODIFIED', rel: 'm.ts', orig: null },
      { group: 'workingTree', status: 'INTENT_TO_ADD', rel: 'ita.txt', orig: null },
      { group: 'workingTree', status: 'INTENT_TO_RENAME', rel: 'moved.txt', orig: 'old.txt' },
      { group: 'workingTree', status: 'DELETED', rel: 'gone.ts', orig: null },
      { group: 'workingTree', status: 'UNTRACKED', rel: 'u.txt', orig: null },
      { group: 'index', status: 'INDEX_ADDED', rel: 'staged.ts', orig: null },
    ]
    expect(discardRequest({ root: '/r', changes })).toEqual({ action: 'discard', root: '/r', tracked: ['m.ts', 'old.txt', 'gone.ts'], untracked: ['ita.txt', 'moved.txt', 'u.txt'] })
  })
})

describe('커밋 입력 (K4·K5)', () => {
  it('⌘Enter = 커밋(누른 때 루트·메시지), 커밋 단추 = 커밋, ▾ 「커밋(수정)」 = amend', () => {
    const run = vi.fn<(input: ScmWriteInput) => Promise<void>>(async () => {})
    render(api({ run, write: { message: 'msg', notice: null, committing: false } }))
    const input = host.querySelector<HTMLTextAreaElement>('[data-scm-message]')
    act(() => input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })))
    act(() => input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    act(() => host.querySelector<HTMLElement>('[data-scm-commit]')?.click())
    expect(host.querySelector('[data-scm-commit-menu]')).toBeNull()
    act(() => host.querySelector<HTMLElement>('[data-scm-commit-more]')?.click())
    expect([...host.querySelectorAll('[data-scm-commit-item]')].map((item) => item.textContent)).toEqual(['커밋', '커밋(수정)'])
    act(() => host.querySelector<HTMLElement>('[data-scm-commit-item="amend"]')?.click())
    expect(host.querySelector('[data-scm-commit-menu]')).toBeNull()
    expect(run.mock.calls.map(([call]) => call)).toEqual([
      { action: 'commit', root: '/r', message: 'msg', amend: false },
      { action: 'commit', root: '/r', message: 'msg', amend: false },
      { action: 'commit', root: '/r', message: 'msg', amend: true },
    ])
  })
  it('커밋 중에는 입력란이 읽기 전용·단추가 꺼진다 · 오류 안내는 원문 그대로 보인다', () => {
    render(api({ write: { message: 'm', notice: { kind: 'error', text: 'HOOK_FIXED_FAIL: 원문\n둘째 줄' }, committing: true } }))
    expect(host.querySelector<HTMLTextAreaElement>('[data-scm-message]')?.readOnly).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[data-scm-commit]')?.disabled).toBe(true)
    expect(host.querySelector('[data-scm-notice="error"] pre')?.textContent).toBe('HOOK_FIXED_FAIL: 원문\n둘째 줄')
  })
})

describe('K12 — 결과는 요청 루트에만 (useScm)', () => {
  it('A 에서 커밋을 누르고 B 로 옮긴 뒤 성공 = A 입력란만 빈다, B 입력은 그대로 · A 실패 안내는 B 에 안 보이고 A 로 돌아오면 보인다', async () => {
    const pending: { input: ScmWriteInput; resolve: (result: ScmWriteResult) => void }[] = []
    Reflect.set(window, 'corral', {
      getUiPrefs: async () => ({}),
      setUiPrefs: () => {},
      onExplorerEvent: () => () => {},
      explorerWatch: async () => ({ ok: true }),
      explorerRefreshGit: () => {},
      scmWrite: (input: ScmWriteInput) => new Promise<ScmWriteResult>((resolve) => pending.push({ input, resolve })),
    })
    let scm: ScmApi | null = null
    const Harness = ({ at }: { at: string }): React.JSX.Element => {
      const value = useScm({ root: at, active: false })
      scm = value
      return createElement(ScmView, { scm: value, title: null, mode: 'list', onChangeMode: () => {}, focusToken: 0, onOpen: () => {} })
    }
    const current = (): ScmApi => {
      if (scm === null) throw new Error('no scm')
      return scm
    }
    await act(async () => root.render(createElement(Harness, { at: '/A' })))
    act(() => current().setMessage('A 메시지'))
    await act(async () => host.querySelector<HTMLElement>('[data-scm-commit]')?.click())
    expect(pending.map((item) => item.input)).toEqual([{ action: 'commit', root: '/A', message: 'A 메시지', amend: false }])
    expect(current().write.committing).toBe(true)
    // 사용자가 B 로 옮겨 입력한다.
    await act(async () => root.render(createElement(Harness, { at: '/B' })))
    expect(current().write).toEqual({ message: '', notice: null, committing: false })
    act(() => current().setMessage('B 메시지'))
    await act(async () => pending[0]?.resolve({ ok: true }))
    expect(current().root).toBe('/B')
    expect(host.querySelector<HTMLTextAreaElement>('[data-scm-message]')?.value).toBe('B 메시지')
    await act(async () => root.render(createElement(Harness, { at: '/A' })))
    expect(current().write).toEqual({ message: '', notice: null, committing: false })

    // 실패 — A 에서 누르고 B 에서 실패를 받는다.
    act(() => current().setMessage('A 둘째'))
    await act(async () => host.querySelector<HTMLElement>('[data-scm-commit]')?.click())
    await act(async () => root.render(createElement(Harness, { at: '/B' })))
    await act(async () => pending[1]?.resolve({ ok: false, code: 'git_error', error: 'pre-commit: gitleaks 없음 — brew install gitleaks' }))
    expect(host.querySelector('[data-scm-notice]')).toBeNull()
    expect(host.querySelector<HTMLTextAreaElement>('[data-scm-message]')?.value).toBe('B 메시지')
    await act(async () => root.render(createElement(Harness, { at: '/A' })))
    expect(host.querySelector('[data-scm-notice="error"] pre')?.textContent).toBe('pre-commit: gitleaks 없음 — brew install gitleaks')
    // 실패 뒤 입력란 메시지는 그대로(D10).
    expect(host.querySelector<HTMLTextAreaElement>('[data-scm-message]')?.value).toBe('A 둘째')
  })
  it('빈 메시지·변경 없음 거절은 안내 문구로, 취소는 안내 없음', async () => {
    const results: ScmWriteResult[] = [
      { ok: false, code: 'empty_message', error: '' },
      { ok: false, code: 'nothing_to_commit', error: '' },
      { ok: false, code: 'cancelled', error: '' },
    ]
    Reflect.set(window, 'corral', {
      getUiPrefs: async () => ({}),
      setUiPrefs: () => {},
      onExplorerEvent: () => () => {},
      explorerWatch: async () => ({ ok: true }),
      explorerRefreshGit: () => {},
      scmWrite: async () => results.shift() ?? { ok: true },
    })
    const Harness = (): React.JSX.Element => createElement(ScmView, { scm: useScm({ root: '/A', active: false }), title: null, mode: 'list', onChangeMode: () => {}, focusToken: 0, onOpen: () => {} })
    await act(async () => root.render(createElement(Harness)))
    const texts: (string | null)[] = []
    for (let index = 0; index < 3; index += 1) {
      await act(async () => host.querySelector<HTMLElement>('[data-scm-commit]')?.click())
      texts.push(host.querySelector('[data-scm-notice] pre')?.textContent ?? null)
    }
    expect(texts).toEqual(['커밋 메시지를 입력하세요.', '커밋할 변경 사항이 없습니다.', null])
  })
})

describe('K14 — base 대비에서는 쓰기 UI 없음 (LIFE-830 맞춤)', () => {
  const BASE: ScmBasePush = {
    ok: true,
    info: { name: 'main', source: 'default', mergeBase: 'a'.repeat(40) },
    changes: [c('base', 'MODIFIED', 'src/a.ts'), c('base', 'DELETED', 'gone.ts'), c('base', 'UNTRACKED', 'u.txt')],
    total: 3,
  }
  it('base 대비 = [data-scm-action]·[data-scm-input] 0개, 목록·base 줄은 보인다 · ⌘Enter·행 클릭에 쓰기 호출 0', () => {
    const run = vi.fn<(input: ScmWriteInput) => Promise<void>>(async () => {})
    render(api({ run, compare: 'base', state: { changes: CHANGES, total: CHANGES.length, error: null, stamp: 1, base: BASE }, write: { message: '초안', notice: { kind: 'error', text: '앞 오류' }, committing: false } }))
    expect(host.querySelector('[data-scm-compare="base"]')).not.toBeNull()
    expect(host.querySelector('[data-scm-base]')).not.toBeNull()
    expect(host.querySelectorAll('[data-scm-file]')).toHaveLength(3)
    expect(host.querySelectorAll('[data-scm-action]')).toHaveLength(0)
    expect(host.querySelectorAll('[data-scm-input], [data-scm-message], [data-scm-commit], [data-scm-commit-more], [data-scm-notice]')).toHaveLength(0)
    expect(scmActionsOf('base')).toEqual([])
    expect(stageRequest({ root: '/r', group: 'base', changes: BASE.ok ? BASE.changes : [] })).toBeNull()
    const list = host.querySelector<HTMLElement>('[data-scm-list]')
    for (const target of [list, host.querySelector<HTMLElement>('[data-scm]'), document.body]) {
      act(() => target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })))
    }
    act(() => host.querySelector<HTMLElement>('[data-scm-file="src/a.ts"]')?.click())
    expect(run).not.toHaveBeenCalled()
  })
  it('작업 트리 ↔ base 대비 전환 — 돌아오면 초안·안내 그대로 · 전환 중 진행하던 쓰기 결과는 같은 루트에 반영(K12)', async () => {
    const pending: { input: ScmWriteInput; resolve: (result: ScmWriteResult) => void }[] = []
    Reflect.set(window, 'corral', {
      getUiPrefs: async () => ({}),
      setUiPrefs: () => {},
      onExplorerEvent: () => () => {},
      explorerWatch: async () => ({ ok: true }),
      explorerRefreshGit: () => {},
      scmBaseMode: () => {},
      scmWrite: (input: ScmWriteInput) => new Promise<ScmWriteResult>((resolve) => pending.push({ input, resolve })),
    })
    let scm: ScmApi | null = null
    const Harness = (): React.JSX.Element => {
      const value = useScm({ root: '/A', active: true })
      scm = value
      return createElement(ScmView, { scm: value, title: null, mode: 'list', onChangeMode: () => {}, focusToken: 0, onOpen: () => {} })
    }
    const current = (): ScmApi => {
      if (scm === null) throw new Error('no scm')
      return scm
    }
    const input = (): HTMLTextAreaElement | null => host.querySelector<HTMLTextAreaElement>('[data-scm-message]')
    await act(async () => root.render(createElement(Harness)))
    // 초안만 두고 base 대비로 → 돌아오면 그대로.
    act(() => current().setMessage('초안 1'))
    await act(async () => host.querySelector<HTMLElement>('[data-scm-compare-toggle="base"]')?.click())
    expect(current().compare).toBe('base')
    expect(host.querySelectorAll('[data-scm-input], [data-scm-action]')).toHaveLength(0)
    await act(async () => host.querySelector<HTMLElement>('[data-scm-compare-toggle="working"]')?.click())
    expect(input()?.value).toBe('초안 1')

    // 커밋(실패)을 누르고 base 대비로 → 실패 결과 → 돌아오면 안내 + 초안 그대로.
    await act(async () => host.querySelector<HTMLElement>('[data-scm-commit]')?.click())
    expect(pending.map((item) => item.input)).toEqual([{ action: 'commit', root: '/A', message: '초안 1', amend: false }])
    await act(async () => current().setCompare('base'))
    await act(async () => pending[0]?.resolve({ ok: false, code: 'git_error', error: 'pre-commit 실패 원문' }))
    expect(host.querySelectorAll('[data-scm-input], [data-scm-notice]')).toHaveLength(0)
    expect(current().write).toEqual({ message: '초안 1', notice: { kind: 'error', text: 'pre-commit 실패 원문' }, committing: false })
    await act(async () => current().setCompare('working'))
    expect(input()?.value).toBe('초안 1')
    expect(host.querySelector('[data-scm-notice="error"] pre')?.textContent).toBe('pre-commit 실패 원문')

    // 커밋(성공)을 누르고 base 대비로 → 성공 결과 → 돌아오면 입력란이 비어 있다(결과가 그 루트에 반영).
    await act(async () => host.querySelector<HTMLElement>('[data-scm-commit]')?.click())
    await act(async () => current().setCompare('base'))
    await act(async () => pending[1]?.resolve({ ok: true }))
    await act(async () => current().setCompare('working'))
    expect(current().write).toEqual({ message: '', notice: null, committing: false })
    expect(input()?.value).toBe('')
  })
})
