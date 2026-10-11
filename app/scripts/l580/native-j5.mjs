// LIFE-580 J5 네이티브 계산기(R2-A4 · R3-A2) — 폰 연결 기록 사본 + 원인 기록(`native-cause.mjs`) [+ main 로그 발췌] → 전이별 ⓐ·ⓑ.
//
//   짝 맞추기(R3-A2): 원인 줄의 **대상 채널(`target`)·기대 상태(`expect`)** 로, 폰 `list_recv` 중 **대상 채널의 점이 기대 상태로 바뀐 첫 목록**
//             (받은 순서, `changes` 를 접어 대상 점을 안다)을 고른다 — `transition-match.mjs`. 그 목록은 원인 뒤·다음 원인 전에 만든 것이어야 한다
//             (`serverAt`, 둘 다 맥 시계). 다른 채널만 바뀐 목록은 짝이 아니다. 같은 상태 반복·대상 확인 불가·대상 점 기록 없음은 보류.
//             대상은 보이는데 기대 상태 목록이 없으면 「미수신」(세는 회차).
//   ⓐ = recvAt − (changedAt − offsetMs)        main 이 그 목록의 첫 변화를 낸 시각 → 폰 수신(같은 목록에 앞선 다른 변화가 묶였으면 길게 나온다 — 보수 쪽)
//   ⓑ = recvAt − (causeAt − offsetMs)          변화를 일으킨 시각(보고 호출 직전) → 폰 수신
//   offsetMs = 그 `list_recv` 줄에 실린 시계차(서버 − 폰). null 이면 그 전이는 「보정 없음」 보류.
//   **원인 시각이 없는 전이**(보고 실패 · 원인 줄 없음)와 대상·기대 상태가 없는 원인 줄은 보류이고 5회에 세지 않는다.
//   `agent.push.applied` 는 판정이 아니라 중간 참고값(원인 → main 적용)으로만 낸다(--main 을 줄 때).
//   통과: 셀 수 있는 전이(원인·대상 확인·수신·보정 다 있음) ≥ 5 이고, 그 전이 **전부** ⓐ·ⓑ ≤ 3000 ms. 하나라도 넘거나 미수신이면 미달.
//   원인 기록에 중단·예외 줄(`kind: interrupted|error`, R3-A4)이 있으면 그 회차는 실패 — 미달.
//
// 사용: node scripts/l580/native-j5.mjs --phone <폰 기록 사본> --cause <cause.ndjson> [--main <main 로그 발췌>] [--out <json>] [--min 5]
// 종료 코드: 0 통과 · 1 미달 · 2 사용법 오류.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { foldTargetDots, matchTransition } from './transition-match.mjs'

export const LIMIT_MS = 3_000

