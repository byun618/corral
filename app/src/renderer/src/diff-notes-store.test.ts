// @vitest-environment happy-dom
// diff 메모 보관·「보냄」 표시 (LIFE-832 L2·L7 상태 표·L8) — 01-criteria 상태 표의 각 행을 장면으로 돈다.
import { afterEach, describe, expect, it } from 'vitest'
import type { DiffNotesSendInput, DiffNotesSendResult, DiffNotesState } from '../../shared/diff-notes.js'
import { cancelDiffNotes, diffNotes, DiffNotesStore, sendDiffNotes } from './diff-notes-store.js'

const W1 = '/repo/wt1'
const W2 = '/repo/wt2'

function noted(store: DiffNotesStore) {
  store.upsert({ root: W1, rel: 'a.ts', line: 3, lineText: 'a3', body: '메모 a3', against: '인덱스' })
  store.upsert({ root: W1, rel: 'b.ts', line: 1, lineText: 'b1', body: '메모 b1', against: '인덱스' })
  return store.notesOf(W1)
}

const result = (requestId: string, state: DiffNotesState['state'], reason: string | null = null): DiffNotesState => ({ requestId, state, wait: null, reason })

describe('보관 (L1·L2)', () => {
  it('worktree 별 — 다른 worktree 에는 보이지 않는다 · 빈 메모는 저장하지 않는다 · 같은 줄은 고치기', () => {
    const store = new DiffNotesStore()
    noted(store)
    expect(store.notesOf(W1)).toHaveLength(2)
    expect(store.notesOf(W2)).toHaveLength(0)
    expect(store.upsert({ root: W1, rel: 'c.ts', line: 1, lineText: '', body: '  \n ', against: '인덱스' })).toBe('empty')
    expect(store.notesOf(W1)).toHaveLength(2)
    expect(store.upsert({ root: W1, rel: 'a.ts', line: 3, lineText: '바뀐 줄', body: '고친 메모', against: 'base main' })).toBe('saved')
    const fixed = store.notesOf(W1).find((note) => note.rel === 'a.ts')
    // 같은 (파일, 줄)은 한 메모 — 메모 단 때 줄 내용·기준은 처음 값 그대로.
    expect(fixed).toMatchObject({ body: '고친 메모', lineText: 'a3', against: '인덱스', rev: 2 })
    expect(store.notesOf(W1)).toHaveLength(2)
  })
  it('지우기', () => {
    const store = new DiffNotesStore()
    const [first] = noted(store)
    store.remove({ root: W1, id: first?.id ?? -1 })
    expect(store.notesOf(W1).map((note) => note.rel)).toEqual(['b.ts'])
  })
})

