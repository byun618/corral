// T7 (폭) — **herdr 의 폭 모델과 xterm.js 의 폭 모델이 어긋나는 자리를 직접 재고**, 유니코드 모드
// 셋 중 하나를 실측으로 고른다.
//
// ## 왜 픽스처 비교(m1)만으로는 부족한가
//
// m1 에서 CJK 픽스처가 100% 로 맞았다. 그건 그 픽스처의 각 행이 **글자를 이어 쓴 것뿐**이라
// 폭이 달라도 문자 순서가 같아서다. 재생 정합성이 깨지는 자리는 따로 있다 (분석 ⓖ6):
// herdr 가 자기 격자에서 화면을 되만들 때 **칸 사이를 공백으로 메운다.** 그 공백 개수가
// herdr 의 폭 모델로 정해진다. xterm 이 같은 글자를 다르게 세면, 그 뒤 내용이 통째로 밀린다.
//
// ## 그래서 이렇게 잰다
//
// pane 에서 `<글자>` 를 쓰고 곧바로 `CSI 40 G` 로 **40열로 절대 이동**한 뒤 `|` 를 찍는다.
//   - 진실: `|` 는 화면 40열(0-기준 39)에 있다
//   - herdr 스냅샷: `<글자>` + (39 − herdr폭) 개의 공백 + `|`
//   - corral 화면: xterm 이 `<글자>` 를 자기 폭으로 그리므로 `|` 는 (xterm폭 + 39 − herdr폭) 열
// 즉 **`|` 의 열 번호 − 39 = xterm폭 − herdr폭** 이다. 0 이면 두 모델이 같다.
//
// 이 측정을 유니코드 모드 3종에서 각각 돌리고, 화면 스크린샷도 모드마다 남긴다 (관문 ④).

import { RAW_DIR, request, run, sleep, startApp, tidySession, writeRaw } from './lib.mjs'
import fs from 'node:fs'
import path from 'node:path'

/** 재는 글자들. 앞의 셋은 CJK·전각(필수 통과선), 뒤의 넷이 이모지·ZWJ(선택지가 갈리는 자리). */
const SAMPLES = [
  { key: 'hangul', label: '한글 한 글자', literal: '한', expect: 2 },
  { key: 'hanja', label: '한자', literal: '漢', expect: 2 },
  { key: 'boxdraw', label: '박스 문자', literal: '─', expect: 1 },
  { key: 'emoji', label: '단일 이모지', literal: '🚀', expect: 2 },
  { key: 'flag', label: '국기 (RI 쌍)', literal: '🇰🇷', expect: 2 },
  { key: 'zwj', label: 'ZWJ 가족', literal: '👨‍👩‍👧', expect: 2 },
  { key: 'vs16', label: 'VS16 하트', literal: '❤️', expect: 2 },
]

/**
 * **2회차 리뷰 G4 가 연 자리** — 판정 표본(위 7종) 밖의 글자들. 통과선은 위 7종 그대로 두고
 * (기준은 freeze 됐다) 이쪽은 근거로만 싣는다.
 *
 * `width.ts` 의 범위표를 UAX #11 로 갈아 끼웠으니 **렌더러가 실제로 그리는 폭**과 맞는지
 * 제품 경로에서 확인해야 한다. 헤드리스 xterm 은 astral 글자를 전부 1로 보고해 못 믿는다
 * (1차 리뷰 §0.1 · 이번에 다시 확인: 🇰🇷 도 1로 준다) — 그래서 **띄운 앱의 격자**에서 읽는다.
 */
const EXTRA_SAMPLES = [
  { key: 'watch', label: 'BMP wide 기호 ⌚', literal: '⌚', uax11: 2 },
  { key: 'star', label: 'BMP wide 기호 ⭐', literal: '⭐', uax11: 2 },
  { key: 'check', label: 'BMP wide 기호 ✅', literal: '✅', uax11: 2 },
  { key: 'thermometer', label: '1칸인 기호 🌡', literal: '🌡', uax11: 1 },
  { key: 'loneRI', label: '홀로 있는 지역표시자 🇰', literal: '🇰', uax11: 1 },
]

const MARK_COL = 40 // 1-기준. 0-기준으로는 39.
const MODES = ['6', '11', 'graphemes']

const paneId = await tidySession()

// 표본을 화면에 한 줄씩 그린다. 각 줄: <글자> → CUP 40열 → '|'
const ALL_SAMPLES = [...SAMPLES, ...EXTRA_SAMPLES]
const lines = ALL_SAMPLES.map((sample) => `printf '%s\\033[${MARK_COL}G|\\n' '${sample.literal}'`).join('; ')
await run(paneId, `clear; ${lines}`, { settleMs: 1500 })

