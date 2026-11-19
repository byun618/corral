// 세션 보기 (LIFE-808) — 오른쪽 패널 몸통. 디스크에 남은 Claude·Codex 대화 기록을 범위·검색·필터로 좁혀 고르고, 상세에서 재개·복사한다.
//
// · 머리: 「세션」 + 새로고침. 그 아래 범위 3단(현재 worktree · 프로젝트 · 머신 전체), 검색, 에이전트 표지, 빈 세션 숨기기.
// · 상태마다 다른 글(C10) — 불러오는 중 · 기록 0건 · 검색 결과 0건 · worktree 선택 없음 · 스캔 실패 · 에이전트 0개.
// · 행: 제목·시각(줄지 않는 칸) / cwd·provider·「열림」. 이미 열린 세션은 재개 대신 그 탭으로 이동(C8).
// · 상세: 첫 프롬프트 전문 · 최근 턴 · 메시지 수 · 재개 명령 미리보기 · 재개 · 명령/ID/기록 경로 복사 · Finder 에서 보기(C6·C7·C9·C19).
import { useEffect, useMemo, useState } from 'react'
import type { AgentSessionRef } from '../../../shared/types.js'
import {
  HISTORY_PROVIDERS,
  HISTORY_SCOPES,
  enabledProviders,
  filterRows,
  openPaneOf,
  scopeRows,
  searchRows,
  type HistoryProvider,
  type PaneSession,
  type ScopeContext,
  type SessionHistoryDetail,
  type SessionHistoryRow,
} from '../../../shared/session-history.js'
import type { SessionHistoryApi } from '../hooks/useSessionHistory.js'
import { Codicon } from './ExplorerIcons.js'
import './session-history.css'

const PROVIDER_LABEL: Record<HistoryProvider, string> = { claude: 'Claude', codex: 'Codex' }
const NO_REALPATHS: Readonly<Record<string, string>> = {}

/** 목록 시각 — 오늘이면 시:분, 아니면 날짜. */
function timeLabel(at: number, now: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date(now)
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  return sameDay ? date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' })
}

export type HistoryBody = { kind: 'notice'; text: string } | { kind: 'rows'; rows: SessionHistoryRow[] }

/** 몸통 — 글 하나 또는 행 목록. 순수 함수(C10 시험 대상). 범위 → 에이전트·빈 세션 → 검색 순으로 겹쳐 건다. */
export function sessionHistoryBody({ api, context }: { api: Pick<SessionHistoryApi, 'list' | 'agents' | 'hideEmpty' | 'scope' | 'query'>; context: ScopeContext }): HistoryBody {
  if (enabledProviders(api.agents).length === 0) return { kind: 'notice', text: '에이전트를 하나 이상 고르세요 — Claude · Codex 표지를 켜면 기록을 훑습니다.' }
  if (api.scope !== 'machine' && context.worktree === null) return { kind: 'notice', text: 'worktree 선택 없음 — 사이드바에서 worktree 를 고르거나 「머신 전체」 로 보세요.' }
  if (api.list.kind === 'loading') return { kind: 'notice', text: '세션 기록을 불러오는 중…' }
  const result = api.list.result
  if (result.kind === 'error') return { kind: 'notice', text: `세션 기록을 읽지 못했습니다 — ${result.message}` }
  if (result.rows.length === 0) return { kind: 'notice', text: '세션 기록이 없습니다.' }
  const scoped = scopeRows({ rows: result.rows, scope: api.scope, context })
  if (scoped.kind === 'no-worktree') return { kind: 'notice', text: 'worktree 선택 없음 — 사이드바에서 worktree 를 고르거나 「머신 전체」 로 보세요.' }
  const rows = searchRows({ rows: filterRows({ rows: scoped.rows, agents: api.agents, hideEmpty: api.hideEmpty }), query: api.query })
  if (rows.length > 0) return { kind: 'rows', rows }
  if (api.query.trim().length > 0) return { kind: 'notice', text: '검색 결과가 없습니다.' }
  return { kind: 'notice', text: '이 범위에 표시할 세션이 없습니다.' }
}

