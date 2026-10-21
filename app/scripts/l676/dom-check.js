/* global window, document, requestAnimationFrame, getComputedStyle */
// LIFE-676 R3 캡처 회차 — 637 dom-check.js 개작(메모리 = {state, bytes}). 다음 푸시를 받고 두 프레임 뒤, 그 스냅샷(IPC 값)과 세그먼트·패널 DOM 을 맞춘다.
// 서식은 제품 코드를 쓰지 않고 독립 재구현: 세그먼트·패널 머리 = 합 ÷ cpuCoreCount 반올림(0~100) · 행 = 코어당 반올림 % ·
// 메모리 = 1 GiB 이상 x.x GB, 미만 MB 정수, 하한 `≥ x`, 못 재면 `측정 불가`, 행 자체 측정 불가면 `—`.
// 툴팁: 세그먼트 title 첫 줄 = 라벨, 「코어 N개 = 100%」 포함 · 사유 없는 행의 CPU 칸 title = 「CPU — 코어 하나 = 100%」 · 사유 있는 행은 CPU 칸 title 없음(행 사유를 덮지 않음).
// 배치(실제 글꼴): 세그먼트·메모리 열이 한 줄 — 높이가 같은 줄 이름 칸 이하, scrollWidth ≤ clientWidth.
(async () => {
  const s = await new Promise((r) => { const stop = window.corral.onResourceSnapshot((x) => { stop(); r(x) }) })
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const GB = 1024 ** 3, MB = 1024 ** 2
  const cores = s.host.cpuCoreCount
  const rowCpu = (v) => `${Math.round(v)}%`
  const machineCpu = (v) => (cores > 0 ? `${Math.min(100, Math.max(0, Math.round(v / cores)))}%` : '—')
  const bytesText = (b, gbOnly) => (gbOnly || b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / MB)} MB`)
  const memText = (m, gbOnly) => (m.state === 'measured' ? bytesText(m.bytes, gbOnly) : m.state === 'partial' ? `≥ ${bytesText(m.bytes, gbOnly)}` : '측정 불가')
  const reasonOf = (measure) => (measure.state === 'unavailable' ? `측정 불가 — ${measure.reason}` : measure.usage.memory.state === 'partial' ? `메모리 하한 — ${measure.usage.memory.reason}` : measure.usage.memory.state === 'unavailable' ? `메모리 측정 불가 — ${measure.usage.memory.reason}` : null)
  const cells = (m) => (m.state === 'measured' ? [rowCpu(m.usage.cpu), memText(m.usage.memory, false)] : ['—', '—'])
  const sum = (measures) => {
    const ok = measures.filter((m) => m.state === 'measured')
    if (ok.length === 0) return null
    const mems = ok.map((m) => m.usage.memory)
    const counted = mems.filter((m) => m.state !== 'unavailable')
    const bytes = counted.reduce((a, m) => a + m.bytes, 0)
    const lower = counted.some((m) => m.state === 'partial') || counted.length < mems.length
    return { cpu: ok.reduce((a, m) => a + m.usage.cpu, 0), memory: counted.length === 0 ? { state: 'unavailable' } : { state: lower ? 'partial' : 'measured', bytes } }
  }
  const segment = document.querySelector('[data-statusbar-resource]')
  const panel = document.querySelector('[data-statusbar-resource-panel]')
  const mism = []
  const eq = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) mism.push({ label, dom: a, ipc: b }) }
  const expectLabel = s.total === null ? 'CPU — · 메모리 —' : `CPU ${machineCpu(s.total.cpu)} · 메모리 ${memText(s.total.memory, true)}`
  eq('segment text', segment?.textContent, expectLabel)
  const segTitle = segment?.getAttribute('title') ?? ''
  eq('segment title first line', segTitle.split('\n')[0], expectLabel)
  if (!segTitle.includes(`코어 ${cores}개 = 100%`)) mism.push({ label: 'segment title scale', dom: segTitle, ipc: `코어 ${cores}개 = 100%` })
  const lines = []
  const rowCheck = (label, el, measure, name) => {
    const cpuEl = el.querySelector('[data-statusbar-resource-cpu]')
    const memEl = el.querySelector('[data-statusbar-resource-memory]')
    const nameEl = el.querySelector('.statusbar-resource-name')
    eq(`${label} cells`, [cpuEl?.textContent, memEl?.textContent], cells(measure))
    if (name !== undefined) eq(`${label} name`, nameEl?.textContent, name)
    const reason = reasonOf(measure)
    const cpuTitle = cpuEl?.getAttribute('title') ?? null
    const rowTitle = el.getAttribute('title') ?? ''
    if (reason === null) eq(`${label} cpu title`, cpuTitle, 'CPU — 코어 하나 = 100%')
    else {
      eq(`${label} cpu title (사유 있는 행은 없음)`, cpuTitle, null)
      if (!rowTitle.includes(reason) || !rowTitle.includes('CPU — 코어 하나 = 100%')) mism.push({ label: `${label} row title`, dom: rowTitle, ipc: reason })
    }
    const nameH = nameEl?.getBoundingClientRect().height ?? 0
    const memH = memEl?.getBoundingClientRect().height ?? 0
    lines.push({ label, memText: memEl?.textContent, memHeight: memH, nameHeight: nameH, memScroll: memEl?.scrollWidth, memClient: memEl?.clientWidth, cpuTitle, rowTitle: rowTitle || null, reason })
  }
  if (!panel) return { panel: false, mismatches: mism }
  const head = panel.querySelector('.statusbar-resource-title')
  eq('panel head', head?.textContent, expectLabel)
  rowCheck('app', panel.querySelector('[data-statusbar-resource-app]'), s.app, 'corral 앱')
  rowCheck('herdr', panel.querySelector('[data-statusbar-resource-herdr]'), s.herdr)
  const groups = [...panel.querySelectorAll('[data-statusbar-resource-group]')]
  for (const g of groups) {
    const key = g.dataset.statusbarResourceGroup
    const panes = s.panes.filter((p) => p.groupKey === key)
    const headEl = g.querySelector('.statusbar-resource-group-head')
    const total = sum(panes.map((p) => p.measure))
    eq(`group ${key} head cells`, [headEl.querySelector('[data-statusbar-resource-cpu]')?.textContent, headEl.querySelector('[data-statusbar-resource-memory]')?.textContent], total === null ? ['—', '—'] : [rowCpu(total.cpu), memText(total.memory, false)])
    for (const r of g.querySelectorAll('[data-statusbar-resource-row]')) {
      const p = s.panes.find((x) => x.paneId === r.dataset.statusbarResourceRow)
      rowCheck(`row ${p?.paneId}`, r, p.measure, p.title)
    }
  }
  const segBox = segment.getBoundingClientRect()
  const layout = {
    segment: { text: segment.textContent, height: segBox.height, scrollWidth: segment.scrollWidth, clientWidth: segment.clientWidth, lineHeight: getComputedStyle(segment).lineHeight, fontFamily: getComputedStyle(segment).fontFamily, fontSize: getComputedStyle(segment).fontSize },
    memoryCells: lines.map((l) => ({ label: l.label, text: l.memText, height: l.memHeight, nameHeight: l.nameHeight, scrollWidth: l.memScroll, clientWidth: l.memClient })),
  }
  const oneLine = layout.memoryCells.every((c) => c.height <= c.nameHeight + 0.5 && c.scrollWidth <= c.clientWidth) && segment.scrollWidth <= segment.clientWidth
  return { collectedAt: s.collectedAt, at: new Date().toISOString(), cpuCoreCount: cores, total: s.total, expectLabel, segmentTitle: segTitle, panelHead: head?.textContent ?? null, titles: lines.map(({ label, cpuTitle, rowTitle, reason }) => ({ label, cpuTitle, rowTitle, reason })), layout, oneLine, mismatches: mism, states: { app: s.app.state, herdr: s.herdr.state, panes: s.panes.map((p) => ({ id: p.paneId, state: p.measure.state, memory: p.measure.state === 'measured' ? p.measure.usage.memory.state : null })) } }
})()
