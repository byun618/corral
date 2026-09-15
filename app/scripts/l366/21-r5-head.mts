// 수정 라운드 5 — **머리 읽기**의 정확성(C5)·비용(C6)과 모양 실측.
//
// 세 가지를 한 번에 낸다:
//   ① `c5-b9-shapes-r5.json` — 사용자 트랜스크립트 전수의 **모양 분포**. 코드 주석이 근거로
//      대는 수(첫 발화 오프셋·건너뛴 봉투·도구 키)가 전부 여기서 나온다
//   ② `c5-accuracy-r5.json` — 첫 발화 **정확성**: 전문 오라클과 대조 (A5 와 같은 규칙)
//   ③ `c6-cost-r5.json` — 첫 채움 주기 ≤2.25MB·≤50ms, 둘째 주기부터 ≤2MB, 파일이 자라도
//      머리를 **다시 안 읽는다**
//
// 읽기 전용이다 (기준 E6·관문 ④). 사용자 파일에는 **쓰지 않는다** — 자라는 파일 실험은 격리
// HOME 의 합성 파일로 한다. 원자료에는 **해시·길이·개수·바이트만** 싣고 대화 내용은 안 싣는다.
//
// 관문 ⑤ 반례가 셋 다 붙어 있다:
//   · C5 — **건너뛰기를 끈** 오라클(첫 user 레코드를 그냥 집는 것)과는 **안 맞아야** 한다
//   · C6 — 캐시를 비우고 같은 파일을 다시 읽으면 머리 256KB 를 **다시 읽는다**(측정이 살아 있다)
//   · 모양 — 첫 발화가 없는 파일 수를 같이 센다. 전부 있으면 건너뛰기 규칙이 일을 안 한 것이다

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isRecord, readArray, readRecord, readString, safeParse } from '../../src/shared/json.js'
import { clearTranscriptCache, readSessionDigest, HEAD_WINDOW_BYTES } from '../../src/main/transcript.js'
import { cleanFirstPrompt } from '../../src/main/transcript-parse.js'
import type { AgentSessionRef } from '../../src/shared/types.js'

const RAW_DIR = path.join(
  path.dirname(path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)))),
  'specs/LIFE-366-session-identity/raw/claude',
)

const hash = (value: string | null): string | null =>
  value === null ? null : crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)

type Pick = { file: string; id: string; size: number }

function claudeFiles(): Pick[] {
  const projects = path.join(os.homedir(), '.claude', 'projects')
  const out: Pick[] = []
  for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const name of fs.readdirSync(path.join(projects, entry.name))) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(projects, entry.name, name)
      out.push({ file, id: name.slice(0, -'.jsonl'.length), size: fs.statSync(file).size })
    }
  }
  return out.sort((a, b) => a.size - b.size)
}

function readHead(file: string, bytes: number): string {
  const size = fs.statSync(file).size
  const length = Math.min(bytes, size)
  const handle = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    fs.readSync(handle, buffer, 0, length, 0)
    return buffer.toString('utf8')
  } finally {
    fs.closeSync(handle)
  }
}

