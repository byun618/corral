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
//       node app/scripts/l456/tally-runs.mjs <runs.md> --check <인용문서…>
//       node app/scripts/l456/tally-runs.mjs <runs.md> --compare <옛 runs.md>
//
// `--check` 는 R3-F2 의 교차검사다. 규칙 ①("인용한 회차는 그 항목 태그를 가져야 한다")은
// 라운드 2 까지 **사람 눈으로만** 지켜졌고, 그래서 S6 가 근거로 쓴 r109 에 `S6` 태그가 없는
// 채로 통과했다. 인용이 태그보다 넓으면 분모가 실제보다 작고, 그 분모로 만든 「n/총 m」 은
// 그 항목을 판정한 실행을 전부 세지 않은 수다. 이제 기계가 센다 — 어긋나면 종료코드 1.

import { readFileSync } from 'node:fs'

const ROW = /^\| (r\d{3}) \|/
// 라운드 접두사는 **한 자리 라운드 전부**를 받는다. `(?:R2-)?` 였을 때 `R3-F2` 는
// 접두사를 놓치고 3번째 글자부터 `F2` 로 잡혀 **라운드 1 의 F2 행에 얹혔다** — 라운드 3 태그를
// 붙이는 순간 조용히 남의 분모를 불리는 모양이라, 태그를 달기 전에 먼저 고쳤다.
const TAG = /(?:R\d-)?[SHF]\d+(?:-②)?/g

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

/** S1·S2… → S9-② → F… → R2-F…·R3-F… → H… 순. 숫자는 사전순이 아니라 수로 센다. */
function order(a, b) {
  const rank = (tag) => (/^R\d-F/.test(tag) ? 3 : tag.startsWith('F') ? 2 : tag.startsWith('H') ? 4 : 1)
  if (rank(a.tag) !== rank(b.tag)) return rank(a.tag) - rank(b.tag)
  const num = (tag) => Number(/\d+/.exec(tag)?.[0] ?? '0')
  if (num(a.tag) !== num(b.tag)) return num(a.tag) - num(b.tag)
  return a.tag.localeCompare(b.tag)
}

/** 판정표 행의 첫 칸에 오는 기준 항목 이름. 비교표(4칸)·회차표(9칸)와 섞이지 않게 **7칸**만 본다. */
const VERDICT_CELLS = 7
const CRITERION = /^\*{0,2}(S\d+(?:-②)?)\*{0,2}$/
const CITED = /r\d{3}/g

/**
 * **인용 ↔ 태그 교차검사** (R3-F2).
 *
 * 판정표 한 행이 인용한 회차는 runs.md 에서 그 행의 기준 항목 태그를 가져야 한다.
 * 안 가진 것이 하나라도 있으면 실패다 — 「인용은 했는데 안 세었다」가 정확히 그 모양이다.
 *
 * 같은 행의 「실행 n/총 m」 칸도 집계와 대조한다 — 손으로 옮기는 칸이라 태그가 바뀌면 늙는다.
 *
 * 표 **밖**의 산문 인용은 실패로 세지 않고 목록으로만 낸다. 산문은 어느 항목을 판정하는지
 * 스스로 말하지 않아서, 기계가 고를 수 있는 기준이 없다 — 고를 수 없는 것을 고른 척하면
 * 그게 또 조용한 오집계다. 대신 전부 세어서 사람이 훑을 수 있게 남긴다.
 */
export function crossCheck(runs, documents) {
  const byId = new Map(runs.rows.map((row) => [row.id, row]))
  const byTag = new Map(runs.tags.map((bucket) => [bucket.tag, bucket]))
  const failures = []
  const prose = []
  for (const { path, text } of documents) {
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
        for (const id of trimmed.match(CITED) ?? []) prose.push({ path, line: index + 1, id })
        continue
      }
      const parts = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((part) => part.trim())
      const criterion = parts.length === VERDICT_CELLS ? CRITERION.exec(parts[0])?.[1] : undefined
      if (criterion === undefined) {
        for (const id of trimmed.match(CITED) ?? []) prose.push({ path, line: index + 1, id })
        continue
      }
      // 「실행 n/총 m」 칸(7번째)도 집계와 대조한다. 손으로 옮겨 적는 칸이라, 태그가 바뀌면
      // 조용히 늙는다 — 라운드 3 에서 태그를 고칠 때마다 실제로 어긋났다.
      const counted = byTag.get(criterion)
      const written = parts[6]
      const expected = counted === undefined ? null : cell(counted)
      if (expected !== null && written !== expected && !written.startsWith('해당 없음')) {
        failures.push({ path, line: index + 1, criterion, id: '실행 n/총 m',
          why: `칸은 \`${written}\` 인데 집계는 \`${expected}\` 다` })
      }
      for (const id of [...new Set(trimmed.match(CITED) ?? [])]) {
        const row = byId.get(id)
        if (row === undefined) {
          failures.push({ path, line: index + 1, criterion, id, why: 'runs.md 에 그 회차가 없다' })
          continue
        }
        if (!row.tags.includes(criterion)) {
          failures.push({ path, line: index + 1, criterion, id, why: `runs.md 의 태그가 ${row.tags.join('·')} 라 ${criterion} 를 안 센다` })
        }
      }
    }
  }
  return { failures, prose }
}

