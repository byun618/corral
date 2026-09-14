// A9·A10 의 재료 — **관측된 형식만 다룬다**는 원칙의 근거를 만든다.
//
// 두 가지를 잰다:
//   ① codex·grok 트랜스크립트의 실제 레코드 모양 (Grok 서치의 단독 주장을 사실로 쓰지 않는다 —
//      `00-analysis.md` §9.2. 여기서 Claude 가 직접 연다)
//   ② claude 트랜스크립트의 마지막 어시스턴트 텍스트에 **실제로 섞여 나오는 오염 형식**
//
// 원자료 규칙(킥오프): 사용자 대화 **내용은 커밋하지 않는다.** 모양·개수·길이만 싣고,
// 오염 형식은 그 형식을 식별할 수 있는 최소한만 인용한다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeRaw } from './lib.mjs'

const TAIL_BYTES = 256 * 1024

function readTail(file, bytes = TAIL_BYTES) {
  const size = fs.statSync(file).size
  const from = Math.max(0, size - bytes)
  const handle = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(size - from)
    fs.readSync(handle, buffer, 0, buffer.length, from)
    return { text: buffer.toString('utf8'), partial: from > 0, size }
  } finally {
    fs.closeSync(handle)
  }
}

function lines(tail) {
  const list = tail.text.split('\n')
  if (tail.partial) list.shift()
  return list.filter((line) => line.trim().length > 0)
}

/** 레코드 모양 요약 — 값은 안 싣고 **키와 타입만**. */
function shapeOf(record, depth = 0) {
  if (Array.isArray(record)) return depth > 1 ? 'array' : [shapeOf(record[0], depth + 1)]
  if (record === null || typeof record !== 'object') return typeof record
  if (depth > 2) return 'object'
  const out = {}
  for (const [key, value] of Object.entries(record)) out[key] = shapeOf(value, depth + 1)
  return out
}

function surveyCodex() {
  const dir = path.join(os.homedir(), '.codex/sessions')
  if (!fs.existsSync(dir)) return { dir, files: 0, note: '없음' }
  const files = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl')) files.push(full)
    }
  }
  walk(dir)
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  const samples = []
  for (const file of files.slice(0, 3)) {
    const tail = readTail(file)
    const kinds = new Map()
    let lastAssistant = null
    for (const line of lines(tail)) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const key = `${record.type}/${record.payload?.type ?? ''}/${record.payload?.role ?? ''}`
      kinds.set(key, (kinds.get(key) ?? 0) + 1)
      if (record.payload?.role === 'assistant') lastAssistant = record
    }
    samples.push({
      file: path.basename(file),
      /** 파일 이름에서 세션 id 를 되뽑을 수 있나 — 참조가 id 뿐이라 이게 해소 규칙이 된다. */
      idFromName: /rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f-]{36})\.jsonl$/.exec(path.basename(file))?.[1] ?? null,
      bytes: tail.size,
      kindsInTail: Object.fromEntries(kinds),
      lastAssistantShape: lastAssistant === null ? null : shapeOf(lastAssistant),
      lastAssistantTextLen:
        lastAssistant?.payload?.content?.find?.((block) => typeof block?.text === 'string')?.text?.length ?? null,
      /** 블록 `type` 값 — 판독기가 무엇을 집어야 하는지가 여기 있다. */
      lastAssistantBlockTypes: Array.isArray(lastAssistant?.payload?.content)
        ? lastAssistant.payload.content.map((block) => block?.type ?? null)
        : null,
    })
  }
  return { dir, files: files.length, samples }
}

function surveyGrok() {
  const dir = path.join(os.homedir(), '.grok/sessions')
  if (!fs.existsSync(dir)) return { dir, files: 0, note: '없음' }
  const chats = []
  for (const cwdEntry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!cwdEntry.isDirectory()) continue
    const cwdDir = path.join(dir, cwdEntry.name)
    for (const sessionEntry of fs.readdirSync(cwdDir, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue
      const file = path.join(cwdDir, sessionEntry.name, 'chat_history.jsonl')
      if (fs.existsSync(file)) chats.push({ file, sessionId: sessionEntry.name, cwdDir: cwdEntry.name })
    }
  }
  chats.sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs)
  const samples = []
  for (const chat of chats.slice(0, 3)) {
    const tail = readTail(chat.file)
    const kinds = new Map()
    let lastAssistant = null
    for (const line of lines(tail)) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const key = `${record.type ?? ''}/${record.role ?? ''}/${typeof record.content}`
      kinds.set(key, (kinds.get(key) ?? 0) + 1)
      if (record.type === 'assistant' || record.role === 'assistant') lastAssistant = record
    }
    samples.push({
      file: path.relative(dir, chat.file),
      /** 폴더 이름이 세션 id 다 — `<sessions>/<urlencoded cwd>/<session-id>/chat_history.jsonl`. */
      sessionIdFromDir: chat.sessionId,
      bytes: tail.size,
      kindsInTail: Object.fromEntries(kinds),
      lastAssistantShape: lastAssistant === null ? null : shapeOf(lastAssistant),
      lastAssistantTextLen: typeof lastAssistant?.content === 'string' ? lastAssistant.content.length : null,
    })
  }
  return { dir, sessions: chats.length, samples }
}