function userText(record: Record<string, unknown>): string | null {
  const message = readRecord(record, 'message')
  if (message === null) return null
  const content = message['content']
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of readArray(message, 'content')) {
    if (!isRecord(block)) continue
    if (block['type'] !== 'text') continue
    const text = readString(block, 'text')
    if (text !== null) parts.push(text)
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/**
 * **전문 오라클** — 파일을 통째로 읽고 앞에서부터 훑어 첫 사람 발화를 찾는다.
 * 판독층은 머리 256KB 만 읽는다 — 범위가 달라서 같은 답이 나오면 실질 대조다.
 * `skip:false` 면 건너뛰기를 **끈** 반례 오라클이다 (첫 user 레코드를 그냥 집는다).
 */
function fullFileFirstPrompt(
  file: string,
  sessionId: string,
  { skip = true } = {},
): { raw: string | null; offset: number | null; lineEnd: number | null } {
  const content = fs.readFileSync(file, 'utf8')
  let offset = 0
  for (const line of content.split('\n')) {
    const lineStart = offset
    offset += Buffer.byteLength(line) + 1
    if (line.trim().length === 0) continue
    const row = safeParse(line)
    if (!isRecord(row)) continue
    if (row['type'] !== 'user') continue
    const text = userText(row)
    if (text === null || text.trim().length === 0) continue
    if (skip) {
      if (row['isMeta'] === true) continue
      if (row['sessionId'] !== sessionId) continue
      if (text.includes('<command-message>') || text.includes('<command-name>')) continue
      if (text.includes('<local-command-stdout>')) continue
    }
    return { raw: text, offset: lineStart, lineEnd: lineStart + Buffer.byteLength(line) }
  }
  return { raw: null, offset: null, lineEnd: null }
}

// --- ① 모양 분포 ---------------------------------------------------------------

function shapes(files: Pick[]) {
  const offsets: number[] = []
  let withPrompt = 0
  let withoutPrompt = 0
  let truncatedRecord = 0
  let meta = 0
  let commandEnvelope = 0
  let localStdout = 0
  let sidechain = 0
  let arrayContent = 0
  let ownerMatch = 0
  let ownerMismatch = 0
  const toolNames = new Map<string, number>()
  const toolKeys = new Map<string, number>()
  let toolOnlyTurns = 0
  let assistantTurns = 0

  for (const pick of files) {
    if (pick.size === 0) continue
    const head = readHead(pick.file, HEAD_WINDOW_BYTES)
    let offset = 0
    let found = false
    // 머리 창의 **마지막 줄은 잘려 있다.** 그 줄이 파싱에 실패하고 그 앞에서 첫 발화를 못 찾았으면,
    // 「발화가 없다」가 아니라 **「레코드가 창을 넘었다」** 다 — 두 부재를 갈라 센다.
    let truncatedTail = false
    for (const line of head.split('\n')) {
      const lineStart = offset
      offset += Buffer.byteLength(line) + 1
      if (line.trim().length === 0) continue
      const row = safeParse(line)
      if (!isRecord(row)) {
        if (lineStart + Buffer.byteLength(line) >= Math.min(pick.size, HEAD_WINDOW_BYTES) - 1) truncatedTail = true
        continue
      }
      if (row['type'] !== 'user') continue
      const text = userText(row)
      if (text === null || text.trim().length === 0) continue
      if (row['isMeta'] === true) {
        meta += 1
        continue
      }
      if (text.includes('<command-message>') || text.includes('<command-name>')) {
        commandEnvelope += 1
        continue
      }
      if (text.includes('<local-command-stdout>')) {
        localStdout += 1
        continue
      }
      if (row['isSidechain'] === true) sidechain += 1
      const message = readRecord(row, 'message')
      if (message !== null && Array.isArray(message['content'])) arrayContent += 1
      if (row['sessionId'] === pick.id) ownerMatch += 1
      else ownerMismatch += 1
      offsets.push(lineStart)
      found = true
      break
    }
    if (found) withPrompt += 1
    else if (truncatedTail) truncatedRecord += 1
    else withoutPrompt += 1

    // 도구 모양 — 꼬리 창에서 어시스턴트 턴을 센다 (B9 미리보기 키 근거).
    const tail = readHead(pick.file, Math.min(pick.size, 256 * 1024))
    for (const line of tail.split('\n')) {
      if (line.trim().length === 0) continue
      const row = safeParse(line)
      if (!isRecord(row)) continue
      if (row['type'] !== 'assistant') continue
      const message = readRecord(row, 'message')
      if (message === null) continue
      const content = message['content']
      if (!Array.isArray(content)) continue
      assistantTurns += 1
      const blocks = content.filter(isRecord)
      const hasText = blocks.some((block) => block['type'] === 'text' && String(block['text'] ?? '').trim().length > 0)
      const tool = blocks.find((block) => block['type'] === 'tool_use') ?? null
      if (hasText || tool === null) continue
      toolOnlyTurns += 1
      const name = String(tool['name'] ?? '?')
      toolNames.set(name, (toolNames.get(name) ?? 0) + 1)
      const input = tool['input']
      const keys = typeof input === 'object' && input !== null ? Object.keys(input).sort().join(',') : ''
      toolKeys.set(keys, (toolKeys.get(keys) ?? 0) + 1)
    }
  }

  offsets.sort((a, b) => a - b)
  const percentile = (fraction: number): number => offsets[Math.min(offsets.length - 1, Math.floor(offsets.length * fraction))] ?? 0
  return {
    '파일 수': files.length,
    '첫 발화 있음': withPrompt,
    '첫 발화 없음(창 안에 사람 발화가 없다)': withoutPrompt,
    '첫 발화 부재 — 레코드가 머리 창을 넘는다': truncatedRecord,
    '건너뛴 것': { 'isMeta': meta, '<command-*> 봉투': commandEnvelope, '<local-command-stdout>': localStdout },
    'isSidechain 인 첫 발화': sidechain,
    '블록 배열 content': arrayContent,
    '소유자(sessionId) 일치': ownerMatch,
    '소유자 불일치': ownerMismatch,
    '첫 발화 오프셋(바이트)': { p50: percentile(0.5), p95: percentile(0.95), 최대: offsets.at(-1) ?? null },
    '머리 창(256KB) 안에 다 들어오나': (offsets.at(-1) ?? 0) < HEAD_WINDOW_BYTES,
    '도구뿐인 어시스턴트 턴': { 전체턴: assistantTurns, 도구뿐: toolOnlyTurns },
    '도구 이름 상위': [...toolNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    '도구 input 키 상위': [...toolKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  }
}

// --- ② 정확성 (C5) -------------------------------------------------------------

function accuracy(files: Pick[]) {
  // 크기 분포 전체에서 고른다 — 작은 파일은 꼬리 조각에 머리가 이미 들어 있고(추가 읽기 0바이트),
  // 큰 파일만 머리를 따로 읽는다. 두 갈래가 **둘 다** 표에 있어야 대조가 의미 있다.
  const at = (fraction: number): Pick | null => files[Math.min(files.length - 1, Math.floor(files.length * fraction))] ?? null
  const picks: Pick[] = []
  for (const fraction of [0.05, 0.25, 0.5, 0.75, 0.95, 1]) {
    const candidate = at(fraction)
    if (candidate === null || picks.some((chosen) => chosen.file === candidate.file)) continue
    picks.push(candidate)
  }
  // **머리 창을 넘는 레코드**를 가진 파일도 하나 넣는다 — 이 갈래는 값이 틀린 게 아니라 **부재**라
  // 판정이 갈린다(§C5 문언과 어긋나는 자리라 표에 실물이 있어야 한다). 실측상 363개 중 9개다.
  for (const candidate of files) {
    if (picks.some((chosen) => chosen.file === candidate.file)) continue
    const oracle = fullFileFirstPrompt(candidate.file, candidate.id)
    if (oracle.lineEnd === null || oracle.lineEnd < HEAD_WINDOW_BYTES) continue
    picks.push(candidate)
    break
  }
  // **건너뛰기가 실제로 일하는 파일**을 세 개까지 더 넣는다 (관문 ⑤). 크기 분포로만 고르면
  // 머리에 봉투·meta 가 없는 파일만 걸려서, 「건너뛰기를 끈 오라클」 반례가 성립조차 안 한다.
  for (const candidate of files) {
    if (picks.length >= 10) break
    if (picks.some((chosen) => chosen.file === candidate.file)) continue
    const skipped = fullFileFirstPrompt(candidate.file, candidate.id)
    const raw = fullFileFirstPrompt(candidate.file, candidate.id, { skip: false })
    if (skipped.raw === null || raw.raw === null) continue
    if (cleanFirstPrompt(skipped.raw) === cleanFirstPrompt(raw.raw)) continue
    picks.push(candidate)
  }

  const rows = picks.map((pick) => {
    const ref: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr:claude', id: pick.id }
    clearTranscriptCache()
    const read = readSessionDigest(ref)
    const oracle = fullFileFirstPrompt(pick.file, pick.id)
    const expected = oracle.raw === null ? null : cleanFirstPrompt(oracle.raw)
    const wrong = fullFileFirstPrompt(pick.file, pick.id, { skip: false })
    const wrongTitle = wrong.raw === null ? null : cleanFirstPrompt(wrong.raw)
    return {
      파일: path.basename(pick.file),
      바이트: pick.size,
      '머리를 따로 읽었나': pick.size > 256 * 1024,
      판독층_해시: hash(read.digest.firstPrompt),
      전문오라클_해시: hash(expected),
      일치: hash(read.digest.firstPrompt) === hash(expected),
      길이: read.digest.firstPrompt?.length ?? null,
      '40자 이하': (read.digest.firstPrompt?.length ?? 0) <= 40,
      원문_오프셋: oracle.offset,
      // 값이 **틀린** 것과 **없는** 것은 다르다 — C5 문언은 "일치" 지만, 부재는 A8("모르면
      // 모른다고 한다")의 결과다. 두 가지를 갈라 세고 판정도 갈라 적는다.
      부재: read.digest.firstPrompt === null,
      // 레코드 **한 줄 전체**가 창을 넘는지를 본다 (내용 길이가 아니라 줄 끝 오프셋).
      '부재 사유(레코드가 머리 창을 넘음)':
        read.digest.firstPrompt === null && oracle.lineEnd !== null ? oracle.lineEnd >= HEAD_WINDOW_BYTES : false,
      '첫 발화 레코드 줄 끝(바이트)': oracle.lineEnd,
      // 관문 ⑤ — 건너뛰기를 끈 오라클과는 **달라야** 한다. 같으면 그 파일엔 건너뛸 게
      // 없었다는 뜻이라 반례가 성립하지 않는다(그 사실도 적는다).
      반례_성립: hash(wrongTitle) !== hash(expected),
      반례와_일치: hash(read.digest.firstPrompt) === hash(wrongTitle),
    }
  })

  return {
    표: rows,
    판정: {
      대조_파일수: rows.length,
      전부_일치: rows.every((row) => row.일치),
      '값이 있는 것 중 일치': rows.filter((row) => !row.부재).every((row) => row.일치),
      '틀린 값': rows.filter((row) => !row.부재 && !row.일치).length,
      부재: rows.filter((row) => row.부재).length,
      '부재가 전부 「레코드가 창을 넘음」인가': rows
        .filter((row) => row.부재)
        .every((row) => row['부재 사유(레코드가 머리 창을 넘음)']),
      '40자 이하': rows.every((row) => row['40자 이하']),
      반례_성립_파일수: rows.filter((row) => row.반례_성립).length,
      반례가_통과하나: rows.some((row) => row.반례_성립 && row.반례와_일치),
    },
  }
}

// --- ③ 비용 (C6 · A6 재측정) ------------------------------------------------------

function cost(files: Pick[]) {
  const at = (fraction: number): Pick | null => files[Math.min(files.length - 1, Math.floor(files.length * fraction))] ?? null
  const picks: Pick[] = []
  for (const fraction of [0.1, 0.5, 0.9, 1]) {
    const candidate = at(fraction)
    if (candidate === null || picks.some((chosen) => chosen.file === candidate.file)) continue
    picks.push(candidate)
  }

  const rows = picks.map((pick) => {
    const ref: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr:claude', id: pick.id }
    clearTranscriptCache()
    const coldAt = process.hrtime.bigint()
    const cold = readSessionDigest(ref)
    const coldMs = Number(process.hrtime.bigint() - coldAt) / 1e6
    const warmAt = process.hrtime.bigint()
    const warm = readSessionDigest(ref)
    const warmMs = Number(process.hrtime.bigint() - warmAt) / 1e6
    return {
      파일: path.basename(pick.file),
      바이트: pick.size,
      MB: Math.round((pick.size / 1024 / 1024) * 100) / 100,
      '첫 주기 바이트': cold.bytes,
      '첫 주기 ms': Math.round(coldMs * 100) / 100,
      '첫 주기 ≤2.25MB': cold.bytes <= 2.25 * 1024 * 1024,
      '첫 주기 ≤50ms': coldMs <= 50,
      '둘째 주기 바이트': warm.bytes,
      '둘째 주기 statOnly': warm.statOnly,
      '둘째 주기 ms': Math.round(warmMs * 100) / 100,
      '첫 발화 있음': cold.digest.firstPrompt !== null,
    }
  })

  // 자라는 파일 — **격리 HOME 의 합성 파일**이다 (사용자 파일에 쓰지 않는다, E6).
  const growth = growthProbe()

  return {
    표: rows,
    '자라는 파일': growth,
    판정: {
      '통과선(첫 주기)': '≤2.25MB · ≤50ms',
      '통과선(둘째 주기부터)': '≤2MB (기존 A6)',
      최대_첫주기_바이트: Math.max(...rows.map((row) => row['첫 주기 바이트'])),
      최대_첫주기_ms: Math.max(...rows.map((row) => row['첫 주기 ms'])),
      첫주기_전부_통과: rows.every((row) => row['첫 주기 ≤2.25MB'] && row['첫 주기 ≤50ms']),
      둘째주기_전부_0바이트: rows.every((row) => row['둘째 주기 바이트'] === 0),
      // 자란 뒤의 읽기는 **꼬리 첫 창(256KB)뿐**이어야 한다 — 머리를 다시 읽었다면 그만큼 더 나온다.
      '자란 뒤 바이트 = 꼬리 첫 창뿐인가': growth['자란 뒤 바이트'] === 256 * 1024,
      '반례(캐시를 비우면 머리까지 다시 읽나)': Number(growth['캐시 비운 뒤 바이트']) > Number(growth['자란 뒤 바이트']),
    },
  }
}

/**
 * 격리 HOME 에 큰 합성 파일을 깔고 **자란 뒤**의 읽기를 잰다.
 *
 * 이 스크립트의 앞 두 절은 사용자 HOME 을 **읽어야** 하고(A6·C5 는 실물 대용량 파일 없이는
 * 측정이 안 된다, 관문 ④ 단서), 이 절은 **써야** 한다. 그래서 여기서만 `HOME` 을 격리 HOME 으로
 * 바꿨다가 되돌린다 — 판독층은 `os.homedir()` 로 경로를 잡으므로 이 한 줄이 경계다.
 * 사용자 `~/.claude` 에는 한 바이트도 쓰지 않는다.
 */
function growthProbe(): Record<string, number | boolean | string> {
  const realHome = process.env['HOME']
  const home = process.env['L366_HOME_LINK'] ?? '/tmp/l366h'
  process.env['HOME'] = home
  try {
    return growthProbeInIsolatedHome(home)
  } finally {
    if (realHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = realHome
  }
}

function growthProbeInIsolatedHome(home: string): Record<string, number | boolean | string> {
  const id = 'c6c6c6c6-d5d5-4d5d-8d5d-000000000055'
  const dir = path.join(home, '.claude', 'projects', 'l366-r5-growth')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)

  const user = JSON.stringify({
    type: 'user',
    sessionId: id,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: '머리 읽기 예산을 재는 합성 세션이다' },
  })
  const filler = (index: number): string =>
    JSON.stringify({
      type: 'assistant',
      sessionId: id,
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: `채움 ${index} ${'가'.repeat(2000)}` }] },
    })
  // 머리 창보다 훨씬 큰 파일 — 꼬리 창과 머리 창이 안 겹쳐야 이 측정이 의미가 있다.
  const lines = [user]
  for (let index = 0; index < 400; index += 1) lines.push(filler(index))
  fs.writeFileSync(file, lines.join('\n') + '\n')

  const ref: AgentSessionRef = { kind: 'id', agent: 'claude', source: 'herdr:claude', id }
  clearTranscriptCache()
  const first = readSessionDigest(ref)
  fs.appendFileSync(file, filler(999) + '\n') // 파일이 자란다 (mtime·size 가 바뀐다)
  const grown = readSessionDigest(ref)
  clearTranscriptCache() // 관문 ⑤ 반례 — 캐시가 없으면 머리를 다시 읽어야 한다
  const reread = readSessionDigest(ref)

  return {
    '파일 바이트': fs.statSync(file).size,
    '첫 주기 바이트': first.bytes,
    '첫 주기 첫 발화 있음': first.digest.firstPrompt !== null,
    '자란 뒤 바이트': grown.bytes,
    '자란 뒤 첫 발화 유지': grown.digest.firstPrompt !== null,
    '캐시 비운 뒤 바이트': reread.bytes,
    note: '격리 HOME 의 합성 파일이다 — 사용자 트랜스크립트에는 쓰지 않는다 (E6)',
  }
}

function main(): void {
  const files = claudeFiles()
  if (files.length === 0) throw new Error('claude 트랜스크립트가 없다')
  const at = new Date().toISOString()
  const note = '사용자 트랜스크립트는 읽기 전용(E6). 대화 내용은 안 싣고 해시·길이·개수·바이트만 싣는다.'

  fs.mkdirSync(RAW_DIR, { recursive: true })
  const shapeOut = { at, note, 모양: shapes(files) }
  fs.writeFileSync(path.join(RAW_DIR, 'c5-b9-shapes-r5.json'), JSON.stringify(shapeOut, null, 2) + '\n')

  const accuracyResult = accuracy(files)
  const accuracyOut = { at, note, ...accuracyResult }
  fs.writeFileSync(path.join(RAW_DIR, 'c5-accuracy-r5.json'), JSON.stringify(accuracyOut, null, 2) + '\n')

  const costResult = cost(files)
  const costOut = { at, note, ...costResult }
  fs.writeFileSync(path.join(RAW_DIR, 'c6-cost-r5.json'), JSON.stringify(costOut, null, 2) + '\n')

  console.log(JSON.stringify({ 모양: shapeOut.모양, 정확성: accuracyResult.판정, 비용: costResult.판정 }, null, 1))
}

main()
