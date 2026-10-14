// 탐색기 실행 취소·다시 실행 기록 (LIFE-592 F4 · E5) — 순수 모델. **worktree 별**, 앱 메모리에만(재시작하면 비운다 — VS Code·Orca 와 같다), 단계 상한 50(Orca).
//
// 기록 한 칸 = 「지금 되돌리려면 부를 조작(`step`)」. 조작을 하나 하면 그 **역조작**을 실행 취소 칸에 넣고 다시 실행 칸을 비운다.
// 실행 취소 = 칸을 꺼내 그 조작을 부르고, 결과에서 다시 그 역조작을 만들어 다시 실행 칸에 넣는다(다시 실행은 거꾸로). 짝:
//   · 이름 변경·이동 (from → to)           ↔ 반대 이동(to → from) — 정체(dev:ino)가 같은 항목일 때만(`expect`)
//   · 만들기·복제·가져오기                ↔ 휴지통 — 만든 뒤 바뀌었으면 거절(`expect` 도장 — 폴더는 밑 전부, E5ⓒ·수정 r1 R1-C).
//                                          그 휴지통이 되면 다시 실행 = **같은 조작 재생**(`replay` — 만들기 그대로·같은 원본 복제·같은 원본 다시 가져오기, 수정 r1 R1-G)
//   · 삭제(파일 ≤ 5 MB — Q1)               ↔ 사본으로 다시 만들기 → 다시 실행 = 다시 휴지통
// Q1 의 「파일 ≤ 5 MB 만」 은 **사용자 삭제의 실행 취소**에만 걸린다 — 폴더·큰 파일 삭제는 칸을 만들지 않는다. 만들기·복제·가져오기 취소의 다시 실행은 재생이라 크기·폴더 제한이 없다.
// 가져오기 재생은 main 이 준 재생 표지(`replayToken` — 드롭 표지와 같은 2 분·한 번)로만 한다. 지나면 다시 실행이 `bad_token` 으로 거절되고 알린다.
// 조작이 실패하면(그 사이 바뀜·자리에 다른 것) 그 칸은 버리고 사유를 알린다(조용히 다른 것을 지우거나 덮지 않는다 — 판단은 main).
import { UNDO_HISTORY_LIMIT, type EntryMark, type ExplorerOpResult } from '../../shared/explorer-ops.js'

/** 다시 실행으로 다시 부를 원래 조작(R1-G). */
export type ReplayStep = { op: 'create'; dir: string; name: string; kind: 'file' | 'dir' } | { op: 'duplicate'; rel: string } | { op: 'import'; dir: string; token: string }

export type HistoryStep =
  | { op: 'move'; from: string; to: string; expect: string }
  /** `replay` = 이 휴지통이 만들기·복제·가져오기를 되돌린 것이면, 되돌린 뒤 다시 실행할 원래 조작. */
  | { op: 'trash'; rel: string; expect: EntryMark[]; replay?: ReplayStep }
  | { op: 'restore'; rel: string; snapshotId: string }
  /** 여러 항목(가져오기) — 차례로 부르고, 역조작도 차례를 뒤집어 묶는다. 전부 되면 `replay` 로 다시 실행. */
  | { op: 'batch'; steps: HistoryStep[]; replay?: ReplayStep }
  | { op: 'replay'; replay: ReplayStep }

export type HistoryEntry = { label: string; step: HistoryStep }
export type History = { undo: HistoryEntry[]; redo: HistoryEntry[] }

export const emptyHistory = (): History => ({ undo: [], redo: [] })

/** 새 조작 — 역조작을 실행 취소 칸에 넣고 다시 실행 칸을 비운다(E5ⓓ). 상한을 넘으면 가장 오래된 것부터 버린다. */
export function recordOp(history: History, entry: HistoryEntry | null): History {
  if (entry === null) return { undo: history.undo, redo: [] }
  return { undo: [...history.undo, entry].slice(-UNDO_HISTORY_LIMIT), redo: [] }
}

/** 꺼낼 칸(실행 취소면 undo 끝, 다시 실행이면 redo 끝). 없으면 null. */
export function peek(history: History, side: 'undo' | 'redo'): HistoryEntry | null {
  const list = history[side]
  return list[list.length - 1] ?? null
}

