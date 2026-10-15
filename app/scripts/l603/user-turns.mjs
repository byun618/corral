#!/usr/bin/env node
// LIFE-603 R1-H ② — 그 pane 이 소유한 세션 기록에서 **사용자 턴 수**를 센다(C3 「초안은 제출되지 않음」 판정 장치).
//
//   node scripts/l603/user-turns.mjs --response <런타임 응답 JSON 파일>   # 경로·종류는 응답의 agent.sessionRecord.path · agent.kind 에서
//   node scripts/l603/user-turns.mjs --kind claude|codex|grok --file <기록 파일>
//
// 셈 규칙 — 런타임 판독(`runtime/terminal/agent.ts` §4.6)과 같은 행 필터를 **따로** 적었다(판정 장치가 판정 대상 코드를 import 하지 않게):
//   claude = `type: user` + `origin.kind: human` + 문자열 content 한 행이 한 턴(도구 결과·합성 user 행은 아니다)
//   codex  = 사람 발화 한 행이 한 턴 — 모양 둘(버전마다 한쪽): 옛 `event_msg/user_message` · 0.158 `event_msg/item_completed` 의
//            `item.type: UserMessage`(`main/transcript-parse.ts` codexUserText 와 같은 두 모양). 질문 답 봉투
//            (`<send_user_message_question_reply>`)는 턴이 아니다. 환경 주입 user 메시지(response_item)는 `aux` 로만 센다.
//   grok   = `user_message_chunk` 의 **연속된 한 덩이**가 한 턴(큰 본문은 쪼개져 올 수 있다).
// 실패 전파: 파일이 없거나 못 읽으면 exit 2, JSON 행이 하나도 없거나 그 형식의 행을 하나도 못 알아보면 exit 3
//   — 「0 턴」 과 「못 읽음」 이 같은 모양으로 나오지 않게(빈 결과는 양성 대조 뒤에야 근거). 성공은 exit 0 + JSON 한 줄.
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const KINDS = ['claude', 'codex', 'grok']
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const sha16 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** 한 행 → { known, user: string|null, chunk: boolean, aux: boolean } */
function project(kind, row) {
  if (kind === 'claude') {
    const known = typeof row.type === 'string' && (row.type === 'user' || row.type === 'assistant' || row.type === 'system' || 'sessionId' in row)
    const human = row.type === 'user' && isRecord(row.origin) && row.origin.kind === 'human' && isRecord(row.message)
    // 사람 턴의 content 가 배열이면(이미지 첨부 등 — R2-E) 그 text 블록을 이어 붙여 **턴으로 센다**. 도구 결과 user 행은 origin 이 없어 여기 안 온다.
    // 런타임 판독(`agent.ts`)은 문자열만 본다 — 이 장치는 「제출 0」 증명용이라 거짓 0 보다 거짓 1 쪽으로 틀린다.
    const content = human ? row.message.content : null
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((part) => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('') : null
    return { known, user: human ? text ?? '' : null, chunk: false, aux: false }
  }
  if (kind === 'codex') {
    const payload = isRecord(row.payload) ? row.payload : null
    const known = typeof row.type === 'string' && payload !== null
    const item = payload?.type === 'item_completed' && isRecord(payload.item) && payload.item.type === 'UserMessage' ? payload.item : null
    const itemText = item === null ? null : typeof item.content === 'string' ? item.content
      : Array.isArray(item.content) ? item.content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('') : ''
    const raw = row.type === 'event_msg' && payload?.type === 'user_message' ? String(payload.message ?? '') : row.type === 'event_msg' ? itemText : null
    const user = raw !== null && raw.trimStart().startsWith('<send_user_message_question_reply>') ? null : raw
    const aux = row.type === 'response_item' && payload?.type === 'message' && payload.role === 'user'
    return { known, user, chunk: false, aux }
  }
  const update = (isRecord(row.params) && isRecord(row.params.update) ? row.params.update : null) ?? (isRecord(row.update) ? row.update : null)
  // grok 형식은 `sessionUpdate` 문자열이 있는 행으로만 알아본다(R2-E) — `type` 만 있는 다른 형식 파일을 0 턴 성공으로 읽지 않게.
  const known = update !== null && typeof update.sessionUpdate === 'string'
  if (update?.sessionUpdate !== 'user_message_chunk') return { known, user: null, chunk: false, aux: false }
  const content = update.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => String(part?.text ?? '')).join('') : String(content?.text ?? '')
  return { known, user: text, chunk: true, aux: false }
}

