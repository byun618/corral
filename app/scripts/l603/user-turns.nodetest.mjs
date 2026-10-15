// LIFE-603 R1-H ② 자기점검 — 판독기가 0·1·2 턴을 가르고, 못 읽음을 0 턴으로 읽지 않는다(판별력 · 실패 전파).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { countUserTurns } from './user-turns.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const lines = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
const claudeUser = (text) => ({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text }, timestamp: '2026-10-15T00:00:00Z' })
const claudeTool = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }
const claudeAssistant = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }
const codexUser = (text) => ({ type: 'event_msg', payload: { type: 'user_message', message: text } })
const codexInjected = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>' }] } }
const codexMeta = { type: 'session_meta', payload: { id: 's' } }
const grokChunk = (text) => ({ params: { update: { sessionUpdate: 'user_message_chunk', content: { text } } } })
const grokAgent = { params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'ok' } } } }

test('claude — 0 턴(초안만, 응답 없음) · 1 턴 · 도구 결과 user 행은 세지 않는다', () => {
  assert.equal(countUserTurns({ kind: 'claude', text: lines([claudeAssistant]) }).userTurns, 0)
  assert.equal(countUserTurns({ kind: 'claude', text: lines([claudeUser('본문'), claudeTool, claudeAssistant]) }).userTurns, 1)
  assert.equal(countUserTurns({ kind: 'claude', text: lines([claudeUser('a'), claudeAssistant, claudeUser('b')]) }).userTurns, 2)
})
test('codex — event_msg user_message 만 턴, 주입 user 메시지는 aux 로만', () => {
  const zero = countUserTurns({ kind: 'codex', text: lines([codexMeta, codexInjected]) })
  assert.equal(zero.userTurns, 0)
  assert.deepEqual(zero.aux, { responseItemUser: 1 })
  assert.equal(countUserTurns({ kind: 'codex', text: lines([codexMeta, codexInjected, codexUser('본문')]) }).userTurns, 1)
  const item = (text) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } })
  assert.equal(countUserTurns({ kind: 'codex', text: lines([codexMeta, item('0.158 모양')]) }).userTurns, 1)
  assert.equal(countUserTurns({ kind: 'codex', text: lines([codexMeta, item('<send_user_message_question_reply>[]</send_user_message_question_reply>')]) }).userTurns, 0)
})
test('grok — 연속 chunk 덩이 하나가 한 턴, 사이에 다른 행이 끼면 두 턴', () => {
  const one = countUserTurns({ kind: 'grok', text: lines([grokChunk('앞'), grokChunk('뒤'), grokAgent]) })
  assert.equal(one.userTurns, 1)
  assert.equal(countUserTurns({ kind: 'grok', text: lines([grokChunk('a'), grokAgent, grokChunk('b')]) }).userTurns, 2)
  assert.equal(countUserTurns({ kind: 'grok', text: lines([grokAgent]) }).userTurns, 0)
})
test('실패 전파 — 빈 파일 · 모르는 형식은 0 턴이 아니라 실패(exit 3), 없는 파일은 exit 2', () => {
  assert.deepEqual(countUserTurns({ kind: 'claude', text: '' }), { ok: false, code: 'no_json_rows', exit: 3 })
  assert.equal(countUserTurns({ kind: 'codex', text: lines([{ foo: 1 }]) }).code, 'format_unrecognized')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l603-turns-'))
  try {
    const run = (args) => spawnSync(process.execPath, [path.join(here, 'user-turns.mjs'), ...args], { encoding: 'utf8' })
    assert.equal(run(['--kind', 'claude', '--file', path.join(dir, 'none.jsonl')]).status, 2)
    const empty = path.join(dir, 'empty.jsonl'); fs.writeFileSync(empty, '')
    assert.equal(run(['--kind', 'claude', '--file', empty]).status, 3)
    // 런타임 응답에서 경로를 읽는 길(양성 대조: 1 턴 → exit 0)
    const record = path.join(dir, 'c.jsonl'); fs.writeFileSync(record, lines([claudeUser('본문'), claudeAssistant]))
    const response = path.join(dir, 'resp.json'); fs.writeFileSync(response, JSON.stringify({ ok: true, result: { agent: { kind: 'claude', sessionRecord: { path: record, exists: true } } } }))
    const ok = run(['--response', response])
    assert.equal(ok.status, 0)
    assert.equal(JSON.parse(ok.stdout).userTurns, 1)
    const noRecord = path.join(dir, 'resp2.json'); fs.writeFileSync(noRecord, JSON.stringify({ ok: true, result: { agent: { kind: 'claude', sessionRecord: null } } }))
    assert.equal(run(['--response', noRecord]).status, 2)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// --- fix2 R2-E -----------------------------------------------------------------------------------
import { bodySha, readBefore, verdict } from './user-turns.mjs'

test('R2-E grok 형식 판별 — claude 기록 · type 만 있는 파일은 0 턴 성공이 아니라 format_unrecognized', () => {
  assert.equal(countUserTurns({ kind: 'grok', text: lines([claudeUser('본문'), claudeAssistant]) }).code, 'format_unrecognized')
  assert.equal(countUserTurns({ kind: 'grok', text: lines([{ type: 'not-a-session' }]) }).code, 'format_unrecognized')
  assert.equal(countUserTurns({ kind: 'grok', text: lines([grokAgent]) }).ok, true)
})

test('R2-E claude 사람 턴 content 가 배열이어도 턴으로 센다(도구 결과는 여전히 아님)', () => {
  const arrayTurn = { type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: '그림과 함께' }, { type: 'image', source: {} }] } }
  const counted = countUserTurns({ kind: 'claude', text: lines([arrayTurn, claudeTool, claudeAssistant]) })
  assert.equal(counted.userTurns, 1)
  assert.deepEqual(counted.turnSha, [bodySha('그림과 함께')])
})

