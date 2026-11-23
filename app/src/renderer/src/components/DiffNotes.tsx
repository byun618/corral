// diff 줄 메모 장치 (LIFE-832) — 오른쪽(작업 파일) 편집기의 거터 + · 줄 아래 메모 카드(view zone) · 머리 「메모 N · 보내기」 · 결과 안내 · 확인 단계.
//
// · 거터: 마우스가 올라간 줄에 + 글리프, 글리프·줄 번호를 누르면 그 줄 메모 편집. 메모가 있는 줄은 말풍선 글리프.
// · 카드: Monaco view zone 의 DOM 에 React portal 로 그린다. zone 은 메모·편집 상태가 바뀔 때 통째로 다시 건다(높이를 다시 재려면 zone 을 다시 걸어야 한다).
//   zone 안 키 입력은 편집기 키 처리로 새지 않게 zone DOM 에서 막는다(React 키 처리는 capture 로 받는다).
// · 갱신(stamp `setValue`)에도 메모는 저장소에 있어 사라지지 않는다 — zone 만 새 줄 수에 맞춰 다시 건다. 줄이 없어지면 마지막 줄 아래에 「지금 파일에 이 줄 없음」.
// · 확인 단계는 연 순간의 묶음·본문을 붙든다 — 보인 본문이 그대로 나간다. 대상 후보는 렌더마다(= 상태 발행마다) 다시 계산한다.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { bodyTooLarge, defaultTarget, DIFF_NOTES_LEAD, formatNotesBody, NO_SESSION_TEXT, noteTargets, reasonText, wellFormed, type NoteTarget } from '../../../shared/diff-notes.js'
import { MAX_INPUT_BYTES } from '../../../shared/input-body.js'
import type { AgentStatus, WorktreeRow } from '../../../shared/types.js'
import { cancelDiffNotes, diffNotes, ensureDiffNotesSubscribed, sendDiffNotes, type DiffNote } from '../diff-notes-store.js'

type MonacoModule = typeof import('../editor/monaco.js')
export type CodeEditor = ReturnType<ReturnType<MonacoModule['createDiffEditor']>['getModifiedEditor']>
export type NoteEditorHost = { editor: CodeEditor; monaco: MonacoModule['monaco'] }

/** 저장소 변화에 다시 그린다 — 메모 장치를 그리는 순간 main push 구독도 건다. */
export function useDiffNotesVersion(): number {
  useEffect(() => ensureDiffNotesSubscribed(), [])
  return useSyncExternalStore(diffNotes.subscribe, diffNotes.getVersion)
}

const EDIT_HEIGHT = 112
const CARD_CHARS = 90
const LINE_PX = 18
/** 편집 칸 첫 포커스를 다시 해 보는 프레임 수 — zone 이 보이는 데 한두 프레임이면 된다. */
const FOCUS_TRIES = 10

/** 카드 둘레 — zone 여백(위아래 4+4) + 카드 안 여백(6+6)·테두리(2) + 머리 줄(20) + 머리·본문 사이(4). E1 캡처에서 이보다 작게 잡아 본문 스크롤이 생겼다. */
const CARD_CHROME = 46
/** 카드 높이 — 줄 수(긴 줄은 접힌다고 어림) × 줄 높이 + 둘레. 너무 길면 카드 안에서 스크롤. */
function cardHeight(body: string): number {
  const lines = body.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / CARD_CHARS)), 0)
  return Math.min(240, CARD_CHROME + lines * LINE_PX)
}

type Editing = { line: number; draft: string }

