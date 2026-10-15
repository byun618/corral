// ⌘P 빠른 열기 (LIFE-593 F5 · E1~E5) — 커맨드 팔레트와 **별도 대화상자**(Q1). 틀(배경·상자·입력·목록 칠)은 팔레트 CSS 를 그대로 쓰고,
// 열기·닫기·`inert`·포커스 복귀는 App 이 팔레트와 같은 방식으로 한다.
//
// · 열 때마다 빈 입력(VS Code `preserveInput: false` — E1ⓕ). 열린 worktree 가 없으면 안내만 보이고 IPC 를 부르지 않는다(E1ⓔ).
// · 목록은 열 때 새로 읽는다. 같은 (루트, 토글)의 마지막 목록이 있으면 먼저 그것으로 보인다(`file-list-client.ts`). 닫히면 진행 중 요청을 끝낸다(E7ⓓ).
// · Enter·클릭 = 고정 탭으로 열기(Q2) — 여는 일은 App 의 `openFileTab` 경로가 한다. 조합(IME) 중 Enter·화살표는 대화상자 동작을 하지 않는다(E1ⓓ).
// · 「무시 파일 포함」 토글(Q3)은 Tab 으로 닿는다(입력 ↔ 토글 순회). 상태는 App 이 앱 실행 동안 들고 있다(영속 안 함).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAnnounceDialog } from '../menu-bus.js'
import { cachedFileList, requestFileList, type FileListOk } from '../file-list-client.js'
import { buildFileIndex, searchFiles, type FileIndex, type QuickOpenResult, type QuickOpenRow } from '../quick-open-search.js'
import { FileIcon } from './ExplorerIcons.js'
import './command-palette.css'
// 파일 아이콘 글꼴(Seti)·`.explorer-file-icon` — 탐색기 패널이 닫혀 있어도 대화상자에서 그린다.
import './explorer.css'
import './quick-open.css'

/** 목록 객체마다 색인 하나 — 다시 열어도 같은 목록이면 색인을 다시 만들지 않는다. */
const indexes = new WeakMap<FileListOk, FileIndex>()
const indexOf = (list: FileListOk): FileIndex => {
  const hit = indexes.get(list)
  if (hit !== undefined) return hit
  const made = buildFileIndex(list.files)
  indexes.set(list, made)
  return made
}

/** 강조 조각 — [start, end) 범위의 글자를 맞은 위치 집합으로 나눈다. */
function Highlighted({ text, start, end, hits }: { text: string; start: number; end: number; hits: ReadonlySet<number> }): React.JSX.Element {
  const parts: React.ReactNode[] = []
  let run = ''
  let runHit = false
  const flush = (key: number): void => {
    if (run === '') return
    parts.push(runHit ? <mark key={key}>{run}</mark> : <span key={key}>{run}</span>)
    run = ''
  }
  for (let index = start; index < end; index += 1) {
    const hit = hits.has(index)
    if (hit !== runHit) {
      flush(index)
      runHit = hit
    }
    run += text[index] ?? ''
  }
  flush(end)
  return <>{parts}</>
}

