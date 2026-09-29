#!/usr/bin/env node
// LIFE-456 R2-F5 — 판정표의 「실행 n/총 m」 을 **runs.md 의 칸을 세서** 만든다.
//
// 규칙 (라운드 2 에서 하나로 정했다):
//   ① 판정표가 근거로 인용하는 회차는 runs.md 에서 **그 기준 항목 태그를 가져야 한다.**
//      한 회차가 여러 항목을 판정하면 태그를 여럿 적는다(`S3·F2`). F→S 대응도 **칸에** 적는다 —
//      집계표 밖의 「+ R1 N회」 같은 부기는 없앤다. 부기는 세어지지 않기 때문이다.
//   ② n/m 은 **그 태그를 가진 행만** 센다.
//   ③ 원자료를 잃은 회차는 **분자에서도 갈라** 적는다: `확정통과 + 미확정 k / 총 m`.
//      「미확정」은 통과로도 실패로도 세지 않는다.
//
// **원자료를 패턴으로 훑지 않는다.** 입력은 runs.md 의 표 한 곳뿐이다 (LIFE-440 재발 방지).
//
// 사용: node app/scripts/l456/tally-runs.mjs <runs.md> [--json]

import { readFileSync } from 'node:fs'

const ROW = /^\| (r\d{3}) \|/
const TAG = /(?:R2-)?[SHF]\d+(?:-②)?/g

/** 한 행을 칸으로 자른다. 칸 안에 `|` 가 섞이면 **집계가 조용히 어긋나므로** 즉시 실패한다. */
function cells(line, id) {
  const parts = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim())
  if (parts.length !== 9) {
    throw new Error(`${id}: 칸이 9개가 아니다 (${String(parts.length)}개). 칸 안에 파이프가 섞였는지 본다 — ` +
      `그대로 두면 판정 칸이 밀려 통과를 실패로, 실패를 통과로 센다.`)
  }
  return parts
}

export function tally(markdown) {
  const rows = []
  for (const line of markdown.split('\n')) {
    const match = ROW.exec(line)
    if (match === null) continue
    const id = match[1]
    const [, round, criteria, , , , , raw, verdict] = cells(line, id)
    const tags = [...new Set(criteria.match(TAG) ?? [])]
    if (tags.length === 0) throw new Error(`${id}: 기준 항목 태그가 없다 — 판정표가 인용할 수 없는 행이다`)
    // 판정 칸은 **모르는 모양이면 실패시킨다.** `**미달(복원 실패)**` 처럼 강조·괄호가 섞인 칸을
    // 그냥 `startsWith('통과')` 로 재면 미달이 조용히 실패로, 강조된 통과가 실패로 세어진다 —
    // 조용한 오집계가 이 스크립트를 만든 이유다. 어휘는 통과·미달·실패·보류 넷뿐이다.
    const head = verdict.replace(/\*/g, '').trim().split(/[(（\s]/)[0]
    if (!['통과', '미달', '실패', '보류'].includes(head)) {
      throw new Error(`${id}: 판정 칸의 어휘가 통과·미달·실패·보류 가 아니다 (${JSON.stringify(verdict)})`)
    }
    rows.push({
      id, round: Number(round), tags,
      // 「보류」와 원자료를 잃은 회차는 통과로도 실패로도 세지 않는다 (③).
      unresolved: raw.includes('미확정') || head === '보류',
      passed: head === '통과',
    })
  }
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`${row.id}: 회차 id 가 두 번 나온다`)
    seen.add(row.id)
  }
  const byTag = new Map()
  for (const row of rows) {
    for (const tag of row.tags) {
      const bucket = byTag.get(tag) ?? { tag, total: 0, passed: 0, failed: 0, unresolved: 0, ids: [] }
      bucket.total += 1
      bucket.ids.push(row.id)
      if (row.unresolved) bucket.unresolved += 1
      else if (row.passed) bucket.passed += 1
      else bucket.failed += 1
      byTag.set(tag, bucket)
    }
  }
  return { rows, tags: [...byTag.values()].sort(order) }
}

/** S1·S2… → S9-② → F… → R2-F… → H… 순. 숫자는 사전순이 아니라 수로 센다. */
function order(a, b) {
  const rank = (tag) => (tag.startsWith('R2-F') ? 3 : tag.startsWith('F') ? 2 : tag.startsWith('H') ? 4 : 1)
  if (rank(a.tag) !== rank(b.tag)) return rank(a.tag) - rank(b.tag)
  const num = (tag) => Number(/\d+/.exec(tag)?.[0] ?? '0')
  if (num(a.tag) !== num(b.tag)) return num(a.tag) - num(b.tag)
  return a.tag.localeCompare(b.tag)
}

/** 판정표에 그대로 붙일 「n/총 m」 문자열. 미확정은 분자·분모 양쪽에서 갈라 적는다(③). */
export function cell(bucket) {
  const denominator = bucket.unresolved > 0 ? `미확정(${String(bucket.total)})` : String(bucket.total)
  const numerator = bucket.unresolved > 0 ? `${String(bucket.passed)} + 미확정 ${String(bucket.unresolved)}` : String(bucket.passed)
  return `${numerator} / ${denominator}`
}

const [file, ...flags] = process.argv.slice(2)
if (file !== undefined) {
  const result = tally(readFileSync(file, 'utf8'))
  if (flags.includes('--json')) {
    console.log(JSON.stringify(result, null, 1))
  } else {
    console.log(`# runs.md 칸 집계 — 총 ${String(result.rows.length)} 회차`)
    console.log(`# 입력: ${file}`)
    console.log('')
    console.log('| 기준 항목 | 실행 n / 총 m | 통과 | 실패 | 미확정 | 회차 |')
    console.log('| --- | --- | --- | --- | --- | --- |')
    for (const bucket of result.tags) {
      console.log(`| ${bucket.tag} | ${cell(bucket)} | ${String(bucket.passed)} | ${String(bucket.failed)} | ${String(bucket.unresolved)} | ${bucket.ids.join(' ')} |`)
    }
    const rounds = new Map()
    for (const row of result.rows) rounds.set(row.round, (rounds.get(row.round) ?? 0) + 1)
    console.log('')
    for (const [round, count] of [...rounds].sort((a, b) => a[0] - b[0])) {
      console.log(`라운드 ${String(round)}: ${String(count)} 회차`)
    }
    console.log(`합계: ${String(result.rows.length)} 회차`)
  }
}