/** 오른쪽 편집기 위의 메모 — 거터·카드·편집. */
export function NoteLayer({ host, root, rel, against }: { host: NoteEditorHost; root: string; rel: string; against: string }): React.JSX.Element {
  useDiffNotesVersion()
  const { editor, monaco } = host
  const notes = diffNotes.notesOf(root).filter((note) => note.rel === rel)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [lineCount, setLineCount] = useState(() => editor.getModel()?.getLineCount() ?? 1)
  const [hosts, setHosts] = useState<ReadonlyMap<string, HTMLElement>>(new Map())
  /** 모델 내용이 바뀐 차례 — `setValue` 는 모델 데코레이션을 모두 버리므로(Monaco `textModel` 「Destroy all my decorations」) 줄 수가 같아도 표지를 다시 세운다(리뷰 r1 A4). */
  const [contentVersion, setContentVersion] = useState(0)
  /** 저장 안 한 편집이 있는데 다른 줄을 눌렀다 — 편집 칸이 포커스를 받고 안내를 보인다(리뷰 r2 B3). */
  const [nudge, setNudge] = useState(0)
  const notesRef = useRef(notes)
  notesRef.current = notes
  const editingRef = useRef(editing)
  editingRef.current = editing

  // 거터 + · 클릭 · 내용 갱신(줄 수).
  useEffect(() => {
    editor.updateOptions({ glyphMargin: true })
    const hover = editor.createDecorationsCollection()
    const { MouseTargetType } = monaco.editor
    const gutter = (type: number): boolean => type === MouseTargetType.GUTTER_GLYPH_MARGIN || type === MouseTargetType.GUTTER_LINE_NUMBERS
    // 마우스 줄이 바뀔 때만 데코레이션을 다시 건다(리뷰 r1 A10 — 이동마다 세우지 않는다).
    let hovered: number | null = null
    const clearHover = (): void => {
      hovered = null
      hover.clear()
    }
    const move = editor.onMouseMove((event) => {
      const line = event.target.position?.lineNumber
      if (line === undefined) return clearHover()
      if (line === hovered) return
      hovered = line
      hover.set([{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'diff-note-add codicon codicon-add', glyphMarginHoverMessage: { value: '메모 달기' } } }])
    })
    const leave = editor.onMouseLeave(clearHover)
    const down = editor.onMouseDown((event) => {
      const line = event.target.position?.lineNumber
      if (line === undefined || !gutter(event.target.type)) return
      // 저장하지 않은 글이 있는 편집을 다른 줄 누름이 버리지 않는다(리뷰 r1 A7) — 저장·취소한 뒤에 옮긴다.
      const current = editingRef.current
      if (current !== null && current.line !== line && unsavedRef.current(current)) {
        // 버리지 않고, 쓰던 편집 칸으로 돌려보낸다(리뷰 r2 B3) — 포커스 + 잠깐 강조.
        setNudge((value) => value + 1)
        return
      }
      const existing = notesRef.current.find((note) => note.line === line)
      setEditing({ line, draft: existing?.body ?? '' })
    })
    const changed = editor.onDidChangeModelContent(() => {
      // setValue 가 hover 데코레이션도 버렸다 — 같은 줄에 머물러도 다음 이동에서 다시 건다(리뷰 r2 B2).
      hovered = null
      setLineCount(editor.getModel()?.getLineCount() ?? 1)
      setContentVersion((value) => value + 1)
    })
    setLineCount(editor.getModel()?.getLineCount() ?? 1)
    return () => {
      move.dispose()
      leave.dispose()
      down.dispose()
      changed.dispose()
      hover.clear()
    }
  }, [editor, monaco])

  // 메모가 있는 줄 표지.
  const markSignature = notes.map((note) => `${note.line}:${note.sent ? 1 : 0}`).join(',')
  useEffect(() => {
    const marks = editor.createDecorationsCollection()
    marks.set(
      notesRef.current.map((note) => {
        const line = Math.min(note.line, lineCount)
        return { range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: `diff-note-mark codicon codicon-comment${note.sent ? ' is-sent' : ''}` } }
      }),
    )
    return () => marks.clear()
  }, [editor, monaco, markSignature, lineCount, contentVersion])

  // zone — 메모 카드 + (새 줄) 편집. 같은 줄 메모를 고치는 중이면 그 카드 자리가 편집이 된다.
  const zones = [
    ...notes.map((note) => ({ key: `n${note.id}`, line: Math.min(note.line, lineCount), height: editing?.line === note.line ? EDIT_HEIGHT : cardHeight(note.body) })),
    ...(editing !== null && !notes.some((note) => note.line === editing.line) ? [{ key: 'new', line: Math.min(editing.line, lineCount), height: EDIT_HEIGHT }] : []),
  ]
  const zoneSignature = zones.map((zone) => `${zone.key}:${zone.line}:${zone.height}`).join(',')
  useLayoutEffect(() => {
    const ids: string[] = []
    const next = new Map<string, HTMLElement>()
    editor.changeViewZones((accessor) => {
      for (const zone of zones) {
        const dom = document.createElement('div')
        dom.className = 'diff-note-zone'
        // 편집기 키 처리(⌘A·찾기 등)로 새지 않게 — React 키 처리는 capture 로 받는다.
        for (const type of ['keydown', 'keyup', 'keypress']) dom.addEventListener(type, (event) => event.stopPropagation())
        // suppressMouseDown 이면 Monaco 가 zone 안 누름을 preventDefault 하고 편집기 textarea 로 포커스를 가져간다 — 메모 칸 클릭이 먹힌다(N1 1회차).
        ids.push(accessor.addZone({ afterLineNumber: zone.line, heightInPx: zone.height, domNode: dom, suppressMouseDown: false }))
        next.set(zone.key, dom)
      }
    })
    setHosts(next)
    return () => {
      editor.changeViewZones((accessor) => {
        for (const id of ids) accessor.removeZone(id)
      })
    }
    // zoneSignature 가 zones 의 값 정체다.
  }, [editor, zoneSignature])

  /** 편집 중인 글이 저장된 메모(없으면 빈 글)와 다르다. */
  const unsaved = (current: Editing): boolean => {
    const existing = notesRef.current.find((note) => note.line === current.line)
    return current.draft.trim() !== '' && current.draft !== (existing?.body ?? '')
  }
  const unsavedRef = useRef(unsaved)
  unsavedRef.current = unsaved
  const save = (input: { line: number; draft: string }): void => {
    const lineText = editor.getModel()?.getLineContent(Math.min(input.line, lineCount)) ?? ''
    if (diffNotes.upsert({ root, rel, line: input.line, lineText, body: input.draft, against }) !== 'empty') setEditing(null)
  }
  const editorFor = (line: number): React.JSX.Element | null =>
    editing !== null && editing.line === line ? (
      <NoteEditor line={line} draft={editing.draft} nudge={nudge} onDraft={(draft) => setEditing({ line, draft })} onSave={() => save(editing)} onCancel={() => setEditing(null)} />
    ) : null

  const newHost = hosts.get('new')
  return (
    <>
      {notes.map((note) => {
        const dom = hosts.get(`n${note.id}`)
        if (dom === undefined) return null
        return createPortal(editorFor(note.line) ?? <NoteCard note={note} missing={note.line > lineCount} onEdit={() => setEditing({ line: note.line, draft: note.body })} onDelete={() => diffNotes.remove({ root, id: note.id })} />, dom, `n${note.id}`)
      })}
      {editing !== null && newHost !== undefined ? createPortal(editorFor(editing.line), newHost, 'new') : null}
    </>
  )
}

