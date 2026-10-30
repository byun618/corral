// @vitest-environment happy-dom
// LIFE-683 fix r1 R1-07·R1-01 — diff 탭 몸통: 좌우 모델 값(작업 트리 = 인덱스 ↔ 작업 파일), stamp 가 바뀌면 다시 읽어 모델 값만 교체,
// 단일(인덱스 추가) / diff 전환, 오른쪽 없음 띠, 대용량은 plaintext·large. 그리고 감시 구독 — 보이는 diff 탭(`watch`)은 그 루트 구독을 잡고
// 안 보이면 놓는다. diff 탭도 보기도 없으면(682 A11 — 상세 보기·패널 닫힘) 구독 0.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScmDiffTarget, ScmReadInput } from '../../../shared/scm.js'
import { useScm } from '../hooks/useScm.js'

type FakeModel = { value: string; language: string; getValue: () => string; setValue: (text: string) => void; dispose: () => void }
const made: { models: FakeModel[]; editors: { kind: 'single' | 'diff'; large: boolean }[]; languages: string[] } = { models: [], editors: [], languages: [] }
const fakeEditor = () => ({ setModel: () => {}, saveViewState: () => ({ scroll: 1 }), restoreViewState: () => {}, dispose: () => {} })

vi.mock('../editor/monaco.js', () => ({
  languageFor: async () => 'typescript',
  createModel: ({ text, language }: { text: string; language: string }): FakeModel => {
    made.languages.push(language)
    const model: FakeModel = {
      value: text,
      language,
      getValue: () => model.value,
      setValue: (next) => {
        model.value = next
      },
      dispose: () => {},
    }
    made.models.push(model)
    return model
  },
  createEditor: ({ large }: { large: boolean }) => {
    made.editors.push({ kind: 'single', large })
    return fakeEditor()
  },
  createDiffEditor: ({ large }: { large: boolean }) => {
    made.editors.push({ kind: 'diff', large })
    return fakeEditor()
  },
}))

const { DiffView } = await import('./DiffView.js')

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

let host: HTMLDivElement
let root: Root
let files: Map<string, string | null>
let blobs: Map<string, string | null>
let reads: string[]
let watchCalls: string[]

