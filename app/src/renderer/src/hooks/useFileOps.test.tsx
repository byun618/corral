// @vitest-environment happy-dom
// LIFE-592 수정 r1 — `useFileOps` 회귀(실제 hook 마운트 · main IPC 는 가짜).
//   R1-A 대기 중인 조작은 **요청 시점의 worktree** 로 간다 — 앞 IPC 가 끝나기 전에 worktree 를 바꿔도(리뷰어 R10/R19 방식) 후속 조작의 root·완료 뒤 UI 반영이 요청한 쪽
//   R1-G 만들기(중간 폴더 포함)·복제·가져오기를 실행 취소한 뒤 ⌘⇧Z = 같은 조작 재생
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { EntryMark, ExplorerDrop, ExplorerOpInput, ExplorerOpResult } from '../../../shared/explorer-ops.js'
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
        return { ok: true, op: 'duplicate', from: input.rel, rel: `${input.rel} copy`, kind: 'dir', marks: [{ rel: `${input.rel} copy`, stamp: 's' }], skipped: [], failed: [], source: 'src-stamp' }
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
  expect(calls[2]).toMatchObject({ root: '/wt/a', rel: 'folder', again: { name: 'folder copy', source: 'src-stamp' } })
})

// --- 수정 r2 ------------------------------------------------------------------------------------------------
//   R2-F 여러 항목 가져오기의 부분 실행 취소 — 안내가 치운 것·거절된 것을 나누고, 치운 것은 다시 실행할 수 있다
//   R2-H 다시 실행(재생) 결과의 부분 실패·덜 든 항목도 일반 조작과 같은 안내
//   R2-E 가져오기 재생 근거 — 기록에서 빠지면(새 조작이 다시 실행 칸을 비움) main 에 놓으라고(release) 알린다
const importResult = (rels: string[], extra: { marks?: EntryMark[][]; partial?: string[]; failed?: { name: string; error: string }[] } = {}): ExplorerOpResult => ({
  ok: true,
  op: 'import',
  dir: '',
  rels,
  marks: rels.map((rel) => [{ rel, stamp: `s-${rel}` }]),
  skipped: [],
  failed: [],
  partial: [],
  replayId: 'replay-1',
  ...extra,
})
const dropOf = (root: string): ExplorerDrop => ({ token: 'drop-1', root, dir: '', names: ['a.txt', 'b.txt'] })

it('R2-F — 두 항목 가져오기 실행 취소에서 하나만 거절되면 안내가 치움·거절을 나누고, 치운 것만 다시 실행한다', async () => {
  respond = (input) => {
    switch (input.op) {
      case 'import':
        return importResult(['a.txt', 'b.txt'])
      case 'trash':
        return input.rel === 'a.txt' ? { ok: true, op: 'trash', rel: input.rel, kind: 'file', snapshotId: null } : { ok: false, code: 'modified', error: 'changed after import' }
      default:
        return { ok: false, code: 'io_error', error: 'x' }
    }
  }
  await act(async () => render('/wt/a'))
  await act(async () => ops().importDrop(dropOf('/wt/a')))
  await act(async () => ops().undo())
  expect(notes).toHaveLength(1)
  expect(notes[0]).toMatch(/치움 1: a\.txt/)
  expect(notes[0]).toMatch(/거절 1: b\.txt/)
  respond = (input) => (input.op === 'import' ? importResult(['a.txt']) : { ok: false, code: 'io_error', error: 'x' })
  await act(async () => ops().redo())
  const redo = calls[calls.length - 1]
  expect(redo).toMatchObject({ op: 'import', root: '/wt/a', replay: 'replay-1', names: ['a.txt'] })
})

