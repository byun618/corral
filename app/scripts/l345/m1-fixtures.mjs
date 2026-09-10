// T1 (화면 일치) · T7 (폭) — 픽스처 3종을 pane 에 태우고 **렌더러의 진짜 버퍼**와 원본 바이트를
// 셀 단위로 맞춰 본다.
//
// 기준선 규칙 (01-criteria.md §2, LIFE-342 탈락 사유가 여기서 났다):
//   기준선 = **픽스처 원본 바이트**를 같은 격자의 xterm 에 먹인 것.
//   herdr 의 다른 출력 형식(pane.read(text))을 기준선으로 삼으면 "herdr 의 두 형식이 서로 같다"를
//   재는 것이라 항목이 무효다. 그래서 여기서는 로컬에서 픽스처를 직접 실행해 바이트를 얻는다.
//
// 격자: 비교 영역은 **pane 의 진짜 PTY 격자**(stty 로 확인한 cols×rows)다.
//   corral 이 그리는 격자는 그보다 넓을 수 있다 — API 에 cols 가 없어 layout 힌트를 상한으로
//   쓰기 때문이다 (분석 §4-ⓓ). 남는 열이 **정말 비어 있는지**를 따로 세어 함께 싣는다.
//   좁혀서 통과시키는 것이 아니라, 좁힌 영역 밖이 비었다는 것까지 증거로 낸다.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import headless from '@xterm/headless'
import unicode11 from '@xterm/addon-unicode11'
import {
  FIXTURE_DIR,
  RAW_DIR,
  compareGrids,
  playFixture,
  ptyGrid,
  request,
  rowText,
  sleep,
  startApp,
  tidySession,
  wideStarts,
  writeRaw,
} from './lib.mjs'

const { Terminal } = headless
const { Unicode11Addon } = unicode11

const FIXTURES = [
  { key: 'log', file: '01-log.sh', label: '① 로그형', alt: false, holdMs: 500 },
  { key: 'cjk', file: '02-cjk.sh', label: '② CJK형', alt: false, holdMs: 500 },
  { key: 'tui', file: '03-tui.sh', label: '③ 전체화면 TUI (알트스크린)', alt: true, holdMs: 500 },
]

/**
 * 픽스처를 로컬에서 실행해 stdout 바이트를 받는다.
 *
 * 파이프로 받으면 tty 의 ONLCR(개행 → CR+LF) 후처리가 빠진다. 그대로 xterm 에 넣으면 LF 가
 * 커서를 아래로만 내려 화면이 계단처럼 밀린다 — pane 쪽은 진짜 tty 라 안 그렇다.
 * 그래서 기준선에도 tty 와 같은 변환을 해 준다. 픽스처 파일 자체는 손대지 않는다.
 */
function fixtureBytes(file, holdMs) {
  return new Promise((resolve) => {
    const chunks = []
    const child = spawn('sh', [path.join(FIXTURE_DIR, file)])
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    setTimeout(() => {
      child.kill('SIGKILL')
      resolve(Buffer.concat(chunks).toString('utf8').replace(/(?<!\r)\n/g, '\r\n'))
    }, holdMs)
  })
}

function makeBaseline(cols, rows, mode) {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 })
  if (mode === '11') {
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
  }
  return term
}

const write = (term, data) => new Promise((resolve) => term.write(data, resolve))

function baselineGrid(term) {
  const buffer = term.buffer.active
  const rows = []
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y)
    const cells = []
    if (line) {
      for (let x = 0; x < term.cols; x++) {
        const cell = line.getCell(x)
        if (!cell) {
          cells.push(null)
          continue
        }
        cells.push({
          ch: cell.getChars(),
          w: cell.getWidth(),
          fg: cell.isFgDefault() ? 'default' : `${cell.isFgPalette() ? 'p' : 'rgb'}${cell.getFgColor()}`,
          bg: cell.isBgDefault() ? 'default' : `${cell.isBgPalette() ? 'p' : 'rgb'}${cell.getBgColor()}`,
          bold: !!cell.isBold(),
          inverse: !!cell.isInverse(),
          underline: !!cell.isUnderline(),
        })
      }
    }
    rows.push(cells)
  }
  return rows
}

function lastInkedRow(grid, cols) {
  let last = -1
  for (let y = 0; y < grid.length; y++) {
    if (rowText(grid[y], cols).trim() !== '') last = y
  }
  return last
}

// --- 실행 -----------------------------------------------------------------

const paneId = await tidySession()
const pty = await ptyGrid(paneId)
console.log('pane', paneId, 'PTY', pty.cols, 'x', pty.rows)

const app = await startApp({ name: 'fixtures' })
await sleep(1200)
await app.selectPane(paneId)
await sleep(2000)

const results = {}
const shots = []

