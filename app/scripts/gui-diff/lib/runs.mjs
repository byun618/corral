// 명시 실행 목록(G5) 기록기 — 실행 한 번 = `runs.md` 의 한 행.
//
// 왜 도구가 직접 쓰나: 나중에 원자료를 훑어 회차를 되짚는 방식은 회차를 빠뜨리고 실패를
// 통과로 센 전례가 있다(.agents/rules/validation.md, LIFE-440). 그래서 **실행한 그 프로세스가
// 자기 행을 남긴다.** 실패도 남긴다 — 지우지 않는 것이 이 파일의 유일한 규칙이다.
//
// 분모는 이 파일의 칸을 세서만 만든다. 수동 실행(pnpm install, 해시, screencapture)은
// 손으로 한 행 적는다. 형식은 같다.

import fs from 'node:fs'
import path from 'node:path'

const HEADER = [
  '# LIFE-443 명시 실행 목록 (raw/claude/runs.md)',
  '',
  '실행 한 번 = 한 행. **실패 회차도 지우지 않는다.** 판정표의 "실행 n/총 m" 은 이 파일의 칸을 세서만 만든다',
  '(`.agents/rules/validation.md` G5·H8ⓑ). `수동` 표시는 사람이 친 명령, 나머지는 `measure.mjs` 가 스스로 적은 행.',
  '',
  '| 실행 id | 기준 항목 | 명령 | 기대 종료코드 | 실제 종료코드 | 원자료 경로 | 통과/실패 |',
  '| --- | --- | --- | --- | --- | --- | --- |'
].join('\n')

const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')

/** 파일이 없으면 머리글부터 만든다. 있으면 건드리지 않는다 — 과거 행은 이 도구가 고치지 않는다. */
export function ensureLedger(ledgerPath) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
  if (!fs.existsSync(ledgerPath)) fs.writeFileSync(ledgerPath, `${HEADER}\n`)
}

/** 다음 실행 id — 파일에 이미 있는 `R###` 중 최대 + 1. 동시 실행은 상정하지 않는다(측정은 직렬이다). */
export function nextRunId(ledgerPath) {
  ensureLedger(ledgerPath)
  const text = fs.readFileSync(ledgerPath, 'utf8')
  let max = 0
  for (const match of text.matchAll(/^\| (R(\d{3}))\b/gm)) max = Math.max(max, Number(match[2]))
  return `R${String(max + 1).padStart(3, '0')}`
}

export function appendRun(ledgerPath, row) {
  ensureLedger(ledgerPath)
  const line = [
    '',
    cell(row.id),
    cell(row.criterion),
    `\`${cell(row.command)}\``,
    cell(row.expectedExit),
    cell(row.actualExit),
    cell(row.raw),
    cell(row.result),
    ''
  ].join(' | ').replace(/^ \| /, '| ').replace(/ \| $/, ' |')
  fs.appendFileSync(ledgerPath, `${line}\n`)
  return row.id
}

/**
 * 한 번의 `measure.mjs` 실행을 감싼다. **어떤 경로로 끝나든 행이 남는다** —
 * 던져서 끝나도, 0 이 아닌 코드로 끝나도. 그것이 이 함수가 존재하는 이유다.
 */
export async function recordRun(ledgerPath, { criterion, command, expectedExit = 0, raw }, body) {
  const id = nextRunId(ledgerPath)
  try {
    const value = await body(id)
    appendRun(ledgerPath, {
      id,
      criterion,
      command,
      expectedExit,
      actualExit: 0,
      raw: typeof raw === 'function' ? raw(id) : raw,
      result: expectedExit === 0 ? '통과' : '실패 (기대와 다름)'
    })
    return value
  } catch (error) {
    appendRun(ledgerPath, {
      id,
      criterion,
      command,
      expectedExit,
      actualExit: 1,
      raw: typeof raw === 'function' ? raw(id) : raw,
      result: `실패 — ${String(error?.message ?? error).slice(0, 180)}`
    })
    throw error
  }
}
