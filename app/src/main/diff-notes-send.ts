// diff 메모 보내기의 main 쪽 (LIFE-832 D6) — 폰 지시 허브(`mobile/input.ts` `InputHub`)의 **데스크톱 전용 인스턴스**로 넣는다.
//
// · 보장은 폰 경로와 같다 — 접수 때 대상 묶기 · 준비 관문(턴 안에 끼어들지 않음) · 맥 입력 울타리 · 초안·agent view 거절 · 기록 매칭 1건 = 들어감.
//   허브 코드는 건드리지 않고 인스턴스만 하나 더 둔다. 그래서 모바일 켬·끔(`stop()`)·페어링(`deviceValid`)과 무관하다 — 이 인스턴스는 `stop()` 을 부르지 않고
//   기기 확인 함수도 주지 않는다. 자기 쓰기 사슬은 인스턴스별이라 폰과 같은 pane 에 거의 동시에 쓰면 뒤 것이 `mac_input` 으로 실패한다(쓰지 않는 쪽 — A10).
// · `corral:termInput`(raw PTY)·CLI `terminal prompt`(AgentRecord 필요) 경로는 쓰지 않는다(A3·A6).
// · 접수 전에 main 이 다시 본다: 요청 모양 · 본문 상한(65536 바이트) · 본문이 이미 정리된 글인가(확인 단계 글 = 넣는 글) ·
//   pane 이 **지금 상태에서** 그 worktree 자기 workspace 의 고를 수 있는 에이전트 pane 인가(렌더러 pane id 를 그대로 믿지 않는다).
// · electron 을 모른다 — 상태·push·로그를 주입받는다(시험이 가짜 백엔드로 돈다).
import { normalizeBody, sessionRecordPaths } from '../runtime/terminal/agent.js'
import { bodyTooLarge, checkNoteTarget, isRequestId, readDiffNotesState, type DiffNotesSendResult, type DiffNotesState } from '../shared/diff-notes.js'
import { cleanBody } from '../shared/input-body.js'
import type { WorktreeRow } from '../shared/types.js'
import { InputHub, type InputBackend, type InputHubDeps } from './mobile/input.js'
import type { ListInput } from './mobile/list.js'
import { chatFileOf } from './mobile/chat.js'
import { resolveTranscriptUnique } from './transcript.js'

/** 허브 안 기기 이름 — 데스크톱 요청은 전부 이 이름 하나로 묶는다(id 는 렌더러가 만든 요청 id). */
export const DESKTOP_DEVICE = 'desktop'

/** 폰 허브와 같은 기록 찾기 — 대화와 같은 파일이되 유일한 후보만, 아직 없으면 그 세션이 쓸 경로(Claude·Grok). */
export const desktopFileDeps: Pick<InputHubDeps, 'resolveFile' | 'expectedFile'> = {
  resolveFile: ({ session, agent }) => {
    const resolved = resolveTranscriptUnique(session)
    return resolved.kind === 'found' ? { kind: 'found', file: chatFileOf({ agent, transcript: resolved.file }), continuedAs: resolved.continuedAs } : resolved
  },
  expectedFile: ({ channel, cwd }) => {
    const { session, agent } = channel
    if (session.kind !== 'id' || agent === 'codex') return null
    return sessionRecordPaths(agent, { cwd, sessionId: session.id, t0Ms: 0, nowMs: 0 })[0] ?? null
  },
}

export type DiffNotesSenderDeps = {
  /** 목록 재료 — 폰과 같은 마지막 상태. 아직 없으면 null. */
  read: () => ListInput | null
  backend: () => InputBackend | null
  push: (state: DiffNotesState) => void
  log: (tag: string, fields?: Record<string, unknown>) => void
  /** 시험이 기록 찾기·시간을 꽂는다. 없으면 `desktopFileDeps`·실제 시간. */
  hub?: Partial<Omit<InputHubDeps, 'read' | 'backend' | 'log'>>
}

export class DiffNotesSender {
  private readonly deps: DiffNotesSenderDeps
  private readonly hub: InputHub

  constructor(deps: DiffNotesSenderDeps) {
    this.deps = deps
    // 허브 로그는 `mobile.input_*` 이름으로 낸다 — 데스크톱 인스턴스 것은 `diff_notes.*` 로 갈라 trace 에서 구별한다.
    const log = (tag: string, fields?: Record<string, unknown>): void => deps.log(tag.replace(/^mobile\./, 'diff_notes.'), fields)
    this.hub = new InputHub({
      read: deps.read,
      backend: deps.backend,
      log,
      ...desktopFileDeps,
      // 질문 답은 이 인스턴스가 하지 않는다 — 판독자가 없다.
      questionItems: () => null,
      ...deps.hub,
    })
    this.hub.attach({
      device: DESKTOP_DEVICE,
      sink: (text) => {
        const state = readWire(text)
        if (state !== null) deps.push(state)
      },
    })
  }

  /** 보내기 접수 — 거절이면 아무것도 쓰지 않는다. 받으면 결과는 `push` 로 온다(대기·보내는 중·들어감·확인 못 함·실패). */
  send(input: unknown): DiffNotesSendResult {
    const requestId = field(input, 'requestId')
    const worktree = field(input, 'worktree')
    const paneId = field(input, 'paneId')
    const text = field(input, 'text')
    if (!isRequestId(requestId) || typeof worktree !== 'string' || typeof paneId !== 'string' || typeof text !== 'string') return this.refuse('bad_input')
    if (bodyTooLarge(text)) return this.refuse('too_large')
    // 확인 단계에 보인 글이 그대로 들어가야 한다 — 허브가 정리해 바뀔 글이면 받지 않는다.
    if (cleanBody(text) !== text) return this.refuse('not_clean')
    if (normalizeBody(text).length === 0) return this.refuse('empty')
    const list = this.deps.read()
    if (list === null) return this.refuse('not_ready')
    const worktrees: WorktreeRow[] = list.state.repos.flatMap((repo) => repo.worktrees)
    const checked = checkNoteTarget({ worktrees, worktree, paneId })
    if (!checked.ok) return this.refuse(checked.reason)
    this.deps.log('diff_notes.accept', { kind: checked.kind, bytes: Buffer.byteLength(text) })
    this.hub.send({ device: DESKTOP_DEVICE, id: requestId, channel: paneId, text })
    return { ok: true }
  }

  /** 대기 중 취소 — 넣기 시작 전(`queued`)만 취소된다. 그 밖엔 지금 상태만 다시 온다. */
  cancel(input: unknown): void {
    const requestId = field(input, 'requestId')
    if (!isRequestId(requestId)) return
    this.hub.cancel({ device: DESKTOP_DEVICE, id: requestId })
  }

  private refuse(reason: Exclude<DiffNotesSendResult, { ok: true }>['reason']): DiffNotesSendResult {
    this.deps.log('diff_notes.refused', { reason })
    return { ok: false, reason }
  }
}

function field(input: unknown, name: string): unknown {
  return typeof input === 'object' && input !== null && name in input ? Reflect.get(input, name) : undefined
}

/** 허브 wire(`input.state`) → 렌더러 push. 지시가 아닌 것(답·중단)은 이 인스턴스에 없다. */
function readWire(text: string): DiffNotesState | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  return readDiffNotesState({ requestId: Reflect.get(value, 'id'), state: Reflect.get(value, 'state'), wait: Reflect.get(value, 'wait') ?? null, reason: Reflect.get(value, 'reason') ?? null })
}
