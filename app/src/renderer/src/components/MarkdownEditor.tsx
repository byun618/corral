// 본문 markdown 편집기 (LIFE-602 C5) — textarea + 도구 10 + 작성/미리보기.
//
// - 도구·단축키(⌘B·⌘⇧I·⌘E·⌘K)·목록 이어 쓰기는 바꿀 구간을 골라 `execCommand('insertText')` 로 넣는다 — 브라우저 undo 기록에 남아
//   ⌘Z 로 되돌아간다(G5, 값을 직접 대입하면 undo 스택이 끊긴다). 그 명령이 없는 환경(테스트 DOM)만 값 대입으로 대신한다.
// - 한국어 IME: 조합 중(isComposing · keyCode 229 · compositionstart~end)의 Enter·⌘↵·Esc 는 아무것도 하지 않는다. 조합을 끝내는 Enter 가
//   compositionend **뒤에** 오는 브라우저(Safari)가 있어, compositionend 직후 같은 틱의 Enter 도 한 번 건너뛴다(G6).
// - Esc = 버림(요청 0) · ⌘↵·저장 = 편집기 내용 **그대로**를 보낸다(다듬지 않는다). 저장이 실패하면 내용은 남는다(부르는 쪽이 닫지 않는다).
import { useLayoutEffect, useRef, useState } from 'react'
import { MD_TOOLS, MD_TOOL_LABEL, applyEdit, applyTool, continueList, type MdTool, type TextEdit } from '../markdown.js'
import { imeComposing } from '../tasks-model.js'
import { MarkdownView } from './MarkdownView.js'

const TOOL_GLYPH: Record<MdTool, string> = { heading: 'H', bold: 'B', italic: 'I', code: '<>', link: '🔗', bullet: '•', number: '1.', check: '☑', quote: '❝', codeblock: '{ }' }
const TOOL_KEY: Partial<Record<MdTool, string>> = { bold: '⌘B', italic: '⌘⇧I', code: '⌘E', link: '⌘K' }

export function MarkdownEditor({ initial, keyPattern, saving, error, onSave, onCancel, draftRef, label = '본문' }: {
  initial: string
  keyPattern: string | null
  saving: boolean
  error: string | null
  onSave: (text: string) => void
  onCancel: () => void
  /** 지금 초안 — 부르는 쪽이 「보낸 값 vs 지금 값」 을 비교한다(LIFE-602 수정 2 R2-B: 저장 중 더 고친 초안을 성공이 지우지 않게). */
  draftRef?: React.MutableRefObject<string>
  label?: string
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  if (draftRef !== undefined) draftRef.current = value
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const composing = useRef(false)
  const justEnded = useRef(false)
  const pendingSelection = useRef<{ from: number; to: number } | null>(null)

  useLayoutEffect(() => {
    const selection = pendingSelection.current
    const element = ref.current
    if (selection === null || element === null) return
    pendingSelection.current = null
    element.setSelectionRange(selection.from, selection.to)
  })
  useLayoutEffect(() => {
    ref.current?.focus()
  }, [])

  /** 편집 하나를 「입력」 으로 넣는다 — undo 기록에 남는다. */
  const run = (edit: TextEdit): void => {
    const element = ref.current
    if (element === null) return
    element.focus()
    element.setSelectionRange(edit.from, edit.to)
    const exec = Reflect.get(document, 'execCommand')
    const inserted = typeof exec === 'function' && (edit.text.length === 0 ? document.execCommand('delete') : document.execCommand('insertText', false, edit.text))
    if (inserted) {
      setValue(element.value)
      element.setSelectionRange(edit.selectFrom, edit.selectTo)
      return
    }
    setValue((current) => applyEdit({ value: current, edit }))
    pendingSelection.current = { from: edit.selectFrom, to: edit.selectTo }
  }
  const tool = (name: MdTool): void => {
    const element = ref.current
    if (element === null) return
    run(applyTool({ value: element.value, start: element.selectionStart, end: element.selectionEnd, tool: name }))
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const native = event.nativeEvent
    if (composing.current || imeComposing(native)) return
    const mod = event.metaKey || event.ctrlKey
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key === 'Enter' && justEnded.current) {
      // 조합을 끝낸 Enter(compositionend 뒤에 온 것) — 한 번 더 처리하지 않는다.
      justEnded.current = false
      event.preventDefault()
      return
    }
    if (event.key === 'Enter' && mod) {
      event.preventDefault()
      if (!saving) onSave(event.currentTarget.value)
      return
    }
    if (mod) {
      const lower = event.key.toLowerCase()
      const shortcut: MdTool | null = lower === 'b' && !event.shiftKey ? 'bold' : lower === 'i' && event.shiftKey ? 'italic' : lower === 'e' && !event.shiftKey ? 'code' : lower === 'k' && !event.shiftKey ? 'link' : null
      if (shortcut !== null) {
        event.preventDefault()
        tool(shortcut)
      }
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      const element = event.currentTarget
      const edit = continueList({ value: element.value, start: element.selectionStart, end: element.selectionEnd })
      if (edit !== null) {
        event.preventDefault()
        run(edit)
      }
    }
  }

  return (
    <div className="md-editor" data-md-editor="">
      <div className="md-editor-bar">
        <div className="md-editor-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'write'} className={tab === 'write' ? 'is-on' : ''} onClick={() => setTab('write')}>작성</button>
          <button type="button" role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'is-on' : ''} onClick={() => setTab('preview')}>미리보기</button>
        </div>
        <div className="md-editor-tools">
          {MD_TOOLS.map((name) => (
            <button
              key={name}
              type="button"
              className="md-tool"
              data-md-tool={name}
              title={TOOL_KEY[name] === undefined ? MD_TOOL_LABEL[name] : `${MD_TOOL_LABEL[name]} (${TOOL_KEY[name]})`}
              aria-label={MD_TOOL_LABEL[name]}
              disabled={tab !== 'write'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => tool(name)}
            >
              {TOOL_GLYPH[name]}
            </button>
          ))}
        </div>
      </div>
      {tab === 'write' ? (
        <textarea
          ref={ref}
          data-editor-keys=""
          className="md-editor-input"
          aria-label={`${label} 편집`}
          value={value}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => {
            composing.current = false
            justEnded.current = true
            setTimeout(() => { justEnded.current = false }, 0)
          }}
        />
      ) : (
        <div className="md-editor-preview">
          {value.trim().length === 0 ? <div className="md-empty">비어 있음</div> : <MarkdownView source={value} keyPattern={keyPattern} onOpenKey={() => {}} />}
        </div>
      )}
      <div className="md-editor-foot">
        <span className="md-editor-hint">{error ?? '⌘B 굵게 · ⌘⇧I 기울임 · ⌘E 코드 · ⌘K 링크'}</span>
        <span className="md-editor-spacer" />
        <button type="button" className="md-editor-cancel" onClick={onCancel}>취소 Esc</button>
        <button type="button" className="md-editor-save" data-md-save="" disabled={saving} onClick={() => onSave(value)}>{saving ? '저장 중…' : '저장 ⌘↵'}</button>
      </div>
    </div>
  )
}
