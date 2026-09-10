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
import unicodeGraphemes from '@xterm/addon-unicode-graphemes'
import {
  FIXTURE_DIR,
  RAW_DIR,
  clustersOf,
  compareGrids,
  oracleWidths,
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
const { UnicodeGraphemesAddon } = unicodeGraphemes

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

/**
 * 기준선 터미널.
 *
 * **폭 모델은 기준선의 자유 변수가 아니다.** 같은 바이트라도 폭 표가 다르면 글자가 놓이는 열이
 * 달라진다 — `👨‍👩‍👧` 를 3칸으로 세는 표와 2칸으로 세는 표는 뒤따르는 글자를 4열 어긋나게 놓는다.
 * 그래서 판정 수치는 **출고 설정과 같은 모델**(`15-graphemes`)로 잰다. 그 모델이 옳다는 근거는
 * T7 이 따로 낸다 — herdr 스냅샷에서 역산한 폭과 7종 전부 0열 차이였다 (`11-t7-width.json`).
 * 대조로 `11` 기준선도 같이 재서 둘의 차이를 원자료에 남긴다.
 */
function makeBaseline(cols, rows, mode) {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 })
  if (mode === '11') {
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
  }
  if (mode === 'graphemes') {
    term.loadAddon(new UnicodeGraphemesAddon())
    term.unicode.activeVersion = '15-graphemes'
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


/**
 * **기준선 ①(판정용) — 제3 오라클로 직접 배치한 격자.**
 *
 * 1차 측정은 기준선을 헤드리스 xterm 의 `getCell` 로 만들었고, 그 도구가 이모지를 1칸으로
 * 세는 바람에 멀쩡한 화면이 98.92% 로 나왔다 (판정 §3 — herdr·렌더러·`wcwidth`·UAX #11 이
 * 전부 2칸으로 일치하는데 기준선만 1칸이었다). **재는 자와 재이는 자가 같은 폭 표를 쓰면
 * 그 항목은 무효다.** 그래서 기준선의 폭을 `wcwidth`(파이썬)에서 가져온다.
 *
 * 여기 있는 것은 터미널 에뮬레이터가 아니라 **픽스처가 실제로 쓰는 것만** 처리하는 배치기다:
 * SGR(무시) · `ED`(2J) · `CUP`(H) · `EL`(K) · 알트 전환(?1049h/l) · CR/LF/BS/TAB · 그리고 글자.
 * 픽스처 3종을 눈으로 확인하고 그 범위를 정했다 (커서 이동은 `\033[H` 뿐이다).
 * 범위 밖 시퀀스가 오면 **조용히 넘기지 않고 세어서 원자료에 싣는다.**
 */
async function oracleGrid(bytes, cols, rows) {
  const widths = new Map()
  const unique = [...new Set(clustersOf(bytes.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, '')))]
  const measured = await oracleWidths(unique)
  unique.forEach((cluster, index) => widths.set(cluster, measured[index]))

  const blank = () => ({ ch: ' ', w: 1, fg: 'default', bg: 'default', bold: false, inverse: false, underline: false })
  let grid = Array.from({ length: rows }, () => Array.from({ length: cols }, blank))
  let x = 0
  let y = 0
  let unhandled = 0

  const clearAll = () => {
    grid = Array.from({ length: rows }, () => Array.from({ length: cols }, blank))
  }
  const newline = () => {
    y += 1
    if (y >= rows) {
      grid.shift()
      grid.push(Array.from({ length: cols }, blank))
      y = rows - 1
    }
  }
  const put = (cluster, width) => {
    if (width === 0) return
    if (x + width > cols) {
      x = 0
      newline()
    }
    grid[y][x] = { ...blank(), ch: cluster, w: width }
    if (width === 2) grid[y][x + 1] = { ...blank(), ch: '', w: 0 }
    x += width
  }

  const source = [...bytes]
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\x1b') {
      const window = source.slice(i, i + 64).join('')
      const csi = /^\x1b\[([0-9;:?]*)([ -/]*)([@-~])/.exec(window)
      if (csi) {
        const [whole, params, , final] = csi
        i += whole.length - 1
        const numbers = params.replace('?', '').split(';').map((value) => (value === '' ? null : Number(value)))
        if (final === 'm') continue
        if (final === 'J') {
          if (numbers[0] === 2) clearAll()
          else for (let ty = y; ty < rows; ty++) for (let tx = ty === y ? x : 0; tx < cols; tx++) grid[ty][tx] = blank()
          continue
        }
        if (final === 'K') {
          for (let tx = x; tx < cols; tx++) grid[y][tx] = blank()
          continue
        }
        if (final === 'H' || final === 'f') {
          y = Math.min(rows - 1, Math.max(0, (numbers[0] ?? 1) - 1))
          x = Math.min(cols - 1, Math.max(0, (numbers[1] ?? 1) - 1))
          continue
        }
        if ((final === 'h' || final === 'l') && params.startsWith('?')) {
          // 알트 전환·커서 표시 등. 알트로 들어가고 나올 때는 화면이 갈리므로 비운다.
          if (numbers[0] === 1049) {
            clearAll()
            x = 0
            y = 0
          }
          continue
        }
        if (final === 'G') {
          x = Math.min(cols - 1, Math.max(0, (numbers[0] ?? 1) - 1))
          continue
        }
        unhandled += 1
        continue
      }
      const osc = /^\x1b[\]P][^\x07\x1b]*(\x07|\x1b\\)?/.exec(window)
      if (osc) {
        i += osc[0].length - 1
        continue
      }
      unhandled += 1
      continue
    }
    if (ch === '\r') {
      x = 0
      continue
    }
    if (ch === '\n') {
      newline()
      continue
    }
    if (ch === '\b') {
      x = Math.max(0, x - 1)
      continue
    }
    if (ch === '\t') {
      x = Math.min(cols - 1, (Math.floor(x / 8) + 1) * 8)
      continue
    }
    if (ch < ' ') continue
    // 글자 — 군집 단위로 집는다. 결합 문자가 뒤따르면 한 칸에 함께 들어간다.
    let cluster = ch
    const tail = clustersOf(source.slice(i, i + 12).join(''))[0]
    if (tail !== undefined && tail.startsWith(ch)) cluster = tail
    // **코드포인트 개수만큼** 건너뛴다. `source` 는 코드포인트 배열이라 UTF-16 길이를 쓰면
    // ZWJ 가족(코드포인트 5개 · UTF-16 8칸)에서 세 칸을 더 뛰어 뒤 글자를 먹는다.
    i += [...cluster].length - 1
    put(cluster, widths.get(cluster) ?? (await oracleWidths([cluster]))[0])
  }
  return { grid, unhandled }
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
  const gridFor = async (mode) => {
    const term = makeBaseline(pty.cols, pty.rows, mode)
    await write(term, '\x1b[2J\x1b[H')
    await write(term, bytes)
    return baselineGrid(term)
  }
  const base = await gridFor('graphemes')
  const base11 = await gridFor('11')
  // **판정에 쓰는 기준선은 이것이다** — 제3 오라클(`wcwidth`)로 배치한 격자.
  const oracle = await oracleGrid(bytes, pty.cols, pty.rows)
  fs.writeFileSync(
    path.join(RAW_DIR, 'fixtures', `${fixture.key}-baseline.txt`),
    base.map((row) => rowText(row, pty.cols)).join('\n'),
  )
  fs.writeFileSync(
    path.join(RAW_DIR, 'fixtures', `${fixture.key}-baseline-unicode11.txt`),
    base11.map((row) => rowText(row, pty.cols)).join('\n'),
  )

  fs.writeFileSync(
    path.join(RAW_DIR, 'fixtures', `${fixture.key}-baseline-oracle.txt`),
    oracle.grid.map((row) => rowText(row, pty.cols)).join('\n'),
  )

  // 비교 행 범위 = 기준선에 내용이 있는 마지막 행까지. 그 아래는 pane 프롬프트라 잡음이다.
  const rows = Math.max(lastInkedRow(oracle.grid, pty.cols), lastInkedRow(base, pty.cols)) + 1
  // **판정 수치**: 제3 오라클 기준선과의 대조.
  const compared = compareGrids(oracle.grid, dump.grid, { rows, cols: pty.cols })
  // 대조 ①: 헤드리스 xterm(graphemes) — 1차 측정이 쓴 기준선. 스타일은 여기서만 나온다.
  const comparedXterm = compareGrids(base, dump.grid, { rows, cols: pty.cols })
  // 대조 ②: 헤드리스 xterm(unicode11).
  const compared11 = compareGrids(base11, dump.grid, { rows, cols: pty.cols })

  // corral 격자가 PTY 보다 넓을 때, 남는 열이 정말 비어 있나 (좁혀서 통과시키지 않았다는 증거)
  let surplusInked = 0
  for (let y = 0; y < dump.rows; y++) {
    for (let x = pty.cols; x < dump.cols; x++) {
      const cell = dump.grid[y]?.[x]
      const ch = cell?.ch ?? ''
      if (ch !== '' && ch !== ' ') surplusInked += 1
    }
  }

  // T7 — wide char 시작 열이 어긋나면 그 행이 밀린 것이다. 기준은 제3 오라클이다.
  const wideRows = []
  for (let y = 0; y < rows; y++) {
    const a = wideStarts(oracle.grid[y], pty.cols)
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
    styleMatch: comparedXterm.styleMatch,
    styleMatchInked: comparedXterm.styleMatchInked,
    styleDiff: comparedXterm.styleDiff,
    surplusColumns: dump.cols - pty.cols,
    surplusInkedCells: surplusInked,
    wideMismatchRows: wideRows.length,
    wideMismatch: wideRows.slice(0, 6),
    shot: shot.file,
    baselineMode: 'wcwidth 오라클 배치 (제3 오라클 — 판정 수치는 이것이다)',
    unhandledSequences: oracle.unhandled,
    styleFrom: '헤드리스 xterm(15-graphemes) 기준선 — 스타일은 폭 표와 무관한 SGR 비교다',
    styleMatchNote: 'styleMatch/styleMatchInked 는 아래 contrastXterm 의 값과 같은 기준선에서 나온다',
    contrastXterm: {
      note: '대조 — 1차 측정이 쓴 기준선(헤드리스 xterm getCell, graphemes). 이모지를 1칸으로 세는 도구다 (판정 §3)',
      textMatch: comparedXterm.textMatch,
      textMatchInked: comparedXterm.textMatchInked,
      styleMatch: comparedXterm.styleMatch,
      styleMatchInked: comparedXterm.styleMatchInked,
      textDiff: comparedXterm.textDiff,
    },
    contrastUnicode11: {
      note: '대조 — 기준선만 unicode 11 로 바꿔 잰 값. 차이는 전부 ZWJ·RI 군집의 칸 나눔에서 온다',
      textMatch: compared11.textMatch,
      textMatchInked: compared11.textMatchInked,
      styleMatch: compared11.styleMatch,
      styleMatchInked: compared11.styleMatchInked,
    },
    baselineText: oracle.grid.slice(0, rows).map((row) => rowText(row, pty.cols)),
    baselineTextXterm: base.slice(0, rows).map((row) => rowText(row, pty.cols)),
    baselineTextUnicode11: base11.slice(0, rows).map((row) => rowText(row, pty.cols)),
    rendererText: dump.grid.slice(0, rows).map((row) => rowText(row, pty.cols)),
  }
  console.log(
    'text',
    (compared.textMatch * 100).toFixed(2) + '%',
    '(내용칸 ' + (compared.textMatchInked * 100).toFixed(2) + '%)',
    '(대조 xterm ' + (comparedXterm.textMatch * 100).toFixed(2) + '%)',
    'style',
    (comparedXterm.styleMatch * 100).toFixed(2) + '%',
    '(내용칸 ' + (comparedXterm.styleMatchInked * 100).toFixed(2) + '%)',
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
  baselineRule:
    '픽스처 원본 바이트를 **제3 오라클(python wcwidth)** 폭으로 배치한 격자. ' +
    '1차 측정의 헤드리스 xterm getCell 기준선은 이모지를 1칸으로 세어 T1 을 보류로 만들었다 (판정 §3) — ' +
    '그 기준선은 contrastXterm 으로 함께 싣는다. 스타일(SGR)은 폭 표와 무관하므로 xterm 기준선에서 잰다',
  comparisonNote:
    '비교 영역은 pane 의 진짜 PTY 격자. corral 격자가 더 넓을 때 남는 열의 내용 칸 수를 surplusInkedCells 로 함께 싣는다',
  shots,
  results,
})
await app.stop()
process.exit(0)