it('R2-H — 다시 실행한 가져오기·복제의 부분 실패를 알린다', async () => {
  respond = (input) => {
    switch (input.op) {
      case 'import':
        return importResult(['a.txt'])
      case 'trash':
        return { ok: true, op: 'trash', rel: input.rel, kind: 'file', snapshotId: null }
      default:
        return { ok: false, code: 'io_error', error: 'x' }
    }
  }
  await act(async () => render('/wt/a'))
  await act(async () => ops().importDrop(dropOf('/wt/a')))
  await act(async () => ops().undo())
  respond = (input) => (input.op === 'import' ? importResult(['a.txt'], { partial: ['a.txt'], failed: [{ name: 'a.txt', error: 'ENOSPC' }] }) : { ok: false, code: 'io_error', error: 'x' })
  await act(async () => ops().redo())
  expect(notes.join('\n')).toMatch(/내용이 덜 든 채 남은 항목 1: a\.txt/)
  expect(notes.join('\n')).toMatch(/실패 1: a\.txt — ENOSPC/)

  notes = []
  gate = () => undefined
  respond = (input) => {
    switch (input.op) {
      case 'duplicate':
        return { ok: true, op: 'duplicate', from: 'folder', rel: 'folder copy', kind: 'dir', marks: [{ rel: 'folder copy', stamp: 's' }], skipped: [], failed: [], source: 'src-stamp' }
      case 'trash':
        return { ok: true, op: 'trash', rel: input.rel, kind: 'dir', snapshotId: null }
      default:
        return { ok: false, code: 'io_error', error: 'x' }
    }
  }
  await act(async () => ops().duplicate('folder'))
  await act(async () => ops().undo())
  respond = (input) =>
    input.op === 'duplicate'
      ? ({ ok: true, op: 'duplicate', from: 'folder', rel: 'folder copy', kind: 'dir', marks: [{ rel: 'folder copy', stamp: 's' }], skipped: [], failed: [{ name: 'folder/x', error: 'EACCES' }], source: 'src-stamp' })
      : { ok: false, code: 'io_error', error: 'x' }
  await act(async () => ops().redo())
  expect(notes.join('\n')).toMatch(/실패 1: folder\/x — EACCES/)
})

it('R2-E — 가져오기 재생 근거가 기록에서 빠지면(다시 실행 칸 비움) main 에 놓으라고 알린다', async () => {
  respond = (input) => {
    switch (input.op) {
      case 'import':
        return importResult(['a.txt'])
      case 'trash':
        return { ok: true, op: 'trash', rel: input.rel, kind: 'file', snapshotId: null }
      case 'create':
        return { ok: true, op: 'create', rel: input.name, kind: input.kind, created: input.name, marks: [{ rel: input.name, stamp: 's' }] }
      case 'release':
        return { ok: true, op: 'release' }
      default:
        return { ok: false, code: 'io_error', error: 'x' }
    }
  }
  await act(async () => render('/wt/a'))
  await act(async () => ops().importDrop(dropOf('/wt/a')))
  await act(async () => ops().undo())
  expect(calls.some((call) => call.op === 'release')).toBe(false)
  await act(async () => {
    await ops().create({ dir: '', name: 'l592-new.txt', kind: 'file' })
  })
  expect(calls.find((call) => call.op === 'release')).toMatchObject({ op: 'release', ids: ['replay-1'] })
})

it('M-3 — 바뀜을 확인할 수 없는 항목(R2-G): 가져올 때 미리 알리고, 실행 취소 거절 안내에 그 사유를 적는다', async () => {
  respond = (input) => {
    switch (input.op) {
      case 'import':
        return importResult(['locked'], { marks: [[{ rel: 'locked', stamp: 'unverifiable' }]], partial: ['locked'], failed: [{ name: 'locked', error: 'EACCES' }] })
      case 'trash':
        return { ok: false, code: 'modified', error: 'unverifiable' }
      default:
        return { ok: false, code: 'io_error', error: 'x' }
    }
  }
  await act(async () => render('/wt/a'))
  await act(async () => ops().importDrop(dropOf('/wt/a')))
  expect(notes[0]).toMatch(/바뀌었는지 확인할 수 없는 항목 1: locked/)
  await act(async () => ops().undo())
  expect(notes[1]).toMatch(/확인할 수 없/)
})

