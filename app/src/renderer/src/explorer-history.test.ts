// LIFE-592 E5 — 탐색기 실행 취소·다시 실행 기록(단위). 역조작 짝·다시 실행 비움·상한·묶음 역순.
import { describe, expect, it } from 'vitest'
import { emptyHistory, inverseOf, inverseOfBatch, peek, recordOp, settle, stepLabel, type HistoryEntry } from './explorer-history.js'
import { UNDO_HISTORY_LIMIT, type ExplorerOpResult } from '../../shared/explorer-ops.js'

const mark = (rel: string) => [{ rel, stamp: `s:${rel}` }]
const entry = (rel: string): HistoryEntry => ({ label: rel, step: { op: 'trash', rel, expect: mark(rel) } })

describe('역조작 짝', () => {
  it('이동 ↔ 반대 이동(정체 도장), 같은 경로면 없음', () => {
    expect(inverseOf({ ok: true, op: 'move', from: 'a.ts', to: 'b.ts', id: '1:2' })).toEqual({ op: 'move', from: 'b.ts', to: 'a.ts', expect: '1:2' })
    expect(inverseOf({ ok: true, op: 'move', from: 'a.ts', to: 'a.ts', id: '1:2' })).toBeNull()
  })
  it('만들기 = 처음 만든 맨 위(중간 폴더 포함)를 휴지통 · 복제·되살리기도 휴지통 — 만들기·복제는 다시 실행 재생을 싣는다(수정 r1 R1-G)', () => {
    expect(inverseOf({ ok: true, op: 'create', rel: 'a/b/c.ts', kind: 'file', created: 'a', marks: mark('a') })).toEqual({ op: 'trash', rel: 'a', expect: mark('a'), replay: { op: 'create', dir: '', name: 'a/b/c.ts', kind: 'file' } })
    expect(inverseOf({ ok: true, op: 'create', rel: 'src/n/sub/f.ts', kind: 'file', created: 'src/n/sub', marks: mark('src/n/sub') })).toEqual({ op: 'trash', rel: 'src/n/sub', expect: mark('src/n/sub'), replay: { op: 'create', dir: 'src/n', name: 'sub/f.ts', kind: 'file' } })
    expect(inverseOf({ ok: true, op: 'duplicate', from: 'x.ts', rel: 'x copy.ts', kind: 'file', marks: mark('x copy.ts'), failed: [] })).toEqual({ op: 'trash', rel: 'x copy.ts', expect: mark('x copy.ts'), replay: { op: 'duplicate', rel: 'x.ts' } })
    expect(inverseOf({ ok: true, op: 'restore', rel: 'r.ts', marks: mark('r.ts'), hash: 'h', stamp: 's' })).toEqual({ op: 'trash', rel: 'r.ts', expect: mark('r.ts') })
  })
  it('삭제 — 사본이 있을 때만 되살리기(Q1), 없으면 항목 없음', () => {
    expect(inverseOf({ ok: true, op: 'trash', rel: 'a.ts', kind: 'file', snapshotId: 'p1' })).toEqual({ op: 'restore', rel: 'a.ts', snapshotId: 'p1' })
    expect(inverseOf({ ok: true, op: 'trash', rel: 'dir', kind: 'dir', snapshotId: null })).toBeNull()
  })
  it('가져오기 = 항목마다 휴지통 묶음 + 재생 표지가 있으면 다시 실행, 실패·확인은 없음', () => {
    const imported: ExplorerOpResult = { ok: true, op: 'import', dir: '', rels: ['a', 'b'], marks: [mark('a'), mark('b')], skipped: [], failed: [], partial: [], replayToken: 't1' }
    expect(inverseOf(imported)).toEqual({ op: 'batch', steps: [{ op: 'trash', rel: 'a', expect: mark('a') }, { op: 'trash', rel: 'b', expect: mark('b') }], replay: { op: 'import', dir: '', token: 't1' } })
    expect(inverseOf({ ...imported, rels: ['a'], marks: [mark('a')], replayToken: null })).toEqual({ op: 'trash', rel: 'a', expect: mark('a') })
    expect(inverseOf({ ...imported, rels: ['a'], marks: [mark('a')] })).toEqual({ op: 'trash', rel: 'a', expect: mark('a'), replay: { op: 'import', dir: '', token: 't1' } })
    expect(inverseOf({ ok: false, code: 'exists', error: '' })).toBeNull()
    expect(inverseOf({ ok: true, op: 'inspect', rel: 'a', kind: 'file', size: 1, undoable: true })).toBeNull()
  })
  it('묶음 역조작은 거꾸로, 실패한 결과는 빠진다', () => {
    const results: ExplorerOpResult[] = [
      { ok: true, op: 'trash', rel: 'a', kind: 'file', snapshotId: 'p1' },
      { ok: false, code: 'modified', error: '' },
      { ok: true, op: 'trash', rel: 'b', kind: 'file', snapshotId: 'p2' },
    ]
    expect(inverseOfBatch(results)).toEqual({ op: 'batch', steps: [{ op: 'restore', rel: 'b', snapshotId: 'p2' }, { op: 'restore', rel: 'a', snapshotId: 'p1' }] })
    expect(inverseOfBatch([results[0]!])).toEqual({ op: 'restore', rel: 'a', snapshotId: 'p1' })
    expect(inverseOfBatch([])).toBeNull()
  })
})

