// 폰 → 맥 쓰기 (LIFE-582 P1~P9) — 지시 보내기 · 큐 취소 · 상태 조회 · 질문 답 · 중단. electron·소켓을 모른다(시험이 가짜 백엔드로 돈다).
//
// - **메시지 id 당 많아야 한 번**(P2): (기기, id) 로 기억한다. 같은 id 가 다시 오면(재연결 뒤 재전송·조회) 다시 넣지 않고 지금 상태만 돌려준다.
//   기억 상한(`INPUT_IDS_MAX`)에서 밀린 id 도 **표지는 남긴다** — 다시 와도 넣지 않고 `unknown`(`expired`)(R1-A6).
//   같은 글이라도 새 id 면 새 지시다 — `prompt_already_delivered`(기록 전체 같은 글 거절)는 쓰지 않는다.
// - **「들어감」 = 이 제출 직전 커서 뒤 기록 매칭 정확히 1건**(`countSubmissions` — CLI `terminal prompt` 와 같은 대조). 0건·2건 이상·커서 무효는
//   `unconfirmed`(확인하지 못했습니다) — 들어감으로 올리지 않는다(P6ⓓ). 다시 넣지도 않는다. 커서는 **파일 꼬리**다(dev·ino · 크기 + 끝 64 KiB 지문, R2-A7) —
//   지시마다 기록 전체를 동기로 읽지 않는다(C1, 45 MB 기록에서 루프 지연 p99 230 ms 실측).
// - **접수 때 대상을 묶는다**(R1-A5): backend epoch · PTY 세대 · provider 세션. 넣기 전 셋 중 하나라도 바뀌면(herdr 재시작·같은 pane 의 새 세션) 실패 —
//   이전 지시가 새 세대로 따라가지 않는다.
// - **채널별 큐**(P3): 순서대로 한 건씩. 에이전트가 준비 관문(750 ms 두 관측 · 같은 seq · detect manifest 확인 — CLI 와 같은 관문)을 통과해야 넣는다.
//   관문 통과 = 턴이 끝났다는 뜻이라 턴 안에 끼어들지 않는다. 넣기는 guard 의 compare-and-submit(`agent.prompt` + 관측한 seq + **관측한 입력 revision**)이라
//   그 사이 전이·맥 타자가 있으면 아무것도 쓰지 않고 거절된다 — 그때는 큐에 그대로 두고 다시 기다린다. 취소는 넣기 시작 전(`queued`)만.
// - **수명**(R1-A1·A4): 모바일 끔·종료(활성 세대가 바뀜)·그 기기 해지면 그 기기의 끝나지 않은 요청을 끝낸다. 모든 await 뒤와 효과 직전에 다시 본다 —
//   늦게 온 guard 거절이 끈 뒤의 지시를 큐로 되살리지 않고, 답의 남은 키는 멈춘다(일부 키가 들어갔으면 `unconfirmed`). 연결 끊김(폰 화면 끔)은 수명이 아니다 — 큐는 남는다.
// - **맥 입력창 초안**(P9): 넣기 직전 보이는 화면의 입력 줄이 비었는지 본다(`keys.ts draftState`). 글이 있거나 판단 못 하면 넣지 않고 실패.
//   그 화면은 같은 guard 턴의 입력 revision·조용한 시간과 함께 읽는다(R2-A3) — 화면을 잡을 때 입력이 `quietMs` 이상 조용했어야 믿고, 넣기는 그 화면의 revision 그대로일 때만
//   같은 App 턴에서 한다(R1-A3). 칸 없는 CLI 제출도 revision 을 올린다(guard).
// - **질문 답**(P4): 폰은 어느 질문(말풍선 id + 도구 호출 id + 내용 지문)에 어떤 답인지만 보낸다(R1-A2·R2-A1). 서버는 그 질문이 기록의 마지막 대기 질문이고 지문이 같고
//   `blocked` 일 때, 키 묶음마다 조용한 화면의 **활성 질문 영역**이 그 문항인지 대조하고, 키마다 「그 seq · 그 입력 revision 그대로일 때만」 넣는다(`runAnswer`).
//   들어감 = 커서 뒤 기록에 **그 질문의 답 정확히 1건**(Codex 는 `questionItemId` 귀속, R2-A2) + 판독자에서 그 질문이 대기에서 풀림(UI `answered` 만으로 세지 않는다).
// - **중단**(P5): 그 순간 상태를 다시 관측해 작업 중·(허용된) 대기일 때만 provider 키 1회 — 역시 seq 비교. 재시도 없음. 한가면 `not_running`.
//   멈춤 = 상태가 working·blocked 를 떠남 또는 기록의 그 턴 `interrupted`(백그라운드가 있으면 herdr 는 working 에 남는다 — Z1ⓓ).
// - 본문은 로그에 남기지 않는다(길이·해시 앞 8자만). 끝난 지시의 본문은 메모리에서도 버린다.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { TerminalIdentity } from '../adapter/index.js'
import { bodyIdentity, countSubmissions, normalizeBody } from '../../runtime/terminal/agent.js'
import type { AgentSessionRef } from '../../shared/types.js'
import { parseGrokUpdates, parseTail } from '../transcript-parse.js'
import { codexQuestionReplies, lineAtoms, type ChatItem } from '../chat-parse.js'
import {
  activeQuestion,
  answerGroups,
  cleanAnswerText,
  cleanBody,
  draftState,
  MAX_INPUT_BYTES,
  questionDigest,
  sameQuestion,
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
 * `unmanaged` = herdr 가 그 pane 을 관리 에이전트로 띄우지 않았다(셸에서 직접 친 `claude` 등) — 한가해도 `interactive_ready` 가 켜지지 않아
 * guard 의 `agent.prompt` 관문을 영영 못 넘는다(격리 빠른 확인 q13). 데스크톱 GUI·하네스는 `agent.start` 로 띄워 관리된다.
 * `input` = 그 pane 의 사람 입력 revision·조용한 시간(guard 가 같은 관측 턴에서 읽는다). 이전 guard 면 null — 그때는 넣지 않는다.
 */
export type PaneObservation = { status: string; seq: number; quiet: boolean; unmanaged: boolean; input: { revision: number; idleMs: number } | null }
export type SendResult = 'sent' | 'refused' | 'unknown'
/** 키 한 번의 결과 — `sent` 면 guard 가 쓴 뒤의 입력 revision(다음 키의 울타리, 울타리 없이 보냈으면 null). */
export type KeyResult = { kind: 'sent'; revision: number | null } | { kind: 'refused' } | { kind: 'unknown' }
/** 보이는 화면 + 같은 guard 턴의 입력 revision·조용한 시간·에이전트 seq(R2-A3). 이전 guard 면 `input`·`seq` 가 null. */
export type ScreenRead = { text: string; input: { revision: number; idleMs: number } | null; seq: number | null }

/** herdr 쪽 — 실제는 `input-backend.ts`(guard 봉투), 시험은 가짜. */
export interface InputBackend {
  /** 지금 그 pane(세대 포함). 없으면 null. */
  locate(paneId: string): Promise<TerminalIdentity | null>
  /** 에이전트 상태 한 번. 에이전트가 없으면 status `none`. */
  observe(pane: TerminalIdentity): Promise<PaneObservation>
  /** detect manifest 확인(CLI 와 같은 fail-closed — 신뢰 대화상자가 한가로 보일 수 있다). */
  manifestVerified(kind: MobileAgentKind): Promise<boolean>
  /** 보이는 화면(ANSI) — 같은 턴의 입력 revision·조용한 시간·seq 와 함께(R2-A3). */
  screen(pane: TerminalIdentity): Promise<ScreenRead>
  /** guard `agent.prompt` — 관측한 seq·입력 revision 그대로이고 입력이 `minIdleMs` 이상 조용할 때만. `refused` = 아무것도 쓰지 않았다. */
  prompt(pane: TerminalIdentity, input: { text: string; seq: number; inputRevision: number; minIdleMs: number }): Promise<SendResult>
  /**
   * guard `pane.send_text` + 관측한 seq 비교 + (주면) 입력 revision 울타리 — 그 revision 뒤에 다른 입력이 있었으면 `refused`(R2-A1).
   * `refused` = 아무것도 쓰지 않았다.
   */
  send(pane: TerminalIdentity, input: { text: string; seq: number; inputRevision: number | null }): Promise<KeyResult>
}

/**
 * 쓰기용 기록 해소(R1-A13) — `found` 는 **유일한** 후보일 때만. `none` = 훑기 성공·0건(새 세션은 첫 지시 뒤에 파일이 생긴다) ·
 * `error` = 0건을 믿을 수 없다(기다린다) · `ambiguous` = 같은 세션 id 의 파일이 둘 이상(잠근다).
 */
export type FileResolution = { kind: 'found'; file: string } | { kind: 'none' } | { kind: 'error' } | { kind: 'ambiguous' }

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
  /** 그 기기가 아직 페어링돼 있나 — 효과 직전마다 본다(R1-A1). 없으면 `revoke()` 로 받은 해지만 본다. */
  deviceValid?: (device: string) => boolean
  log: (tag: string, fields?: Record<string, unknown>) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timing?: Partial<InputTiming>
}

