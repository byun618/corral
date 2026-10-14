// 탐색기 파일 조작 흐름 (LIFE-592 F4) — main 조작(`window.corral.explorerOp`)을 부르고, 그 결과를 **열린 탭·문서·탐색기 상태·실행 취소 기록**에 반영한다.
//
// · 이름 변경·이동(E4): 부르기 전에 ① 대상 경로에 열린 탭·문서가 있으면 거절(같은 파일 탭이 둘이 되지 않게) ② 옮길 문서 중 저장 중인 것이 있으면 거절
//   ③ 옮길 문서의 저장을 붙잡고(`holdDocs` — 끝난 뒤 새 경로에 쓴다) ④ 그 경로들의 감시 push 를 붙잡는다(앱이 한 이동의 「삭제됨」 깜빡임 0 — Orca 와 같은 결).
//   성공하면 같은 틱에 문서 키(모델 그대로 — 내용·수정 표시·편집 실행 취소 기록 유지)·탭 id·view state·Markdown 모드·닫은 탭 기록·탐색기 펼침/선택을 옮긴다.
// · 삭제(E3·Q2·Q3): 확인 대화상자 → 휴지통 → 수정 없는 탭은 닫고(문서 버림), 수정 중인 탭은 남긴다(감시가 「삭제됨」 을 단다 — F2·F3 기존 경로).
// · 되살리기(E5): 사본으로 다시 만든 파일이 남은 수정 중 탭이 기대던 내용과 같으면 그 문서의 기준 stamp 만 옮긴다(「삭제됨」 이 풀리고 배너 없음).
// · 실행 취소 기록은 worktree 경로별(`explorer-history.ts`). 조작은 한 줄로 선다(실행 취소·다시 실행·새 조작이 서로 끼지 않게).
// · **소유 worktree 는 요청 시점에 고정한다**(수정 r1 R1-A) — 줄을 서는 동안 화면 worktree 가 바뀌어도 조작·기록·완료 뒤 반영(탭·문서·트리)은 요청한 worktree 로 간다.
//   트리 반영(펼침·선택·다시 읽기·새 파일 열기)은 그 worktree 가 아직 화면에 있을 때만 한다.
import { useCallback, useEffect, useRef } from 'react'
import { baseName, isAtOrUnder, remapRel, UNVERIFIABLE, type EntryMark, type ExplorerDrop, type ExplorerOpInput, type ExplorerOpResult } from '../../../shared/explorer-ops.js'
import { parentRel } from '../../../shared/explorer.js'
import { emptyHistory, inverseOf, inverseOfBatch, narrowReplay, peek, recordOp, replayIdsOf, settle, stepLabel, type History, type HistoryStep, type ReplayStep } from '../explorer-history.js'
import { allDocs, disposeDoc, docKey, getDoc, holdDocs, rebaseDoc, rekeyDocs } from '../file-docs.js'
import { fileTabsUnder, tabKindOf } from '../file-tabs.js'
import type { GroupLayoutApi } from './useGroupLayout.js'
import type { ExplorerApi } from './useExplorer.js'
import { retargetLiveEditors, type MarkdownModeStore, type ViewStateStore } from '../components/FileView.js'
import { remapClosedFiles, type RecentlyClosed } from '../recently-closed.js'

type Refusal = Extract<ExplorerOpResult, { ok: false }>
const refusal = (code: Refusal['code'], error: string): Refusal => ({ ok: false, code, error })

/** 탭 id 로 묶인 저장소(view state·Markdown 모드)의 키를 옮긴다. */
function moveKeys<V>(store: Map<string, V>, moved: readonly { from: string; to: string }[]): void {
  for (const pair of moved) {
    const value = store.get(pair.from)
    if (value === undefined) continue
    store.delete(pair.from)
    store.set(pair.to, value)
  }
}

export type FileOpsDeps = {
  /** 지금 탐색기가 보이는 worktree(활성 worktree 경로). */
  root: string | null
  explorer: ExplorerApi
  layout: Pick<GroupLayoutApi, 'fileLayoutOf' | 'closeFiles' | 'retargetFiles'>
  viewStatesOf: (root: string) => ViewStateStore
  markdownModesOf: (root: string) => MarkdownModeStore
  recentlyClosedRef: { current: RecentlyClosed }
  notify: (message: string) => void
  /** 파일 탭 열기(탐색기와 같은 길 — 새 파일은 고정 탭으로, E1ⓔ). */
  openFile: (input: { rel: string; preview: boolean }) => void
  /** 열린 파일 감시 push 를 붙잡는다(그 경로들) — 돌려준 함수가 풀고, 붙잡은 동안 온 마지막 상태를 반영한다(App `fileWatchState` — 수정 r1 R1-D). */
  holdWatch: (input: { root: string; prefixes: string[] }) => () => void
}

