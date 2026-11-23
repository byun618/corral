// 소스 제어 diff 탭 몸통 (LIFE-683 S5·S6) — 양쪽 읽기 전용. 왼쪽이 없으면(인덱스 추가·삭제) 단일 읽기 전용 편집기(VS Code `vscode.open`).
//
// · 읽기: 작업 파일 = 기존 파일 읽기 IPC(`readFile` — 가둠·상한·바이너리), HEAD·인덱스 = `scmRead`(main 이 고정 argv). 렌더러는 ref 를 고르지 않는다.
// · 갱신(S6): 그 루트의 git push 차례(`stamp`)가 바뀌면 양쪽을 다시 읽어, 내용이 달라진 모델만 바꾼다 — view state(스크롤)를 저장했다 되살린다.
//   대상이 변경 목록에서 사라져도 탭은 남고 같은 대상을 다시 읽는다. 양쪽이 같아지면 「변경 없음」 안내 띠.
// · base 대비(LIFE-830): `base` 쪽은 main 이 그 루트에서 푼 merge-base 로 읽고, 읽은 결과에 실린 base(이름·해시)로 머리에 「base <이름>(<해시>)」 를 그린다.
//   추가·추적 안 함은 왼쪽(merge-base 쪽)이 없는 빈 왼쪽 diff 다 — 「base 쪽에 이 파일이 없습니다」 띠를 보인다.
// · Monaco 는 파일 탭과 같은 지연 로딩(`../editor/monaco.js` 동적 import)·같은 편집기 worker. 한쪽이라도 20 MB 를 넘으면 파일 탭과 같은 대용량 처리(fix r1 R1-10).
// · 감시(fix r1 R1-01 · S8 정정 r1): 영역에 보이는 diff 탭(`watch`)은 그 루트 허브 구독을 잡는다 — 패널이 닫혔거나 상세 보기여도 git push(= 갱신 신호)가 온다.
//   참조 셈(`explorer-watch-refs.ts`)이라 탐색기·소스 제어와 같은 루트면 한 벌이고, 탭이 안 보이면(탭 전환·닫음·작업 페이지·설정) 해제한다.
// · 줄 메모(LIFE-832): 오른쪽이 작업 파일인 모드(`notesAllowed`)에서 `notes` 를 받으면 오른쪽 편집기에 메모 장치(`DiffNotes.tsx`)를 얹는다.
//   diff 탭은 여전히 읽기 전용이다 — 메모는 편집기 내용이 아니라 view zone 이다. `notes` 가 없으면(시험·다른 자리) 장치도 구독도 없다.
import { useEffect, useRef, useState } from 'react'
import { diffTitle, sidesOf, type ScmBaseInfo, type ScmDiffTarget, type ScmSide } from '../../../shared/scm.js'
import { notesAllowed } from '../../../shared/diff-notes.js'
import type { WorktreeRow } from '../../../shared/types.js'
import { confirmBatch, NoteLayer, NotesConfirm, NotesHeadControls, NotesResult, type ConfirmBatch, type NoteEditorHost } from './DiffNotes.js'
import { LARGE_FILE_BYTES } from '../../../shared/file-view.js'
import { acquireExplorerWatch } from '../explorer-watch-refs.js'
import { Codicon } from './ExplorerIcons.js'
import './scm.css'

type MonacoModule = typeof import('../editor/monaco.js')
type Model = ReturnType<MonacoModule['createModel']>

/** `base` — side `base` 로 읽었을 때 main 이 쓴 base(머리 표지용, LIFE-830). */
export type SideContent = ({ kind: 'text'; text: string; size: number } | { kind: 'missing' } | { kind: 'binary' } | { kind: 'too_large' } | { kind: 'error'; message: string }) & { base?: ScmBaseInfo }

const SIDE_LABEL: Readonly<Record<ScmSide, string>> = { head: 'HEAD', index: '인덱스', working: '작업 트리', base: 'base' }

/** 머리 표지의 한 쪽 — base 쪽은 읽은 base 가 있으면 「base <이름>(<짧은 해시>)」. */
export function sideLabel({ side, content }: { side: ScmSide; content: SideContent | null }): string {
  if (side !== 'base' || content?.base === undefined) return SIDE_LABEL[side]
  return `base ${content.base.name}(${content.base.mergeBase.slice(0, 7)})`
}

/** 한 쪽 읽기 — 작업 파일은 `readFile`, 나머지는 `scmRead`. */
export async function readSide(input: { root: string; side: ScmSide; rel: string }): Promise<SideContent> {
  if (input.side === 'working') {
    const result = await window.corral.readFile({ root: input.root, rel: input.rel })
    if (!result.ok) return result.code === 'not_found' ? { kind: 'missing' } : { kind: 'error', message: result.error }
    return result.kind === 'text' ? { kind: 'text', text: result.text, size: result.size } : { kind: result.kind }
  }
  const result = await window.corral.scmRead({ root: input.root, rel: input.rel, side: input.side })
  if (!result.ok) return { kind: 'error', message: result.error }
  const base = result.base === undefined ? {} : { base: result.base }
  return result.kind === 'text' ? { kind: 'text', text: result.text, size: result.size, ...base } : { kind: result.kind, ...base }
}

