// herdr 재시작 재개 참조 고쳐 쓰기 (LIFE-772) — corral 이 멈춘 `default` 서버를 띄우기 직전에, 그 세션 `session.json` 의 claude 참조를
// 백그라운드 전환(`continued-in`) 끝 id 로 바꾼다. herdr 는 저장 참조 그대로 `claude --resume <id>` 로 재개하므로(0.9.0 `agent_resume.rs` `plan()`),
// 옛 id 로 두면 전환 시점에 멈춘 사본이 열리고 그 뒤 입력이 옛 파일에 이어 써져 대화가 갈라진다.
//
// 판별은 LIFE-766 `followContinued` 한 벌을 그대로 쓴다(`empty: 'stay'` — 대화가 있는 대상까지만, 되살아남·모름·창 밖·대상 없음은 옛 id). 기록 파일 찾기는
// 766 쓰기 경로와 같은 유일성 계약(`resolveTranscriptUnique` — 같은 id 의 파일이 둘 이상이거나 폴더를 못 읽으면 그 참조는 그대로)이다.
// **살아 있는 herdr 상태는 바꾸지 않는다** — 서버가 멈춘 것이 확인된 그 자리(`BackendStarter.beforeSpawn`)에서만 파일을 쓴다.
//
// 안전한 실패: 구조를 모르거나·판별이 결론을 못 내거나·쓰기가 실패하면 파일을 그대로 두고 지금처럼 띄운다. 바뀌는 바이트는 claude 참조 `value` 문자열뿐이다 —
// 같은 디렉터리 임시 파일에 쓰고 rename 한다. 읽은 뒤 바이트가 바뀌었으면 rename 하지 않는다.
// **남는 창**은 멈춤 확인부터 rename 까지 전체다(남긴 자식 정리 대기·첫 읽기·따라가기 스캔 포함). 그 사이 다른 손(사용자가 친 `herdr`)이 서버를 띄우면 그 서버는 시작 때 읽은
// 옛 id 로 재개하고, 파일 바이트가 같으면 rename 이 되며, 그 서버의 다음 저장이 고친 값을 덮는다 — 그 서버에게는 고쳐 쓰기가 없던 것과 같다(지금 동작).
import fs from 'node:fs'
import path from 'node:path'
import { isRecord } from '../../../shared/json.js'
import type { AgentSessionRef } from '../../../shared/types.js'
import { followContinued, SESSION_ID } from '../../transcript-continued.js'
import { resolveTranscriptFile, resolveTranscriptUnique } from '../../transcript.js'
import { restorePaneMaps } from './server.js'

/** herdr 가 claude pane 에 남기는 참조의 출처 — herdr 재개 표가 `claude --resume` 으로 옮기는 그 칸이다. */
const HERDR_CLAUDE_SOURCE = 'herdr:claude'

/**
 * claude 참조 하나가 어떻게 됐나 — 로그에 개수로 싣는다(세션 id·경로는 싣지 않는다).
 * `moved` 옮김 · `no_hop` 기록은 찾았는데 따라갈 곳이 없음(전환 없음·되살아남·모름·창 밖·대상 없음·대상에 대화 없음 — 766 판별이 하나로 낸다) ·
 * `no_file` 기록 파일 없음 · `ambiguous` 같은 id 의 파일이 둘 이상(연쇄 대상 포함) · `scan_error` 기록 폴더를 못 읽음 · `taken` 옮길 곳을 다른 pane 이 이미 쥠(K10).
 */
export type RefOutcome = 'moved' | 'no_hop' | 'no_file' | 'ambiguous' | 'scan_error' | 'taken'
export type RefOutcomes = Partial<Record<RefOutcome, number>>

export type RestoreRewrite =
  | { kind: 'skipped'; reason: string }
  | { kind: 'unchanged'; refs: number; outcomes: RefOutcomes }
  | { kind: 'rewritten'; refs: number; moved: number; outcomes: RefOutcomes }
  | { kind: 'failed'; reason: string }

export type RestoreRewritePlan =
  | { kind: 'unknown'; reason: string }
  | { kind: 'same'; refs: number; outcomes: RefOutcomes }
  | { kind: 'moved'; refs: number; moves: ReadonlyMap<string, string>; text: string; outcomes: RefOutcomes }

/** 참조 하나의 따라가기 결과 — 옮길 곳 또는 머문 사유. */
export type FollowResult = { kind: 'to'; id: string } | { kind: 'stay'; reason: Exclude<RefOutcome, 'moved' | 'taken'> }

/** 기록 파일 위치 — 유일할 때만 `found`. */
export type TranscriptLocation = { kind: 'found'; file: string } | { kind: 'none' } | { kind: 'ambiguous' } | { kind: 'error' }

