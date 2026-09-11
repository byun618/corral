// M1 (폭 표) — main 의 `displayWidth` 가 렌더러·herdr 와 같은 규칙인지 **제3 오라클로 확인**한다.
//
// 왜 필요한가: main 은 이 함수로 격자의 열 수를 정하고, 렌더러는 xterm 의 graphemes 애드온으로
// 같은 글자를 그린다. 두 규칙이 어긋나면 그 차이만큼 행이 밀리거나 **잘린다** — 프레임이
// autowrap 을 끄고 그리기 때문이다. 1차 구현은 코드포인트마다 세는 근사여서 `👨‍👩‍👧` 를 6,
// `❤️` 를 1로 셌다 (3자 리뷰 전원 지적, 판정 M1).
//
// 오라클은 `wcwidth`(파이썬, herdr 도 xterm 도 아니다). 군집 자르기는 `Intl.Segmenter` 다.
// 이 스크립트는 앱을 안 띄운다 — 순수 함수 대조라 herdr 가 필요 없다.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_DIR, clustersOf, oracleWidths, writeRaw } from './lib.mjs'

/** `app/src/shared/width.ts` 를 그대로 불러온다 — 옮겨 적으면 대조가 아니라 창작이다. */
async function loadShippingWidth() {
  const source = path.join(APP_DIR, 'src/shared/width.ts')
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l345-width-')), 'width.mjs')
  await new Promise((resolve, reject) => {
    execFile(
      path.join(APP_DIR, 'node_modules/.bin/esbuild'),
      [source, '--format=esm', '--outfile=' + out],
      (error) => (error ? reject(error) : resolve()),
    )
  })
  return import(out)
}

const { clusterWidth, displayWidth } = await loadShippingWidth()

// T7 이 herdr 에게 직접 물어 본 7종 (11-t7-width.json 과 같은 표본).
const PROBES = [
  { key: 'hangul', literal: '한' },
  { key: 'hanja', literal: '漢' },
  { key: 'boxdraw', literal: '─' },
  { key: 'emoji', literal: '🚀' },
  { key: 'flag', literal: '🇰🇷' },
  { key: 'zwj', literal: '👨‍👩‍👧' },
  { key: 'vs16', literal: '❤️' },
]

const herdrWidths = (() => {
  const file = path.join(APP_DIR, '../specs/LIFE-345-terminal-view/raw/claude/11-t7-width.json')
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8')).herdrWidths ?? null
})()

const probeWidths = await oracleWidths(PROBES.map((probe) => probe.literal))
const table = PROBES.map((probe, index) => ({
  ...probe,
  oracle: probeWidths[index],
  shipping: clusterWidth(probe.literal),
  herdr: herdrWidths?.[probe.key] ?? null,
  agrees: probeWidths[index] === clusterWidth(probe.literal),
}))
for (const row of table) {
  console.log('M1', row.key, 'oracle', row.oracle, 'shipping', row.shipping, 'herdr', row.herdr, row.agrees ? 'OK' : '어긋남')
}

/**
 * **2회차 리뷰 G4 가 뚫고 들어온 구간.** 1차 말뭉치(CJK 픽스처 + 결합문자·VS15·깃발·수학문자)에
 * 이 글자들이 한 자도 없어서, `isWide` 범위표가 ⌚⭐⚡ 를 1칸으로 세는 것을 아무도 못 잡았다.
 * 과소는 **그 행에서 글자를 자른다** — CI 로그·에이전트 TUI 에 흔한 글자다.
 *
 * 그래서 말뭉치에 박는다. 세 갈래를 같이 넣어 한쪽으로 치우치지 않게 한다:
 *   ① BMP wide 기호 21종 (옛 표가 과소로 셌다)  ② 실제로 1칸인 기호들 (옛 표가 과대로 셌다)
 *   ③ 홀로 있는 지역표시자 (쌍이 아니면 1칸이다)
 */
const WIDE_SYMBOLS = [
  '⌚⌛⏰⏳◾☔☕♈⚡⚽⛄⛔✅✊✨❌❗➕⬛⭐⭕ BMP wide 기호',
  '🌡🖥🕹🗺🛠〿 실제로 1칸인 기호',
  '🀄🃏🆎🈚🉐 astral 카드·표의문자 기호',
  '🇰 홀로 있는 지역표시자',
]

// 넓은 표본 — 픽스처에 실제로 나오는 군집 전부 + 경계 사례.
const corpus = [
  ...fs.readFileSync(path.join(APP_DIR, 'scripts/l345/fixtures/02-cjk.sh'), 'utf8').split('\n'),
  'a̐éö̲ combining',
  '텍스트 표현 ❤︎ VS15',
  '🏳️‍🌈 무지개 깃발',
  '𝕏 수학 문자',
  ...WIDE_SYMBOLS,
]
const clusters = [...new Set(corpus.flatMap((line) => clustersOf(line)))]
const widths = await oracleWidths(clusters)
/**
 * **오라클과 갈리는 것이 언제나 구현의 잘못은 아니다.**
 *
 * 홀로 있는 지역표시자(`🇰`)는 `wcwidth` 가 2, UAX #11 은 N(1), 그리고 **제품 렌더러(xterm
 * graphemes)가 실제로 그리는 폭은 1** 이다 (`11-t7-width.json` → `byMode.graphemes.extraRows.loneRI`,
 * 띄운 앱의 격자에서 읽은 값). `width.ts` 의 존재 이유가 *렌더러와 같은 폭을 예측하는 것*이므로
 * 이 자리에서는 렌더러를 따른다 — 오라클을 따르면 없는 칸을 하나 더 잡아 오른쪽에 빈 열이 생긴다.
 *
 * 그래서 이 한 줄은 **설명된 어긋남**으로 따로 세고 판정에서 뺀다. 설명 없는 어긋남은 그대로 실패다.
 */