it('R2-E — 실행 취소 칸 상한(50)으로 가져오기 기록이 밀려나면 그 재생 근거를 놓는다', async () => {
  respond = (input) => {
    switch (input.op) {
      case 'import':
        return importResult(['a.txt'])
      case 'create':
        return { ok: true, op: 'create', rel: input.name, kind: input.kind, created: input.name, marks: [{ rel: input.name, stamp: 's' }] }
      case 'release':
        return { ok: true, op: 'release' }
      default:
        return { ok: false, code: 'io_error', error: 'x' }
    }
  }
  await act(async () => render('/wt/a'))
  await act(async () => ops().importDrop(dropOf('/wt/a')))
  for (let index = 0; index < 49; index += 1) await act(async () => void (await ops().create({ dir: '', name: `l592-${index}.txt`, kind: 'file' })))
  expect(calls.some((call) => call.op === 'release')).toBe(false)
  await act(async () => void (await ops().create({ dir: '', name: 'l592-last.txt', kind: 'file' })))
  expect(calls.filter((call) => call.op === 'release')).toEqual([{ op: 'release', ids: ['replay-1'] }])
})

// --- 수정 r3 ------------------------------------------------------------------------------------------------
//   R3-C 중간 폴더 만들기의 다시 실행은 원래 맨 위 자리가 비어 있을 때만(`again`)
//   R3-D 중간 폴더가 남은 부분 실패 — 입력 행 오류·알림에 남은 폴더 이름
//   R3-E 확인 불가 항목은 안내 하나(「⌘Z 로 지우지 않음」 — 「휴지통에 보낼 수 있다」 를 같이 내지 않는다)
//   재생 근거 수명 — hook 이 사라지면(언마운트) 붙잡던 재생 근거를 놓는다
it('R3-C — 중간 폴더 만들기 다시 실행 요청은 again(원래 맨 위 자리 빔 확인)을 싣는다', async () => {
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
  await act(async () => void (await ops().create({ dir: 'src', name: 'n/sub/file.txt', kind: 'file' })))
  expect(calls[0]).not.toHaveProperty('again')
  await act(async () => ops().undo())
  await act(async () => ops().redo())
  expect(calls[2]).toMatchObject({ op: 'create', dir: 'src', name: 'n/sub/file.txt', again: true })
})

it('R3-D — 중간 폴더가 남은 부분 실패는 입력 행 오류와 알림에 남은 폴더를 적는다', async () => {
  respond = () => ({ ok: false, code: 'permission_denied', error: "폴더 만들기: 권한 없음 — 중간 폴더 'remaining' 는 만들어졌다", done: true, remains: ['remaining'] })
  await act(async () => render('/wt/a'))
  let message: string | null = null
  await act(async () => {
    message = await ops().create({ dir: '', name: 'remaining/child/file.txt', kind: 'file' })
  })
  expect(message).toMatch(/remaining/)
  expect(notes.join('\n')).toMatch(/remaining/)
})

it('R3-E — 확인 불가 항목은 「⌘Z 로 지우지 않음」 안내 하나만', async () => {
  respond = (input) =>
    input.op === 'import'
      ? importResult(['good', 'locked'], { marks: [[{ rel: 'good', stamp: 's' }], [{ rel: 'locked', stamp: 'unverifiable' }]], partial: ['locked'], failed: [{ name: 'locked', error: 'EACCES' }] })
      : { ok: false, code: 'io_error', error: 'x' }
  await act(async () => render('/wt/a'))
  await act(async () => ops().importDrop(dropOf('/wt/a')))
  expect(notes).toHaveLength(1)
  expect(notes[0]).toMatch(/바뀌었는지 확인할 수 없는 항목 1: locked/)
  expect(notes[0]).not.toMatch(/휴지통에 보낼 수 있습니다/)
})

it('재생 근거 수명 — hook 이 언마운트되면 붙잡던 재생 근거를 main 에서 놓는다', async () => {
  respond = (input) => (input.op === 'import' ? importResult(['a.txt']) : input.op === 'release' ? { ok: true, op: 'release' } : { ok: false, code: 'io_error', error: 'x' })
  await act(async () => render('/wt/a'))
  await act(async () => ops().importDrop(dropOf('/wt/a')))
  act(() => tree.unmount())
  tree = createRoot(host)
  expect(calls.filter((call) => call.op === 'release')).toEqual([{ op: 'release', ids: ['replay-1'] }])
})
