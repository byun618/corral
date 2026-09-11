// M9 — N8(격리) 감사 + A2·A3 마무리.
//
// **전 실행 로그**를 가로질러 `default` 소켓으로 나간 쓰기를 센다. 0 이 아니면 그 실행은 무효다
// (관문 ⑥). 화이트리스트(`request.ts`)의 실제 내용도 소스에서 그대로 읽어 싣는다 — "추가했다"
// 는 주장이 아니라 파일이 근거여야 한다.

import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, RAW_DIR, defaultSessionWrites, pct, readLog, writeRaw } from './lib.mjs'

const runsDir = path.join(RAW_DIR, '_runs')
const runs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort() : []

const out = { at: new Date().toISOString(), runs: [], 합계: null, 화이트리스트: null, a2: null }

const allLatencies = { 생성: [], 종료: [] }
for (const name of runs) {
  const logPath = path.join(runsDir, name, 'app.ndjson')
  const entries = readLog(logPath)
  if (entries.length === 0) continue
  const writes = defaultSessionWrites(entries)
  const sockets = [...new Set(entries.filter((entry) => entry.tag === 'req.conn.open').map((entry) => entry.socketPath))]
  const methods = [...new Set(entries.filter((entry) => entry.tag === 'req.conn.open').map((entry) => entry.method))].sort()
  // 구독 커넥션이 붙은 소켓도 센다 — 읽기라도 어느 세션인지는 남겨 둔다.
  const subSockets = [...new Set(entries.filter((entry) => entry.tag === 'sub.conn.open').map((entry) => entry.socketPath))]
  out.runs.push({
    run: name,
    줄수: entries.length,
    요청소켓: sockets,
    구독소켓: subSockets,
    보낸메서드: methods,
    default로나간쓰기: writes.count,
    default로나간쓰기상세: writes.rows.map((row) => ({ at: row.at, method: row.method })),
    화이트리스트밖거절: entries.filter((entry) => entry.tag === 'req.method_not_allowed').length,
  })
}

out.합계 = {
  실행수: out.runs.length,
  default로나간쓰기: out.runs.reduce((sum, item) => sum + item.default로나간쓰기, 0),
  건드린소켓: [...new Set(out.runs.flatMap((item) => [...item.요청소켓, ...item.구독소켓]))],
  보낸메서드: [...new Set(out.runs.flatMap((item) => item.보낸메서드))].sort(),
}

// 화이트리스트는 **소스에서** 읽는다.
const source = fs.readFileSync(path.join(APP_DIR, 'src/main/herdr/request.ts'), 'utf8')
// `readonly string[]` 의 `]` 에 걸리지 않도록 **배열 리터럴의 시작**부터 자른다.
const listStart = source.indexOf('= [', source.indexOf('const ALLOWED_METHODS'))
const block = source.slice(listStart, source.indexOf(']', listStart))
out.화이트리스트 = {
  파일: 'app/src/main/herdr/request.ts',
  목록: [...block.matchAll(/'([a-z_]+\.[a-z_]+|ping)'/g)].map((match) => match[1]),
  LIFE346추가: ['tab.create', 'agent.start', 'tab.close', 'pane.process_info'],
}
out.화이트리스트.추가가_목록에있나 = out.화이트리스트.LIFE346추가.every((method) => out.화이트리스트.목록.includes(method))

// 세션 가드가 그대로 살아 있나 — 두 쓰기 경로가 같은 함수를 쓰는지 파일로 확인한다.
const guard = fs.readFileSync(path.join(APP_DIR, 'src/main/herdr/default-session-guard.ts'), 'utf8')
out.세션가드 = {
  파일: 'app/src/main/herdr/default-session-guard.ts',
  열쇠: guard.includes('CORRAL_ALLOW_DEFAULT_INPUT'),
  쓰는곳: ['pane-terminal.ts (입력)', 'lifecycle.ts (생성·종료)'].filter((_, index) =>
    [
      fs.readFileSync(path.join(APP_DIR, 'src/main/herdr/pane-terminal.ts'), 'utf8'),
      fs.readFileSync(path.join(APP_DIR, 'src/main/herdr/lifecycle.ts'), 'utf8'),
    ][index].includes('defaultSessionWriteBlocked'),
  ),
}

// A2 — M2 가 남긴 회차별 지연을 다시 굴린다 (원자료가 진실이고 여기서는 요약만 한다).
const roundsFile = path.join(RAW_DIR, 'n3-n5-rounds.json')
if (fs.existsSync(roundsFile)) {
  const data = JSON.parse(fs.readFileSync(roundsFile, 'utf8'))
  for (const arm of data.arms ?? []) {
    for (const round of arm.rounds) {
      allLatencies.생성.push(round.listedMs)
      allLatencies.종료.push(round.delistedMs)
    }
  }
  out.a2 = {
    표본: allLatencies.생성.length,
    '생성 요청 → 목록 반영 ms': { p50: pct(allLatencies.생성, 50), p95: pct(allLatencies.생성, 95), max: Math.max(...allLatencies.생성) },
    '종료 요청 → 목록에서 사라짐 ms': { p50: pct(allLatencies.종료, 50), p95: pct(allLatencies.종료, 95), max: Math.max(...allLatencies.종료) },
    메모: '통과선 없음 — 측정 자체가 항목이다 (기준 A2)',
  }
}

out.a3 = {
  결론: '재동기는 두지 않는다. 끊겼다 붙는 경로(link 재부트스트랩)가 이미 스냅샷을 다시 받아 오고, 대화형 속도에서 push 유실은 0 이다',
  근거: [
    '분석 ⓘ — 20연타 생성·종료에서 유실 0/40',
    'N7 15회 — 스냅샷 재조회 0회로 이벤트 경로만으로 herdr 와 일치',
  ],
}

console.log(JSON.stringify({ 합계: out.합계, 화이트리스트: out.화이트리스트, 세션가드: out.세션가드, a2: out.a2 }, null, 2))
writeRaw('n8-isolation-audit.json', out)
