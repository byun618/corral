// LIFE-573 최종 관문 드라이버 — 개발 앱(up.sh) 하나에 회차를 돌려 원자료 한 행씩(rounds.ndjson) 남긴다.
// 사용(구현 worktree 의 app/ 에서): L565_ROOT=/tmp/l573n-<빌드> node scripts/l573/gate.mjs <빌드> <원자료 폴더> <단계...>
//   단계: setup <레포> <worktree> · probe · c1 · c2 · c3 · c3info · c6 · c4 · c5 · claude
// 입력은 렌더러 합성 이벤트(01-criteria 「입력 모형」) — `.xterm-screen` 에 mousemove/mousedown/mouseup/mouseleave 를 dispatch.
// 셸 명령은 `term.input`(onData → pane) 으로 보낸다 — 제어 `type` 은 before-input-event 를 타 `input.raw` 를 남겨
// 사용자 키 누출 계수와 섞이기 때문이다. 열림 판정 = main `window.open.*` 로그 ↔ localhost 관측 서버 접속(l565 계측).
// provider 호출 수(C5)·onRender·onData 는 이 드라이버가 CDP 없이 제어 eval 로 xterm 객체에 단 계측으로 센다(제품 코드 무변경):
// xterm 객체는 React fiber 의 TerminalPane `termRef` 에서 찾는다.
import fs from 'node:fs'
import * as l from '../l565/lib.mjs'

const [build, out, ...steps] = process.argv.slice(2)
const ROOT = l.ROOT
const P = l.PORT
const ROWS = `${ROOT}/rows`
const ROW_SH = new URL('./row.sh', import.meta.url).pathname
const STREAM_PY = new URL('./stream.py', import.meta.url).pathname
const ESC = '\x1b'
// 반복 회차(L573_REP=-r2 등)는 URL·기록에 접미를 붙여 회차끼리 안 섞이게 한다.
const REP = process.env.L573_REP ?? ''
const url = (id) => `http://localhost:${P}/l573-${build}-${id}${REP}`
const osc8 = (uri, label) => `${ESC}]8;;${uri}${ESC}\\${label}${ESC}]8;;${ESC}\\`

const HELPER = `(() => {
  if (window.__l573 && document.contains(window.__l573.term.element)) return window.__l573.info()
  const hosts = [...document.querySelectorAll('.term-host')].filter((h) => h.querySelector('.xterm-screen'))
  const host = hosts.find((h) => h.getBoundingClientRect().width > 0) ?? hosts[0]
  if (!host) return { error: 'no term-host' }
  const fk = Object.keys(host).find((k) => k.startsWith('__reactFiber$'))
  let term = null
  for (let f = host[fk]; f && !term; f = f.return) {
    for (let h = f.memoizedState; h && typeof h === 'object' && 'next' in h; h = h.next) {
      const v = h.memoizedState
      if (v && typeof v === 'object' && 'current' in v && v.current && typeof v.current === 'object' && '_core' in v.current) { term = v.current; break }
    }
  }
  if (!term) return { error: 'term not found' }
  const lk = term._core.linkifier
  const provs = term._core._linkProviderService.linkProviders
  const S = { provide: provs.map(() => 0), renders: 0, data: [], writeParsed: 0 }
  provs.forEach((p, i) => { const o = p.provideLinks.bind(p); p.provideLinks = (y, cb) => { S.provide[i]++; return o(y, cb) } })
  term.onRender(() => { S.renders++ })
  term.onWriteParsed(() => { S.writeParsed++ })
  term.onData((d) => { S.data.push({ at: Date.now(), d }) })
  const screen = term.element.querySelector('.xterm-screen')
  const cellXY = (row, col) => { const r = screen.getBoundingClientRect(); const cw = r.width / term.cols, ch = r.height / term.rows; return { x: Math.round(r.left + (col + 0.5) * cw), y: Math.round(r.top + (row + 0.5) * ch) } }
  const ev = (type, row, col, o = {}) => { const p = cellXY(row, col); screen.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseleave', cancelable: true, clientX: p.x, clientY: p.y, ...o })); return p }
  const click = (row, col, meta) => { const o = { button: 0, buttons: 1, metaKey: meta }; ev('mousedown', row, col, o); ev('mouseup', row, col, { ...o, buttons: 0 }); return true }
  const sgr = (from) => S.data.filter((x) => x.at >= from).flatMap((x) => [...x.d.matchAll(/\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])/g)].map((m) => m[0].slice(1)))
  const snap = () => ({ provide: [...S.provide], renders: S.renders, writeParsed: S.writeParsed, data: S.data.length, activeLine: lk._activeLine, hasLink: lk._currentLink !== undefined,
    mouseOut: lk._isMouseOut, pointer: term.element.classList.contains('xterm-cursor-pointer'), viewportY: term.buffer.active.viewportY, bufType: term.buffer.active.type, ts: Date.now() })
  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(true), 80))))
  window.__l573 = { term, lk, S, ev, click, sgr, snap, settle, cellXY,
    info: () => ({ ok: true, hosts: hosts.length, cols: term.cols, rows: term.rows, providers: provs.length, mouseTracking: term.modes.mouseTrackingMode, viewportY: term.buffer.active.viewportY, bufType: term.buffer.active.type }) }
  return window.__l573.info()
})()`

