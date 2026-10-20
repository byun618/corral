#!/usr/bin/env node
// LIFE-603 R1-H ④ — 재시작 전후 링크 · 예외 · 활동 스냅샷 대조(C12 최종 · R1-C).
//
//   node scripts/l603/snapshot.mjs take <ROOT=/tmp/l603g-*> <out.json> [--expect-links N] [--expect-events N]
//        # <ROOT>/ud 의 repos.json · work-activity.json · work-start-pending.json 을 정규화. 링크 · 사건이 N 개 미만이면 exit 3(R2-L —
//        #   둘 다 빈 스냅샷끼리 「같음」 으로 공허하게 통과하지 않게). 기본 N = 1 · 1, 빈 것을 일부러 찍을 때만 0.
//        #   N 이 0 이상 정수가 아니거나 값이 빠지면 exit 2(R3-D — NaN 비교가 거짓이라 빈 스냅샷이 통과하던 구멍).
//   node scripts/l603/snapshot.mjs diff <before.json> <after.json>       # 같으면 exit 0, 다르면 exit 1 + 차이 JSON
//
// 정규화: worktree 경로별 `workLink`(linkedAt 은 남긴다 — 재시작이 바꾸면 안 된다) · `workLinkSuppressed`, 활동은 `eventKey` 있는 줄만
//   (eventKey → { connectionId, change }) 사전 + 열쇠 기억(`seen`) **`[열쇠, 연결 id]` 쌍 집합**(R2-L · R3-D — 열쇠가 같고 연결 id 만 바뀌어도 다름,
//   fix1 문자열은 연결 id null), 미확정 시작은 attemptId 목록. 순서·id·시각 칸(at)은 뺀다.
// 실패 전파: 파일을 못 읽거나 JSON 이 아니면 exit 2 — 「없음 = 같음」 으로 읽지 않는다(없는 파일은 `absent` 로 적고 그 자체가 차이다).
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function readJson(file) {
  if (!fs.existsSync(file)) return { absent: true }
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) } } catch (error) { return { error: String(error) } }
}

export function normalize({ registry, activity, pending }) {
  const links = {}
  const worktrees = isRecord(registry?.worktrees) ? registry.worktrees : {}
  for (const key of Object.keys(worktrees).sort()) {
    const row = worktrees[key]
    if (!isRecord(row) || (row.workLink === undefined && row.workLinkSuppressed === undefined)) continue
    links[key] = { workLink: row.workLink ?? null, suppressed: row.workLinkSuppressed === true }
  }
  const events = {}
  for (const record of Array.isArray(activity?.records) ? activity.records : []) {
    if (isRecord(record) && typeof record.eventKey === 'string') events[record.eventKey] = { connectionId: record.connectionId ?? null, change: record.change }
  }
  // seen 칸: fix2 `[열쇠, 연결 id]` 쌍 · fix1 문자열(연결 id null) — 쌍 집합으로(정렬).
  const pairs = Array.isArray(activity?.seen) ? activity.seen.map((row) => (Array.isArray(row) ? [row[0], typeof row[1] === 'string' ? row[1] : null] : [row, null])).filter(([key]) => typeof key === 'string') : null
  const seen = pairs === null ? null : [...new Map(pairs.map((pair) => [JSON.stringify(pair), pair])).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, pair]) => pair)
  const attempts = (Array.isArray(pending?.entries) ? pending.entries : []).map((entry) => entry?.attemptId).filter((id) => typeof id === 'string').sort()
  return { links, events: Object.fromEntries(Object.keys(events).sort().map((key) => [key, events[key]])), seen, pending: attempts }
}

export function diff(a, b) {
  const out = []
  const keys = (x, y) => [...new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])].sort()
  for (const section of ['links', 'events']) {
    for (const key of keys(a[section], b[section])) {
      const before = JSON.stringify(a[section]?.[key] ?? null), after = JSON.stringify(b[section]?.[key] ?? null)
      if (before !== after) out.push({ section, key, before: a[section]?.[key] ?? null, after: b[section]?.[key] ?? null })
    }
  }
  for (const field of ['seen', 'pending', 'files']) if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) out.push({ section: field, before: a[field], after: b[field] })
  return out
}

function main(argv) {
  const [mode, first, second] = argv
  // 값이 빠졌거나 0 이상 정수가 아니면 null(R3-D) — 호출자가 exit 2.
  const flag = (name, fallback) => { const at = argv.indexOf(`--${name}`); if (at < 0) return fallback; const raw = argv[at + 1]; return typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null }
  if (mode === 'take') {
    if (first === undefined || !/^\/tmp\/l603g-[^/.]+$/.test(first) || second === undefined) { console.log(JSON.stringify({ ok: false, code: 'usage' })); return 2 }
    const expectLinks = flag('expect-links', 1), expectEvents = flag('expect-events', 1)
    if (expectLinks === null || expectEvents === null) { console.log(JSON.stringify({ ok: false, code: 'bad_expect', message: '--expect-links / --expect-events 는 0 이상 정수' })); return 2 }
    const ud = path.join(first, 'ud')
    const files = { registry: readJson(path.join(ud, 'repos.json')), activity: readJson(path.join(ud, 'work-activity.json')), pending: readJson(path.join(ud, 'work-start-pending.json')) }
    const broken = Object.entries(files).filter(([, read]) => read.error !== undefined)
    if (broken.length > 0) { console.log(JSON.stringify({ ok: false, code: 'unreadable', files: broken.map(([name, read]) => ({ name, error: read.error })) })); return 2 }
    const snapshot = { ...normalize({ registry: files.registry.value, activity: files.activity.value, pending: files.pending.value }), files: Object.fromEntries(Object.entries(files).map(([name, read]) => [name, read.absent === true ? 'absent' : 'present'])) }
    fs.writeFileSync(second, JSON.stringify(snapshot, null, 2) + '\n')
    const links = Object.keys(snapshot.links).length, events = Object.keys(snapshot.events).length
    const thin = links < expectLinks || events < expectEvents
    console.log(JSON.stringify({ ok: !thin, out: second, links, events, expectLinks, expectEvents, ...(thin ? { code: 'below_expected' } : {}) }))
    return thin ? 3 : 0
  }
  if (mode === 'diff') {
    const a = readJson(first ?? ''), b = readJson(second ?? '')
    if (a.value === undefined || b.value === undefined) { console.log(JSON.stringify({ ok: false, code: 'unreadable_snapshot' })); return 2 }
    const changes = diff(a.value, b.value)
    console.log(JSON.stringify({ ok: true, same: changes.length === 0, changes }))
    return changes.length === 0 ? 0 : 1
  }
  console.log(JSON.stringify({ ok: false, code: 'usage', usage: 'take <ROOT> <out> | diff <a> <b>' }))
  return 2
}

// 진입 판별은 실경로로(R4-A) — `/tmp`→`/private/tmp` 같은 심볼릭 링크 낀 경로로 부르면 문자열 비교가 거짓이라 main 이 안 돌고 출력 0줄 exit 0 이 됐다.
const invokedDirectly = () => { try { return process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false } }
if (invokedDirectly()) process.exit(main(process.argv.slice(2)))
