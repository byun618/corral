// 작업 ↔ worktree 칩 (LIFE-603 C10) — 보드 카드(자세히)·리스트 행의 칩, 간단히 카드의 점.
//
// - 칩 하나 = 급한 순 첫 worktree + 「+N」. 점·라벨은 `work-links-model`(→ `paneDot`·`tabStatus`) 에서 — 사이드바와 같은 판정.
// - 칩 클릭 = 「열기」 와 같은 경로(`open`) — App 이 작업 페이지를 닫고 그 worktree 를 사이드바 카드처럼 활성화한다.
// - 카드마다 props 를 내려 보내지 않고 컨텍스트로 받는다 — 보드·백로그·리스트가 같은 칩을 쓴다.
import { createContext, useContext } from 'react'
import { elapsedLabel } from '../../../shared/session-activity.js'
import { PR_ERROR_LABEL, PR_STATE_LABEL, type PrLookup } from '../../../shared/pr-status.js'
import type { WorkItem } from '../../../shared/work.js'
import { AGENT_DOT_LABEL } from '../agent-dot.js'
import { AGENT_ICON } from '../session-glyphs.js'
import { relativeTime } from '../task-detail-model.js'
import { chipOf, loudLabel, remoteLinks, treesFor, type LinkedTree } from '../work-links-model.js'
import { AgentIcon } from './AgentIcon.js'
import { AgentStateDot } from './AgentStateDot.js'

export type WorkLinksView = {
  trees: LinkedTree[]
  open: (tree: LinkedTree) => void
  /** 이 Mac 의 이름(LIFE-635) — 원격 링크를 로컬과 가른다. 모르면 null(원격 목록을 그리지 않는다). */
  machine: string | null
  /** LIFE-624 — worktree 경로 → PR 상태(`usePrStatus`). 없으면 칩을 그리지 않는다. */
  pr?: ReadonlyMap<string, PrLookup>
}

export const WorkLinksContext = createContext<WorkLinksView | null>(null)

/** 그 작업에 붙은 worktree — 급한 순. 컨텍스트가 없으면 빈 목록. */
export function useItemTrees({ connectionId, item }: { connectionId: string | null; item: WorkItem }): LinkedTree[] {
  const view = useContext(WorkLinksContext)
  if (view === null || connectionId === null) return []
  return treesFor({ trees: view.trees, connectionId, itemId: item.id, key: item.key })
}

export function TreeLogo({ tree }: { tree: LinkedTree }): React.JSX.Element | null {
  if (tree.agent === null) return null
  return (
    <span className={`work-chip-logo agent-${tree.agent}`} data-agent-kind={tree.agent} aria-hidden>
      <AgentIcon kind={tree.agent} glyph={AGENT_ICON[tree.agent].glyph} size={11} />
    </span>
  )
}

/** 자세히 카드·리스트 행의 칩. 붙은 worktree 가 없으면 아무것도 그리지 않는다. */
export function WorktreeChip({ connectionId, item }: { connectionId: string | null; item: WorkItem }): React.JSX.Element | null {
  const view = useContext(WorkLinksContext)
  const chip = chipOf(useItemTrees({ connectionId, item }))
  if (view === null || chip === null) return null
  const { tree, more } = chip
  const loud = loudLabel(tree.dot)
  return (
    <button
      type="button"
      className={`work-chip${loud === null ? '' : ' is-loud'}`}
      data-issue-worktree={tree.branch}
      data-no-drag=""
      title={`${tree.repoName} / ${tree.branch}`}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); view.open(tree) }}
    >
      {tree.dot === null ? null : <AgentStateDot dot={tree.dot} />}
      <TreeLogo tree={tree} />
      <span className="work-chip-branch">{tree.branch}</span>
      {loud === null ? null : <span className="work-chip-loud" data-chip-loud={tree.dot ?? ''}>{loud}</span>}
      {more > 0 ? <span className="work-chip-more" data-chip-more={more}>+{more}</span> : null}
    </button>
  )
}

