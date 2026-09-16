// R13-a 진단 — 같은 창 크기에서 전환 전후 요청 격자가 왜 달라졌나.
//
// S5 재실행(l373/s5-grid.json)이 LIFE-353 r1 과 다른 격자를 냈다: 1000x700 에서 72x46 → 87x39.
// **어디서 갈렸는지**를 가린다: 상자 px 인가, 셀 px 인가, 산식인가.
//   · 상자: `.term-group`(새 분모) 과 `.term-host`(옛 FitAddon 의 parentElement) 의 computed box
//   · 셀: 살아 있는 xterm 의 `_renderService.dimensions.css.cell` vs `measureCellSize()` 오프스크린
//   · 산식: FitAddon 의 scrollBarWidth 보정이 실제로 몇 px 인가
//
// 이 스크립트는 **판정하지 않는다** — 코디네이터에게 물을 근거를 뜬다 (기준서는 얼었다).

import { startApp, attachPane, firstPaneId, settleXterm, sleep, writeRaw } from '../l353/lib.mjs'

const STEPS = [
  { width: 1000, height: 700 },
  { width: 1360, height: 900 },
  { width: 820, height: 620 },
]

const PROBE = `(() => {
  const group = document.querySelector('[data-term-group]')
  const host = document.querySelector('.term-host')
  const box = (el) => {
    if (el === null) return null
    const s = getComputedStyle(el)
    return {
      computedWidth: s.getPropertyValue('width'),
      computedHeight: s.getPropertyValue('height'),
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(' '),
    }
  }
  const probe = window.corralTermProbe
  const cells = probe ? probe.cell() : { live: null, measured: null }
  const read = probe ? probe.read() : null
  const xtermEl = document.querySelector('.xterm')
  const xs = xtermEl ? getComputedStyle(xtermEl) : null
  return {
    group: box(group),
    host: box(host),
    xtermPadding: xs ? [xs.paddingTop, xs.paddingRight, xs.paddingBottom, xs.paddingLeft].join(' ') : null,
    cell: cells.live,
    cellMeasured: cells.measured,
    size: read ? { cols: read.cols, rows: read.rows } : null,
  }
})()`

const paneId = await firstPaneId()
const app = await startApp({ name: 'r13a-grid-probe' })
await attachPane(app, paneId)
await settleXterm(app)

const steps = []
for (const step of STEPS) {
  await app.resizeWindow(step.width, step.height)
  await sleep(1200)
  const probe = (await app.send({ cmd: 'eval', code: PROBE })).result
  const term = await app.termRead()
  // 옛 산식(FitAddon)을 **지금 상자·지금 셀**에 그대로 먹여 본다 — 산식 차이인지 상자 차이인지.
  const asFit =
    probe.cell === null || probe.host === null
      ? null
      : {
          cols: Math.max(2, Math.floor(Number.parseInt(probe.host.computedWidth, 10) / probe.cell.width)),
          rows: Math.max(1, Math.floor(Number.parseInt(probe.host.computedHeight, 10) / probe.cell.height)),
        }
  steps.push({ window: step, probe, xterm: { cols: term.cols, rows: term.rows }, fitAddon산식: asFit })
  console.log(
    JSON.stringify({ window: `${step.width}x${step.height}`, xterm: `${term.cols}x${term.rows}`, cell: probe.cell, group: probe.group?.computedWidth + '×' + probe.group?.computedHeight, host: probe.host?.computedWidth + '×' + probe.host?.computedHeight, asFit }),
  )
}

writeRaw('r13a-grid-probe.json', { at: new Date().toISOString(), steps })
await app.send({ cmd: 'state' })
process.exit(0)