const helper = async () => {
  const info = await l.evalJs(HELPER)
  if (!info?.ok) throw new Error(`helper ${JSON.stringify(info)}`)
  return info
}
const js = (code) => l.evalJs(`(() => { const L = window.__l573; return (${code}) })()`)
const jsAsync = (code) => l.evalJs(`(async () => { const L = window.__l573; return (${code}) })()`)
const sh = (line) => js(`(L.term.input(${JSON.stringify(`${line}\r`)}), true)`)
const record = (rec) => fs.appendFileSync(`${out}/rounds.ndjson`, `${JSON.stringify({ build, rep: REP, at: new Date().toISOString(), ...rec })}\n`)
const findRow = async (tag, label) => l.until(async () => { const t = await l.termRead(); const row = t.lines.findIndex((x) => x.includes(tag)); return row >= 0 ? { t, row } : null }, label, 20_000, 100)

/** 열림 관측 창 — 전후 main 로그·관측 서버 접속 수 */
const openWindow = async () => ({ log: l.openLog().length, http: l.httpLog().length })
const openResult = async (before) => {
  await l.pause(2500)
  const mainLog = l.openLog().slice(before.log).map((x) => JSON.parse(x))
  // 브라우저가 페이지를 열며 따라 부르는 /favicon.ico 는 열림이 아니다 — 따로 센다.
  const http = l.httpLog().slice(before.http).map((x) => JSON.parse(x)).map((h) => h.url)
  return { mainLog: mainLog.map((m) => ({ tag: m.tag, url: m.url })), http: http.filter((u) => u !== '/favicon.ico'), favicon: http.filter((u) => u === '/favicon.ico').length }
}
const verdict = (res, expect) => {
  const ext = res.mainLog.filter((m) => m.tag === 'window.open.external')
  if (expect === null) return ext.length === 0 && res.http.length === 0
  const path = new URL(expect).pathname
  // main 로그는 URL 을 200자에서 자른다(external-url.ts externalOpenLogUrl) — 관측 서버 경로는 전체로 맞춘다.
  return ext.length === 1 && ext[0].url === expect.slice(0, 200) && res.http.length === 1 && res.http[0] === path
}

/**
 * 행 하나를 제자리에서 바꾸는 회차.
 * mode: stay(C1 — 포인터 이동 없이 ⌘+클릭) · move(C2·C3 — 같은 행 안 이동 뒤 ⌘+클릭) · leave(C6 — leave 뒤 같은 칸 복귀) ·
 *       prerender(C3 정보 — write 가 파싱된 직후 렌더 전에 이동·클릭)
 */