test('R2-E 인접한 두 제출 조각은 1 턴으로 합쳐지지만 sha 대조가 거른다', () => {
  const merged = countUserTurns({ kind: 'grok', text: lines([grokChunk('첫 제출'), grokChunk('둘째 제출'), grokAgent]) })
  assert.equal(merged.userTurns, 1)
  const before = { ok: true, userTurns: 0, file: '/f' }
  assert.deepEqual(verdict({ before, after: { ...merged, file: '/f' }, expectedSha: bodySha('첫 제출') }).why, 'body_mismatch')
  assert.equal(verdict({ before, after: { ...countUserTurns({ kind: 'grok', text: lines([grokChunk('첫 제출'), grokAgent]) }), file: '/f' }, expectedSha: bodySha('첫 제출\r\n') }).proved, true)
})

test('R2-E readBefore — 없는 파일은 기록 루트 아래이고 루트가 있을 때만 0 턴(프로젝트 디렉터리는 없어도 된다), 아니면 실패', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l603-before-'))
  try {
    const file = path.join(dir, '-tmp-repo-wt', 's.jsonl') // claude 처럼 프로젝트 디렉터리도 아직 없음
    assert.deepEqual(readBefore({ kind: 'claude', file, root: dir }), { ok: true, kind: 'claude', file, root: dir, state: 'absent', userTurns: 0, turnSha: [] })
    assert.equal(readBefore({ kind: 'claude', file, root: path.join(dir, 'other-root') }).code, 'outside_records_root')
    assert.equal(readBefore({ kind: 'claude', file: path.join(dir, 'gone', 'x', 's.jsonl'), root: path.join(dir, 'gone') }).code, 'records_root_missing')
    fs.writeFileSync(path.join(dir, 'p.jsonl'), lines([claudeUser('이미 제출'), claudeAssistant]))
    assert.equal(readBefore({ kind: 'claude', file: path.join(dir, 'p.jsonl'), root: dir }).userTurns, 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('R2-E 실제 런타임 응답(리뷰 격리 실측 rt-draft1.json) — 경로 · 종류를 읽고 그 경로가 claude 기록 루트 규칙과 맞다', () => {
  const real = path.join(here, 'fixtures', 'rt-draft1.json')
  const run = spawnSync(process.execPath, [path.join(here, 'user-turns.mjs'), '--response', real], { encoding: 'utf8' })
  const out = JSON.parse(run.stdout)
  // 기록 파일은 없다(초안 전 · 신뢰 화면) — 옛 모드는 읽기 실패(exit 2)
  assert.equal(run.status, 2)
  assert.equal(out.code, 'record_unreadable')
  assert.match(out.file, /\/\.claude\/projects\/-private-tmp-l603r2c-repo--claude-worktrees-draft1\/90002283-f288-40f9-bb14-78ef40d96a42\.jsonl$/)
  // 같은 응답을 before 절차로 — 루트를 그 경로의 claude 루트로 두면 없음 = 0 턴(루트는 시험용 임시 디렉터리로 대신, 실제 사용자 디렉터리 무접촉)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l603-real-'))
  try {
    const value = JSON.parse(fs.readFileSync(real, 'utf8'))
    const projects = path.join(dir, '.claude', 'projects')
    fs.mkdirSync(projects, { recursive: true })
    value.result.agent.sessionRecord.path = value.result.agent.sessionRecord.path.replace(/^.*\/\.claude\/projects/, projects)
    const response = path.join(dir, 'resp.json'); fs.writeFileSync(response, JSON.stringify(value))
    const before = spawnSync(process.execPath, [path.join(here, 'user-turns.mjs'), 'before', '--response', response, '--state', path.join(dir, 'st.json'), '--records-root', projects], { encoding: 'utf8' })
    assert.equal(before.status, 0, before.stdout)
    assert.equal(JSON.parse(before.stdout).state, 'absent')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('R2-E 절차 before → after — 없음(0) → Enter 뒤 같은 경로 1 턴 · 본문 일치면 proved, 어긋나면 비0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l603-proc-'))
  const run = (args) => spawnSync(process.execPath, [path.join(here, 'user-turns.mjs'), ...args], { encoding: 'utf8' })
  try {
    const record = path.join(dir, 'session.jsonl')
    const response = path.join(dir, 'create.json')
    fs.writeFileSync(response, JSON.stringify({ ok: true, result: { agent: { kind: 'claude', sessionRecord: { path: record, exists: false } } } }))
    const state = path.join(dir, 'state.json')
    const body = path.join(dir, 'body.txt'); fs.writeFileSync(body, '작업 본문\n둘째 줄\n')
    assert.equal(run(['before', '--response', response, '--state', state, '--records-root', dir]).status, 0)
    assert.equal(run(['before', '--response', response, '--state', state, '--records-root', dir]).status, 0) // 30초 뒤 재판독 자리
    // Enter 전에 after — 파일이 없어 증명 불가
    assert.equal(run(['after', '--state', state, '--body-file', body]).status, 1)
    fs.writeFileSync(record, lines([claudeUser('작업 본문\n둘째 줄'), claudeAssistant]))
    const ok = run(['after', '--state', state, '--body-file', body])
    assert.equal(ok.status, 0, ok.stdout)
    assert.equal(JSON.parse(ok.stdout).beforeReads, 2)
    // 다른 본문이 들어갔으면 증명 아님
    fs.writeFileSync(record, lines([claudeUser('다른 글'), claudeAssistant]))
    assert.equal(JSON.parse(run(['after', '--state', state, '--body-file', body]).stdout).why, 'body_mismatch')
    // 두 번 제출됐으면 증명 아님
    fs.writeFileSync(record, lines([claudeUser('작업 본문\n둘째 줄'), claudeAssistant, claudeUser('작업 본문\n둘째 줄')]))
    assert.equal(JSON.parse(run(['after', '--state', state, '--body-file', body]).stdout).why, 'after_not_one')
    // 앞 판독에서 이미 1 턴이었으면(초안이 제출됨) 증명 아님
    const state2 = path.join(dir, 'state2.json')
    fs.writeFileSync(record, lines([claudeUser('작업 본문\n둘째 줄'), claudeAssistant]))
    assert.equal(run(['before', '--response', response, '--state', state2, '--records-root', dir]).status, 1)
    assert.equal(JSON.parse(run(['after', '--state', state2, '--body-file', body]).stdout).why, 'before_not_zero')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
