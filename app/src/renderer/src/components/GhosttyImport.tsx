// 외관 › 터미널 「Ghostty에서 가져오기」 (LIFE-513 K8) — 버튼 + 미리보기·적용 모달.
// Orca v1.4.198 `useGhosttyImport.ts`·`GhosttyImportModal.tsx` 의 흐름·상태·ko 문구를 옮겼다(MIT, 고지 `src/main/ghostty/NOTICE.md`).
// 모달 모양은 corral 대화 상자(`modal-*` · `RevealConfirmDialog`)를 따른다. Orca 와 다른 점: 아이콘 없음(Ghostty 로고 라이선스 확인을
// 피했다) · 지원되지 않는 키에 사유 · override 는 색 견본 · 적용 실패는 저장소가 `failed` 를 돌려준 경우(Orca 는 예외만 봤다).
//
// 가져오기는 **1회 복사**다(K5ⓓ) — 적용 뒤 Ghostty 파일을 다시 보지 않는다. 적용은 기존 쓰기 경로 한 번(`updateSettings`).
import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { GhosttyImportPreview } from '../../../shared/ghostty-import.js'
import { ghosttyDiffRows, ghosttyImportPatch, type GhosttyDiffRow } from '../ghostty-import.js'
import { useAnnounceDialog, useWindowEscape } from '../menu-bus.js'
import { getSettings, updateSettings } from '../settings-store.js'

type ImportState =
  | { phase: 'closed' }
  | { phase: 'loading' }
  | { phase: 'ready'; preview: GhosttyImportPreview; applying: boolean; applyError: string | null }
  | { phase: 'applied'; preview: Extract<GhosttyImportPreview, { status: 'found' }> }