/** `source: herdr:claude`·`agent: claude`·`kind: id` 이고 값이 세션 id 모양인 참조만 — codex·grok·경로 참조는 건드리지 않는다. */
function claudeIdRef(agentSession: Record<string, unknown>): string | null {
  const value = agentSession['value']
  if (agentSession['source'] !== HERDR_CLAUDE_SOURCE || agentSession['agent'] !== 'claude' || agentSession['kind'] !== 'id') return null
  return typeof value === 'string' && SESSION_ID.test(value) ? value : null
}

/** claude 참조를 가진 agent_session 객체들. 구조를 모르면 사유(계수와 같은 판별). */
function claudeRefs(session: unknown): { known: true; refs: Record<string, unknown>[] } | { known: false; reason: string } {
  const walked = restorePaneMaps(session)
  if (!walked.known) return walked
  const refs: Record<string, unknown>[] = []
  for (const panes of walked.paneMaps)
    for (const pane of Object.values(panes)) {
      if (!isRecord(pane)) return { known: false, reason: 'pane 이 객체가 아니다' }
      const agentSession = pane['agent_session']
      if (agentSession === undefined || agentSession === null) continue
      if (!isRecord(agentSession)) return { known: false, reason: 'agent_session 이 객체가 아니다' }
      if (claudeIdRef(agentSession) !== null) refs.push(agentSession)
    }
  return { known: true, refs }
}

function occurrences(input: { text: string; needle: string }): number {
  return input.text.split(input.needle).length - 1
}

/**
 * 순수 계획 — 원문과 「id → 대화가 있는 끝 id(옮길 곳이 없으면 null)」 로 새 원문을 만든다. 디스크를 건드리지 않는다.
 * 바꿀 값 `"<id>"` 가 원문에 참조 수만큼만 나와야 한다 — 다른 자리에도 있으면 모름(바이트 치환이 그 자리까지 바꾸게 된다).
 * 치환한 원문을 다시 파싱해 「그 참조 값만 바뀐 같은 구조」 인지 대조한다.
 */
