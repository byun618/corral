// ⓑ B1~B4 — pane.read(ansi) 스냅샷을 xterm.js 에 재생하고 원본과 셀 단위로 비교.
//
// 기준선(A) = 픽스처를 로컬에서 그대로 실행해 얻은 바이트를 xterm 인스턴스 A 에 먹인 것.
// 대상(B)   = herdr pane.read(visible, ansi, strip_ansi:false) 를 인스턴스 B 에 먹인 것.
// observe 스트림은 기준선으로 쓰지 않는다 — 그건 B8 에서 자기가 측정 대상이다.
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/b-snapshot.mjs

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Raw, sleep } from '../lib/raw.mjs'
import { RAW_DIR } from '../lib/herdr.mjs'
import { makeApi, run, readPair } from '../lib/pane.mjs'
import { makeTerm, write, grid, cursor, compare, wideStarts, rowText } from '../lib/xterm.mjs'

const raw = new Raw('b-snapshot')
const api = makeApi(raw)
const SPIKE = path.resolve(new URL('..', import.meta.url).pathname)
const R = { fixtures: {} }

// --- 격자 크기를 먼저 못 박는다 -----------------------------------------
// pane.resize 는 상대 조정(direction+amount)이라 정확한 크기 지정 수단이 아니다.
// 그래서 크기를 강제하지 않고 **셸에게 물어 확정**하고, xterm 인스턴스를 같은 크기로 만든다.
const panes = await api('pane.list', {})
const P = panes.panes[0].pane_id
for (const p of panes.panes.slice(1)) await api('pane.close', { pane_id: p.pane_id })
await run(api, P, `cd ${SPIKE}`, { settleMs: 600 })
await run(api, P, "printf '\\033[2J\\033[H'; stty size", { settleMs: 900 })
const sizeRead = await readPair(api, P, 'visible')
const m = sizeRead.text.text.match(/(\d+)\s+(\d+)/)
if (!m) throw new Error('stty size 를 못 읽었다: ' + JSON.stringify(sizeRead.text.text.slice(0, 200)))
const ROWS = Number(m[1])
const COLS = Number(m[2])
R.grid = { cols: COLS, rows: ROWS, source: 'stty size (셸이 보는 PTY 크기)', paneId: P }
raw.log('grid', R.grid)
console.log('grid', COLS, 'x', ROWS, 'pane', P)

// --- 픽스처 원본 바이트 (기준선 A) --------------------------------------
/**
 * 픽스처를 로컬에서 실행해 stdout 바이트를 받는다. sleep 은 출력이 없으니 잘라도 된다.
 *
 * 파이프로 받으면 tty 가 하는 ONLCR(개행 → CR+LF) 후처리가 빠진다. 그대로 xterm 에 넣으면
 * LF 가 커서를 아래로만 내려 화면이 계단처럼 밀린다 — pane 쪽은 진짜 tty 라 안 그렇다.
 * 그래서 기준선에도 tty 와 같은 변환을 해준다. 픽스처 파일 자체는 손대지 않는다.
 */
function fixtureBytes(file, { holdMs = 500 } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    const p = spawn('sh', [path.join(SPIKE, 'fixtures', file)], { cwd: SPIKE })
    p.stdout.on('data', (c) => chunks.push(c))
    setTimeout(() => {
      p.kill('SIGKILL')
      const out = Buffer.concat(chunks).toString('utf8')
      resolve(out.replace(/(?<!\r)\n/g, '\r\n'))
    }, holdMs)
  })
}

const FIXTURES = [
  { key: 'log', file: '01-log.sh', label: '① 로그형', alt: false },
  { key: 'cjk', file: '02-cjk.sh', label: '② CJK형', alt: false },
  { key: 'tui', file: '03-tui.sh', label: '③ TUI형 (alternate screen)', alt: true },
]