export type FileOpsApi = {
  /** 새 파일·폴더 — 실패면 입력 행에 보일 문구, 성공이면 null. */
  create: (input: { dir: string; name: string; kind: 'file' | 'dir' }) => Promise<string | null>
  rename: (input: { rel: string; name: string }) => Promise<string | null>
  move: (input: { from: string; toDir: string }) => Promise<void>
  trash: (rel: string) => Promise<void>
  duplicate: (rel: string) => Promise<void>
  importDrop: (drop: ExplorerDrop) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
}

/** 실행 취소 거절 사유 — 그 칸의 표지가 「확인 불가」(R2-G)면 그렇게 적는다(「바뀌었다」 가 아니라 「확인할 수 없다」). */
function stepFailureMessage(step: HistoryStep, result: Refusal): string {
  if (result.code === 'modified' && step.op === 'trash' && step.expect.some((mark) => mark.stamp === UNVERIFIABLE)) return `읽을 수 없는 하위 항목이 있어 바뀌었는지 확인할 수 없습니다 — 지우지 않았습니다(직접 정리하세요) (${result.code})`
  return opFailureMessage(result)
}

/** 거절 사유 → 사람 말(알림). 코드는 괄호로 남긴다(회차 원자료가 어느 검사에서 났는지 본다). */
export function opFailureMessage(result: Refusal): string {
  const why = (() => {
    switch (result.code) {
      case 'exists':
        return '그 자리에 같은 이름이 이미 있습니다 — 덮어쓰지 않습니다'
      case 'invalid_name':
        return '쓸 수 없는 이름입니다'
      case 'protected':
        return 'worktree 루트와 .git 은 조작할 수 없습니다'
      case 'into_self':
        return '폴더를 자기 자신이나 그 안으로 옮길 수 없습니다'
      case 'outside_root':
        return 'worktree 밖입니다'
      case 'not_found':
        return '대상이 없습니다'
      case 'not_file':
        return '일반 파일·폴더·링크가 아닙니다'
      case 'changed':
        return result.done === true ? '조작은 됐지만 그 사이 경로가 바뀌어 결과를 확인하지 못했습니다' : '그 사이 경로가 바뀌어 하지 않았습니다'
      case 'modified':
        return '만든 뒤(또는 되돌린 뒤) 바뀌어 실행 취소하지 않았습니다'
      case 'expired':
        return '되살릴 내용이 더 이상 메모리에 없습니다'
      case 'trash_failed':
        return '휴지통으로 옮기지 못했습니다(영구 삭제하지 않았습니다)'
      case 'permission_denied':
        return '권한이 없습니다'
      case 'bad_token':
        return '가져오기 원본을 확인할 수 없습니다'
      default:
        return result.error
    }
  })()
  // 도중 실패로 남은 중간 폴더(R3-D) — 사용자가 직접 찾아 정리할 수 있게 이름을 적는다.
  const remains = result.remains !== undefined && result.remains.length > 0 ? ` — 남은 폴더: ${result.remains.join(', ')}(직접 정리하세요)` : ''
  return `${why} (${result.code})${remains}`
}

