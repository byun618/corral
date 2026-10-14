// 작업 시작 모달 (LIFE-603 C1·C2·C5·C6 · design-handoff D) — 그리기만 한다. 상태는 `useStartWork`, 런타임 호출은 main.
//
// 폭 600(`--w-modal-start-work`) · 머리(제목 + 키) · 이미 작업 중 상자 · 96 라벨 표(레포 · 이름 · 에이전트 · 모델 · effort) ·
// 첫 프롬프트 미리보기(≤180) + 바로 보내기(기본 꺼짐) · 상태 옮기기(기본 꺼짐) · 진행 3단계 · 취소/시작.
// 진행 중에는 Esc · 바깥 클릭 · 취소 · 시작이 막힌다.
import { useEffect } from 'react'
import { effortOptions, modelOptions, type StartAgent } from '../../../shared/agent-options.js'
import type { RepoRow } from '../../../shared/types.js'
import { AGENT_ICON } from '../session-glyphs.js'
import type { StartWorkModel } from '../hooks/useStartWork.js'
import { failureActions, progressRows, type ProgressRow } from '../start-work-model.js'
import type { LinkedTree } from '../work-links-model.js'
import { AgentIcon } from './AgentIcon.js'

const AGENTS: { value: StartAgent; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'grok', label: 'Grok' },
  { value: 'shell', label: '빈 터미널' },
]

const STATUS_MARK: Record<ProgressRow['status'], string> = { pending: '○', running: '◌', completed: '✓', failed: '✕', skipped: '–', unknown: '?' }

