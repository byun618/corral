// LIFE-470 수정 라운드 1 (R1-08) — 판정표 「실행 n/총 m」 을 runs.md(명시 실행 목록)의 **칸 값만** 세어 만든다.
// 묶음은 「기준 항목」 칸의 글로 정한다(아래 GROUPS). 원자료를 패턴으로 훑어 회차를 추측하지 않는다(validation.md H8ⓑ).
// 마지막 칸은 `통과`·`실패`·`미확정` 셋 중 하나여야 한다 — 그 밖의 값이면 오류로 멈춘다(수정 라운드 3 R3-01).
// 미확정(원자료 없는 회차)이 하나라도 든 묶음은 n/m 을 확정하지 않는다 — 「확인된 통과 a · 실패 b · 미확정 c, 총 회차 미확정」(H8ⓑ).
// 같은 행이 여러 묶음에 들 수 있다(예: K1~K9 격리 회차가 K12ⓑ 스모크도 돈 경우).
// 사용: node count-runs.mjs <runs.md> | node count-runs.mjs --self-check
import fs from 'node:fs'

const GROUPS = [
  { id: 'iso-menu', label: 'K1~K10 메뉴·정렬·필터 격리 하네스(options-isolated)', match: (row) => /격리 실행 run\d+/.test(row.criterion) },
  { id: 'iso-smoke', label: 'K12ⓑ 스모크(같은 하네스 중 스모크가 든 회차)', match: (row) => row.criterion.includes('K12ⓑ 스모크') },
  { id: 'iso-r1', label: '수정 라운드 1 추가 검사(혼합 입력·많은 레포·K4d 강화)가 든 회차', match: (row) => row.criterion.includes('R1 검사') },
  { id: 'l469', label: 'K12ⓐ LIFE-469 순서 변경 회귀(reorder-isolated)', match: (row) => row.criterion.includes('LIFE-469 순서 변경 회귀') },
  { id: 'measure', label: 'K10ⓒ·K12ⓒ 측정 도구(sidebar default)', match: (row) => row.id.startsWith('R') },
  { id: 'vitest', label: 'K12ⓐ vitest 전체', match: (row) => row.criterion.includes('vitest') },
  { id: 'node-test', label: 'K12ⓐ node:test gui-diff', match: (row) => row.criterion.includes('node:test') },
  { id: 'typecheck', label: 'K12ⓐ 타입 검사', match: (row) => row.criterion.includes('타입 검사') },
  { id: 'lint', label: 'K12ⓐ lint 증가 없음', match: (row) => row.criterion.includes('lint') },
  { id: 'build', label: 'K12ⓐ 빌드', match: (row) => row.criterion.includes('빌드') && row.id.startsWith('C') },
  { id: 'native', label: 'K11 네이티브 관문', match: (row) => row.id.startsWith('N') },
  { id: 'raw-audit', label: 'R1-01 원자료 점검(audit-raw)', match: (row) => row.criterion.includes('원자료 점검') },
  { id: 'negative', label: '음성 대조(옛 코드에서 새 시험·점검이 실패 — 라운드 1~3)', match: (row) => row.criterion.includes('음성 대조') },
  { id: 'self-check', label: '자기점검(native-k11 드래그 판정 · audit-raw · anon-check · native-down-check · count-runs)', match: (row) => row.criterion.includes('자기점검') },
  { id: 'iso-r2', label: '수정 라운드 2 추가 검사(K7a-others-kept)가 든 회차', match: (row) => row.criterion.includes('R2 검사') },
  { id: 'r2-unit', label: 'R2-01 단위(파일 단독 실행)', match: (row) => row.criterion.startsWith('R2-01 단위') },
  { id: 'r2-anon', label: 'R2-02 익명화 멱등(자기점검·음성 대조·실제 raw 재실행)', match: (row) => row.criterion.startsWith('R2-02') },
  { id: 'r3-count', label: 'R3-01 집계 미확정 구분(자기점검·음성 대조)', match: (row) => row.criterion.startsWith('R3-01') },
  { id: 'r2-down', label: 'R2-03 원복 익명화 종료코드', match: (row) => row.criterion.startsWith('R2-03') },
]

