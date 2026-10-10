// 대화방 목록 메시지 — 정본은 `app/src/main/mobile/SURFACE.md` §3 「대화방 목록」(서버 `list.ts`). 여기는 그 모양의 앱 쪽 사본과 읽기.
// 서버가 값·순서를 데스크톱 파생 함수로 다 정해서 보낸다 — 앱은 제목·상태 점·정렬·그룹 규칙을 갖지 않는다(J4·L2ⓑ).
// RN 을 모른다(단위 시험 대상).

/** 데스크톱 상태 점 9값(`shared/agent-dot.ts` `AgentDot`) — 앱은 값을 읽기만 한다. */
export const DOTS = ['waiting', 'blocked', 'working', 'monitoring', 'interrupted', 'failed', 'done', 'unverifiable', 'idle'] as const
export type Dot = (typeof DOTS)[number]

export type AgentKind = 'claude' | 'codex' | 'grok'
export type WaitKind = 'question' | 'approval' | 'login' | 'other'
export type Outcome = 'completed' | 'interrupted' | 'failed'

export type Preview =
  | { kind: 'question'; text: string | null }
  | { kind: 'approval'; text: string | null }
  | { kind: 'prompt'; text: string }
  /** 에이전트 마지막 답(LIFE-581 X8). */
  | { kind: 'reply'; text: string }
  | { kind: 'tool'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'none' }

export type Channel = {
  id: string
  key: string
  status: 'live' | 'closed'
  kind: AgentKind | null
  title: string
  dot: Dot
  dotUnseen: Dot
  depth: 0 | 1
  origin: string | null
  /** 목록 행 셋째 줄용 — 부모가 다른 작업 그룹에 있거나 모를 때만. */
  spawnedBy: { title: string | null } | null
  /** 대화 머리용 — 계보에 부모가 있으면 항상(579 Q3, R1 C2). 칸이 없으면(옛 서버) null. */
  parent: { title: string | null } | null
  preview: Preview
  waiting: WaitKind | null
  model: string | null
  timeAt: number | null
  activityAt: number | null
  outcome: Outcome | null
}

export type Task = { id: string; name: string; isDefault: boolean; channels: Channel[] }
export type Repo = { id: string; name: string; tasks: Task[] }

export type ChannelList = { available: true; repos: Repo[]; waiting: string[] } | { available: false; reason: string }

export type ListMessage = { epoch: string; seq: number; at: number; changedAt: number; list: ChannelList }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  for (const item of allowed) if (item === value) return item
  return null
}

function readPreview(value: unknown): Preview | null {
  if (!isRecord(value)) return null
  const text = str(value.text)
  switch (value.kind) {
    case 'question':
      return { kind: 'question', text }
    case 'approval':
      return { kind: 'approval', text }
    case 'prompt':
      return text === null ? null : { kind: 'prompt', text }
    case 'reply':
      return text === null ? null : { kind: 'reply', text }
    case 'tool':
      return text === null ? null : { kind: 'tool', text }
    case 'error':
      return text === null ? null : { kind: 'error', text }
    case 'none':
      return { kind: 'none' }
    default:
      return null
  }
}

function readChannel(value: unknown): Channel | null {
  if (!isRecord(value)) return null
  const id = str(value.id)
  const key = str(value.key)
  const status = pick(value.status, ['live', 'closed'] as const)
  const title = str(value.title)
  const dot = pick(value.dot, DOTS)
  const dotUnseen = pick(value.dotUnseen, DOTS)
  const depth = value.depth === 1 ? 1 : value.depth === 0 ? 0 : null
  const preview = readPreview(value.preview)
  if (id === null || key === null || status === null || title === null || dot === null || dotUnseen === null || depth === null || preview === null) return null
  const spawned = value.spawnedBy
  const parent = value.parent
  return {
    id,
    key,
    status,
    kind: pick(value.kind, ['claude', 'codex', 'grok'] as const),
    title,
    dot,
    dotUnseen,
    depth,
    origin: str(value.origin),
    spawnedBy: isRecord(spawned) ? { title: str(spawned.title) } : null,
    parent: isRecord(parent) ? { title: str(parent.title) } : null,
    preview,
    waiting: pick(value.waiting, ['question', 'approval', 'login', 'other'] as const),
    model: str(value.model),
    timeAt: num(value.timeAt),
    activityAt: num(value.activityAt),
    outcome: pick(value.outcome, ['completed', 'interrupted', 'failed'] as const),
  }
}

/** 모양이 틀린 칸이 하나라도 있으면 그 목록 전체를 버린다 — 반쪽 목록을 그리지 않는다. */
function readList(value: unknown): ChannelList | null {
  if (!isRecord(value)) return null
  if (value.available === false) return { available: false, reason: str(value.reason) ?? 'unknown' }
  if (value.available !== true || !Array.isArray(value.repos) || !Array.isArray(value.waiting)) return null
  const repos: Repo[] = []
  for (const rawRepo of value.repos) {
    if (!isRecord(rawRepo) || !Array.isArray(rawRepo.tasks)) return null
    const repoId = str(rawRepo.id)
    const repoName = str(rawRepo.name)
    if (repoId === null || repoName === null) return null
    const tasks: Task[] = []
    for (const rawTask of rawRepo.tasks) {
      if (!isRecord(rawTask) || !Array.isArray(rawTask.channels)) return null
      const taskId = str(rawTask.id)
      const taskName = str(rawTask.name)
      if (taskId === null || taskName === null) return null
      const channels: Channel[] = []
      for (const rawChannel of rawTask.channels) {
        const channel = readChannel(rawChannel)
        if (channel === null) return null
        channels.push(channel)
      }
      tasks.push({ id: taskId, name: taskName, isDefault: rawTask.isDefault === true, channels })
    }
    repos.push({ id: repoId, name: repoName, tasks })
  }
  const waiting = value.waiting.filter((item): item is string => typeof item === 'string')
  return { available: true, repos, waiting }
}

/** 서버 `list` 메시지(이미 JSON 으로 읽은 값) → 목록. 모양이 틀리면 null. */
export function parseListMessage(value: Record<string, unknown>): ListMessage | null {
  const epoch = str(value.epoch)
  const seq = num(value.seq)
  const at = num(value.at)
  const changedAt = num(value.changedAt)
  const list = readList(value.list)
  if (epoch === null || seq === null || at === null || list === null) return null
  return { epoch, seq, at, changedAt: changedAt ?? at, list }
}

export function allChannels(list: ChannelList): Channel[] {
  return list.available ? list.repos.flatMap((repo) => repo.tasks.flatMap((task) => task.channels)) : []
}

/** 채널과 그 소속(대화 자리 화면 머리 `레포 › 작업`). 없으면 null — 목록에서 사라졌다. */
export function locateChannel(list: ChannelList, id: string): { channel: Channel; repo: Repo; task: Task } | null {
  if (!list.available) return null
  for (const repo of list.repos) for (const task of repo.tasks) for (const channel of task.channels) if (channel.id === id) return { channel, repo, task }
  return null
}