/** 편집기 대신 보일 안내 — 둘 중 하나라도 글이 아니면(없음은 빈 글로 본다). 없으면 null. */
export function blockingNotice(sides: readonly SideContent[]): string | null {
  for (const side of sides) {
    if (side.kind === 'binary') return '바이너리 파일이라 내용을 표시하지 않습니다.'
    if (side.kind === 'too_large') return '파일이 너무 커서(50 MB 초과) 내용을 표시하지 않습니다.'
    if (side.kind === 'error') return `읽지 못했습니다 — ${side.message}`
  }
  return null
}

const textOf = (side: SideContent): string => (side.kind === 'text' ? side.text : '')

export function DiffView({
  root,
  target,
  stamp,
  watch,
  onOpenFile,
  groupId,
  onActivate,
  notes,
}: {
  root: string
  target: ScmDiffTarget | null
  stamp: number
  watch: boolean
  onOpenFile: (rel: string) => void
  /** 이 diff 가 선 영역 — 본문 드롭 대상 표지(`data-diff-group`, LIFE-823 B5 — 탭 끌기 `DROP_BODY_SELECTOR`). */
  groupId?: string
  /** 본문을 누르면 이 영역을 활성으로 (LIFE-824 C8 — base 누락). */
  onActivate?: () => void
  /** 줄 메모(LIFE-832) — 이 diff 의 worktree 행(대상 후보·보관 키). 없으면 메모 장치를 그리지 않는다. */
  notes?: { worktree: WorktreeRow }
}): React.JSX.Element {
  useEffect(() => {
    if (!watch) return
    return acquireExplorerWatch(root)
  }, [watch, root])
  // 읽은 내용은 그 대상(`key`)과 같이 든다 — 대상이 바뀐 직후 옛 대상 내용으로 편집기 모양(diff/단일)을 정하지 않게(fix r1 R1-07 시험이 잡음).
  const [loaded, setLoaded] = useState<{ key: string; left: SideContent | null; right: SideContent } | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  /** 편집기가 붙은 차례 — 붙은 뒤 마지막 내용을 한 번 싣는다. */
  const [ready, setReady] = useState(0)
  const targetKey = target === null ? null : JSON.stringify(target)
  const contents = loaded !== null && loaded.key === targetKey ? loaded : null

  useEffect(() => {
    if (target === null || targetKey === null) return
    let cancelled = false
    const sides = sidesOf(target)
    void Promise.all([sides.left === null ? Promise.resolve(null) : readSide({ root, ...sides.left }), readSide({ root, ...sides.right })]).then(([left, right]) => {
      if (cancelled) return
      const next = { key: targetKey, left, right }
      setLoaded((previous) => (previous !== null && JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
    })
    return () => {
      cancelled = true
    }
    // targetKey 가 target 의 값 정체다 — target 객체는 렌더마다 새로 파싱된다.
  }, [root, targetKey, stamp])

  const single = contents !== null && contents.left === null
  const notice = contents === null ? null : blockingNotice(contents.left === null ? [contents.right] : [contents.left, contents.right])
  const editable = contents !== null && notice === null
  const large = contents !== null && [contents.left, contents.right].some((side) => side !== null && side.kind === 'text' && side.size > LARGE_FILE_BYTES)
  const editorRef = useRef<{ kind: 'diff' | 'single'; dispose: () => void; update: (input: { left: string; right: string }) => void } | null>(null)
  const notesOn = notes !== undefined && target !== null && notesAllowed(target.mode)
  /** 메모를 얹을 오른쪽 편집기 — diff 편집기가 붙고 메모 모드일 때만. */
  const [noteHost, setNoteHost] = useState<NoteEditorHost | null>(null)
  const [confirm, setConfirm] = useState<ConfirmBatch | null>(null)

  // 편집기 만들기 — 대상·모양(diff/단일)이 바뀔 때만. 내용 갱신은 아래 효과.
  useEffect(() => {
    const host = hostRef.current
    if (host === null || !editable || target === null) return
    let disposed = false
    const rel = target.rel
    void import('../editor/monaco.js').then(async (module) => {
      const language = large ? 'plaintext' : await module.languageFor(rel)
      if (disposed) return
      const model = (text: string, side: string): Model => module.createModel({ text, language, key: `diff:${side}\0${rel}` })
      const setText = (target: Model, text: string): void => {
        if (target.getValue() !== text) target.setValue(text)
      }
      if (single) {
        const editor = module.createEditor({ host, large, readOnly: true })
        const right = model('', 'right')
        editor.setModel(right)
        editorRef.current = {
          kind: 'single',
          update: ({ right: text }) => {
            const view = editor.saveViewState()
            setText(right, text)
            if (view !== null) editor.restoreViewState(view)
          },
          dispose: () => {
            editor.dispose()
            right.dispose()
          },
        }
      } else {
        const editor = module.createDiffEditor({ host, large })
        const original = model('', 'left')
        const modified = model('', 'right')
        editor.setModel({ original, modified })
        if (notesOn) setNoteHost({ editor: editor.getModifiedEditor(), monaco: module.monaco })
        editorRef.current = {
          kind: 'diff',
          update: ({ left, right }) => {
            const view = editor.saveViewState()
            setText(original, left)
            setText(modified, right)
            if (view !== null) editor.restoreViewState(view)
          },
          dispose: () => {
            editor.dispose()
            original.dispose()
            modified.dispose()
          },
        }
      }
      host.dataset.editorReady = single ? 'single' : 'diff'
      setReady((value) => value + 1)
    })
    return () => {
      disposed = true
      setNoteHost(null)
      editorRef.current?.dispose()
      editorRef.current = null
      delete host.dataset.editorReady
    }
  }, [targetKey, single, editable, large, notesOn])

  useEffect(() => {
    if (contents === null || editorRef.current === null) return
    editorRef.current.update({ left: contents.left === null ? '' : textOf(contents.left), right: textOf(contents.right) })
  }, [contents, ready])

  // LIFE-824 — tabIndex -1: 키보드로 이 diff 탭에 오면(⌘⌥방향·⌃`·이전/다음 탭·탭 클릭) 포커스가 머물 자리. Tab 순회에는 들지 않는다.
  if (target === null) return <div className="scm-diff-message" data-diff-group={groupId} tabIndex={-1} onMouseDown={onActivate}>이 diff 탭의 대상을 읽지 못했습니다(손상된 탭).</div>
  const sides = sidesOf(target)
  // base 대비 추가·추적 안 함 — 왼쪽(merge-base 쪽)에 없다. 빈 왼쪽과 「같음」 으로 보지 않는다.
  const leftMissing = contents !== null && sides.left?.side === 'base' && contents.left?.kind === 'missing'
  const unchanged = contents !== null && notice === null && contents.left !== null && !leftMissing && textOf(contents.left) === textOf(contents.right)
  const missing = contents !== null && contents.right.kind === 'missing'
  const leftLabel = sides.left === null ? '' : sideLabel({ side: sides.left.side, content: contents?.left ?? null })
  const rightLabel = sideLabel({ side: sides.right.side, content: contents?.right ?? null })
  return (
    <div className="scm-diff" data-scm-diff={target.mode} data-scm-diff-rel={target.rel} data-diff-group={groupId} tabIndex={-1} onMouseDown={onActivate}>
      <div className="scm-diff-head">
        <span className="scm-diff-sides" title={diffTitle(target)}>
          {sides.left === null ? `${rightLabel} · ${target.rel}` : `${leftLabel}${sides.left.rel === sides.right.rel ? '' : ` ${sides.left.rel}`} ↔ ${rightLabel} · ${target.rel}`} · 읽기 전용
        </span>
        {target.mode === 'deleted' || target.mode === 'baseDeleted' ? null : (
          <button type="button" className="scm-diff-open" data-scm-diff-open="" title="파일 열기" onClick={() => onOpenFile(target.rel)}>
            <Codicon name="go-to-file" />
            파일 열기
          </button>
        )}
        {notesOn && notes !== undefined ? <NotesHeadControls root={root} onSend={() => setConfirm(confirmBatch(root))} /> : null}
      </div>
      {notesOn ? <NotesResult root={root} /> : null}
      {unchanged ? (
        <div className="scm-diff-notice" data-scm-diff-unchanged="">
          변경 없음 — 양쪽 내용이 같습니다.
        </div>
      ) : null}
      {leftMissing && notice === null ? (
        <div className="scm-diff-notice" data-scm-diff-left-missing="">
          base 쪽에 이 파일이 없습니다(추가됨).
        </div>
      ) : null}
      {missing && notice === null ? (
        <div className="scm-diff-notice" data-scm-diff-missing="">
          {rightLabel} 쪽에 이 파일이 없습니다.
        </div>
      ) : null}
      {notice !== null ? (
        <div className="scm-diff-message" data-scm-diff-blocked="">
          {notice}
        </div>
      ) : (
        <div className="scm-diff-host" ref={hostRef} data-scm-diff-host="" />
      )}
      {notesOn && noteHost !== null && notice === null ? <NoteLayer host={noteHost} root={root} rel={target.rel} against={leftLabel} /> : null}
      {notesOn && notes !== undefined && confirm !== null ? <NotesConfirm root={root} worktree={notes.worktree} batch={confirm} onClose={() => setConfirm(null)} /> : null}
    </div>
  )
}
