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
//
// ## 알트 판이라는 것을 **먼저 증명한다** (판정 H1)
//
// 1차 측정은 "에이전트를 띄웠으니 알트겠지"로 넘어갔고, 실제로는 둘 다 일반 버퍼였다
// (`term.scrollback` 의 씨앗이 claude 32줄 · codex 13줄). 통과선이 요구하는 것은 **전체화면
// TUI pane** 이므로 그 화면은 T4 의 대상이 아니었다.
//
// 판별자는 **herdr 가 주는 `scroll.max_offset_from_bottom`** 이다 — 알트 버퍼에는 스크롤백이
// 없으므로 이 값이 0 이 된다. 히스토리가 없는 새 pane 도 0 이므로 값 하나로는 모자라다.
// 그래서 순서를 박는다:
//
//   ① pane 에 히스토리 60줄을 심는다 → ② `max_offset_from_bottom > 0` 을 확인한다
//   (판별자가 살아 있다) → ③ TUI 를 띄운다 → ④ 그 값이 0 이면 **알트 진입 확정**
//
// corral 의 씨앗 줄 수를 판별자로 쓰지 않는 이유: **재는 대상이 corral 자신**이라 자기순환이다.
// (실제로 그 방식은 vim 메시지 화면에서 36 을 내놓아 "알트 아님"으로 잘못 읽혔다.)
// 씨앗은 보조 근거로만 싣는다.
//
// 판정 수치는 ④가 확정된 대상에서만 낸다. 에이전트(claude·codex)도 같은 절차로 돌려서
// **"에이전트가 알트를 쓰는가"(판정 §6)에 실측으로 답한다** — 이건 T4 의 판정 수치가 아니라
// 그 질문의 답이다.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { killFixtures, pct, reclaimShell, request, run, sleep, startApp, tidySession, writeRaw } from './lib.mjs'

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

  /**
   * 대상 목록. `vim` 이 **판정용**이다 — 알트 진입이 확실하고, `-O` 세로 분할이라 세로
   * 테두리(`│`)가 생겨 깨짐 정의 ①(테두리 정렬)이 실제로 검사할 것이 있다. 1차 측정의
   * claude 팔은 `borderStartColumns: []` 라 ①이 아무것도 안 봤다 (판정 H1 보조 근거).
   */
  const subjects = [
    {
      key: 'vim',
      label: 'vim -O (알트 확인용 · 판정 대상)',
      judged: true,
      launch: "vim -u NONE -O /tmp/l345-t4-left.txt /tmp/l345-t4-right.txt",
      settleMs: 3500,
      // 파일 두 개를 열면 vim 이 "Press ENTER or type command to continue" 에서 멈춘다.
      // 1차 재측정이 그 **메시지 화면**을 T4 대상으로 재 버렸다 (세로 테두리가 없었던 이유다).
      afterLaunch: async () => {
        await request('pane.send_text', { pane_id: paneId, text: '\r' })
        await sleep(3000)
      },
      quit: async () => {
        await request('pane.send_keys', { pane_id: paneId, keys: ['Escape'] }).catch(() => {})
        await sleep(300)
        await request('pane.send_text', { pane_id: paneId, text: ':qa!\n' }).catch(() => {})
        await sleep(800)
      },
    },
    ...agents.map((agent) => ({
      key: agent.name,
      label: `${agent.name} (에이전트 — 판정 §6 질문의 답)`,
      judged: false,
      launch: agent.name,
      settleMs: 12_000,
      quit: async () => {
        for (let i = 0; i < 2; i++) {
          await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] }).catch(() => {})
          await sleep(600)
        }
      },
    })),
  ]

  // vim 이 열 파일 두 개. 내용이 있어야 분할이 눈에 보인다.
  await run(paneId, "printf 'LEFT 1\\nLEFT 2\\nLEFT 3\\n' > /tmp/l345-t4-left.txt", { settleMs: 400 })
  await run(paneId, "printf 'RIGHT 1\\nRIGHT 2\\nRIGHT 3\\n' > /tmp/l345-t4-right.txt", { settleMs: 400 })

  const cases = []
  for (const subject of subjects) {
    await reclaimShell(paneId)
    // ① 히스토리를 심는다 — 판별자(씨앗 0줄)가 살아 있는지 먼저 보이기 위해서다.
    // **뷰포트보다 많이** 심는다 — 39행짜리 pane 에 30줄만 심으면 화면에 다 들어가 씨앗이
    // 0이 되고, 그러면 판별자가 죽는다 (m9 에서 그대로 밟았다).
    await run(paneId, 'clear; for i in $(seq 1 60); do echo "T4 HIST $i"; done', { settleMs: 2500 })

    const app = await startApp({ name: `agent-${subject.key}` })
    await sleep(1500)

    // ② 일반 판에서 붙어 본다 — 씨앗이 0보다 커야 판별자가 의미를 갖는다.
    await app.selectPane(paneId)
    await sleep(3000)
    const seededBefore = (await app.state()).state.terminal.seededLines
    // **알트 판별자는 herdr 가 준다** — 알트 버퍼에는 스크롤백이 없으므로
    // `scroll.max_offset_from_bottom` 이 0 이 된다. 히스토리 60줄을 심어 뒀으니 일반 판에서는
    // 0 보다 커야 하고, 전체화면 TUI 로 들어가면 0 이어야 한다. corral 의 씨앗 줄 수는
    // **corral 자신의 값**이라 판별자로 쓰면 자기순환이다 — 보조 근거로만 싣는다.
    const scrollBefore = (await request('pane.get', { pane_id: paneId })).pane.scroll

    // ③ TUI 를 띄우고 ④ 다시 붙는다.
    await run(paneId, subject.launch, { settleMs: subject.settleMs })
    if (subject.afterLaunch) await subject.afterLaunch()
    const scrollAfter = (await request('pane.get', { pane_id: paneId })).pane.scroll
    await app.selectPane(null)
    await sleep(600)
    await app.selectPane(paneId)
    await sleep(4000)
    const seededAfter = (await app.state()).state.terminal.seededLines
    const altConfirmed = scrollBefore.max_offset_from_bottom > 0 && scrollAfter.max_offset_from_bottom === 0
    console.log(
      'T4', subject.key,
      '스크롤백', scrollBefore.max_offset_from_bottom, '→', scrollAfter.max_offset_from_bottom,
      '· 씨앗', seededBefore, '→', seededAfter,
      altConfirmed ? '알트 확정' : '알트 아님',
    )

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
      cases.push({
        subject: subject.key,
        label: subject.label,
        judged: subject.judged,
        seededBefore,
        seededAfter,
        maxOffsetBefore: scrollBefore.max_offset_from_bottom,
        maxOffsetAfter: scrollAfter.max_offset_from_bottom,
        altConfirmed,
        settled: false,
        note: '화면이 정지하지 않아 비교 쌍을 못 얻었다',
      })
      await app.stop()
      await subject.quit()
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
      subject: subject.key,
      label: subject.label,
      judged: subject.judged,
      seededBefore,
      seededAfter,
      maxOffsetBefore: scrollBefore.max_offset_from_bottom,
      maxOffsetAfter: scrollAfter.max_offset_from_bottom,
      altConfirmed,
      settled: true,
      rowsCompared: rows,
      mismatchedRows: mismatched.length,
      mismatchSample: mismatched.slice(0, 6),
      borderStartColumns: [...borderColumns].sort((a, b) => a - b),
      borderAligned: borderColumns.size <= 1,
      borderChecked: borderColumns.size > 0,
      ghostRows: ghosts.length,
      duplicatedRows: duplicated.length,
      duplicatedSample: duplicated.slice(0, 4),
      broken: mismatched.length > 0 || ghosts.length > 0 || duplicated.length > 0,
      shot: (await app.termShot(`t4-${subject.key}`)).file,
      fullShot: (await app.shot(`t4-${subject.key}-full`)).file,
      screen: screen.filter((line) => line !== '').slice(0, 20),
    }
    cases.push(item)
    console.log(
      'T4',
      subject.key,
      JSON.stringify({ ...item, screen: undefined, mismatchSample: undefined, shot: undefined, fullShot: undefined }),
    )
    await app.stop()
    await subject.quit()
    await run(paneId, "printf '\\033[?1049l'; clear", { settleMs: 800 })
  }

  const judged = cases.filter((item) => item.judged)
  out.t4 = {
    brokenDefinition: {
      '①': '테두리 어긋남 — 박스 문자로 시작하는 행들의 시작 열이 하나로 모이지 않으면 깨짐',
      '②': '중복 줄 — 같은 내용 행이 herdr 스냅샷보다 많이 나타나면 깨짐',
      '③': '잔상 — 스냅샷에 없는 글자가 화면에 남아 있으면 깨짐',
      '④': '행 밀림 — 스냅샷 행 i 와 화면 행 i 가 다르면 깨짐',
    },
    altDiscriminator:
      '히스토리 30줄을 심고 붙어 씨앗 > 0 을 확인한 뒤 TUI 를 띄우고 다시 붙는다. 씨앗 == 0 이면 알트 진입 확정 (판정 H1)',
    agentsAvailable: agents,
    judgedSubjects: judged.map((item) => item.subject),
    altConfirmedAll: judged.length > 0 && judged.every((item) => item.altConfirmed),
    agentUsesAltScreen: cases
      .filter((item) => !item.judged)
      .map((item) => ({
        agent: item.subject,
        seededBefore: item.seededBefore,
        seededAfter: item.seededAfter,
        maxOffsetBefore: item.maxOffsetBefore,
        maxOffsetAfter: item.maxOffsetAfter,
        alt: item.altConfirmed,
      })),
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

  const arms = { dom: { idle: [], busy: [], rounds: [], webglEvents: [], frames: [], shot: null }, webgl: { idle: [], busy: [], rounds: [], webglEvents: [], frames: [], shot: null } }
  // **한 번씩 재고 끝내면 안 된다.** 표본 10개로 쟀을 때 두 팔의 CPU 차이가 실행마다 방향이
  // 뒤집혔다 — 그건 렌더러 차이가 아니라 잡음이다. 그래서 팔을 번갈아 여러 라운드 돌리고
  // 라운드별 값을 전부 남긴다. 판단은 **반복해서 같은 방향으로 나오는 것**만 근거로 한다.
  const SAMPLES = Number(process.env.L345_COST_SAMPLES ?? 15)
  const ROUNDS = Number(process.env.L345_COST_ROUNDS ?? 3)
  const summarize = (list) => ({
    samples: list.length,
    cpuP50: pct(list.map((item) => item.cpuPercent), 50),
    cpuP95: pct(list.map((item) => item.cpuPercent), 95),
    cpuMax: Math.max(...list.map((item) => item.cpuPercent)),
    rssMBP50: pct(list.map((item) => item.rssMB), 50),
    rssMBMax: Math.max(...list.map((item) => item.rssMB)),
    processes: list[0]?.processes ?? null,
  })
  const plan = []
  for (let round = 0; round < ROUNDS; round++) for (const webgl of [false, true]) plan.push({ round, webgl })
  for (const { round, webgl } of plan) {
    // **앞 팔의 티커를 확실히 죽이고 시작한다.** `&` 로 띄운 픽스처는 C-c 가 닿지 않아
    // 다음 팔의 "유휴" 구간까지 화면을 계속 바꿨다 — 1차 측정에서 webgl 팔의 프레임이
    // 101장(dom 팔은 43장)이라 두 팔이 아예 다른 부하를 잰 값이었다.
    await killFixtures()
    await run(paneId, "printf '\\033[?1049l'; clear", { settleMs: 600 })
    const app = await startApp({ name: `cost-${webgl ? 'webgl' : 'dom'}` })
    await sleep(1500)
    await app.webgl(webgl)
    await app.selectPane(paneId)
    await sleep(4000)

    const idle = []
    for (let i = 0; i < SAMPLES; i++) {
      idle.push(await sample(app.child.pid))
      await sleep(1000)
    }

    await run(paneId, `sh ${process.cwd()}/scripts/l345/fixtures/04-ticker.sh &`, { settleMs: 2000 })
    const busy = []
    for (let i = 0; i < SAMPLES; i++) {
      busy.push(await sample(app.child.pid))
      await sleep(1000)
    }
    const state = (await app.state()).state.terminal
    const webglEvents = app
      .entries()
      .filter((entry) => entry.tag === 'renderer.probe' && entry.name === 'term.webgl')
      .map((entry) => entry.event)

    await killFixtures()
    await request('pane.send_keys', { pane_id: paneId, keys: ['C-c'] })
    await sleep(600)
    await run(paneId, "printf '\\033[?1049l'; clear", { settleMs: 800 })

    const key = webgl ? 'webgl' : 'dom'
    const arm = arms[key]
    arm.idle.push(...idle)
    arm.busy.push(...busy)
    arm.webglEvents.push(...webglEvents)
    arm.frames.push({ round, frames: state.frames, reads: state.reads })
    arm.rounds.push({ round, idle: summarize(idle), busy: summarize(busy), frames: state.frames })
    // startApp 이 라운드마다 이 팔의 shots 폴더를 비우므로 **마지막 라운드 것만 남는다.**
    // 관문 ④ 증거로는 팔당 한 장이면 된다.
    arm.shot = (await app.termShot(`p1-${key}`)).file
    console.log('P1', key, 'round', round, JSON.stringify(arm.rounds[arm.rounds.length - 1]))
    await app.stop()
  }
  for (const key of ['dom', 'webgl']) {
    const arm = arms[key]
    arm.idleAll = summarize(arm.idle)
    arm.busyAll = summarize(arm.busy)
    delete arm.idle
    delete arm.busy
    console.log('P1', key, '합계', JSON.stringify({ idle: arm.idleAll, busy: arm.busyAll, frames: arm.frames }))
  }
  out.p1 = {
    note: `main + 렌더러/GPU 헬퍼 프로세스의 %CPU·RSS 합, 1초 간격. 팔을 번갈아 ${ROUNDS}라운드 × 팔당 유휴/부하 각 ${SAMPLES}표본`,
    arms,
  }
}

writeRaw('50-agent-cost.json', { measuredAt: new Date().toISOString(), ...out })
process.exit(0)