async function loadPreview(): Promise<GhosttyImportPreview> {
  const corral = typeof window !== 'undefined' ? window.corral : undefined
  if (corral === undefined || typeof corral.previewGhosttyImport !== 'function') return { status: 'error', error: '미리보기를 불러올 수 없습니다.' }
  try {
    return (await corral.previewGhosttyImport()) ?? { status: 'error', error: '미리보기를 불러올 수 없습니다.' }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

function DiffList({ rows }: { rows: GhosttyDiffRow[] }): React.JSX.Element {
  return (
    <ul className="ghostty-import-diff" data-ghostty-import-diff>
      {rows.map((row) => (
        <li key={row.key} data-ghostty-import-row={row.key}>
          <span className="ghostty-import-label">{row.label}</span>
          {row.kind === 'value' ? (
            <span className="ghostty-import-value">{row.value}</span>
          ) : (
            <span className="ghostty-import-colors">
              {row.colors.map((entry) => (
                <span key={entry.name} className="ghostty-import-color" data-ghostty-import-color={entry.name}>
                  <span className="ghostty-import-swatch" style={{ backgroundColor: entry.color }} aria-hidden />
                  {entry.name}: {entry.color}
                </span>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function GhosttyImportModal({ state, onClose, onApply }: { state: Exclude<ImportState, { phase: 'closed' }>; onClose: () => void; onApply: () => void }): React.JSX.Element {
  useAnnounceDialog()
  useWindowEscape({ onEscape: onClose })
  const found = state.phase === 'ready' && state.preview.status === 'found' ? state.preview : null
  const rows = found === null ? [] : ghosttyDiffRows(found.diff)
  const hasChanges = rows.length > 0
  return (
    <div className="modal-scrim" data-modal-scrim onMouseDown={onClose}>
      <div className="modal modal-ghostty-import" role="dialog" aria-label="Ghostty에서 가져오기" data-ghostty-import-modal={state.phase === 'ready' ? state.preview.status : state.phase} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head modal-head-plain">
          <div>
            <h2 className="modal-title">Ghostty에서 가져오기</h2>
            <p className="modal-desc">Ghostty 구성에서 가져올 설정을 확인하세요.</p>
          </div>
        </div>
        <div className="modal-body">
          {state.phase === 'loading' ? <p className="modal-desc" data-ghostty-import-loading>미리보기 로드 중…</p> : null}
          {state.phase === 'applied' ? (
            <div>
              <p className="ghostty-import-heading ghostty-import-done" data-ghostty-import-done>가져오기 완료</p>
              <DiffList rows={ghosttyDiffRows(state.preview.diff)} />
            </div>
          ) : null}
          {state.phase === 'ready' && state.preview.status === 'not-found' ? <p className="modal-desc" data-ghostty-import-not-found>이 시스템에는 Ghostty 구성이 없습니다.</p> : null}
          {state.phase === 'ready' && state.preview.status === 'error' ? <p className="ghostty-import-error" data-ghostty-import-error>{state.preview.error}</p> : null}
          {state.phase === 'ready' && found !== null ? (
            <>
              <p className="modal-desc ghostty-import-paths" data-ghostty-import-paths>구성: {found.configPaths.join(', ')}</p>
              {hasChanges ? (
                <div>
                  <p className="ghostty-import-heading">업데이트할 설정</p>
                  <DiffList rows={rows} />
                </div>
              ) : (
                <p className="modal-desc" data-ghostty-import-no-changes>가져올 새 설정이 없습니다. 현재 설정이 이미 일치합니다.</p>
              )}
              {state.applyError !== null ? <p className="ghostty-import-error" data-ghostty-import-apply-error>{state.applyError}</p> : null}
              {found.unsupported.length > 0 ? (
                <div>
                  <p className="ghostty-import-heading">지원되지 않는 키</p>
                  <ul className="ghostty-import-unsupported" data-ghostty-import-unsupported>
                    {found.unsupported.map((entry, index) => (
                      <li key={`${entry.key}-${index}`}>
                        <span className="ghostty-import-key">{entry.key}</span> <span className="ghostty-import-reason">— {entry.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <div className="modal-footer">
          {state.phase === 'applied' ? (
            <button type="button" className="btn-accent" data-ghostty-import-close autoFocus onClick={onClose}>완료</button>
          ) : (
            <>
              <button type="button" className="btn-ghost" data-ghostty-import-cancel onClick={onClose}>취소</button>
              {hasChanges ? (
                <button type="button" className="btn-accent" data-ghostty-import-apply autoFocus disabled={state.phase === 'ready' && state.applying} onClick={onApply}>변경 사항 적용</button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 「터미널 타이포그래피」 소제목 action 자리의 버튼 + 모달(Orca 198 `TerminalAppearanceSection.tsx:184-199` 자리). */
export function GhosttyImportButton(): React.JSX.Element {
  const [state, setState] = useState<ImportState>({ phase: 'closed' })

  const open = async (): Promise<void> => {
    setState({ phase: 'loading' })
    const preview = await loadPreview()
    // 로딩 중에 닫았으면 다시 열지 않는다.
    setState((prev) => (prev.phase === 'loading' ? { phase: 'ready', preview, applying: false, applyError: null } : prev))
  }

  const apply = async (): Promise<void> => {
    if (state.phase !== 'ready' || state.preview.status !== 'found' || state.applying) return
    const preview = state.preview
    setState({ phase: 'ready', preview, applying: true, applyError: null })
    const saved = await updateSettings(ghosttyImportPatch({ diff: preview.diff, current: getSettings() }))
    setState((prev) => {
      if (prev.phase === 'closed') return prev
      // 저장 실패면 「완료」 로 보이지 않는다(K5ⓒ) — 모달에 오류를 남긴다.
      return saved ? { phase: 'applied', preview } : { phase: 'ready', preview, applying: false, applyError: '설정을 저장하지 못했습니다. 다시 시도하세요.' }
    })
  }

  return (
    <>
      <button type="button" className="btn-ghost settings-ghostty-import" data-settings-ghostty-import onClick={() => void open()}>
        Ghostty에서 가져오기
      </button>
      {/* 문서 루트에 그린다 — 설정 화면(쌓임 맥락 z-index 30) 안의 카드에 갇히지 않게. */}
      {state.phase === 'closed' ? null : createPortal(<GhosttyImportModal state={state} onClose={() => setState({ phase: 'closed' })} onApply={() => void apply()} />, document.body)}
    </>
  )
}
