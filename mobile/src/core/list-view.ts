// 목록 → 화면 줄 (LIFE-580 B1–B9 · 디자인 Q1·Q2·Q3·Q6·Q11). 순수 함수 — 단위 시험 대상(L5ⓖ).
//
// 순서·그룹·상태 점은 서버 값을 그대로 쓴다 — 여기서 정렬하지 않는다(J4). 여기가 하는 일은 폰 표시 규칙뿐이다:
//   · 점 고르기: 폰 장부가 안 읽음이면 `dotUnseen`, 아니면 `dot`(데스크톱이 자기 장부로 고르는 것과 같은 두 값)
//   · 「나를 기다리는 것」: 서버 `waiting` 순서 그대로 위로 올리고, 제자리엔 자국 행. 4개 이상이면 3 + `N개 더 보기`
//   · 작업 접힘(기본 규칙 + 기억) · 접힌 머리의 점 묶음(4개 넘으면 +N) · 안 읽음 점
//   · 둘째 줄 접두어·글(디자인 §2 ChannelRow) · 셋째 줄(출신·`레포 › 작업`·띄운 세션)
//   · 하위 워크트리 묶음 머리(LIFE-588 D1·D4) — 서버 `groups` 순서·글 그대로. 머리 아래 행은 `↳ 출신` 을 빼고, 위 섹션은 `레포 › 작업 › 하위`
import type { Channel, ChannelList, Dot, Group, Task, WaitKind } from './list'
import type { ListFailure } from './list-store'

export const WAITING_SHOWN = 3
export const COLLAPSED_DOTS = 4

export type Tone = 'question' | 'alert' | 'done' | 'working' | 'muted' | 'dim'

/** 상태 이름(대화 머리·미리보기 없을 때) — 디자인 §2 StatusGlyph 행 이름. */
export function statusLabel(input: { dot: Dot; waiting: WaitKind | null; closed: boolean }): string {
  if (input.closed) return '닫힘'
  switch (input.dot) {
    case 'waiting':
      return input.waiting === 'approval' ? '권한 대기' : '질문 대기'
    case 'blocked':
      return input.waiting === 'login' ? '로그인 대기' : '대기 중'
    case 'working':
      return '작업 중'
    case 'monitoring':
      return '지켜보는 중'
    case 'interrupted':
      return '중단됨'
    case 'failed':
      return '실패'
    case 'done':
      return '완료'
    case 'unverifiable':
      return '확인 불가'
    case 'idle':
      return '한가'
  }
}

export function statusTone(input: { dot: Dot; closed: boolean }): Tone {
  if (input.closed) return 'muted'
  switch (input.dot) {
    case 'waiting':
      return 'question'
    case 'blocked':
    case 'interrupted':
    case 'failed':
      return 'alert'
    case 'working':
    case 'monitoring':
      return 'working'
    case 'done':
      return 'done'
    case 'unverifiable':
    case 'idle':
      return 'muted'
  }
}

/** 둘째 줄 접두어 — 상태가 말할 것이 있으면 상태, 아니면 내 지시면 `나`. */
function prefixOf(input: { channel: Channel; dot: Dot }): { text: string; tone: Tone } | null {
  const { channel, dot } = input
  if (channel.status === 'closed') return null
  switch (dot) {
    case 'waiting':
      return { text: channel.waiting === 'approval' ? '맥에서 승인' : '질문', tone: 'question' }
    case 'blocked':
      return { text: channel.waiting === 'login' ? '로그인 대기' : '대기 중', tone: 'alert' }
    case 'failed':
      return { text: '실패', tone: 'alert' }
    case 'interrupted':
      return { text: '중단됨', tone: 'alert' }
    case 'done':
      return { text: '완료', tone: 'done' }
    case 'monitoring':
      return { text: '백그라운드', tone: 'working' }
    case 'unverifiable':
      return { text: '확인 불가', tone: 'muted' }
    case 'working':
    case 'idle':
      return channel.preview.kind === 'prompt' ? { text: '나', tone: 'dim' } : null
  }
}

