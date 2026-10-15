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
