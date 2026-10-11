// LIFE-581 Y12ⓒ — 네이티브 3초 반영 계산(폰 연결 기록 사본에서). 폰 앱 › 설정 › 「연결 기록」 › 「복사」 를 맥에 옮긴 파일(또는 logcat `[corral-conn]` 줄)을 읽는다.
//   ⓐ  = 폰 수신(서버 시계로 옮김: recvAt + offsetMs) − 서버가 그 줄을 읽은 시각(readAt)
//   ⓑ' = 폰 수신(같음) − 기록 파일 수정 시각(writtenAt — 실제 provider 는 append 직전 시각을 모르므로 mtime 이 대신이다)
// 대상 = `chat_recv` 중 `type: items`(push — 첫 페이지 `page` 는 3초 대상이 아니다). offsetMs 가 null 인 줄은 보류(회차에서 뺀다).
// 통과: 셀 수 있는 회차 ≥ 5 · ⓐ·ⓑ' 전부 ≤ 3000 ms. 종료 코드 0 통과 · 1 미달 · 2 사용법.
//
//   node scripts/l581/y12c-native.mjs --phone <연결 기록 사본> [--since <ISO 또는 ms>] --out <json>
import fs from 'node:fs'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({ options: { phone: { type: 'string' }, since: { type: 'string' }, out: { type: 'string' } } })
if (args.phone === undefined || args.out === undefined) {
  console.error('--phone <연결 기록 사본> --out <json> 필요')
  process.exit(2)
}
const since = args.since === undefined ? 0 : /^\d+$/.test(args.since) ? Number(args.since) : Date.parse(args.since)

const entries = fs.readFileSync(args.phone, 'utf8').split('\n').flatMap((raw) => {
  const start = raw.indexOf('{')
  if (start === -1) return []
  try {
    return [JSON.parse(raw.slice(start))]
  } catch {
    return []
  }
})
const pushes = entries.filter((entry) => entry.event === 'chat_recv' && entry.type === 'items' && Date.parse(entry.at) >= since)
const rows = pushes.map((entry) => {
  if (typeof entry.offsetMs !== 'number') return { at: entry.at, lastId: entry.lastId, held: '시계차 없음' }
  const recvServer = entry.recvAt + entry.offsetMs
  return {
    at: entry.at,
    lastId: entry.lastId,
    items: entry.items,
    a: typeof entry.readAt === 'number' ? Math.round(recvServer - entry.readAt) : null,
    b: typeof entry.writtenAt === 'number' ? Math.round(recvServer - entry.writtenAt) : null,
    rttMs: entry.rttMs,
  }
})
const counted = rows.filter((row) => row.held === undefined && row.a !== null && row.b !== null)
const max = (key) => (counted.length === 0 ? null : Math.max(...counted.map((row) => row[key])))
const pass = counted.length >= 5 && counted.every((row) => row.a <= 3000 && row.b <= 3000)
const result = { measuredAt: new Date().toISOString(), since: since || null, pushes: pushes.length, counted: counted.length, held: rows.length - counted.length, maxA: max('a'), maxB: max('b'), pass, rows }
fs.writeFileSync(args.out, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ pushes: result.pushes, counted: result.counted, held: result.held, maxA: result.maxA, maxB: result.maxB, pass }))
process.exit(pass ? 0 : 1)