/** 미리보기 글. `fallback` = 재료가 없어 상태 이름·대체 문구로 채웠다 — 접두어가 있는 행은 이 글을 쓰지 않는다(LIFE-587). */
function previewText(input: { channel: Channel; dot: Dot }): { text: string; mono: boolean; fallback: boolean } {
  const { channel, dot } = input
  if (channel.status === 'closed') return { text: '닫힌 세션', mono: false, fallback: false }
  const preview = channel.preview
  switch (preview.kind) {
    case 'question':
      return preview.text === null ? { text: '질문 대기', mono: false, fallback: true } : { text: preview.text, mono: false, fallback: false }
    case 'approval':
      return preview.text === null ? { text: '승인 대기', mono: false, fallback: true } : { text: preview.text, mono: true, fallback: false }
    case 'tool':
      return { text: preview.text, mono: true, fallback: false }
    case 'prompt':
    case 'reply':
    case 'error':
      return { text: preview.text, mono: false, fallback: false }
    case 'none':
      return { text: statusLabel({ dot, waiting: channel.waiting, closed: false }), mono: false, fallback: true }
  }
}

/** 목록 실패 안내(R1-A4) — 받은 목록이 없을 때는 이것만, 있을 때는 「오래된 값」 띠의 둘째 줄. */
export function failureText(failure: ListFailure): { title: string; body: string } {
  switch (failure.reason) {
    case 'invalid':
      return { title: '목록 형식이 맞지 않습니다', body: '맥의 corral 이 보낸 대화방 목록을 이 앱이 읽지 못했습니다. 오래된 쪽(앱 또는 맥 corral)을 업데이트해 주세요.' }
    case 'rejected':
      return { title: '맥이 목록을 보내지 않습니다', body: '맥의 corral 이 대화방 목록을 모르는 버전입니다. 맥의 corral 을 업데이트해 주세요.' }
    case 'timeout':
      return { title: '목록 응답이 없습니다', body: '맥에 연결됐지만 목록이 오지 않았습니다. 당겨서 다시 받아 주세요.' }
  }
}

/** 대화 머리 셋째 줄(J3 · 579 Q3) — 모델 · `↳ 출신` · 「띄운 세션」(부모가 있으면 항상, R1 C2). */
/**
 * 대화 자리 머리의 표시 상태 하나(R3-A3) — 아바타 배지·별도 점·상태 글이 **이 값 하나**를 같이 쓴다. 연결이 끊겼거나 목록이 실패해
 * 받아 둔 값이 최신이 아니면(`unknown`) 받아 둔 점을 어디에도 보이지 않고 확인 불가로 그린다.
 */
export function headerStatus(input: { channel: Channel; unknown: boolean }): { dot: Dot; label: string; tone: Tone } {
  if (input.unknown) return { dot: 'unverifiable', label: '확인 불가', tone: 'muted' }
  const closed = input.channel.status === 'closed'
  const dot = input.channel.dot
  return { dot, label: statusLabel({ dot, waiting: input.channel.waiting, closed }), tone: statusTone({ dot, closed }) }
}

export function headerMeta(channel: Channel): string | null {
  const parts = [channel.model, channel.origin === null ? null : `↳ ${channel.origin}`, channel.parent === null ? null : `띄운 세션: ${channel.parent.title ?? '알 수 없음'}`]
  return joinMeta(parts)
}

