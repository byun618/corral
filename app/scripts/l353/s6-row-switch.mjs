// S6 — 행 전환. 행 A→B 전환 10회, 전환→B 의 첫 프레임 표시 p95 ≤ 1000ms.
//
// 통과선 근거 (기준 S6): 뷰 전환은 1초 안에 연속감이 유지된다는 응답성 통칙(RAIL) — 타이핑
// 즉각성(S2)과 다른 급의 행위라 승계 floor 와 별도. 최종 확인은 게이트 ① 사용자 체감.
//
// 오라클: 전환 클릭 시각 → B pane 내용이 xterm 에 write 완료된 시각. B 화면이 실제로 B 의
//   것임을 **내용 마커**로 증명 (A 잔상이면 무효).

import { startApp, attachPane, firstPaneId, herdrRequest, until, sleep, pct, writeRaw } from './lib.mjs'
import { neutralizePrompt } from './fixtures.mjs'

const SWITCHES = 10

async function ensureTwoPanes() {
  let panes = (await herdrRequest('pane.list', {})).panes
  if (panes.length < 2) {
    const ws = (await herdrRequest('workspace.list', {})).workspaces[0]
    await herdrRequest('tab.create', { workspace_id: ws.workspace_id })
    await sleep(800)
    panes = (await herdrRequest('pane.list', {})).panes
  }
  return panes.map((p) => p.pane_id)
}

async function main() {
  const paneIds = await ensureTwoPanes()
  const [a, b] = paneIds
  const app = await startApp({ name: 's6-row-switch' })
  await attachPane(app, a)

  // 각 pane 에 유일 마커 — 화면이 정말 그 pane 인지 증명하는 데 쓴다.
  const markA = `PANEA${Date.now() % 100000}`
  const markB = `PANEB${Date.now() % 100000}`
  await neutralizePrompt(a)
  await herdrRequest('pane.send_text', { pane_id: a, text: `printf '${markA}\\n'\n` })
  await neutralizePrompt(b)
  await herdrRequest('pane.send_text', { pane_id: b, text: `printf '${markB}\\n'\n` })
  await sleep(1000)

  const switches = []
  let stale = 0
  for (let i = 0; i < SWITCHES; i++) {
    const target = i % 2 === 0 ? b : a
    const mark = i % 2 === 0 ? markB : markA
    const otherMark = i % 2 === 0 ? markA : markB
    // 전환 = 그 pane 행을 진짜 클릭.
    const clicked = await app.click(`[data-pane="${target}"]`)
    const clickAt = clicked.at
    const shown = await until(
      async () => {
        const term = await app.termRead()
        if (term === null || term.paneId !== target) return null
        const text = term.lines.join('\n')
        if (!text.includes(mark)) return null // 아직 B 내용 아님
        // B 마커 등장 + 그 시점의 첫 write 완료 (clickAt 이후)
        const w = term.writes.filter((r) => r.paneId === target && r.at >= clickAt).sort((x, y) => x.at - y.at)[0]
        // A 잔상 검사: B 화면에 A 마커가 남아 있으면 무효
        const hasStale = text.includes(otherMark)
        return w ? { writeAt: w.at, hasStale } : null
      },
      { timeoutMs: 3000, everyMs: 10, what: `switch to ${target}` },
    )
    if (!shown.ok) {
      stale += 1
      switches.push({ i, target, latencyMs: null, miss: true })
    } else {
      if (shown.value.hasStale) stale += 1
      switches.push({ i, target, clickAt, writeAt: shown.value.writeAt, latencyMs: shown.value.writeAt - clickAt, staleResidue: shown.value.hasStale })
    }
    await sleep(400)
  }

  const lat = switches.filter((s) => !s.miss && !s.staleResidue).map((s) => s.latencyMs)
  const p50 = pct(lat, 50)
  const p95 = pct(lat, 95)
  const pass = switches.filter((s) => s.miss || s.staleResidue).length === 0 && lat.length === SWITCHES && p95 <= 1000
  const result = {
    at: new Date().toISOString(),
    buildCheck: app.buildCheck,
    panes: { a, b },
    threshold: { p95: 1000, basis: 'RAIL 응답성 통칙 — 뷰 전환 1초 연속감' },
    switches: switches.length,
    validSamples: lat.length,
    p50,
    p95,
    max: lat.length ? Math.max(...lat) : null,
    verdict: pass ? '통과' : '미달',
    raw: switches,
  }
  writeRaw('s6-row-switch.json', result)
  console.log(`\nS6 전환 ${lat.length}/${SWITCHES} · p50 ${p50}ms · p95 ${p95}ms · 잔상/놓침 ${SWITCHES - lat.length} → ${result.verdict}`)
  await app.stop()
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
