// 폰 → 맥 쓰기 (LIFE-582 P1~P9) — 지시 보내기 · 큐 취소 · 상태 조회 · 질문 답 · 중단. electron·소켓을 모른다(시험이 가짜 백엔드로 돈다).
//
// - **메시지 id 당 많아야 한 번**(P2): (기기, id) 로 기억한다. 같은 id 가 다시 오면(재연결 뒤 재전송·조회) 다시 넣지 않고 지금 상태만 돌려준다.
//   기억 상한(`INPUT_IDS_MAX`)에서 밀린 id 도 **표지는 남긴다** — 다시 와도 넣지 않고 `unknown`(`expired`)(R1-A6).
//   같은 글이라도 새 id 면 새 지시다 — `prompt_already_delivered`(기록 전체 같은 글 거절)는 쓰지 않는다.
// - **「들어감」 = 이 제출 직전 커서 뒤 기록 매칭 정확히 1건**(`countSubmissions` — CLI `terminal prompt` 와 같은 대조). 0건·2건 이상·커서 무효는
//   `unconfirmed`(확인하지 못했습니다) — 들어감으로 올리지 않는다(P6ⓓ). 다시 넣지도 않는다. 커서는 **파일 꼬리**다(dev·ino · 크기 + 끝 64 KiB 지문, R2-A7) —
//   지시마다 기록 전체를 동기로 읽지 않는다(C1, 45 MB 기록에서 루프 지연 p99 230 ms 실측).
// - **접수 때 대상을 묶는다**(R1-A5): backend epoch · PTY 세대 · provider 세션 · **입력 revision**(LIFE-598 r2). 넣기 전 하나라도 바뀌면 실패 —
//   이전 지시가 새 세대로 따라가지 않는다. **접수 뒤 그 pane 에 맥 입력이 있으면 넣지 않는다**(`mac_input` — LIFE-709, 세션·세대가 바뀐 것은 `target_changed`): 효과는 guard 가 같은 턴에서
//   울타리 값 — 접수 때의 revision(R0)에서 허브 자기 쓰기 사슬을 따라간 **끝** — 그대로일 때만 쓴다(`expected_input_revision`). `/clear` 는 키 입력이라 이 울타리가 결정적으로 막는다 — herdr 가 새 세션을
//   언제 알든(리뷰 r2 실측 최대 ≈ 6 s, 훅 경로라 상한 없음) 상관없다. 「맥 입력」 = guard 가 revision 을 올리는, 초안이 될 수 있는 PTY 사용자 입력 쓰기 — 키·글자·붙여넣기·
//   제출·다른 클라이언트의 `pane.send_text`(CLI `terminal prompt`·orchestration 배달 포함)·마우스 보고가 꺼진 alt-screen 의 휠(`AlternateScroll` — 화살표 키라 이전 입력을 불러온다).
//   **마우스 보고**(휠·클릭·드래그·이동 — LIFE-708)와 **포커스 전환**(corral 의 `pane.focus` 경로, 리뷰 r3 실측 +0)은 올리지 않는다.
//   허브 자기 쓰기(앞 지시·답 키·중단 키)는 쓰기 **전에** 「직전 revision → +1」 고리를 걸고(`beginWrite`) 그 pane 에 쓰기 진행을 표시한다(LIFE-598 r3).
//   끝은 `endWrite`(백엔드 reject 도 `finally` 로 — R4-C2): 키는 guard 가 돌려준 쓴 뒤 revision 으로 확정, 응답에 revision 이 없는 지시·울타리 없는 중단 키는
//   끝난 뒤 다시 관측해 직전+1 일 때만 확정(`endUnreported`, R4-C3), 거절·`unknown` 은 거둔다. 사슬 위의 값은 남의 입력이 아니다(`fenceRead` — 끝값 ok, 중간·진행 중 사슬 밖은
//   다시 봄, 그 밖 moved). **진행 중 미룸**은 지시 경로의 효과 직전(`deliver` — 다른 자기 쓰기가 진행 중이면 넣지 않음, R4-C1)과 답의 첫 키 앞(`runAnswer` — 끝날 때까지
//   기다림, 기한 넘으면 `busy`, R4-C4)에 건다. 그 사이 맥 입력이 끼면 실제 revision 이 고리 끝을 넘어 뒤 지시는 실패한다(쓰지 않는 쪽).
//   효과 직전 세션 대조(목록 R2-A4 + herdr 관측 `agent_session`, LIFE-598 r0·r1)는 보조로 남는다 — 관측에 세션이 없으면 쓰지 않고 실패.
//   남는 구멍: 접수 **전**에 친 `/clear` 를 목록·herdr 가 아직 모르는 때 접수된 지시, 그리고 접수 뒤 R0 표본까지(`bind` 의 locate·observe 왕복 ≈ 0.3 s) 친 키 —
//   R0 가 이미 그 키를 포함하므로 울타리로는 못 막고 보조 대조만 본다(답은 `before` 관측까지 같다).
// - **채널별 큐**(P3): 순서대로 한 건씩. 에이전트가 준비 관문(750 ms 두 관측 · 같은 seq · detect manifest 확인 — CLI 와 같은 관문)을 통과해야 넣는다.
//   관문 통과 = 턴이 끝났다는 뜻이라 턴 안에 끼어들지 않는다. 넣기는 guard 의 compare-and-submit(`agent.prompt` + 관측한 seq + **접수 때 revision 에서 자기 쓰기 사슬만 따라간 울타리**)이라
//   그 사이 전이·맥 입력이 있으면 아무것도 쓰지 않고 거절된다 — 다시 관측해 입력이면 `mac_input`, 전이면 큐로 돌아가 다시 기다린다. 취소는 넣기 시작 전(`queued`)만.
// - **수명**(R1-A1·A4): 모바일 끔·종료(활성 세대가 바뀜)·그 기기 해지면 그 기기의 끝나지 않은 요청을 끝낸다. 모든 await 뒤와 효과 직전에 다시 본다 —
//   늦게 온 guard 거절이 끈 뒤의 지시를 큐로 되살리지 않고, 답의 남은 키는 멈춘다(일부 키가 들어갔으면 `unconfirmed`). 연결 끊김(폰 화면 끔)은 수명이 아니다 — 큐는 남는다.
// - **맥 입력창 초안**(P9): 넣기 직전 보이는 화면의 입력 줄이 비었는지 본다(`keys.ts draftState`). 글이 있거나 판단 못 하면 넣지 않고 실패.
//   그 앞에 Claude agent view 화면인지 본다(`keys.ts agentViewShown`, LIFE-770) — 그 화면의 입력은 폰이 보던 대화로 가지 않으니(상자는 새 세션, Space 패널은 그 행의 세션) `agent_view` 로 실패.
//   그 화면은 같은 guard 턴의 입력 revision·조용한 시간과 함께 읽는다(R2-A3) — 화면을 잡을 때 입력이 `quietMs` 이상 조용했어야 믿고, 그 화면의 revision 도 울타리 값이어야 한다.
//   넣기는 그 울타리 그대로일 때만 같은 App 턴에서 한다(R1-A3). 칸 없는 CLI 제출도 revision 을 올린다(guard).
// - **질문 답**(P4): 폰은 어느 질문(말풍선 id + 도구 호출 id + 내용 지문)에 어떤 답인지만 보낸다(R1-A2·R2-A1). 서버는 그 질문이 기록의 마지막 대기 질문이고 지문이 같고
//   `blocked` 일 때, 키 묶음마다 조용한 화면의 **활성 질문 영역**이 그 문항인지 대조하고, 키마다 「그 seq · 그 입력 revision 그대로일 때만」 넣는다(`runAnswer`).
//   답은 마우스 보고까지 세는 **모든 입력 revision** 도 화면 조용함·키 앞 대조·키 울타리에 쓴다(LIFE-708 r1 — 클릭이 선택만 옮길 수 있다). 지시·자기 쓰기 사슬은 초안 revision 만.
//   들어감 = 커서 뒤 기록에 **그 질문의 답 정확히 1건**(Codex 는 `questionItemId` 귀속, R2-A2) + 판독자에서 그 질문이 대기에서 풀림(UI `answered` 만으로 세지 않는다).
// - **중단**(P5): 그 순간 상태를 다시 관측해 작업 중·(허용된) 대기일 때만 provider 키 1회 — 역시 seq 비교. 재시도 없음. 한가면 `not_running`.
//   멈춤 = 상태가 working·blocked 를 떠남 또는 기록의 그 턴 `interrupted`(백그라운드가 있으면 herdr 는 working 에 남는다 — Z1ⓓ).
// - 본문은 로그에 남기지 않는다(길이·해시 앞 8자만). 끝난 지시의 본문은 메모리에서도 버린다.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { TerminalIdentity } from '../adapter/index.js'
import { bodyIdentity, countSubmissions, normalizeBody } from '../../runtime/terminal/agent.js'
import { ATTACH_SESSION_SOURCE, type AgentSessionRef } from '../../shared/types.js'
import { parseGrokUpdates, parseTail } from '../transcript-parse.js'
import { codexQuestionReplies, grokAnsweredMessage, grokAnswerSegments, lineAtoms, type ChatItem } from '../chat-parse.js'
import {
  activeQuestion,
  agentViewShown,
  answerGroups,
  cleanAnswerText,
  cleanBody,
  draftState,
  MAX_INPUT_BYTES,
  matchQuestion,
  questionDigest,
  questionKeys,
  stopAllowed,
  stopKey,
  stopNeedsEmptyInput,
  type AnswerCheck,
  type QuestionAnswer,
} from './keys.js'
import { buildMobileList, chatChannel, type ChatChannel, type ListInput, type MobileAgentKind, type MobileChannel } from './list.js'

export type InputOp = 'send' | 'answer' | 'stop'
/**
 * 지시·답·중단의 상태(폰 C12 4상태 + 확인 못 함):
 * `queued`(서버가 받음 — 관문을 기다림, 취소 가능) · `sending`(넣는 중 — 취소 불가) · `delivered`(기록 1건 확인) · `unconfirmed`(넣었거나 넣었을 수 있는데
 * 기록으로 확정 못 함) · `failed`(넣지 않았다) · `cancelled` · `stopped`(중단 확인) · `unknown`(서버가 모르는 id — 맥 앱 재시작·기억 만료).
 */
export type InputState = 'queued' | 'sending' | 'delivered' | 'unconfirmed' | 'failed' | 'cancelled' | 'stopped' | 'unknown'
/** `queued` 의 기다림 — `turn` = 에이전트가 작업 중·대기 중(이 턴이 끝나면) · `gate` = 곧 넣는다(관문 확인 중). */
export type InputWait = 'turn' | 'gate'

/** `text` 는 복구 조회(`input.pending`)의 답에서만 — 앱이 다시 시작해 잊은 대기 지시를 다시 보이게(R1-A8). */
export type InputWire = { type: 'input.state'; id: string; channel: string | null; op: InputOp | null; state: InputState; wait: InputWait | null; reason: string | null; at: number; text?: string }

/** 채널당 큐 상한(P3 ≥ 3). 넘으면 `queue_full`. */
export const INPUT_QUEUE_MAX = 5
/** 기기당 기억하는 id 수 — 넘으면 끝난 것부터 상태를 버린다(버린 id 는 `unknown`·`expired`, 다시 넣지는 않는다). */
export const INPUT_IDS_MAX = 500
/** 기록 꼬리 지문의 크기 — 이 구간이 바뀌었으면 파일이 다시 쓰인 것이다. */
const TAIL_WINDOW = 64 * 1024

export type InputTiming = {
  /** 큐가 관문을 다시 보는 주기. */
  pollMs: number
  /** 준비 관문 두 관측 사이(CLI `READY_SAMPLE_INTERVAL_MS` 와 같다). */
  gateMs: number
  /** 맥 입력이 이만큼 조용해야 넣는다 — 타자 echo 가 화면에 오기 전을 덮는다(R1-A3 실측 echo ≤ 223 ms → 500). guard 가 같은 턴에서 잰다. */
  quietMs: number
  /** 지시를 넣은 뒤 기록에서 1건을 기다리는 시간. 넘으면 `unconfirmed`. */
  confirmMs: number
  /** 기록 확인 주기. */
  recordPollMs: number
  /** 질문 답 키 단계 사이(Z1 실측 300~500 ms). */
  stepGapMs: number
  /** 질문 답 뒤 기록에서 답함을 기다리는 시간. */
  answerConfirmMs: number
  /** 중단 뒤 멈춤을 기다리는 시간(Z5ⓐ ≤ 5초). */
  stopConfirmMs: number
}
export const INPUT_TIMING: InputTiming = { pollMs: 1000, gateMs: 750, quietMs: 500, confirmMs: 15_000, recordPollMs: 250, stepGapMs: 350, answerConfirmMs: 10_000, stopConfirmMs: 5_000 }