async function rowRound({ item, id, before, after, startCol, targetCol, mode, expect, afterVisible }) {
  const tag = `[${id}]`
  fs.writeFileSync(`${ROWS}/${id}.before`, `${tag} ${before}\n`)
  fs.writeFileSync(`${ROWS}/${id}.after`, `${tag} ${after}\n`)
  fs.rmSync(`${ROWS}/${id}.go`, { force: true })
  const off = tag.length + 1
  await helper()
  await sh(`clear; sh ${ROW_SH} ${ROWS} ${id}`)
  const { row } = await findRow(tag, `before ${id}`)
  await l.pause(400)
  const start = { row, col: off + startCol }
  const click = { row, col: off + (targetCol ?? startCol) }
  // 회차 독립: 다른 행 칸을 먼저 지나 직전 회차의 마지막 칸·행 캐시를 끊는다(실제 포인터가 다른 데서 들어오는 것과 같다).
  await js(`L.ev('mousemove', ${start.row + 4}, 2, { metaKey: true })`)
  await l.pause(100)
  const s0 = await js('L.snap()')
  const p0 = await js(`L.ev('mousemove', ${start.row}, ${start.col}, { metaKey: true })`)
  await l.pause(300)
  const s1 = await js('L.snap()')
  if (mode === 'leave') { await js(`L.ev('mouseleave', ${start.row}, ${start.col})`); await l.pause(200) }
  const win = await openWindow()
  let s2, s3, pre = null
  if (mode === 'prerender') {
    // 렌더 전 창: write 파싱 직후(onWriteParsed) 같은 콜백 안에서 이동·⌘+클릭 — 렌더(rAF) 전이다.
    await js(`(L.__pre = null, L.__preOff = L.term.onWriteParsed(() => { if (L.__pre !== null) return; const line = L.term.buffer.active.getLine(${row})?.translateToString(true) ?? '';
      if (!line.includes(${JSON.stringify(afterVisible)})) return; L.__preOff.dispose(); const r0 = L.S.renders; L.ev('mousemove', ${click.row}, ${click.col}, { metaKey: true }); L.click(${click.row}, ${click.col}, true); L.__pre = { line, rendersBetween: L.S.renders - r0, snap: L.snap() } }), true)`)
    fs.writeFileSync(`${ROWS}/${id}.go`, '')
    await l.until(() => js('L.__pre'), `prerender ${id}`, 10_000, 50)
    pre = await js('L.__pre')
  } else {
    fs.writeFileSync(`${ROWS}/${id}.go`, '')
    await findRow(afterVisible, `after ${id}`)
    await jsAsync('await L.settle()')
    s2 = await js('L.snap()')
    if (mode === 'move' || mode === 'leave') { await js(`L.ev('mousemove', ${click.row}, ${click.col}, { metaKey: true })`); await l.pause(150) }
    s3 = await js('L.snap()')
    await js(`L.click(${click.row}, ${click.col}, true)`)
  }
  const res = await openResult(win)
  const t = await l.termRead()
  const pass = verdict(res, expect)
  record({ item, id, mode, expect, start, click, pointerXY: p0, snaps: { s0, s1, s2, s3 }, pre, ...res, rowText: t.lines[row], pass })
  console.log(`${item} ${id} ${mode} pass=${pass} opens=${JSON.stringify(res.mainLog.map((m) => `${m.tag}:${m.url}`))} http=${JSON.stringify(res.http)} q(s1→s3)=${JSON.stringify([s1?.provide, s3?.provide])} pointer=${s3?.pointer}`)
  return pass
}

