// ⓑ B7 — 화면 밖 과거 출력을 어디까지 되찾는가.
// 0.9.0 신규 pane.scroll · pane.selection.read 로 herdr 에게 스크롤을 시키는 길도 같이 잰다.
//
// 실행: HERDR_SOCKET_PATH=~/.config/herdr/sessions/spike-claude/herdr.sock node probes/b-scrollback.mjs

import { Raw, sleep } from '../lib/raw.mjs'
import { makeApi, run, readText, readAnsi } from '../lib/pane.mjs'

const raw = new Raw('b-scrollback')
const api = makeApi(raw)
const R = {}
const TOTAL = 300

const panes = await api('pane.list', {})
const P = panes.panes[0].pane_id
for (const p of panes.panes.slice(1)) await api('pane.close', { pane_id: p.pane_id })

/** '줄 N' 형태로 찍은 줄에서 되찾은 N 의 범위를 뽑는다. */
function span(text, tag = '줄') {
  const re = new RegExp(`${tag} (\\d+)`, 'g')
  const ns = [...text.matchAll(re)].map((m) => Number(m[1]))
  if (!ns.length) return { count: 0, min: null, max: null, distinct: 0 }
  return { count: ns.length, min: Math.min(...ns), max: Math.max(...ns), distinct: new Set(ns).size }
}

async function readSpan(source, lines, tag) {
  const r = await readText(api, P, source, lines)
  raw.log('read', { source, lines, length: r.text.length, truncated: r.truncated, span: span(r.text, tag) })
  return { source, lines: lines ?? null, truncated: r.truncated, bytes: r.text.length, ...span(r.text, tag) }
}

// --- 1) 보통 pane (알트스크린 아님) --------------------------------------
{
  await run(api, P, "printf '\\033[2J\\033[H'", { settleMs: 500 })
  await run(api, P, `seq 1 ${TOTAL} | awk '{print "줄 " $1}'`, { settleMs: 2500 })

  const rows = []
  rows.push(await readSpan('visible', undefined, '줄'))
  for (const n of [50, 200, 500, 5000]) {
    rows.push(await readSpan('recent', n, '줄'))
    rows.push(await readSpan('recent_unwrapped', n, '줄'))
  }
  rows.push(await readSpan('detection', undefined, '줄'))
  R.normalPane = { total: TOTAL, reads: rows }
  console.log('보통 pane:')
  for (const r of rows) console.log(' ', r.source, 'lines=' + r.lines, '→', r.min, '~', r.max, `(${r.distinct}줄, truncated=${r.truncated})`)
}

// --- 2) herdr 에게 스크롤을 시키고 visible 을 다시 읽는 길 ----------------
{
  const info = (await api('pane.list', {})).panes.find((x) => x.pane_id === P)
  const maxOff = info.scroll?.max_offset_from_bottom ?? 0
  const walked = []
  const seen = new Set()
  // 뷰포트 높이만큼씩 뒤로 걸으며 화면을 읽는다
  const step = info.scroll?.viewport_rows ?? 39
  for (let off = 0; off <= maxOff; off += step) {
    await api('pane.scroll', { pane_id: P, offset_from_bottom: off })
    await sleep(120)
    const v = await readText(api, P, 'visible')
    const s = span(v.text)
    if (s.min !== null) for (let n = s.min; n <= s.max; n++) seen.add(n)
    walked.push({ offset: off, min: s.min, max: s.max })
  }
  await api('pane.scroll', { pane_id: P, offset_from_bottom: 0 })
  R.paneScrollWalk = {
    maxOffsetFromBottom: maxOff,
    viewportRows: step,
    steps: walked.length,
    walked,
    distinctLinesRecovered: seen.size,
    coverage: `${seen.size}/${TOTAL}`,
  }
  console.log('pane.scroll 왕복:', maxOff, '오프셋,', walked.length, '스텝 →', seen.size, '줄')
}