/**
 * `unmanaged` = herdr 가 그 pane 을 관리 에이전트로 띄우지 않았다(셸에서 직접 친 `claude` 등) — 한가해도 `interactive_ready` 가 켜지지 않는다.
 * LIFE-597: 그런 pane 은 요청이 `unmanaged_agent`(채널 종류)를 명시할 때만 guard 가 받는다 — 종류 결속 + 같은 상태 settle(3 s).
 * `quiet` 는 관리 pane 이면 `agentQuiescent`, 관리 밖이면 guard 가 그 갈래를 알고 settle 을 넘겼을 때다.
 * `input` = 그 pane 의 사람 입력 revision·조용한 시간(guard 가 같은 관측 턴에서 읽는다). 이전 guard 면 null — 그때는 넣지 않는다.
 */
export type PaneObservation = { status: string; seq: number; quiet: boolean; unmanaged: boolean; input: InputMark | null; anyInput: InputMark | null; session: string | null }
/**
 * 입력 revision·조용한 시간. `input` = 초안이 될 수 있는 입력(키·글자·붙여넣기·제출 — 마우스 보고 제외, LIFE-708),
 * `anyInput` = 마우스 보고까지 모든 입력(LIFE-708 r1 — 질문 답은 클릭이 선택을 옮길 수 있어 이것으로 울타리 친다). 이전 guard 면 `anyInput` 이 null —
 * 그 guard 는 마우스도 `input` 에 세므로 답 경로는 `input` 으로 대신한다.
 */
export type InputMark = { revision: number; idleMs: number }
/**
 * LIFE-598: `PaneObservation.session` — herdr `agent.get` 의 `agent_session` 을 이 키로. 목록 `AgentSessionRef` 도 같은 herdr 봉투에서 왔으므로
 * (`store.ts readAgentSession`) source·kind·값으로 맞춘다. `agent` 는 관측 봉투에 없어 쓰지 않는다(source 가 `herdr:<agent>` 라 갈린다).
 */
export const observedSessionKey = (session: { source: string; kind: string; value: string }): string => `${session.source}\u0000${session.kind}\u0000${session.value}`
/**
 * 접수 때 묶는 herdr 관측 키. corral 이 `claude attach` 로 푼 세션(LIFE-769 `ATTACH_SESSION_SOURCE`)은 herdr 가 참조를 주지 않는 pane 의 것이라
 * 관측 키가 **없음(null)** 이어야 같은 상태다 — herdr 가 그 사이 키를 주기 시작하면 다른 세션으로 보고 거절한다(fail-closed 유지).
 */
const boundSessionKey = (session: AgentSessionRef): string | null =>
  session.source === ATTACH_SESSION_SOURCE ? null : observedSessionKey({ source: session.source, kind: session.kind, value: session.kind === 'id' ? session.id : session.path })
export type SendResult = 'sent' | 'refused' | 'unknown'
/** 키 한 번의 결과 — `sent` 면 guard 가 쓴 뒤의 입력 revision(다음 키의 울타리, 울타리 없이 보냈으면 null). */
export type KeyResult = { kind: 'sent'; revision: number | null; anyRevision: number | null } | { kind: 'refused' } | { kind: 'unknown' }
/** 보이는 화면 + 같은 guard 턴의 입력 revision·조용한 시간·에이전트 seq(R2-A3). 이전 guard 면 `input`·`seq` 가 null. */
export type ScreenRead = { text: string; input: InputMark | null; anyInput: InputMark | null; seq: number | null }

/** herdr 쪽 — 실제는 `input-backend.ts`(guard 봉투), 시험은 가짜. */
export interface InputBackend {
  /** 지금 그 pane(세대 포함). 없으면 null. */
  locate(paneId: string): Promise<TerminalIdentity | null>
  /** 에이전트 상태 한 번. 에이전트가 없으면 status `none`. */
  observe(pane: TerminalIdentity): Promise<PaneObservation>
  /** LIFE-597: guard 가 관리 밖 pane 의 `agent.prompt`(`unmanaged_agent`)를 아는가 — `locate` 뒤에 안다. 모르면 관리 밖 pane 에 넣지 않는다. */
  unmanagedPrompt(): boolean
  /** detect manifest 확인(CLI 와 같은 fail-closed — 신뢰 대화상자가 한가로 보일 수 있다). */
  manifestVerified(kind: MobileAgentKind): Promise<boolean>
  /** 보이는 화면(ANSI) — 같은 턴의 입력 revision·조용한 시간·seq 와 함께(R2-A3). */
  screen(pane: TerminalIdentity): Promise<ScreenRead>
  /**
   * guard `agent.prompt` — 관측한 seq·입력 revision 그대로이고 입력이 `minIdleMs` 이상 조용할 때만. `refused` = 아무것도 쓰지 않았다.
   * `unmanagedAgent` = 관리 밖 pane 이라고 관측했을 때만 채널 종류(LIFE-597 — guard 가 감지 종류와 대조하고 settle 을 잰다). 관리 pane 은 null.
   */
  prompt(pane: TerminalIdentity, input: { text: string; seq: number; inputRevision: number; minIdleMs: number; unmanagedAgent: MobileAgentKind | null }): Promise<SendResult>
  /**
   * guard `pane.send_text` + 관측한 seq 비교 + (주면) 입력 revision 울타리 — 그 revision 뒤에 다른 입력이 있었으면 `refused`(R2-A1).
   * `anyInputRevision`(주면) = 모든 입력 revision 울타리 — 그 뒤 클릭 하나라도 있었으면 `refused`(LIFE-708 r1, 질문 답 키만). `refused` = 아무것도 쓰지 않았다.
   */
  send(pane: TerminalIdentity, input: { text: string; seq: number; inputRevision: number | null; anyInputRevision: number | null }): Promise<KeyResult>
}

/**
 * 쓰기용 기록 해소(R1-A13) — `found` 는 **유일한** 후보일 때만. `none` = 훑기 성공·0건(새 세션은 첫 지시 뒤에 파일이 생긴다) ·
 * `error` = 0건을 믿을 수 없다(기다린다) · `ambiguous` = 같은 세션 id 의 파일이 둘 이상(잠근다).
 * `continuedAs` = 기록이 이어 간 세션 id(LIFE-766) — 커서 뒤 줄은 이 id 로 센다. 없으면 채널 세션 그대로.
 */
export type FileResolution = { kind: 'found'; file: string; continuedAs?: string } | { kind: 'none' } | { kind: 'error' } | { kind: 'ambiguous' }

export type InputHubDeps = {
  read: () => ListInput | null
  backend: () => InputBackend | null
  /** 채널 → 기록 파일(대화와 같은 파일 — Grok 은 `updates.jsonl`). */
  resolveFile: (channel: ChatChannel) => FileResolution
  /**
   * 기록 파일이 **아직 없을 때**(`none`) 그 세션이 쓸 경로 — 새 Claude·Grok 세션은 첫 지시 뒤에 파일이 생긴다(격리 빠른 확인 q10).
   * CLI 와 같은 규칙(`sessionRecordPaths` — pane 의 cwd + 세션 id). 없으면(Codex 등) null — 그때는 기다린다.
   */
  expectedFile?: (input: { channel: ChatChannel; cwd: string }) => string | null
  /** 그 기록의 말풍선(열린 대화의 판독자) — 질문 확인용. 판독자가 없으면 null. */
  questionItems: (file: string) => readonly ChatItem[] | null
  /** 그 기록의 판독자를 질문 확인 전에 맞춘다(LIFE-766) — 세션이 막 이어 갔으면 열린 대화를 옮기고 색인을 기다린다. 없으면 바로 본다. */
  questionReady?: (file: string) => Promise<void>
  /** 그 기기가 아직 페어링돼 있나 — 효과 직전마다 본다(R1-A1). 없으면 `revoke()` 로 받은 해지만 본다. */
  deviceValid?: (device: string) => boolean
  log: (tag: string, fields?: Record<string, unknown>) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timing?: Partial<InputTiming>
}

/**
 * 접수 때 묶은 대상(R1-A5). `observed` = 같은 세션의 herdr 관측 키(LIFE-598 — 효과 직전 `PaneObservation.session` 과 대조).
 * `revision` = 접수 때 herdr 관측의 입력 revision(R0, LIFE-598 r2) — 효과의 울타리는 여기서 허브 자기 쓰기 사슬만 따라간 값(`fenceOf`).
 */
type Bind = { epoch: string; ptyId: string; session: string; observed: string | null; revision: number }
/** 효과 직전 세션·입력 대조 중 무엇이 걸렸나 — 로그 `mobile.input_target_changed` 에 남겨 실물 회차가 가른다(리뷰 r2 C·R2-C3). */
type MovedCheck = 'list' | 'pane' | 'herdr_session' | 'input' | 'input_refused'
/** 허브 자기 쓰기 사슬의 pane 키 — revision 은 PTY 세대마다 새로 센다. */
const paneKey = (pane: { epoch: string; ptyId: string }): string => `${pane.epoch}\u0000${pane.ptyId}`
/** pane 당 남기는 자기 쓰기 수 — 넘으면 오래된 것부터 버린다(버린 사슬에 묶인 항목은 `mac_input` 로 끝난다 — 쓰지 않는 쪽). `fenceOf` 반복 상한도 이 값. */
const SELF_WRITES_MAX = 256
/**
 * 자기 쓰기 사슬 한 고리(LIFE-598 r3) — 쓰기 **전에** `before → before + 1` 로 걸고(`owners` = 진행 중인 쓰기), 들어가면 `confirmed`,
 * 거절·`unknown` 이면 그 쓰기의 몫을 거둔다(아무도 확정하지 않았으면 고리를 지운다 — 뒤 항목은 `mac_input`, 쓰지 않는 쪽).
 */
type Link = { after: number; owners: Set<symbol>; confirmed: boolean }
/** 진행 중인 자기 쓰기 하나 — `beginWrite` 가 주고 `endWrite` 가 한 번만 닫는다(`closed`). 고리를 못 건 쓰기(after ≤ before 등)는 `link` 가 null. */
type SelfWrite = { key: string; before: number; token: symbol; link: Link | null; closed: boolean }
/** 자기 쓰기의 끝 — `sent` 의 `after` 는 쓴 뒤 revision(guard 응답, 또는 끝난 뒤 다시 관측해 직전+1 임을 본 값). */
type WriteOutcome = { kind: 'sent'; after: number } | { kind: 'refused' } | { kind: 'unknown' }
/** 관측 revision 대조 — `ok` = 울타리 끝값 · `behind` = 사슬 중간(그 뒤 자기 쓰기가 있었다)이나 자기 쓰기 진행 중의 값(다시 본다) · `moved` = 접수 뒤 남의 입력. */
type FenceRead = 'ok' | 'behind' | 'moved'

type Entry = {
  device: string
  id: string
  channel: string
  op: InputOp
  state: InputState
  wait: InputWait | null
  reason: string | null
  at: number
  order: number
  /** 접수 때의 모바일 활성 세대 — 끄면 바뀐다(R1-A4). */
  gen: number
  /** 접수 때 묶은 대상 — 묶기 전(접수 직후 비동기)이면 null. */
  bind: Bind | null
  /** 지시 본문(정리한 것) — 끝나면 지운다. */
  text: string | null
  question: number | null
  /** 폰이 본 질문의 도구 호출 id(R1-A2). */
  call: string | null
  /** 폰이 본 질문 내용의 지문(`questionDigest`, R2-A1). */
  digest: string | null
  answers: QuestionAnswer[] | null
}

type QuestionItem = Extract<ChatItem, { kind: 'question' }>
/** 기록 꼬리 커서 — 제출 직전 그 파일의 정체(dev·ino)·크기와 끝 `TAIL_WINDOW` 바이트의 지문. 한 번 연 파일에서 함께 잡는다(R2-A7). */
type TailCursor = { file: string; existed: boolean; dev: number; ino: number; bytes: number; window: string | null }

const FINAL: ReadonlySet<InputState> = new Set(['delivered', 'unconfirmed', 'failed', 'cancelled', 'stopped'])
const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8)
const sessionKey = (session: AgentSessionRef): string => (session.kind === 'id' ? `${session.agent}:id:${session.id}` : `${session.agent}:path:${session.path}`)

/** 폰이 보낸 질문 답 한 문항 — 모양은 프로토콜이 이미 걸렀다. 직접 입력 글은 여기서 한 줄로 정리한다(합계 `MAX_INPUT_BYTES` — P7). */
export function cleanAnswers(raw: { choices: number[]; other: string | null }[]): QuestionAnswer[] | null {
  const out: QuestionAnswer[] = []
  let bytes = 0
  for (const answer of raw) {
    const other = answer.other === null ? null : cleanAnswerText(answer.other)
    if (other !== null && other.length === 0) return null
    bytes += other === null ? 0 : Buffer.byteLength(other)
    if (bytes > MAX_INPUT_BYTES) return null
    out.push({ choices: [...answer.choices], other })
  }
  return out
}

