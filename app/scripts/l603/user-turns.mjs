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

const KINDS = ['claude', 'codex', 'grok']
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const sha16 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** 한 행 → { known, user: string|null, chunk: boolean, aux: boolean } */
function project(kind, row) {
  if (kind === 'claude') {
    const known = typeof row.type === 'string' && (row.type === 'user' || row.type === 'assistant' || row.type === 'system' || 'sessionId' in row)
    const human = row.type === 'user' && isRecord(row.origin) && row.origin.kind === 'human' && isRecord(row.message) && typeof row.message.content === 'string'
    return { known, user: human ? row.message.content : null, chunk: false, aux: false }
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
  const known = update !== null || typeof row.type === 'string'
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
  return { ok: true, kind, rows, known, userTurns: turns.length, turnSha: turns.map(sha16), aux: kind === 'codex' ? { responseItemUser: aux } : null }
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

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