function lines(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value = JSON.parse(line)
      if (value !== null && typeof value === 'object') out.push(value)
    } catch {
      // 사본 머리·꼬리의 다른 글 — 건너뛴다
    }
  }
  return out
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export function computeNativeJ5({ phoneText, causeText, mainText = null, min = 5 }) {
  // 받은 순서 그대로(폰 기록은 시간순) — seq 는 연결이 바뀌면 다시 시작할 수 있어 정렬 열쇠로 쓰지 않는다.
  const recv = lines(phoneText)
    .filter((entry) => entry.event === 'list_recv')
    .map((entry) => ({
      seq: num(entry.seq),
      builtAt: num(entry.serverAt) ?? num(entry.changedAt),
      changedAt: num(entry.changedAt),
      recvAt: num(entry.recvAt) ?? (typeof entry.at === 'string' ? Date.parse(entry.at) : null),
      offsetMs: num(entry.offsetMs),
      rttMs: num(entry.rttMs),
      changes: entry.changes,
    }))
    .filter((entry) => entry.builtAt !== null && entry.changedAt !== null && entry.recvAt !== null)
  const causeRows = lines(causeText)
  // `native-cause.mjs` 의 원인 줄만 전이다. 중단·예외 줄은 그 회차가 실패로 끝났다는 표시(R3-A4) — 있으면 미달. release 줄은 정리 결과(참고).
  const causes = causeRows.filter((entry) => entry.kind === undefined || entry.kind === 'cause').sort((a, b) => (num(a.causeAt) ?? 0) - (num(b.causeAt) ?? 0))
  const aborted = causeRows.filter((entry) => entry.kind === 'interrupted' || entry.kind === 'error')
  const cleanup = causeRows.filter((entry) => entry.kind === 'release').map((entry) => ({ reason: entry.reason ?? null, exit: num(entry.exit) }))
  const applied = mainText === null ? [] : lines(mainText).filter((entry) => entry.tag === 'agent.push.applied' && entry.changed === true && num(entry.at) !== null)
  const pushes = mainText === null ? [] : lines(mainText).filter((entry) => entry.tag === 'mobile.list_push' && num(entry.at) !== null)
  const rows = causes.map((cause, index) => {
    const causeAt = cause.exit === 0 ? num(cause.causeAt) : null
    const target = typeof cause.target === 'string' && cause.target !== '' ? cause.target : null
    const expect = typeof cause.expect === 'string' && cause.expect !== '' ? cause.expect : null
    const base = { i: cause.i ?? index, label: cause.label ?? '', state: cause.state ?? null, target, expect }
    if (causeAt === null) return { ...base, status: '보류', why: '원인 시각 없음(보고 실패)', countable: false }
    if (target === null || expect === null) return { ...base, causeAt, status: '보류', why: '원인 줄에 대상 채널·기대 상태 없음', countable: false }
    const nextCause = causes.slice(index + 1).map((item) => num(item.causeAt)).find((value) => value !== null) ?? Number.POSITIVE_INFINITY
    const match = matchTransition({ lists: foldTargetDots({ recv, target }), expect, causeAt, nextCauseAt: nextCause })
    if (match.kind === 'held') return { ...base, causeAt, status: '보류', why: match.why, countable: false }
    if (match.kind === 'miss') return { ...base, causeAt, status: '미수신', why: match.why, countable: true, aMs: null, bMs: null }
    const hit = match.list
    if (hit.offsetMs === null) return { ...base, causeAt, seq: hit.seq, status: '보류', why: '보정값 없음(offsetMs null)', countable: false }
    const aMs = hit.recvAt - (hit.changedAt - hit.offsetMs)
    const bMs = hit.recvAt - (causeAt - hit.offsetMs)
    const firstApplied = applied.find((entry) => entry.at >= causeAt && entry.at < nextCause)
    const push = pushes.find((entry) => entry.seq === hit.seq)
    return {
      ...base,
      causeAt,
      seq: hit.seq,
      dot: hit.dot,
      builtAt: hit.builtAt,
      changedAt: hit.changedAt,
      recvAt: hit.recvAt,
      offsetMs: hit.offsetMs,
      errorBoundMs: hit.rttMs === null ? null : hit.rttMs / 2,
      aMs,
      bMs,
      // 중간 참고값 — 판정에 쓰지 않는다.
      causeToAppliedMs: firstApplied === undefined ? null : firstApplied.at - causeAt,
      pushAt: push === undefined ? null : push.at,
      orderOk: push === undefined ? null : push.at >= hit.changedAt && push.at <= hit.recvAt + hit.offsetMs,
      status: aMs <= LIMIT_MS && bMs <= LIMIT_MS ? '통과' : '초과',
      countable: true,
    }
  })
  const counted = rows.filter((row) => row.countable)
  const pass = aborted.length === 0 && counted.length >= min && counted.every((row) => row.status === '통과')
  return {
    rule: `원인·대상 확인·수신·보정이 다 있는 전이 ≥ ${min}, 그 전부 ⓐ·ⓑ ≤ ${LIMIT_MS} ms. 짝 = 대상 채널이 기대 상태로 바뀐 첫 목록. 원인 시각·대상 확인 없는 전이는 보류(세지 않음). agent.push.applied 는 참고값.`,
    counted: counted.length,
    held: rows.filter((row) => !row.countable).length,
    aborted: aborted.map((entry) => ({ kind: entry.kind, signal: entry.signal ?? null })),
    cleanup,
    maxAMs: counted.length > 0 ? Math.max(...counted.map((row) => row.aMs ?? Number.POSITIVE_INFINITY)) : null,
    maxBMs: counted.length > 0 ? Math.max(...counted.map((row) => row.bMs ?? Number.POSITIVE_INFINITY)) : null,
    verdict: pass ? '통과' : '미달',
    rows,
  }
}

function cli() {
  let values
  try {
    values = parseArgs({ options: { phone: { type: 'string' }, cause: { type: 'string' }, main: { type: 'string' }, out: { type: 'string' }, min: { type: 'string', default: '5' } } }).values
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exit(2)
  }
  const min = Number(values.min)
  if (values.phone === undefined || values.cause === undefined || !fs.existsSync(values.phone) || !fs.existsSync(values.cause) || !Number.isInteger(min) || min < 1) {
    console.error('사용: --phone <폰 기록 사본> --cause <cause.ndjson> [--main <main 로그 발췌>] [--out <json>] [--min 5]')
    process.exit(2)
  }
  const result = computeNativeJ5({
    phoneText: fs.readFileSync(values.phone, 'utf8'),
    causeText: fs.readFileSync(values.cause, 'utf8'),
    mainText: values.main === undefined ? null : fs.readFileSync(values.main, 'utf8'),
    min,
  })
  if (values.out !== undefined) fs.writeFileSync(values.out, JSON.stringify(result, null, 2) + '\n')
  for (const row of result.rows) console.log(`${row.i} ${row.state} ${row.status}${row.aMs !== undefined && row.aMs !== null ? ` ⓐ ${row.aMs}ms ⓑ ${row.bMs}ms` : ''}${row.why ? ` — ${row.why}` : ''}`)
  console.log(`J5 네이티브 셀 수 있는 전이 ${result.counted} · 보류 ${result.held} · 중단 ${result.aborted.length} · ⓐ 최대 ${result.maxAMs} · ⓑ 최대 ${result.maxBMs} → ${result.verdict}`)
  process.exit(result.verdict === '통과' ? 0 : 1)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) cli()