export function planRestoreRewrite(input: { text: string; follow: (id: string) => FollowResult }): RestoreRewritePlan {
  let session: unknown
  try {
    session = JSON.parse(input.text)
  } catch {
    return { kind: 'unknown', reason: 'session.json 을 JSON 으로 읽지 못했다' }
  }
  const found = claudeRefs(session)
  if (!found.known) return { kind: 'unknown', reason: found.reason }
  const moves = new Map<string, string>()
  // 다른 pane 이 이미 쥔 id(원래 값·앞서 옮겨 간 곳)로는 옮기지 않는다 — herdr 는 같은 세션을 한 번만 재개하고(`dedupe_key`) 뒤 pane 은 참조를 잃고 빈 셸로 뜬다(실측 C3 12).
  // 고쳐 쓰기가 재개를 하나 없애는 일은 만들지 않는다 — 그 pane 은 지금처럼 옛 id 다.
  const taken = new Set(found.refs.map((ref) => claudeIdRef(ref)))
  const decided = new Map<string, RefOutcome>()
  for (const ref of found.refs) {
    const from = claudeIdRef(ref)
    if (from === null || decided.has(from)) continue
    const followed = input.follow(from)
    if (followed.kind === 'stay') {
      decided.set(from, followed.reason)
      continue
    }
    const to = followed.id
    if (to === from || !SESSION_ID.test(to)) {
      decided.set(from, 'no_hop')
      continue
    }
    if (taken.has(to)) {
      decided.set(from, 'taken')
      continue
    }
    decided.set(from, 'moved')
    moves.set(from, to)
    taken.add(to)
  }
  const outcomes: RefOutcomes = {}
  for (const ref of found.refs) {
    const from = claudeIdRef(ref)
    const outcome = from === null ? undefined : decided.get(from)
    if (outcome !== undefined) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  if (moves.size === 0) return { kind: 'same', refs: found.refs.length, outcomes }
  let text = input.text
  for (const [from, to] of moves) {
    const needle = JSON.stringify(from)
    const expected = found.refs.filter((ref) => ref['value'] === from).length
    if (occurrences({ text, needle }) !== expected) return { kind: 'unknown', reason: '참조 값이 참조 밖에도 있다' }
    text = text.split(needle).join(JSON.stringify(to))
  }
  for (const ref of found.refs) {
    const from = claudeIdRef(ref)
    const to = from === null ? undefined : moves.get(from)
    if (to !== undefined) ref['value'] = to
  }
  let reparsed: unknown
  try {
    reparsed = JSON.parse(text)
  } catch {
    return { kind: 'unknown', reason: '고친 원문이 JSON 이 아니다' }
  }
  if (JSON.stringify(reparsed) !== JSON.stringify(session)) return { kind: 'unknown', reason: '고친 원문의 구조가 참조 값 말고도 다르다' }
  return { kind: 'moved', refs: found.refs.length, moves, text, outcomes }
}

/**
 * 참조의 기록 파일 — 766 쓰기 경로의 유일성 계약(`resolveTranscriptUnique`)을 통과할 때만. 같은 id 의 파일이 둘 이상(연쇄 대상 포함)이거나 폴더를 못 읽으면 null —
 * 첫 일치(`resolveTranscriptFile`)는 폴더 나열 순서에 따라 다른 파일을 고를 수 있다.
 */
export function uniqueTranscriptFile(ref: AgentSessionRef): TranscriptLocation {
  const unique = resolveTranscriptUnique(ref)
  if (unique.kind !== 'found') return { kind: unique.kind }
  const file = resolveTranscriptFile(ref)
  return file === null ? { kind: 'none' } : { kind: 'found', file }
}

const STAY_OF_LOCATION = { none: 'no_file', ambiguous: 'ambiguous', error: 'scan_error' } as const

/** 기록 파일 찾기 → 766 따라가기(`empty: 'stay'`). 옮겨 간 곳 또는 머문 사유. */
export function followClaudeRef(input: { id: string; locate: (ref: AgentSessionRef) => TranscriptLocation }): FollowResult {
  const ref: AgentSessionRef = { kind: 'id', agent: 'claude', source: HERDR_CLAUDE_SOURCE, id: input.id }
  const location = input.locate(ref)
  if (location.kind !== 'found') return { kind: 'stay', reason: STAY_OF_LOCATION[location.kind] }
  const followed = followContinued({ session: ref, file: location.file, empty: 'stay' })
  return followed.hops.length > 0 && followed.sessionId !== null ? { kind: 'to', id: followed.sessionId } : { kind: 'stay', reason: 'no_hop' }
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error['code'] === 'string' ? error['code'] : String(error)
}

/**
 * 세션 디렉터리의 session.json 을 고쳐 쓴다. 서버가 멈춘 것을 확인한 호출자만 부른다(herdr 가 상주 쓰기 주체다).
 * 쓰기: 같은 디렉터리 임시 파일(`wx`, umask 와 무관하게 `fchmod` 로 원본 권한) → fsync → 원본을 다시 읽어 처음 읽은 바이트와 같을 때만 rename. 어디서 실패해도 원본은 그대로, 임시 파일은 지운다.
 */
export function rewriteRestoreRefs(input: { sessionDir: string; locate?: (ref: AgentSessionRef) => TranscriptLocation }): RestoreRewrite {
  const locate = input.locate ?? uniqueTranscriptFile
  const file = path.join(input.sessionDir, 'session.json')
  let original: Buffer
  let mode: number
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile()) return { kind: 'skipped', reason: 'session.json 이 일반 파일이 아니다' }
    mode = stat.mode & 0o777
    original = fs.readFileSync(file)
  } catch (error) {
    return { kind: 'skipped', reason: `session.json 을 읽지 못했다 (${errorCode(error)})` }
  }
  const text = original.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(original)) return { kind: 'skipped', reason: 'session.json 이 UTF-8 이 아니다' }
  const plan = planRestoreRewrite({ text, follow: (id) => followClaudeRef({ id, locate }) })
  if (plan.kind === 'unknown') return { kind: 'skipped', reason: plan.reason }
  if (plan.kind === 'same') return { kind: 'unchanged', refs: plan.refs, outcomes: plan.outcomes }
  const temp = path.join(input.sessionDir, `.session.json.corral-${process.pid}-${Date.now()}.tmp`)
  let created = false
  try {
    const fd = fs.openSync(temp, 'wx', mode)
    created = true
    try {
      fs.fchmodSync(fd, mode)
      fs.writeFileSync(fd, plan.text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    // 읽은 뒤 다른 손이 서버를 띄워 파일을 바꿨으면 그 쓰기를 덮지 않는다 — 그 쓰기를 덮을 수 있는 창은 이 비교와 rename 사이뿐이다
    // (멈춤 확인부터 rename 까지의 남는 창 전체는 머리 주석).
    if (!fs.readFileSync(file).equals(original)) {
      fs.unlinkSync(temp)
      return { kind: 'skipped', reason: '읽은 뒤 session.json 이 바뀌었다' }
    }
    fs.renameSync(temp, file)
    return { kind: 'rewritten', refs: plan.refs, moved: plan.moves.size, outcomes: plan.outcomes }
  } catch (error) {
    if (created) {
      try {
        fs.unlinkSync(temp)
      } catch {
        // 이미 없거나 rename 이 끝났다 — 남길 것이 없다.
      }
    }
    return { kind: 'failed', reason: errorCode(error) }
  }
}
