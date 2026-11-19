// 터미널 검색 막대 (LIFE-812) — pane 오른쪽 위에 뜨는 관례 위젯(입력칸 · k/총 · 이전/다음 · 닫기).
// 키는 전부 이 입력칸이 받고 PTY 로 내려보내지 않는다(C6ⓐ) — 막대는 xterm(`[data-term-pane]`) 밖이라 터미널 입력 경로를 타지 않는다.
import { useEffect, useRef } from 'react'
import { isCaseSensitive } from '../../../shared/terminal-search.js'
import { searchStatusText, type TerminalSearchState } from '../terminal-search-controller.js'
import { Codicon } from './ExplorerIcons.js'

export function TerminalSearchBar({
  state,
  selectToken,
  onQuery,
  onStep,
  onClose,
}: {
  state: TerminalSearchState
  /** 값이 바뀔 때마다 입력칸에 포커스를 주고 전체 선택한다 — 열 때·열린 막대에서 다시 ⌘F(C4ⓐⓔ). */
  selectToken: number
  onQuery: (query: string) => void
  onStep: (direction: 'forward' | 'backward') => void
  onClose: () => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [selectToken])
  const status = searchStatusText(state)
  const caseNote = isCaseSensitive(state.query) ? '대소문자 구분 (대문자가 있음)' : '대소문자 무시 (대문자를 넣으면 구분)'
  return (
    <div
      className="term-search"
      data-term-search=""
      role="search"
      // fix2 R2-2 — 단추를 눌러도 포커스는 입력칸에 남긴다(Chromium 은 누른 단추에 포커스를 준다 — 그러면 Esc·⇧Enter 가 입력칸 처리를 못 탄다). 클릭은 그대로 간다.
      // fix3 R3-1 — 상태 문구·여백도 같다(포커스 못 받는 요소라 기본 동작이 포커스를 body 로 뺀다). 입력칸 안만 기본 동작(캐럿·선택)을 쓴다.
      onMouseDown={(event) => {
        if (event.target instanceof Element && event.target.closest('[data-term-search-input]') === null) event.preventDefault()
      }}
    >
      <input
        ref={inputRef}
        className="term-search-input"
        data-term-search-input=""
        placeholder="터미널에서 찾기"
        aria-label="터미널에서 찾기"
        title={caseNote}
        value={state.query}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          // 앱 단축키·터미널로 올라가지 않는다 — 이 칸의 키는 이 칸의 것이다.
          event.stopPropagation()
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter') {
            event.preventDefault()
            onStep(event.shiftKey ? 'backward' : 'forward')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey && (event.code === 'KeyF' || event.key.toLowerCase() === 'f')) {
            event.preventDefault()
            event.currentTarget.select()
          }
        }}
      />
      <span className="term-search-status" data-term-search-status="" aria-live="polite" title={caseNote}>
        {status}
      </span>
      <button type="button" className="explorer-tool" data-term-search-prev="" title="이전 (⇧Enter)" aria-label="이전 일치" disabled={state.query === '' || state.tooLong} onClick={() => onStep('backward')}>
        <Codicon name="arrow-up" />
      </button>
      <button type="button" className="explorer-tool" data-term-search-next="" title="다음 (Enter)" aria-label="다음 일치" disabled={state.query === '' || state.tooLong} onClick={() => onStep('forward')}>
        <Codicon name="arrow-down" />
      </button>
      <button type="button" className="explorer-tool" data-term-search-close="" title="닫기 (Esc)" aria-label="검색 닫기" onClick={onClose}>
        <Codicon name="close" />
      </button>
    </div>
  )
}