for (const fx of FIXTURES) {
  console.log(`\n=== ${fx.label} ===`)
  const bytes = await fixtureBytes(fx.file)
  raw.log('fixture.bytes', { key: fx.key, file: fx.file, length: bytes.length, escaped: JSON.stringify(bytes) })

  // pane 에 픽스처를 태운다. 화면을 먼저 지워 프롬프트·에코를 위로 밀어낸다.
  // (픽스처 파일 자체는 글자 그대로다 — 지우기는 하네스 쪽 처리다)
  await run(api, P, `printf '\\033[2J\\033[H'; sh fixtures/${fx.file}`, { settleMs: 1400 })
  const pair = await readPair(api, P, 'visible')
  raw.log('pane.snapshot', {
    key: fx.key,
    revision: pair.ansi.revision,
    truncated: pair.ansi.truncated,
    attempts: pair.attempts,
    ansiLength: pair.ansi.text.length,
    ansiEscaped: JSON.stringify(pair.ansi.text),
    textEscaped: JSON.stringify(pair.text.text),
  })
  fs.writeFileSync(path.join(RAW_DIR, `b-${fx.key}-snapshot.ansi`), pair.ansi.text)
  fs.writeFileSync(path.join(RAW_DIR, `b-${fx.key}-snapshot.text`), pair.text.text)
  fs.writeFileSync(path.join(RAW_DIR, `b-${fx.key}-fixture.bytes`), bytes)

  // 인스턴스 A: 원본 바이트. 인스턴스 B: herdr 스냅샷. 둘 다 같은 격자.
  const A = makeTerm(COLS, ROWS)
  await write(A, '\x1b[2J\x1b[H')
  await write(A, bytes)
  const B = makeTerm(COLS, ROWS)
  await write(B, pair.ansi.text)

  const ga = grid(A)
  const gb = grid(B)
  // 비교 범위 = 원본에 내용이 있는 행까지. 그 아래는 pane 프롬프트가 들어와 잡음이다.
  let last = -1
  ga.forEach((row, y) => {
    if (rowText(row).trim() !== '') last = y
  })
  const rows = last + 1
  const cmp = compare(ga, gb, { rows })

  // B3: wide char 시작 열이 어긋나면 행이 밀린 것이다.
  const wideCmp = []
  for (let y = 0; y < rows; y++) {
    const wa = wideStarts(ga[y] ?? [])
    const wb = wideStarts(gb[y] ?? [])
    const same =
      wa.length === wb.length && wa.every((c, i) => c.x === wb[i]?.x && c.ch === wb[i]?.ch)
    if (!same) wideCmp.push({ y, a: wa, b: wb })
  }

  const ca = cursor(A)
  const cb = cursor(B)

  R.fixtures[fx.key] = {
    label: fx.label,
    comparedRows: rows,
    cells: cmp.cells,
    B1_textMatch: +(cmp.textMatch * 100).toFixed(2),
    B2_styleMatch: +(cmp.styleMatch * 100).toFixed(2),
    B3_wideMismatchRows: wideCmp.length,
    B3_detail: wideCmp,
    B4_cursor: { a: { x: ca.x, y: ca.y }, b: { x: cb.x, y: cb.y }, match: ca.x === cb.x && ca.y === cb.y },
    revision: pair.ansi.revision,
    truncated: pair.ansi.truncated,
    textDiff: cmp.textDiff,
    styleDiff: cmp.styleDiff,
    rowsA: ga.slice(0, rows).map(rowText),
    rowsB: gb.slice(0, rows).map(rowText),
  }
  const r = R.fixtures[fx.key]
  console.log(`B1 텍스트 ${r.B1_textMatch}%  B2 스타일 ${r.B2_styleMatch}%  B3 밀림행 ${r.B3_wideMismatchRows}  B4 커서 ${r.B4_cursor.match}`)
  console.log('  A:', r.rowsA[0]?.slice(0, 70))
  console.log('  B:', r.rowsB[0]?.slice(0, 70))
  A.dispose()
  B.dispose()

  // alt screen 픽스처는 sleep 600 으로 화면을 잡고 있다. 다음 픽스처 전에 풀어준다.
  if (fx.alt) {
    await api('pane.send_text', { pane_id: P, text: '\x03' })
    await sleep(600)
  }
}

// --- b4: revision 이 변화 감지에 쓸 만한가 ------------------------------
{
  // pane.read 의 revision 과 pane.list(PaneInfo) 의 revision 은 별개 필드다. 둘 다 본다.
  const seen = []
  for (const cmd of ["printf '\\033[2J\\033[Hone\\n'", "printf 'two\\n'", "printf 'three\\n'"]) {
    await run(api, P, cmd, { settleMs: 700 })
    const rd = await readPair(api, P, 'visible')
    const info = (await api('pane.list', {})).panes.find((x) => x.pane_id === P)
    seen.push({
      cmd,
      readRevision: rd.ansi.revision,
      paneInfoRevision: info?.revision ?? null,
      textLen: rd.text.text.length,
    })
  }
  R.revisionProbe = {
    samples: seen,
    // 화면이 세 번 바뀌는 동안 각 revision 이 실제로 움직였는가
    readRevisionChanged: new Set(seen.map((s) => s.readRevision)).size > 1,
    paneInfoRevisionChanged: new Set(seen.map((s) => s.paneInfoRevision)).size > 1,
  }
  console.log('\nrevision 표본:', JSON.stringify(seen))
}

raw.close({ probe: 'b-snapshot', at: new Date().toISOString(), results: R })
process.exit(0)
