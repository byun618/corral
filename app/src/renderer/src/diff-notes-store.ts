// diff 줄 메모 보관 (LIFE-832 D3·D7·D8) — worktree 별, **앱 실행 중에만**(메모리). 디스크·ui-prefs·탭 배치에 쓰지 않는다.
//
// · 메모 키 = (worktree, 작업 파일 상대 경로, 줄). base 대비 탭과 작업 트리 탭은 같은 작업 파일 줄이라 메모를 같이 쓴다(L2ⓓ).
// · 줄 번호는 따라가지 않는다(L2ⓑ) — 갱신 뒤에도 그 줄 번호에 남고, 본문에는 메모 단 때 그 줄 내용이 같이 실린다(줄 번호가 낡아도 찾게).
// · 「보냄」 표시는 01-criteria 상태 표 한 규칙으로만 선다: 결과 `delivered` 가 왔을 때 **보낸 판(id·rev)과 지금 메모가 같은** 메모에만.
//   보내는 중에 고친(rev 바뀜)·지운·새로 단 메모는 건드리지 않는다. 메모를 고치면 그 메모의 표시만 지운다. 그 밖의 결과는 표시를 세우지 않는다.
// · worktree 당 보내는 중(대기·보내는 중) 하나 — 그동안 보내기는 막힌다(`busy`). 시작은 동기라 연타해도 한 건만 나간다(L8).
// · 결과는 worktree 상태라 다른 worktree 화면에는 남지 않는다. 그 worktree 로 돌아오면 마지막 결과를 닫을 때(또는 다음 보내기)까지 보인다.
import type { DiffNotesPhase, DiffNotesRefusal, DiffNotesState } from '../../shared/diff-notes.js'

export type DiffNote = { id: number; rel: string; line: number; lineText: string; body: string; against: string; rev: number; sent: boolean }
export type NoteSend = { requestId: string; paneId: string; state: DiffNotesPhase; wait: 'turn' | 'gate' | null; reason: string | null; batch: readonly { id: number; rev: number }[] }

type RootState = { notes: readonly DiffNote[]; send: NoteSend | null }

const EMPTY: readonly DiffNote[] = []
const BUSY: ReadonlySet<DiffNotesPhase> = new Set<DiffNotesPhase>(['queued', 'sending'])

export class DiffNotesStore {
  private readonly roots = new Map<string, RootState>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  private nextId = 1

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion = (): number => this.version

  notesOf(root: string): readonly DiffNote[] {
    return this.roots.get(root)?.notes ?? EMPTY
  }

  sendOf(root: string): NoteSend | null {
    return this.roots.get(root)?.send ?? null
  }

  /** 다음 묶음 — 그 worktree 의 안 보낸 메모 전부. */
  unsent(root: string): DiffNote[] {
    return this.notesOf(root).filter((note) => !note.sent)
  }

  busy(root: string): boolean {
    const send = this.sendOf(root)
    return send !== null && BUSY.has(send.state)
  }

  /** 달기·고치기 — 빈 메모는 저장하지 않는다. 고치면 rev 가 오르고 「보냄」 이 풀리며 줄 내용·기준이 지금 값이 된다. 같은 글이면 그대로. */
  upsert(input: { root: string; rel: string; line: number; lineText: string; body: string; against: string }): 'saved' | 'empty' | 'unchanged' {
    if (input.body.trim() === '') return 'empty'
    const notes = this.notesOf(input.root)
    const existing = notes.find((note) => note.rel === input.rel && note.line === input.line)
    if (existing === undefined) {
      const note: DiffNote = { id: this.nextId++, rel: input.rel, line: input.line, lineText: input.lineText, body: input.body, against: input.against, rev: 1, sent: false }
      this.put(input.root, { notes: [...notes, note] })
      return 'saved'
    }
    if (existing.body === input.body) return 'unchanged'
    // 고치면 그 줄 내용·비교 기준도 지금 값으로(리뷰 r1 A5 — 다시 보낼 때 낡은 줄 내용을 싣지 않는다).
    this.put(input.root, { notes: notes.map((note) => (note === existing ? { ...note, body: input.body, lineText: input.lineText, against: input.against, rev: note.rev + 1, sent: false } : note)) })
    return 'saved'
  }