// --- 3) pane.selection.read 로 범위를 통째로 긁는 길 ---------------------
{
  const info = (await api('pane.list', {})).panes.find((x) => x.pane_id === P)
  const maxOff = info.scroll?.max_offset_from_bottom ?? 0
  const rows = info.scroll?.viewport_rows ?? 39
  const attempts = []
  // row 좌표계가 무엇인지 모른다 — 몇 가지로 두들겨보고 응답을 그대로 남긴다.
  for (const [label, anchor, cursor] of [
    ['0..viewport', { row: 0, col: 0 }, { row: rows - 1, col: 0 }],
    ['0..maxOff+viewport', { row: 0, col: 0 }, { row: maxOff + rows, col: 0 }],
    ['0..2000', { row: 0, col: 0 }, { row: 2000, col: 0 }],
  ]) {
    try {
      const r = await api('pane.selection.read', { pane_id: P, anchor, cursor })
      const txt = JSON.stringify(r).length > 0 ? (r.text ?? r.selection?.text ?? JSON.stringify(r)) : ''
      attempts.push({ label, anchor, cursor, ok: true, resultKeys: Object.keys(r), span: span(String(txt)) })
      raw.log('selection.read', { label, result: JSON.stringify(r).slice(0, 400) })
    } catch (err) {
      attempts.push({ label, anchor, cursor, ok: false, error: String(err) })
    }
  }
  R.selectionRead = attempts
  console.log('selection.read:', JSON.stringify(attempts.map((a) => ({ l: a.label, ok: a.ok, span: a.span })), null, 0).slice(0, 400))
}

// --- 4) alternate screen pane 은 무엇을 못 되찾는가 ----------------------
// 스킬 문서 경고: alt screen pane 의 출력은 host scrollback 에 안 쌓인다. 범위를 실측한다.
{
  await run(api, P, "printf '\\033[2J\\033[H'", { settleMs: 400 })
  // 알트스크린 안에서 300줄을 찍고 화면을 잡아둔다
  await run(
    api,
    P,
    `printf '\\033[?1049h\\033[2J\\033[H'; seq 1 ${TOTAL} | awk '{print "알트 " $1}'; sleep 600`,
    { settleMs: 3000 },
  )
  const rows = []
  rows.push(await readSpan('visible', undefined, '알트'))
  for (const n of [200, 5000]) {
    rows.push(await readSpan('recent', n, '알트'))
    rows.push(await readSpan('recent_unwrapped', n, '알트'))
  }
  // 알트스크린을 잡고 있는 동안 host scrollback(정상 화면의 '줄 N')은 어떻게 보이는가
  const hostView = await readText(api, P, 'recent_unwrapped', 5000)
  const info = (await api('pane.list', {})).panes.find((x) => x.pane_id === P)
  R.altPane = {
    total: TOTAL,
    reads: rows,
    hostScrollbackWhileAlt: span(hostView.text, '줄'),
    scrollInfo: info.scroll ?? null,
  }
  console.log('알트 pane:')
  for (const r of rows) console.log(' ', r.source, 'lines=' + r.lines, '→', r.min, '~', r.max, `(${r.distinct}줄)`)
  console.log('  알트 중 host scrollback 의 "줄 N":', JSON.stringify(R.altPane.hostScrollbackWhileAlt))
  console.log('  scroll info:', JSON.stringify(R.altPane.scrollInfo))

  await api('pane.send_text', { pane_id: P, text: '\x03' })
  await sleep(600)
  // 알트에서 빠져나온 뒤 알트 안 출력이 되살아나는가
  const after = await readText(api, P, 'recent_unwrapped', 5000)
  R.altPane.afterExit = { alt: span(after.text, '알트'), host: span(after.text, '줄') }
  console.log('  알트 종료 후:', JSON.stringify(R.altPane.afterExit))
}

raw.close({ probe: 'b-scrollback', at: new Date().toISOString(), results: R })
process.exit(0)
