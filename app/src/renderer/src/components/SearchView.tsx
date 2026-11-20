// 검색 보기 (LIFE-803 C4) — 오른쪽 패널 몸통. 활성 worktree 에서 내용을 찾아 파일별로 묶어 보이고, 행을 누르면 그 줄로 연다(C5).
//
// · 입력칸 + 토글 3개(대소문자·단어·정규식 — `aria-pressed`). 입력 중엔 지연 검색, Enter 는 바로(IME 조합 중 Enter 는 검색하지 않는다).
// · 결과 = 파일 머리(이름·디렉터리·일치 수 — 접기/펴기) + 일치 줄 행(줄 번호·미리보기·일치 강조). 줄 번호·일치 수는 줄지 않는 칸(긴 경로에서도 보인다).
// · 상태(세션 — `content-search-session.ts`)는 App 이 든다 — 패널을 숨겨도 질의·결과가 그대로.
import { useEffect, useRef } from 'react'
import type { ContentSearchFile, ContentSearchLine, ContentSearchOptions } from '../../../shared/content-search.js'
import type { SearchState } from '../content-search-session.js'
import type { ContentSearchApi } from '../hooks/useContentSearch.js'
import { Codicon, FileIcon } from './ExplorerIcons.js'
import './search.css'

export type SearchOpenInput = { rel: string; line: number; column: number; preview: boolean }

const TOGGLES: readonly { name: keyof ContentSearchOptions; label: string; icon: 'case-sensitive' | 'whole-word' | 'regex' }[] = [
  { name: 'caseSensitive', label: '대소문자 구분', icon: 'case-sensitive' },
  { name: 'wholeWord', label: '단어 단위로', icon: 'whole-word' },
  { name: 'regex', label: '정규식 사용', icon: 'regex' },
]

/** 결과 목록 대신 보일 글 — 목록을 그릴 상태면 null. 순수 함수(시험 대상). */
export function searchNotice(state: Pick<SearchState, 'root' | 'query' | 'status' | 'files' | 'error'>): string | null {
  if (state.root === null) return '열린 worktree 가 없습니다.'
  if (state.query === '') return null
  if (state.status === 'error') return `검색할 수 없습니다 — ${state.error ?? ''}`
  if (state.files.length > 0) return null
  if (state.status === 'searching') return '검색 중…'
  if (state.status === 'done') return '결과가 없습니다.'
  return null
}

/** 요약 — 「N개 파일에서 M개 결과」(일치 수가 부분값이면 「M개 이상」 — r1 R1-10). 결과가 없으면 null. */
export function searchSummary(state: Pick<SearchState, 'files' | 'matchCount' | 'matchCountExact'>): string | null {
  return state.files.length === 0 ? null : `${state.files.length}개 파일에서 ${state.matchCount}개${state.matchCountExact ? '' : ' 이상'} 결과`
}

export type PreviewSegment = { text: string; hit: boolean }

/** 미리보기 → 조각(강조 여부). 앞 공백은 첫 일치 앞까지만 걷는다. 앞이 잘린 줄은 「…」 로 시작하고 뒤가 잘린 줄은 「…」 로 끝난다. */
export function previewSegments(line: Pick<ContentSearchLine, 'preview' | 'ranges' | 'clippedStart' | 'clippedEnd'>): PreviewSegment[] {
  const firstHit = line.ranges.reduce((least, range) => Math.min(least, range.start), line.preview.length)
  let skip = 0
  while (skip < firstHit && (line.preview[skip] === ' ' || line.preview[skip] === '\t')) skip += 1
  const segments: PreviewSegment[] = line.clippedStart ? [{ text: '…', hit: false }] : []
  let at = skip
  for (const range of [...line.ranges].sort((a, b) => a.start - b.start)) {
    const start = Math.max(range.start, at)
    if (range.end <= start) continue
    if (start > at) segments.push({ text: line.preview.slice(at, start), hit: false })
    segments.push({ text: line.preview.slice(start, range.end), hit: true })
    at = range.end
  }
  if (at < line.preview.length) segments.push({ text: line.preview.slice(at), hit: false })
  if (line.clippedEnd) segments.push({ text: '…', hit: false })
  return segments
}