beforeEach(() => {
  made.models.length = 0
  made.editors.length = 0
  made.languages.length = 0
  files = new Map()
  blobs = new Map()
  reads = []
  watchCalls = []
  Reflect.set(window, 'corral', {
    readFile: async ({ rel }: { rel: string }) => {
      reads.push(`working:${rel}`)
      const text = files.get(rel)
      return text === undefined || text === null ? { ok: false, code: 'not_found', error: 'x' } : { ok: true, kind: 'text', text, size: text.length, bom: false, utf8: true, nlink: 1, bytesRead: text.length, stamp: 's', hash: 'h' }
    },
    scmRead: async (input: ScmReadInput) => {
      reads.push(`${input.side}:${input.rel}`)
      const text = blobs.get(`${input.side}:${input.rel}`)
      return text === undefined || text === null ? { ok: true, kind: 'missing' } : { ok: true, kind: 'text', text, size: text.length }
    },
    explorerWatch: async ({ root: watched, on }: { root: string; on: boolean }) => {
      watchCalls.push(`${on ? 'on' : 'off'}:${watched}`)
      return { ok: true }
    },
    explorerRefreshGit: (watched: string) => watchCalls.push(`refresh:${watched}`),
    onExplorerEvent: () => () => {},
    getUiPrefs: async () => ({ scmViewMode: 'list' }),
    setUiPrefs: () => {},
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  act(() => root.unmount())
  await flush()
  host.remove()
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await act(async () => await Promise.resolve())
}
const render = async (input: { target: ScmDiffTarget; stamp?: number; watch?: boolean }): Promise<void> => {
  act(() => root.render(createElement(DiffView, { root: '/r', target: input.target, stamp: input.stamp ?? 1, watch: input.watch ?? false, onOpenFile: () => {} })))
  await flush()
}
const WT: ScmDiffTarget = { mode: 'wt', rel: 'a.ts', orig: null }

describe('DiffView 내용', () => {
  it('작업 트리 diff — 왼쪽 = 인덱스, 오른쪽 = 작업 파일(모델 값)', async () => {
    blobs.set('index:a.ts', 'index text\n')
    files.set('a.ts', 'working text\n')
    await render({ target: WT })
    expect(made.editors).toEqual([{ kind: 'diff', large: false }])
    expect(made.models.map((model) => model.value)).toEqual(['index text\n', 'working text\n'])
    expect(host.querySelector('[data-scm-diff-host]')?.getAttribute('data-editor-ready')).toBe('diff')
  })
  it('stamp 가 바뀌면 다시 읽어 바뀐 모델 값만 교체(편집기는 새로 만들지 않는다)', async () => {
    blobs.set('index:a.ts', 'index text\n')
    files.set('a.ts', 'v1\n')
    await render({ target: WT, stamp: 1 })
    files.set('a.ts', 'v2\n')
    await render({ target: WT, stamp: 2 })
    expect(reads.filter((read) => read === 'working:a.ts')).toHaveLength(2)
    expect(made.editors).toHaveLength(1)
    expect(made.models.map((model) => model.value)).toEqual(['index text\n', 'v2\n'])
  })
  it('인덱스 추가 = 단일 편집기, 같은 탭 자리에서 diff 대상으로 바꾸면 diff 편집기', async () => {
    blobs.set('index:n.ts', 'new\n')
    await render({ target: { mode: 'idxOnly', rel: 'n.ts', orig: null } })
    expect(made.editors.map((editor) => editor.kind)).toEqual(['single'])
    expect(host.querySelector('[data-scm-diff-host]')?.getAttribute('data-editor-ready')).toBe('single')
    blobs.set('index:a.ts', 'i\n')
    files.set('a.ts', 'w\n')
    await render({ target: WT })
    expect(made.editors.map((editor) => editor.kind)).toEqual(['single', 'diff'])
  })
  it('오른쪽(작업 파일)이 없으면 「없습니다」 띠, 양쪽이 같으면 「변경 없음」 띠', async () => {
    blobs.set('index:a.ts', 'same\n')
    await render({ target: WT })
    expect(host.querySelector('[data-scm-diff-missing]')?.textContent).toContain('작업 트리 쪽에 이 파일이 없습니다')
    files.set('a.ts', 'same\n')
    await render({ target: WT, stamp: 2 })
    expect(host.querySelector('[data-scm-diff-missing]')).toBeNull()
    expect(host.querySelector('[data-scm-diff-unchanged]')).not.toBeNull()
  })
  it('20 MB 초과 = 대용량(plaintext · large) — 파일 탭과 같은 처리(R1-10)', async () => {
    const big = 'x'.repeat(20 * 1024 * 1024 + 1)
    blobs.set('index:a.ts', 'small\n')
    files.set('a.ts', big)
    await render({ target: WT })
    expect(made.editors).toEqual([{ kind: 'diff', large: true }])
    expect(made.languages.every((language) => language === 'plaintext')).toBe(true)
  })
})

describe('감시 구독 (S8 정정 r1 · R1-01 · 682 A11)', () => {
  it('보이는 diff 탭 = 그 루트 구독 on, 안 보이게 되면 off', async () => {
    files.set('a.ts', 'w\n')
    await render({ target: WT, watch: true })
    expect(watchCalls).toEqual(['on:/r'])
    await render({ target: WT, watch: false })
    expect(watchCalls).toEqual(['on:/r', 'off:/r'])
  })
  it('diff 탭이 안 보이고(watch false) 소스 제어 보기도 안 보이면 구독 0', async () => {
    files.set('a.ts', 'w\n')
    function Hidden(): React.JSX.Element {
      useScm({ root: '/r', active: false })
      return createElement(DiffView, { root: '/r', target: WT, stamp: 1, watch: false, onOpenFile: () => {} })
    }
    act(() => root.render(createElement(Hidden)))
    await flush()
    expect(watchCalls).toEqual([])
  })
})
