// @vitest-environment happy-dom
// LIFE-592 수정 r1 — `useFileOps` 회귀(실제 hook 마운트 · main IPC 는 가짜).
//   R1-A 대기 중인 조작은 **요청 시점의 worktree** 로 간다 — 앞 IPC 가 끝나기 전에 worktree 를 바꿔도(리뷰어 R10/R19 방식) 후속 조작의 root·완료 뒤 UI 반영이 요청한 쪽
//   R1-G 만들기(중간 폴더 포함)·복제·가져오기를 실행 취소한 뒤 ⌘⇧Z = 같은 조작 재생
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ExplorerOpInput, ExplorerOpResult } from '../../../shared/explorer-ops.js'
import { useFileOps, type FileOpsApi, type FileOpsDeps } from './useFileOps.js'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

type Call = ExplorerOpInput
let calls: Call[] = []
let gate: ((result: ExplorerOpResult) => void) | null = null
let respond: (input: Call) => ExplorerOpResult = () => ({ ok: false, code: 'io_error', error: 'unset' })
let retargets: { worktreePath: string; from: string; to: string }[] = []
let notes: string[] = []
let api: FileOpsApi | null = null
let host: HTMLDivElement
let tree: Root

const explorerOf = (root: string): FileOpsDeps['explorer'] => {
  const noop = (): void => undefined
  return {
    root,
    state: null,
    filter: { showDotfiles: true, showIgnored: true },
    version: 0,
    toggle: noop,
    expand: noop,
    collapse: noop,
    select: noop,
    reveal: () => true,
    setScrollTop: noop,
    collapseAll: noop,
    refresh: noop,
    setFilter: noop,
    reloadDirs: noop,
    remap: noop,
  }
}
const depsOf = (root: string): FileOpsDeps => ({
  root,
  explorer: explorerOf(root),
  layout: {
    closeFiles: () => undefined,
    fileLayoutOf: () => null,
    retargetFiles: (input) => {
      retargets.push(input)
      return []
    },
  },
  viewStatesOf: () => new Map(),
  markdownModesOf: () => new Map(),
  recentlyClosedRef: { current: {} },
  notify: (message) => notes.push(message),
  openFile: () => undefined,
  holdWatch: () => () => undefined,
})
function Probe({ root }: { root: string }): null {
  api = useFileOps(depsOf(root))
  return null
}
const render = (root: string): void => tree.render(createElement(Probe, { root }))
const ops = (): FileOpsApi => {
  if (api === null) throw new Error('hook 미마운트')
  return api
}

beforeEach(() => {
  calls = []
  gate = null
  retargets = []
  notes = []
  Reflect.set(window, 'corral', {
    explorerOp: (input: Call) => {
      calls.push(input)
      if (calls.length === 1 && gate === null && input.op === 'duplicate')
        return new Promise<ExplorerOpResult>((resolve) => {
          gate = resolve
        })
      return Promise.resolve(respond(input))
    },
    fileDialog: async () => 'trash',
  })
  host = document.createElement('div')
  document.body.append(host)
  tree = createRoot(host)
})
afterEach(() => {
  act(() => tree.unmount())
  host.remove()
})

it('R1-A — 앞 조작을 기다리는 동안 worktree 를 바꿔도 이름 변경은 요청한 worktree 로 가고, 탭 반영도 그 worktree', async () => {
  respond = (input) => (input.op === 'move' ? { ok: true, op: 'move', from: input.from, to: input.to, id: '1:2' } : { ok: false, code: 'io_error', error: 'x' })
  await act(async () => render('/wt/a'))
  await act(async () => {
    void ops().duplicate('big-folder')
    await Promise.resolve()
  })
  let queued: Promise<string | null> = Promise.resolve(null)
  await act(async () => {
    queued = ops().rename({ rel: 'l592-original.txt', name: 'l592-renamed.txt' })
    render('/wt/b')
  })
  await act(async () => {
    gate?.({ ok: false, code: 'io_error', error: 'release' })
    await queued
  })
  const move = calls.find((call) => call.op === 'move')
  expect(move?.root).toBe('/wt/a')
  expect(retargets).toEqual([{ worktreePath: '/wt/a', from: 'l592-original.txt', to: 'l592-renamed.txt' }])
})

