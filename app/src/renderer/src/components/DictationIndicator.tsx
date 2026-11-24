// LIFE-834 — 녹음 중 표시. 상태·partial 글·무음 알림. 받아쓰기가 아닐 때(idle)는 그리지 않는다. 오류는 토스트가 말한다(표시는 끝나며 사라진다).
import type { DictationView } from '../dictation-controller.js'

export const DICTATION_SILENT_TEXT = '마이크 입력이 없다 — 입력 장치(덮개 닫힌 내장 마이크 등)를 확인한다'

export function DictationIndicator({ view, toggleLabel }: { view: DictationView; toggleLabel: string | null }): React.JSX.Element | null {
  if (view.phase === 'idle') return null
  const status = view.phase === 'starting' ? '받아쓰기 준비 중…' : view.phase === 'stopping' ? '마지막 글 확정 중…' : '받아쓰는 중'
  const hint = view.phase === 'listening' ? `${toggleLabel === null ? '' : `${toggleLabel} 정지 · `}Esc 취소` : 'Esc 취소'
  const partial = view.phase === 'starting' ? '' : view.partial
  const silent = view.phase !== 'starting' && view.silent
  return (
    <div className={`dictation-indicator phase-${view.phase}`} data-dictation-indicator={view.phase} role="status" aria-live="polite">
      <div className="dictation-indicator-row">
        <span className="dictation-indicator-dot" />
        <span className="dictation-indicator-status">{status}</span>
        <span className="dictation-indicator-hint">{hint}</span>
      </div>
      {partial !== '' ? (
        <div className="dictation-indicator-partial" data-dictation-partial>
          {partial}
        </div>
      ) : null}
      {silent ? (
        <div className="dictation-indicator-silent" data-dictation-silent>
          {DICTATION_SILENT_TEXT}
        </div>
      ) : null}
    </div>
  )
}