// herdr 가 실제로 준 스냅샷 원문을 그대로 남긴다 (근거의 1차 자료).
const snapshot = await request('pane.read', {
  pane_id: paneId,
  source: 'visible',
  format: 'ansi',
  strip_ansi: false,
})
fs.mkdirSync(path.join(RAW_DIR, 'width'), { recursive: true })
fs.writeFileSync(path.join(RAW_DIR, 'width', 'snapshot.ansi'), snapshot.read.text)

/** herdr 가 그 글자를 몇 칸으로 셌나 — 스냅샷의 `|` 앞 공백 수로 역산한다. */
function herdrWidthOf(line) {
  const bar = line.indexOf('|')
  if (bar === -1) return null
  let spaces = 0
  for (let i = bar - 1; i >= 0 && line[i] === ' '; i--) spaces += 1
  return MARK_COL - 1 - spaces
}

const snapshotLines = snapshot.read.text.split(/\r?\n/)
const herdrWidths = {}
ALL_SAMPLES.forEach((sample, index) => {
  herdrWidths[sample.key] = herdrWidthOf(snapshotLines[index] ?? '')
})
console.log('herdr 폭', JSON.stringify(herdrWidths))

const app = await startApp({ name: 'width' })
await sleep(1200)
await app.selectPane(paneId)
await sleep(2500)

const byMode = {}
for (const mode of MODES) {
  const set = await app.send({ cmd: 'term-unicode', mode })
  // 모드를 바꿔도 **이미 그려진 셀은 다시 안 잰다.** 다시 붙여 화면을 처음부터 칠하게 한다.
  await app.selectPane(null)
  await sleep(400)
  await app.selectPane(paneId)
  await sleep(2200)

  const dump = (await app.dump()).dump
  if (!dump?.ok) throw new Error('term-dump 실패')
  const shot = await app.shot(`t7-${mode}`)

  /** 격자 한 줄에서 `|` 열과 첫 셀 폭을 읽는다 — 표본 하나의 측정값. */
  const readRow = (sample, index) => {
    const cells = dump.grid[index] ?? []
    let barColumn = null
    for (let x = 0; x < dump.cols; x++) {
      if (cells[x]?.ch === '|') {
        barColumn = x
        break
      }
    }
    const first = cells[0]
    return {
      label: sample.label,
      literal: sample.literal,
      herdrWidth: herdrWidths[sample.key],
      // xterm 이 첫 셀에 매긴 폭. 격자에 직접 찍힌 값이라 추정이 아니다.
      xtermCellWidth: first?.w ?? null,
      xtermChars: first?.ch ?? '',
      barColumn,
      // 0 이면 두 폭 모델이 같아 재생이 어긋나지 않는다. 양수면 그만큼 오른쪽으로 밀린 것이다.
      shift: barColumn === null ? null : barColumn - (MARK_COL - 1),
      expectedWidth: sample.expect ?? sample.uax11,
    }
  }

  const rows = {}
  SAMPLES.forEach((sample, index) => {
    rows[sample.key] = readRow(sample, index)
  })
  // 판정 표본 밖 — `width.ts` 의 새 범위표가 **렌더러와 같은 값**인지 보는 자리 (G4).
  const extraRows = {}
  EXTRA_SAMPLES.forEach((sample, index) => {
    const row = readRow(sample, SAMPLES.length + index)
    extraRows[sample.key] = { ...row, uax11: sample.uax11, matchesUax11: row.xtermCellWidth === sample.uax11 }
  })
  byMode[mode] = {
    activeVersion: set.active,
    // 모드가 **실제로 렌더러에 먹었는지**를 dump 가 다시 확인한다 (설정 응답만 믿지 않는다).
    activeVersionAtDump: dump.unicodeVersion,
    shot: shot.file,
    rows,
    extraRows,
    shiftedSamples: Object.values(rows).filter((row) => row.shift !== 0).length,
    cjkShifted: ['hangul', 'hanja', 'boxdraw'].filter((key) => rows[key].shift !== 0).length,
  }
  console.log(
    'mode',
    mode,
    'G4 표본 렌더러 폭',
    JSON.stringify(Object.fromEntries(Object.entries(extraRows).map(([k, v]) => [k, v.xtermCellWidth]))),
  )
  console.log(
    'mode',
    mode,
    '→',
    set.active,
    'shift',
    JSON.stringify(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.shift]))),
  )
}

writeRaw('11-t7-width.json', {
  measuredAt: new Date().toISOString(),
  paneId,
  method: `pane 에서 <글자> + CSI ${MARK_COL} G + '|' 를 찍고, herdr 스냅샷의 공백 수와 렌더러 격자의 '|' 열을 각각 읽는다`,
  markColumn0Based: MARK_COL - 1,
  herdrWidths,
  snapshotFile: 'width/snapshot.ansi',
  byMode,
})
await app.stop()
process.exit(0)
