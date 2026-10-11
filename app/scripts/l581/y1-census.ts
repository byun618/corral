// LIFE-581 Y1ⓓ — 실물 기록 **사본**(`/tmp/l581w*`)을 대화 판독기(ChatBuilder)로 변환해 줄 종류별 개수·버린 줄·알 수 없는 줄을 센다. 글은 남기지 않는다(G5).
//
//   npx tsx scripts/l581/y1-census.ts --dir /tmp/l581w-y1 --out <json>
//   <dir>/{codex,grok}/<별칭>.jsonl · <dir>/claude/<별칭>/<원래 파일 이름>.jsonl — 사본만 받는다(경로가 /tmp/l581w 로 시작하지 않으면 거부).
//   Claude 는 파일 이름이 세션 id 다(사람 발화 판정이 기록의 sessionId 와 대조한다 — 제품 판독기와 같은 조건). 이름을 바꾼 사본은 사람 발화가 0 이 된다(F-Y1d-census 첫 회차).
//   원자료에는 별칭만 남긴다(세션 id 없음).
//
// 파일마다: 크기·sha256 앞 16자 · 줄 수 · **줄 종류**(기록 스키마의 type 칸 이름만 — 값 글은 없다) → 원자 종류 개수 ·
//   버린 줄 사유(stats.skipped) · 알 수 없는 줄 모양(stats.unknown) · 말풍선 종류 개수 · C15(이름 있는 도구가 없는 묶음 = wire detail:false) ·
//   **새는지 대조**: 알 수 없는 원자를 낸 줄의 문자열 값(12자 이상) 중 말풍선 글(지시·답·도구 대상·질문)에 나타난 것의 개수(기대 0).
//   양성 대조: 같은 대조를 「말풍선이 된 줄」(prompt 원자 줄)에 돌리면 0 보다 커야 한다 — 대조 방법이 실제로 글을 잡는다는 증거.
// 종료 코드: 0 = provider 마다 파일 ≥ 3 · 알 수 없는 줄 누수 0 · 양성 대조 > 0(provider 마다 사람 발화 줄 > 0 이어야 — 0 이면 대조가 서지 않아 미달) / 1 = 미달 / 2 = 사용법.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { ChatBuilder, lineAtoms } from '../../src/main/chat-parse.js'
import type { ChatItem } from '../../src/main/chat-parse.js'

type Agent = 'claude' | 'codex' | 'grok'
const { values: args } = parseArgs({ options: { dir: { type: 'string' }, out: { type: 'string' } } })
if (args.dir === undefined || args.out === undefined || !path.resolve(args.dir).startsWith('/tmp/l581w')) {
  console.error('사용: --dir /tmp/l581w-* --out <json> (사본 폴더만)')
  process.exit(2)
}
const DIR = path.resolve(args.dir)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const name = (value: unknown): string => (typeof value === 'string' && /^[A-Za-z0-9_.\-/]{1,40}$/.test(value) ? value : typeof value === 'string' ? '<str>' : value === undefined ? '-' : `<${typeof value}>`)

/** 줄 종류 — 스키마의 type 칸 이름만(사람 글이 아니다). 모양이 이름이 아니면 `<str>`. */
function lineKind(agent: Agent, record: Record<string, unknown>): string {
  switch (agent) {
    case 'claude': {
      const type = name(record['type'])
      if (type === 'system') return `system:${name(record['subtype'])}`
      const message = isRecord(record['message']) ? record['message'] : null
      if ((type === 'user' || type === 'assistant') && message !== null) {
        const content = message['content']
        if (typeof content === 'string') return `${type}:string`
        if (Array.isArray(content)) return `${type}:${[...new Set(content.map((block) => (isRecord(block) ? name(block['type']) : '<x>')))].sort().join(',')}`
      }
      return type
    }
    case 'codex': {
      const payload = isRecord(record['payload']) ? record['payload'] : {}
      const base = `${name(record['type'])}:${name(payload['type'])}`
      if (payload['type'] === 'message') return `${base}:${name(payload['role'])}`
      if (payload['type'] === 'item_completed' && isRecord(payload['item'])) return `${base}:${name(payload['item']['type'])}`
      return base
    }
    case 'grok': {
      const params = isRecord(record['params']) ? record['params'] : {}
      const update = isRecord(params['update']) ? params['update'] : {}
      return `${name(record['method'])}:${name(update['sessionUpdate'])}`
    }
  }
}

