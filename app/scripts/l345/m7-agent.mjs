// T4 (알트스크린 판) · P1 (비용).
//
// ## T4 — 깨짐의 정의를 먼저 박는다
//
// 기준이 "깨짐의 정의를 미리 적고 그 검사를 통과한 근거를 내라"고 한다. 이 구현이 쓰는 정의:
//
//   ① **테두리 어긋남** — 박스 문자(│┌└├ 등)로 시작하는 행들의 시작 열이 서로 달라지면 깨짐.
//      알트스크린 TUI 의 왼쪽 테두리는 한 열에 정렬돼야 한다
//   ② **중복 줄** — 같은 내용의 행이 herdr 스냅샷보다 corral 화면에 더 많이 나타나면 깨짐.
//      재생이 화면을 밀어냈다는 뜻이다
//   ③ **잔상** — herdr 스냅샷에 없는 글자가 corral 화면에 남아 있으면 깨짐.
//      이전 프레임을 다 못 지운 것이다
//   ④ **행 밀림** — herdr 스냅샷의 행 i 와 corral 화면의 행 i 가 다르면 깨짐
//
// ②③④ 는 결국 "스냅샷 행 == 화면 행"으로 한 번에 검사된다. 기준선을 herdr 스냅샷으로 두는 것이
// 여기서는 맞다 — T1 과 달리 이 항목이 묻는 것은 *herdr 화면의 재현*이지 원본 바이트와의 일치가
// 아니다 (에이전트 TUI 는 원본 바이트를 따로 얻을 방법이 없다). T1 이 그 일치를 이미 증명했다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pct, request, run, sleep, startApp, tidySession, writeRaw } from './lib.mjs'

const exec = promisify(execFile)
const out = {}

const screenRows = (dump) =>
  dump.grid.map((row) => row.map((cell) => (cell?.w === 0 ? '' : (cell?.ch ?? ' '))).join('').replace(/\s+$/, ''))

// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g
const snapshotRows = (text) => {
  const lines = text.split(/\r?\n/).map((line) => line.replace(CSI, '').replace(/\s+$/, ''))
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

// ==========================================================================
// T4 — 에이전트 TUI
// ==========================================================================
{
  const paneId = await tidySession()
  const agents = []
  // 기준이 이름 댄 것은 claude·codex 다. 있는 것을 쓰고, 어느 쪽도 없으면 그 사실을 적는다.
  for (const name of ['claude', 'codex']) {
    const found = await exec('which', [name]).then((r) => r.stdout.trim()).catch(() => null)
    if (found) agents.push({ name, path: found })
  }
  console.log('agents', JSON.stringify(agents))

  const cases = []
  for (const agent of agents.slice(0, 2)) {
    await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] }).catch(() => {})
    await sleep(400)
    await run(paneId, "printf '\\033[?1049l'; clear", { settleMs: 600 })
    // 에이전트를 격리 pane 에서 띄운다. 아무 일도 시키지 않는다 — 화면만 본다.
    await run(paneId, agent.name, { settleMs: 12_000 })

    const app = await startApp({ name: `agent-${agent.name}` })
    await sleep(1500)
    await app.selectPane(paneId)
    await sleep(4000)

    // 같은 순간의 herdr 스냅샷과 corral 화면을 맞춰 본다. 화면이 계속 움직이면 다시 뜬다.
    let pair = null
    for (let attempt = 0; attempt < 8; attempt++) {
      const first = await request('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })
      await sleep(1200)
      const dump = (await app.dump()).dump
      const second = await request('pane.read', { pane_id: paneId, source: 'visible', format: 'text' })
      if (first.read.text === second.read.text) {
        pair = { snapshot: second.read.text, dump }
        break
      }
      await sleep(600)
    }
    if (pair === null) {
      cases.push({ agent: agent.name, settled: false, note: '화면이 정지하지 않아 비교 쌍을 못 얻었다' })
      await app.stop()
      continue
    }

    const snap = snapshotRows(pair.snapshot)
    const screen = screenRows(pair.dump)
    const rows = Math.max(snap.length, screen.length)
    const mismatched = []
    for (let y = 0; y < rows; y++) {
      if ((snap[y] ?? '') !== (screen[y] ?? '')) mismatched.push({ y, snapshot: snap[y] ?? '', screen: screen[y] ?? '' })
    }
    // ① 테두리 정렬 — 박스 문자로 시작하는 행들의 시작 열
    const borderColumns = new Set()
    for (const line of screen) {
      const index = line.search(/[│┌└├┃┏┗┣╭╰|]/)
      if (index >= 0) borderColumns.add(index)
    }
    // ③ 잔상 — 스냅샷에 없는 글자가 화면에 남았나 (행 단위)
    const ghosts = screen.filter((line, y) => line !== '' && (snap[y] ?? '') === '')
    // ② 중복 — 같은 내용 행의 개수가 스냅샷보다 많나
    const count = (list) => list.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map())
    const snapCount = count(snap.filter((line) => line !== ''))
    const screenCount = count(screen.filter((line) => line !== ''))
    const duplicated = [...screenCount.entries()].filter(([line, n]) => n > (snapCount.get(line) ?? 0))

    const item = {
      agent: agent.name,
      settled: true,
      rowsCompared: rows,
      mismatchedRows: mismatched.length,
      mismatchSample: mismatched.slice(0, 6),
      borderStartColumns: [...borderColumns].sort((a, b) => a - b),
      borderAligned: borderColumns.size <= 1,
      ghostRows: ghosts.length,
      duplicatedRows: duplicated.length,
      duplicatedSample: duplicated.slice(0, 4),
      broken: mismatched.length > 0 || ghosts.length > 0 || duplicated.length > 0,
      shot: (await app.termShot(`t4-${agent.name}`)).file,
      fullShot: (await app.shot(`t4-${agent.name}-full`)).file,
      screen: screen.filter((line) => line !== '').slice(0, 20),
    }
    cases.push(item)
    console.log('T4', agent.name, JSON.stringify({ ...item, screen: undefined, mismatchSample: undefined, shot: undefined, fullShot: undefined }))
    await app.stop()

    await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] }).catch(() => {})
    await sleep(600)
    await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] }).catch(() => {})
    await sleep(600)
    await run(paneId, "printf '\\033[?1049l'; clear", { settleMs: 800 })
  }

  out.t4 = {
    brokenDefinition: {
      '①': '테두리 어긋남 — 박스 문자로 시작하는 행들의 시작 열이 하나로 모이지 않으면 깨짐',
      '②': '중복 줄 — 같은 내용 행이 herdr 스냅샷보다 많이 나타나면 깨짐',
      '③': '잔상 — 스냅샷에 없는 글자가 화면에 남아 있으면 깨짐',
      '④': '행 밀림 — 스냅샷 행 i 와 화면 행 i 가 다르면 깨짐',
    },
    agentsAvailable: agents,
    cases,
  }
}