  remove(input: { root: string; id: number }): void {
    const notes = this.notesOf(input.root)
    if (!notes.some((note) => note.id === input.id)) return
    this.put(input.root, { notes: notes.filter((note) => note.id !== input.id) })
  }

  /** 보낸 메모 일괄 지우기(사용자 몫). */
  clearSent(root: string): void {
    const notes = this.notesOf(root)
    if (!notes.some((note) => note.sent)) return
    this.put(root, { notes: notes.filter((note) => !note.sent) })
  }

  /** 확인 → 접수 직전. 이미 보내는 중이면 false(아무것도 안 바꾼다). */
  begin(input: { root: string; requestId: string; paneId: string; batch: readonly DiffNote[] }): boolean {
    if (this.busy(input.root)) return false
    this.put(input.root, { send: { requestId: input.requestId, paneId: input.paneId, state: 'queued', wait: null, reason: null, batch: input.batch.map((note) => ({ id: note.id, rev: note.rev })) } })
    return true
  }

  /** main 이 접수 전에 거절했다 — 아무것도 쓰지 않았다. */
  refuse(input: { requestId: string; reason: DiffNotesRefusal | 'backend' }): void {
    this.apply({ requestId: input.requestId, state: 'failed', wait: null, reason: input.reason })
  }

  /** 허브 결과 한 건 — 상태 표대로. 끝난 요청에 늦게 온 같은 id 상태는 무시한다. */
  apply(state: DiffNotesState): void {
    for (const [root, entry] of this.roots) {
      const send = entry.send
      if (send === null || send.requestId !== state.requestId) continue
      if (!BUSY.has(send.state)) return
      const next: NoteSend = { ...send, state: state.state, wait: state.wait, reason: state.reason }
      if (state.state !== 'delivered') return this.put(root, { send: next })
      const sentRev = new Map(send.batch.map((item) => [item.id, item.rev]))
      const notes = entry.notes.map((note) => (sentRev.get(note.id) === note.rev && !note.sent ? { ...note, sent: true } : note))
      return this.put(root, { notes, send: next })
    }
  }

  /** 결과 안내 닫기 — 보내는 중이면 닫지 않는다(대기는 취소로). */
  dismiss(root: string): void {
    if (this.sendOf(root) === null || this.busy(root)) return
    this.put(root, { send: null })
  }

  private put(root: string, patch: Partial<RootState>): void {
    const previous = this.roots.get(root) ?? { notes: EMPTY, send: null }
    this.roots.set(root, { ...previous, ...patch })
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

export const diffNotes = new DiffNotesStore()

let subscribed = false

/** main push 구독 — diff 탭이 메모 장치를 처음 그릴 때 한 번(메모를 안 쓰면 구독도 없다). */
export function ensureDiffNotesSubscribed(): void {
  if (subscribed) return
  subscribed = true
  window.corral.onDiffNotesState((state) => diffNotes.apply(state))
}

/** 확인한 본문 그대로 보낸다 — 시작은 동기(`begin`)라 연타는 한 건. */
export async function sendDiffNotes(input: { root: string; paneId: string; text: string; batch: readonly DiffNote[] }): Promise<void> {
  const requestId = crypto.randomUUID()
  if (!diffNotes.begin({ root: input.root, requestId, paneId: input.paneId, batch: input.batch })) return
  const result = await window.corral.diffNotesSend({ requestId, worktree: input.root, paneId: input.paneId, text: input.text }).catch(() => null)
  if (result === null) diffNotes.refuse({ requestId, reason: 'backend' })
  else if (!result.ok) diffNotes.refuse({ requestId, reason: result.reason })
}

export function cancelDiffNotes(root: string): void {
  const send = diffNotes.sendOf(root)
  if (send !== null && send.state === 'queued') window.corral.diffNotesCancel({ requestId: send.requestId })
}