function NoteCard({ note, missing, onEdit, onDelete }: { note: DiffNote; missing: boolean; onEdit: () => void; onDelete: () => void }): React.JSX.Element {
  return (
    <div className="diff-note" data-diff-note={note.line} data-diff-note-sent={note.sent ? '' : undefined}>
      <div className="diff-note-head">
        <span className="diff-note-line">줄 {note.line}</span>
        {note.sent ? <span className="diff-note-sent" data-diff-note-sent-badge="">보냄</span> : null}
        {missing ? <span className="diff-note-missing">지금 파일에 이 줄 없음</span> : null}
        <span className="diff-note-spacer" />
        <button type="button" className="diff-note-btn" data-diff-note-edit="" onClick={onEdit}>고치기</button>
        <button type="button" className="diff-note-btn" data-diff-note-delete="" onClick={onDelete}>지우기</button>
      </div>
      <div className="diff-note-body">{note.body}</div>
    </div>
  )
}

function NoteEditor({ line, draft, nudge, onDraft, onSave, onCancel }: { line: number; draft: string; nudge: number; onDraft: (draft: string) => void; onSave: () => void; onCancel: () => void }): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const [nudged] = useState(nudge)
  // Monaco 는 zone 을 붙일 때 숨기고(display none) 다음 그리기에서 보인다 — 포커스가 붙을 때까지 몇 프레임 다시 한다.
  useEffect(() => {
    let frame = 0
    let tries = 0
    const attempt = (): void => {
      const textarea = ref.current
      if (textarea === null) return
      textarea.focus()
      if (document.activeElement !== textarea && (tries += 1) < FOCUS_TRIES) frame = requestAnimationFrame(attempt)
    }
    attempt()
    return () => cancelAnimationFrame(frame)
  }, [nudge])
  const empty = draft.trim() === ''
  const held = nudge !== nudged
  return (
    <div className={`diff-note is-editing${held ? ' is-held' : ''}`} data-diff-note-editor={line}>
      {held ? (
        <div className="diff-note-held" data-diff-note-held="">
          저장하지 않은 메모가 있습니다 — 저장하거나 취소한 뒤 다른 줄에 다세요
        </div>
      ) : null}
      <textarea
        ref={ref}
        className="diff-note-input"
        value={draft}
        placeholder={`줄 ${line} 메모 — ⌘Enter 저장 · Esc 취소`}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDownCapture={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            if (!empty) onSave()
          }
        }}
      />
      <div className="diff-note-actions">
        <button type="button" className="diff-note-btn" data-diff-note-cancel="" onClick={onCancel}>취소</button>
        <button type="button" className="diff-note-btn is-primary" data-diff-note-save="" disabled={empty} onClick={onSave}>저장</button>
      </div>
    </div>
  )
}

