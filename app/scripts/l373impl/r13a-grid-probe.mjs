// R13-a 진단 — 같은 창 크기에서 전환 전후 요청 격자가 왜 달라졌나.
//
// S5 재실행(l373/s5-grid.json)이 LIFE-353 r1 과 다른 격자를 냈다: 1000x700 에서 72x46 → 87x39.
// **어디서 갈렸는지**를 가린다: 상자 px 인가, 셀 px 인가, 산식인가.
//   · 상자: `.term-group`(새 분모) 과 `.term-host`(옛 FitAddon 의 parentElement) 의 computed box
//   · 셀: 살아 있는 xterm 의 `_renderService.dimensions.css.cell` vs `measureCellSize()` 오프스크린
//   · 산식: FitAddon 의 scrollBarWidth 보정이 실제로 몇 px 인가
//
// 이 스크립트는 **판정하지 않는다** — 코디네이터에게 물을 근거를 뜬다 (기준서는 얼었다).

import { startApp, attachPane, firstPaneId, settleXterm, sleep, SESSION, writeRaw } from '../l353/lib.mjs'

/**
 * 격리 가드 (L12) — 다만 **막는 축이 다른 엔트리와 다르다.**
 *
 * 이 파일은 `startApp` 을 부르는 엔트리인데 가드가 없었다. 맨손으로 돌리면 `LIFE353_SESSION` 이
 * 기본값 `life353-claude` 로 떨어지고, `l353/lib.mjs` 의 RAW 매핑이 이 런의 `_runs`·`_discarded`
 * 를 **LIFE-353 트리 본체**로 보낸다 — `_discarded/` 에 701건을 쌓은 것과 같은 모양이다.
 * `ISOLATED_PREFIXES` 에 `life353-` 가 있어 세션 가드에도 안 걸린다.
 *
 * 그렇다고 `life373-` 만 받게 하면 **문서화된 길을 막는다** — R13-a 는 LIFE-353 하네스를 그대로
 * 돌리는 자리라 `life353-` 에서 도는 것이 02-kickoff 의 예외로 허용돼 있다. 그래서 막는 것은
 * 접두가 아니라 **"아무도 안 정해 준 기본값으로 떨어지는 것"** 이다: 세션을 **명시**해야 돈다.
 */
if (process.env.LIFE353_SESSION === undefined) {
  throw new Error('거부: LIFE353_SESSION 을 명시해라 — 기본값으로 떨어지면 원자료가 LIFE-353 트리로 샌다 (L12)')
}
if (!SESSION.startsWith('life373-') && !SESSION.startsWith('life353-')) {
  throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
}

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