const RESULTS = ['통과', '실패', '미확정']
const MARK = { 통과: '', 실패: '✘', 미확정: '?' }

function parseRows(text) {
  return text
    .split('\n')
    .filter((line) => /^\| [A-Z]\d{3} \|/.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
      // 결과는 **마지막 칸** — 앞 칸 글에 `|` 가 섞여도 어긋나지 않게.
      const row = { id: cells[0], criterion: cells[1], result: cells.at(-1) }
      if (!RESULTS.includes(row.result)) throw new Error(`${row.id}: 마지막 칸 「${row.result}」 — 통과·실패·미확정 중 하나여야 한다`)
      return row
    })
}

/** 묶음 한 줄의 「통과 n / 총 m」 칸 — 미확정이 있으면 총 회차를 확정하지 않는다. */
export function tally(rows) {
  const count = (result) => rows.filter((row) => row.result === result).length
  const [pass, fail, unknown] = RESULTS.map(count)
  if (unknown > 0) return `확인된 통과 ${pass} · 실패 ${fail} · 미확정 ${unknown}, 총 회차 미확정`
  return `${pass}/${pass + fail}`
}

function report(rows) {
  const lines = ['| 묶음 | 행 (✘ 실패 · ? 미확정) | 통과 n / 총 m |', '| --- | --- | --- |']
  for (const group of GROUPS) {
    const hit = rows.filter(group.match)
    lines.push(`| ${group.label} | ${hit.map((row) => `${row.id}${MARK[row.result]}`).join(' ') || '—'} | ${hit.length === 0 ? '—' : tally(hit)} |`)
  }
  const unmatched = rows.filter((row) => !GROUPS.some((group) => group.match(row)))
  lines.push('', `행 ${rows.length}개 · 어느 묶음에도 안 든 행: ${unmatched.map((row) => row.id).join(' ') || '없음'}`)
  return lines.join('\n')
}

if (process.argv.includes('--self-check')) {
  // 합성 원장 — 미확정이 든 묶음은 총 회차 미확정, 미확정 없는 묶음은 n/m, 모르는 값은 오류.
  const ledger = [
    '| C901 | K12ⓐ 타입 검사 (합성) | x | 0 | 0 | 없음 | 통과 |',
    '| C902 | K12ⓐ 타입 검사 (합성) | x | 0 | 1 | 없음 | 실패 |',
    '| C903 | K12ⓐ 타입 검사 (합성) | x | 0 | 0 | 원자료 없음 | 미확정 |',
    '| C904 | K12ⓐ 빌드 (합성) | x | 0 | 0 | 없음 | 통과 |',
  ].join('\n')
  const out = report(parseRows(ledger))
  const typeLine = out.split('\n').find((line) => line.startsWith('| K12ⓐ 타입 검사'))
  const buildLine = out.split('\n').find((line) => line.startsWith('| K12ⓐ 빌드'))
  let badValueStops = false
  try {
    parseRows('| C905 | K12ⓐ 빌드 | x | 0 | 0 | 없음 | 실행 중 |')
  } catch {
    badValueStops = true
  }
  const checks = {
    unknownGroupNotConfirmed: typeLine.includes('확인된 통과 1 · 실패 1 · 미확정 1, 총 회차 미확정') && typeLine.includes('C903?') && typeLine.includes('C902✘'),
    cleanGroupConfirmed: buildLine.endsWith('| 1/1 |'),
    badValueStops,
  }
  const ok = Object.values(checks).every(Boolean)
  console.log(JSON.stringify({ selfCheck: ok ? 'pass' : 'fail', checks, typeLine, buildLine, ledger: ledger.split('\n') }, null, 2))
  process.exit(ok ? 0 : 1)
}

console.log(report(parseRows(fs.readFileSync(process.argv[2], 'utf8'))))
