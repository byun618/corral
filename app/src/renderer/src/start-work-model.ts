// 시작 모달 화면 모델 (LIFE-603 C2·C6) — 순수 함수. 런타임 호출·결과 해석은 main(`main/work/start.ts`) 이 한다.
import type { RepoRow } from '../../shared/types.js'
import type { WorkRepoDefault } from '../../shared/work.js'
import type { StartAgent } from '../../shared/agent-options.js'
import type { StartStage, StartStageName, StartWorkResult } from '../../shared/work-start.js'

/** 기본 레포 — 그 스페이스를 기본으로 둔 레포 → 활성 worktree 레포 → 없음(고르기). 등록된 레포만. */
export function defaultStartRepo({ repos, repoDefaults, connectionId, spaceKey, activeRepoRoot }: {
  repos: RepoRow[]
  repoDefaults: WorkRepoDefault[]
  connectionId: string
  spaceKey: string
  activeRepoRoot: string | null
}): string | null {
  const known = new Set(repos.map((repo) => repo.root))
  const byDefault = repoDefaults.find((entry) => entry.connectionId === connectionId && entry.spaceKey === spaceKey && known.has(entry.repoRoot))
  if (byDefault !== undefined) return byDefault.repoRoot
  if (activeRepoRoot !== null && known.has(activeRepoRoot)) return activeRepoRoot
  return null
}

export type ProgressRow = { name: StartStageName; label: string; status: StartStage['status']; note: string | null }

/** 진행 3단계 — 진행 중(결과 없음)이면 worktree 단계는 트리에 그 경로가 보이면 완료로, 나머지는 차례로 진행. */
export function progressRows({ result, running, agent, submit, worktreeSeen }: {
  result: StartWorkResult | null
  running: boolean
  agent: StartAgent
  submit: boolean
  worktreeSeen: boolean
}): ProgressRow[] {
  const shell = agent === 'shell'
  const labels: Record<StartStageName, string> = {
    worktree: 'worktree 만들기',
    agent: shell ? '터미널 열기' : '에이전트 띄우기',
    prompt: shell ? '프롬프트 없음' : submit ? '프롬프트 보내기까지' : '프롬프트 초안 넣기',
  }
  const names: StartStageName[] = shell ? ['worktree', 'agent'] : ['worktree', 'agent', 'prompt']
  if (result !== null) return names.map((name) => ({ name, label: labels[name], status: result.stages[name].status, note: result.stages[name].message }))
  if (!running) return names.map((name) => ({ name, label: labels[name], status: 'pending', note: null }))
  return names.map((name, index) => {
    if (name === 'worktree') return { name, label: labels[name], status: worktreeSeen ? 'completed' : 'running', note: null }
    return { name, label: labels[name], status: worktreeSeen && index === 1 ? 'running' : 'pending', note: null }
  })
}

/** 실패한 단계 뒤 줄 행동 — 그 단계에서 멈춘다(C6). */
export type FailureAction = { kind: 'rename' } | { kind: 'relaunch' } | { kind: 'open' }

export function failureActions(result: StartWorkResult | null): FailureAction[] {
  if (result === null || result.refused !== null) return []
  const { worktree, agent, prompt } = result.stages
  if (worktree.status === 'failed' || worktree.status === 'unknown') return [{ kind: 'rename' }]
  if (agent.status === 'failed' || agent.status === 'unknown') return result.worktreePath === null ? [] : [{ kind: 'relaunch' }, { kind: 'open' }]
  if (prompt.status === 'failed' || prompt.status === 'unknown') return result.worktreePath === null ? [] : [{ kind: 'open' }]
  return []
}

/** 끝까지 갔나 — 실패·미확정 단계가 없다. */
export function startSucceeded(result: StartWorkResult | null): boolean {
  if (result === null || result.refused !== null) return false
  return Object.values(result.stages).every((entry) => entry.status === 'completed' || entry.status === 'skipped')
}

/** 입력 지문 — 바뀌면 새 시도(새 id), 같으면 같은 id 로 다시 보낸다(연타·재시도). */
export function startSignature(input: { repoRoot: string; name: string; agent: StartAgent; model: string; effort: string; submit: boolean; prompt: string }): string {
  return JSON.stringify([input.repoRoot, input.name, input.agent, input.model, input.effort, input.submit, input.prompt])
}