/** 이 보기가 읽는 레포 모양 — `RepoRow` 의 부분(범위 재료·열린 세션). */
export type HistoryRepo = {
  root: string
  worktrees: readonly { path: string; workspace: { tabs: readonly { panes: readonly { paneId: string; agent: string | null; agentSession: AgentSessionRef | null }[] }[] } | null }[]
}

/**
 * 범위 재료(C4) — 활성 worktree 와 그것이 속한 등록 레포. 경로는 main 이 준 realpath 로 바꿔(R1-8) 행 `cwdKey`(realpath)와 같은 눈으로 비교한다.
 */
export function historyScopeContext({ repos, worktree, realpaths }: { repos: readonly HistoryRepo[]; worktree: string | null; realpaths: Readonly<Record<string, string>> }): ScopeContext {
  if (worktree === null) return { worktree: null, repo: null }
  const real = (dir: string): string => realpaths[dir] ?? dir
  const repo = repos.find((entry) => entry.root === worktree || entry.worktrees.some((row) => row.path === worktree)) ?? null
  return { worktree: real(worktree), repo: repo === null ? null : { root: real(repo.root), worktrees: repo.worktrees.map((row) => real(row.path)) } }
}

/** 지금 pane 들의 감지된 에이전트·세션 참조 (C8) — 열림 판정은 main 과 같은 `openPaneOf`. */
export function historyPanes(repos: readonly HistoryRepo[]): PaneSession[] {
  const out: PaneSession[] = []
  for (const repo of repos)
    for (const worktree of repo.worktrees)
      for (const tab of worktree.workspace?.tabs ?? [])
        for (const pane of tab.panes) out.push({ paneId: pane.paneId, agent: pane.agent, sessionId: pane.agentSession?.kind === 'id' ? pane.agentSession.id : null })
  return out
}

const sameRow = (row: SessionHistoryRow, key: { provider: HistoryProvider; id: string }): boolean => row.provider === key.provider && row.id === key.id

export type SessionHistoryViewProps = {
  api: SessionHistoryApi
  repos: readonly HistoryRepo[]
  /** 활성 worktree 경로 — 없으면 null. */
  worktree: string | null
  /** 새 탭을 만들 workspace — 활성 worktree 가 없으면 null(재개 비활성). */
  workspaceId: string | null
  onRevealPane: (paneId: string) => void
}