export function countUserTurns({ kind, text }) {
  if (!KINDS.includes(kind)) return { ok: false, code: 'bad_kind', exit: 2 }
  let rows = 0, known = 0, aux = 0
  const turns = []
  let inChunk = false
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed
    try { parsed = JSON.parse(line) } catch { inChunk = false; continue }
    if (!isRecord(parsed)) { inChunk = false; continue }
    rows += 1
    const row = project(kind, parsed)
    if (row.known) known += 1
    if (row.aux) aux += 1
    if (row.user === null) { inChunk = false; continue }
    if (row.chunk && inChunk) { turns[turns.length - 1] += row.user; continue }
    turns.push(row.user)
    inChunk = row.chunk
  }
  if (rows === 0) return { ok: false, code: 'no_json_rows', exit: 3 }
  if (known === 0) return { ok: false, code: 'format_unrecognized', exit: 3, rows }
  return { ok: true, kind, rows, known, userTurns: turns.length, turnSha: turns.map((turn) => bodySha(turn)), aux: kind === 'codex' ? { responseItemUser: aux } : null }
}

/** 본문 비교용 정규화 — CR·CRLF → LF, 끝 공백 제거. 비교는 sha256 앞 16자. */
export function bodySha(text) {
  return sha16(text.replace(/\r\n?/g, '\n').replace(/\s+$/u, ''))
}

/**
 * provider 의 기록 루트 — 런타임 `ownedRecords`(`runtime/terminal/agent.ts`)와 같은 자리:
 * claude `$CLAUDE_CONFIG_DIR|~/.claude/projects` · codex `$CODEX_HOME|~/.codex/sessions` · grok `$GROK_HOME|~/.grok/sessions`.
 */
export function recordsRoot({ kind, env = process.env, home = os.homedir() }) {
  if (kind === 'claude') return path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'projects')
  if (kind === 'codex') return path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions')
  return path.join(env.GROK_HOME ?? path.join(home, '.grok'), 'sessions')
}

/**
 * 「제출 전 0 턴」 판독(R2-E). 기록 파일이 없을 수 있다 — claude 는 첫 사용자 메시지 전엔 파일도, 그 프로젝트 디렉터리도 만들지 않는다
 * (리뷰 실측 `claude-r2-raw/claude-no-transcript-before-first-turn.txt` · `rt-draft1.json` 의 `exists:false`).
 * 그래서 「없음」 을 0 턴으로 읽는 조건은 바로 위 디렉터리가 아니라 **경로가 provider 기록 루트 아래이고 그 루트가 있다**는 것이다 —
 * 경로 계산이 틀려(엉뚱한 곳 · 루트 없음) 없는 것과 가르기 위해. 경로는 런타임 응답이 준 것만 쓴다(`--response`).
 */
export function readBefore({ kind, file, root = recordsRoot({ kind }), exists = fs.existsSync, read = (target) => fs.readFileSync(target, 'utf8') }) {
  if (!exists(file)) {
    const under = path.resolve(file).startsWith(path.resolve(root) + path.sep)
    if (!under) return { ok: false, code: 'outside_records_root', exit: 2, file, root }
    if (!exists(root)) return { ok: false, code: 'records_root_missing', exit: 2, file, root }
    return { ok: true, kind, file, root, state: 'absent', userTurns: 0, turnSha: [] }
  }
  const counted = countUserTurns({ kind, text: read(file) })
  return counted.ok ? { ...counted, file, state: 'present' } : { ...counted, file }
}

/**
 * Enter 뒤 같은 경로에서 정확히 1 턴 · 그 턴이 기대 본문(R2-E 양성 대조). 앞 판독이 「0 턴」 이어야 하고, 같은 경로여야 한다.
 * 둘 다 맞아야 `proved` — 앞의 0 턴은 이 대조가 통과할 때만 증거다(못 보는 것과 없는 것은 같은 모양으로 나온다).
 */
export function verdict({ before, after, expectedSha }) {
  if (!before.ok || before.userTurns !== 0) return { proved: false, why: 'before_not_zero', before }
  if (!after.ok) return { proved: false, why: 'after_unreadable', after }
  if (after.file !== before.file) return { proved: false, why: 'path_changed' }
  if (after.userTurns !== 1) return { proved: false, why: 'after_not_one', userTurns: after.userTurns }
  if (after.turnSha[0] !== expectedSha) return { proved: false, why: 'body_mismatch', got: after.turnSha[0], want: expectedSha }
  return { proved: true }
}

