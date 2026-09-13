// S1 — 셀 일치. fixture 3종 × 5회, 정착 화면의 텍스트·행 배치 불일치 0.
//
// 오라클 (기준 S1): 제3 오라클 = control 소켓 pane.read (stream 과 다른 소켓·다른 프로토콜)
// vs xterm 버퍼 실물(buffer.getLine, 렌더러 프로브). 벤더 frame 데이터는 판별자로 안 쓴다.
//
// 정착: herdr 화면이 멎고(settleHerdr) xterm 프레임이 멎은(settleXterm) 뒤, 둘을 한 번씩
// 더 떠서 비교한다. 전체 리페인트라 정착 화면이면 같은 프레임을 본다.

import {
  startApp,
  attachPane,
  firstPaneId,
  settleHerdr,
  settleXterm,
  normalizeLines,
  diffScreen,
  sleep,
  writeRaw,
} from './lib.mjs'
import { FIXTURES, assertAltScreen } from './fixtures.mjs'

const ROUNDS = 5

async function main() {
  const paneId = await firstPaneId()
  const app = await startApp({ name: 's1-cell-match' })
  const attach = await attachPane(app, paneId)

  const perFixture = []
  for (const fixture of Object.values(FIXTURES)) {
    const rounds = []
    for (let round = 1; round <= ROUNDS; round++) {
      await fixture.setup(paneId)
      // TUI 는 알트 진입을 herdr 쪽 값으로 먼저 확인 (검증 규칙)
      let altCheck = null
      if (fixture.key === 'tui') {
        altCheck = await assertAltScreen(paneId)
        if (!altCheck.alt) console.error(`  [${fixture.key} r${round}] 알트 미확인`, altCheck)
      }
      const herdrSettled = await settleHerdr(paneId)
      const xtermSettled = await settleXterm(app)
      const term = xtermSettled.term
      const mismatches = diffScreen(herdrSettled.lines, term.lines)
      rounds.push({
        round,
        herdrSettleMs: herdrSettled.ms,
        xtermSettleMs: xtermSettled.ms,
        xtermSize: `${term.cols}x${term.rows}`,
        alt: altCheck?.alt ?? null,
        mismatchRows: mismatches.length,
        mismatches: mismatches.slice(0, 8),
      })
      console.log(`  [${fixture.key}] r${round}: 불일치 ${mismatches.length}행 (herdr ${herdrSettled.ms}ms · xterm ${xtermSettled.ms}ms)`)
    }
    perFixture.push({ fixture: fixture.key, label: fixture.label, rounds })
  }

  const totalMismatch = perFixture.reduce(
    (sum, f) => sum + f.rounds.reduce((s, r) => s + r.mismatchRows, 0),
    0,
  )
  const result = {
    at: new Date().toISOString(),
    buildCheck: app.buildCheck,
    paneId,
    attach,
    rounds: ROUNDS,
    perFixture,
    totalMismatchRows: totalMismatch,
    verdict: totalMismatch === 0 ? '통과' : '미달',
  }
  writeRaw('s1-cell-match.json', result)
  console.log('\nS1 총 불일치 행:', totalMismatch, '→', result.verdict)
  await app.stop()
  process.exit(totalMismatch === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
