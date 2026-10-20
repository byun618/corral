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

/**
 * 이미 이 작업에 만든 worktree 에 합류했나(R1-A) — main 이 `already_linked` 로 worktree · 에이전트 · 프롬프트를 `skipped` 로 돌려준다.
 * 성공이 아니다: 새로 만든 것도, 에이전트를 띄운 것도, 프롬프트를 넣은 것도 없다. 화면은 「이미 있음 — 열기」 로 그린다.
 */
export function alreadyLinked(result: StartWorkResult | null): boolean {
  return result !== null && result.refused === null && result.stages.worktree.status === 'skipped' && result.stages.worktree.code === 'already_linked'
}

const SKIPPED_NOTE = '이미 있는 worktree 라 하지 않았습니다.'
const QUEUED_NOTE = '줄에 넣음 — 에이전트가 받았는지는 아직 모릅니다.'

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
  if (result !== null) {
    const joined = alreadyLinked(result)
    return names.map((name) => {
      const entry = result.stages[name]
      const fallback = entry.status === 'queued' ? QUEUED_NOTE : joined && entry.status === 'skipped' ? SKIPPED_NOTE : null
      return { name, label: joined && name === 'worktree' ? '이미 있음' : labels[name], status: entry.status, note: entry.message ?? fallback }
    })
  }
  if (!running) return names.map((name) => ({ name, label: labels[name], status: 'pending', note: null }))
  return names.map((name, index) => {
    if (name === 'worktree') return { name, label: labels[name], status: worktreeSeen ? 'completed' : 'running', note: null }
    return { name, label: labels[name], status: worktreeSeen && index === 1 ? 'running' : 'pending', note: null }
  })
}

/** 결과 뒤 줄 행동 — 실패한 단계에서 멈추고 복구 길을 남긴다(C6). 합류(이미 있음)도 열기 · 다시 띄우기. */
export type FailureAction = { kind: 'rename' } | { kind: 'relaunch' } | { kind: 'open' }

export function failureActions(result: StartWorkResult | null): FailureAction[] {
  if (result === null || result.refused !== null) return []
  const { worktree, agent, prompt } = result.stages
  const atPath = result.worktreePath !== null
  if (alreadyLinked(result)) return atPath ? [{ kind: 'open' }, { kind: 'relaunch' }] : []
  // 미확정인데 그 자리에 worktree 가 보이면(R1-B) 이름을 바꾸라고 하지 않는다 — 있는 것을 연다.
  if (worktree.status === 'failed' || worktree.status === 'unknown') return atPath ? [{ kind: 'open' }, { kind: 'relaunch' }] : [{ kind: 'rename' }]
  if (agent.status === 'failed' || agent.status === 'unknown') return atPath ? [{ kind: 'relaunch' }, { kind: 'open' }] : []
  if (prompt.status === 'failed' || prompt.status === 'unknown') return atPath ? [{ kind: 'open' }] : []
  // 링크 저장 실패(R2-B) — 만든 것은 다 됐지만 작업에 안 붙었다. 성공으로 그리지 않고 열기만 남긴다(다음 상태 갱신이 다시 붙인다).
  if (!result.linkSaved && atPath) return [{ kind: 'open' }]
  return []
}

/** 끝까지 갔나 — worktree 를 이번에 만들었고(합류 아님) 링크도 저장했고(R2-B) 실패·미확정 단계가 없다. 「줄에 넣음」 은 실패가 아니다. */
export function startSucceeded(result: StartWorkResult | null): boolean {
  if (result === null || result.refused !== null || result.stages.worktree.status !== 'completed' || !result.linkSaved) return false
  return Object.values(result.stages).every((entry) => entry.status === 'completed' || entry.status === 'skipped' || entry.status === 'queued')
}

/**
 * 「하나 더 시작」 의 기본 이름이 있는 worktree 와 겹치지 않게(R1-A) — 등록된 레포의 브랜치 · 폴더 이름과 겹치면 `-2`, `-3` … 을 붙인다.
 * git 브랜치 규칙을 깨지 않는 접미만 쓴다.
 */
export function uniqueStartName({ base, repos }: { base: string; repos: RepoRow[] }): string {
  const taken = new Set(repos.flatMap((repo) => repo.worktrees.flatMap((row) => [row.branch?.replace(/^refs\/heads\//, '') ?? '', row.path.split('/').pop() ?? ''])))
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  return `${base}-${Date.now()}`
}

/** 입력 지문 — 바뀌면 새 시도(새 id), 같으면 같은 id 로 다시 보낸다(연타·재시도). */
export function startSignature(input: { repoRoot: string; name: string; agent: StartAgent; model: string; effort: string; submit: boolean; prompt: string }): string {
  return JSON.stringify([input.repoRoot, input.name, input.agent, input.model, input.effort, input.submit, input.prompt])
}

/**
 * 초안(또는 보내기)이 들어가지 못한 결과인가(R2-I) — 그때 모달이 「프롬프트 복사」 출구를 준다(다시 넣기는 하지 않는다 — 재량).
 * 빈 터미널 · 거절 · 프롬프트 완료/줄에 넣음은 아니다.
 */
export function promptUndelivered({ result, agent }: { result: StartWorkResult | null; agent: StartAgent }): boolean {
  if (result === null || result.refused !== null || agent === 'shell') return false
  const status = result.stages.prompt.status
  return status !== 'completed' && status !== 'queued'
}