export function SearchView({ api, title, focusToken, onOpen }: { api: ContentSearchApi; title: string | null; focusToken: number; onOpen: (input: SearchOpenInput) => void }): React.JSX.Element {
  const { session, state } = api
  const inputRef = useRef<HTMLInputElement | null>(null)
  // ⌘⇧F — 입력칸 포커스·기존 글 전체 선택(C7ⓐ).
  useEffect(() => {
    if (focusToken === 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusToken])
  const notice = searchNotice(state)
  const summary = searchSummary(state)
  return (
    <div className="search-view" data-search-view="" data-search-status={state.status}>
      <div className="explorer-section-head" data-search-head="">
        <span className="explorer-section-twistie" />
        <span className="explorer-section-title" title={title ?? undefined} data-search-title="">
          {title ?? '검색'}
        </span>
      </div>
      <div className="search-form">
        <div className="search-box">
          <input
            ref={inputRef}
            className="search-input"
            data-search-input=""
            type="text"
            spellCheck={false}
            placeholder="검색"
            aria-label="검색"
            value={state.query}
            disabled={state.root === null}
            onChange={(event) => session.setQuery(event.target.value)}
            onKeyDown={(event) => {
              // IME 조합 중 Enter(조합 확정)는 검색이 아니다(C4ⓕ).
              if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
              event.preventDefault()
              session.submit()
            }}
          />
          <div className="search-toggles">
            {TOGGLES.map((toggle) => (
              <button
                key={toggle.name}
                type="button"
                className="search-toggle"
                data-search-toggle={toggle.name}
                title={toggle.label}
                aria-label={toggle.label}
                aria-pressed={state.options[toggle.name]}
                onClick={() => session.setOption(toggle.name, !state.options[toggle.name])}
              >
                <Codicon name={toggle.icon} />
              </button>
            ))}
          </div>
        </div>
      </div>
      {state.status === 'searching' ? <div className="search-progress" data-search-progress="" role="progressbar" aria-label="검색 중" /> : null}
      {summary === null ? null : (
        <div className="search-summary" data-search-summary="">
          <span>{summary}</span>
          {state.truncated ? (
            <span className="search-truncated" data-search-truncated="">
              결과가 많아 일부만 보입니다
            </span>
          ) : null}
        </div>
      )}
      <div className="explorer-scroll search-scroll">
        {notice !== null ? (
          <div className="explorer-empty" data-search-empty={state.status}>
            {notice}
          </div>
        ) : (
          <div className="search-results" data-search-results="">
            {state.files.map((file) => (
              <FileGroup key={file.rel} file={file} collapsed={state.collapsed.has(file.rel)} onToggle={() => session.toggleCollapsed(file.rel)} onOpen={onOpen} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FileGroup({ file, collapsed, onToggle, onOpen }: { file: ContentSearchFile; collapsed: boolean; onToggle: () => void; onOpen: (input: SearchOpenInput) => void }): React.JSX.Element {
  const slash = file.rel.lastIndexOf('/')
  const name = file.rel.slice(slash + 1)
  const dir = slash === -1 ? '' : file.rel.slice(0, slash)
  const count = file.lines.reduce((sum, line) => sum + line.matches, 0)
  const exact = file.lines.every((line) => line.matchesExact)
  return (
    <div className="search-file" data-search-file={file.rel}>
      <button type="button" className="search-file-head" aria-expanded={!collapsed} title={file.rel} onClick={onToggle}>
        <span className={`explorer-twistie is-collapsible${collapsed ? ' is-collapsed' : ''}`}>
          <Codicon name="chevron-down" />
        </span>
        <FileIcon name={name} />
        <span className="search-file-label">
          <span className="search-file-name">{name}</span>
          <span className="search-file-dir">{dir}</span>
        </span>
        <span className="search-file-count" data-search-file-count={count} data-search-file-count-exact={exact ? 'true' : 'false'}>
          {exact ? count : `${count}+`}
        </span>
      </button>
      {collapsed
        ? null
        : file.lines.map((line) => (
            <button
              key={line.line}
              type="button"
              className="search-line"
              data-search-line={`${file.rel}:${line.line}`}
              title={`${file.rel}:${line.line}:${line.column}`}
              onClick={() => onOpen({ rel: file.rel, line: line.line, column: line.column, preview: true })}
              onDoubleClick={() => onOpen({ rel: file.rel, line: line.line, column: line.column, preview: false })}
            >
              <span className="search-line-text">
                {previewSegments(line).map((segment, index) =>
                  segment.hit ? (
                    <mark key={index} className="search-hit" data-search-hit="">
                      {segment.text}
                    </mark>
                  ) : (
                    <span key={index}>{segment.text}</span>
                  ),
                )}
              </span>
              <span className="search-line-no" data-search-line-no={line.line}>
                {line.line}
              </span>
            </button>
          ))}
    </div>
  )
}