export function useFileOps(deps: FileOpsDeps): FileOpsApi {
  const latest = useRef(deps)
  latest.current = deps
  const histories = useRef(new Map<string, History>())
  /** main 이 붙잡고 있는 가져오기 재생 근거 중 기록이 가리키는 것(R2-E). */
  const heldReplays = useRef(new Set<string>())
  /** 이 hook 의 수명 표지(수정 r4 R4-B) — 가져오기에 싣고, 언마운트 때 닫는다. main 이 진행 중 가져오기의 근거를 붙잡을지 이것으로 판정한다. */
  const hookOwner = useRef(`hook-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const historyOf = (root: string): History => histories.current.get(root) ?? emptyHistory()
  // hook 이 사라지면(언마운트) 기록도 사라진다 — 붙잡던 재생 근거를 main 에서 놓고, 이 hook 의 owner 를 닫는다(수정 r3·r4 — 붙잡은 것이 없어도:
  // 진행 중인 가져오기가 뒤늦게 끝나도 main 이 붙잡지 않게). 렌더러가 새로 뜨는 경우는 main 이 놓는다(`did-navigate`).
  useEffect(() => {
    const self = hookOwner.current
    return () => {
      const held = [...heldReplays.current]
      heldReplays.current = new Set()
      void window.corral.explorerOp({ op: 'release', ids: held, owner: self }).catch(() => undefined)
    }
  }, [])
  /** 기록을 바꾼다 — 어느 기록도 더는 가리키지 않는 재생 근거(상한으로 밀림·다시 실행 칸 비움·재생 실패로 버림)는 main 에서 놓는다(R2-E). */
  const setHistory = (root: string, history: History): void => {
    histories.current.set(root, history)
    const live = new Set([...histories.current.values()].flatMap(replayIdsOf))
    const gone = [...heldReplays.current].filter((id) => !live.has(id))
    heldReplays.current = live
    if (gone.length > 0) void window.corral.explorerOp({ op: 'release', ids: gone }).catch(() => undefined)
  }

  /** 조작을 한 줄로 세운다. */
  const serial = useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(run, run)
    queue.current = next.catch(() => undefined)
    return next
  }, [])

  const call = (input: ExplorerOpInput): Promise<ExplorerOpResult> => window.corral.explorerOp(input)
  /** 그 worktree 가 지금 탐색기에 보이는가 — 트리 반영(펼침·선택·다시 읽기·열기)은 보일 때만. */
  const shown = (root: string): boolean => latest.current.explorer.root === root

  /** 이름 변경·이동이 성공했다 — 같은 틱에 문서·탭·view state·Markdown 모드·닫은 탭 기록·탐색기를 옮긴다(E4ⓐⓑⓓ). 모두 `root`(요청한 worktree) 기준. */
  const retarget = (root: string, from: string, to: string): void => {
    const d = latest.current
    rekeyDocs({ root, from, to })
    const moved = d.layout.retargetFiles({ worktreePath: root, from, to })
    const viewStates = d.viewStatesOf(root)
    // 붙어 있는 편집기는 지금 커서·스크롤을 새 탭 id 로 맡긴다(R1-E — 탭 id 가 바뀌면 편집기를 새로 붙인다).
    moveKeys(viewStates, moved)
    retargetLiveEditors(viewStates, moved)
    moveKeys(d.markdownModesOf(root), moved)
    d.recentlyClosedRef.current = remapClosedFiles({ history: d.recentlyClosedRef.current, worktreePath: root, remap: (rel) => remapRel(rel, from, to) })
    if (shown(root)) d.explorer.remap({ from, to })
  }

  const doMove = async (root: string, from: string, to: string, expect?: string): Promise<ExplorerOpResult> => {
    const d = latest.current
    const layout = d.layout.fileLayoutOf(root)
    const caseOnly = from !== to && from.toLowerCase() === to.toLowerCase()
    if (from !== to && !caseOnly) {
      const taken = (layout === null ? [] : fileTabsUnder({ layout, rel: to })).length > 0 || allDocs().some((doc) => doc.root === root && isAtOrUnder(doc.rel, to))
      if (taken) return refusal('exists', `'${to}' 경로에 열린 탭이 있습니다 — 먼저 닫으세요`)
    }
    const moving = allDocs().filter((doc) => doc.root === root && isAtOrUnder(doc.rel, from))
    if (moving.some((doc) => doc.saving)) return refusal('changed', '저장 중인 파일이 있습니다 — 저장이 끝난 뒤 다시 하세요')
    const release = holdDocs(moving)
    const unhold = d.holdWatch({ root, prefixes: [from, to] })
    try {
      const result = await call({ op: 'move', root, from, to, ...(expect === undefined ? {} : { expect }) })
      if (result.ok && result.op === 'move' && result.from !== result.to) retarget(root, result.from, result.to)
      return result
    } finally {
      release()
      unhold()
    }
  }

  /** 휴지통으로 간 경로 밑의 탭 — 수정 없는 것은 닫고(문서 버림), 수정 중인 것은 남긴다(Q3 — 「삭제됨」 은 감시가 단다). 요청한 worktree 의 배치에서. */
  const closeCleanTabs = (root: string, rel: string): void => {
    const d = latest.current
    const layout = d.layout.fileLayoutOf(root)
    if (layout === null) return
    const closing: string[] = []
    for (const tabId of fileTabsUnder({ layout, rel })) {
      const kind = tabKindOf(tabId)
      if (kind.kind !== 'file') continue
      const doc = getDoc(docKey(root, kind.rel))
      if (doc !== undefined && doc.dirty) continue
      d.viewStatesOf(root).delete(tabId)
      if (doc !== undefined) disposeDoc(doc.key)
      closing.push(tabId)
    }
    d.layout.closeFiles({ worktreePath: root, tabIds: closing })
  }

  /** `snapshot` — 되살릴 사본을 뜰지. 사용자 삭제는 Q1 대로 파일 ≤ 5 MB 만, 되살린 것을 다시 지우는 다시 실행은 늘, 만들기 되돌리기는 재생이라 뜨지 않는다. */
  const doTrash = async (input: { root: string; rel: string; snapshot: boolean; expect?: EntryMark[] }): Promise<ExplorerOpResult> => {
    const { root, rel, expect } = input
    const result = await call({ op: 'trash', root, rel, snapshot: input.snapshot, ...(expect === undefined ? {} : { expect }) })
    if (result.ok) closeCleanTabs(root, rel)
    return result
  }

  const doRestore = async (root: string, rel: string, snapshotId: string): Promise<ExplorerOpResult> => {
    const unhold = latest.current.holdWatch({ root, prefixes: [rel] })
    try {
      const result = await call({ op: 'restore', root, rel, snapshotId })
      if (result.ok && result.op === 'restore' && result.hash !== null && result.stamp !== null) {
        // 남은 수정 중 탭(Q3)이 기대던 내용이 그대로 돌아왔다 — 기준 stamp 만 옮긴다(「삭제됨」·외부 변경 배너 없이 정상으로).
        const doc = getDoc(docKey(root, rel))
        if (doc !== undefined) rebaseDoc(doc, { stamp: result.stamp, hash: result.hash })
      }
      return result
    } finally {
      unhold()
    }
  }

  /** 원래 조작 다시 부르기(다시 실행 재생). 성공하면 트리에 보이게 하고, 부분 실패·덜 든 항목은 일반 조작과 같은 안내(`note` — R2-H). */
  const runReplay = async (root: string, step: ReplayStep): Promise<{ result: ExplorerOpResult; note: string | null }> => {
    switch (step.op) {
      case 'create': {
        const result = await call({ op: 'create', root, dir: step.dir, name: step.name, kind: step.kind, again: step.again, was: step.was })
        if (result.ok && result.op === 'create' && shown(root)) latest.current.explorer.reveal(result.rel)
        return { result, note: null }
      }
      case 'duplicate': {
        const result = await call({ op: 'duplicate', root, rel: step.rel, again: step.again, was: step.was })
        if (!result.ok || result.op !== 'duplicate') return { result, note: null }
        if (shown(root)) latest.current.explorer.reveal(result.rel)
        const note = copyNotes({ made: [result.rel], marks: [result.marks], partial: result.failed.length > 0 ? [result.rel] : [], skipped: result.skipped, failed: result.failed })
        return { result, note: note === null ? null : `'${baseName(step.rel)}' 복제: ${note}` }
      }
      case 'import': {
        const result = await call({ op: 'import', root, dir: step.dir, replay: step.replay, names: step.names, was: step.was })
        if (!result.ok || result.op !== 'import') return { result, note: null }
        const first = result.rels[0]
        if (first !== undefined && shown(root)) latest.current.explorer.reveal(first)
        const note = copyNotes({ made: result.rels, marks: result.marks, partial: result.partial, skipped: result.skipped, failed: result.failed })
        return { result, note: note === null ? null : `가져오기: ${note}` }
      }
    }
  }

  /** 기록된 조작 하나(실행 취소·다시 실행) — 결과들과 그 역조작, 따로 알릴 것(`note`). */
  const runStep = async (root: string, step: HistoryStep): Promise<{ results: ExplorerOpResult[]; inverse: HistoryStep | null; note: string | null }> => {
    switch (step.op) {
      case 'move': {
        const result = await doMove(root, step.from, step.to, step.expect)
        return { results: [result], inverse: inverseOf(result), note: null }
      }
      case 'trash': {
        // 만들기·복제·가져오기 되돌리기(`replay` 있음) — 다시 실행은 재생이라 사본을 뜨지 않는다(R1-G). 되살린 것을 다시 지우는 다시 실행만 사본을 뜬다.
        const result = await doTrash({ root, rel: step.rel, snapshot: step.replay === undefined, expect: step.expect })
        return { results: [result], inverse: result.ok && step.replay !== undefined ? { op: 'replay', replay: step.replay } : inverseOf(result), note: null }
      }
      case 'restore': {
        const result = await doRestore(root, step.rel, step.snapshotId)
        return { results: [result], inverse: inverseOf(result), note: null }
      }
      case 'replay': {
        const { result, note } = await runReplay(root, step.replay)
        return { results: [result], inverse: inverseOf(result), note }
      }
      case 'batch': {
        const done: string[] = []
        const refused: string[] = []
        const results: ExplorerOpResult[] = []
        for (const one of step.steps) {
          const outcome = await runStep(root, one)
          results.push(...outcome.results)
          const name = one.op === 'move' ? baseName(one.from) : one.op === 'trash' || one.op === 'restore' ? baseName(one.rel) : stepLabel(one)
          const failed = outcome.results.find((result): result is Refusal => !result.ok)
          if (failed === undefined) done.push(name)
          else refused.push(`${name}(${stepFailureMessage(one, failed)})`)
        }
        if (refused.length === 0) return { results, inverse: step.replay !== undefined ? { op: 'replay', replay: step.replay } : inverseOfBatch(results), note: null }
        // 일부만 됐다(R2-F) — 치운 것·거절된 것을 나누어 알리고, 가져오기 되돌리기면 치운 것만 다시 실행할 수 있게 재생을 좁힌다.
        const narrowed = step.replay === undefined ? null : narrowReplay(step.replay, done)
        const verb = step.steps.every((one) => one.op === 'trash') ? '치움' : '됨'
        const note = done.length === 0 ? null : `${stepLabel(step)} 중 일부만 했습니다 — ${verb} ${done.length}: ${done.join(', ')} · 거절 ${refused.length}: ${refused.join(', ')}`
        return { results, inverse: narrowed !== null ? { op: 'replay', replay: narrowed } : inverseOfBatch(results), note }
      }
    }
  }

  /** 조작이 건드린 폴더들 — 감시 push 를 기다리지 않고 바로 다시 읽는다(E1ⓔ). */
  const touched = (result: ExplorerOpResult): string[] => {
    if (!result.ok) return []
    switch (result.op) {
      case 'move':
        return [parentRel(result.from), parentRel(result.to)]
      case 'create':
        return [parentRel(result.created), parentRel(result.rel)]
      case 'trash':
      case 'restore':
      case 'duplicate':
        return [parentRel(result.rel)]
      case 'import':
        return [result.dir]
      case 'inspect':
      case 'release':
        return []
    }
  }
  const refresh = (root: string, results: readonly ExplorerOpResult[]): void => {
    if (!shown(root)) return
    const d = latest.current
    const dirs = results.flatMap(touched)
    // 사후 확인이 어긋난 경로 연산(done) — 무엇이 바뀌었는지 모르니 읽어 둔 것을 다시 읽는다.
    if (results.some((result) => !result.ok && result.done === true)) d.explorer.refresh()
    else if (dirs.length > 0) d.explorer.reloadDirs(dirs)
  }

  /** 새 조작 하나를 기록한다(역조작이 없으면 다시 실행 칸만 비운다 — E5ⓓ). */
  const record = (root: string, result: ExplorerOpResult): void => {
    const inverse = inverseOf(result)
    setHistory(root, recordOp(historyOf(root), inverse === null ? null : { label: stepLabel(inverse), step: inverse }))
  }

  /** 복제·가져오기의 부분 실패·건너뜀 안내(E7ⓑⓔ·R1-H) — 무엇이 들어왔고 무엇이 덜 들어왔는지. */
  const copyNotes = (input: { made: string[]; marks: EntryMark[][]; partial: string[]; skipped: { name: string; reason: string }[]; failed: { name: string; error: string }[] }): string | null => {
    // 도장을 못 만든 항목(R2-G — 읽을 수 없는 하위) — 실행 취소가 지우지 않는다는 것을 미리 알린다.
    const unverifiable = input.made.filter((_, index) => (input.marks[index] ?? []).some((mark) => mark.stamp === UNVERIFIABLE))
    // 항목마다 안내 하나(R3-E) — 확인 불가 항목은 「⌘Z 로 지우지 않음」 만, 「휴지통에 보낼 수 있다」 는 그 밖의 덜 든 항목에만.
    const partial = input.partial.filter((rel) => !unverifiable.includes(rel))
    if (partial.length === 0 && input.skipped.length === 0 && input.failed.length === 0 && unverifiable.length === 0 && input.made.length > 0) return null
    return [
      input.made.length > 0 ? `${input.made.length}개 항목을 만들었습니다` : '만든 항목이 없습니다',
      unverifiable.length > 0 ? `바뀌었는지 확인할 수 없는 항목 ${unverifiable.length}: ${unverifiable.slice(0, 3).join(', ')} — 실행 취소(⌘Z)로 지우지 않습니다(직접 정리하세요)` : null,
      partial.length > 0 ? `내용이 덜 든 채 남은 항목 ${partial.length}: ${partial.slice(0, 3).join(', ')} — 실행 취소(⌘Z)로 휴지통에 보낼 수 있습니다` : null,
      input.skipped.length > 0 ? `건너뜀 ${input.skipped.length}: ${input.skipped.slice(0, 3).map((row) => `${row.name}(${row.reason})`).join(', ')}` : null,
      input.failed.length > 0 ? `실패 ${input.failed.length}: ${input.failed.slice(0, 3).map((row) => `${row.name} — ${row.error}`).join(' / ')}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join(' · ')
  }

  const create = useCallback(
    (input: { dir: string; name: string; kind: 'file' | 'dir' }): Promise<string | null> => {
      const root = latest.current.root
      return serial(async () => {
        if (root === null) return '열린 worktree 가 없습니다'
        const result = await call({ op: 'create', root, dir: input.dir, name: input.name, kind: input.kind })
        refresh(root, [result])
        if (!result.ok) {
          if (result.done === true) latest.current.notify(opFailureMessage(result))
          return opFailureMessage(result)
        }
        record(root, result)
        if (result.op === 'create' && shown(root)) {
          latest.current.explorer.reveal(result.rel)
          if (result.kind === 'file') latest.current.openFile({ rel: result.rel, preview: false })
        }
        return null
      })
    },
    [serial],
  )

  const rename = useCallback(
    (input: { rel: string; name: string }): Promise<string | null> => {
      const root = latest.current.root
      return serial(async () => {
        if (root === null) return '열린 worktree 가 없습니다'
        const parent = parentRel(input.rel)
        const to = parent === '' ? input.name : `${parent}/${input.name}`
        if (to === input.rel) return null
        const result = await doMove(root, input.rel, to)
        refresh(root, [result])
        if (!result.ok) {
          if (result.done === true) latest.current.notify(opFailureMessage(result))
          return opFailureMessage(result)
        }
        record(root, result)
        if (shown(root)) latest.current.explorer.select(to)
        return null
      })
    },
    [serial],
  )

  const move = useCallback(
    (input: { from: string; toDir: string }): Promise<void> => {
      const root = latest.current.root
      return serial(async () => {
        if (root === null) return
        const to = input.toDir === '' ? baseName(input.from) : `${input.toDir}/${baseName(input.from)}`
        // 같은 부모 = 무동작(E6ⓑ).
        if (parentRel(input.from) === input.toDir) return
        const result = await doMove(root, input.from, to)
        refresh(root, [result])
        if (!result.ok) {
          latest.current.notify(`'${baseName(input.from)}' 을(를) 옮기지 못했습니다: ${opFailureMessage(result)}`)
          return
        }
        record(root, result)
        if (shown(root)) latest.current.explorer.reveal(to)
      })
    },
    [serial],
  )

  const trash = useCallback(
    (rel: string): Promise<void> => {
      const root = latest.current.root
      return serial(async () => {
        if (root === null) return
        const inspected = await call({ op: 'inspect', root, rel })
        if (!inspected.ok || inspected.op !== 'inspect') {
          if (!inspected.ok) latest.current.notify(`'${baseName(rel)}' 을(를) 삭제할 수 없습니다: ${opFailureMessage(inspected)}`)
          return
        }
        // 확인(Q2) — 폴더면 「안의 내용까지」, 실행 취소 가능 여부(Q1), 수정 중 탭(Q3).
        const dirty = allDocs()
          .filter((doc) => doc.root === root && doc.dirty && isAtOrUnder(doc.rel, rel))
          .map((doc) => doc.rel)
        const choice = await window.corral.fileDialog({ kind: 'trash', file: rel, isDir: inspected.kind === 'dir', undoable: inspected.undoable, dirty })
        if (choice !== 'trash') return
        const result = await doTrash({ root, rel, snapshot: inspected.undoable })
        refresh(root, [result])
        if (!result.ok) {
          latest.current.notify(`'${baseName(rel)}' 을(를) 휴지통으로 옮기지 못했습니다: ${opFailureMessage(result)}`)
          return
        }
        // Q1 — 파일(≤ 5 MB, 사본 있음)만 실행 취소 항목. 폴더·큰 파일·링크는 사본이 없어 다시 실행 칸만 비운다.
        record(root, result)
      })
    },
    [serial],
  )

  const duplicate = useCallback(
    (rel: string): Promise<void> => {
      const root = latest.current.root
      return serial(async () => {
        if (root === null) return
        const result = await call({ op: 'duplicate', root, rel })
        refresh(root, [result])
        if (!result.ok || result.op !== 'duplicate') {
          if (!result.ok) latest.current.notify(`'${baseName(rel)}' 을(를) 복제하지 못했습니다: ${opFailureMessage(result)}`)
          return
        }
        record(root, result)
        if (shown(root)) latest.current.explorer.reveal(result.rel)
        const note = copyNotes({ made: [result.rel], marks: [result.marks], partial: result.failed.length > 0 ? [result.rel] : [], skipped: result.skipped, failed: result.failed })
        if (note !== null) latest.current.notify(`'${baseName(rel)}' 복제: ${note}`)
      })
    },
    [serial],
  )

  const importDrop = useCallback(
    (drop: ExplorerDrop): Promise<void> => {
      // 드롭은 그 트리(그 worktree)에서 왔다 — 화면 worktree 가 이미 바뀌었으면 버린다(요청 시점 판단).
      const owner = latest.current.root === drop.root ? drop.root : null
      return serial(async () => {
        if (drop.token === null) {
          latest.current.notify(`가져오지 못했습니다: ${drop.error}`)
          return
        }
        if (owner === null) return
        const result = await call({ op: 'import', root: owner, dir: drop.dir, token: drop.token, owner: hookOwner.current })
        refresh(owner, [result])
        if (!result.ok || result.op !== 'import') {
          if (!result.ok) latest.current.notify(`가져오지 못했습니다: ${opFailureMessage(result)}`)
          return
        }
        record(owner, result)
        const first = result.rels[0]
        if (first !== undefined && shown(owner)) latest.current.explorer.reveal(first)
        // 건너뛴 것(링크·특수 파일)·실패한 것·덜 든 것은 알린다(E7ⓑⓔ·R1-H) — 무엇이 들어왔는지 사용자가 안다.
        const note = copyNotes({ made: result.rels, marks: result.marks, partial: result.partial, skipped: result.skipped, failed: result.failed })
        if (note !== null) latest.current.notify(`가져오기: ${note}`)
      })
    },
    [serial],
  )

  const replay = useCallback(
    (side: 'undo' | 'redo'): Promise<void> => {
      const root = latest.current.root
      return serial(async () => {
        if (root === null) return
        const entry = peek(historyOf(root), side)
        if (entry === null) return
        const { results, inverse, note } = await runStep(root, entry.step)
        refresh(root, results)
        setHistory(root, settle({ history: historyOf(root), side, inverse: inverse === null ? null : { label: stepLabel(inverse), step: inverse } }))
        const failed = results.find((result): result is Refusal => !result.ok)
        const action = side === 'undo' ? '실행 취소' : '다시 실행'
        if (note !== null) latest.current.notify(failed === undefined ? `${action} — ${note}` : `${action}: ${note}`)
        else if (failed !== undefined) {
          const gone = failed.code === 'bad_token' && entry.step.op === 'replay' ? ' — 다시 가져올 원본 기록이 더 이상 없습니다(앱을 다시 시작했거나 기록에서 빠짐)' : ''
          latest.current.notify(`${action}하지 못했습니다 — ${entry.label}: ${stepFailureMessage(entry.step, failed)}${gone}`)
        }
      })
    },
    [serial],
  )
  const undo = useCallback(() => replay('undo'), [replay])
  const redo = useCallback(() => replay('redo'), [replay])

  return { create, rename, move, trash, duplicate, importDrop, undo, redo }
}