export function SessionHistoryView({ api, repos, worktree, workspaceId, onRevealPane }: SessionHistoryViewProps): React.JSX.Element {
  const realpaths = api.list.kind === 'ready' && api.list.result.kind === 'ok' ? api.list.result.realpaths : NO_REALPATHS
  const context = useMemo(() => historyScopeContext({ repos, worktree, realpaths }), [repos, worktree, realpaths])
  const panes = useMemo(() => historyPanes(repos), [repos])
  const body = sessionHistoryBody({ api, context })
  // R1-4 — 선택 행이 보이는 목록(범위·검색·필터·빈 세션)에서 빠지면 선택·상세를 지운다. 새로고침 중에는 이전 목록이 보이므로 지우지 않는다.
  const selected = api.selected
  const selectedVisible = selected === null || (body.kind === 'rows' && body.rows.some((row) => sameRow(row, selected)))
  const select = api.select
  useEffect(() => {
    if (!selectedVisible) select(null)
  }, [selectedVisible, select])
  const busy = api.list.kind === 'loading' || (api.list.kind === 'ready' && api.list.refreshing)
  const now = Date.now()
  return (
    <div className="history-view" data-history-view="" data-history-busy={busy ? '' : undefined}>
      <div className="explorer-section-head" data-history-head="">
        <span className="explorer-section-twistie" />
        <span className="explorer-section-title">세션</span>
        <div className="explorer-toolbar">
          <button type="button" className="explorer-tool" data-history-refresh="" title="새로고침" aria-label="새로고침" onClick={api.refresh}>
            <Codicon name="refresh" />
          </button>
        </div>
      </div>
      <div className="history-controls">
        <div className="history-scopes" role="radiogroup" aria-label="범위">
          {HISTORY_SCOPES.map((entry) => (
            <button key={entry.id} type="button" role="radio" aria-checked={api.scope === entry.id} className={`history-chip${api.scope === entry.id ? ' is-on' : ''}`} data-history-scope={entry.id} onClick={() => api.setScope(entry.id)}>
              {entry.title}
            </button>
          ))}
        </div>
        <input className="history-search" type="search" placeholder="제목·폴더·브랜치·모델·프롬프트 검색" aria-label="세션 검색" data-history-search="" value={api.query} onChange={(event) => api.setQuery(event.target.value)} />
        <div className="history-filters">
          {HISTORY_PROVIDERS.map((provider) => (
            <button key={provider} type="button" aria-pressed={api.agents[provider]} className={`history-chip${api.agents[provider] ? ' is-on' : ''}`} data-history-agent={provider} onClick={() => api.setAgent({ provider, on: !api.agents[provider] })}>
              {PROVIDER_LABEL[provider]}
            </button>
          ))}
          <label className="history-hide-empty">
            <input type="checkbox" data-history-hide-empty="" checked={api.hideEmpty} onChange={(event) => api.setHideEmpty(event.target.checked)} />
            빈 세션 숨기기
          </label>
        </div>
      </div>
      <div className="explorer-scroll history-list" data-history-list="">
        {body.kind === 'notice' ? (
          <div className="explorer-empty" data-history-empty="">
            {body.text}
          </div>
        ) : (
          body.rows.map((row) => {
            const selected = api.selected !== null && sameRow(row, api.selected)
            const open = openPaneOf({ panes, key: row }) !== null
            return (
              <button key={`${row.provider}:${row.id}`} type="button" className={`history-row${selected ? ' is-selected' : ''}`} data-history-row={`${row.provider}:${row.id}`} aria-pressed={selected} onClick={() => api.select({ provider: row.provider, id: row.id })}>
                <span className="history-row-line">
                  <span className="history-row-title">{row.title ?? '(제목 없음)'}</span>
                  <span className="history-row-time">{timeLabel(row.lastActivityAt, now)}</span>
                </span>
                <span className="history-row-line is-second">
                  <span className={`history-row-cwd${row.cwdExists ? '' : ' is-missing'}`} title={row.cwd ?? undefined}>
                    {row.cwd ?? '(폴더 모름)'}
                  </span>
                  {open ? (
                    <span className="history-badge is-open" data-history-open="">
                      열림
                    </span>
                  ) : null}
                  <span className="history-badge">{PROVIDER_LABEL[row.provider]}</span>
                </span>
              </button>
            )
          })
        )}
      </div>
      {api.selected === null || !selectedVisible ? null : <HistoryDetailPane api={api} openPaneId={openPaneOf({ panes, key: api.selected })} workspaceId={workspaceId} onRevealPane={onRevealPane} />}
    </div>
  )
}

function HistoryDetailPane({ api, openPaneId, workspaceId, onRevealPane }: { api: SessionHistoryApi; openPaneId: string | null; workspaceId: string | null; onRevealPane: (paneId: string) => void }): React.JSX.Element {
  const state = api.detail
  return (
    <div className="history-detail" data-history-detail="">
      {state.kind === 'none' ? null : state.kind === 'loading' ? (
        <div className="explorer-empty" data-history-detail-empty="">
          세션 상세를 불러오는 중…
        </div>
      ) : state.result.kind === 'error' ? (
        <div className="explorer-empty" data-history-detail-empty="">
          {state.result.message}
        </div>
      ) : (
        <DetailBody key={`${state.key.provider}:${state.key.id}`} detail={state.result.detail} openPaneId={openPaneId} workspaceId={workspaceId} onRevealPane={onRevealPane} />
      )}
    </div>
  )
}