function Row({ row, index, selected, onOpen }: { row: QuickOpenRow; index: number; selected: boolean; onOpen: () => void }): React.JSX.Element {
  const hits = new Set(row.positions)
  const name = row.display.slice(row.nameStart)
  return (
    <div
      role="option"
      aria-selected={selected}
      id={`quick-open-result-${index}`}
      data-quick-open-row={row.rel}
      data-quick-open-group={row.group}
      className={`palette-entry quick-open-row ${selected ? 'selected' : ''}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      title={row.display}
    >
      <FileIcon name={name} />
      <span className="quick-open-label">
        <span className="quick-open-name">
          <Highlighted text={row.display} start={row.nameStart} end={row.display.length} hits={hits} />
        </span>
        {row.nameStart > 0 ? (
          <span className="quick-open-dir">
            <Highlighted text={row.display} start={0} end={row.nameStart - 1} hits={hits} />
          </span>
        ) : null}
      </span>
    </div>
  )
}

export function QuickOpen({
  root,
  recent,
  includeIgnored,
  onIncludeIgnored,
  onOpen,
  onClose,
}: {
  /** 활성 worktree 경로 — null 이면 안내만(E1ⓔ). */
  root: string | null
  /** 그 worktree 의 최근 연 파일(최근이 앞 — E5). */
  recent: readonly string[]
  includeIgnored: boolean
  onIncludeIgnored: (next: boolean) => void
  onOpen: (rel: string) => void
  onClose: (restore: boolean) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [list, setList] = useState<FileListOk | null>(() => (root === null ? null : cachedFileList({ root, includeIgnored })))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(root !== null)
  const [selected, setSelected] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const executed = useRef(false)
  const previous = useRef<{ index: FileIndex; result: QuickOpenResult } | null>(null)
  useAnnounceDialog()
  useEffect(() => input.current?.focus(), [])

  useEffect(() => {
    if (root === null) return
    let live = true
    setList(cachedFileList({ root, includeIgnored }))
    setError(null)
    setLoading(true)
    const request = requestFileList({ root, includeIgnored })
    void request.result.then((value) => {
      if (!live) return
      setLoading(false)
      if (value.ok) setList(value)
      else if (value.code !== 'cancelled') setError(`파일 목록을 읽지 못했습니다 (${value.code})`)
    })
    return () => {
      live = false
      request.cancel()
    }
  }, [root, includeIgnored])

  const index = useMemo(() => (list === null ? null : indexOf(list)), [list])
  const result = useMemo(() => {
    if (index === null) return null
    const before = previous.current !== null && previous.current.index === index ? previous.current.result : null
    const next = searchFiles({ index, query, recent, previous: before })
    previous.current = { index, result: next }
    return next
  }, [index, query, recent])
  const rows = result?.rows ?? []
  const current = Math.min(selected, Math.max(0, rows.length - 1))
  useEffect(() => {
    document.getElementById(`quick-open-result-${current}`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const open = (row: QuickOpenRow | undefined): void => {
    if (row === undefined || executed.current) return
    executed.current = true
    onClose(false)
    onOpen(row.rel)
  }
  const state = root === null ? 'no-root' : error !== null ? 'error' : index === null ? 'loading' : 'ready'
  const firstFile = rows.findIndex((row) => row.group === 'file')
  const hasRecent = rows.length > 0 && rows[0]?.group === 'recent'

  return (
    <div className="palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(true) }}>
      <div
        className="command-palette quick-open"
        role="dialog"
        aria-modal="true"
        aria-label="빠른 열기"
        data-quick-open=""
        data-quick-open-state={state}
        data-quick-open-loading={loading ? '' : undefined}
        data-quick-open-total={result?.total ?? 0}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose(true)
          } else if (event.key === 'Tab') {
            event.preventDefault()
            if (document.activeElement === toggle.current) input.current?.focus()
            else toggle.current?.focus()
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (rows.length === 0) return
            setSelected((current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
          } else if (event.key === 'Enter' && event.target === input.current) {
            event.preventDefault()
            open(rows[current])
          }
        }}
      >
        <div className="quick-open-head">
          <input
            ref={input}
            role="combobox"
            aria-label="파일 이름으로 찾기"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="quick-open-results"
            aria-activedescendant={rows[current] ? `quick-open-result-${current}` : undefined}
            data-quick-open-input=""
            placeholder={root === null ? '열린 워크트리가 없습니다' : '파일 이름으로 찾기 (공백 = 그리고, / = 경로)'}
            disabled={root === null}
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
          />
          <button
            ref={toggle}
            type="button"
            className={`quick-open-toggle${includeIgnored ? ' is-on' : ''}`}
            aria-pressed={includeIgnored}
            data-quick-open-ignored={includeIgnored ? 'on' : 'off'}
            title="Git 이 무시하는 파일도 목록에 넣는다(.git·node_modules 는 늘 뺀다)"
            disabled={root === null}
            onClick={() => {
              setSelected(0)
              onIncludeIgnored(!includeIgnored)
            }}
          >
            무시 파일 포함
          </button>
        </div>
        <div role="listbox" id="quick-open-results" aria-label="파일" className="palette-results">
          {state === 'no-root' ? (
            <p role="status" data-quick-open-empty="no-root">열린 워크트리가 없습니다 — 사이드바에서 worktree 를 열면 그 안 파일을 찾을 수 있습니다.</p>
          ) : state === 'error' ? (
            <p role="status" data-quick-open-empty="error">{error}</p>
          ) : state === 'loading' ? (
            <p role="status" data-quick-open-empty="loading">파일 목록을 읽는 중…</p>
          ) : rows.length === 0 ? (
            <p role="status" data-quick-open-empty="none">일치하는 파일이 없습니다</p>
          ) : (
            rows.map((row, i) => (
              <div key={row.rel} className="quick-open-item">
                {i === 0 && hasRecent ? <div className="quick-open-group" data-quick-open-heading="recent">최근 연 파일</div> : null}
                {i === firstFile && hasRecent ? <div className="quick-open-group" data-quick-open-heading="file">파일</div> : null}
                <Row row={row} index={i} selected={i === current} onOpen={() => open(row)} />
              </div>
            ))
          )}
        </div>
        <footer>
          {result !== null && result.total > rows.length && query.trim() !== '' ? (
            <span data-quick-open-more="">
              {result.total.toLocaleString()}개 중 {rows.length}개 — 더 있습니다. 질의를 더 입력하세요 ·{' '}
            </span>
          ) : null}
          {list?.truncated === true ? <span data-quick-open-truncated="">목록이 상한에 걸려 일부만 찾습니다 · </span> : null}
          ↑↓ 선택 · Enter 열기 · Tab 무시 파일 토글 · Esc 닫기
        </footer>
      </div>
    </div>
  )
}