/** 접수 때 묶은 대상(R1-A5). */
type Bind = { epoch: string; ptyId: string; session: string }

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

/** 기록 문항 → 화면 대조용(글·선택지 글). */
const plainQuestion = (question: QuestionItem['questions'][number]): { question: string; options: string[] } => ({ question: question.question, options: question.options.map((option) => option.label) })

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
    entry.bind = { epoch: pane.epoch, ptyId: pane.ptyId, session: sessionKey(channel.session) }
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
    if (sessionKey(channel.session) !== bind.session) return this.fail(entry, 'target_changed')
    const backend = this.deps.backend()
    if (backend === null) return 'wait'
    const pane = await backend.locate(entry.channel)
    if (this.dropped(entry)) return 'done'
    if (pane === null) return this.fail(entry, 'closed')
    if (pane.epoch !== bind.epoch || pane.ptyId !== bind.ptyId) return this.fail(entry, 'target_changed')
    const resolved = this.fileFor({ channel, cwd: pane.path })
    if (resolved.kind === 'wait') return 'wait'
    if (resolved.kind === 'fail') return this.fail(entry, resolved.reason)
    const { file } = resolved
    const first = await backend.observe(pane)
    if (this.dropped(entry)) return 'done'
    // 관리 밖 pane — 기다려도 넣을 수 없다. 대기로 두면 블랙홀이다(P1 「증명 못 하는 채널은 잠그고 안내」).
    if (first.unmanaged) return this.fail(entry, 'unmanaged')
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
    const shot = await backend.screen(pane)
    if (this.dropped(entry)) return 'done'
    // R2-A3: 화면과 **같은 guard 턴**의 입력 revision·조용한 시간·seq 로 판단한다. 화면을 잡을 때 입력이 `quietMs` 이상 조용했어야
    // 그 화면이 마지막 입력의 echo 까지 보인다. 넣기는 이 revision 그대로일 때만 — 그러면 넣는 순간까지 화면 뒤 입력이 없다.
    if (shot.input === null || shot.seq === null) return this.fail(entry, 'guard_outdated')
    if (shot.seq !== second.seq) return this.waitTurn(entry, 'turn')
    if (shot.input.idleMs < this.timing.quietMs) return this.waitTurn(entry, 'gate')
    const draft = draftState({ kind, screen: shot.text })
    if (draft !== 'empty') return this.fail(entry, draft === 'draft' ? 'mac_draft' : 'draft_unknown')
    const text = entry.text ?? ''
    const cursor = tailCursor(file)
    if (cursor === null) return this.fail(entry, 'record_unreadable')
    const submittedAtMs = this.now()
    // 여기서부터 취소 불가 — 넣기 시작. 효과 직전 마지막 확인(해지·끔 · 접수 때 묶은 provider 세션 — R2-A4).
    const gone = this.gone(entry)
    if (gone !== null) return this.fail(entry, gone)
    if (this.sessionMoved(entry)) return this.fail(entry, 'target_changed')
    entry.state = 'sending'
    entry.wait = null
    this.emit(entry)
    const sent = await backend.prompt(pane, { text, seq: second.seq, inputRevision: shot.input.revision, minIdleMs: this.timing.quietMs })
    if (sent === 'refused') {
      // guard 가 거절 — 아무것도 쓰지 않았다. 그 사이 끄거나 해지했으면 끝낸다(되살리지 않는다, R1-A4). 아니면 큐에 되돌려 다음 관문을 기다린다.
      const late = this.gone(entry)
      if (late !== null) return this.fail(entry, late)
      entry.state = 'queued'
      return this.waitTurn(entry, 'turn')
    }
    await this.confirmSend({ entry, kind, cursor, submittedAtMs, text })
    return 'done'
  }

  /** 쓰기용 기록 파일 — 유일한 후보, 또는 0건이 확실할 때만 그 세션이 쓸 경로(R1-A13). */
  private fileFor(input: { channel: ChatChannel; cwd: string }): { kind: 'file'; file: string } | { kind: 'wait' } | { kind: 'fail'; reason: string } {
    const resolved = this.deps.resolveFile(input.channel)
    switch (resolved.kind) {
      case 'found':
        return { kind: 'file', file: resolved.file }
      case 'ambiguous':
        return { kind: 'fail', reason: 'record_ambiguous' }
      case 'error':
        return { kind: 'wait' }
      case 'none': {
        const expected = this.deps.expectedFile?.(input) ?? null
        return expected === null ? { kind: 'wait' } : { kind: 'file', file: expected }
      }
    }
  }

  /**
   * 접수 때 묶은 provider 세션이 지금 목록의 그 채널 세션과 다른가(R2-A4) — 효과 직전에 await 없이 본다. 채널이 사라졌어도 바뀐 것이다.
   * 목록은 이 프로세스의 상태라 이 확인과 효과 호출 사이에 바뀌지 않는다.
   */
  private sessionMoved(entry: Entry): boolean {
    const located = this.locate(entry.channel)
    if (!located.ok) return true
    const session = sessionKey(located.channel.session)
    return entry.bind === null ? false : session !== entry.bind.session
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

  private async confirmSend(input: { entry: Entry; kind: MobileAgentKind; cursor: TailCursor; submittedAtMs: number; text: string }): Promise<void> {
    const { entry, cursor } = input
    const identity = bodyIdentity(input.text)
    const deadline = this.now() + this.timing.confirmMs
    // 커서 뒤 꼬리만 CLI 와 같은 대조에 넣는다 — 꼬리 앞(커서) 줄은 이미 잘라 냈다.
    const after = [{ path: cursor.file, existed: cursor.existed, bytes: 0, lines: 0 }]
    for (;;) {
      const tail = tailSince(cursor)
      if (tail.rewritten) return this.settle(entry, 'unconfirmed', 'record_rewritten')
      const text = tail.text
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
   * - 세션: 접수 때의 provider 세션이 키마다 그대로다.
   * - 화면: 키 묶음마다 그 앞에서, 입력이 `quietMs` 이상 조용할 때 잡은 화면의 **활성 질문 영역**(맨 아래 질문 상자)이 그 문항이다.
   *   화면 위쪽 과거 글은 보지 않는다. Codex 는 접힌 표시의 문항 수를 본 뒤 ⇧← 로 열고 다시 본다.
   * - 입력: 그 화면의 입력 revision 에서 시작해 키마다 guard 가 돌려준 revision 으로 다음 키를 울타리 친다 — 다른 클라이언트의 입력이 끼면 그 키부터 넣지 않는다.
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
    entry.bind = { epoch: pane.epoch, ptyId: pane.ptyId, session: sessionKey(channel.session) }
    const resolved = this.deps.resolveFile(channel)
    if (resolved.kind !== 'found') return this.settle(entry, 'failed', resolved.kind === 'ambiguous' ? 'record_ambiguous' : 'not_ready')
    const { file } = resolved
    const question = this.openQuestion({ file, id: entry.question, call })
    if (question === null) return this.settle(entry, 'failed', 'question_closed')
    if (questionDigest(question.questions) !== digest) return this.settle(entry, 'failed', 'question_changed')
    const plan = answerGroups({
      kind,
      questions: question.questions.map((q) => ({ options: q.options.length, multiSelect: q.multiSelect, preview: q.preview === true })),
      answers,
    })
    if (!plan.ok) return this.settle(entry, 'failed', plan.reason === 'bad_answer' ? 'bad_answer' : plan.reason === 'other_locked' ? 'other_locked' : 'question_locked')
    const before = await backend.observe(pane)
    if (this.halted(entry)) return
    if (before.status !== 'blocked') return this.settle(entry, 'failed', 'question_closed')
    const cursor = tailCursor(file)
    if (cursor === null) return this.settle(entry, 'failed', 'record_unreadable')
    let revision: number | null = null
    let sent = 0
    // 키가 들어간 뒤의 실패는 확인 못 함 — 일부 키가 들어갔을 수 있다.
    const stop = (reason: string): void => this.settle(entry, sent === 0 ? 'failed' : 'unconfirmed', reason)
    for (let group = 0; group < plan.groups.length; group += 1) {
      const { check, keys } = plan.groups[group]!
      if (group > 0) await this.sleep(this.timing.stepGapMs)
      const shot = await this.quietScreen({ backend, pane })
      if (this.halted(entry, sent)) return
      if (shot === null) return stop('question_changed')
      if (shot.input === null || shot.seq === null) return stop('guard_outdated')
      if (shot.seq !== before.seq || (revision !== null && shot.input.revision !== revision)) return stop('question_changed')
      const shown = this.screenMatches({ kind, check, screen: shot.text, questions: question.questions })
      if (shown === 'skip') continue
      if (!shown) return stop('question_changed')
      if (this.openQuestion({ file, id: entry.question, call }) === null) return stop('question_closed')
      revision = shot.input.revision
      for (let index = 0; index < keys.length; index += 1) {
        if (index > 0) await this.sleep(this.timing.stepGapMs)
        // 키마다 효과 직전 — 해지·끔·세션 바뀜이면 남은 키를 넣지 않는다. 첫 키 전이면 아무것도 넣지 않았다(R1-A1·A4·R2-A4).
        const gone = this.gone(entry)
        if (gone !== null) return stop(gone)
        if (this.sessionMoved(entry)) return stop('target_changed')
        if (sent === 0) {
          entry.state = 'sending'
          this.emit(entry)
        }
        const result = await backend.send(pane, { text: keys[index]!, seq: before.seq, inputRevision: revision })
        if (result.kind === 'refused') return stop('question_changed')
        if (result.kind === 'unknown') return this.settle(entry, 'unconfirmed', 'backend')
        sent += 1
        // 쓴 뒤 revision 을 모르면 다음 키를 울타리 칠 수 없다 — 더 넣지 않는다.
        if (result.revision === null) return this.settle(entry, 'unconfirmed', 'guard_outdated')
        revision = result.revision
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
      if (records.count === 1 && this.questionItem({ file, id: entry.question, call })?.state !== 'pending') return this.settle(entry, 'delivered', null)
      if (this.now() >= deadline) return this.settle(entry, 'unconfirmed', 'record_missing')
      await this.sleep(this.timing.recordPollMs)
    }
  }

  /**
   * 입력이 `quietMs` 이상 조용할 때 잡은 화면(R2-A3) — 덜 조용하면 남은 만큼 기다렸다 다시 읽는다(최대 몇 번). 끝내 조용하지 않으면 null.
   * 이전 guard(`input` 없음)는 그대로 돌려준다 — 부르는 쪽이 `guard_outdated` 로 끝낸다.
   */
  private async quietScreen(input: { backend: InputBackend; pane: TerminalIdentity }): Promise<ScreenRead | null> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const shot = await input.backend.screen(input.pane)
      if (shot.input === null || shot.input.idleMs >= this.timing.quietMs) return shot
      await this.sleep(this.timing.quietMs - shot.input.idleMs)
    }
    return null
  }

  /** 키 묶음 앞 화면 확인 — `skip` = Codex 질문이 이미 펼쳐져 있다(⇧← 를 보내면 다음 문항으로 간다 — 보내지 않는다). */
  private screenMatches(input: { kind: MobileAgentKind; check: AnswerCheck; screen: string; questions: QuestionItem['questions'] }): boolean | 'skip' {
    const active = activeQuestion({ kind: input.kind, screen: input.screen })
    switch (input.check.kind) {
      case 'open':
        if (active.kind === 'question') return sameQuestion({ active, question: plainQuestion(input.questions[0]!), index: 0, total: input.questions.length }) ? 'skip' : false
        return active.kind === 'collapsed' && active.count === input.questions.length
      case 'review':
        return active.kind === 'review'
      case 'question': {
        const target = input.questions[input.check.index]
        return target !== undefined && sameQuestion({ active, question: plainQuestion(target), index: input.check.index, total: input.questions.length })
      }
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
    if (stopNeedsEmptyInput(kind)) {
      const screen = await backend.screen(pane)
      if (this.halted(entry)) return
      if (draftState({ kind, screen: screen.text }) !== 'empty') return this.settle(entry, 'failed', 'mac_draft')
    }
    const resolved = this.deps.resolveFile(channel)
    const file = resolved.kind === 'found' ? resolved.file : null
    const gone = this.gone(entry)
    if (gone !== null) return this.settle(entry, 'failed', gone)
    entry.state = 'sending'
    this.emit(entry)
    const sentAt = this.now()
    const sent = await backend.send(pane, { text: stopKey(kind), seq: observed.seq, inputRevision: null })
    if (sent.kind === 'refused') return this.settle(entry, 'failed', 'state_changed')
    const deadline = sentAt + this.timing.stopConfirmMs
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