for (const fixture of FIXTURES) {
  console.log(`\n=== ${fixture.label} ===`)
  const bytes = await fixtureBytes(fixture.file, fixture.holdMs)
  fs.mkdirSync(path.join(RAW_DIR, 'fixtures'), { recursive: true })
  fs.writeFileSync(path.join(RAW_DIR, 'fixtures', `${fixture.key}.bytes`), bytes)

  await playFixture(paneId, fixture.file, { settleMs: 2200 })
  // 심장박동이 한 번 더 돌 시간을 준다 — 화면이 정지한 뒤의 프레임을 재야 한다.
  await sleep(1500)

  const dump = (await app.dump()).dump
  if (!dump?.ok) throw new Error('term-dump 실패: ' + JSON.stringify(dump))
  const shot = await app.shot(`t1-${fixture.key}`)
  shots.push(shot.file)
  fs.writeFileSync(
    path.join(RAW_DIR, 'fixtures', `${fixture.key}-renderer.json`),
    JSON.stringify({ cols: dump.cols, rows: dump.rows, baseY: dump.baseY, grid: dump.grid }, null, 1),
  )

  // 기준선 — 픽스처 원본 바이트를 pane 의 **진짜 격자**에 먹인다.
  const baseline = makeBaseline(pty.cols, pty.rows, '11')
  await write(baseline, '\x1b[2J\x1b[H')
  await write(baseline, bytes)
  const base = baselineGrid(baseline)
  fs.writeFileSync(
    path.join(RAW_DIR, 'fixtures', `${fixture.key}-baseline.txt`),
    base.map((row) => rowText(row, pty.cols)).join('\n'),
  )

  // 비교 행 범위 = 기준선에 내용이 있는 마지막 행까지. 그 아래는 pane 프롬프트라 잡음이다.
  const rows = lastInkedRow(base, pty.cols) + 1
  const compared = compareGrids(base, dump.grid, { rows, cols: pty.cols })

  // corral 격자가 PTY 보다 넓을 때, 남는 열이 정말 비어 있나 (좁혀서 통과시키지 않았다는 증거)
  let surplusInked = 0
  for (let y = 0; y < dump.rows; y++) {
    for (let x = pty.cols; x < dump.cols; x++) {
      const cell = dump.grid[y]?.[x]
      const ch = cell?.ch ?? ''
      if (ch !== '' && ch !== ' ') surplusInked += 1
    }
  }

  // T7 — wide char 시작 열이 어긋나면 그 행이 밀린 것이다.
  const wideRows = []
  for (let y = 0; y < rows; y++) {
    const a = wideStarts(base[y], pty.cols)
    const b = wideStarts(dump.grid[y], pty.cols)
    const same = a.length === b.length && a.every((cell, i) => cell.x === b[i]?.x && cell.ch === b[i]?.ch)
    if (!same) wideRows.push({ y, baseline: a, renderer: b })
  }

  results[fixture.key] = {
    label: fixture.label,
    alt: fixture.alt,
    fixtureBytes: bytes.length,
    ptyGrid: pty,
    rendererGrid: { cols: dump.cols, rows: dump.rows, baseY: dump.baseY, unicode: dump.unicodeVersion },
    comparedRows: rows,
    comparedCols: pty.cols,
    ...compared,
    surplusColumns: dump.cols - pty.cols,
    surplusInkedCells: surplusInked,
    wideMismatchRows: wideRows.length,
    wideMismatch: wideRows.slice(0, 6),
    shot: shot.file,
    baselineText: base.slice(0, rows).map((row) => rowText(row, pty.cols)),
    rendererText: dump.grid.slice(0, rows).map((row) => rowText(row, pty.cols)),
  }
  console.log(
    'text',
    (compared.textMatch * 100).toFixed(2) + '%',
    '(내용칸 ' + (compared.textMatchInked * 100).toFixed(2) + '%)',
    'style',
    (compared.styleMatch * 100).toFixed(2) + '%',
    '(내용칸 ' + (compared.styleMatchInked * 100).toFixed(2) + '%)',
    'wide 밀림',
    wideRows.length,
    'surplus ink',
    surplusInked,
  )

  if (fixture.alt) {
    // 알트에서 반드시 빠져나온다 — 안 그러면 다음 측정이 내내 틀린 것을 잰다 (LIFE-342 B7).
    await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] })
    await sleep(400)
    await request('pane.send_text', { pane_id: paneId, text: "printf '\\033[?1049l'; clear\n" })
    await sleep(700)
  }
}

writeRaw('10-t1-fixtures.json', {
  measuredAt: new Date().toISOString(),
  session: process.env.LIFE345_SESSION ?? 'life345-claude',
  paneId,
  pty,
  baselineRule: '픽스처 원본 바이트 (herdr 의 다른 형식이 아니다)',
  comparisonNote:
    '비교 영역은 pane 의 진짜 PTY 격자. corral 격자가 더 넓을 때 남는 열의 내용 칸 수를 surplusInkedCells 로 함께 싣는다',
  shots,
  results,
})
await app.stop()
process.exit(0)
