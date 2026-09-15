// LIFE-373 스파이크 렌더러 — xterm 인스턴스 N개에 같은 프레임 스트림을 먹이고,
// **xterm 바깥 오라클**로 잰다 (관문 ②):
//   · rAF 하트비트 (performance.now 간격) — 메인 스레드가 실제로 그릴 틈이 있었는가
//   · PerformanceObserver('longtask') — 50ms 이상 스톨
//   · 스케줄러 지각 (예정 시각 대비 실제 발화 시각)
//   · 생산자 카운터 (offered/written/dropped) — 우리가 센다, xterm 이 아니라
// term.write 콜백은 **파싱 완료**이지 페인트 완료가 아니다 — M2 는 그 한계를 안고 읽는다.

const fs = require('node:fs')
const { ipcRenderer } = require('electron')

const config = JSON.parse(fs.readFileSync(process.env.L373_CONFIG, 'utf8'))
const frames = JSON.parse(fs.readFileSync(config.framesFile, 'utf8'))

const TerminalCtor = window.Terminal ?? (window.xterm && window.xterm.Terminal)
const GraphemesCtor =
  window.UnicodeGraphemesAddon ??
  (window.UnicodeGraphemesAddon === undefined && window.addonUnicodeGraphemes
    ? window.addonUnicodeGraphemes.UnicodeGraphemesAddon
    : undefined)

function fail(message) {
  ipcRenderer.send('l373-fail', message)
}

const pct = (values, p) => {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  return +s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))].toFixed(3)
}