// ==========================================================================
// P1 — 비용. 유휴(정지 화면)와 출력이 쏟아질 때, WebGL 켠 것과 끈 것.
// ==========================================================================
{
  const paneId = await tidySession()
  await run(paneId, 'clear; printf "P1 정지 화면\\n"', { settleMs: 900 })

  /** 앱 프로세스 트리(main + 렌더러 헬퍼)의 CPU·RSS 합. ps 한 번에 다 잡는다. */
  async function sample(pid) {
    const { stdout } = await exec('/bin/ps', ['-o', 'pid=,ppid=,%cpu=,rss=,comm=', '-Ax'])
    const rows = stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 5)
      .map((parts) => ({ pid: Number(parts[0]), ppid: Number(parts[1]), cpu: Number(parts[2]), rss: Number(parts[3]) }))
    // main 프로세스와 그 자식(렌더러·GPU 헬퍼)까지.
    const family = new Set([pid])
    for (let i = 0; i < 4; i++) {
      for (const row of rows) if (family.has(row.ppid)) family.add(row.pid)
    }
    const mine = rows.filter((row) => family.has(row.pid))
    return {
      processes: mine.length,
      cpuPercent: Number(mine.reduce((sum, row) => sum + row.cpu, 0).toFixed(1)),
      rssMB: Number((mine.reduce((sum, row) => sum + row.rss, 0) / 1024).toFixed(1)),
    }
  }

  const arms = {}
  for (const webgl of [false, true]) {
    const app = await startApp({ name: `cost-${webgl ? 'webgl' : 'dom'}` })
    await sleep(1500)
    await app.webgl(webgl)
    await app.selectPane(paneId)
    await sleep(4000)

    const idle = []
    for (let i = 0; i < 10; i++) {
      idle.push(await sample(app.child.pid))
      await sleep(1000)
    }

    await run(paneId, `sh ${process.cwd()}/scripts/l345/fixtures/04-ticker.sh &`, { settleMs: 2000 })
    const busy = []
    for (let i = 0; i < 10; i++) {
      busy.push(await sample(app.child.pid))
      await sleep(1000)
    }
    const state = (await app.state()).state.terminal
    const webglEvents = app
      .entries()
      .filter((entry) => entry.tag === 'renderer.probe' && entry.name === 'term.webgl')
      .map((entry) => entry.event)

    await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] })
    await sleep(600)
    await run(paneId, "printf '\\033[?1049l'; clear", { settleMs: 800 })

    const summarize = (list) => ({
      samples: list.length,
      cpuP50: pct(list.map((item) => item.cpuPercent), 50),
      cpuP95: pct(list.map((item) => item.cpuPercent), 95),
      cpuMax: Math.max(...list.map((item) => item.cpuPercent)),
      rssMBP50: pct(list.map((item) => item.rssMB), 50),
      rssMBMax: Math.max(...list.map((item) => item.rssMB)),
      processes: list[0]?.processes ?? null,
    })
    arms[webgl ? 'webgl' : 'dom'] = {
      webglEvents,
      idle: summarize(idle),
      busy: summarize(busy),
      framesAtEnd: state.frames,
      readsAtEnd: state.reads,
      shot: (await app.termShot(`p1-${webgl ? 'webgl' : 'dom'}`)).file,
    }
    console.log('P1', webgl ? 'webgl' : 'dom', JSON.stringify(arms[webgl ? 'webgl' : 'dom']))
    await app.stop()
  }
  out.p1 = { note: 'main + 렌더러/GPU 헬퍼 프로세스의 %CPU·RSS 합, 1초 간격 10표본', arms }
}

writeRaw('50-agent-cost.json', { measuredAt: new Date().toISOString(), ...out })
process.exit(0)