it('R1-A — 실행 취소도 요청 시점 worktree 의 기록을 쓴다', async () => {
  respond = (input) => (input.op === 'move' ? { ok: true, op: 'move', from: input.from, to: input.to, id: '1:2' } : { ok: false, code: 'io_error', error: 'x' })
  await act(async () => render('/wt/a'))
  await act(async () => {
    await ops().rename({ rel: 'x.txt', name: 'y.txt' })
  })
  // a 의 기록이 있는 채로, 앞 조작(복제)이 걸린 동안 ⌘Z 를 누르고 b 로 바꾼다 — ⌘Z 는 a 의 기록을 a 에.
  calls = []
  gate = null
  await act(async () => {
    void ops().duplicate('big-folder')
    await Promise.resolve()
  })
  let queued: Promise<void> = Promise.resolve()
  await act(async () => {
    queued = ops().undo()
    render('/wt/b')
  })
  await act(async () => {
    gate?.({ ok: false, code: 'io_error', error: 'release' })
    await queued
  })
  const undo = calls.find((call) => call.op === 'move')
  expect(undo).toMatchObject({ root: '/wt/a', from: 'y.txt', to: 'x.txt' })
})

it('R1-G — 중간 폴더까지 만든 것을 실행 취소한 뒤 다시 실행 = 같은 만들기 재생', async () => {
  respond = (input) => {
    switch (input.op) {
      case 'create':
        return { ok: true, op: 'create', rel: `${input.dir}/${input.name}`, kind: input.kind, created: `${input.dir}/${input.name.split('/')[0]}`, marks: [{ rel: 'x', stamp: 's' }] }
      case 'trash':
        return { ok: true, op: 'trash', rel: input.rel, kind: 'dir', snapshotId: null }
      default:
        return { ok: false, code: 'io_error', error: 'x' }
    }
  }
  await act(async () => render('/wt/a'))
  await act(async () => {
    await ops().create({ dir: 'src', name: 'n/sub/file.txt', kind: 'file' })
  })
  await act(async () => {
    await ops().undo()
  })
  await act(async () => {
    await ops().redo()
  })
  expect(calls.map((call) => call.op)).toEqual(['create', 'trash', 'create'])
  expect(calls[2]).toMatchObject({ root: '/wt/a', dir: 'src', name: 'n/sub/file.txt', kind: 'file' })
  expect(notes).toEqual([])
})

it('R1-G — 폴더 복제를 실행 취소한 뒤 다시 실행 = 같은 원본 복제 재생', async () => {
  respond = (input) => {
    switch (input.op) {
      case 'duplicate':
        return { ok: true, op: 'duplicate', from: input.rel, rel: `${input.rel} copy`, kind: 'dir', marks: [{ rel: `${input.rel} copy`, stamp: 's' }], failed: [] }
      case 'trash':
        return { ok: true, op: 'trash', rel: input.rel, kind: 'dir', snapshotId: null }
      default:
        return { ok: false, code: 'io_error', error: 'x' }
    }
  }
  gate = () => undefined // 첫 복제를 붙잡지 않는다
  await act(async () => render('/wt/a'))
  await act(async () => {
    await ops().duplicate('folder')
  })
  await act(async () => {
    await ops().undo()
  })
  await act(async () => {
    await ops().redo()
  })
  expect(calls.map((call) => call.op)).toEqual(['duplicate', 'trash', 'duplicate'])
  expect(calls[2]).toMatchObject({ root: '/wt/a', rel: 'folder' })
})
