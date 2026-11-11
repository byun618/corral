// herdr 재시작 재개 참조 고쳐 쓰기 (LIFE-772) — corral 이 멈춘 `default` 서버를 띄우기 직전에, 그 세션 `session.json` 의 claude 참조를
// 백그라운드 전환(`continued-in`) 끝 id 로 바꾼다. herdr 는 저장 참조 그대로 `claude --resume <id>` 로 재개하므로(0.9.0 `agent_resume.rs` `plan()`),
// 옛 id 로 두면 전환 시점에 멈춘 사본이 열리고 그 뒤 입력이 옛 파일에 이어 써져 대화가 갈라진다.
//
// 판별은 LIFE-766 `followContinued` 한 벌을 그대로 쓴다(`empty: 'stay'` — 대화가 있는 대상까지만, 되살아남·모름·창 밖·대상 없음은 옛 id). 기록 파일 찾기도
// 기존 해소(`resolveTranscriptFile`)다. **살아 있는 herdr 상태는 바꾸지 않는다** — 서버가 멈춘 것이 확인된 그 자리(`BackendStarter.beforeSpawn`)에서만 파일을 쓴다.
//
// 안전한 실패: 구조를 모르거나·판별이 결론을 못 내거나·쓰기가 실패하면 파일을 그대로 두고 지금처럼 띄운다. 바뀌는 바이트는 claude 참조 `value` 문자열뿐이다 —
// 같은 디렉터리 임시 파일에 쓰고 rename 한다. 읽은 뒤 다른 손(사용자가 친 `herdr`)이 파일을 바꿨으면 rename 하지 않는다.
import fs from 'node:fs'
import path from 'node:path'
import { isRecord } from '../../../shared/json.js'
import type { AgentSessionRef } from '../../../shared/types.js'
import { followContinued, SESSION_ID } from '../../transcript-continued.js'
import { resolveTranscriptFile } from '../../transcript.js'
import { restorePaneMaps } from './server.js'

/** herdr 가 claude pane 에 남기는 참조의 출처 — herdr 재개 표가 `claude --resume` 으로 옮기는 그 칸이다. */
const HERDR_CLAUDE_SOURCE = 'herdr:claude'

export type RestoreRewrite =
  | { kind: 'skipped'; reason: string }
  | { kind: 'unchanged'; refs: number }
  | { kind: 'rewritten'; refs: number; moved: number }
  | { kind: 'failed'; reason: string }

export type RestoreRewritePlan =
  | { kind: 'unknown'; reason: string }
  | { kind: 'same'; refs: number }
  | { kind: 'moved'; refs: number; moves: ReadonlyMap<string, string>; text: string }

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
export function planRestoreRewrite(input: { text: string; follow: (id: string) => string | null }): RestoreRewritePlan {
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
  for (const ref of found.refs) {
    const from = claudeIdRef(ref)
    if (from === null || moves.has(from)) continue
    const to = input.follow(from)
    if (to === null || to === from || !SESSION_ID.test(to) || taken.has(to)) continue
    moves.set(from, to)
    taken.add(to)
  }
  if (moves.size === 0) return { kind: 'same', refs: found.refs.length }
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
  return { kind: 'moved', refs: found.refs.length, moves, text }
}

/** 기록 파일 찾기 → 766 따라가기(`empty: 'stay'`). 옮겨 간 곳이 없으면 null. */
export function followClaudeRef(input: { id: string; locate: (ref: AgentSessionRef) => string | null }): string | null {
  const ref: AgentSessionRef = { kind: 'id', agent: 'claude', source: HERDR_CLAUDE_SOURCE, id: input.id }
  const file = input.locate(ref)
  if (file === null) return null
  const followed = followContinued({ session: ref, file, empty: 'stay' })
  return followed.hops.length > 0 ? followed.sessionId : null
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error['code'] === 'string' ? error['code'] : String(error)
}

/**
 * 세션 디렉터리의 session.json 을 고쳐 쓴다. 서버가 멈춘 것을 확인한 호출자만 부른다(herdr 가 상주 쓰기 주체다).
 * 쓰기: 같은 디렉터리 임시 파일(`wx`, 원본 권한) → fsync → 원본을 다시 읽어 처음 읽은 바이트와 같을 때만 rename. 어디서 실패해도 원본은 그대로, 임시 파일은 지운다.
 */
export function rewriteRestoreRefs(input: { sessionDir: string; locate?: (ref: AgentSessionRef) => string | null }): RestoreRewrite {
  const locate = input.locate ?? resolveTranscriptFile
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
  if (plan.kind === 'same') return { kind: 'unchanged', refs: plan.refs }
  const temp = path.join(input.sessionDir, `.session.json.corral-${process.pid}-${Date.now()}.tmp`)
  let created = false
  try {
    const fd = fs.openSync(temp, 'wx', mode)
    created = true
    try {
      fs.writeFileSync(fd, plan.text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    // 읽은 뒤 다른 손이 서버를 띄워 파일을 바꿨으면 그 쓰기를 덮지 않는다 — 남는 창은 이 비교와 rename 사이뿐이다.
    if (!fs.readFileSync(file).equals(original)) {
      fs.unlinkSync(temp)
      return { kind: 'skipped', reason: '읽은 뒤 session.json 이 바뀌었다' }
    }
    fs.renameSync(temp, file)
    return { kind: 'rewritten', refs: plan.refs, moved: plan.moves.size }
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

/**
 * spawn 직전 고리(`BackendStarter.beforeSpawn`) — 바인딩 세션(corral 이 띄우지 않는다)이면 아무것도 하지 않는다.
 * 결과는 로그 한 줄(개수만 — 세션 id·경로는 싣지 않는다).
 */
export function rewriteBeforeSpawn(input: {
  bound: string | null
  sessionDir: string | null
  rewrite: (sessionDir: string) => RestoreRewrite
  log: (event: string, data: Record<string, unknown>) => void
}): void {
  if (input.bound !== null) return
  if (input.sessionDir === null) {
    input.log('herdr.restore_rewrite', { kind: 'skipped', reason: '세션 디렉터리를 알 수 없다' })
    return
  }
  input.log('herdr.restore_rewrite', { ...input.rewrite(input.sessionDir) })
}
