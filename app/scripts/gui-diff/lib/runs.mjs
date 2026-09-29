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
  '(`.agents/rules/validation.md` G5·H8ⓑ). **`수동` 로 시작하는 「기준 항목」 칸은 사람이 적은 행이다** —',
  '나머지는 `measure.mjs`·`compare-runs.mjs` 가 자기 행을 스스로 적었다(기준 항목 칸까지).',
  '`실행 중` 으로 남은 행은 그 회차가 끝을 못 봤다는 뜻이다 — 지우지 않는다.',
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
 * 회차 **시작**에 행을 먼저 적는다 (L3).
 *
 * 왜: 이전 판은 시작할 때 번호만 잡고(`nextRunId`) 끝에만 행을 썼다. SIGINT·OOM·강제 종료로 중간에
 * 죽은 회차는 원장에 **한 행도 남기지 않고** 다음 회차가 같은 번호를 다시 썼다 — 분모가 조용히 줄어드는
 * 경로다. 지금은 `실행 중` 으로 먼저 적고 끝에 그 행을 결과로 고친다. 고치지 못한 채 죽으면
 * `실행 중` 이 그대로 남아 「끝을 못 본 회차」가 파일에 보인다.
 */
export function beginRun(ledgerPath, { criterion, command, expectedExit = 0, raw }) {
  const id = nextRunId(ledgerPath)
  appendRun(ledgerPath, { id, criterion, command, expectedExit, actualExit: '실행 중', raw, result: '실행 중 (끝을 못 봤으면 이 행이 남는다)' })
  return id
}

/** `beginRun` 이 적은 행을 결과로 고친다. 그 행이 없으면 새로 붙인다 — 기록을 잃지 않는다. */
export function finishRun(ledgerPath, id, { criterion, command, expectedExit = 0, actualExit, raw, result }) {
  ensureLedger(ledgerPath)
  const text = fs.readFileSync(ledgerPath, 'utf8')
  const lines = text.split('\n')
  const index = lines.findIndex((line) => line.startsWith(`| ${id} |`))
  const line = [
    '',
    cell(id),
    cell(criterion),
    `\`${cell(command)}\``,
    cell(expectedExit),
    cell(actualExit),
    cell(raw),
    cell(result),
    ''
  ].join(' | ').replace(/^ \| /, '| ').replace(/ \| $/, ' |')
  if (index === -1) {
    fs.appendFileSync(ledgerPath, `${line}\n`)
    return id
  }
  lines[index] = line
  fs.writeFileSync(ledgerPath, lines.join('\n'))
  return id
}
