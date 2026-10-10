// LIFE-582 Z1 측정 도우미 — provider 기록을 제품과 같은 함수로 읽는다(`countSubmissions`·`parseTail`). 글은 남기지 않고 개수·상태만 낸다(G5).
//   npx tsx scripts/l582/rec.ts cursor  <agent> <file>                 → 커서 JSON(stdout)
//   npx tsx scripts/l582/rec.ts count   <agent> <file> <cursor.json> <body> → {matchCount, naiveCount, cursorInvalidated}
//   npx tsx scripts/l582/rec.ts pending <agent> <file>                 → {pendingQuestions(문항·선택지 수), turnOutcome}
//   npx tsx scripts/l582/rec.ts tail    <agent> <file> <cursor.json>   → 커서 뒤 줄의 종류만(type·role·payload.type·sessionUpdate·도구 이름) — 글 없음
import fs from 'node:fs'
import { bodyIdentity, captureCursor, countSubmissions, isAgentKind, type CursorEntry } from '../../src/runtime/terminal/agent.js'
import { parseTail } from '../../src/main/transcript-parse.js'

const [command, agent, file, third, fourth] = process.argv.slice(2)
if (!isAgentKind(agent) || file === undefined) { console.error('usage'); process.exit(2) }
const readCursor = (p: string): CursorEntry[] => JSON.parse(fs.readFileSync(p, 'utf8')) as CursorEntry[]

switch (command) {
  case 'cursor':
    console.log(JSON.stringify(captureCursor([file])))
    break
  case 'count': {
    if (third === undefined || fourth === undefined) process.exit(2)
    const cursor = readCursor(third)
    const r = countSubmissions({ kind: agent, files: [file], identity: bodyIdentity(fourth), submittedAtMs: 0, cursor })
    console.log(JSON.stringify({ matchCount: r.matchCount, naiveCount: r.naiveCount, cursorInvalidated: r.cursorInvalidated, assistantAfter: r.assistantAfter }))
    break
  }
  case 'pending': {
    const digest = parseTail({ agent, chunk: fs.readFileSync(file, 'utf8'), partial: false, sessionId: null })
    const q = digest.pendingQuestions
    console.log(JSON.stringify({ pending: q === null ? null : q.map(x => ({ options: x.options.length, multiSelect: x.multiSelect ?? null })), turnOutcome: digest.turnOutcome }))
    break
  }
  case 'tail': {
    if (third === undefined) process.exit(2)
    const cursor = readCursor(third)[0]
    const lines = fs.readFileSync(file, 'utf8').split('\n').slice(cursor?.existed ? cursor.lines : 0)
    for (const line of lines) {
      if (!line.trim()) continue
      let row: Record<string, unknown>
      try { row = JSON.parse(line) as Record<string, unknown> } catch { continue }
      const payload = (row.payload ?? {}) as Record<string, unknown>
      const update = (((row.params ?? {}) as Record<string, unknown>).update ?? row.update ?? {}) as Record<string, unknown>
      const message = (row.message ?? {}) as Record<string, unknown>
      const content = Array.isArray(message.content) ? message.content.map(c => (c as Record<string, unknown>).type).join('+') : typeof message.content
      console.log([row.type, message.role, content, payload.type, payload.name, update.sessionUpdate, (update.toolCall as Record<string, unknown> | undefined)?.name ?? update.title].filter(v => v !== undefined && v !== null).join(' · '))
    }
    break
  }
  default:
    process.exit(2)
}