const EXPLAINED = {
  '🇰': '홀로 있는 지역표시자 — wcwidth 2 / UAX #11 1 / 제품 렌더러 1. 렌더러를 따른다 (11-t7-width.json → extraRows.loneRI)',
}

const allDisagreements = clusters
  .map((cluster, index) => ({ cluster, oracle: widths[index], shipping: clusterWidth(cluster) }))
  .filter((row) => row.oracle !== row.shipping)
const explainedDisagreements = allDisagreements
  .filter((row) => EXPLAINED[row.cluster] !== undefined)
  .map((row) => ({ ...row, why: EXPLAINED[row.cluster] }))
const disagreements = allDisagreements.filter((row) => EXPLAINED[row.cluster] === undefined)
for (const row of explainedDisagreements) console.log('M1 설명된 어긋남', row.cluster, 'oracle', row.oracle, 'shipping', row.shipping)

// 줄 단위 — 격자 열 수를 정하는 것은 군집이 아니라 줄의 합이다.
const lines = fs
  .readFileSync(path.join(APP_DIR, 'scripts/l345/fixtures/02-cjk.sh'), 'utf8')
  .split('\n')
  .filter((line) => line.startsWith('printf'))
const lineRows = []
for (const line of lines) {
  const text = line.replace(/^printf '/, '').replace(/\\n'$/, '')
  const oracle = (await oracleWidths(clustersOf(text))).reduce((sum, value) => sum + value, 0)
  lineRows.push({ text, oracle, shipping: displayWidth(text), agrees: oracle === displayWidth(text) })
}
for (const row of lineRows) console.log('M1 줄', row.oracle, row.shipping, row.agrees ? 'OK' : '어긋남', row.text.slice(0, 30))

// --- 제2 대조: **렌더러가 실제로 쓰는 엔진** (xterm + graphemes 애드온) ---------------
//
// `wcwidth` 는 제3자라 좋은 오라클이지만 **화면을 그리는 것은 xterm** 이다. `width.ts` 의 존재
// 이유가 "렌더러와 같은 규칙"이므로 그쪽과도 직접 맞춰 본다 (2회차 리뷰 N5 — "같은 규격이지
// 같은 자는 아니다"). 헤드리스는 astral 이모지 폭을 못 믿는 전례가 있어(1차 리뷰 §0.1)
// BMP 만 판정에 쓰고 astral 은 값만 남긴다.
const xtermWidths = await (async () => {
  // CJS 패키지라 기본 내보내기 한 겹을 벗겨야 생성자가 나온다.
  const headless = (await import('@xterm/headless')).default
  const graphemes = (await import('@xterm/addon-unicode-graphemes')).default
  const term = new headless.Terminal({ cols: 200, rows: 4, allowProposedApi: true })
  const addon = new graphemes.UnicodeGraphemesAddon()
  term.loadAddon(addon)
  term.unicode.activeVersion = '15-graphemes'
  const widthOf = (cluster) =>
    new Promise((resolve) => {
      term.reset()
      term.write(cluster, () => resolve(term.buffer.active.getLine(0)?.getCell(0)?.getWidth() ?? null))
    })
  const out = {}
  for (const cluster of clusters) out[cluster] = await widthOf(cluster)
  return out
})()

const isAstral = (cluster) => (cluster.codePointAt(0) ?? 0) > 0xffff
const xtermRows = clusters.map((cluster, index) => ({
  cluster,
  oracle: widths[index],
  shipping: clusterWidth(cluster),
  xterm: xtermWidths[cluster],
  astral: isAstral(cluster),
}))
const xtermDisagreements = xtermRows.filter((row) => !row.astral && row.xterm !== null && row.xterm !== row.shipping)
console.log('M1 xterm 대조', `${clusters.length}군집 · BMP 어긋남 ${xtermDisagreements.length}`)
for (const row of xtermDisagreements.slice(0, 10)) {
  console.log('M1 xterm 어긋남', row.cluster, 'xterm', row.xterm, 'shipping', row.shipping, 'oracle', row.oracle)
}

const allAgree =
  table.every((row) => row.agrees) &&
  disagreements.length === 0 &&
  lineRows.every((row) => row.agrees) &&
  xtermDisagreements.length === 0
console.log('M1 전체', allAgree ? '일치' : `어긋남 ${disagreements.length + xtermDisagreements.length}`)

writeRaw('13-m1-width.json', {
  measuredAt: new Date().toISOString(),
  oracle: 'python wcwidth (제3 오라클 — herdr 도 xterm.js 도 아니다)',
  segmentation: "Intl.Segmenter(granularity:'grapheme') — 렌더러의 graphemes 애드온과 같은 UAX #29",
  shippingSource: 'app/src/shared/width.ts (esbuild 로 그대로 불러왔다)',
  probes: table,
  corpusClusters: clusters.length,
  corpusDisagreements: disagreements,
  explainedDisagreements,
  /** G4 가 뚫은 구간을 말뭉치에 박았다 — 같은 구멍이 다시 나면 여기서 걸린다. */
  wideSymbolCorpus: WIDE_SYMBOLS,
  wideSymbolRows: xtermRows.filter((row) => WIDE_SYMBOLS.join('').includes(row.cluster)),
  xtermSource: '@xterm/headless 6.0.0 + addon-unicode-graphemes (렌더러가 쓰는 엔진)',
  xtermDisagreements,
  lines: lineRows,
  allAgree,
})
