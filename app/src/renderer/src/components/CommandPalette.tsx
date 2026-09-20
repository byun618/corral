import { useEffect, useRef, useState } from 'react'
import { searchPalette, type PaletteEntry } from '../palette-search.js'
import './command-palette.css'

export function CommandPalette({ entries, onClose }: { entries: PaletteEntry[]; onClose: (restore: boolean) => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(() => searchPalette(entries, '')[0]?.id ?? null)
  const input = useRef<HTMLInputElement>(null)
  const executed = useRef(false)
  const rows = searchPalette(entries, query)
  const index = rows.findIndex(entry => entry.id === selected)
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => { document.getElementById(`palette-result-${index}`)?.scrollIntoView({ block: 'nearest' }) }, [index])
  const run = (entry: PaletteEntry): void => {
    if (entry.disabled || executed.current) return
    executed.current = true
    onClose(false)
    entry.run()
  }
  return <div className="palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(true) }}>
    <div className="command-palette" role="dialog" aria-modal="true" aria-label="커맨드 팔레트" data-command-palette onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); onClose(true) }
      if (event.key === 'Tab') { event.preventDefault(); input.current?.focus() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(1, rows.length); setSelected(rows[next]?.id ?? null) }
      if (event.key === 'Enter') { event.preventDefault(); if (rows[index]) run(rows[index]) }
    }}>
      <input ref={input} role="combobox" aria-label="명령 검색" aria-expanded="true" aria-autocomplete="list" aria-controls="palette-results" aria-activedescendant={rows[index] ? `palette-result-${index}` : undefined} placeholder="명령, 레포, worktree, pane 검색…" value={query} onChange={event => { setQuery(event.target.value); setSelected(searchPalette(entries, event.target.value)[0]?.id ?? null) }} />
      <div role="listbox" id="palette-results" aria-label="명령" className="palette-results">
        {rows.length === 0 ? <p role="status">검색 결과가 없습니다</p> : rows.map((entry, i) => <div role="option" aria-selected={index === i} aria-disabled={!!entry.disabled} id={`palette-result-${i}`} data-palette-entry={entry.id} className={`palette-entry ${i === index ? 'selected' : ''}`} key={entry.id} onMouseDown={event => event.preventDefault()} onClick={() => run(entry)} title={`${entry.title}\n${entry.detail}\n${entry.disabled ?? ''}`}>
          <span className="palette-label"><strong>{entry.title}</strong><small>{entry.disabled ?? entry.detail}</small></span><kbd>{entry.shortcut}</kbd>
        </div>)}
      </div>
      <footer>↑↓ 선택 · Enter 실행 · Esc 닫기</footer>
    </div>
  </div>
}