describe('기록 (E5ⓓ)', () => {
  it('새 조작은 다시 실행 칸을 비운다 — 역조작이 없는 조작도', () => {
    let history = recordOp(emptyHistory(), entry('a'))
    history = settle({ history, side: 'undo', inverse: entry('a2') })
    expect(history).toEqual({ undo: [], redo: [entry('a2')] })
    expect(recordOp(history, null)).toEqual({ undo: [], redo: [] })
    expect(recordOp(history, entry('b'))).toEqual({ undo: [entry('b')], redo: [] })
  })
  it('실행 취소 → 다시 실행 왕복, 역조작이 없으면 반대 칸에 안 넣는다', () => {
    let history = recordOp(recordOp(emptyHistory(), entry('a')), entry('b'))
    expect(peek(history, 'undo')).toEqual(entry('b'))
    history = settle({ history, side: 'undo', inverse: entry('b-redo') })
    expect(peek(history, 'redo')).toEqual(entry('b-redo'))
    history = settle({ history, side: 'redo', inverse: entry('b2') })
    expect(history.undo.map((item) => item.label)).toEqual(['a', 'b2'])
    history = settle({ history, side: 'undo', inverse: null })
    expect(history).toEqual({ undo: [entry('a')], redo: [] })
    expect(peek(emptyHistory(), 'redo')).toBeNull()
  })
  it(`상한 ${UNDO_HISTORY_LIMIT} — 가장 오래된 것부터 버린다`, () => {
    let history = emptyHistory()
    for (let index = 0; index < UNDO_HISTORY_LIMIT + 5; index += 1) history = recordOp(history, entry(`e${index}`))
    expect(history.undo).toHaveLength(UNDO_HISTORY_LIMIT)
    expect(history.undo[0]?.label).toBe('e5')
  })
  it('알림 이름', () => {
    expect(stepLabel({ op: 'move', from: 'src/a.ts', to: 'b.ts', expect: '' })).toBe("'a.ts' 이동")
    expect(stepLabel({ op: 'restore', rel: 'x/y.md', snapshotId: 'p' })).toBe("'y.md' 다시 만들기")
    expect(stepLabel({ op: 'batch', steps: [] })).toBe('0개 항목')
    expect(stepLabel({ op: 'replay', replay: { op: 'create', dir: '', name: 'a/b.ts', kind: 'file' } })).toBe("'b.ts' 만들기")
  })
})
