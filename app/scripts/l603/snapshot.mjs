#!/usr/bin/env node
// LIFE-603 R1-H ④ — 재시작 전후 링크 · 예외 · 활동 스냅샷 대조(C12 최종 · R1-C).
//
//   node scripts/l603/snapshot.mjs take <ROOT=/tmp/l603g-*> <out.json>   # <ROOT>/ud 의 repos.json · work-activity.json · work-start-pending.json 을 정규화
//   node scripts/l603/snapshot.mjs diff <before.json> <after.json>       # 같으면 exit 0, 다르면 exit 1 + 차이 JSON
//
// 정규화: worktree 경로별 `workLink`(linkedAt 은 남긴다 — 재시작이 바꾸면 안 된다) · `workLinkSuppressed`, 활동은 `eventKey` 있는 줄만
//   (eventKey → change) 사전 + 열쇠 기억(`seen`) 수, 미확정 시작은 attemptId 목록. 순서·id·시각 칸(at)은 뺀다.
// 실패 전파: 파일을 못 읽거나 JSON 이 아니면 exit 2 — 「없음 = 같음」 으로 읽지 않는다(없는 파일은 `absent` 로 적고 그 자체가 차이다).
import fs from 'node:fs'
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
    if (isRecord(record) && typeof record.eventKey === 'string') events[record.eventKey] = record.change
  }
  const seen = Array.isArray(activity?.seen) ? activity.seen.length : null
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

function main([mode, first, second]) {
  if (mode === 'take') {
    if (first === undefined || !/^\/tmp\/l603g-[^/.]+$/.test(first) || second === undefined) { console.log(JSON.stringify({ ok: false, code: 'usage' })); return 2 }
    const ud = path.join(first, 'ud')
    const files = { registry: readJson(path.join(ud, 'repos.json')), activity: readJson(path.join(ud, 'work-activity.json')), pending: readJson(path.join(ud, 'work-start-pending.json')) }
    const broken = Object.entries(files).filter(([, read]) => read.error !== undefined)
    if (broken.length > 0) { console.log(JSON.stringify({ ok: false, code: 'unreadable', files: broken.map(([name, read]) => ({ name, error: read.error })) })); return 2 }
    const snapshot = { ...normalize({ registry: files.registry.value, activity: files.activity.value, pending: files.pending.value }), files: Object.fromEntries(Object.entries(files).map(([name, read]) => [name, read.absent === true ? 'absent' : 'present'])) }
    fs.writeFileSync(second, JSON.stringify(snapshot, null, 2) + '\n')
    console.log(JSON.stringify({ ok: true, out: second, links: Object.keys(snapshot.links).length, events: Object.keys(snapshot.events).length }))
    return 0
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

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)))