/** 간단히 카드 — 칩 대신 점(급한 순 첫 worktree). */
export function WorktreeDotMark({ connectionId, item }: { connectionId: string | null; item: WorkItem }): React.JSX.Element | null {
  const chip = chipOf(useItemTrees({ connectionId, item }))
  if (chip === null || chip.tree.dot === null) return null
  return (
    <span className="work-chip-dot" data-issue-worktree-dot={chip.tree.dot} title={`${chip.tree.repoName} / ${chip.tree.branch}${chip.more > 0 ? ` 외 ${chip.more}` : ''}`}>
      <AgentStateDot dot={chip.tree.dot} />
    </span>
  )
}

// --- 상세 (C1·C10) — 상태 줄 오른쪽 작업 버튼 · 본문 뒤 「실행」 ---

export type DetailWorkActions = {
  /** 질문 대기 pane 으로 — 작업 페이지를 닫고 그 pane 을 고른다(사이드바 세션 클릭과 같은 길). */
  reveal: (paneId: string) => void
  /** 시작 모달 열기 — `first` = 링크 없음, `another` = 하나 더. */
  start: (mode: 'first' | 'another') => void
}

/** 링크 없음 = 「▶ 시작」 / 있음 = 「열기 · <브랜치>」 + 「하나 더 시작」. */
export function WorkButtons({ trees, actions }: { trees: LinkedTree[]; actions: DetailWorkActions }): React.JSX.Element {
  const view = useContext(WorkLinksContext)
  const first = trees[0]
  if (first === undefined || view === null) {
    return <button type="button" className="issue-btn is-accent" data-issue-start="first" onClick={() => actions.start('first')}>▶ 시작</button>
  }
  return (
    <span className="issue-work-buttons">
      <button type="button" className="issue-btn is-primary" data-issue-open={first.branch} title={`${first.repoName} / ${first.branch}`} onClick={() => view.open(first)}>
        열기 · <span className="issue-work-branch">{first.branch}</span>
      </button>
      <button type="button" className="issue-btn is-ghost" data-issue-start="another" onClick={() => actions.start('another')}>하나 더 시작</button>
    </span>
  )
}

/**
 * 다른 곳의 링크(LIFE-635 C5) — 출처에 있는데 이 Mac 의 로컬 worktree 로 합쳐지지 않는 링크(폰·웹·에이전트·다른 Mac). **읽기 전용** — 편집·떼기 없음.
 * PR 은 `http(s)` 주소만 바깥 링크(새 창 → main 이 http·https 만 연다), 그 밖은 글자. 없으면 아무것도 그리지 않는다(목록 행의 빈 배열을 「없음」 으로 그리지 않는다).
 */
export function RemoteLinksSection({ item, trees, now }: { item: WorkItem; trees: LinkedTree[]; now: number }): React.JSX.Element | null {
  const view = useContext(WorkLinksContext)
  const rows = remoteLinks({ records: item.workLinks, trees, machine: view?.machine ?? null })
  if (rows === null || rows.length === 0) return null
  return (
    <section className="issue-section" data-issue-remote-links="">
      <div className="issue-section-head"><span>다른 곳의 링크</span></div>
      {rows.map((row) => {
        const at = row.createdAt === null ? Number.NaN : Date.parse(row.createdAt)
        return (
          <div key={row.id} className="issue-work-box" data-remote-link={row.kindLabel}>
            <div className="issue-work-line">
              <span className="issue-work-auto">{row.kindLabel}</span>
              {row.href === null
                ? <span className="issue-work-branch issue-remote-value" data-remote-value="">{row.value}</span>
                : <a className="issue-work-branch issue-remote-value" data-remote-href="" href={row.href} target="_blank" rel="noopener noreferrer">{row.value}</a>}
            </div>
            <div className="issue-work-where">
              <span className="issue-work-repo" data-remote-machine="">{row.machine ?? '기기 모름'}</span>
              {row.repo === null ? null : <> · <span data-remote-repo="">{row.repo}</span></>}
              {Number.isFinite(at) ? <> · <span className="issue-work-time" data-remote-at="">{relativeTime({ at, now })}</span></> : null}
            </div>
          </div>
        )
      })}
    </section>
  )
}