/** 머리 조각 — 안 보낸 메모 수 · 보내기 · 보낸 메모 지우기. */
export function NotesHeadControls({ root, onSend }: { root: string; onSend: () => void }): React.JSX.Element {
  useDiffNotesVersion()
  const notes = diffNotes.notesOf(root)
  const unsent = notes.filter((note) => !note.sent).length
  const sent = notes.length - unsent
  const busy = diffNotes.busy(root)
  return (
    <span className="diff-notes-head" data-diff-notes-head="">
      <span className="diff-notes-count" data-diff-notes-unsent={unsent}>메모 {unsent}</span>
      <button type="button" className="scm-diff-open" data-diff-notes-send="" disabled={unsent === 0 || busy} title={busy ? '보내는 중입니다' : unsent === 0 ? '안 보낸 메모가 없습니다' : '이 worktree 의 안 보낸 메모를 에이전트에게 보내기'} onClick={onSend}>
        보내기
      </button>
      {sent > 0 ? (
        <button type="button" className="scm-diff-open" data-diff-notes-clear-sent="" onClick={() => diffNotes.clearSent(root)}>
          보낸 메모 지우기
        </button>
      ) : null}
    </span>
  )
}

/** 결과 안내 — 그 worktree 의 마지막 보내기. 다른 worktree diff 에는 그리지 않는다(저장소가 worktree 별). */
export function NotesResult({ root }: { root: string }): React.JSX.Element | null {
  useDiffNotesVersion()
  const send = diffNotes.sendOf(root)
  if (send === null) return null
  const text = resultText(send)
  return (
    <div className={`scm-diff-notice diff-notes-result is-${send.state}`} data-diff-notes-result={send.state} data-diff-notes-reason={send.reason ?? undefined}>
      <span className="diff-notes-result-text">{text}</span>
      {send.state === 'queued' ? (
        <button type="button" className="diff-note-btn" data-diff-notes-cancel="" onClick={() => cancelDiffNotes(root)}>취소</button>
      ) : send.state === 'sending' ? null : (
        <button type="button" className="diff-note-btn" data-diff-notes-dismiss="" onClick={() => diffNotes.dismiss(root)}>닫기</button>
      )}
    </div>
  )
}

function resultText(send: { state: string; wait: 'turn' | 'gate' | null; reason: string | null; batch: readonly unknown[] }): string {
  switch (send.state) {
    case 'queued':
      return send.wait === 'turn' ? '대기 — 에이전트가 작업 중입니다. 턴이 끝나면 넣습니다' : '대기 — 곧 넣습니다'
    case 'sending':
      return '보내는 중'
    case 'delivered':
      return `들어감 — 메모 ${send.batch.length}개를 보냈습니다`
    case 'unconfirmed':
      return '확인 못 함 — 그 pane 을 보고 판단하세요. 다시 보내면 중복될 수 있습니다'
    case 'cancelled':
      return '취소됨 — 아무것도 넣지 않았습니다'
    case 'unknown':
      return send.reason === 'renderer_gone' ? '확인 못 함 — 화면이 다시 그려지는 동안 결과를 받지 못했습니다. 그 pane 을 보고 판단하세요' : '확인 못 함 — 앱이 이 요청을 모릅니다. 그 pane 을 보고 판단하세요'
    default:
      return `실패 — ${reasonText(send.reason)}`
  }
}

const STATUS_TEXT: Readonly<Record<AgentStatus, string>> = { idle: '한가', working: '작업 중', blocked: '대기', done: '완료', unknown: '알 수 없음' }

export type ConfirmBatch = { notes: readonly DiffNote[]; body: string }

/** 확인 단계를 열 때 붙드는 묶음·본문 — 그 worktree 의 안 보낸 메모 전부. */
export function confirmBatch(root: string): ConfirmBatch {
  const notes = diffNotes.unsent(root)
  return { notes, body: formatNotesBody({ notes, against: notes.map((note) => note.against) }) }
}

