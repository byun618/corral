// LIFE-582 r11 F3 — grok-4.7-build 의 `ask_user_question` 결과는 `rawOutput.UserAnswered` 가 `{ message }` 하나다(`answers` 없음).
// 서버 답 확인은 그 글을 읽어 delivered 했는데 대화 카드는 「답함 → (답을 기록에서 찾지 못함)」 이었다(네이티브 n9-k1-q).
// fixture = 그 실기록 `updates.jsonl` 에서 질문·답 세 줄만 자르고 세션·호출·프롬프트 id 를 가짜로 바꾼 것(경로 없음).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChatBuilder, grokAnsweredMessage, type ChatItem } from '../chat-parse.js'
import { answerMatches, recordedAnswers } from './input.js'

const lines = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/grok-4.7-question.jsonl'), 'utf8').trim().split('\n')
const CALL = 'call-00000000-0000-4000-8000-0000000000aa-0'
const QUESTION = 'Choose Left or Right.'

function build(input: string[]): ChatItem[] {
  const builder = new ChatBuilder({ agent: 'grok', sessionId: null })
  let offset = 0
  for (const line of input) {
    builder.feed({ offset, line })
    offset += Buffer.byteLength(line) + 1
  }
  return builder.items
}
const answerOf = (items: ChatItem[]): unknown[] => items.flatMap((item) => (item.kind === 'question' ? [[item.state, item.answer]] : []))
/** 실측 형식 그대로 `message` 만 바꾼 결과 줄 — 문항 여럿 · 직접 입력. */
const result = (message: string): string => {
  const record = JSON.parse(lines[2]!)
  record.params.update.content[0].content.text = message
  record.params.update.rawOutput.UserAnswered.message = message
  return JSON.stringify(record)
}

describe('F3 Grok 4.7 질문 답 — 대화 카드와 서버 답 확인이 같은 글을 읽는다', () => {
  it('실기록 줄: 카드는 「답함 → Right」', () => {
    expect(answerOf(build(lines))).toEqual([['answered', 'Right']])
  })

  it('서버 답 확인도 같은 글(`grokAnsweredMessage`)에서 `"Right"` 를 읽고 고른 선택지와 맞춘다', () => {
    expect(grokAnsweredMessage(JSON.parse(lines[2]!).params.update.rawOutput)).toBe(`User has answered your questions: "${QUESTION}"="Right". You can now continue with the user's answers in mind.`)
    const recorded = recordedAnswers({ kind: 'grok', text: lines.join('\n'), call: CALL, questions: [QUESTION] })
    expect(recorded).toEqual({ kind: 'ok', values: ['"Right"'] })
    const questions = [{ question: QUESTION, header: null, options: [{ label: 'Left', description: null }, { label: 'Right', description: null }], multiSelect: null }]
    if (recorded.kind !== 'ok') throw new Error('unreadable')
    expect(answerMatches({ kind: 'grok', recorded: recorded.values, questions, answers: [{ choices: [1], other: null }] })).toBe(true)
  })

  it('직접 입력은 접두를 떼고 · 경계를 못 읽으면 못 찾음 그대로', () => {
    const other = result(`User has answered your questions: "${QUESTION}"="Other" user notes: 가운데, "진짜". You can now continue with the user's answers in mind.`)
    expect(answerOf(build([lines[0]!, lines[1]!, other]))).toEqual([['answered', '가운데, "진짜"']])
    const broken = result(`User has answered: Right`)
    expect(answerOf(build([lines[0]!, lines[1]!, broken]))).toEqual([['answered', null]])
  })
})