/** PR 칩(LIFE-624 C6·C7) — `PR #<번호> · <상태>`. PR 이 있을 때만, 그 밖(없음·오류·거절)은 아무것도 그리지 않는다. */
export function PrChip({ lookup }: { lookup: PrLookup | undefined }): React.JSX.Element | null {
  if (lookup?.kind !== 'pr') return null
  const { pr } = lookup
  return <span className={`pr-chip is-${pr.state}`} data-pr-chip={pr.state} data-pr-number={pr.number} title={pr.url}>PR #{pr.number} · {PR_STATE_LABEL[pr.state]}</span>
}

/** 실행 영역의 흐린 이유(C6) — 못 읽었을 때만. 「GitHub 원격 아님」 은 그 레포에 원래 PR 이 없으니 소리 내지 않는다. */
export function PrReason({ lookup }: { lookup: PrLookup | undefined }): React.JSX.Element | null {
  if (lookup?.kind !== 'error' || lookup.error === 'not_github') return null
  return <span className="pr-reason" data-pr-reason={lookup.error} title={lookup.message}>{PR_ERROR_LABEL[lookup.error]}</span>
}

export function WorkRunSection({ trees, itemKey, now, actions }: { trees: LinkedTree[]; itemKey: string; now: number; actions: DetailWorkActions }): React.JSX.Element {
  const view = useContext(WorkLinksContext)
  return (
    <section className="issue-section" data-issue-work="">
      <div className="issue-section-head"><span>실행</span></div>
      {trees.length === 0 ? (
        <div className="issue-muted issue-empty" data-issue-work-empty="">아직 연 worktree 가 없습니다. 브랜치 이름에 {itemKey} 가 들어가면 자동으로 여기 붙습니다.</div>
      ) : trees.map((tree) => {
        const elapsed = elapsedLabel(tree.activityAt, now)
        return (
          <div key={tree.path} className="issue-work-box" data-work-tree={tree.branch} data-work-dot={tree.dot ?? 'none'}>
            <div className="issue-work-line">
              {tree.dot === null ? null : <AgentStateDot dot={tree.dot} />}
              <TreeLogo tree={tree} />
              <span className="issue-work-state">{tree.dot === null ? '에이전트 없음' : AGENT_DOT_LABEL[tree.dot]}</span>
              {elapsed === null ? null : <span className="issue-work-time">{elapsed}</span>}
              {tree.link.mode === 'explicit' ? null : <span className="issue-work-auto" title="브랜치 이름의 키로 붙었습니다">자동</span>}
              <span className="issue-detail-head-spacer" />
              <button type="button" className="issue-link-btn" data-work-goto={tree.branch} onClick={() => view?.open(tree)}>worktree 로</button>
            </div>
            <div className="issue-work-where">
              <span className="issue-work-repo">{tree.repoName}</span> / <span className="issue-work-branch">{tree.branch}</span>
              <PrChip lookup={view?.pr?.get(tree.path)} />
              <PrReason lookup={view?.pr?.get(tree.path)} />
            </div>
            {tree.question === null ? null : (
              <div className="issue-work-question" data-work-question={tree.question.text === null ? 'unreadable' : 'text'}>
                {tree.question.text === null
                  ? <div className="issue-muted" data-work-question-reason="">{tree.question.reason}</div>
                  : <div className="issue-work-question-text">{tree.question.text}</div>}
                <button type="button" className="issue-link-btn" data-work-answer={tree.question.paneId} onClick={() => { if (tree.question !== null) actions.reveal(tree.question.paneId) }}>터미널에서 답하기 →</button>
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}
