// 시작 모달 상태 (LIFE-603 C2·C5·C6·C7) — 화면은 `StartWorkModal`, 런타임 호출은 main(`window.corral.startWork`).
//
// - 한 시도 = attemptId 하나. 입력 지문(`startSignature`)이 같으면 같은 id 로 다시 보낸다(연타·재시도 → main 합류 · 런타임 replay).
//   입력이 바뀌면 새 id. 모달을 다시 열면 `startWorkStatus` 로 그 작업의 마지막 시도를 이어 받는다(진행 중이면 같은 id 로 다시 보내 합류).
// - 상태 옮기기(C5)는 기본 꺼짐. 켜면 worktree 가 생긴 뒤 상세의 쓰기(`detail.write`, T3 잠금)로 한 번 — 실패는 모달에 남기고 worktree·에이전트는 그대로.
// - 진행 중에는 닫기·Esc·바깥 클릭·시작이 막힌다(`running`).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { effortOptions, modelOptions, type StartAgent } from '../../../shared/agent-options.js'
import type { RepoRow } from '../../../shared/types.js'
import { composeStartPrompt, defaultStartName, newAttemptId, startNameProblem, startStatusTarget, type StartStatusTarget, type StartWorkInput, type StartWorkResult } from '../../../shared/work-start.js'
import type { WorkRepoDefault } from '../../../shared/work.js'
import { defaultStartRepo, startSignature, startSucceeded } from '../start-work-model.js'
import type { TaskDetailModel } from './useTaskDetail.js'

export type StartMode = 'first' | 'another'

export type StartForm = {
  repoRoot: string | null
  name: string
  agent: StartAgent
  model: string
  effort: string
  submit: boolean
  moveStatus: boolean
}

export type StatusMove = { state: 'idle' } | { state: 'writing' } | { state: 'done'; label: string } | { state: 'failed'; message: string }

const NO_MOVE: StatusMove = { state: 'idle' }

function uuid(): string {
  return crypto.randomUUID()
}

