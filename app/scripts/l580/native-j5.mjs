// LIFE-580 J5 네이티브 계산기(R2-A4) — 폰 연결 기록 사본 + 원인 기록(`native-cause.mjs`) [+ main 로그 발췌] → 전이별 ⓐ·ⓑ.
//
//   짝 맞추기: 원인 줄마다 **그 원인 시각 이후 처음으로 만든 목록**(`changedAt ≥ causeAt`, 둘 다 맥 시계)을 폰 `list_recv` 에서 찾는다.
//             다음 원인 시각 전에 만든 목록이어야 한다(다른 전이와 섞이지 않게). 없으면 「미수신」.
//   ⓐ = recvAt − (changedAt − offsetMs)        main 이 그 변화를 담은 상태를 낸 시각 → 폰 수신
//   ⓑ = recvAt − (causeAt − offsetMs)          변화를 일으킨 시각(보고 호출 직전) → 폰 수신
//   offsetMs = 그 `list_recv` 줄에 실린 시계차(서버 − 폰). null 이면 그 전이는 「보정 없음」 보류.
//   **원인 시각이 없는 전이**(보고 실패 · 원인 줄 없음)는 ⓑ 보류이고 5회에 세지 않는다. `agent.push.applied` 는 판정이 아니라 중간 참고값
//   (원인 → main 적용)으로만 낸다(--main 을 줄 때).
//   통과: 셀 수 있는 전이(원인·수신·보정 다 있음) ≥ 5 이고, 그 전이 **전부** ⓐ·ⓑ ≤ 3000 ms. 하나라도 넘으면 미달.
//
// 사용: node scripts/l580/native-j5.mjs --phone <폰 기록 사본> --cause <cause.ndjson> [--main <main 로그 발췌>] [--out <json>] [--min 5]
// 종료 코드: 0 통과 · 1 미달 · 2 사용법 오류.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

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
  const recv = lines(phoneText)
    .filter((entry) => entry.event === 'list_recv')
    .map((entry) => ({ seq: num(entry.seq), changedAt: num(entry.changedAt), recvAt: num(entry.recvAt) ?? (typeof entry.at === 'string' ? Date.parse(entry.at) : null), offsetMs: num(entry.offsetMs), rttMs: num(entry.rttMs) }))
    .filter((entry) => entry.changedAt !== null && entry.recvAt !== null)
    .sort((a, b) => a.changedAt - b.changedAt)
  const causes = lines(causeText).sort((a, b) => (num(a.causeAt) ?? 0) - (num(b.causeAt) ?? 0))
  const applied = mainText === null ? [] : lines(mainText).filter((entry) => entry.tag === 'agent.push.applied' && entry.changed === true && num(entry.at) !== null)
  const pushes = mainText === null ? [] : lines(mainText).filter((entry) => entry.tag === 'mobile.list_push' && num(entry.at) !== null)
  const rows = causes.map((cause, index) => {
    const causeAt = cause.exit === 0 ? num(cause.causeAt) : null
    const base = { i: cause.i ?? index, label: cause.label ?? '', state: cause.state ?? null, pane: cause.pane ?? null }
    if (causeAt === null) return { ...base, status: '보류', why: '원인 시각 없음(보고 실패)', countable: false }
    const nextCause = causes.slice(index + 1).map((item) => num(item.causeAt)).find((value) => value !== null) ?? Number.POSITIVE_INFINITY
    const hit = recv.find((entry) => entry.changedAt >= causeAt && entry.changedAt < nextCause)
    if (hit === undefined) return { ...base, causeAt, status: '미수신', why: '원인 뒤 만든 목록을 폰이 받지 않았다', countable: true, aMs: null, bMs: null }
    if (hit.offsetMs === null) return { ...base, causeAt, seq: hit.seq, status: '보류', why: '보정값 없음(offsetMs null)', countable: false }
    const aMs = hit.recvAt - (hit.changedAt - hit.offsetMs)
    const bMs = hit.recvAt - (causeAt - hit.offsetMs)
    const firstApplied = applied.find((entry) => entry.at >= causeAt && entry.at < nextCause)
    const push = pushes.find((entry) => entry.seq === hit.seq)
    return {
      ...base,
      causeAt,
      seq: hit.seq,
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
  const pass = counted.length >= min && counted.every((row) => row.status === '통과')
  return {
    rule: `원인·수신·보정이 다 있는 전이 ≥ ${min}, 그 전부 ⓐ·ⓑ ≤ ${LIMIT_MS} ms. 원인 시각 없는 전이는 보류(세지 않음). agent.push.applied 는 참고값.`,
    counted: counted.length,
    held: rows.filter((row) => !row.countable).length,
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
  console.log(`J5 네이티브 셀 수 있는 전이 ${result.counted} · 보류 ${result.held} · ⓐ 최대 ${result.maxAMs} · ⓑ 최대 ${result.maxBMs} → ${result.verdict}`)
  process.exit(result.verdict === '통과' ? 0 : 1)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) cli()