/** 판정표에 그대로 붙일 「n/총 m」 문자열. 미확정은 분자·분모 양쪽에서 갈라 적는다(③). */
export function cell(bucket) {
  const denominator = bucket.unresolved > 0 ? `미확정(${String(bucket.total)})` : String(bucket.total)
  const numerator = bucket.unresolved > 0 ? `${String(bucket.passed)} + 미확정 ${String(bucket.unresolved)}` : String(bucket.passed)
  return `${numerator} / ${denominator}`
}

/**
 * 두 runs.md 를 태그별로 견준다 (R3-F2).
 *
 * 「라운드 N 표와 달라진 곳」을 **손으로 적으면 늙는다** — 라운드 2 에서 실제로 그 표가
 * 스무 줄 아래 판정표와 어긋난 채 남아 있었다(advisor 가 잡았다). 그래서 그 표도 만든다.
 */
export function compare(before, after) {
  const old = new Map(before.tags.map((bucket) => [bucket.tag, bucket]))
  const now = new Map(after.tags.map((bucket) => [bucket.tag, bucket]))
  const tags = [...new Set([...old.keys(), ...now.keys()])]
  const rows = []
  for (const tag of tags) {
    const a = old.get(tag)
    const b = now.get(tag)
    const from = a === undefined ? '—(없던 항목)' : cell(a)
    const to = b === undefined ? '—(사라진 항목)' : cell(b)
    if (from === to) continue
    const added = b === undefined ? [] : b.ids.filter((id) => !(a?.ids ?? []).includes(id))
    const removed = a === undefined ? [] : a.ids.filter((id) => !(b?.ids ?? []).includes(id))
    rows.push({ tag, from, to, added, removed })
  }
  return rows.sort((x, y) => order({ tag: x.tag }, { tag: y.tag }))
}

const [file, ...flags] = process.argv.slice(2)
if (file !== undefined && flags[0] === '--compare') {
  const [older] = flags.slice(1)
  if (older === undefined) { console.error('--compare 는 옛 runs.md 경로를 받는다'); process.exit(2) }
  const rows = compare(tally(readFileSync(older, 'utf8')), tally(readFileSync(file, 'utf8')))
  console.log(`# 태그별로 달라진 곳 — ${older} → ${file}`)
  console.log('')
  console.log('| 기준 항목 | 그때 | 지금 | 들어온 회차 | 나간 회차 |')
  console.log('| --- | --- | --- | --- | --- |')
  for (const row of rows) {
    console.log(`| ${row.tag} | \`${row.from}\` | \`${row.to}\` | ${row.added.join(' ') || '—'} | ${row.removed.join(' ') || '—'} |`)
  }
  console.log('')
  console.log(`달라진 항목 ${String(rows.length)}개`)
} else if (file !== undefined && flags[0] === '--check') {
  const result = tally(readFileSync(file, 'utf8'))
  const documents = flags.slice(1).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
  if (documents.length === 0) {
    console.error('--check 는 인용 문서를 하나 이상 받는다 — 0개면 아무것도 검사하지 않고 통과한다')
    process.exit(2)
  }
  const { failures, prose } = crossCheck(result, documents)
  console.log(`# 인용 ↔ 태그 교차검사 — 판정표 인용 ${String(failures.length)}건 불일치`)
  console.log(`# runs.md: ${file}`)
  for (const document of documents) console.log(`# 인용 문서: ${document.path}`)
  console.log('')
  if (failures.length > 0) {
    console.log('| 문서 | 줄 | 기준 항목 | 회차 | 왜 |')
    console.log('| --- | --- | --- | --- | --- |')
    for (const item of failures) console.log(`| ${item.path} | ${String(item.line)} | ${item.criterion} | ${item.id} | ${item.why} |`)
    console.log('')
  }
  const byDocument = new Map()
  for (const item of prose) byDocument.set(item.path, (byDocument.get(item.path) ?? new Set()).add(item.id))
  console.log('표 밖 산문 인용 (실패로 세지 않는다 — 사람이 훑는다):')
  for (const [path, ids] of byDocument) console.log(`  ${path}: ${[...ids].sort().join(' ')}`)
  console.log('')
  console.log(failures.length === 0 ? '판정: 통과' : '판정: 미달')
  process.exit(failures.length === 0 ? 0 : 1)
} else if (file !== undefined) {
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
    // **라운드별 수와 미확정 수는 「행」을 센다.** 위 표의 미확정 칸은 태그별이라 한 회차가
    // 여러 항목에 잡히면 여러 번 세어진다 — 산문에 그 합계를 옮겨 적으면 틀린다
    // (실제로 「라운드 0 미확정 10회차」라고 적혀 있었고 행으로 세면 9다).
    const rounds = new Map()
    for (const row of result.rows) {
      const bucket = rounds.get(row.round) ?? { total: 0, unresolved: 0, ids: [] }
      bucket.total += 1
      if (row.unresolved) { bucket.unresolved += 1; bucket.ids.push(row.id) }
      rounds.set(row.round, bucket)
    }
    console.log('')
    for (const [round, bucket] of [...rounds].sort((a, b) => a[0] - b[0])) {
      const tail = bucket.unresolved === 0 ? '미확정 0' : `미확정 ${String(bucket.unresolved)} (${bucket.ids.join(' ')})`
      console.log(`라운드 ${String(round)}: ${String(bucket.total)} 회차 · ${tail}`)
    }
    console.log(`합계: ${String(result.rows.length)} 회차 · 미확정 ${String(result.rows.filter((row) => row.unresolved).length)} 회차`)
  }
}