function main() {
  if (typeof TerminalCtor !== 'function') return fail('xterm UMD 전역을 못 찾았다')

  const grid = document.getElementById('grid')
  const { cols, rows, count } = config.panes
  const panes = []
  for (let i = 0; i < count; i++) {
    const host = document.createElement('div')
    host.className = 'cell'
    grid.appendChild(host)
    // TerminalPane.tsx 와 같은 설정 — DOM 렌더러(기본), scrollback 0, graphemes 15.
    const term = new TerminalCtor({
      cols,
      rows,
      scrollback: 0,
      cursorBlink: false,
      fontSize: 13,
      fontFamily: 'SF Mono, Menlo, Monaco, monospace',
      theme: { background: '#141718' },
      allowProposedApi: true,
    })
    if (typeof GraphemesCtor === 'function') {
      term.loadAddon(new GraphemesCtor())
      term.unicode.activeVersion = '15-graphemes'
    }
    term.open(host)
    const pane = {
      index: i,
      term,
      host,
      pending: null,
      writing: false,
      cursor: 0,
      offset: (i * 7) % frames.length,
      // M3 에서 "안 바뀌는 pane" 이 늘 쓰는 고정 프레임
      staticFrame: frames[(i * 11) % frames.length],
      offered: 0,
      written: 0,
      dropped: 0,
      skipped: 0,
      bytes: 0,
      writeMs: [],
      queueMs: [],
      renderPasses: 0,
      mutations: 0,
    }
    panes.push(pane)
    // **바깥 오라클 (M1 의 진짜 답)** — term.write 콜백은 파싱 완료일 뿐 페인트가 아니다.
    // DOM 렌더러가 실제로 행 DOM 을 갈아끼운 횟수를 MutationObserver 로 센다. xterm 이
    // 스스로 보고하는 수치가 아니라 브라우저가 관찰한 DOM 변경이다 (관문 ②).
    // 한 태스크 안에서 두 번 그리면 콜백이 합쳐질 수 있다 — 하한값으로 읽는다.
    if (config.observeDom !== false) {
      const rowsEl = host.querySelector('.xterm-rows')
      if (rowsEl !== null) {
        const mo = new MutationObserver((records) => {
          if (!measuring) return
          pane.renderPasses += 1
          pane.mutations += records.length
        })
        mo.observe(rowsEl, { childList: true, subtree: true, characterData: true })
        pane.mo = mo
      }
    }
  }

  // 자연 크기를 재서 창 안에 들어가도록 스케일 (N=8 에서만 1 미만이 된다 — 원자료에 기록).
  const gw = grid.scrollWidth
  const gh = grid.scrollHeight
  const scale = Math.min(1, (window.innerWidth - 2) / Math.max(1, gw), (window.innerHeight - 2) / Math.max(1, gh))
  grid.style.transform = `scale(${scale})`

  // --- 바깥 오라클 -----------------------------------------------------------
  let rafGaps = []
  let rafCount = 0
  let lastRaf = null
  let measuring = false
  const longTasks = []
  let observer = null
  try {
    observer = new PerformanceObserver((list) => {
      if (!measuring) return
      for (const entry of list.getEntries()) longTasks.push(+entry.duration.toFixed(2))
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch (error) {
    // longtask 미지원이면 rAF 간격만으로 간다 — 원자료에 남긴다.
    observer = null
  }
  const rafLoop = (now) => {
    if (lastRaf !== null && measuring) {
      rafGaps.push(+(now - lastRaf).toFixed(3))
      rafCount += 1
    }
    lastRaf = now
    requestAnimationFrame(rafLoop)
  }
  requestAnimationFrame(rafLoop)

  // --- 프레임 제시 (TerminalPane.tsx 의 coalesce 정책 그대로) ------------------
  let running = false
  const nextFrame = (pane) => {
    const f = frames[(pane.cursor + pane.offset) % frames.length]
    pane.cursor += 1
    return f
  }

  const flush = (pane) => {
    if (!running || pane.writing || pane.pending === null) return
    const item = pane.pending
    pane.pending = null
    pane.writing = true
    const t0 = performance.now()
    pane.term.write(item.data, () => {
      pane.writing = false
      if (measuring) {
        const now = performance.now()
        pane.written += 1
        pane.bytes += item.data.length
        pane.writeMs.push(+(now - t0).toFixed(3))
        pane.queueMs.push(+(now - item.offeredAt).toFixed(3))
      }
      if (!running) return
      if (config.mode === 'saturated') offer(pane, nextFrame(pane))
      else flush(pane)
    })
  }

  const offer = (pane, data) => {
    if (!running) return
    if (measuring) {
      pane.offered += 1
      // 최신 프레임만 남긴다 — 앞선 보류분은 드랍 (production 정책)
      if (pane.pending !== null) pane.dropped += 1
    }
    pane.pending = { data, offeredAt: performance.now() }
    flush(pane)
  }

  // --- 스케줄러 --------------------------------------------------------------
  const lateness = []
  let tickIndex = 0
  let tickStart = 0
  let timer = null

  const paced = () => {
    if (!running) return
    const now = performance.now()
    if (measuring) lateness.push(+(now - (tickStart + tickIndex * config.paceMs)).toFixed(3))
    const active = config.activePanes ?? panes.length
    for (const pane of panes) {
      const changed = pane.index < active
      if (!changed && config.skip === true) {
        if (measuring) pane.skipped += 1
        continue
      }
      offer(pane, changed ? nextFrame(pane) : pane.staticFrame)
    }
    tickIndex += 1
    const target = tickStart + tickIndex * config.paceMs
    timer = setTimeout(paced, Math.max(0, target - performance.now()))
  }

  const start = () => {
    running = true
    if (config.mode === 'saturated') {
      for (const pane of panes) offer(pane, nextFrame(pane))
    } else if (config.mode === 'paced') {
      tickStart = performance.now()
      tickIndex = 0
      paced()
    }
    // mode 'idle' — 아무 프레임도 안 먹인다 (rAF 바닥값·상주 비용 대조군)
  }

  const resetCounters = () => {
    for (const pane of panes) {
      pane.offered = 0
      pane.written = 0
      pane.dropped = 0
      pane.skipped = 0
      pane.bytes = 0
      pane.writeMs = []
      pane.queueMs = []
      pane.renderPasses = 0
      pane.mutations = 0
    }
    rafGaps = []
    rafCount = 0
    longTasks.length = 0
    lateness.length = 0
  }

  start()
  setTimeout(() => {
    resetCounters()
    if (config.mode === 'paced') {
      tickStart = performance.now()
      tickIndex = 0
    }
    measuring = true
    const measureStart = performance.now()
    ipcRenderer.send('l373-mark', 'measure_start')
    setTimeout(() => {
      const measureEnd = performance.now()
      measuring = false
      running = false
      ipcRenderer.send('l373-mark', 'measure_end')
      if (timer !== null) clearTimeout(timer)
      if (observer !== null) observer.disconnect()
      for (const pane of panes) if (pane.mo) pane.mo.disconnect()
      const elapsedMs = measureEnd - measureStart
      const perPane = panes.map((pane) => ({
        index: pane.index,
        offered: pane.offered,
        written: pane.written,
        dropped: pane.dropped,
        skipped: pane.skipped,
        bytes: pane.bytes,
        writtenPerSec: +((pane.written / elapsedMs) * 1000).toFixed(2),
        renderPasses: pane.renderPasses,
        renderPassesPerSec: +((pane.renderPasses / elapsedMs) * 1000).toFixed(2),
        mutations: pane.mutations,
        writeMs: { p50: pct(pane.writeMs, 50), p95: pct(pane.writeMs, 95), max: pct(pane.writeMs, 100) },
        queueMs: { p50: pct(pane.queueMs, 50), p95: pct(pane.queueMs, 95), max: pct(pane.queueMs, 100) },
        // 살아 있었다는 증거 (판별자 아님) — 마지막 상태줄 일부
        lastRow: pane.term.buffer.active.getLine(rows - 1)?.translateToString(true).slice(0, 40) ?? null,
      }))
      const allWrite = panes.flatMap((p) => p.writeMs)
      const allQueue = panes.flatMap((p) => p.queueMs)
      const totalWritten = perPane.reduce((a, b) => a + b.written, 0)
      const totalOffered = perPane.reduce((a, b) => a + b.offered, 0)
      const totalDropped = perPane.reduce((a, b) => a + b.dropped, 0)
      ipcRenderer.send('l373-result', {
        config,
        elapsedMs: +elapsedMs.toFixed(1),
        scale: +scale.toFixed(4),
        naturalGrid: { width: gw, height: gh },
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        totals: {
          offered: totalOffered,
          written: totalWritten,
          dropped: totalDropped,
          skipped: perPane.reduce((a, b) => a + b.skipped, 0),
          bytes: perPane.reduce((a, b) => a + b.bytes, 0),
          writtenPerSec: +((totalWritten / elapsedMs) * 1000).toFixed(2),
          perPaneWrittenPerSec: +((totalWritten / panes.length / elapsedMs) * 1000).toFixed(2),
          bytesPerSec: Math.round((perPane.reduce((a, b) => a + b.bytes, 0) / elapsedMs) * 1000),
          dropRate: totalOffered === 0 ? null : +(totalDropped / totalOffered).toFixed(4),
          renderPasses: perPane.reduce((a, b) => a + b.renderPasses, 0),
          perPaneRenderPassesPerSec: +(
            (perPane.reduce((a, b) => a + b.renderPasses, 0) / panes.length / elapsedMs) * 1000
          ).toFixed(2),
        },
        writeMs: { p50: pct(allWrite, 50), p95: pct(allWrite, 95), max: pct(allWrite, 100), n: allWrite.length },
        queueMs: { p50: pct(allQueue, 50), p95: pct(allQueue, 95), max: pct(allQueue, 100), n: allQueue.length },
        raf: {
          callbacks: rafCount,
          perSec: +((rafCount / elapsedMs) * 1000).toFixed(2),
          gapMs: { p50: pct(rafGaps, 50), p95: pct(rafGaps, 95), max: pct(rafGaps, 100) },
        },
        longTasks: {
          supported: observer !== null,
          count: longTasks.length,
          totalMs: +longTasks.reduce((a, b) => a + b, 0).toFixed(1),
          p95Ms: pct(longTasks, 95),
          maxMs: pct(longTasks, 100),
        },
        schedulerLatenessMs:
          lateness.length === 0
            ? null
            : { p50: pct(lateness, 50), p95: pct(lateness, 95), max: pct(lateness, 100) },
        perPane,
      })
    }, config.measureMs)
  }, config.warmupMs)
}

try {
  main()
} catch (error) {
  fail(String(error && error.stack ? error.stack : error))
}
