// LIFE-580 L10ⓓ — push 1회 비용 집계(R1 C3). main 로그(`corral.ndjson`)의 `mobile.list_built {seq, buildMs}` 와 `mobile.list_push {seq, sendMs}` 를
// **같은 seq 로 묶어** buildMs + sendMs 를 더하고, 그 합의 p95 를 낸다. 개별 값(buildMs 만·sendMs 만)으로는 기준을 통과시키지 않는다.
//
//   - 표본 = 짝이 맞은 seq(만들기 1 + 보내기 1, 구독자 ≥ 1). 짝 없는 줄은 수만 센다(`unpairedBuilt`·`unpairedPush`).
//   - seq 는 앱(main) 기동마다 1 부터 다시 센다 — 로그에 기동이 여럿이면 `list_built` 의 seq 가 줄어드는 자리에서 구간을 나눈다.
//   - `--since <epoch ms>` 를 주면 그 뒤 줄만(관문 회차 시작 시각).
//   - 통과: 표본 ≥ 1 이고 p95 ≤ `--limit-ms`(기본 5). **표본 0 이면 실패**(빈 로그·폰이 안 붙은 회차를 통과로 세지 않는다).
//
// 사용: node scripts/l580/push-cost.mjs --log "<userData>/corral.ndjson" [--since 1791571502005] [--limit-ms 5] [--out <json>]
// 종료 코드: 0 통과 · 1 미달(표본 0 포함) · 2 사용법 오류. 출력에는 seq·ms·수만 — 제목·기기 이름은 없다.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export function pct(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

/** ndjson 글 → 집계. 줄 모양이 틀리면 건너뛰고 수만 센다. */
export function aggregatePushCost({ text, since = null, limitMs = 5 }) {
  let segment = 0
  let lastBuiltSeq = 0
  let badLines = 0
  const built = new Map()
  const pushed = new Map()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      badLines += 1
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    if (entry.tag !== 'mobile.list_built' && entry.tag !== 'mobile.list_push') continue
    if (since !== null && !(typeof entry.at === 'number' && entry.at >= since)) continue
    if (typeof entry.seq !== 'number') {
      badLines += 1
      continue
    }
    if (entry.tag === 'mobile.list_built') {
      // 기동이 바뀌면 seq 가 1 부터 다시 — 구간을 나눈다.
      if (entry.seq <= lastBuiltSeq) segment += 1
      lastBuiltSeq = entry.seq
      if (typeof entry.buildMs === 'number') built.set(`${segment}:${entry.seq}`, entry.buildMs)
    } else if (typeof entry.sendMs === 'number' && typeof entry.subscribers === 'number' && entry.subscribers >= 1) {
      pushed.set(`${segment}:${entry.seq}`, entry.sendMs)
    }
  }
  const samples = []
  for (const [key, sendMs] of pushed) {
    const buildMs = built.get(key)
    if (buildMs === undefined) continue
    samples.push({ key, buildMs, sendMs, totalMs: Math.round((buildMs + sendMs) * 100) / 100 })
  }
  const totals = samples.map((sample) => sample.totalMs)
  const p95 = pct(totals, 95)
  const pass = samples.length > 0 && p95 !== null && p95 <= limitMs
  return {
    samples: samples.length,
    p50: pct(totals, 50),
    p95,
    max: totals.length > 0 ? Math.max(...totals) : null,
    limitMs,
    unpairedBuilt: [...built.keys()].filter((key) => !pushed.has(key)).length,
    unpairedPush: [...pushed.keys()].filter((key) => !built.has(key)).length,
    segments: segment + 1,
    badLines,
    verdict: pass ? '통과' : '미달',
    reason: samples.length === 0 ? '표본 0 — 짝 맞은 seq(만들기+보내기, 구독자 ≥ 1)가 없다' : pass ? null : `p95 ${p95} ms > ${limitMs} ms`,
    rows: samples,
  }
}

function cli() {
  let values
  try {
    values = parseArgs({ options: { log: { type: 'string' }, since: { type: 'string' }, 'limit-ms': { type: 'string', default: '5' }, out: { type: 'string' } } }).values
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exit(2)
  }
  const since = values.since === undefined ? null : Number(values.since)
  const limitMs = Number(values['limit-ms'])
  if (values.log === undefined || !fs.existsSync(values.log) || (since !== null && !Number.isFinite(since)) || !(limitMs > 0)) {
    console.error('사용: --log <corral.ndjson> [--since <epoch ms>] [--limit-ms 5] [--out <json>]')
    process.exit(2)
  }
  const result = aggregatePushCost({ text: fs.readFileSync(values.log, 'utf8'), since, limitMs })
  if (values.out !== undefined) {
    fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true })
    fs.writeFileSync(values.out, JSON.stringify(result, null, 2) + '\n')
  }
  console.log(`L10ⓓ push 비용 표본 ${result.samples} · p50 ${result.p50} · p95 ${result.p95} · 최대 ${result.max} ms (짝 없음 built ${result.unpairedBuilt} · push ${result.unpairedPush}) → ${result.verdict}${result.reason === null ? '' : ` — ${result.reason}`}`)
  process.exit(result.verdict === '통과' ? 0 : 1)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) cli()