/** 꺼낸 칸을 부른 결과 — 그 칸을 빼고, 역조작이 있으면 반대쪽에 넣는다. */
export function settle(input: { history: History; side: 'undo' | 'redo'; inverse: HistoryEntry | null }): History {
  const { history, side } = input
  const rest = history[side].slice(0, -1)
  const other = side === 'undo' ? 'redo' : 'undo'
  const pushed = input.inverse === null ? history[other] : [...history[other], input.inverse].slice(-UNDO_HISTORY_LIMIT)
  return side === 'undo' ? { undo: rest, redo: pushed } : { undo: pushed, redo: rest }
}

/** 조작 결과 → 그것을 되돌릴 조작(역조작). 되돌릴 수 없으면 null. `step` = 방금 부른 조작(이동 역조작에 쓴다). */
export function inverseOf(result: ExplorerOpResult): HistoryStep | null {
  if (!result.ok) return null
  switch (result.op) {
    case 'move':
      return result.from === result.to ? null : { op: 'move', from: result.to, to: result.from, expect: result.id }
    case 'create': {
      // 처음 만든 것(중간 폴더를 만들었으면 그 맨 위 폴더)을 휴지통으로 — 만든 표지 전부가 그대로일 때만.
      // 다시 실행 = 그 자리에서 같은 이름으로 다시 만들기(처음 만든 것의 부모에서 나머지 경로 — 이미 있던 중간 폴더는 그대로 둔 채).
      const dir = parentOfRel(result.created)
      const name = dir === '' ? result.rel : result.rel.slice(dir.length + 1)
      return { op: 'trash', rel: result.created, expect: result.marks, replay: { op: 'create', dir, name, kind: result.kind } }
    }
    case 'duplicate':
      return { op: 'trash', rel: result.rel, expect: result.marks, replay: { op: 'duplicate', rel: result.from } }
    case 'import': {
      const steps = result.rels.map((rel, index): HistoryStep => ({ op: 'trash', rel, expect: result.marks[index] ?? [] }))
      const replay: ReplayStep | undefined = result.replayToken === null ? undefined : { op: 'import', dir: result.dir, token: result.replayToken }
      const only = steps[0]
      if (only === undefined) return null
      if (steps.length === 1 && only.op === 'trash') return replay === undefined ? only : { ...only, replay }
      return replay === undefined ? { op: 'batch', steps } : { op: 'batch', steps, replay }
    }
    case 'trash':
      return result.snapshotId === null ? null : { op: 'restore', rel: result.rel, snapshotId: result.snapshotId }
    case 'restore':
      return { op: 'trash', rel: result.rel, expect: result.marks }
    case 'inspect':
      return null
  }
}

/** 묶음 역조작 — 각 결과의 역조작을 거꾸로. 하나도 없으면 null. */
export function inverseOfBatch(results: readonly ExplorerOpResult[]): HistoryStep | null {
  const steps = results.map(inverseOf).filter((step): step is HistoryStep => step !== null).reverse()
  return steps.length === 0 ? null : steps.length === 1 ? (steps[0] ?? null) : { op: 'batch', steps }
}

function replayLabel(replay: ReplayStep): string {
  switch (replay.op) {
    case 'create':
      return `'${replay.name.slice(replay.name.lastIndexOf('/') + 1)}' 만들기`
    case 'duplicate':
      return `'${replay.rel.slice(replay.rel.lastIndexOf('/') + 1)}' 복제`
    case 'import':
      return '가져오기'
  }
}

const parentOfRel = (rel: string): string => {
  const index = rel.lastIndexOf('/')
  return index === -1 ? '' : rel.slice(0, index)
}

/** 조작 이름(알림 문구) — 「'<이름>' 이름 바꾸기」 류. */
export function stepLabel(step: HistoryStep): string {
  const name = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)
  switch (step.op) {
    case 'replay':
      return replayLabel(step.replay)
    case 'move':
      return `'${name(step.from)}' 이동`
    case 'trash':
      return `'${name(step.rel)}' 휴지통으로 이동`
    case 'restore':
      return `'${name(step.rel)}' 다시 만들기`
    case 'batch':
      return `${step.steps.length}개 항목`
  }
}