/** 확인 단계 — 대상 pane + 보낼 본문 전체. 확인하면 이 본문 그대로 나간다. */
export function NotesConfirm({ root, worktree, batch, onClose }: { root: string; worktree: WorktreeRow; batch: ConfirmBatch; onClose: () => void }): React.JSX.Element {
  useDiffNotesVersion()
  const targets = noteTargets(worktree)
  const [picked, setPicked] = useState<string | null>(null)
  const chosen = picked ?? defaultTarget(targets)
  const chosenTarget = targets.find((target) => target.paneId === chosen && target.selectable) ?? null
  const tooLarge = bodyTooLarge(batch.body)
  const illFormed = !wellFormed(batch.body)
  const busy = diffNotes.busy(root)
  // Esc 로 닫기(리뷰 r1 A7) — 취소와 같다(쓰기 0).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // 조합 중 Esc 는 입력기 몫(리뷰 r2 B6) — 확인 단계를 닫지 않는다.
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      // 아래(편집기·터미널·다른 단축키)로 전파하지 않는다(B6).
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const selectable = targets.filter((target) => target.selectable)
  // 후보는 있으나 고를 수 있는 것이 없으면 그 사유를 말한다(리뷰 r1 A6) — 「고르세요」 가 아니다.
  const blocked = targets.length === 0 ? '이 worktree 에 에이전트 pane 이 없어 보낼 수 없습니다' : selectable.length === 0 ? `고를 수 있는 pane 이 없습니다 — ${targets[0]?.reason ?? NO_SESSION_TEXT}` : chosen !== null && chosenTarget === null ? '고른 pane 이 없어졌거나 고를 수 없습니다' : chosen === null ? '보낼 pane 을 고르세요' : tooLarge ? `본문이 상한(${MAX_INPUT_BYTES} 바이트)을 넘어 보낼 수 없습니다 — 메모를 줄이세요` : illFormed ? reasonText('ill_formed') : busy ? '보내는 중입니다' : null
  return (
    <div className="diff-notes-confirm-backdrop" data-diff-notes-confirm="" onMouseDown={(event) => event.stopPropagation()}>
      <div className="diff-notes-confirm" role="dialog" aria-label="메모 보내기 확인">
        <div className="diff-notes-confirm-title">메모 {batch.notes.length}개 보내기</div>
        <div className="diff-notes-confirm-label">대상</div>
        {targets.length === 0 ? (
          <div className="diff-notes-confirm-empty" data-diff-notes-no-target="">이 worktree 에 에이전트 pane(claude·codex·grok)이 없습니다.</div>
        ) : (
          <div className="diff-notes-targets">
            {targets.map((target) => (
              <TargetRow key={target.paneId} target={target} checked={chosen === target.paneId} onPick={() => setPicked(target.paneId)} />
            ))}
          </div>
        )}
        <div className="diff-notes-confirm-label">보낼 글 — 리드 한 줄을 친 뒤 본문을 붙여 넣는다</div>
        <div className="diff-notes-lead" data-diff-notes-lead="">{DIFF_NOTES_LEAD}</div>
        <pre className="diff-notes-body" data-diff-notes-body="">{batch.body}</pre>
        {blocked !== null ? <div className="diff-notes-blocked" data-diff-notes-blocked="">{blocked}</div> : null}
        <div className="diff-notes-confirm-actions">
          <button type="button" className="diff-note-btn" data-diff-notes-confirm-cancel="" onClick={onClose}>취소</button>
          <button
            type="button"
            className="diff-note-btn is-primary"
            data-diff-notes-confirm-send=""
            disabled={blocked !== null || chosenTarget === null}
            onClick={() => {
              if (chosenTarget === null) return
              void sendDiffNotes({ root, paneId: chosenTarget.paneId, text: batch.body, batch: batch.notes })
              onClose()
            }}
          >
            보내기
          </button>
        </div>
      </div>
    </div>
  )
}

function TargetRow({ target, checked, onPick }: { target: NoteTarget; checked: boolean; onPick: () => void }): React.JSX.Element {
  return (
    <label className={`diff-notes-target${target.selectable ? '' : ' is-disabled'}`} data-diff-notes-target={target.paneId} data-diff-notes-target-selectable={target.selectable ? '' : undefined}>
      <input type="radio" name="diff-notes-target" checked={checked} disabled={!target.selectable} onChange={onPick} />
      <span className="diff-notes-target-kind">{target.kind}</span>
      <span className="diff-notes-target-name">{target.tabLabel}{target.title.trim() === '' ? '' : ` · ${target.title}`}</span>
      <span className="diff-notes-target-status">{STATUS_TEXT[target.status]}</span>
      {target.reason !== null ? <span className="diff-notes-target-reason">{target.reason}</span> : null}
    </label>
  )
}
