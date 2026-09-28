#!/usr/bin/env node
// C10 재현성 검사 — 같은 명령을 여러 회차 돌린 결과 폴더를 받아 차이 **집합**이 같은지 본다.
//
//   node app/scripts/gui-diff/compare-runs.mjs <run-dir> <run-dir> [<run-dir> …] [--out <md>] [--ledger <md>]
//
// 집합의 원소 = (단위 id, 순번, 차이 종류, 상세 전문). **건수만 세지 않는다** — 건수가 같고 내용이
// 다르면 재현이 아니다. 판정 알맹이는 `lib/compare.mjs` 에 있고(단위 테스트), 여기는 읽기·쓰기만 한다.
//
// **유효하지 않은 회차는 비교하지 않는다** — 측정에 실패해 diff 가 없는 폴더 둘을 "동일" 로 적던
// 자리를 막았다. 이 검사도 자기 행을 `runs.md` 에 적는다.

import fs from 'node:fs'
import path from 'node:path'

import { compareRuns } from './lib/compare.mjs'
import { beginRun, finishRun } from './lib/runs.mjs'

function parseArgs(argv) {
  const dirs = []
  let out = null
  let ledger = null
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') { out = argv[++i]; continue }
    if (argv[i] === '--ledger') { ledger = argv[++i]; continue }
    dirs.push(argv[i])
  }
  return { dirs, out, ledger }
}

/** 한 회차 폴더를 읽어 비교용 모양으로. 파일이 없으면 **없다고** 돌려준다 — 추측하지 않는다. */
function readRun(dir) {
  const keys = new Map()
  let summary = null
  const summaryPath = path.join(dir, 'summary.json')
  if (fs.existsSync(summaryPath)) {
    try {
      summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    } catch (error) {
      summary = { parseError: String(error?.message ?? error) }
    }
  }
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('-diff.json')) continue
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      const elements = new Set(
        parsed.findings.map((f) => `${f.id}\u0000${f.index ?? 0}\u0000${f.kind}\u0000${JSON.stringify(f.detail)}`)
      )
      keys.set(name.replace(/-diff\.json$/, ''), { total: parsed.findings.length, elements })
    }
  }
  return { dir, label: path.basename(dir), keys, summary }
}

function render({ dirs, runs, result }) {
  const lines = []
  lines.push('# C10 재현성 — 같은 명령을 여러 회차 돌려 차이 "집합"이 같은지 본다')
  lines.push('')
  lines.push('집합의 원소 = (단위 id, 순번, 차이 종류, 상세 전문). **건수만 세지 않는다** — 건수가 같고 내용이 다르면 재현이 아니다.')
  lines.push('')
  lines.push(`생성: \`node app/scripts/gui-diff/compare-runs.mjs ${dirs.join(' ')}\``)
  lines.push('')
  for (const run of runs) lines.push(`- \`${run.label}\`: \`${run.dir}\``)
  lines.push('')
  lines.push('## 회차 유효성 (집합 비교보다 먼저)')
  lines.push('')
  lines.push('| 회차 | 유효 | 사유 |')
  lines.push('| --- | --- | --- |')
  for (const entry of result.validations) {
    lines.push(`| ${entry.label} | ${entry.ok ? '○' : '✗'} | ${entry.problems.join(' · ') || '요청한 칸이 모두 있고 자기 관문을 통과했다'} |`)
  }
  lines.push('')
  if (result.rows.length > 0) {
    lines.push(`| 영역/상태 | ${runs.map((run) => `${run.label} 건수`).join(' | ')} | 집합 동일 |`)
    lines.push(`| --- | ${runs.map(() => '---').join(' | ')} | --- |`)
    for (const row of result.rows) {
      lines.push(`| ${row.key} | ${row.totals.map((total) => (total === null ? '(없음)' : total)).join(' | ')} | ${row.same ? '예' : '아니오'} |`)
    }
    lines.push('')
  }
  if (result.mismatches.length > 0) {
    lines.push('## 어긋난 원소')
    lines.push('')
    for (const item of result.mismatches) {
      const [id, index, kind, detail] = item.element.split('\u0000')
      lines.push(`- \`${item.key}\` · ${id}[${index}] · ${kind} — ${item.onlyIn.join(',')} 에만 있음: \`${detail.slice(0, 200)}\``)
    }
    lines.push('')
  }
  lines.push(`**판정: ${result.ok ? '통과 — 회차 간 차이 집합이 상세까지 동일하다' : `미달 — ${result.reason}`}**`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

function main(argv) {
  const { dirs, out, ledger } = parseArgs(argv)
  const command = `node app/scripts/gui-diff/compare-runs.mjs ${argv.join(' ')}`
  const runId = ledger ? beginRun(ledger, { criterion: 'C10 (재현성 검사)', command, raw: out ?? '(stdout)' }) : null
  const finish = (exit, verdict) => {
    if (ledger && runId) {
      finishRun(ledger, runId, { criterion: 'C10 (재현성 검사)', command, actualExit: exit, raw: out ?? '(stdout)', result: verdict })
    }
    return exit
  }

  if (dirs.length < 2) {
    process.stderr.write('회차 폴더를 2개 이상 주세요 — 한 회차로는 재현성을 말할 수 없습니다.\n')
    return finish(2, '실패 — 회차 2개 미만')
  }
  const runs = dirs.map(readRun)
  const result = compareRuns(runs)
  const text = render({ dirs, runs, result })
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, text)
    process.stdout.write(`[l443] ${out}\n`)
  }
  process.stdout.write(text)
  return finish(result.ok ? 0 : 1, result.ok ? '통과 — 집합 상세까지 동일' : `실패 — ${result.reason}`)
}

process.exit(main(process.argv.slice(2)))
