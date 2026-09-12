// S7ⓔ — frame-to-ansi 폭 함수의 3자 대조 (LIFE-345 M1 재판 방지).
//
// 세 축:
//   ① 내 함수    — vendor/string-width.ts 의 stringWidth (Bun.stringWidth 대체)
//   ② xterm      — term.unicode.getStringCellWidth (렌더러가 실제 렌더에 쓰는 폭, 프로브)
//   ③ 제3자      — npm `string-width`@7 (wcwidth 류 독립 구현)
//
// 이모지·CJK·VS16·ZWJ·국기·반각 카나 말뭉치. S1 이 실제로 밟는 그래핌은 ①==② 여야 한다
// (렌더러와 어긋나면 셀이 밀린다). ③ 은 참고 축 — 세 구현이 갈리는 지점을 드러낸다.
// ｶﾞ(반각 카나+반각 탁점)의 herdr↔xterm 폭 모델 발산(C6)을 여기서 명시적으로 기록한다.

import { startApp, attachPane, firstPaneId, writeRaw } from './lib.mjs'
import { stringWidth as myWidth } from '../../src/main/adapter/internal/vendor/string-width.ts'
import npmWidth from 'string-width'

const CORPUS = [
  { g: 'A', note: 'ASCII' },
  { g: '한', note: '한글 음절' },
  { g: '中', note: 'CJK 한자' },
  { g: '½', note: 'vulgar fraction (narrow)' },
  { g: '©', note: 'copyright (narrow, EAW=A)' },
  { g: '🙂', note: 'emoji (EAW=W)' },
  { g: '🚀', note: 'emoji rocket' },
  { g: '✨', note: 'emoji sparkles (U+2728)' },
  { g: '👩‍💻', note: 'ZWJ sequence (woman technologist)' },
  { g: '🇨🇳', note: 'regional indicator flag (RI 쌍)' },
  { g: '☂️', note: 'VS16 승격 (umbrella + FE0F)' },
  { g: 'ガ', note: '전각 카나 voiced (precomposed)' },
  { g: 'ｶ', note: '반각 카나 (halfwidth)' },
  { g: 'ｶﾞ', note: '★ 반각 카나 + 반각 탁점 — herdr(합=2)↔xterm-graphemes(클러스터) 발산 (C6)' },
  { g: '─', note: 'box drawing horizontal' },
]

async function main() {
  const paneId = await firstPaneId()
  const app = await startApp({ name: 's7-width-oracle' })
  await attachPane(app, paneId)

  const rows = []
  for (const item of CORPUS) {
    const mine = myWidth(item.g)
    const xterm = await app.termCellWidth(item.g)
    const npm = npmWidth(item.g)
    rows.push({
      grapheme: item.g,
      codepoints: [...item.g].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')),
      note: item.note,
      mine,
      xterm,
      npm,
      mineMatchesXterm: mine === xterm,
      allAgree: mine === xterm && xterm === npm,
    })
  }

  // S1 이 밟는 집합 = ｶﾞ(별표) 를 뺀 전부. 그 집합에서 ①==② 가 통과 조건.
  const s1Set = rows.filter((r) => !r.note.startsWith('★'))
  const s1Disagreements = s1Set.filter((r) => !r.mineMatchesXterm)
  const result = {
    at: new Date().toISOString(),
    buildCheck: app.buildCheck,
    axes: { '①mine': 'vendor/string-width.ts', '②xterm': 'unicode.getStringCellWidth', '③npm': 'string-width@7' },
    rows,
    s1RelevantDisagreements: s1Disagreements.length,
    documentedDivergence: rows.filter((r) => r.note.startsWith('★')).map((r) => ({ grapheme: r.grapheme, mine: r.mine, xterm: r.xterm, npm: r.npm })),
    verdict: s1Disagreements.length === 0 ? '통과 (S1 집합에서 ①==②)' : '미달',
  }
  writeRaw('s7-width-oracle.json', result)
  console.log('\n폭 3자 대조:')
  for (const r of rows) {
    console.log(`  ${r.grapheme}\t내=${r.mine} xterm=${r.xterm} npm=${r.npm}\t${r.allAgree ? '전원일치' : r.mineMatchesXterm ? '①=②(≠③)' : '★발산'}\t${r.note}`)
  }
  console.log('\nS1 집합 ①≠② 불일치:', s1Disagreements.length, '→', result.verdict)
  await app.stop()
  process.exit(s1Disagreements.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