/** 줄 안의 문자열 값(12자 이상, 앞 80자) — 누수 대조용. 원자료에는 개수만 남는다. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    const flat = value.replace(/\s+/g, ' ').trim()
    if (flat.length >= 12) out.push(flat.slice(0, 80))
  } else if (Array.isArray(value)) for (const entry of value) strings(entry, out)
  else if (isRecord(value)) for (const entry of Object.values(value)) strings(entry, out)
  return out
}

function itemTexts(items: ChatItem[]): string {
  const parts: string[] = []
  for (const item of items) {
    if (item.kind === 'prompt' || item.kind === 'reply') parts.push(item.text)
    if (item.kind === 'tools') for (const tool of item.tools) parts.push(tool.target ?? '', tool.name ?? '')
    if (item.kind === 'question') parts.push(JSON.stringify(item.questions), item.answer ?? '')
  }
  return parts.join('\n').replace(/\s+/g, ' ')
}

const add = (map: Record<string, number>, key: string, n = 1): void => { map[key] = (map[key] ?? 0) + n }

function census(agent: Agent, file: string, alias: string) {
  const buffer = fs.readFileSync(file)
  const sessionId = agent === 'claude' ? path.basename(file, '.jsonl') : null
  const builder = new ChatBuilder({ agent, sessionId })
  const kinds: Record<string, number> = {}
  const atomsByKind: Record<string, Record<string, number>> = {}
  const nullNameTools: Record<string, number> = {}
  const unknownLines: string[][] = []
  const promptLines: string[][] = []
  let offset = 0
  let held = 0
  let unparsable = 0
  while (offset < buffer.length) {
    const nl = buffer.indexOf(10, offset)
    if (nl < 0) { held = buffer.length - offset; break }
    const line = buffer.toString('utf8', offset, nl)
    if (line.trim().length > 0) {
      let record: unknown = null
      try { record = JSON.parse(line) } catch { unparsable += 1 }
      const kind = isRecord(record) ? lineKind(agent, record) : '<not-json>'
      add(kinds, kind)
      const parsed = lineAtoms({ agent, line, sessionId })
      const bucket = (atomsByKind[kind] ??= {})
      for (const atom of parsed.atoms) {
        add(bucket, atom.kind)
        if (atom.kind === 'tool' && atom.name === null) add(nullNameTools, kind)
      }
      if (parsed.atoms.some((atom) => atom.kind === 'unknown')) unknownLines.push(strings(record))
      if (parsed.atoms.some((atom) => atom.kind === 'prompt') && promptLines.length < 50) promptLines.push(strings(record))
    }
    builder.feed({ offset, line })
    offset = nl + 1
  }
  const texts = itemTexts(builder.items)
  const leaks = (lines: string[][]) => lines.reduce((sum, values) => sum + values.filter((value) => texts.includes(value)).length, 0)
  const items: Record<string, number> = {}
  let c15 = 0
  for (const item of builder.items) {
    add(items, item.kind)
    if (item.kind === 'tools' && !item.tools.some((tool) => tool.name !== null)) c15 += 1
  }
  return {
    agent,
    file: `${agent}/${alias}`,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16),
    lines: builder.stats.lines,
    heldPartialBytes: held,
    unparsable,
    lineKinds: kinds,
    atomsByLineKind: atomsByKind,
    skipped: builder.stats.skipped,
    unknown: builder.stats.unknown,
    unknownLines: unknownLines.length,
    unknownLeaks: leaks(unknownLines),
    positiveControl: { promptLines: promptLines.length, found: leaks(promptLines) },
    orphanResults: builder.stats.orphanResults,
    rewinds: builder.rewinds,
    items,
    c15Groups: c15,
    toolsWithoutName: nullNameTools,
  }
}

const out: { measuredAt: string; dir: string; files: ReturnType<typeof census>[]; verdict: Record<string, unknown> } = { measuredAt: new Date().toISOString(), dir: DIR, files: [], verdict: {} }
let ok = true
for (const agent of ['claude', 'codex', 'grok'] as const) {
  const dir = path.join(DIR, agent)
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : []
  const files = entries.flatMap((entry) => {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) return [{ file: path.join(dir, entry.name), alias: entry.name }]
    if (!entry.isDirectory()) return []
    const inner = fs.readdirSync(path.join(dir, entry.name)).filter((name) => name.endsWith('.jsonl'))
    return inner.length === 1 ? [{ file: path.join(dir, entry.name, inner[0] ?? ''), alias: `${entry.name}.jsonl` }] : []
  })
  const rows = files.map((entry) => census(agent, entry.file, entry.alias))
  out.files.push(...rows)
  const leaks = rows.reduce((sum, row) => sum + row.unknownLeaks, 0)
  const control = rows.reduce((sum, row) => sum + row.positiveControl.found, 0)
  const prompts = rows.reduce((sum, row) => sum + row.positiveControl.promptLines, 0)
  const pass = rows.length >= 3 && leaks === 0 && prompts > 0 && control > 0
  out.verdict[agent] = { files: rows.length, unknownLines: rows.reduce((sum, row) => sum + row.unknownLines, 0), unknownLeaks: leaks, positiveControl: { promptLines: prompts, found: control }, c15Groups: rows.reduce((sum, row) => sum + row.c15Groups, 0), pass }
  ok &&= pass
}
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
fs.writeFileSync(args.out, JSON.stringify(out, null, 1) + '\n')
console.log(JSON.stringify(out.verdict))
process.exit(ok ? 0 : 1)