export function clockLabel(at: number | null): string {
  if (at === null) return ''
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export type ChannelRowView = {
  kind: 'channel'
  channel: Channel
  dot: Dot
  closed: boolean
  unread: boolean
  flash: boolean
  worker: boolean
  prefix: { text: string; tone: Tone } | null
  /** 둘째 줄 글. 접두어가 이미 상태를 말했고 재료가 없으면 `''`(글 없음) — 「대기 중 대기 중」 같은 겹침을 막는다(LIFE-587). */
  text: string
  mono: boolean
  time: string
  /** 셋째 줄(없으면 null) — 위 섹션: `레포 › 작업`(› 하위 또는 +출신) · 그룹 안: `↳ 출신`(하위 머리 아래면 뺌) · 띄운 세션. */
  meta: string | null
}

/** 자국 행 — 기다리는 채널의 원래 자리(디자인 Q1 채택안). */
export type GhostRowView = { kind: 'ghost'; channel: Channel; worker: boolean }

/** 하위 워크트리 묶음 머리(LIFE-588 D1) — 접지 않는다. `label` = 서버 머리 꼴(detached 라벨 포함). */
export type GroupRowView = { kind: 'group'; id: string; label: string }

export type TaskView = {
  id: string
  name: string
  /** 작업 머리 글 — 서버 `label`(detached 면 `<제목> · Detached HEAD @ <7자>`), 없으면 `name`. */
  label: string
  isDefault: boolean
  collapsed: boolean
  unread: boolean
  /** 접힌 작업은 하위 머리째 그리지 않는다(머리 접기는 작업 단위뿐 — 579 Q2). */
  rows: (ChannelRowView | GhostRowView | GroupRowView)[]
  /** 열린 세션 전부의 표시 점 — 기본 접힘 규칙의 입력. */
  liveDots: Dot[]
  /** 접힌 머리 요약 — 열린 세션의 점(앞 4개) + 넘친 수 + 개수. */
  dots: Dot[]
  extraDots: number
  count: number
}

export type ListView = {
  waiting: ChannelRowView[]
  waitingTotal: number
  /** 접어 둔 기다림 수(`N개 더 보기`). 펼쳤거나 3개 이하면 0. */
  waitingMore: number
  /** 기다림 0 일 때 한 줄 요약. */
  noWaitingSummary: string | null
  repos: { id: string; name: string; tasks: TaskView[] }[]
  /** 열린 AI 세션이 하나도 없다(B9) — 「아직 못 받음」 과 다르다. */
  empty: boolean
}

export type ViewInput = {
  list: Extract<ChannelList, { available: true }>
  isUnread: (channel: Channel) => boolean
  isCollapsed: (taskId: string, dots: readonly Dot[]) => boolean
  flashUntil: Readonly<Record<string, number>>
  now: number
  waitingExpanded: boolean
}

function shownDot(input: { channel: Channel; unread: boolean }): Dot {
  return input.unread ? input.channel.dotUnseen : input.channel.dot
}

function spawnedText(channel: Channel): string | null {
  if (channel.spawnedBy === null) return null
  return `띄운 세션: ${channel.spawnedBy.title ?? '알 수 없음'}`
}

function joinMeta(parts: (string | null)[]): string | null {
  const kept = parts.filter((part): part is string => part !== null && part !== '')
  return kept.length === 0 ? null : kept.join(' · ')
}

/**
 * 그릴 묶음(LIFE-588 R1-A1) — 서버 계약(SURFACE §3)의 불변식이 깨진 작업은 **작업 전체를 평탄 보기**로 그린다(빈 Map):
 * ① 채널의 `group` 은 그 작업 `groups` 에 있는 id ② 같은 `group` 채널은 이어진 한 덩어리 ③ 묶음 없는 행(루트 쪽)은 맨 앞 덩어리에만.
 * 머리 중복만 지우면 행이 남의 머리 아래 붙는다 — 그래서 부분 보정하지 않는다.
 */
function groupsOf(task: Task): Map<string, Group> {
  const groups = new Map((task.groups ?? []).map((group) => [group.id, group]))
  const seen = new Set<string | null>()
  let previous: string | null | undefined = undefined
  for (const channel of task.channels) {
    const id = channel.group ?? null
    if (id !== null && !groups.has(id)) return new Map()
    if (id === previous) continue
    if (seen.has(id) || (id === null && previous !== undefined)) return new Map()
    seen.add(id)
    previous = id
  }
  return groups
}

export function buildListView(input: ViewInput): ListView {
  const { list, now } = input
  const waitingIds = new Set(list.waiting)
  const rowOf = (channel: Channel, place: { crumb: string | null; group: Group | null }): ChannelRowView => {
    const unread = input.isUnread(channel)
    const dot = shownDot({ channel, unread })
    const flash = (input.flashUntil[channel.id] ?? 0) > now
    const preview = previewText({ channel, dot })
    const prefix = prefixOf({ channel, dot })
    // D4 — 하위 머리가 출신을 이미 말한다(그룹 안) · 위 섹션은 crumb 에 하위가 붙는다.
    const origin = channel.origin === null || place.group !== null ? null : `↳ ${channel.origin}`
    return {
      kind: 'channel',
      channel,
      dot,
      closed: channel.status === 'closed',
      unread,
      flash,
      worker: place.crumb === null && channel.depth === 1,
      prefix,
      text: preview.fallback && prefix !== null ? '' : preview.text,
      mono: preview.mono,
      time: flash ? '방금' : clockLabel(channel.timeAt),
      meta: place.crumb === null ? joinMeta([origin, spawnedText(channel)]) : joinMeta([place.crumb, origin, spawnedText(channel)]),
    }
  }

  const waitingRows = new Map<string, ChannelRowView>()
  let working = 0
  const repos = list.repos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    tasks: repo.tasks.map((task): TaskView => {
      const live = task.channels.filter((channel) => channel.status === 'live')
      const dots = live.map((channel) => shownDot({ channel, unread: input.isUnread(channel) }))
      working += dots.filter((dot) => dot === 'working' || dot === 'monitoring').length
      const groups = groupsOf(task)
      const rows: TaskView['rows'] = []
      let current: Group | null = null
      for (const channel of task.channels) {
        // 묶음이 없거나 불변식이 깨진 작업은 평탄 행 + `↳ 출신`(옛 꼴).
        const group = groups.get(channel.group ?? '') ?? null
        if (group !== null && group !== current) rows.push({ kind: 'group', id: group.id, label: group.label })
        current = group
        if (waitingIds.has(channel.id)) {
          const crumb = group === null ? `${repo.name} › ${task.name}` : `${repo.name} › ${task.name} › ${group.name}`
          waitingRows.set(channel.id, rowOf(channel, { crumb, group }))
          rows.push({ kind: 'ghost', channel, worker: channel.depth === 1 })
          continue
        }
        rows.push(rowOf(channel, { crumb: null, group }))
      }
      return {
        id: task.id,
        name: task.name,
        label: task.label ?? task.name,
        isDefault: task.isDefault,
        collapsed: input.isCollapsed(task.id, dots),
        unread: live.some((channel) => input.isUnread(channel)),
        rows,
        liveDots: dots,
        dots: dots.slice(0, COLLAPSED_DOTS),
        extraDots: Math.max(0, dots.length - COLLAPSED_DOTS),
        count: live.length,
      }
    }),
  }))
  const waiting = list.waiting.map((id) => waitingRows.get(id)).filter((row): row is ChannelRowView => row !== undefined)
  const shown = input.waitingExpanded || waiting.length <= WAITING_SHOWN ? waiting : waiting.slice(0, WAITING_SHOWN)
  const empty = repos.every((repo) => repo.tasks.length === 0)
  return {
    waiting: shown,
    waitingTotal: waiting.length,
    waitingMore: waiting.length - shown.length,
    noWaitingSummary: waiting.length > 0 || empty ? null : working > 0 ? `기다리는 세션 없음 · 작업 중 ${working}` : '기다리는 세션 없음',
    repos,
    empty,
  }
}