function sessionFromResponse(value) {
  const candidates = [value, value?.result, value?.result?.result]
  for (const candidate of candidates) {
    const agent = isRecord(candidate) && isRecord(candidate.agent) ? candidate.agent : null
    const file = agent?.sessionRecord?.path
    if (typeof file === 'string' && KINDS.includes(agent.kind)) return { kind: agent.kind, file }
  }
  return null
}

function main(argv) {
  const flag = (name) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined }
  const mode = argv[0] === 'before' || argv[0] === 'after' ? argv[0] : null
  if (mode !== null) return procedure({ mode, flag })
  let kind = flag('kind'), file = flag('file')
  const response = flag('response')
  if (response !== undefined) {
    let value
    try { value = JSON.parse(fs.readFileSync(response, 'utf8')) } catch (error) { console.log(JSON.stringify({ ok: false, code: 'response_unreadable', error: String(error) })); return 2 }
    const found = sessionFromResponse(value)
    if (found === null) { console.log(JSON.stringify({ ok: false, code: 'no_session_record_in_response' })); return 2 }
    kind = found.kind; file = found.file
  }
  if (kind === undefined || file === undefined) { console.log(JSON.stringify({ ok: false, code: 'usage', usage: '--response <json> | --kind <k> --file <f>' })); return 2 }
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (error) { console.log(JSON.stringify({ ok: false, code: 'record_unreadable', file, error: String(error) })); return 2 }
  const result = countUserTurns({ kind, text })
  console.log(JSON.stringify({ ...result, file }))
  return result.ok ? 0 : result.exit
}

/**
 * 절차(R2-E) — 같은 기록 경로로 두 번:
 *   before --response <worktree create 응답 JSON> --state <상태 파일> [--records-root <루트>]   # 초안 직후(그리고 30초 뒤 다시). 없음이면 기록 루트 확인 후 0 턴
 *   after  --state <상태 파일> --body-file <기대 본문>                  # 사람이 Enter 를 누른 뒤. 같은 경로 · 정확히 1 턴 · 본문 sha 일치
 * after 의 exit 0 = 증명(proved). before 만으로는 증거가 아니다. 상태 파일엔 경로 · 종류 · 앞 판독만(본문 없음).
 */
function procedure({ mode, flag }) {
  const stateFile = flag('state')
  if (stateFile === undefined) { console.log(JSON.stringify({ ok: false, code: 'usage', usage: 'before --response <json> --state <f> | after --state <f> --body-file <f>' })); return 2 }
  if (mode === 'before') {
    const response = flag('response')
    let value
    try { value = JSON.parse(fs.readFileSync(response ?? '', 'utf8')) } catch (error) { console.log(JSON.stringify({ ok: false, code: 'response_unreadable', error: String(error) })); return 2 }
    const found = sessionFromResponse(value)
    if (found === null) { console.log(JSON.stringify({ ok: false, code: 'no_session_record_in_response' })); return 2 }
    const before = readBefore({ ...found, ...(flag('records-root') === undefined ? {} : { root: flag('records-root') }) })
    const previous = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null
    if (previous !== null && previous.file !== found.file) { console.log(JSON.stringify({ ok: false, code: 'path_changed', previous: previous.file, now: found.file })); return 3 }
    const reads = [...(previous?.reads ?? []), { at: new Date().toISOString(), ...before }]
    fs.writeFileSync(stateFile, JSON.stringify({ kind: found.kind, file: found.file, reads }, null, 2) + '\n')
    console.log(JSON.stringify(before))
    return before.ok && before.userTurns === 0 ? 0 : before.ok ? 1 : before.exit
  }
  let state, body
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); body = fs.readFileSync(flag('body-file') ?? '', 'utf8') } catch (error) { console.log(JSON.stringify({ ok: false, code: 'state_or_body_unreadable', error: String(error) })); return 2 }
  const reads = Array.isArray(state.reads) ? state.reads : []
  const worst = reads.find((read) => !read.ok || read.userTurns !== 0) ?? reads[reads.length - 1] ?? { ok: false, code: 'no_before' }
  let after
  try { after = { ...countUserTurns({ kind: state.kind, text: fs.readFileSync(state.file, 'utf8') }), file: state.file } } catch (error) { after = { ok: false, code: 'record_unreadable', file: state.file, error: String(error) } }
  const result = { ...verdict({ before: worst, after, expectedSha: bodySha(body) }), beforeReads: reads.length, file: state.file }
  console.log(JSON.stringify(result))
  return result.proved ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