function DetailBody({ detail, openPaneId, workspaceId, onRevealPane }: { detail: SessionHistoryDetail; openPaneId: string | null; workspaceId: string | null; onRevealPane: (paneId: string) => void }): React.JSX.Element {
  const [message, setMessage] = useState<string | null>(null)
  /** 재개 요청 중 — 단추를 막는다(R1-2). main 도 같은 세션의 진행 중 재개를 막는다. */
  const [resuming, setResuming] = useState(false)
  const copy = (input: { text: string; label: string }): void => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(input.text))
      .then(() => setMessage(`${input.label} 복사했습니다`))
      .catch(() => setMessage(`${input.label} 복사하지 못했습니다`))
  }
  const key = { provider: detail.provider, id: detail.id }
  const resumeBlocked = detail.resume.disabled ?? (workspaceId === null ? '열린 worktree 가 없어 새 탭을 만들 수 없습니다' : null)
  const resume = (): void => {
    if (workspaceId === null || resuming) return
    setResuming(true)
    void Promise.resolve()
      .then(() => window.corral.sessionHistoryResume({ ...key, workspaceId }))
      .then((result) => {
        switch (result.kind) {
          case 'started':
            // R1-6(e) — 새 탭으로 이동(「탭으로 이동」 과 같은 경로).
            if (result.paneId !== null) onRevealPane(result.paneId)
            return setMessage('새 탭에서 재개했습니다')
          case 'pending':
            return setMessage('이 세션의 재개가 이미 진행 중입니다')
          case 'open':
            return onRevealPane(result.paneId)
          case 'rejected':
            return setMessage(result.reason)
          case 'error':
            return setMessage(`재개하지 못했습니다 — ${result.message}`)
        }
      })
      .catch((error: unknown) => setMessage(`재개하지 못했습니다 — ${String(error).slice(0, 200)}`))
      .finally(() => setResuming(false))
  }
  const reveal = (): void => {
    void Promise.resolve()
      .then(() => window.corral.sessionHistoryReveal(key))
      .then((result) => setMessage(result.kind === 'ok' ? null : result.kind === 'rejected' ? result.reason : result.message))
      .catch((error: unknown) => setMessage(String(error).slice(0, 200)))
  }
  return (
    <div className="history-detail-body">
      <div className="history-detail-meta">
        <span data-history-detail-id="">
          {PROVIDER_LABEL[detail.provider]} · {detail.id}
        </span>
        <span data-history-count="">메시지 {detail.messageCount}개</span>
      </div>
      <div className="history-detail-cwd" data-history-cwd="">
        {detail.resume.fallback ? `원래 폴더 없음 — ${detail.resume.cwd} 에서 재개` : detail.cwd}
      </div>
      <code className="history-command" data-history-command="">
        {detail.command}
      </code>
      <div className="history-actions">
        {openPaneId !== null ? (
          <button type="button" className="history-action is-primary" data-history-goto="" onClick={() => onRevealPane(openPaneId)}>
            탭으로 이동
          </button>
        ) : (
          <button type="button" className="history-action is-primary" data-history-resume="" disabled={resumeBlocked !== null || resuming} title={resumeBlocked ?? undefined} onClick={resume}>
            재개
          </button>
        )}
        <button type="button" className="history-action" data-history-copy-command="" onClick={() => copy({ text: detail.command, label: '재개 명령을' })}>
          명령 복사
        </button>
        <button type="button" className="history-action" data-history-copy-id="" onClick={() => copy({ text: detail.id, label: '세션 ID 를' })}>
          ID 복사
        </button>
        <button type="button" className="history-action" data-history-copy-path="" onClick={() => copy({ text: detail.file, label: '기록 경로를' })}>
          기록 경로 복사
        </button>
        <button type="button" className="history-action" data-history-reveal="" onClick={reveal}>
          Finder 에서 보기
        </button>
      </div>
      {resumeBlocked !== null && openPaneId === null ? (
        <div className="history-note" data-history-blocked="">
          {resumeBlocked}
        </div>
      ) : null}
      {message !== null ? (
        <div className="history-note" data-history-message="">
          {message}
        </div>
      ) : null}
      <div className="history-detail-label">첫 프롬프트</div>
      <pre className="history-first" data-history-first="">
        {detail.firstPrompt ?? '(사람 프롬프트 없음)'}
      </pre>
      <div className="history-detail-label">최근 턴</div>
      <ol className="history-turns" data-history-turns="">
        {detail.recent.map((turn, index) => (
          <li key={index} className={`history-turn is-${turn.role}`} data-history-turn={turn.role}>
            <span className="history-turn-role">{turn.role === 'prompt' ? '사람' : '응답'}</span>
            <span className="history-turn-text">{turn.text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