const FILL = '_'.repeat(70)
const plainAfter = (u) => `${'_'.repeat(10)} ${u} ${'_'.repeat(10)}`
const steps_ = {
  async setup(repo, wt) {
    const live = await l.until(async () => { const s = await l.state(); return s.link?.phase === 'live' ? s : null }, 'live', 60_000)
    console.log('live', JSON.stringify({ selectedSession: live.selectedSession, backend: live.backend?.kind }))
    console.log('add-repo', JSON.stringify(await l.control({ cmd: 'add-repo', root: repo })).slice(0, 200))
    await l.until(async () => { const s = await l.state(); return (s.repos ?? []).some((r) => (r.worktrees ?? []).some((w) => w.path === wt)) ? s : null }, 'rows')
    console.log('click', JSON.stringify(await l.control({ cmd: 'click', selector: `[data-worktree="${wt}"] [data-worktree-card-surface]` })))
    await l.until(async () => { const t = await l.termRead(); return t?.lines ? t : null }, 'term', 30_000)
    await l.pause(3000)
    const info = await helper()
    const t = await l.termRead()
    fs.writeFileSync(`${out}/setup-screen.json`, `${JSON.stringify({ info, cols: t.cols, rows: t.rows, lines: t.lines.filter((x) => x.trim()) }, null, 1)}\n`)
    console.log('helper', JSON.stringify(info))
  },
  async probe() { console.log(JSON.stringify(await helper()), JSON.stringify(await js('L.snap()'))) },
  async c1() {
    for (let n = 1; n <= 3; n++) {
      const u = url(`c1p-${n}`)
      await rowRound({ item: 'C1-plain', id: `c1p-${n}`, before: FILL, after: plainAfter(u), startCol: 16, mode: 'stay', expect: u, afterVisible: `l573-${build}-c1p-${n}` })
    }
    for (let n = 1; n <= 3; n++) {
      const u = url(`c1o-${n}`)
      await rowRound({ item: 'C1-osc8', id: `c1o-${n}`, before: FILL, after: `${'_'.repeat(10)} ${osc8(u, 'osc8-label-c1o-zzzzzz')} ${'_'.repeat(10)}`, startCol: 16, mode: 'stay', expect: u, afterVisible: 'osc8-label-c1o' })
    }
  },
  async c2() {
    for (let n = 1; n <= 3; n++) {
      const u = url(`c2p-${n}`)
      await rowRound({ item: 'C2-plain', id: `c2p-${n}`, before: FILL, after: `${'_'.repeat(20)} ${u} ${'_'.repeat(5)}`, startCol: 3, targetCol: 26, mode: 'move', expect: u, afterVisible: `l573-${build}-c2p-${n}` })
    }
    for (let n = 1; n <= 3; n++) {
      const u = url(`c2o-${n}`)
      await rowRound({ item: 'C2-osc8', id: `c2o-${n}`, before: FILL, after: `${'_'.repeat(20)} ${osc8(u, 'osc8-label-c2o-zzzzzz')} ${'_'.repeat(5)}`, startCol: 3, targetCol: 26, mode: 'move', expect: u, afterVisible: 'osc8-label-c2o' })
    }
  },
  async c3() {
    for (let n = 1; n <= 3; n++) {
      const a = url(`c3a-${n}`)
      await rowRound({ item: 'C3', id: `c3-${n}`, before: `${'_'.repeat(20)} ${a} ${'_'.repeat(5)}`, after: `${'_'.repeat(20)} gone-c3-${'-'.repeat(40)}`, startCol: 3, targetCol: 26, mode: 'move', expect: null, afterVisible: 'gone-c3' })
    }
  },
  async c3info() {
    const a = url('c3info-a')
    await rowRound({ item: 'C3-info-prerender', id: 'c3info-1', before: `${'_'.repeat(20)} ${a} ${'_'.repeat(5)}`, after: `${'_'.repeat(20)} gone-c3i-${'-'.repeat(40)}`, startCol: 3, targetCol: 26, mode: 'prerender', expect: null, afterVisible: 'gone-c3i' })
  },
  async c6() {
    for (let n = 1; n <= 3; n++) {
      const u = url(`c6-${n}`)
      await rowRound({ item: 'C6-plain', id: `c6-${n}`, before: FILL, after: plainAfter(u), startCol: 16, mode: 'leave', expect: u, afterVisible: `l573-${build}-c6-${n}` })
    }
  },
  async c4() {
    await helper()
    // ⓐ 수식키 없는 클릭 → 0 · ⓑ 이동 hover ⌘+클릭 → 1
    const u = url('c4-move')
    const tag = '[c4-ab]'
    fs.writeFileSync(`${ROWS}/c4ab.txt`, `${tag} ${plainAfter(u)}\n`)
    await sh(`clear; /bin/cat ${ROWS}/c4ab.txt`)  // 사용자 셸의 cat 은 bat 별칭(줄 번호·자체 줄 넘김)이다
    const { row, t: t0 } = await findRow(tag, 'c4ab')
    await l.pause(400)
    const col = t0.lines[row].indexOf(tag) + tag.length + 1 + 16
    for (const [id, meta, expect] of [['c4-nomod', false, null], ['c4-move-meta', true, u]]) {
      const win = await openWindow()
      // 다른 행에서 들어온다(회차 독립 — rowRound 와 같은 이유)
      await js(`L.ev('mousemove', ${row + 4}, 2, { metaKey: ${meta} })`)
      await l.pause(100)
      await js(`L.ev('mousemove', ${row}, ${col - 3}, { metaKey: ${meta} })`)
      await l.pause(100)
      await js(`L.ev('mousemove', ${row}, ${col}, { metaKey: ${meta} })`)
      await l.pause(150)
      const s = await js('L.snap()')
      await js(`L.click(${row}, ${col}, ${meta})`)
      const res = await openResult(win)
      const pass = verdict(res, expect)
      record({ item: 'C4', id, meta, expect, cell: { row, col }, snap: s, ...res, pass })
      console.log(`C4 ${id} pass=${pass} ${JSON.stringify(res)} pointer=${s.pointer}`)
    }
    // ⓒ 줄 넘김 URL 둘째 행 → 전체 URL 1
    const long = url(`c4-wrap/${'w'.repeat(120)}/${'z'.repeat(80)}`)
    fs.writeFileSync(`${ROWS}/c4c.txt`, `[c4-wrap] ${long}\n`)
    await sh(`clear; /bin/cat ${ROWS}/c4c.txt`)
    const top = await findRow('[c4-wrap]', 'c4c')
    await l.pause(400)
    const t = await l.termRead()
    const r2 = top.row + 1
    const c2 = Math.max(2, t.lines[r2].indexOf('zzzz') + 2)
    const win = await openWindow()
    await js(`L.ev('mousemove', ${r2 + 4}, 2, { metaKey: true })`)
    await l.pause(100)
    await js(`L.ev('mousemove', ${r2}, ${c2 - 1}, { metaKey: true })`)
    await l.pause(100)
    await js(`L.ev('mousemove', ${r2}, ${c2}, { metaKey: true })`)
    await l.pause(150)
    const s = await js('L.snap()')
    await js(`L.click(${r2}, ${c2}, true)`)
    const res = await openResult(win)
    const pass = verdict(res, long)
    record({ item: 'C4', id: 'c4-wrap-second-row', expect: long, cell: { row: r2, col: c2 }, rows: [t.lines[top.row], t.lines[r2]], snap: s, ...res, pass })
    console.log(`C4 c4-wrap-second-row pass=${pass} ${JSON.stringify(res.mainLog)} http=${JSON.stringify(res.http)}`)
  },
  // C3 정보 변형 — row.sh 는 지우기(printf)와 새 내용(cat)을 두 번에 써서 그 사이 렌더가 한 번 낀다.
  // 여기서는 한 번의 write(single.sh) 로 바꿔 「렌더 전 창」 을 단일 프레임으로 좁힌다.
  async c3info1w() {
    fs.writeFileSync(`${ROWS}/single.sh`, `D=$1; ID=$2\n/bin/cat "$D/$ID.before"\nwhile [ ! -e "$D/$ID.go" ]; do sleep 0.02; done\nprintf '\\033[1A\\r\\033[2K%s\\n' "$(/bin/cat "$D/$ID.after1")"\n`)
    const a = url('c3info1w-a')
    const id = 'c3info1w-1'
    const tag = `[${id}]`
    fs.writeFileSync(`${ROWS}/${id}.after1`, `${tag} ${'_'.repeat(20)} gone-c3w-${'-'.repeat(40)}`)
    // rowRound 의 row.sh 대신 single.sh 를 쓰도록 같은 절차를 한 번 더 적는다
    fs.writeFileSync(`${ROWS}/${id}.before`, `${tag} ${'_'.repeat(20)} ${a} ${'_'.repeat(5)}\n`)
    fs.rmSync(`${ROWS}/${id}.go`, { force: true })
    await helper()
    await sh(`clear; sh ${ROWS}/single.sh ${ROWS} ${id}`)
    const { row } = await findRow(tag, `before ${id}`)
    await l.pause(400)
    const off = tag.length + 1
    await js(`L.ev('mousemove', ${row + 4}, 2, { metaKey: true })`)
    await l.pause(100)
    await js(`L.ev('mousemove', ${row}, ${off + 3}, { metaKey: true })`)
    await l.pause(300)
    const s1 = await js('L.snap()')
    const win = await openWindow()
    await js(`(L.__pre = null, L.__preOff = L.term.onWriteParsed(() => { if (L.__pre !== null) return; const line = L.term.buffer.active.getLine(${row})?.translateToString(true) ?? '';
      if (!line.includes('gone-c3w')) return; L.__preOff.dispose(); const r0 = L.S.renders; L.ev('mousemove', ${row}, ${off + 26}, { metaKey: true }); L.click(${row}, ${off + 26}, true); L.__pre = { line, rendersBetween: L.S.renders - r0, snap: L.snap() } }), true)`)
    fs.writeFileSync(`${ROWS}/${id}.go`, '')
    await l.until(() => js('L.__pre'), `prerender ${id}`, 10_000, 50)
    const pre = await js('L.__pre')
    const res = await openResult(win)
    const pass = verdict(res, null)
    record({ item: 'C3-info-prerender-single-write', id, mode: 'prerender', expect: null, snaps: { s1 }, pre, writesBetween: pre.snap.writeParsed - s1.writeParsed, rendersSinceHover: pre.snap.renders - s1.renders, ...res, pass })
    console.log(`C3-info-single-write pass=${pass} ${JSON.stringify(res)} writesBetween=${pre.snap.writeParsed - s1.writeParsed} rendersSinceHover=${pre.snap.renders - s1.renders} hasLink=${pre.snap.hasLink}`)
  },
  // L4-4 레이아웃 변경 뒤 가장자리 — 포인터를 왼쪽 가장자리 칸(링크 없음)에 둔 채 사이드바를 펼쳐 터미널을 오른쪽으로 밀고
  // (저장된 clientX 는 이제 터미널 왼쪽 밖), 그 행 0열에 URL 이 오게 한다. 재평가가 클램프된 0열로 링크를 잡는지 본다. 클릭은 안 한다.
  async l44() {
    await helper()
    const toggle = () => l.evalJs(`(() => { const b = document.querySelector('[data-sidebar-toggle]'); b?.click(); return b?.getAttribute('aria-label') ?? null })()`)
    const before0 = await toggle()
    await l.pause(1500)
    await helper()
    const id = 'l44-1'
    const u = url('l44-edge')
    fs.writeFileSync(`${ROWS}/${id}.before`, `${'_'.repeat(60)} [${id}]\n`)
    fs.writeFileSync(`${ROWS}/${id}.after`, `${u} ____ [${id}]x\n`)
    fs.rmSync(`${ROWS}/${id}.go`, { force: true })
    await sh(`clear; sh ${ROW_SH} ${ROWS} ${id}`)
    const { row } = await findRow(`[${id}]`, 'l44 before')
    await l.pause(400)
    await js(`L.ev('mousemove', ${row + 4}, 2, {})`)
    await l.pause(100)
    const p = await js(`L.ev('mousemove', ${row}, 1, {})`)
    await l.pause(300)
    const s1 = await js('L.snap()')
    const rect1 = await js(`(() => { const r = L.term.element.querySelector('.xterm-screen').getBoundingClientRect(); return { left: r.left, width: r.width, cols: L.term.cols } })()`)
    const before1 = await toggle()
    await l.pause(1500)
    const rect2 = await js(`(() => { const r = L.term.element.querySelector('.xterm-screen').getBoundingClientRect(); return { left: r.left, width: r.width, cols: L.term.cols } })()`)
    const s2 = await js('L.snap()')
    fs.writeFileSync(`${ROWS}/${id}.go`, '')
    await findRow(`[${id}]x`, 'l44 after')
    await jsAsync('await L.settle()')
    await l.pause(300)
    const s3 = await js('L.snap()')
    const t = await l.termRead()
    record({ item: 'L4-4', id, pointerXY: p, rect1, rect2, toggles: [before0, before1], snaps: { s1, s2, s3 }, pointerOutsideAfterLayout: p.x < rect2.left, rowText: t.lines.find((x) => x.includes(`[${id}]x`)) })
    console.log(`L4-4 pointer.x=${p.x} rect1.left=${rect1.left} rect2.left=${rect2.left} outside=${p.x < rect2.left} s2.hasLink=${s2.hasLink} s3.hasLink=${s3.hasLink} q=${JSON.stringify([s1.provide, s2.provide, s3.provide])}`)
  },
  // C4 실제 Claude Code pane — viewportY 기록(L4-5) · 마우스 리포트 양성 대조(실제 DOM 이벤트 → onData SGR) ·
  // 정지 포인터 재평가 구간(응답 스트리밍 중 포인터 고정) SGR 0 · 응답의 URL ⌘+클릭 1 (L4-2)
  async claude() {
    await helper()
    const u = url('c4-claude')
    await sh('clear; claude --model haiku')
    const ready = await l.until(async () => { const t = await l.termRead(); const s = t.lines.join('\n'); return /trust this folder|Do you trust/i.test(s) || t.lines.some((x) => x.startsWith('❯')) ? t : null }, 'claude ready', 90_000, 500)
    fs.writeFileSync(`${out}/claude-ready-screen.json`, `${JSON.stringify(ready.lines, null, 1)}\n`)
    if (/trust this folder|Do you trust/i.test(ready.lines.join('\n'))) throw new Error('claude 신뢰 대화상자 — 손대지 않고 멈춘다')
    await l.pause(1500)
    const info = await helper()
    record({ item: 'L4-5', id: 'claude-viewport', info })
    console.log('claude pane', JSON.stringify(info))
    // 양성 대조 — 빈 칸에서 실제 DOM mousedown → mousemove(buttons=1) → mouseup (수식키 없음)
    const t0 = await js('Date.now()')
    await js(`(L.ev('mousedown', 1, 70, { button: 0, buttons: 1 }), L.ev('mousemove', 1, 71, { buttons: 1 }), L.ev('mouseup', 1, 71, { button: 0, buttons: 0 }), true)`)
    await l.pause(800)
    const posSgr = await js(`L.sgr(${t0})`)
    record({ item: 'C4-claude', id: 'mouse-report-positive-control', cell: { row: 1, col: 70 }, sgr: posSgr, pass: posSgr.length > 0 })
    console.log('positive control sgr', JSON.stringify(posSgr))
    // 프롬프트 → 스트리밍 동안 포인터를 빈 칸(행 2)에 한 번 두고 고정
    await js(`(L.term.input(${JSON.stringify(`Write six short lines about rivers, one per line. Then on its own final line output exactly this URL and nothing after it: ${u}`)}), true)`)
    await l.pause(700)
    await js(`(L.term.input('\\r'), true)`)
    await l.pause(300)
    const a = await js('L.snap()')
    const t1 = await js(`(L.ev('mousemove', 2, 60, {}), Date.now())`)
    const key = `l573-${build}-c4-claude${REP}`
    const count = (t) => t.lines.reduce((n, x) => n + x.split(key).length - 1, 0)
    const n0 = count(await l.termRead())
    await l.until(async () => { const t = await l.termRead(); return count(t) > n0 ? t : null }, 'claude answer', 120_000, 500)
    // 응답이 끝나 화면이 2초 동안 그대로일 때까지
    let prev = '', same = 0, done = null
    await l.until(async () => { done = await l.termRead(); const s = done.lines.join('\n'); same = s === prev ? same + 1 : 0; prev = s; return same >= 4 }, 'claude settle', 60_000, 500)
    const b = await js('L.snap()')
    const quietSgr = await js(`L.sgr(${t1})`)
    record({ item: 'C4-claude', id: 'stationary-reeval-window', cell: { row: 2, col: 60 }, ms: b.ts - t1, provide: b.provide.map((v, i) => v - a.provide[i]), renders: b.renders - a.renders, sgr: quietSgr, pass: quietSgr.length === 0 })
    console.log('stationary window', JSON.stringify({ ms: b.ts - t1, provide: b.provide.map((v, i) => v - a.provide[i]), renders: b.renders - a.renders, sgr: quietSgr }))
    fs.writeFileSync(`${out}/claude-answer-screen.json`, `${JSON.stringify(done.lines, null, 1)}\n`)
    // 응답 URL ⌘+클릭
    const t = await l.termRead()
    const at = l.locate(t, key, count(t) - 1)
    const col = at.col + 2
    const win = await openWindow()
    const t2 = await js('Date.now()')
    await js(`L.ev('mousemove', ${Math.max(0, at.row - 3)}, 2, { metaKey: true })`)
    await l.pause(100)
    await js(`L.ev('mousemove', ${at.row}, ${col - 1}, { metaKey: true })`)
    await l.pause(100)
    await js(`L.ev('mousemove', ${at.row}, ${col}, { metaKey: true })`)
    await l.pause(150)
    const s = await js('L.snap()')
    await js(`L.click(${at.row}, ${col}, true)`)
    const res = await openResult(win)
    const clickSgr = await js(`L.sgr(${t2})`)
    const pass = verdict(res, u)
    record({ item: 'C4-claude', id: 'claude-meta-click', expect: u, cell: { row: at.row, col }, n0, rowText: t.lines[at.row], snap: s, ...res, sgr: clickSgr, pass })
    console.log(`claude meta-click pass=${pass} ${JSON.stringify(res)} sgr=${JSON.stringify(clickSgr)}`)
    await js(`(L.term.input('\\x03'), true)`)
    await l.pause(500)
    await js(`(L.term.input('\\x03'), true)`)
    await l.pause(1500)
  },
  async c5() {
    await helper()
    const u = url('c5-link')
    const line = `[c5] ${'_'.repeat(30)} ${u} ${'_'.repeat(10)}`
    fs.writeFileSync(`${ROWS}/c5.line`, line)
    const urlCol = line.indexOf(u) + 4
    for (const arm of ['outside-still', 'outside-moving', 'on-link', 'terminal-out']) {
      await sh(`clear; python3 ${STREAM_PY} ${ROWS}/c5.line 13`)
      const { row } = await findRow('[c5]', `stream ${arm}`)
      await l.pause(1000)
      if (arm === 'terminal-out') {
        await js(`L.ev('mousemove', ${row}, 10, {})`)
        await l.pause(100)
        await js(`L.ev('mouseleave', ${row}, 10)`)
      } else await js(`L.ev('mousemove', ${row}, ${arm === 'on-link' ? urlCol : 10}, {})`)
      await l.pause(300)
      // 10초 계수 — 이동 팔은 렌더러 rAF 마다 링크 밖 두 칸(10↔11)을 오간다.
      const r = await jsAsync(`await (async () => {
        const a = L.snap(); let moves = 0, k = 0; let stop = false
        const tick = () => { if (stop) return; ${arm === 'outside-moving' ? `k ^= 1; L.ev('mousemove', ${row}, 10 + k, {}); moves++;` : ''} requestAnimationFrame(tick) }
        requestAnimationFrame(tick)
        await new Promise((res) => setTimeout(res, 10000)); stop = true
        const b = L.snap()
        return { a, b, moves, provide: b.provide.map((v, i) => v - a.provide[i]), renders: b.renders - a.renders, writeParsed: b.writeParsed - a.writeParsed, ms: b.ts - a.ts }
      })()`)
      const total = r.provide.reduce((x, y) => x + y, 0)
      record({ item: 'C5', id: `c5-${arm}`, arm, row, urlCol, ...r, total })
      console.log(`C5 ${arm} provide=${JSON.stringify(r.provide)} total=${total} renders=${r.renders} writeParsed=${r.writeParsed} moves=${r.moves} ms=${r.ms} hasLink=${r.b.hasLink} mouseOut=${r.b.mouseOut}`)
      await findRow('stream-done', `stream end ${arm}`)
    }
  },
}

for (let i = 0; i < steps.length; i++) {
  const name = steps[i]
  if (name === 'setup') { await steps_.setup(steps[i + 1], steps[i + 2]); i += 2; continue }
  if (!(name in steps_)) throw new Error(`단계 없음 ${name}`)
  console.log(`## ${name} ${new Date().toISOString()}`)
  await steps_[name]()
}
