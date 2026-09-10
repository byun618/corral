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

// 넓은 표본 — 픽스처에 실제로 나오는 군집 전부 + 경계 사례.
const corpus = [
  ...fs.readFileSync(path.join(APP_DIR, 'scripts/l345/fixtures/02-cjk.sh'), 'utf8').split('\n'),
  'a̐éö̲ combining',
  '텍스트 표현 ❤︎ VS15',
  '🏳️‍🌈 무지개 깃발',
  '𝕏 수학 문자',
]
const clusters = [...new Set(corpus.flatMap((line) => clustersOf(line)))]
const widths = await oracleWidths(clusters)
const disagreements = clusters
  .map((cluster, index) => ({ cluster, oracle: widths[index], shipping: clusterWidth(cluster) }))
  .filter((row) => row.oracle !== row.shipping)

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

const allAgree = table.every((row) => row.agrees) && disagreements.length === 0 && lineRows.every((row) => row.agrees)
console.log('M1 전체', allAgree ? '일치' : `어긋남 ${disagreements.length}`)

writeRaw('13-m1-width.json', {
  measuredAt: new Date().toISOString(),
  oracle: 'python wcwidth (제3 오라클 — herdr 도 xterm.js 도 아니다)',
  segmentation: "Intl.Segmenter(granularity:'grapheme') — 렌더러의 graphemes 애드온과 같은 UAX #29",
  shippingSource: 'app/src/shared/width.ts (esbuild 로 그대로 불러왔다)',
  probes: table,
  corpusClusters: clusters.length,
  corpusDisagreements: disagreements,
  lines: lineRows,
  allAgree,
})
