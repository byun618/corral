/* global window, document, requestAnimationFrame */
// R4 — 다음 푸시를 받은 뒤 그 스냅샷(IPC 값)과 패널 DOM 을 맞춘다. 서식은 독립 재구현(cpu = 반올림 %, 메모리 = 1GB 이상 x.x GB, 미만 MB 정수).
(async () => {
  const s = await new Promise((r) => { const stop = window.corral.onResourceSnapshot((x) => { stop(); r(x) }) })
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const GB = 1024 ** 3, MB = 1024 ** 2
  const cpu = (v) => `${Math.round(v)}%`
  const mem = (v) => (v >= GB ? `${(v / GB).toFixed(1)} GB` : `${Math.round(v / MB)} MB`)
  const cells = (m) => (m.state === 'measured' ? [cpu(m.usage.cpu), mem(m.usage.memory)] : ['—', '—'])
  const panel = document.querySelector('[data-statusbar-resource-panel]')
  if (!panel) return { panel: false }
  const txt = (el, sel) => el?.querySelector(sel)?.textContent ?? null
  const dom = {
    app: [txt(panel.querySelector('[data-statusbar-resource-app]'), '[data-statusbar-resource-cpu]'), txt(panel.querySelector('[data-statusbar-resource-app]'), '[data-statusbar-resource-memory]')],
    herdr: [txt(panel.querySelector('[data-statusbar-resource-herdr]'), '[data-statusbar-resource-cpu]'), txt(panel.querySelector('[data-statusbar-resource-herdr]'), '[data-statusbar-resource-memory]')],
    groups: [...panel.querySelectorAll('[data-statusbar-resource-group]')].map((g) => ({
      key: g.dataset.statusbarResourceGroup,
      head: [g.querySelector('.statusbar-resource-group-head .statusbar-resource-name')?.textContent, txt(g.querySelector('.statusbar-resource-group-head'), '[data-statusbar-resource-cpu]'), txt(g.querySelector('.statusbar-resource-group-head'), '[data-statusbar-resource-memory]')],
      rows: [...g.querySelectorAll('[data-statusbar-resource-row]')].map((r) => ({ id: r.dataset.statusbarResourceRow, title: txt(r, '.statusbar-resource-name'), agent: txt(r, '[data-statusbar-resource-agent]'), cpu: txt(r, '[data-statusbar-resource-cpu]'), mem: txt(r, '[data-statusbar-resource-memory]') })),
    })),
    host: panel.querySelector('[data-statusbar-resource-host]')?.textContent ?? null,
  }
  const mism = []
  const eq = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) mism.push({ label, dom: a, ipc: b }) }
  eq('app', dom.app, cells(s.app)); eq('herdr', dom.herdr, cells(s.herdr))
  for (const g of dom.groups) {
    const panes = s.panes.filter((p) => p.groupKey === g.key)
    const measured = panes.filter((p) => p.measure.state === 'measured')
    const sum = measured.length === 0 ? null : measured.reduce((a, p) => ({ c: a.c + p.measure.usage.cpu, m: a.m + p.measure.usage.memory }), { c: 0, m: 0 })
    eq(`group ${g.key}`, g.head.slice(1), sum === null ? ['—', '—'] : [cpu(sum.c), mem(sum.m)])
    eq(`group ${g.key} label`, g.head[0], panes[0]?.groupLabel)
    for (const r of g.rows) { const p = s.panes.find((x) => x.paneId === r.id); eq(`row ${r.id}`, [r.title, r.agent, r.cpu, r.mem], [p?.title, p?.agent ?? 'shell', ...cells(p.measure)]) }
    eq(`group ${g.key} members`, g.rows.map((r) => r.id).sort(), panes.map((p) => p.paneId).sort())
  }
  const memOrder = dom.groups.map((g) => g.rows.map((r) => { const p = s.panes.find((x) => x.paneId === r.id); return p.measure.state === 'measured' ? p.measure.usage.memory : -1 }))
  return { collectedAt: s.collectedAt, at: new Date().toISOString(), dom, mismatches: mism, memDescWithinGroups: memOrder.every((o) => o.every((v, i) => i === 0 || o[i - 1] >= v)), memOrder,
    active: (() => { const a = document.activeElement; return a ? { tag: a.tagName.toLowerCase(), data: { ...a.dataset } } : null })() }
})()