export function useStartWork({ detail, repos, repoDefaults, activeRepoRoot, sourceName }: {
  detail: TaskDetailModel
  repos: RepoRow[]
  repoDefaults: WorkRepoDefault[]
  activeRepoRoot: string | null
  sourceName: string
}) {
  const { item, target } = detail
  const [mode, setMode] = useState<StartMode | null>(null)
  /** 이미 작업 중 상자를 지나 「하나 더 시작」 을 골랐나. */
  const [proceed, setProceed] = useState(false)
  const [form, setForm] = useState<StartForm | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<StartWorkResult | null>(null)
  const [move, setMove] = useState<StatusMove>(NO_MOVE)
  const attempt = useRef<{ id: string; signature: string } | null>(null)
  /** 모달 회차 — 닫았다 연 뒤 앞 회차 응답이 새 화면을 덮지 않게. */
  const round = useRef(0)

  const prompt = useMemo(() => (item === null ? null : composeStartPrompt({
    item, parent: detail.parents[0] ?? null, blockers: item.openBlockers, sourceName,
  })), [item, detail.parents, sourceName])

  const statusTarget = useMemo((): StartStatusTarget | null => {
    if (item === null) return null
    const mode = detail.caps?.transition.mode ?? 'any'
    if (mode === 'allowed' && detail.transitions?.state !== 'ready') return { state: 'disabled', reason: detail.transitions?.state === 'error' ? '갈 수 있는 상태를 받지 못했습니다.' : '갈 수 있는 상태를 받는 중…' }
    const allowed = mode === 'allowed' && detail.transitions?.state === 'ready' ? detail.transitions.value : null
    const found = startStatusTarget({ category: item.category, statuses: detail.statuses ?? [], allowed })
    if (found.state === 'ready' && detail.blocked !== null) return { state: 'disabled', reason: detail.blocked }
    return found
  }, [item, detail.caps, detail.transitions, detail.statuses, detail.blocked])

  const begin = useCallback((next: StartMode) => {
    if (item === null || target === null) return
    round.current += 1
    const here = round.current
    const repoRoot = defaultStartRepo({ repos, repoDefaults, connectionId: target.connectionId, spaceKey: item.spaceKey, activeRepoRoot })
    setMode(next)
    // 링크가 있는 작업이면 어느 버튼으로 열든 「이미 진행 중」 상자부터(C1) — 「하나 더 시작」 은 그 상자에서 고른다.
    setProceed(false)
    setForm({ repoRoot, name: defaultStartName({ key: item.key, title: item.title }), agent: 'claude', model: '', effort: '', submit: false, moveStatus: false })
    setResult(null)
    setMove(NO_MOVE)
    setRunning(false)
    attempt.current = null
    if ((detail.caps?.transition.mode ?? 'any') === 'allowed') void detail.loadTransitions()
    // 앞 시도 이어 받기 — 진행 중이면 같은 입력·같은 id 로 다시 보내 합류한다(모달을 닫았다 다시 연 경우).
    void window.corral.startWorkStatus({ connectionId: target.connectionId, itemId: item.id }).then((view) => {
      if (view === null || here !== round.current) return
      if (view.result !== null && startSucceeded(view.result)) return
      setProceed(true)
      setForm((current) => (current === null ? current : { ...current, repoRoot: view.repoRoot, name: view.name, agent: view.agent, model: view.model, effort: view.effort, submit: view.submit }))
      if (view.result !== null) {
        setResult(view.result)
        return
      }
      attempt.current = { id: view.attemptId, signature: '' }
      setRunning(true)
      void join({ attemptId: view.attemptId, here })
    })
  }, [item, target, repos, repoDefaults, activeRepoRoot, detail])

  /** 진행 중 시도에 합류 — main 은 같은 id 를 입력 없이 받지 않으므로 시도 상태를 다시 묻는다. */
  const join = async ({ attemptId, here }: { attemptId: string; here: number }): Promise<void> => {
    if (item === null || target === null) return
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (here !== round.current) return
      const view = await window.corral.startWorkStatus({ connectionId: target.connectionId, itemId: item.id })
      if (here !== round.current) return
      if (view === null || view.attemptId !== attemptId) { setRunning(false); return }
      if (view.result !== null) { setResult(view.result); setRunning(false); return }
    }
  }

  const nameProblem = form === null ? null : startNameProblem(form.name)
  const canStart = form !== null && item !== null && target !== null && !running && form.repoRoot !== null && nameProblem === null && (form.agent === 'shell' || prompt !== null)

  const writeStatus = async (statusKey: string, label: string): Promise<void> => {
    if (item === null) return
    setMove({ state: 'writing' })
    const outcome = await detail.write({
      call: { op: 'changeStatus', itemId: item.id, statusKey, ifVersion: detail.versionOf(detail.base), resolution: null },
      optimistic: null,
      label: null,
      undo: null,
      quiet: true,
    })
    const final = outcome.kind === 'late' ? await outcome.settled : outcome
    setMove(final.kind === 'ok' ? { state: 'done', label } : { state: 'failed', message: final.kind === 'failed' ? final.error.message : final.kind === 'busy' ? (detail.blocked ?? '앞 변경을 출처가 확인하는 중입니다.') : '작업 화면이 바뀌어 상태를 옮기지 않았습니다.' })
  }

  const start = async (): Promise<void> => {
    if (!canStart || form === null || form.repoRoot === null || item === null || target === null || detail.connection === null) return
    const text = form.agent === 'shell' ? '' : prompt?.text ?? ''
    const signature = startSignature({ repoRoot: form.repoRoot, name: form.name, agent: form.agent, model: form.model, effort: form.effort, submit: form.submit, prompt: text })
    // 결과를 받은 뒤 다시 누르면 새 시도다 — 같은 id 면 main 이 끝난 기록을 그대로 돌려준다.
    const id = attempt.current !== null && attempt.current.signature === signature && result === null ? attempt.current.id : newAttemptId({ now: Date.now(), uuid: uuid() })
    attempt.current = { id, signature }
    const here = round.current
    const input: StartWorkInput = {
      attemptId: id, connectionId: target.connectionId, sourceId: detail.connection.sourceId, itemId: item.id, itemKey: item.key,
      repoRoot: form.repoRoot, name: form.name, agent: form.agent, model: form.model, effort: form.effort, prompt: text, submit: form.agent === 'shell' ? false : form.submit,
    }
    const moveTo = form.moveStatus && statusTarget?.state === 'ready' ? statusTarget : null
    setRunning(true)
    setResult(null)
    setMove(NO_MOVE)
    const outcome = await window.corral.startWork(input)
    if (here !== round.current) return
    setRunning(false)
    setResult(outcome)
    if (outcome !== null && outcome.stages.worktree.status === 'completed' && moveTo !== null) await writeStatus(moveTo.statusKey, moveTo.label)
  }

  const relaunch = async (): Promise<void> => {
    if (form === null || form.agent === 'shell' || result?.worktreePath == null || item === null || target === null || running) return
    const here = round.current
    setRunning(true)
    const outcome = await window.corral.relaunchWorkAgent({ attemptId: newAttemptId({ now: Date.now(), uuid: uuid() }), connectionId: target.connectionId, itemId: item.id, path: result.worktreePath, agent: form.agent, model: form.model, effort: form.effort })
    if (here !== round.current) return
    setRunning(false)
    if (outcome !== null) setResult(outcome)
  }

  const close = useCallback((): boolean => {
    if (running) return false
    round.current += 1
    setMode(null)
    setForm(null)
    return true
  }, [running])

  // 다른 작업으로 바뀌면 닫는다(진행 중이어도 — main 쪽 시도는 계속되고 다시 열면 이어 받는다).
  const uid = detail.uid
  useEffect(() => {
    round.current += 1
    setMode(null)
    setForm(null)
    setRunning(false)
  }, [uid])

  const update = (patch: Partial<StartForm>): void => {
    setForm((current) => {
      if (current === null) return current
      const next = { ...current, ...patch }
      // 에이전트가 바뀌면 그 목록에 없는 모델·effort 는 기본값으로.
      if (patch.agent !== undefined) {
        if (!modelOptions(next.agent).some((option) => option.value === next.model)) next.model = ''
        if (!effortOptions(next.agent).some((option) => option.value === next.effort)) next.effort = ''
      }
      return next
    })
  }

  return {
    open: mode !== null && form !== null, mode, proceed, setProceed, form, update, prompt, statusTarget, nameProblem, canStart,
    running, result, move, begin, start, relaunch, close,
  }
}

export type StartWorkModel = ReturnType<typeof useStartWork>
