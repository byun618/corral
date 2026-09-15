// 수정 라운드 7 — **경과 시간 칸은 손대지 않는다. 확인만 한다** (지시 문구 그대로).
//
// `05-orca-parity.md` §5.1 이 "corral `elapsedLabel` 이 이미 글자 하나까지 같다" 고 적었다.
// 그 문장을 **말로 두지 않고** 둘을 나란히 돌린다: corral 쪽은 렌더러의 진짜 함수를 import 하고,
// Orca 쪽은 그 파일(`renderer/src/lib/short-time-ago.ts`)의 함수를 **그대로 옮겨 적은 사본**이다
// (원본은 다른 레포라 import 할 길이 없다 — 대신 파일의 sha256 과 원문을 원자료에 싣는다).
//
// 경계값만 보면 "같다" 를 못 박을 수 없으므로 **경계 앞뒤 1ms** 까지 같이 본다.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { elapsedLabel } from '../../src/renderer/src/session-activity.js'

const RAW_DIR = path.join(
  path.dirname(path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname)))),
  'specs/LIFE-366-session-identity/raw/claude',
  process.env['L366_RAW_SUBDIR'] ?? '',
)

const ORCA_FILE = '/Users/byun/repos/etc/orca/src/renderer/src/lib/short-time-ago.ts'

/**
 * Orca `formatShortTimeAgo` 의 **사본**. 위 파일에서 그대로 옮겼다 — 고치지 않는다.
 * (읽기만 한다: 관문 ④ 는 쓰기를 막는 규칙이고 사용자 레포는 읽기 대상이다.)
 */
function formatShortTimeAgo(ts: number, now = Date.now()): string {
  const delta = now - ts
  if (delta < 60_000) {
    return 'now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const CASES: { 이름: string; delta: number }[] = [
  { 이름: '방금(0)', delta: 0 },
  { 이름: '59초', delta: 59_000 },
  { 이름: '59.999초 (경계 직전)', delta: MINUTE - 1 },
  { 이름: '1분 (경계)', delta: MINUTE },
  { 이름: '44분', delta: 44 * MINUTE },
  { 이름: '59분 59초 (경계 직전)', delta: HOUR - 1 },
  { 이름: '1시간 (경계)', delta: HOUR },
  { 이름: '3시간', delta: 3 * HOUR },
  { 이름: '23시간 59분 (경계 직전)', delta: DAY - MINUTE },
  { 이름: '24시간 (경계)', delta: DAY },
  { 이름: '2일', delta: 2 * DAY },
  { 이름: '400일', delta: 400 * DAY },
  { 이름: '시계 어긋남 (미래 1초)', delta: -1000 },
  { 이름: '시계 어긋남 (미래 1시간)', delta: -HOUR },
]

function main(): void {
  const now = 1_757_000_000_000
  const source = fs.readFileSync(ORCA_FILE, 'utf8')
  const rows = CASES.map((row) => {
    const at = now - row.delta
    const corral = elapsedLabel(at, now)
    const orca = formatShortTimeAgo(at, now)
    return { ...row, corral, orca, 같은가: corral === orca }
  })
  const out = {
    at: new Date().toISOString(),
    '왜 재나': '지시: "경과 시간 칸은 손대지 마라 — 확인만 해서 원자료에 적어라"',
    'Orca 원본': {
      파일: ORCA_FILE,
      sha256: crypto.createHash('sha256').update(source).digest('hex'),
      mtime: fs.statSync(ORCA_FILE).mtime.toISOString(),
      원문: source,
    },
    'corral 쪽': 'app/src/renderer/src/session-activity.ts 의 `elapsedLabel` (import 한 실물)',
    표: rows,
    '다른 칸': rows.filter((row) => !row.같은가),
    판정: {
      '글자 하나까지 같은가': rows.every((row) => row.같은가),
      '이 라운드에서 안 건드렸다': true,
    },
    메모:
      '음수(시계 어긋남)에서 corral 은 명시적으로 `now` 로 접고 Orca 는 `delta < 60_000` 에 걸려 같은 값이 된다 — 경로는 다르고 값은 같다.',
  }
  fs.mkdirSync(RAW_DIR, { recursive: true })
  fs.writeFileSync(path.join(RAW_DIR, 'elapsed-parity-r7.json'), JSON.stringify(out, null, 2) + '\n')
  console.log(JSON.stringify(out.판정, null, 1))
}

main()
