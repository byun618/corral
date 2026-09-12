// S5 — 격자 수렴. corral 창 리사이즈 3단계 × fixture 1종 — 최종 pane.innerRect == xterm cols×rows,
// 수렴까지 요청 ≤ 3회, 수렴 후 잉여 리페인트 0.
//
// 오라클 (기준 S5): surface 의 innerRect(서버 응답) vs xterm 실제 크기. 요청 횟수는 하네스가
//   센 client.resize 호출 수 — 벤더가 남기는 "resize request" 디버그 로그(vendor 수정 ③)로 센다.
//   innerRect 는 벤더 "surface" 디버그 로그가 준다.

import { startApp, attachPane, firstPaneId, settleXterm, until, sleep, writeRaw } from './lib.mjs'
import { FIXTURES } from './fixtures.mjs'

const STEPS = [
  { width: 1000, height: 700 },
  { width: 1360, height: 900 },
  { width: 820, height: 620 },
]

/** app.ndjson 에서 벤더 디버그 로그(resize request / surface)를 시간순으로. */
function vendorEvents(app, sinceMs) {
  return app
    .entries()
    .filter((e) => e.tag === 'vendor.debug' && e.at >= sinceMs)
}

async function main() {
  const paneId = await firstPaneId()
  const app = await startApp({ name: 's5-grid' })
  await attachPane(app, paneId)
  await FIXTURES.scroll.setup(paneId)
  await settleXterm(app)

  const steps = []
  let prevSize = null
  for (const step of STEPS) {
    const since = Date.now()
    const before = await app.termRead()
    prevSize = `${before.cols}x${before.rows}`
    await app.resizeWindow(step.width, step.height)
    // 수렴까지 기다린다: 최신 surface 의 innerRect == xterm 크기 이고, 이전 단계 크기에서
    // 실제로 바뀌었을 때. (창 리사이즈가 전파되기 전 "이미 안정"인 옛 크기를 잡지 않게)
    let last = null
    let stable = 0
    const settled = await until(
      async () => {
        const term = await app.termRead()
        const size = `${term.cols}x${term.rows}`
        const surfaces = vendorEvents(app, since).filter((e) => e.message === 'surface')
        const inner = surfaces.length ? surfaces[surfaces.length - 1].innerRect : null
        if (size === last) stable += 1
        else {
          stable = 0
          last = size
        }
        // 수렴 = 크기가 2회 연속 같고, 서버 innerRect 가 그 크기와 일치.
        if (stable >= 2 && inner === size) return term
        return null
      },
      { timeoutMs: 10000, everyMs: 150, what: 'grid converge' },
    )
    await sleep(600) // 수렴 후 잉여 프레임을 관측할 여유
    const term = settled.value ?? (await app.termRead())
    const events = vendorEvents(app, since)
    const resizeRequests = events.filter((e) => e.message === 'resize request')
    const surfaces = events.filter((e) => e.message === 'surface')
    const lastSurface = surfaces[surfaces.length - 1]
    // 수렴 후 잉여 리페인트: 마지막 resize request 이후에도 크기가 계속 바뀐 surface 가 있나
    const lastReqAt = resizeRequests.length ? resizeRequests[resizeRequests.length - 1].at : since
    const framesAfterConverge = surfaces.filter((e) => e.at > lastReqAt + 600)
    const innerRect = lastSurface ? lastSurface.innerRect : null // "WxH"
    const xtermSize = `${term.cols}x${term.rows}`
    steps.push({
      window: step,
      xtermSize,
      innerRect,
      resizeRequestCount: resizeRequests.length,
      match: innerRect === xtermSize,
      requestsWithinLimit: resizeRequests.length <= 3,
      surplusAfterConverge: framesAfterConverge.length,
    })
    console.log(`  창 ${step.width}x${step.height} → xterm ${xtermSize} · innerRect ${innerRect} · 요청 ${resizeRequests.length}회 · 수렴후프레임 ${framesAfterConverge.length}`)
  }

  const pass = steps.every((s) => s.match && s.requestsWithinLimit && s.surplusAfterConverge === 0)
  const result = { at: new Date().toISOString(), buildCheck: app.buildCheck, steps, verdict: pass ? '통과' : '미달' }
  writeRaw('s5-grid.json', result)
  console.log('\nS5 →', result.verdict)
  await app.stop()
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