/** 열린 파일에서 `[from, to)` 바이트. */
function readFd(input: { fd: number; from: number; to: number }): Buffer {
  const length = Math.max(0, input.to - input.from)
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const chunk = fs.readSync(input.fd, buffer, read, length - read, input.from + read)
    if (chunk === 0) break
    read += chunk
  }
  return buffer.subarray(0, read)
}

/** `[from, to)` 바이트. 못 읽으면 null. */
function readBytes(input: { file: string; from: number; to: number }): Buffer | null {
  try {
    const fd = fs.openSync(input.file, 'r')
    try {
      return readFd({ fd, from: input.from, to: input.to })
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

const sizeOf = (file: string): number | null => {
  try {
    return fs.statSync(file).size
  } catch {
    return null
  }
}

/**
 * 파일 하나를 열어 그 정체(dev·ino)·크기와 `[from, 크기)` 를 같은 열린 파일에서 읽는다 — 이름이 그 사이 다른 파일로 바뀌어도 섞이지 않는다(R2-A7).
 * 없으면 `missing`, 그 밖에 못 읽으면 `error`.
 */
function snapshot(input: { file: string; from: (size: number) => number }): { kind: 'ok'; dev: number; ino: number; size: number; data: Buffer } | { kind: 'missing' } | { kind: 'error' } {
  let fd: number
  try {
    fd = fs.openSync(input.file, 'r')
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error' }
  }
  try {
    const stat = fs.fstatSync(fd)
    return { kind: 'ok', dev: stat.dev, ino: stat.ino, size: stat.size, data: readFd({ fd, from: Math.min(stat.size, input.from(stat.size)), to: stat.size }) }
  } catch {
    return { kind: 'error' }
  } finally {
    fs.closeSync(fd)
  }
}

const digestOf = (chunk: Buffer): string => createHash('sha256').update(chunk).digest('hex')

/** 제출 직전 커서 — 정체·크기와 끝 64 KiB 만 읽는다(C1). 못 읽으면 null(넣지 않는다). */
export function tailCursor(file: string): TailCursor | null {
  const shot = snapshot({ file, from: (size) => Math.max(0, size - TAIL_WINDOW) })
  switch (shot.kind) {
    case 'missing':
      return { file, existed: false, dev: 0, ino: 0, bytes: 0, window: null }
    case 'error':
      return null
    case 'ok':
      return { file, existed: true, dev: shot.dev, ino: shot.ino, bytes: shot.size, window: digestOf(shot.data) }
  }
}

/**
 * 커서 뒤에 붙은 글. 파일이 다른 파일로 바뀌었거나(dev·ino — R2-A7) 커서보다 짧거나 커서 앞 꼬리가 바뀌었으면 다시 쓰인 것이다
 * (`rewritten` — CLI 의 `cursorInvalidated` 와 같은 뜻, 성공 근거로 쓰지 않는다). 커서 때 없던 파일은 통째로(새 세션 — 작다), 아직 없으면 null.
 */
export function tailSince(cursor: TailCursor): { text: string | null; rewritten: boolean } {
  const shot = snapshot({ file: cursor.file, from: (size) => (cursor.existed ? Math.max(0, Math.min(size, cursor.bytes) - TAIL_WINDOW) : 0) })
  if (shot.kind === 'missing') return { text: null, rewritten: cursor.existed }
  if (shot.kind === 'error') return { text: null, rewritten: false }
  if (!cursor.existed) return { text: shot.data.toString('utf8'), rewritten: false }
  if (shot.dev !== cursor.dev || shot.ino !== cursor.ino || shot.size < cursor.bytes) return { text: null, rewritten: true }
  const windowStart = Math.max(0, cursor.bytes - TAIL_WINDOW)
  if (digestOf(shot.data.subarray(0, cursor.bytes - windowStart)) !== cursor.window) return { text: null, rewritten: true }
  return { text: shot.data.subarray(cursor.bytes - windowStart).toString('utf8'), rewritten: false }
}

/**
 * 커서 뒤 기록에서 그 도구 호출의 답 — 같은 기록 파서(`lineAtoms`)의 `result` 원자를 센다(Claude·Grok). `declined` = 답이 오류(거절·취소)로 끝났다.
 * Codex 는 답이 사람 줄 봉투로 온다 — 봉투의 `questionItemId`(도구 호출 id + 문항 번호)가 **이 호출**인 항목만 센다(R2-A2). 이 호출의 문항
 * `questions` 개가 모두 한 번씩 답해졌을 때만 1건, 일부만이면 0건. 귀속을 못 읽은 봉투가 있으면 `unattributed`(확정하지 않는다).
 */
export function answerRecords(input: { kind: MobileAgentKind; text: string; call: string; questions: number }): { count: number; declined: boolean; unattributed: boolean } {
  let results = 0
  let declined = false
  let unattributed = false
  const answered = new Map<number, number>()
  for (const line of input.text.split('\n')) {
    if (line.trim() === '') continue
    if (input.kind === 'codex') {
      const replies = codexQuestionReplies(line)
      if (replies !== null) {
        for (const reply of replies) {
          if (reply.call === null || reply.index === null) unattributed = true
          else if (reply.call === input.call) answered.set(reply.index, (answered.get(reply.index) ?? 0) + 1)
        }
        continue
      }
    }
    for (const atom of lineAtoms({ agent: input.kind, line, sessionId: null }).atoms) {
      if (atom.kind === 'result' && atom.callId === input.call) {
        results += 1
        if (atom.status === 'error') declined = true
      }
    }
  }
  if (input.kind !== 'codex' || answered.size === 0) return { count: results, declined, unattributed }
  const complete = answered.size === input.questions && [...answered.keys()].every((index) => index >= 0 && index < input.questions)
  // 같은 문항이 두 번 답해졌으면 정확히 한 번이 아니다.
  const repeated = [...answered.values()].some((times) => times > 1)
  return { count: repeated ? 2 : complete ? 1 : 0, declined, unattributed }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const parseLine = (line: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(line)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

/** 기록의 답 값 — 문항마다 하나(문항 순서대로). 문항↔답 대응을 못 읽으면 `unreadable`(R4-A1). */
export type RecordedAnswers = { kind: 'ok'; values: string[] } | { kind: 'unreadable' }

/**
 * 커서 뒤 기록에서 그 도구 호출의 **문항별 답 값**(R3-A1 · R4-A1 — 문항↔답 대응을 보존한다, 한 글로 평탄화하지 않는다).
 * - Claude: 그 호출의 결과 줄 `toolUseResult.answers`(`{문항 글: 답}`) — 문항 글로 찾는다. 같은 문항 글이 둘이면 대응을 모른다.
 * - Codex: 답 봉투에서 그 호출에 귀속된 항목의 `questionItemId` 문항 번호 → `answer`. 같은 번호가 둘이면 대응을 모른다.
 * - Grok: 그 호출의 결과 줄 `rawOutput.UserAnswered.message`(`User has answered your questions: "문항"="답", … . You can now …`) —
 *   문항 글마다 `"문항"=` 이 정확히 한 번 있어야 그 사이를 그 문항의 답으로 자른다. 경계를 못 읽으면 대응을 모른다.
 * 하나라도 못 읽으면 `unreadable`.
 */
export function recordedAnswers(input: { kind: MobileAgentKind; text: string; call: string; questions: string[] }): RecordedAnswers {
  const values: (string | null)[] = input.questions.map(() => null)
  const set = (index: number, value: string): boolean => {
    if (index < 0 || index >= values.length || values[index] !== null) return false
    values[index] = value
    return true
  }
  for (const line of input.text.split('\n')) {
    if (line.trim() === '') continue
    if (input.kind === 'codex') {
      for (const reply of codexQuestionReplies(line) ?? []) {
        if (reply.call !== input.call) continue
        if (reply.index === null || reply.answer === null || !set(reply.index, reply.answer)) return { kind: 'unreadable' }
      }
      continue
    }
    if (!lineAtoms({ agent: input.kind, line, sessionId: null }).atoms.some((atom) => atom.kind === 'result' && atom.callId === input.call)) continue
    const record = parseLine(line)
    if (record === null) return { kind: 'unreadable' }
    if (input.kind === 'claude') {
      const result = record['toolUseResult']
      const answers = isObject(result) ? result['answers'] : null
      if (!isObject(answers)) return { kind: 'unreadable' }
      // 같은 문항 글이 둘이면 map 으로는 어느 문항의 답인지 모른다.
      if (new Set(input.questions).size !== input.questions.length) return { kind: 'unreadable' }
      for (const [index, question] of input.questions.entries()) {
        const value = answers[question]
        if (typeof value !== 'string' || !set(index, value)) return { kind: 'unreadable' }
      }
      continue
    }
    const params = record['params']
    const update = isObject(params) && isObject(params['update']) ? params['update'] : isObject(record['update']) ? record['update'] : null
    const message = update === null ? null : grokAnsweredMessage(update['rawOutput'])
    const split = message === null ? null : grokAnswerSegments({ message, questions: input.questions })
    if (split === null) return { kind: 'unreadable' }
    for (const [index, value] of split.entries()) if (!set(index, value)) return { kind: 'unreadable' }
  }
  const ok: string[] = []
  for (const value of values) {
    if (value === null) return { kind: 'unreadable' }
    ok.push(value)
  }
  return { kind: 'ok', values: ok }
}

/**
 * 기록의 답 값이 폰이 고른 답인가(R3-A1 · R4-A1) — **문항마다** 비교한다. 순서를 보지 않는 것은 한 문항 안의 multiSelect 집합뿐.
 * - 하나 고름: 그 선택지 글 또는 직접 입력 글과 정확히 같아야 한다(Grok 은 `"글"` · 직접 입력 `"Other" user notes: 글`).
 * - 여럿 고름(Claude): `A, B` — 고른 글·직접 입력 글을 `, ` 경계에서 하나씩 정확히 한 번 빼면 아무것도 남지 않아야 한다
 *   (반복 라벨은 남고, 다른 라벨의 부분 문자열인 라벨은 경계가 맞지 않아 빠지지 않는다).
 */
export function answerMatches(input: { kind: MobileAgentKind; recorded: string[]; questions: QuestionItem['questions']; answers: QuestionAnswer[] }): boolean {
  if (input.recorded.length !== input.questions.length || input.answers.length !== input.questions.length) return false
  return input.questions.every((question, index) => {
    const answer = input.answers[index]!
    const labels = answer.choices.map((choice) => question.options[choice]?.label ?? null)
    if (labels.some((label) => label === null)) return false
    return valueMatches({ kind: input.kind, value: input.recorded[index]!, multi: question.multiSelect === true, labels: labels.flatMap((label) => (label === null ? [] : [label])), other: answer.other })
  })
}

function valueMatches(input: { kind: MobileAgentKind; value: string; multi: boolean; labels: string[]; other: string | null }): boolean {
  let value = input.value.trim()
  if (input.kind === 'grok') {
    // 직접 입력 = 고정 접두 뒤 글 그대로(R5-A3 — 글 안의 따옴표·끝 쉼표도 답이다). 고름 = `"글"`.
    const prefix = '"Other" user notes: '
    if (value.startsWith(prefix)) return input.other !== null && !input.multi && input.labels.length === 0 && value.slice(prefix.length) === input.other
    if (input.other !== null) return false
    const match = /^"(.*)"$/.exec(value)
    if (match === null) return false
    value = match[1]!
  }
  if (!input.multi) {
    const expected = input.other ?? input.labels[0]
    return input.labels.length + (input.other === null ? 0 : 1) === 1 && expected !== undefined && value === expected
  }
  // 여럿 고름(Claude 실측 r5/native m01): `, ` 로 잇고, 쉼표나 `"` 가 든 글은 `"…"` 로 감싸 안의 `"` 를 `\"` 로 쓴다(R5-A2). 그 형식대로 나눠 집합을 비교한다.
  const tokens = claudeChoiceList(value)
  if (tokens === null) return false
  const expected = [...input.labels, ...(input.other === null ? [] : [input.other])].sort()
  return JSON.stringify([...tokens].sort()) === JSON.stringify(expected)
}

/** Claude multiSelect 답 값 → 고른 글 목록. 형식이 어긋나면(닫히지 않은 따옴표 · 감싸지 않은 `"` · 빈 칸) null. */
function claudeChoiceList(value: string): string[] | null {
  const tokens: string[] = []
  let at = 0
  while (at <= value.length) {
    let token = ''
    if (value[at] === '"') {
      at += 1
      let closed = false
      while (at < value.length) {
        const char = value[at]!
        if (char === '\\' && (value[at + 1] === '"' || value[at + 1] === '\\')) {
          token += value[at + 1]
          at += 2
          continue
        }
        at += 1
        if (char === '"') {
          closed = true
          break
        }
        token += char
      }
      if (!closed) return null
    } else {
      const next = value.indexOf(', ', at)
      token = value.slice(at, next < 0 ? value.length : next)
      if (token.includes('"')) return null
      at += token.length
    }
    if (token.length === 0) return null
    tokens.push(token)
    if (at === value.length) return tokens
    if (!value.startsWith(', ', at)) return null
    at += 2
  }
  return null
}

/**
 * 「들어감」 근거로 쓸 줄만(R3-A4·A5) — **이 접수 뒤**(`sinceMs` 이후 — 기록 시각의 단위만큼만 봐준다: ms 가 있으면 ms, 초뿐이면 그 초)이고
 * **이 세션**(Claude `sessionId` · Grok `params.sessionId`)인 줄. 시각이 없거나 세션이 다른 줄은 뺀다. Codex 는 줄에 세션이 없다 — 기록 파일이 세션마다
 * 따로라(이름에 세션 id) 파일로 귀속하고, 시각만 본다. 나중에 생긴 파일을 통째로 읽거나, 같은 파일을 제자리에서 다시 써 옛 줄이 커서 뒤에 와도 그 줄은 이 접수 전 시각이다.
 */
export function submissionLines(input: { kind: MobileAgentKind; text: string; sessionId: string | null; sinceMs: number }): string {
  const keep = input.text.split('\n').filter((line) => {
    const record = parseLine(line)
    if (record === null) return false
    return lineAfter({ kind: input.kind, record, sinceMs: input.sinceMs }) && lineSession({ kind: input.kind, record, sessionId: input.sessionId })
  })
  return keep.length === 0 ? '' : `${keep.join('\n')}\n`
}

function lineAfter(input: { kind: MobileAgentKind; record: Record<string, unknown>; sinceMs: number }): boolean {
  const stamp = input.record['timestamp']
  if (typeof stamp === 'number' && Number.isFinite(stamp)) {
    // Grok 은 초 단위 정수(실측) — 그 초까지 봐준다.
    return stamp >= 1e12 ? stamp >= input.sinceMs : Math.floor(stamp) >= Math.floor(input.sinceMs / 1000)
  }
  if (typeof stamp !== 'string') return false
  const ms = Date.parse(stamp)
  if (Number.isNaN(ms)) return false
  return /T\d{2}:\d{2}:\d{2}\.\d/.test(stamp) ? ms >= input.sinceMs : Math.floor(ms / 1000) >= Math.floor(input.sinceMs / 1000)
}

function lineSession(input: { kind: MobileAgentKind; record: Record<string, unknown>; sessionId: string | null }): boolean {
  // 경로 참조 세션(`kind: 'path'`)은 그 파일이 곧 세션이다 — 파일로 귀속한다.
  if (input.sessionId === null) return true
  switch (input.kind) {
    case 'claude':
      return input.record['sessionId'] === input.sessionId
    case 'grok': {
      const params = input.record['params']
      return (isObject(params) ? params['sessionId'] : input.record['sessionId']) === input.sessionId
    }
    case 'codex':
      return true
  }
}

/** 기록 문항 → 화면 대조용(글·선택지 글·여럿 고름·preview). */
const plainQuestion = (question: QuestionItem['questions'][number]): { question: string; options: string[]; descriptions: (string | null)[]; multiSelect: boolean | null; preview: boolean } => ({
  question: question.question,
  options: question.options.map((option) => option.label),
  // 좁은 pane 에서 줄 바뀐 행은 「선택지 글 + 설명」 으로 복원해 비교한다(R4-A2).
  descriptions: question.options.map((option) => option.description),
  multiSelect: question.multiSelect,
  preview: question.preview === true,
})

/** 기록 문항 → 키 만들기용 모양. */
const answerShape = (question: QuestionItem['questions'][number]): { options: number; multiSelect: boolean | null; preview: boolean } => ({
  options: question.options.length,
  multiSelect: question.multiSelect,
  preview: question.preview === true,
})

/** 키 묶음 앞 화면 확인 결과 — `go`(그 문항, `checked` = 이미 체크된 칸) · `skip` · `busy`(맥에서 고르는 중) · `truncated`(좁은 pane 에서 잘려 복원 불가 — R4-A2) · `other`(다른 화면). */
type ScreenCheck = { kind: 'go'; checked: number[] } | { kind: 'skip' } | { kind: 'busy' } | { kind: 'truncated' } | { kind: 'other' }

export class InputHub {
  private readonly deps: InputHubDeps
  private readonly timing: InputTiming
  private readonly entries = new Map<string, Entry>()
  /** 기억 상한에서 밀린 (기기, id) — 다시 넣지 않는다(R1-A6). */
  private readonly retired = new Set<string>()
  /** 해지된 기기(R1-A1). */
  private readonly revoked = new Set<string>()
  private readonly sinks = new Map<string, (text: string) => void>()
  private readonly pumps = new Set<string>()
  private readonly busy = new Set<string>()
  /** 허브 자기 쓰기 — pane 별 쓰기 직전 입력 revision → 쓴 뒤 revision(LIFE-598 r2). */
  private readonly selfWrites = new Map<string, Map<number, Link>>()
  /** pane 별 진행 중인 자기 쓰기 수(LIFE-598 r3 — 그동안 대기 지시는 사슬 밖 revision 을 실패로 단정하지 않고, 효과를 내지 않는다). */
  private readonly writing = new Map<string, number>()
  private order = 0
  /** 모바일 활성 세대 — `stop()` 마다 올린다. 이전 세대의 요청은 효과를 내지 않는다(R1-A4). */
  private generation = 0
  private stopped = false

  constructor(deps: InputHubDeps) {
    this.deps = deps
    this.timing = { ...INPUT_TIMING, ...deps.timing }
  }

  /** 기기의 지금 연결 — 상태 변화는 그 기기의 마지막으로 붙은 연결로 간다. 돌려준 함수로 뗀다(그 연결이 아직 주인일 때만). 끊김은 큐를 건드리지 않는다. */
  attach(input: { device: string; sink: (text: string) => void }): () => void {
    this.sinks.set(input.device, input.sink)
    return () => {
      if (this.sinks.get(input.device) === input.sink) this.sinks.delete(input.device)
    }
  }

  /** 모바일 켬 — 끈 동안 실패로 끝난 것은 그대로 기억한다(조회하면 실패). */
  start(): void {
    this.stopped = false
  }

  /** 모바일 끔·종료(P3) — 활성 세대를 바꾸고 큐의 지시는 실패로 끝낸다. 넣는 중인 요청은 다음 효과 직전에 멈춘다. 기억한 id 는 남긴다(조회용). */
  stop(): void {
    this.stopped = true
    this.generation += 1
    for (const entry of this.entries.values()) {
      if (entry.state === 'queued') this.settle(entry, 'failed', 'mobile_off')
    }
  }

  /**
   * 기기 해지(P8, R1-A1) — 그 기기의 아직 내지 않은 요청을 끝내고 결과도 보내지 않는다. 넣는 중인 요청은 다음 효과 직전에 멈춘다.
   * 연결이 끊긴 것(폰 화면 끔)과 다르다 — 그때는 큐가 남는다.
   */
  revoke(device: string): void {
    this.revoked.add(device)
    this.sinks.delete(device)
    for (const entry of this.entries.values()) {
      if (entry.device === device && entry.state === 'queued') this.settle(entry, 'failed', 'revoked')
    }
  }

  /** 시험·계측 — 그 채널의 큐 길이. */
  queued(channel: string): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.channel === channel && entry.op === 'send' && entry.state === 'queued') count += 1
    return count
  }

  // --- 폰 메시지 ---

  send(input: { device: string; id: string; channel: string; text: string }): void {
    if (this.repeat(input)) return
    const text = cleanBody(input.text)
    const entry = this.add({ device: input.device, id: input.id, channel: input.channel, op: 'send', text, question: null, call: null, digest: null, answers: null })
    this.deps.log('mobile.input_send', { bytes: Buffer.byteLength(text), sha: short(normalizeBody(text)) })
    const gone = this.gone(entry)
    if (gone !== null) return this.settle(entry, 'failed', gone)
    if (normalizeBody(text).length === 0) return this.settle(entry, 'failed', 'empty')
    const located = this.locate(input.channel)
    if (!located.ok) return this.settle(entry, 'failed', located.reason)
    if (this.queued(input.channel) > INPUT_QUEUE_MAX) return this.settle(entry, 'failed', 'queue_full')
    this.emit(entry)
    void this.bind(entry, located.channel).catch((error: unknown) => {
      this.deps.log('mobile.input_error', { op: 'send', error: String(error) })
      if (entry.state === 'queued') this.settle(entry, 'failed', 'backend')
    })
  }

  cancel(input: { device: string; id: string }): void {
    const entry = this.entries.get(this.key(input))
    if (entry === undefined) return this.emitUnknown(input)
    // 취소는 큐의 지시만(R2-A9) — 답·중단은 접수 즉시 넣기를 시작한다. 취소를 받았다고 답한 뒤 키를 넣지 않게 지금 상태만 돌려준다.
    if (entry.state === 'queued' && entry.op === 'send') return this.settle(entry, 'cancelled', null)
    this.emit(entry)
  }

  status(input: { device: string; ids: string[] }): void {
    for (const id of input.ids) {
      const entry = this.entries.get(this.key({ device: input.device, id }))
      if (entry === undefined) this.emitUnknown({ device: input.device, id })
      else this.emit(entry)
    }
  }

  /** 복구 조회(R1-A8) — 이 기기의 끝나지 않은 요청 전부를 보낸다. 지시는 본문까지(폰이 잊었을 수 있다). */
  pending(input: { device: string }): void {
    const open = [...this.entries.values()].filter((entry) => entry.device === input.device && !FINAL.has(entry.state)).sort((a, b) => a.order - b.order)
    for (const entry of open) this.emit(entry, { withText: true })
  }

  answer(input: { device: string; id: string; channel: string; question: number; call: string | null; digest: string | null; answers: { choices: number[]; other: string | null }[] }): void {
    if (this.repeat(input)) return
    const answers = cleanAnswers(input.answers)
    const entry = this.add({ device: input.device, id: input.id, channel: input.channel, op: 'answer', text: null, question: input.question, call: input.call, digest: input.digest, answers })
    this.deps.log('mobile.input_answer', { questions: input.answers.length })
    const gone = this.gone(entry)
    if (gone !== null) return this.settle(entry, 'failed', gone)
    if (answers === null) return this.settle(entry, 'failed', 'bad_answer')
    void this.exclusive(entry, () => this.runAnswer(entry, answers))
  }

  stopTurn(input: { device: string; id: string; channel: string }): void {
    if (this.repeat(input)) return
    const entry = this.add({ device: input.device, id: input.id, channel: input.channel, op: 'stop', text: null, question: null, call: null, digest: null, answers: null })
    this.deps.log('mobile.input_stop', {})
    const gone = this.gone(entry)
    if (gone !== null) return this.settle(entry, 'failed', gone)
    void this.exclusive(entry, () => this.runStop(entry))
  }

  // --- 큐 ---

  /** 접수 직후 대상을 묶는다(R1-A5) — 그 뒤에 큐가 돈다. */
  private async bind(entry: Entry, channel: ChatChannel): Promise<void> {
    const backend = this.deps.backend()
    if (backend === null) return this.settle(entry, 'failed', 'not_ready')
    const pane = await backend.locate(entry.channel)
    if (this.dropped(entry)) return
    if (pane === null) return this.settle(entry, 'failed', 'closed')
    // LIFE-598 r2: 접수 때의 입력 revision(R0) — 효과는 이 값 그대로일 때만 쓴다. revision 이 없는 guard 는 울타리를 못 친다(fail-closed).
    const observed = await backend.observe(pane)
    if (this.dropped(entry)) return
    if (observed.status === 'none') return this.settle(entry, 'failed', 'closed')
    if (observed.input === null) return this.settle(entry, 'failed', 'guard_outdated')
    entry.bind = { epoch: pane.epoch, ptyId: pane.ptyId, session: sessionKey(channel.session), observed: boundSessionKey(channel.session), revision: observed.input.revision }
    void this.pump(entry.channel)
  }

  private async pump(channel: string): Promise<void> {
    if (this.pumps.has(channel)) return
    this.pumps.add(channel)
    try {
      for (;;) {
        const head = this.head(channel)
        if (head === null || this.stopped) return
        const outcome = await this.deliver(head).catch((error: unknown): 'done' => {
          this.deps.log('mobile.input_error', { op: 'send', error: String(error) })
          // 넣기 전이면 넣지 않았다 — 실패. 넣기 시작한 뒤면 들어갔을 수 있다 — 확인 못 함(다시 넣지 않는다).
          if (head.state === 'queued') this.settle(head, 'failed', 'backend')
          else if (head.state === 'sending') this.settle(head, 'unconfirmed', 'backend')
          return 'done'
        })
        if (outcome === 'wait') await this.sleep(this.timing.pollMs)
      }
    } finally {
      this.pumps.delete(channel)
    }
  }

  /** 큐 머리 — 아직 묶이지 않은 머리가 있으면 기다린다(순서를 건너뛰지 않는다). */
  private head(channel: string): Entry | null {
    let first: Entry | null = null
    for (const entry of this.entries.values()) {
      if (entry.channel !== channel || entry.op !== 'send' || entry.state !== 'queued') continue
      if (first === null || entry.order < first.order) first = entry
    }
    return first === null || first.bind === null ? null : first
  }

  /** 큐 머리 한 건 — 관문을 못 넘으면 `wait`, 끝났으면(들어감·실패·확인 못 함) `done`. 모든 await 뒤에 `dropped` 를 본다. */
  private async deliver(entry: Entry): Promise<'wait' | 'done'> {
    const bind = entry.bind
    if (bind === null) return 'wait'
    const located = this.locate(entry.channel)
    if (!located.ok) {
      if (located.reason === 'not_ready') return 'wait'
      return this.fail(entry, located.reason === 'not_listed' ? 'closed' : located.reason)
    }
    const { channel, kind } = located
    if (sessionKey(channel.session) !== bind.session) return this.moved(entry, 'list')
    const backend = this.deps.backend()
    if (backend === null) return 'wait'
    const pane = await backend.locate(entry.channel)
    if (this.dropped(entry)) return 'done'
    if (pane === null) return this.fail(entry, 'closed')
    if (pane.epoch !== bind.epoch || pane.ptyId !== bind.ptyId) return this.moved(entry, 'pane')
    const resolved = this.fileFor({ channel, cwd: pane.path })
    if (resolved.kind === 'wait') return 'wait'
    if (resolved.kind === 'fail') return this.fail(entry, resolved.reason)
    const first = await backend.observe(pane)
    if (this.dropped(entry)) return 'done'
    // 관리 밖 pane 인데 guard 가 그 갈래를 모른다(설치본 herdr 서버를 재기동하기 전) — 기다려도 넣을 수 없다. 대기로 두면 블랙홀이다(LIFE-597 U5).
    if (first.unmanaged && !backend.unmanagedPrompt()) return this.fail(entry, 'guard_outdated')
    // LIFE-598 r2: 접수 뒤 맥 입력 — 턴이 끝나기를 기다리지 않고 바로 끝낸다(넣을 일이 없다).
    // r3: 울타리는 비교할 때마다 새로 읽는다(`fenceRead`) — await 사이 끝난 자기 쓰기로 낡은 지역 값과 비교하지 않는다.
    if (first.input !== null && this.fenceRead(bind, first.input.revision) === 'moved') return this.moved(entry, 'input')
    if (!first.quiet) return this.waitTurn(entry, 'turn')
    this.setWait(entry, 'gate')
    await this.sleep(this.timing.gateMs)
    if (this.dropped(entry)) return 'done'
    const second = await backend.observe(pane)
    if (this.dropped(entry)) return 'done'
    if (!second.quiet || second.seq !== first.seq) return this.waitTurn(entry, 'turn')
    const manifest = await backend.manifestVerified(kind)
    if (this.dropped(entry)) return 'done'
    if (!manifest) return this.waitTurn(entry, 'turn')
    // 입력 revision 이 없는 guard 는 화면을 읽은 뒤의 맥 타자를 막지 못한다 — 넣지 않는다(R1-A3, fail-closed).
    if (second.input === null) return this.fail(entry, 'guard_outdated')
    const secondRead = this.fenceRead(bind, second.input.revision)
    if (secondRead === 'moved') return this.moved(entry, 'input')
    if (secondRead === 'behind') return this.waitTurn(entry, 'gate')
    const shot = await backend.screen(pane)
    if (this.dropped(entry)) return 'done'
    // R2-A3: 화면과 **같은 guard 턴**의 입력 revision·조용한 시간·seq 로 판단한다. 화면을 잡을 때 입력이 `quietMs` 이상 조용했어야
    // 그 화면이 마지막 입력의 echo 까지 보인다. 넣기는 울타리 revision 그대로일 때만 — 그러면 넣는 순간까지 접수 뒤 입력이 없다(LIFE-598 r2).
    if (shot.input === null || shot.seq === null) return this.fail(entry, 'guard_outdated')
    if (shot.seq !== second.seq) return this.waitTurn(entry, 'turn')
    const shotRead = this.fenceRead(bind, shot.input.revision)
    if (shotRead === 'moved') return this.moved(entry, 'input')
    if (shotRead === 'behind') return this.waitTurn(entry, 'gate')
    if (shot.input.idleMs < this.timing.quietMs) return this.waitTurn(entry, 'gate')
    // agent view 의 입력은 이 대화로 가지 않는다 — 초안 판정보다 먼저(LIFE-770). 자리표시가 흐림이면 draftState 는 빈 입력으로 읽는다.
    if (agentViewShown({ kind, screen: shot.text })) return this.fail(entry, 'agent_view')
    const draft = draftState({ kind, screen: shot.text })
    if (draft !== 'empty') return this.fail(entry, draft === 'draft' ? 'mac_draft' : 'draft_unknown')
    // LIFE-598: 효과 직전 herdr 를 **다시** 본다 — `second` 뒤 `manifestVerified`·`screen` 동안의 전이·세션 교체도 여기서 잡힌다(세션은 보조).
    // 이 관측과 `prompt` 사이에는 await 가 없다. 그 뒤의 키는 guard 가 같은 턴에서 울타리 revision 으로 거절한다.
    const last = await backend.observe(pane)
    if (this.dropped(entry)) return 'done'
    if (last.seq !== second.seq) return this.waitTurn(entry, 'turn')
    if (last.input === null) return this.fail(entry, 'guard_outdated')
    const lastRead = this.fenceRead(bind, last.input.revision)
    if (lastRead === 'moved') return this.moved(entry, 'input')
    if (lastRead === 'behind') return this.waitTurn(entry, 'gate')
    const text = entry.text ?? ''
    // 파일과 세션 id 쌍은 커서 직전에 다시 푼다(LIFE-766) — 위 관문을 기다리는 사이에 세션이 이어 갔을 수 있다. 커서와 확인이 이 쌍을 같이 쓴다.
    const record = this.fileFor({ channel, cwd: pane.path })
    if (record.kind === 'wait') return 'wait'
    if (record.kind === 'fail') return this.fail(entry, record.reason)
    const cursor = tailCursor(record.file)
    if (cursor === null) return this.fail(entry, 'record_unreadable')
    const submittedAtMs = this.now()
    // 여기서부터 취소 불가 — 넣기 시작. 효과 직전 마지막 확인(해지·끔 · 접수 때 묶은 provider 세션 — 목록 R2-A4 + herdr 관측 `last` LIFE-598).
    const gone = this.gone(entry)
    if (gone !== null) return this.fail(entry, gone)
    const moved = this.sessionMoved(entry, last)
    if (moved !== null) return this.moved(entry, moved)
    // 같은 pane 에 다른 자기 쓰기(답·중단 키)가 진행 중이면 그것이 끝난 뒤의 울타리로 — 지금은 넣지 않는다(r3).
    if (this.writingOn(bind)) return this.waitTurn(entry, 'gate')
    const fence = this.fenceOf(bind)
    entry.state = 'sending'
    entry.wait = null
    this.emit(entry)
    // r3: 사슬 고리를 쓰기 **전에** 건다(guard 는 같은 턴에서 revision 을 정확히 1 올린다 — `queue_user_input_submission` → `corral_note_input`).
    const write = this.beginWrite({ pane: bind, before: fence })
    // 들어갔으면 다시 관측해 +1 일 때만 확정(R4-C3). 거절은 쓰지 않았으니 거둔다. `unknown`·reject 는 썼을 수 있지만 몇 번인지 모른다 — 거둔다
    // (뒤 항목은 `mac_input`, 쓰지 않는 쪽). reject 도 진행 표시를 남기지 않게 `finally`(R4-C2).
    let sent: SendResult = 'unknown'
    try {
      sent = await backend.prompt(pane, { text, seq: last.seq, inputRevision: fence, minIdleMs: this.timing.quietMs, unmanagedAgent: last.unmanaged ? kind : null })
      if (sent === 'sent') await this.endUnreported({ write, backend, pane })
    } finally {
      this.endWrite(write, sent === 'refused' ? { kind: 'refused' } : { kind: 'unknown' })
    }
    if (sent === 'refused') {
      // guard 가 거절 — 아무것도 쓰지 않았다. 그 사이 끄거나 해지했으면 끝낸다(되살리지 않는다, R1-A4).
      const late = this.gone(entry)
      if (late !== null) return this.fail(entry, late)
      entry.state = 'queued'
      // LIFE-598 r2: 거절 이유를 다시 본다 — 입력이 울타리를 넘었으면(접수 뒤 맥 입력) 큐로 돌리지 않고 실패, 아니면(상태 전이) 다음 관문을 기다린다.
      const after = await backend.observe(pane)
      if (this.dropped(entry)) return 'done'
      if (after.input === null) return this.fail(entry, 'guard_outdated')
      // 비교는 지금의 사슬로(r3 — 거절과 겹친 자기 쓰기가 끝났으면 그 값도 남의 입력이 아니다).
      if (this.fenceRead(bind, after.input.revision) === 'moved') return this.moved(entry, 'input_refused')
      return this.waitTurn(entry, 'turn')
    }
    await this.confirmSend({ entry, kind, cursor, submittedAtMs, text, sessionId: record.continuedAs ?? (channel.session.kind === 'id' ? channel.session.id : null) })
    return 'done'
  }

  /** 쓰기용 기록 파일 — 유일한 후보, 또는 0건이 확실할 때만 그 세션이 쓸 경로(R1-A13). */
  private fileFor(input: { channel: ChatChannel; cwd: string }): { kind: 'file'; file: string; continuedAs: string | null } | { kind: 'wait' } | { kind: 'fail'; reason: string } {
    const resolved = this.deps.resolveFile(input.channel)
    switch (resolved.kind) {
      case 'found':
        return { kind: 'file', file: resolved.file, continuedAs: resolved.continuedAs ?? null }
      case 'ambiguous':
        return { kind: 'fail', reason: 'record_ambiguous' }
      case 'error':
        return { kind: 'wait' }
      case 'none': {
        const expected = this.deps.expectedFile?.(input) ?? null
        return expected === null ? { kind: 'wait' } : { kind: 'file', file: expected, continuedAs: null }
      }
    }
  }

  /**
   * 접수 때 묶은 provider 세션이 바뀌었나 — 효과 직전에 await 없이 본다(보조 — 결정적인 것은 입력 revision 울타리). 둘 중 하나라도 다르면 바뀐 것이다:
   * - 목록(R2-A4): 지금 목록의 그 채널 세션. 채널이 사라졌어도 바뀐 것이다. 목록은 이 프로세스의 상태라 이 확인과 효과 호출 사이에 바뀌지 않는다.
   * - herdr 관측(LIFE-598): 효과 호출 바로 앞에서 다시 한 `observe` 의 `agent_session`. 목록보다 빨리 바뀌지만 상한이 없다(리뷰 r2 실측 최대 ≈ 6 s) —
   *   접수 뒤 `/clear` 는 revision 울타리가 막고, 이 대조는 접수 **전** `/clear` 를 herdr 만 먼저 안 때를 줍는다.
   *   관측에 세션이 없으면(null) 같은 세션임을 증명 못 한다 — 바뀐 것으로 본다(fail-closed, 기다리지 않으니 블랙홀도 없다).
   *   예외: corral 이 `claude attach` 로 푼 세션(LIFE-769)은 묶을 때 관측 키가 null 이다(`boundSessionKey`) — 그 pane 은 herdr 가 참조를 주지 않으므로
   *   null 이 같은 상태이고, 같은 세션인지는 목록 대조(해소기가 세션 조회마다 argv 를 다시 본다)와 revision 울타리가 본다.
   */
  private sessionMoved(entry: Entry, observed: PaneObservation): 'herdr_session' | 'list' | null {
    if (entry.bind === null) return null
    if (observed.session !== entry.bind.observed) return 'herdr_session'
    const located = this.locate(entry.channel)
    if (!located.ok) return 'list'
    return sessionKey(located.channel.session) !== entry.bind.session ? 'list' : null
  }

  /**
   * 접수 때의 R0 에서 허브 자기 쓰기 사슬을 따라간 값들(LIFE-598 r2·r3) — 마지막이 효과의 울타리. 사슬 위의 값은 모두 허브가 만든 상태다
   * (고리는 그 쓰기의 울타리 = guard 가 같은 턴에서 확인한 직전 revision 에서만 건다). 고리는 늘 증가하는 쪽만 걸지만(`beginWrite`·`endWrite`),
   * 순환·자기 고리를 코드로도 막는다 — 본 값에 다시 오거나 `SELF_WRITES_MAX` 를 넘으면 멈춘다(R3-C3).
   */
  private chainOf(bind: Bind): number[] {
    const chain = this.selfWrites.get(paneKey(bind))
    const values = [bind.revision]
    for (let step = 0; step < SELF_WRITES_MAX; step += 1) {
      const next = chain?.get(values[values.length - 1]!)?.after
      if (next === undefined || values.includes(next)) break
      values.push(next)
    }
    return values
  }

  /** 효과의 입력 울타리 — 사슬의 끝값. */
  private fenceOf(bind: Bind): number {
    const values = this.chainOf(bind)
    return values[values.length - 1]!
  }

  /**
   * 관측한 입력 revision 이 접수 뒤 남의 입력이 없음을 말하나(r3). 사슬 끝 = `ok`, 사슬 중간 = `behind`(관측 뒤 자기 쓰기가 끝났다 — 다시 본다),
   * 사슬 밖인데 그 pane 에 자기 쓰기가 진행 중이면 `behind`(쓰기 응답 전 관측일 수 있다 — 끝난 뒤 다시 본다, R3-C2), 아니면 `moved`.
   */
  private fenceRead(bind: Bind, revision: number): FenceRead {
    const values = this.chainOf(bind)
    if (revision === values[values.length - 1]) return 'ok'
    if (values.includes(revision) || this.writingOn(bind)) return 'behind'
    return 'moved'
  }

  private writingOn(pane: { epoch: string; ptyId: string }): boolean {
    return (this.writing.get(paneKey(pane)) ?? 0) > 0
  }

  /**
   * 허브 자기 쓰기 시작(LIFE-598 r3 — R3-C2) — 쓰기 **전에** `before → before + 1` 고리를 걸고 진행 표시를 올린다. 그래서 쓰기가 guard 에서 일어난 뒤
   * 응답이 오기 전에 대기 지시가 새 revision 을 봐도 사슬 위의 값이다. `before` = 그 쓰기의 울타리(guard 가 같은 턴에서 확인하는 값,
   * 울타리 없는 중단 키는 바로 앞 관측값 — 그 사이 맥 입력이 끼면 실제 revision 이 고리 끝을 넘어 뒤 지시는 `mac_input`, 쓰지 않는 쪽).
   * 같은 직전 값에서 이미 고리가 있으면(겹친 자기 쓰기) 그 고리에 몫만 더한다. 다른 끝값의 고리가 있으면 걸지 않는다.
   */
  private beginWrite(input: { pane: { epoch: string; ptyId: string }; before: number }): SelfWrite {
    const key = paneKey(input.pane)
    this.writing.set(key, (this.writing.get(key) ?? 0) + 1)
    const token = Symbol('self-write')
    const chain = this.selfWrites.get(key) ?? new Map<number, Link>()
    this.selfWrites.set(key, chain)
    const existing = chain.get(input.before)
    const after = input.before + 1
    if (existing !== undefined && existing.after !== after) return { key, before: input.before, token, link: null, closed: false }
    const link = existing ?? { after, owners: new Set<symbol>(), confirmed: false }
    link.owners.add(token)
    chain.set(input.before, link)
    if (chain.size > SELF_WRITES_MAX) {
      const oldest = chain.keys().next()
      if (oldest.done !== true) chain.delete(oldest.value)
    }
    return { key, before: input.before, token, link, closed: false }
  }

  /**
   * 허브 자기 쓰기 끝 — `sent` 면 고리 확정(`after` = 쓴 뒤 revision. `after ≤ before` 면 고리를 걸지 않는다 — 뒤 항목은 `mac_input`, R3-C3).
   * `refused`·`unknown`(백엔드 reject 포함 — 부르는 쪽이 `finally` 로 닫는다, R4-C2)이면 이 쓰기의 몫을 거두고, 아무도 확정하지 않은 고리는 지운다. 두 번째 호출은 무시한다.
   */
  private endWrite(write: SelfWrite, outcome: WriteOutcome): void {
    if (write.closed) return
    write.closed = true
    const count = (this.writing.get(write.key) ?? 1) - 1
    if (count > 0) this.writing.set(write.key, count)
    else this.writing.delete(write.key)
    const { link } = write
    if (link === null) {
      this.dropEmptyChain(write.key)
      return
    }
    link.owners.delete(write.token)
    const chain = this.selfWrites.get(write.key)
    if (outcome.kind === 'sent') {
      if (outcome.after <= write.before) {
        if (link.owners.size === 0 && !link.confirmed) chain?.delete(write.before)
        this.dropEmptyChain(write.key)
        return
      }
      link.after = outcome.after
      link.confirmed = true
      return
    }
    if (link.owners.size === 0 && !link.confirmed) chain?.delete(write.before)
    this.dropEmptyChain(write.key)
  }

  /** 고리가 하나도 남지 않은 pane 의 사슬 Map 은 버린다(R5-C5 — pane·PTY 세대마다 빈 Map 이 쌓이지 않게). 진행 중인 쓰기가 있으면 남긴다. */
  private dropEmptyChain(key: string): void {
    if (this.selfWrites.get(key)?.size === 0 && !this.writing.has(key)) this.selfWrites.delete(key)
  }

  /** 시험·계측 — 사슬 Map 을 가진 pane 수. */
  selfWritePanes(): number {
    return this.selfWrites.size
  }

  /**
   * 응답에 쓴 뒤 revision 이 없는 자기 쓰기(지시 `agent.prompt` · 울타리 없는 중단 키)의 끝(R4-C3) — 예측 +1 을 그대로 믿지 않고 끝난 뒤 다시 관측해
   * 직전+1 일 때만 확정한다. 아니면(+0 — guard 계약 깨짐 · +2 이상 — 그 사이 맥 입력 · 관측 실패) 고리를 거둔다: +0 이면 뒤 지시는 R0 그대로 울타리라 넣고(영구 `behind` 없음),
   * 맥 입력이 끼었으면 실제 revision 이 사슬 밖이라 `mac_input`(쓰지 않는 쪽). 남는 창: guard 가 +0 인데 맥 키가 쓰기와 이 관측 사이(RPC 한 번)에 든 경우.
   */
  private async endUnreported(input: { write: SelfWrite; backend: InputBackend; pane: TerminalIdentity }): Promise<void> {
    const seen = await input.backend.observe(input.pane).catch(() => null)
    const revision = seen?.input?.revision ?? null
    this.endWrite(input.write, revision === input.write.before + 1 ? { kind: 'sent', after: revision } : { kind: 'unknown' })
  }

  /**
   * 지시가 효과 직전 대조에 걸렸다 — 입력 울타리(`input`·`input_refused`, 접수 뒤 남의 입력)면 `mac_input`(LIFE-709), 목록·pane·herdr 세션이면 `target_changed`.
   * 무엇이 걸렸는지 로그에도 남긴다(실물 회차가 목록·herdr·입력 울타리 중 무엇이 막았는지 가른다).
   */
  private moved(entry: Entry, check: MovedCheck): 'done' {
    this.deps.log('mobile.input_target_changed', { op: entry.op, check })
    return this.fail(entry, check === 'input' || check === 'input_refused' ? 'mac_input' : 'target_changed')
  }

  private fail(entry: Entry, reason: string): 'done' {
    this.settle(entry, 'failed', reason)
    return 'done'
  }

  /** await 뒤 — 그 사이 취소·끝났거나(state) 해지·끔이면(끝낸다) 더 하지 않는다. */
  private dropped(entry: Entry): boolean {
    if (entry.state !== 'queued') return true
    const gone = this.gone(entry)
    if (gone === null) return false
    this.settle(entry, 'failed', gone)
    return true
  }

  /** 이 요청이 더 효과를 내면 안 되는 이유 — 해지(R1-A1) · 모바일 끔·세대 바뀜(R1-A4). */
  private gone(entry: Entry): 'revoked' | 'mobile_off' | null {
    if (this.revoked.has(entry.device) || this.deps.deviceValid?.(entry.device) === false) return 'revoked'
    if (this.stopped || entry.gen !== this.generation) return 'mobile_off'
    return null
  }

  private waitTurn(entry: Entry, wait: InputWait): 'wait' {
    this.setWait(entry, wait)
    return 'wait'
  }

  private setWait(entry: Entry, wait: InputWait): void {
    if (entry.state !== 'queued' || entry.wait === wait) return
    entry.wait = wait
    this.emit(entry)
  }

  private async confirmSend(input: { entry: Entry; kind: MobileAgentKind; cursor: TailCursor; submittedAtMs: number; text: string; sessionId: string | null }): Promise<void> {
    const { entry, cursor } = input
    const identity = bodyIdentity(input.text)
    const deadline = this.now() + this.timing.confirmMs
    // 커서 뒤 꼬리만 CLI 와 같은 대조에 넣는다 — 꼬리 앞(커서) 줄은 이미 잘라 냈다.
    const after = [{ path: cursor.file, existed: cursor.existed, bytes: 0, lines: 0 }]
    for (;;) {
      const tail = tailSince(cursor)
      if (tail.rewritten) return this.settle(entry, 'unconfirmed', 'record_rewritten')
      // 이 접수 뒤·이 세션의 줄만 근거로 센다(R3-A4·A5).
      const text = tail.text === null ? null : submissionLines({ kind: input.kind, text: tail.text, sessionId: input.sessionId, sinceMs: input.submittedAtMs })
      const count = text === null ? null : countSubmissions({ kind: input.kind, files: [cursor.file], identity, submittedAtMs: input.submittedAtMs, cursor: after, read: () => text })
      if (count !== null && count.matchCount > 1) return this.settle(entry, 'unconfirmed', 'record_ambiguous')
      if (count !== null && count.matchCount === 1) {
        this.deps.log('mobile.input_delivered', { ms: this.now() - input.submittedAtMs })
        return this.settle(entry, 'delivered', null)
      }
      if (this.now() >= deadline) return this.settle(entry, 'unconfirmed', 'record_missing')
      await this.sleep(this.timing.recordPollMs)
    }
  }

  // --- 질문 답 ---

  /**
   * 질문 답(P4 · R2-A1). 같은 질문의 증명:
   * - 기록: 그 말풍선 id + 도구 호출 id 가 마지막 대기 질문이고, 그 내용 지문이 폰이 본 지문과 같다(같은 id·호출에 다른 내용이면 거절).
   * - 세션: 접수 때의 provider 세션이 키마다 그대로다(목록 + 키 전 herdr 관측 — LIFE-598, 보조).
   * - 화면: 키 묶음마다 그 앞에서, 입력이 `quietMs` 이상 조용할 때 잡은 화면의 **활성 질문 영역**(맨 아래 질문 상자)이 그 문항이다.
   *   화면 위쪽 과거 글은 보지 않는다. Codex 는 접힌 표시의 문항 수를 본 뒤 ⇧← 로 열고 다시 본다.
   * - 입력: 접수 때(`before` 관측)의 입력 revision(R0)에서 시작해 키마다 guard 가 돌려준 revision 으로 다음 키를 울타리 친다(LIFE-598 r2) —
   *   첫 키 묶음의 화면도 R0 그대로여야 한다. 접수 뒤 다른 클라이언트의 입력(맥의 `/clear` 포함)이 끼면 그 키부터 넣지 않는다.
   * 증명 못 하면 키 0회로 실패(키가 이미 들어갔으면 `unconfirmed`). 들어감 = 커서 뒤 기록에 그 호출의 답 정확히 1건 + 판독자에서 대기 해소.
   */
  private async runAnswer(entry: Entry, answers: QuestionAnswer[]): Promise<void> {
    const located = this.locate(entry.channel)
    if (!located.ok) return this.settle(entry, 'failed', located.reason === 'not_listed' ? 'closed' : located.reason)
    const { channel, kind } = located
    const backend = this.deps.backend()
    if (backend === null) return this.settle(entry, 'failed', 'not_ready')
    // 폰이 본 질문의 도구 호출 id·내용 지문이 없으면 같은 질문인지 대조할 수 없다 — 잠근다(R1-A2·R2-A1).
    const { call, digest } = entry
    if (call === null || digest === null) return this.settle(entry, 'failed', 'question_changed')
    const pane = await backend.locate(entry.channel)
    if (this.halted(entry)) return
    if (pane === null) return this.settle(entry, 'failed', 'closed')
    const resolved = this.deps.resolveFile(channel)
    if (resolved.kind !== 'found') return this.settle(entry, 'failed', resolved.kind === 'ambiguous' ? 'record_ambiguous' : 'not_ready')
    const { file } = resolved
    await this.deps.questionReady?.(file)
    if (this.halted(entry)) return
    const question = this.openQuestion({ file, id: entry.question, call })
    if (question === null) return this.settle(entry, 'failed', 'question_closed')
    if (questionDigest(question.questions) !== digest) return this.settle(entry, 'failed', 'question_changed')
    const plan = answerGroups({
      kind,
      questions: question.questions.map(answerShape),
      answers,
    })
    if (!plan.ok) return this.settle(entry, 'failed', plan.reason === 'bad_answer' ? 'bad_answer' : plan.reason === 'other_locked' ? 'other_locked' : 'question_locked')
    const before = await backend.observe(pane)
    if (this.halted(entry)) return
    if (before.status !== 'blocked') return this.settle(entry, 'failed', 'question_closed')
    // LIFE-598 r2: 접수 때의 입력 revision(R0) — 첫 키의 울타리. 이 관측 앞은 동기 확인뿐이라 접수 시점이다.
    if (before.input === null) return this.settle(entry, 'failed', 'guard_outdated')
    const bind: Bind = { epoch: pane.epoch, ptyId: pane.ptyId, session: sessionKey(channel.session), observed: boundSessionKey(channel.session), revision: before.input.revision }
    entry.bind = bind
    const cursor = tailCursor(file)
    if (cursor === null) return this.settle(entry, 'failed', 'record_unreadable')
    // R4-C4: 같은 pane 의 다른 자기 쓰기(지시)가 진행 중이면 그 고리가 확정·회수될 때까지 기다린다 — 미확정 고리 끝을 첫 키 울타리로 쓰지 않는다.
    // 기한(`answerConfirmMs`)을 넘기면 키 0회 `busy`(블랙홀 없음).
    const settleBy = this.now() + this.timing.answerConfirmMs
    while (this.writingOn(bind)) {
      if (this.now() >= settleBy) return this.settle(entry, 'failed', 'busy')
      await this.sleep(this.timing.recordPollMs)
      if (this.halted(entry)) return
    }
    let revision = this.fenceOf(bind)
    // LIFE-708 r1: 답은 모든 입력(클릭 포함) 울타리도 친다 — 접수 때 값에서 자기 쓰기 사슬이 올린 만큼(자기 쓰기는 두 값을 같이 1씩 올린다)을 더한다.
    // 이전 guard(`anyInput` 없음)는 마우스도 초안 revision 에 세므로 초안 울타리만으로 같다 — 이 울타리를 치지 않는다.
    const anyFenced = before.anyInput !== null
    let anyRevision = (before.anyInput?.revision ?? before.input.revision) + (revision - bind.revision)
    const anyMoved = (seen: { input: InputMark; anyInput: InputMark | null }): boolean => anyFenced && (seen.anyInput === null || seen.anyInput.revision !== anyRevision)
    let sent = 0
    // 키가 들어간 뒤의 실패는 확인 못 함 — 일부 키가 들어갔을 수 있다.
    const stop = (reason: string): void => this.settle(entry, sent === 0 ? 'failed' : 'unconfirmed', reason)
    for (let group = 0; group < plan.groups.length; group += 1) {
      const { check } = plan.groups[group]!
      if (group > 0) await this.sleep(this.timing.stepGapMs)
      const shot = await this.quietScreen({ backend, pane, minIdleMs: this.timing.quietMs, any: anyFenced })
      if (this.halted(entry, sent)) return
      if (shot === null) return stop('question_changed')
      if (shot.input === null || shot.seq === null) return stop('guard_outdated')
      // 화면도 울타리 revision 그대로여야 한다 — 첫 묶음은 R0(접수 뒤 맥 입력이면 키 0), 다음 묶음은 앞 키가 돌려준 revision(R2-G2).
      if (shot.seq !== before.seq) return stop('question_changed')
      if (shot.input.revision !== revision) return this.answerMoved({ stop, entry, sent })
      // 키 앞 observe 대조(아래)와 중복 방어 — 같은 클릭은 그쪽도 잡는다. 화면이 그 클릭 뒤 값이면 그 화면으로 키를 고르지 않게 여기서 먼저 끝낸다.
      if (anyMoved({ input: shot.input, anyInput: shot.anyInput })) return this.answerMoved({ stop, entry, sent, any: true })
      const shown = this.screenMatches({ kind, check, screen: shot.text, questions: question.questions })
      if (shown.kind === 'skip') continue
      // 맥에서 이미 고르는 중(커서·체크·직접 입력 글·문항 진행) — 거기서 폰 답으로 가는 키를 셀 수 없으면 넣지 않는다(R3-A1·D3).
      if (shown.kind === 'busy') return stop('question_in_progress')
      // 좁은 맥 pane 에서 질문이 잘려 보여 그 문항임을 복원할 수 없다(R4-A2) — 원인이 보이는 이유로 키 0회.
      if (shown.kind === 'truncated') return stop('question_truncated')
      if (shown.kind === 'other') return stop('question_changed')
      // Claude multiSelect 의 체크만 있는 상태 — 바뀌어야 하는 칸만 뒤집는 키로 다시 센다(R3-A1).
      const keys =
        check.kind === 'question' && shown.checked.length > 0
          ? questionKeys({ kind, question: answerShape(question.questions[check.index]!), answer: answers[check.index]!, checked: shown.checked })
          : plan.groups[group]!.keys
      if (keys.some((key) => key.length === 0)) return stop('question_in_progress')
      if (this.openQuestion({ file, id: entry.question, call }) === null) return stop('question_closed')
      for (let index = 0; index < keys.length; index += 1) {
        if (index > 0) await this.sleep(this.timing.stepGapMs)
        // 키마다 효과 직전 — 해지·끔·세션 바뀜이면 남은 키를 넣지 않는다. 첫 키 전이면 아무것도 넣지 않았다(R1-A1·A4·R2-A4).
        // LIFE-598: herdr 를 키마다 다시 본다 — 이 관측과 키 사이에 await 가 없다. seq·revision 이 울타리 값 그대로여야 한다.
        const now = await backend.observe(pane)
        if (this.halted(entry, sent)) return
        if (now.input === null) return stop('guard_outdated')
        if (now.seq !== before.seq) return stop('question_changed')
        if (now.input.revision !== revision) return this.answerMoved({ stop, entry, sent })
        if (anyMoved({ input: now.input, anyInput: now.anyInput })) return this.answerMoved({ stop, entry, sent, any: true })
        const gone = this.gone(entry)
        if (gone !== null) return stop(gone)
        const moved = this.sessionMoved(entry, now)
        if (moved !== null) {
          this.deps.log('mobile.input_target_changed', { op: entry.op, check: moved })
          return stop('target_changed')
        }
        if (sent === 0) {
          entry.state = 'sending'
          this.emit(entry)
        }
        // r3: 같은 pane 대기 지시의 사슬 고리를 쓰기 **전에** 건다 — 들어가면 guard 가 돌려준 revision 으로 확정, 아니면 거둔다.
        const write = this.beginWrite({ pane, before: revision })
        let result: KeyResult = { kind: 'unknown' }
        try {
          result = await backend.send(pane, { text: keys[index]!, seq: before.seq, inputRevision: revision, anyInputRevision: anyFenced ? anyRevision : null })
        } finally {
          // 키의 고리 끝은 guard 가 돌려준 쓴 뒤 revision. 응답에 없으면(이전 guard)·reject 면 거둔다(R4-C2).
          this.endWrite(write, result.kind === 'sent' && result.revision !== null ? { kind: 'sent', after: result.revision } : result.kind === 'refused' ? { kind: 'refused' } : { kind: 'unknown' })
        }
        if (result.kind === 'refused') return stop('question_changed')
        if (result.kind === 'unknown') return this.settle(entry, 'unconfirmed', 'backend')
        sent += 1
        // 쓴 뒤 revision 을 모르면 다음 키를 울타리 칠 수 없다 — 더 넣지 않는다.
        if (result.revision === null) return this.settle(entry, 'unconfirmed', 'guard_outdated')
        if (anyFenced && result.anyRevision === null) return this.settle(entry, 'unconfirmed', 'guard_outdated')
        revision = result.revision
        if (result.anyRevision !== null) anyRevision = result.anyRevision
      }
    }
    if (sent === 0) return this.settle(entry, 'failed', 'question_changed')
    const deadline = this.now() + this.timing.answerConfirmMs
    for (;;) {
      const tail = tailSince(cursor)
      if (tail.rewritten) return this.settle(entry, 'unconfirmed', 'record_rewritten')
      const records = tail.text === null ? { count: 0, declined: false, unattributed: false } : answerRecords({ kind, text: tail.text, call, questions: question.questions.length })
      if (records.unattributed) return this.settle(entry, 'unconfirmed', 'record_unattributed')
      if (records.count > 1) return this.settle(entry, 'unconfirmed', 'record_ambiguous')
      if (records.count === 1 && records.declined) return this.settle(entry, 'unconfirmed', 'question_declined')
      // 답 1건 + 판독자에서 그 질문이 대기에서 풀림(판독자가 없으면 답 줄이 곧 해소다 — Claude·Grok 은 그 도구 호출의 결과 줄).
      // 그리고 기록의 답 값이 폰이 고른 답이어야 한다(R3-A1 — 맥이 먼저 체크해 둔 칸이 섞이면 1건이어도 다른 답이다).
      if (records.count === 1 && this.questionItem({ file, id: entry.question, call })?.state !== 'pending') {
        const recorded: RecordedAnswers = tail.text === null ? { kind: 'unreadable' } : recordedAnswers({ kind, text: tail.text, call, questions: question.questions.map((q) => q.question) })
        if (recorded.kind === 'unreadable') return this.settle(entry, 'unconfirmed', 'answer_unreadable')
        if (!answerMatches({ kind, recorded: recorded.values, questions: question.questions, answers })) return this.settle(entry, 'unconfirmed', 'answer_mismatch')
        return this.settle(entry, 'delivered', null)
      }
      if (this.now() >= deadline) return this.settle(entry, 'unconfirmed', 'record_missing')
      await this.sleep(this.timing.recordPollMs)
    }
  }

  /**
   * 입력이 `quietMs` 이상 조용할 때 잡은 화면(R2-A3) — 덜 조용하면 남은 만큼 기다렸다 다시 읽는다(최대 몇 번). 끝내 조용하지 않으면 null.
   * `any` = 모든 입력(클릭 포함)의 조용한 시간으로 잰다(LIFE-708 r1 — 질문 답. 클릭 직후 화면은 선택 이동을 아직 안 그렸을 수 있다).
   * 이전 guard(`input` 없음)는 그대로 돌려준다 — 부르는 쪽이 `guard_outdated` 로 끝낸다.
   */
  private async quietScreen(input: { backend: InputBackend; pane: TerminalIdentity; minIdleMs: number; any: boolean }): Promise<ScreenRead | null> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const shot = await input.backend.screen(input.pane)
      const mark = input.any ? (shot.anyInput ?? shot.input) : shot.input
      if (mark === null || mark.idleMs >= input.minIdleMs) return shot
      await this.sleep(input.minIdleMs - mark.idleMs)
    }
    return null
  }

  /**
   * 답 — 울타리 revision 이 움직였다(다른 클라이언트의 입력). 답의 말로는 `question_changed`(폰 문구 그대로), 로그에는 입력 울타리.
   * `any` = 초안 revision 은 그대로인데 모든 입력 revision 만 움직였다(맥 클릭·휠 — LIFE-708 r1), 로그 `check: 'any_input'`.
   */
  private answerMoved(input: { stop: (reason: string) => void; entry: Entry; sent: number; any?: boolean }): void {
    this.deps.log('mobile.input_target_changed', { op: input.entry.op, check: input.any === true ? 'any_input' : 'input', sent: input.sent })
    input.stop('question_changed')
  }

  /** 키 묶음 앞 화면 확인 — `skip` = Codex 질문이 이미 펼쳐져 있다(⇧← 를 보내면 다음 문항으로 간다 — 보내지 않는다). */
  private screenMatches(input: { kind: MobileAgentKind; check: AnswerCheck; screen: string; questions: QuestionItem['questions'] }): ScreenCheck {
    const { kind, questions } = input
    const active = activeQuestion({ kind, screen: input.screen })
    const match = (index: number): ScreenCheck => {
      const target = questions[index]
      if (target === undefined) return { kind: 'other' }
      const result = matchQuestion({ kind, active, question: plainQuestion(target), index, total: questions.length })
      return result.kind === 'same' ? { kind: 'go', checked: result.checked } : result
    }
    switch (input.check.kind) {
      case 'open': {
        if (active.kind === 'question') {
          const first = match(0)
          return first.kind === 'go' ? { kind: 'skip' } : first
        }
        // 접힌 표시는 화면 맨 아래 입력창 바로 위에 있을 때만(D2 — keys.ts codexCollapsed). ⇧← 는 이때 한 번.
        return active.kind === 'collapsed' && active.count === questions.length ? { kind: 'go', checked: [] } : { kind: 'other' }
      }
      case 'review':
        return active.kind === 'review' ? { kind: 'go', checked: [] } : { kind: 'other' }
      case 'question':
        return match(input.check.index)
    }
  }

  /**
   * 답·중단의 await 뒤 — 이미 끝났거나(R2-A9) 해지·끔이면 더 하지 않는다. 키가 하나라도 들어갔으면(`sent`) `unconfirmed`, 아니면 실패.
   */
  private halted(entry: Entry, sent = 0): boolean {
    if (FINAL.has(entry.state)) return true
    const gone = this.gone(entry)
    if (gone === null) return false
    this.settle(entry, sent === 0 ? 'failed' : 'unconfirmed', gone)
    return true
  }

  private questionItem(input: { file: string; id: number | null; call: string }): QuestionItem | null {
    const items = this.deps.questionItems(input.file)
    if (items === null || input.id === null) return null
    for (const item of items) if (item.kind === 'question' && item.id === input.id && item.call === input.call) return item
    return null
  }

  /**
   * 그 질문(말풍선 id + 도구 호출 id)이 기록에서 아직 열려 있고 **마지막 대기 질문**일 때만(뒤에 새 질문이 열렸으면 그쪽에 들어간다 — 오입력).
   * 말풍선 id 는 파일 위치라 다른 세션·세대에서 다른 질문에 다시 쓰일 수 있다 — 도구 호출 id 가 같아야 같은 질문이다(R1-A2).
   */
  private openQuestion(input: { file: string; id: number | null; call: string }): QuestionItem | null {
    const items = this.deps.questionItems(input.file)
    if (items === null || input.id === null) return null
    let last: QuestionItem | null = null
    for (const item of items) if (item.kind === 'question' && item.state === 'pending') last = item
    return last !== null && last.id === input.id && last.call === input.call ? last : null
  }

  // --- 중단 ---

  private async runStop(entry: Entry): Promise<void> {
    const located = this.locate(entry.channel)
    if (!located.ok) return this.settle(entry, 'failed', located.reason === 'not_listed' ? 'closed' : located.reason)
    const { channel, kind, listed } = located
    const backend = this.deps.backend()
    if (backend === null) return this.settle(entry, 'failed', 'not_ready')
    const pane = await backend.locate(entry.channel)
    if (this.halted(entry)) return
    if (pane === null) return this.settle(entry, 'failed', 'closed')
    const observed = await backend.observe(pane)
    if (this.halted(entry)) return
    if (observed.status !== 'working' && observed.status !== 'blocked') return this.settle(entry, 'failed', 'not_running')
    const waiting = observed.status === 'blocked' ? (listed.waiting ?? 'other') : null
    if (!stopAllowed({ kind, waiting })) return this.settle(entry, 'failed', 'stop_hidden')
    // Grok 의 Ctrl+C 는 입력 줄에 글이 있으면 그 글을 지운다 — 빈 입력 줄을 본 **같은 guard 턴**의 입력 revision·seq 로 울타리 친다(R3-A6).
    // 화면을 잡을 때 입력이 `quietMs` 이상 조용했어야 그 화면이 마지막 입력까지 보인다. 그 사이 맥 타자가 있으면 guard 가 거절한다(Ctrl+C 0회).
    // Claude·Codex 의 키는 울타리 없이(seq 비교만 — 중단은 응급 조작이라 맥 입력·휠에 실패하지 않게, LIFE-598 r3 에서 r2 이전으로 되돌림).
    let inputRevision: number | null = null
    if (stopNeedsEmptyInput(kind)) {
      const screen = await this.quietScreen({ backend, pane, minIdleMs: this.timing.quietMs, any: false })
      if (this.halted(entry)) return
      if (screen === null) return this.settle(entry, 'failed', 'mac_draft')
      if (screen.input === null || screen.seq === null) return this.settle(entry, 'failed', 'guard_outdated')
      if (screen.seq !== observed.seq) return this.settle(entry, 'failed', 'state_changed')
      if (draftState({ kind, screen: screen.text }) !== 'empty') return this.settle(entry, 'failed', 'mac_draft')
      inputRevision = screen.input.revision
    }
    const resolved = this.deps.resolveFile(channel)
    const file = resolved.kind === 'found' ? resolved.file : null
    const gone = this.gone(entry)
    if (gone !== null) return this.settle(entry, 'failed', gone)
    entry.state = 'sending'
    this.emit(entry)
    const sentAt = this.now()
    // LIFE-598 r3: 같은 pane 대기 지시의 사슬 — 쓰기 전에 「울타리(Grok) 또는 바로 앞 관측 revision → +1」 을 건다(키 한 번 = revision 1, guard).
    // 울타리 없는 키라 관측과 키 사이 맥 입력이 끼면 실제 revision 이 고리 끝을 넘는다 — 뒤 지시는 `mac_input`(쓰지 않는 쪽).
    const base = inputRevision ?? observed.input?.revision ?? null
    const write = base === null ? null : this.beginWrite({ pane, before: base })
    let sent: KeyResult = { kind: 'unknown' }
    // 멈춤 확인 기한의 시작 — 키 직전. 사슬 확정용 재관측을 하면 그 뒤부터(R5-C3 — 재관측 RPC 만큼 확인 창이 줄지 않게. 키·결과 의미는 r2 이전 그대로).
    let confirmFrom = sentAt
    try {
      sent = await backend.send(pane, { text: stopKey(kind), seq: observed.seq, inputRevision, anyInputRevision: null })
      // 울타리 없는 키는 응답에 revision 이 없다 — 다시 관측해 +1 일 때만 확정(R4-C3). Grok(울타리)은 guard 가 돌려준 값.
      if (write !== null && sent.kind === 'sent') {
        if (sent.revision === null) {
          await this.endUnreported({ write, backend, pane })
          confirmFrom = this.now()
        } else this.endWrite(write, { kind: 'sent', after: sent.revision })
      }
    } finally {
      if (write !== null) this.endWrite(write, sent.kind === 'refused' ? { kind: 'refused' } : { kind: 'unknown' })
    }
    if (sent.kind === 'refused') return this.settle(entry, 'failed', 'state_changed')
    const deadline = confirmFrom + this.timing.stopConfirmMs
    for (;;) {
      const now = await backend.observe(pane).catch(() => null)
      if (now !== null && now.status !== 'working' && now.status !== 'blocked') return this.settle(entry, 'stopped', null)
      if (file !== null && this.interruptedSince({ kind, file, since: sentAt })) return this.settle(entry, 'stopped', 'record')
      if (this.now() >= deadline) return this.settle(entry, 'unconfirmed', 'still_running')
      await this.sleep(this.timing.recordPollMs)
    }
  }

  /** 기록의 마지막 턴이 이 중단 뒤에 `interrupted` 로 끝났나 — 꼬리 1 MiB 만 읽는다. */
  private interruptedSince(input: { kind: MobileAgentKind; file: string; since: number }): boolean {
    const size = sizeOf(input.file)
    if (size === null) return false
    const from = Math.max(0, size - 1024 * 1024)
    const chunk = readBytes({ file: input.file, from, to: size })?.toString('utf8') ?? null
    if (chunk === null) return false
    const partial = from > 0
    const digest = input.kind === 'grok' ? parseGrokUpdates({ chunk, partial }) : parseTail({ agent: input.kind, chunk, partial, sessionId: null })
    if (digest.turnOutcome?.outcome !== 'interrupted') return false
    // 시각이 없는 결과는 이 중단의 것인지 모른다 — 세지 않는다.
    return digest.turnOutcomeAt !== null && digest.turnOutcomeAt >= input.since - 1000
  }

  // --- 공통 ---

  /** 채널 → 살아 있는 AI 채널·세션(P1·P8). 셸 pane·닫힌 세션·목록 밖은 거절, 세션 참조가 없으면 `no_session`(입력 잠금). */
  private locate(channelId: string):
    | { ok: true; channel: ChatChannel; kind: MobileAgentKind; listed: MobileChannel }
    | { ok: false; reason: 'not_listed' | 'no_session' | 'not_ready' | 'closed' } {
    const list = this.deps.read()
    if (list === null) return { ok: false, reason: 'not_ready' }
    const built = buildMobileList(list)
    if (!built.available) return { ok: false, reason: 'not_ready' }
    const listed = built.repos.flatMap((repo) => repo.tasks.flatMap((task) => task.channels)).find((channel) => channel.id === channelId)
    if (listed === undefined || listed.kind === null) return { ok: false, reason: 'not_listed' }
    if (listed.status !== 'live') return { ok: false, reason: 'closed' }
    const found = chatChannel({ list, channelId })
    if (!found.ok) return found
    return { ok: true, channel: found.channel, kind: listed.kind, listed }
  }

  /** 같은 (기기, id) 가 이미 있으면 지금 상태만 다시 보낸다 — 다시 넣지 않는다(P2). 기억에서 밀린 id 도 넣지 않는다(R1-A6). */
  private repeat(input: { device: string; id: string }): boolean {
    const key = this.key(input)
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      this.emit(existing)
      return true
    }
    if (!this.retired.has(key)) return false
    this.emitUnknown(input)
    return true
  }

  private add(input: { device: string; id: string; channel: string; op: InputOp; text: string | null; question: number | null; call: string | null; digest: string | null; answers: QuestionAnswer[] | null }): Entry {
    const entry: Entry = { ...input, state: 'queued', wait: null, reason: null, at: this.now(), order: (this.order += 1), gen: this.generation, bind: null }
    this.entries.set(this.key(input), entry)
    this.prune(input.device)
    return entry
  }

  /** 기기당 기억 상한 — 끝난 것 중 오래된 것부터 상태를 잊는다. 잊은 id 의 표지는 남긴다(다시 넣지 않게, R1-A6). */
  private prune(device: string): void {
    const mine = [...this.entries.values()].filter((entry) => entry.device === device)
    if (mine.length <= INPUT_IDS_MAX) return
    const done = mine.filter((entry) => FINAL.has(entry.state)).sort((a, b) => a.order - b.order)
    for (const entry of done.slice(0, mine.length - INPUT_IDS_MAX)) {
      const key = this.key(entry)
      this.entries.delete(key)
      this.retired.add(key)
    }
  }

  /** 답·중단은 채널당 한 번에 하나 — 겹치면 뒤의 것은 넣지 않는다. */
  private async exclusive(entry: Entry, run: () => Promise<void>): Promise<void> {
    if (this.busy.has(entry.channel)) return this.settle(entry, 'failed', 'busy')
    this.busy.add(entry.channel)
    try {
      await run()
    } catch (error) {
      this.deps.log('mobile.input_error', { op: entry.op, error: String(error) })
      if (!FINAL.has(entry.state)) this.settle(entry, entry.state === 'sending' ? 'unconfirmed' : 'failed', 'backend')
    } finally {
      this.busy.delete(entry.channel)
    }
  }

  private settle(entry: Entry, state: InputState, reason: string | null): void {
    entry.state = state
    entry.wait = null
    entry.reason = reason
    entry.at = this.now()
    if (FINAL.has(state)) {
      entry.text = null
      entry.answers = null
    }
    this.deps.log('mobile.input_state', { op: entry.op, state, reason })
    this.emit(entry)
  }

  private emit(entry: Entry, options: { withText: boolean } = { withText: false }): void {
    if (this.revoked.has(entry.device)) return
    const wire: InputWire = { type: 'input.state', id: entry.id, channel: entry.channel, op: entry.op, state: entry.state, wait: entry.wait, reason: entry.reason, at: entry.at }
    if (options.withText && entry.text !== null) wire.text = entry.text
    this.sinks.get(entry.device)?.(JSON.stringify(wire))
  }

  private emitUnknown(input: { device: string; id: string }): void {
    const reason = this.retired.has(this.key(input)) ? 'expired' : null
    const wire: InputWire = { type: 'input.state', id: input.id, channel: null, op: null, state: 'unknown', wait: null, reason, at: this.now() }
    this.sinks.get(input.device)?.(JSON.stringify(wire))
  }

  private key(input: { device: string; id: string }): string {
    return `${input.device}\u0000${input.id}`
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep !== undefined) return this.deps.sleep(ms)
    return new Promise((resolve) => setTimeout(resolve, ms).unref())
  }
}
