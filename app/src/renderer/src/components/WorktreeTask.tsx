// 사이드바 카드의 작업 줄 (LIFE-603 C11) — 링크된 worktree 카드에만.
//
// 자세히: 메타 줄 아래 한 줄(종류 · 키 mono · 제목 잘림) / 간단히: 제목 줄 끝 키 칩(막힘이면 빨간 점).
// hover 요약은 기존 `HoverCard`(320). 누르면 작업 페이지 + 그 작업 상세.
// 출처 연결이 없거나 오류·작업을 못 찾으면 **키만** 그린다(제목 없음) — 카드는 그대로 산다.
// 제목은 App 의 캐시(`useLinkTitles`)에서 온다 — 이 컴포넌트는 요청을 내지 않는다.
import { HoverCard } from './HoverCard.js'
import './work-links.css'

export type WorktreeTaskLine = {
  key: string
  /** 못 찾았거나 연결이 없으면 null — 키만. */
  title: string | null
  kindLabel: string | null
  statusLabel: string | null
  blocked: boolean
  blockers: string[]
  onOpen: () => void
}

function Summary({ line }: { line: WorktreeTaskLine }): React.JSX.Element {
  return (
    <div className="worktree-task-hover" data-worktree-task-hover="">
      <div className="worktree-task-hover-head"><span className="worktree-task-key">{line.key}</span>{line.kindLabel === null ? null : <span className="worktree-task-kind">{line.kindLabel}</span>}</div>
      {line.title === null ? <div className="worktree-task-muted">작업 제목을 읽지 못했습니다.</div> : <div className="worktree-task-hover-title">{line.title}</div>}
      {line.statusLabel === null ? null : <div className="worktree-task-muted">{line.statusLabel}</div>}
      {line.blockers.length === 0 ? null : <div className="worktree-task-blocked-text">막힘: {line.blockers.join(' · ')}</div>}
    </div>
  )
}

export function WorktreeTaskRow({ line, suppressed, testId }: { line: WorktreeTaskLine; suppressed: boolean; testId: string }): React.JSX.Element {
  return (
    <HoverCard
      content={<Summary line={line} />}
      suppressed={suppressed}
      testId={`${testId}#task`}
      render={(trigger) => (
        <button
          {...trigger}
          type="button"
          className="worktree-task-line"
          data-worktree-issue={line.key}
          onClick={(event) => { event.stopPropagation(); line.onOpen() }}
        >
          {line.kindLabel === null ? null : <span className="worktree-task-kind">{line.kindLabel}</span>}
          <span className="worktree-task-key">{line.key}</span>
          {line.title === null ? null : <span className="worktree-task-title">{line.title}</span>}
          {line.blocked ? <span className="worktree-task-blocked" data-worktree-issue-blocked="" aria-label="막힘" /> : null}
        </button>
      )}
    />
  )
}

export function WorktreeTaskChip({ line, suppressed, testId }: { line: WorktreeTaskLine; suppressed: boolean; testId: string }): React.JSX.Element {
  return (
    <HoverCard
      content={<Summary line={line} />}
      suppressed={suppressed}
      testId={`${testId}#task`}
      render={(trigger) => (
        <button
          {...trigger}
          type="button"
          className="worktree-task-chip"
          data-worktree-issue={line.key}
          onClick={(event) => { event.stopPropagation(); line.onOpen() }}
        >
          {line.blocked ? <span className="worktree-task-blocked" data-worktree-issue-blocked="" aria-label="막힘" /> : null}
          {line.key}
        </button>
      )}
    />
  )
}