/** claude 의 마지막 어시스턴트 텍스트에 **실제로** 나오는 오염 형식을 센다. */
function surveyContamination() {
  const dir = path.join(os.homedir(), '.claude/projects')
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of fs.readdirSync(path.join(dir, entry.name))) {
      if (!file.endsWith('.jsonl')) continue
      const full = path.join(dir, entry.name, file)
      if (fs.statSync(full).size < 20000) continue
      files.push(full)
    }
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  const patterns = {
    'xml 봉투 <command-*>': /<command-[a-z-]+>/,
    '<local-command-stdout>': /<local-command-stdout>/,
    '[Request interrupted…]': /\[Request interrupted/,
    '대괄호 시스템 문구 (그 밖)': /^\[[A-Z][^\]]{3,60}\]/,
    '마크다운 헤더/목록 줄바꿈': /\n[#\-*]/,
    'tool 결과 JSON 이 텍스트로': /^\s*\{"(type|tool_use_id)"/,
  }
  const counts = Object.fromEntries(Object.keys(patterns).map((key) => [key, 0]))
  const examples = {}
  let scanned = 0
  let withText = 0
  // **오염 형식이 어느 레인에 사는가** — 2차 줄은 assistant 만 보므로, user 쪽에 있다면
  // 그 형식을 지우는 코드는 만들 이유가 없다. 그 근거를 같이 센다.
  const userLaneCounts = Object.fromEntries(Object.keys(patterns).map((key) => [key, 0]))
  for (const file of files.slice(0, 30)) {
    const tail = readTail(file)
    scanned += 1
    let text = null
    const list = lines(tail)
    for (let i = list.length - 1; i >= 0 && text === null; i -= 1) {
      let record
      try {
        record = JSON.parse(list[i])
      } catch {
        continue
      }
      if (record.type !== 'assistant') continue
      const blocks = record.message?.content
      if (!Array.isArray(blocks)) continue
      const joined = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (joined.trim().length > 0) text = joined
    }
    // user 레인 — 같은 꼬리에서 user 레코드 텍스트를 모아 같은 패턴으로 센다.
    const userText = []
    for (const line of list) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record.type !== 'user') continue
      const content = record.message?.content
      if (typeof content === 'string') userText.push(content)
      else if (Array.isArray(content)) {
        for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') userText.push(block.text)
      }
    }
    const userJoined = userText.join('\n')
    for (const [label, pattern] of Object.entries(patterns)) {
      if (pattern.test(userJoined)) userLaneCounts[label] += 1
    }

    if (text === null) continue
    withText += 1
    for (const [label, pattern] of Object.entries(patterns)) {
      if (!pattern.test(text)) continue
      counts[label] += 1
      // 형식을 알아볼 최소한만 남긴다 — 대화 내용을 커밋하지 않는다.
      if (examples[label] === undefined) {
        const match = pattern.exec(text)
        examples[label] = String(match?.[0] ?? '').slice(0, 40)
      }
    }
  }
  return {
    scannedFiles: scanned,
    filesWithAssistantText: withText,
    /** **2차 줄이 실제로 보는 레인** (마지막 어시스턴트 텍스트)에서 센 것. */
    assistantLaneCounts: counts,
    /** 참고 — 같은 파일의 user 레인. 형식이 존재는 하나 2차 줄에 닿지 않음을 보이는 대조군. */
    userLaneCounts,
    examples,
  }
}

const result = {
  at: new Date().toISOString(),
  note: '사용자 트랜스크립트는 읽기 전용으로만 열었다 (기준 E6). 내용은 싣지 않고 모양·개수만 싣는다.',
  tailBytes: TAIL_BYTES,
  codex: surveyCodex(),
  grok: surveyGrok(),
  claudeContamination: surveyContamination(),
}
writeRaw('a10-foreign-shapes.json', { codex: result.codex, grok: result.grok, at: result.at, note: result.note })
writeRaw('a9-contamination.json', { ...result.claudeContamination, at: result.at, note: result.note })
console.log(JSON.stringify({ codex: result.codex.samples?.[0], grok: result.grok.samples?.[0] }, null, 1).slice(0, 2000))
console.log(JSON.stringify(result.claudeContamination, null, 1))