describe('상태 표 (L7)', () => {
  it('확인 → 접수: 보냄 그대로 · 그 worktree 보내기 막힘 · 다른 worktree 는 안 막힘', () => {
    const store = new DiffNotesStore()
    const notes = noted(store)
    expect(store.begin({ root: W1, requestId: 'r1', paneId: 'p', batch: notes })).toBe(true)
    expect(store.busy(W1)).toBe(true)
    expect(store.busy(W2)).toBe(false)
    expect(store.notesOf(W1).every((note) => !note.sent)).toBe(true)
    // 보내는 중에 두 번째 시작은 받지 않는다(L8).
    expect(store.begin({ root: W1, requestId: 'r2', paneId: 'p', batch: notes })).toBe(false)
    store.apply({ requestId: 'r1', state: 'queued', wait: 'turn', reason: null })
    expect(store.sendOf(W1)).toMatchObject({ state: 'queued', wait: 'turn' })
    store.apply(result('r1', 'sending'))
    expect(store.busy(W1)).toBe(true)
  })
  it('결과 들어감: 실렸고 지금도 같은 판인 메모에만 보냄 — 보내는 중 고친·지운·새로 단 메모는 건드리지 않는다 · 풀림', () => {
    const store = new DiffNotesStore()
    noted(store)
    store.upsert({ root: W1, rel: 'c.ts', line: 9, lineText: 'c9', body: '지울 메모', against: '인덱스' })
    store.begin({ root: W1, requestId: 'r1', paneId: 'p', batch: store.unsent(W1) })
    // 보내는 중에: a.ts 고침 · c.ts 지움 · d.ts 새로 닮.
    store.upsert({ root: W1, rel: 'a.ts', line: 3, lineText: 'a3', body: '보내는 중 고침', against: '인덱스' })
    const removed = store.notesOf(W1).find((note) => note.rel === 'c.ts')
    store.remove({ root: W1, id: removed?.id ?? -1 })
    store.upsert({ root: W1, rel: 'd.ts', line: 2, lineText: 'd2', body: '새 메모', against: '인덱스' })
    store.apply(result('r1', 'delivered'))
    const sent = Object.fromEntries(store.notesOf(W1).map((note) => [note.rel, note.sent]))
    expect(sent).toEqual({ 'a.ts': false, 'b.ts': true, 'd.ts': false })
    expect(store.busy(W1)).toBe(false)
    expect(store.sendOf(W1)?.state).toBe('delivered')
    // 다음 묶음 = 안 보낸 메모만(L8 — 보낸 메모는 다시 실리지 않는다).
    expect(store.unsent(W1).map((note) => note.rel)).toEqual(['a.ts', 'd.ts'])
  })
  const finals: [string, DiffNotesState['state'], string | null][] = [
    ['확인 못 함', 'unconfirmed', 'record_missing'],
    ['실패(사유)', 'failed', 'mac_draft'],
    ['대기 중 취소', 'cancelled', null],
  ]
  it.each(finals)('결과 %s: 보냄 세우지 않음 · 풀림 · 사유 그대로', (_name, state, reason) => {
    const store = new DiffNotesStore()
    noted(store)
    store.begin({ root: W1, requestId: 'r1', paneId: 'p', batch: store.unsent(W1) })
    store.apply(result('r1', state, reason))
    expect(store.notesOf(W1).some((note) => note.sent)).toBe(false)
    expect(store.busy(W1)).toBe(false)
    expect(store.sendOf(W1)).toMatchObject({ state, reason })
  })
  it('보낸 메모를 고치면 그 메모의 표시만 지운다 · 같은 글로 저장하면 그대로', () => {
    const store = new DiffNotesStore()
    noted(store)
    store.begin({ root: W1, requestId: 'r1', paneId: 'p', batch: store.unsent(W1) })
    store.apply(result('r1', 'delivered'))
    expect(store.upsert({ root: W1, rel: 'a.ts', line: 3, lineText: 'a3', body: '메모 a3', against: '인덱스' })).toBe('unchanged')
    store.upsert({ root: W1, rel: 'a.ts', line: 3, lineText: 'a3', body: '다시 고침', against: '인덱스' })
    expect(Object.fromEntries(store.notesOf(W1).map((note) => [note.rel, note.sent]))).toEqual({ 'a.ts': false, 'b.ts': true })
    store.clearSent(W1)
    expect(store.notesOf(W1).map((note) => note.rel)).toEqual(['a.ts'])
  })
  it('결과가 왔을 때 다른 worktree 를 보고 있어도 그 worktree 상태로만 — 다른 worktree 에는 결과가 없다 · 끝난 요청의 늦은 상태는 무시', () => {
    const store = new DiffNotesStore()
    noted(store)
    store.upsert({ root: W2, rel: 'x.ts', line: 1, lineText: 'x', body: 'w2 메모', against: '인덱스' })
    store.begin({ root: W1, requestId: 'r1', paneId: 'p', batch: store.unsent(W1) })
    store.apply(result('r1', 'delivered'))
    expect(store.sendOf(W2)).toBeNull()
    expect(store.notesOf(W2)[0]?.sent).toBe(false)
    store.apply(result('r1', 'failed', 'late'))
    expect(store.sendOf(W1)?.state).toBe('delivered')
    store.dismiss(W1)
    expect(store.sendOf(W1)).toBeNull()
  })
})

describe('보내기 IPC (L8·L3)', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'corral')
  })
  it('확인 연타 3회 → IPC 1회 · main 거절이면 실패로 끝나고 풀린다 · 대기 중 취소는 그 요청 id 로', async () => {
    const calls: DiffNotesSendInput[] = []
    const cancels: string[] = []
    let answer: DiffNotesSendResult = { ok: true }
    Reflect.set(window, 'corral', {
      diffNotesSend: async (input: DiffNotesSendInput) => {
        calls.push(input)
        return answer
      },
      diffNotesCancel: ({ requestId }: { requestId: string }) => cancels.push(requestId),
    })
    const root = '/repo/ipc'
    diffNotes.upsert({ root, rel: 'a.ts', line: 1, lineText: 'a', body: 'm', against: '인덱스' })
    const batch = diffNotes.unsent(root)
    await Promise.all([0, 1, 2].map(() => sendDiffNotes({ root, paneId: 'p1', text: 'BODY', batch })))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ worktree: root, paneId: 'p1', text: 'BODY' })
    cancelDiffNotes(root)
    expect(cancels).toEqual([calls[0]?.requestId])
    diffNotes.apply(result(calls[0]?.requestId ?? '', 'cancelled'))
    answer = { ok: false, reason: 'not_target' }
    await sendDiffNotes({ root, paneId: 'p1', text: 'BODY', batch })
    expect(diffNotes.sendOf(root)).toMatchObject({ state: 'failed', reason: 'not_target' })
    expect(diffNotes.busy(root)).toBe(false)
  })
})
