#!/usr/bin/env node
// C10 재현성 검사 — 같은 명령을 여러 회차 돌린 결과 폴더를 받아 차이 **집합**이 같은지 본다.
//
//   node app/scripts/gui-diff/compare-runs.mjs <run-dir> <run-dir> [<run-dir> …] [--out <md>]
//
// 집합의 원소 = (단위 id, 차이 종류, 상세 전문). **건수만 세지 않는다** —
// 건수가 같고 내용이 다르면 재현이 아니다 (LIFE-443 에서 tab-status-dot 색이 그렇게 흔들렸다).
// 집합이 어긋나면 어느 회차에만 있는 원소인지 그대로 찍고 종료코드 1 로 끝난다.

import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const dirs = []
  let out = null
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      out = argv[i + 1]
      i += 1
      continue
    }
    dirs.push(argv[i])
  }
  return { dirs, out }
}

/** 한 회차 폴더의 `<영역>-<상태>-diff.json` 전부를 키별 집합으로. */
function readRun(dir) {
  const byKey = new Map()
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('-diff.json')) continue
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    const elements = new Set(
      parsed.findings.map((f) => `${f.id}\u0000${f.kind}\u0000${JSON.stringify(f.detail)}`)
    )
    byKey.set(name.replace(/-diff\.json$/, ''), { total: parsed.findings.length, elements })
  }
  return { dir, label: path.basename(dir), byKey }
}

function main(argv) {
  const { dirs, out } = parseArgs(argv)
  if (dirs.length < 2) {
    console.error('회차 폴더를 2개 이상 주세요 — 한 회차만으로는 재현성을 말할 수 없습니다.')
    return 2
  }
  const runs = dirs.map(readRun)
  const keys = [...new Set(runs.flatMap((r) => [...r.byKey.keys()]))]

  const lines = []
  lines.push('# C10 재현성 — 같은 명령을 여러 회차 돌려 차이 "집합"이 같은지 본다')
  lines.push('')
  lines.push('집합의 원소 = (단위 id, 차이 종류, 상세 전문). **건수만 세지 않는다** — 건수가 같고 내용이 다르면 재현이 아니다.')
  lines.push('')
  lines.push(`생성: \`node app/scripts/gui-diff/compare-runs.mjs ${dirs.join(' ')}\``)
  lines.push('')
  for (const run of runs) lines.push(`- \`${run.label}\`: \`${run.dir}\``)
  lines.push('')
  lines.push(`| 영역/상태 | ${runs.map((r) => `${r.label} 건수`).join(' | ')} | 집합 동일 |`)
  lines.push(`| --- | ${runs.map(() => '---').join(' | ')} | --- |`)

  let ok = true
  const mismatches = []
  for (const key of keys) {
    const entries = runs.map((r) => r.byKey.get(key))
    const missing = entries.some((e) => !e)
    const base = entries[0]
    let same = !missing
    if (same) {
      for (const entry of entries.slice(1)) {
        if (entry.elements.size !== base.elements.size) { same = false; break }
        for (const element of entry.elements) if (!base.elements.has(element)) { same = false; break }
        if (!same) break
      }
    }
    if (!same) {
      ok = false
      const union = new Set(entries.flatMap((e) => (e ? [...e.elements] : [])))
      for (const element of union) {
        const only = runs.filter((r, i) => entries[i]?.elements.has(element))
        if (only.length === runs.length) continue
        const [id, kind, detail] = element.split('\u0000')
        mismatches.push(`- \`${key}\` · ${id} · ${kind} — ${only.map((r) => r.label).join(',')} 에만 있음: \`${detail.slice(0, 200)}\``)
      }
    }
    lines.push(`| ${key} | ${entries.map((e) => (e ? e.total : '(없음)')).join(' | ')} | ${same ? '예' : '아니오'} |`)
  }
  lines.push('')
  if (mismatches.length > 0) {
    lines.push('## 어긋난 원소')
    lines.push('')
    lines.push(...mismatches)
    lines.push('')
  }
  lines.push(`**판정: ${ok ? '통과 — 회차 간 차이 집합이 상세까지 동일하다' : '미달 — 위 원소가 회차마다 다르다'}**`)
  lines.push('')

  const text = `${lines.join('\n')}\n`
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, text)
    console.log(`[l443] ${out}`)
  }
  process.stdout.write(text)
  return ok ? 0 : 1
}

process.exit(main(process.argv.slice(2)))