export function StartWorkModal({ model, itemKey, itemTitle, repos, trees, onOpen }: {
  model: StartWorkModel
  itemKey: string
  itemTitle: string
  repos: RepoRow[]
  /** 이 작업에 이미 붙은 worktree — 급한 순. 있으면 「이미 진행 중」 상자. */
  trees: LinkedTree[]
  onOpen: (tree: LinkedTree | { repoRoot: string; path: string }) => void
}): React.JSX.Element | null {
  const { form, running, result } = model
  // Esc — 진행 중이면 막는다. 캡처 단계에서 받아 작업 페이지의 Esc 단계로 내려가지 않게 한다.
  useEffect(() => {
    if (!model.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      model.close()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [model.open, model.close])
  if (!model.open || form === null) return null

  const existing = trees[0]
  const showExisting = existing !== undefined && !model.proceed
  const shell = form.agent === 'shell'
  const worktreeSeen = form.repoRoot !== null && repos.some((repo) => repo.root === form.repoRoot && repo.worktrees.some((row) => (row.branch?.replace(/^refs\/heads\//, '') ?? '') === form.name))
  const rows = progressRows({ result, running, agent: form.agent, submit: form.submit, worktreeSeen })
  const actions = failureActions(result)
  const repoName = (root: string): string => repos.find((repo) => repo.root === root)?.name ?? root

  return (
    <div className="modal-scrim" data-modal-scrim="" onClick={() => model.close()}>
      <div className="modal modal-start-work" data-start-work="" role="dialog" aria-label="작업 시작" aria-busy={running} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2 className="modal-title">작업 시작</h2>
            <p className="modal-subtitle"><span className="start-key">{itemKey}</span> {itemTitle}</p>
          </div>
          <button type="button" className="modal-close" aria-label="닫기" disabled={running} onClick={() => model.close()}>✕</button>
        </div>
        <div className="modal-body start-body">
          {showExisting ? (
            <div className="start-existing" data-start-existing="">
              <span className="start-existing-text">이미 진행 중인 작업입니다 — <span className="start-mono">{existing.repoName} / {existing.branch}</span>{trees.length > 1 ? ` 외 ${trees.length - 1}` : ''}</span>
              <button type="button" className="issue-btn is-ghost" data-start-another="" onClick={() => model.setProceed(true)}>하나 더 시작</button>
              <button type="button" className="issue-btn is-primary" data-start-open-existing="" onClick={() => { if (model.close()) onOpen(existing) }}>기존 열기</button>
            </div>
          ) : null}

          <div className="start-grid">
            <span className="start-label">레포</span>
            <div className="start-field">
              <div className="start-segment" role="radiogroup" aria-label="레포" data-start-repo="">
                {repos.map((repo) => (
                  <button key={repo.root} type="button" role="radio" aria-checked={form.repoRoot === repo.root} className={`start-option${form.repoRoot === repo.root ? ' is-on' : ''}`} data-start-repo-option={repo.name} disabled={running} title={repo.root} onClick={() => model.update({ repoRoot: repo.root })}>{repo.name}</button>
                ))}
              </div>
              {form.repoRoot === null ? <span className="start-note" data-start-repo-note="">레포를 고르세요 — 이 스페이스를 기본으로 둔 레포가 없습니다.</span> : null}
            </div>

            <span className="start-label">이름</span>
            <div className="start-field">
              <input className="start-input" data-start-name="" value={form.name} disabled={running} spellCheck={false} onChange={(event) => model.update({ name: event.target.value })} aria-invalid={model.nameProblem !== null} />
              {model.nameProblem === null ? null : <span className="start-note is-error" data-start-name-problem="">{model.nameProblem}</span>}
            </div>

            <span className="start-label">에이전트</span>
            <div className="start-segment" role="radiogroup" aria-label="에이전트" data-start-agent="">
              {AGENTS.map((agent) => (
                <button key={agent.value} type="button" role="radio" aria-checked={form.agent === agent.value} className={`start-option${form.agent === agent.value ? ' is-on' : ''}`} data-start-agent-option={agent.value} disabled={running} onClick={() => model.update({ agent: agent.value })}>
                  {agent.value === 'shell' ? <span className="start-shell-mark" aria-hidden>$</span> : <AgentIcon kind={agent.value} glyph={AGENT_ICON[agent.value].glyph} size={13} />}
                  {agent.label}
                </button>
              ))}
            </div>

            {shell ? null : (
              <>
                <span className="start-label">모델 · effort</span>
                <div className="start-pair">
                  <select className="start-select" data-start-model="" value={form.model} disabled={running} onChange={(event) => model.update({ model: event.target.value })}>
                    {modelOptions(form.agent).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <select className="start-select" data-start-effort="" value={form.effort} disabled={running || effortOptions(form.agent).length <= 1} title={effortOptions(form.agent).length <= 1 ? '이 에이전트는 effort 선택지가 없습니다' : undefined} onChange={(event) => model.update({ effort: event.target.value })}>
                    {effortOptions(form.agent).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
              </>
            )}
          </div>

          {shell || model.prompt === null ? null : (
            <div className="start-prompt-box">
              <div className="start-prompt-head">
                <span className="start-label-inline">첫 프롬프트</span>
                <span className="start-note">작업 제목 + 본문 + 부모 · 막힘 요약</span>
                <span className="issue-detail-head-spacer" />
                <label className="start-switch" data-start-send="">
                  <input type="checkbox" role="switch" checked={form.submit} disabled={running} onChange={(event) => model.update({ submit: event.target.checked })} />
                  바로 보내기
                </label>
              </div>
              <pre className="start-prompt" data-start-prompt="">{model.prompt.text}</pre>
              {model.prompt.truncated ? <div className="start-note" data-start-prompt-truncated="">본문이 길어 잘랐습니다.</div> : null}
              <div className="start-note">{form.submit ? '에이전트가 준비되면 바로 보냅니다.' : '기본은 에이전트 입력창에 초안으로만 넣습니다 — 확인하고 Enter 를 누르면 보내집니다.'}</div>
            </div>
          )}

          <label className={`start-check${model.statusTarget?.state === 'ready' ? '' : ' is-disabled'}`} data-start-status="" title={model.statusTarget?.state === 'disabled' ? model.statusTarget.reason : undefined}>
            <input type="checkbox" checked={form.moveStatus && model.statusTarget?.state === 'ready'} disabled={running || model.statusTarget?.state !== 'ready'} onChange={(event) => model.update({ moveStatus: event.target.checked })} />
            {model.statusTarget?.state === 'ready' ? `상태를 「${model.statusTarget.label}」 로 옮기기` : `상태 옮기기 — ${model.statusTarget?.reason ?? '작업을 불러오는 중…'}`}
          </label>
          {model.move.state === 'failed' ? <div className="start-note is-error" data-start-status-failed="">상태를 옮기지 못했습니다 — {model.move.message}. worktree·에이전트는 그대로입니다.</div> : null}
          {model.move.state === 'done' ? <div className="start-note" data-start-status-done="">상태를 「{model.move.label}」 로 옮겼습니다.</div> : null}

          {running || result !== null ? (
            <div className="start-progress" data-start-progress="">
              {result?.refused ? <div className="start-note is-error" data-start-refused="">{result.refused}</div> : rows.map((row) => (
                <div key={row.name} className={`start-step is-${row.status}`} data-start-step={row.name} data-step-status={row.status}>
                  <span className="start-step-mark" aria-hidden>{STATUS_MARK[row.status]}</span>
                  <span>{row.label}</span>
                  {row.note === null ? null : <span className="start-step-note">{row.note}</span>}
                </div>
              ))}
              {result?.sourceLink?.state === 'failed' ? <div className="start-note" data-start-source-link="failed">출처에 링크를 남기지 못했습니다 — {result.sourceLink.message}</div> : null}
              {actions.length === 0 ? null : (
                <div className="start-actions" data-start-failure="">
                  {actions.map((action) => {
                    switch (action.kind) {
                      case 'rename':
                        return <span key="rename" className="start-note" data-start-action="rename">이름을 바꿔 다시 시작하세요.</span>
                      case 'relaunch':
                        return shell ? null : <button key="relaunch" type="button" className="issue-btn" data-start-action="relaunch" disabled={running} onClick={() => void model.relaunch()}>에이전트 다시 띄우기</button>
                      case 'open':
                        return <button key="open" type="button" className="issue-btn" data-start-action="open" disabled={running} onClick={() => { const path = result?.worktreePath; if (path != null && form.repoRoot !== null && model.close()) onOpen({ repoRoot: form.repoRoot, path }) }}>worktree 열기</button>
                    }
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
        <div className="modal-footer">
          <span className="start-note start-footer-note">{form.repoRoot === null ? '' : `${repoName(form.repoRoot)} 에 ${form.name}`}</span>
          <span className="issue-detail-head-spacer" />
          {result !== null && result.worktreePath !== null && actions.length === 0 ? (
            <button type="button" className="issue-btn is-primary" data-start-open="" onClick={() => { const path = result.worktreePath; if (path !== null && form.repoRoot !== null && model.close()) onOpen({ repoRoot: form.repoRoot, path }) }}>worktree 열기</button>
          ) : null}
          <button type="button" className="issue-btn" data-start-cancel="" disabled={running} onClick={() => model.close()}>{result === null ? '취소' : '닫기'}</button>
          <button type="button" className="issue-btn is-accent" data-start-submit="" disabled={!model.canStart || showExisting} onClick={() => void model.start()}>▶ 시작</button>
        </div>
      </div>
    </div>
  )
}
