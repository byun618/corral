// M5 — N5(목록 정합: 불일치 0). **밖에서** herdr 를 흔들고 corral 목록이 따라오나 본다.
//
// R1 에는 행 생성·종료 UI 가 없다 (R3). 그래서 변화는 전부 하네스가 herdr 소켓에 직접 건다 —
// 기준 N5 가 말하는 "밖(herdr CLI·소켓)에서 일으킨 변화" 가 그것이다.
//
//   ⓐ 탭 생성        `tab.create`
//   ⓑ 탭 닫기        `tab.close`      → `tab_closed` 한 건만 온다 (pane_closed 안 옴)
//   ⓒ pane exit      셸에 `exit`       → 마지막 pane 이면 `pane_exited` 하나뿐이고
//                                       `workspace_closed` 는 **안 온다**
//   ⓓ 마지막 탭 닫기 `tab.close`       → `workspace_closed` 가 먼저 온다
//   ⓔ 탭 이동        `tab.move`         → `tab_moved` (수정 1회차 M5 로 추가)
//
// **ⓔ 는 id 집합으로 재면 안 된다.** 탭을 옮겨도 id 집합은 그대로라 `sameSet` 이 공짜로 통과한다.
// 판별자는 **순서**다 — corral 목록의 탭 배열과 herdr `tab.list` 의 배열을 자리째 비교한다.
// (그리고 `number` 로 비교해도 안 된다: 실측상 `tab.move` 는 number 를 안 바꾼다 — 00-shapes-fix1.json)
//
// **스냅샷 재조회로 덮어 맞춘 것은 통과가 아니다.** 그래서 회차 구간에 `boot.snapshot.applied`·
// `resync.applied` 가 한 번도 없었음을 로그로 함께 증명한다. 있으면 그 회차는 무효다.
// (그래서 이 실행은 `CORRAL_RESYNC_MS` 를 크게 준다 — 주기 재동기는 N7 이 따로 잰다.)
//
// 대조는 **같은 폴에서** 두 쪽을 뜬다. corral 은 제어 채널의 AppState(=화면이 받는 그것),
// herdr 은 하네스 자기 커넥션의 `tab.list`·`pane.list`·`workspace.list` 다 (제3 오라클).

import { REPO_DIR, herdrTruth, look, request, sleep, startApp, tidySession, until, writeRaw, pct } from './lib.mjs'

const TIMES = Number(process.env.LIFE351_TIMES ?? 5)

await tidySession(REPO_DIR)
const app = await startApp({
  name: 'n5-consistency',
  // 주기 재동기가 회차 안에서 돌면 "이벤트 경로가 맞았다" 를 말할 수 없다 — 1시간으로 민다.
  env: { CORRAL_RESYNC_MS: '3600000' },
})
await sleep(800)
await app.addRepo(REPO_DIR)
await until(async () => (await app.state()).repos.length === 1, { what: '레포 등록' })

const out = { at: new Date().toISOString(), 재동기간격ms: 3600000, cases: { a: [], b: [], c: [], d: [], e: [] } }

/**
 * 어긋난 것을 본 관측과 일치를 본 관측 **사이**의 시간 (수정 2회차 L-9).
 *
 * 처음부터 맞았으면 0 이고, 아니면 두 관측의 단조 시계 차다 — 0.1ms 까지 남긴다.
 * 정수 ms 로 재면 "처음엔 안 맞았는데 0ms 에 수렴" 이라는 모순된 줄이 나온다. 실제로 그런
 * 구간이 있다: 한 번의 `look` 안에서 corral 쪽과 herdr 쪽을 나란히 뜨는데(Promise.all),
 * 그 둘 사이의 미세한 시차 때문에 **그 관측만** 어긋나 보이고 다음 관측은 곧바로 맞는다.
 * 그 사실을 0 으로 뭉개지 않고 0.4ms 처럼 그대로 적는 편이 정직하다.
 */
function 사이ms(first, agreed) {
  if (first.일치) return 0
  if (agreed === null || agreed === undefined) return null
  return Math.round((agreed.mono - first.mono) * 10) / 10
}

/** 그 구간에 스냅샷 재조회가 있었나 — 있으면 "이벤트 경로가 맞았다" 를 말할 수 없다. */
function snapshotsSince(mark) {
  return app
    .entries()
    .filter((entry) => (entry.tag === 'boot.snapshot.applied' || entry.tag === 'resync.applied') && entry.at >= mark)
    .length
}

/** herdr 가 그 변화를 확정한 **바로 그 폴에서** corral 을 함께 뜬다. */
async function watch(done, { everyMs = 20, timeoutMs = 15000 } = {}) {
  let firstLook = null
  const seen = await until(
    async () => {
      const view = await look(app)
      if (!done(view.herdr)) return null
      firstLook = view
      return view
    },
    { what: 'herdr 확정', timeoutMs, everyMs },
  )
  return { ok: seen.ok, ms: seen.ms, 해상도ms: everyMs, firstLook }
}

/**
 * 그 pane 이 **프롬프트에 온** 뒤에 건드린다 — 사용자가 하는 일이 그렇다.
 *
 * **두 번 연속**으로 프롬프트여야 인정한다 (수정 2회차). 한 번만 보면 이 기계의 zsh 시작 스크립트가
 * 곧바로 띄우는 `pyenv-rehash` 사이의 틈을 프롬프트로 착각한다 — 그러면 `exit` 가 그 bash 뒤에
 * 입력 버퍼로 들어가 셸이 안 죽고, 회차가 통째로 헛돈다 (이 회차 실측에서 실제로 났다).
 */
/**
 * `pane.process_info` — 그 pane 이 이미 없으면 `null`.
 *
 * **죽음은 이 케이스의 목표 상태지 오류가 아니다** (수정 3회차). 앞 시도의 `exit` 가 시한
 * 뒤에 뒤늦게 먹으면 다음 폴이 `pane_not_found` 를 받는데, 2회차 하네스는 그걸 그대로
 * throw 해서 실행을 통째로 죽였다 (이번 회차 첫 실행에서 실제로 났다 — ⓒ 진행 중 중단).
 */
async function paneInfo(paneId) {
  try {
    return (await request('pane.process_info', { pane_id: paneId })).process_info
  } catch (error) {
    if (String(error).includes('pane_not_found')) return null
    throw error
  }
}

async function waitPrompt(paneId) {
  const 프롬프트인가 = async () => {
    const info = await paneInfo(paneId)
    if (info === null) return 'gone'
    return info.foreground_processes?.length === 1 && info.shell_pid === info.foreground_process_group_id
  }
  return until(
    async () => {
      const first = await 프롬프트인가()
      if (first === 'gone') return 'gone'
      if (!first) return null
      await sleep(400)
      const second = await 프롬프트인가()
      return second === 'gone' ? 'gone' : second ? true : null
    },
    { what: '프롬프트', timeoutMs: 60000, everyMs: 150 },
  )
}

/**
 * 셸에 `exit` 를 친다 — **herdr 가 그 pane 이 죽은 것을 확인할 때까지**, 필요하면 다시 친다.
 *
 * 왜 재시도가 통과선을 낮추는 게 아닌가: 이 케이스가 재는 것은 "사용자가 exit 해서 pane 이
 * 죽었을 때 목록이 따라오나" 다. 셸이 시작 스크립트에 붙들려 `exit` 를 아직 **실행조차 못 한**
 * 상태는 그 사건이 아직 안 일어난 것이라, 재는 대상이 없다. 몇 번 쳤는지는 원자료에 남긴다.
 */
async function sendExit(paneId, tabId) {
  let 보낸횟수 = 0
  const 죽었나 = async () => {
    const truth = await herdrTruth()
    return !truth.panes.includes(paneId) && !truth.tabs.includes(tabId)
  }
  for (let 시도 = 0; 시도 < 3; 시도++) {
    // 앞 시도가 시한 뒤에 먹었을 수 있다 — 그건 이 케이스가 재려는 그 사건이므로 성공이다.
    if (await 죽었나()) return { 보낸횟수, ok: true, 뒤늦게먹음: 보낸횟수 > 0 }
    const prompt = await waitPrompt(paneId)
    if (prompt.value === 'gone' || (await 죽었나())) return { 보낸횟수, ok: true, 뒤늦게먹음: 보낸횟수 > 0 }
    await request('pane.send_text', { pane_id: paneId, text: 'exit\n' })
    보낸횟수 += 1
    const gone = await until(async () => ((await 죽었나()) ? true : null), {
      what: 'exit 반영',
      timeoutMs: 12000,
      everyMs: 100,
    })
    if (gone.ok) return { 보낸횟수, ok: true, 뒤늦게먹음: false }
  }
  return { 보낸횟수, ok: false, 뒤늦게먹음: false }
}

async function firstWorkspaceId() {
  return (await request('workspace.list', {})).workspaces[0]?.workspace_id ?? null
}

/** herdr 에 탭을 하나 만든다 (밖에서 일으킨 변화). */
async function createTab(workspaceId) {
  const before = new Set((await herdrTruth()).tabs)
  const mark = Date.now()
  const result = await request('tab.create', { workspace_id: workspaceId, cwd: REPO_DIR })
  const tabId = result.tab?.tab_id ?? null
  const paneId = result.root_pane?.pane_id ?? null
  return { mark, tabId, paneId, 새것인가: tabId !== null && !before.has(tabId) }
}

async function record(bucket, row) {
  out.cases[bucket].push(row)
  console.log(
    `${bucket}#${row.round}`,
    row.일치 ? 'OK' : JSON.stringify(row.차이),
    `herdr ${row.herdr확정ms}ms · 수렴 ${row.수렴ms}ms · 스냅샷 ${row.스냅샷재조회}`,
  )
}

/**
 * 한 회차의 공통 꼬리 — herdr 확정 시점 대조 → 수렴까지 대조 → 최종 대조.
 *
 * **수렴ms 는 두 관측의 시각 차다** (수정 2회차 L-9). 1회차는 `until` 이 돌려준 경과를 썼는데,
 * 그 값은 **첫 검사에서 참이면 0** 이다 — 그래서 `처음부터일치: false` 인데 `수렴ms: 0` 인
 * 짝 안 맞는 줄이 나왔다 (N5 ⓔ 3회차). 어긋난 것을 본 폴과 일치한 폴이 다른 관측이면
 * 그 사이는 0 일 수 없다. 표기가 스스로 모순되지 않게 게이트도 같이 싣는다.
 */
async function settle({ bucket, round, mark, done, extra = {} }) {
  const confirmed = await watch(done)
  const first = confirmed.firstLook ?? (await look(app))
  const converged = await until(
    async () => {
      const view = await look(app)
      return view.일치 ? view : null
    },
    { what: '수렴', timeoutMs: 10000, everyMs: 40 },
  )
  const final = await look(app)
  const 수렴ms = 사이ms(first, converged.value)
  await record(bucket, {
    round,
    ...extra,
    게이트: {
      herdr확정: confirmed.ok,
      수렴: converged.ok,
      // 처음부터 일치했을 때만 0 이다. 아니면 두 관측 사이의 실제 시각 차가 들어간다.
      '수렴ms 표기 정합': first.일치 === (수렴ms === 0),
    },
    herdr확정ms: confirmed.ms,
    해상도ms: confirmed.해상도ms,
    처음부터일치: first.일치,
    처음차이: first.일치 ? null : first.차이,
    수렴ms,
    스냅샷재조회: snapshotsSince(mark),
    일치: final.일치,
    차이: final.차이,
    corral: final.corral,
    herdr: final.herdr,
  })
}

// ── ⓐ 탭 생성 ───────────────────────────────────────────────────────────────
for (let round = 1; round <= TIMES; round++) {
  const workspaceId = await firstWorkspaceId()
  const made = await createTab(workspaceId)
  await settle({
    bucket: 'a',
    round,
    mark: made.mark,
    done: (truth) => truth.tabs.includes(made.tabId),
    extra: { tabId: made.tabId, paneId: made.paneId, 새것인가: made.새것인가 },
  })
}

// ── ⓑ 탭 닫기 (`tab_closed` 한 건만 온다) ────────────────────────────────────
for (let round = 1; round <= TIMES; round++) {
  const workspaceId = await firstWorkspaceId()
  const made = await createTab(workspaceId)
  await until(async () => (await look(app)).일치, { what: '준비 수렴', timeoutMs: 10000, everyMs: 40 })
  await waitPrompt(made.paneId)
  const mark = Date.now()
  await request('tab.close', { tab_id: made.tabId })
  await settle({
    bucket: 'b',
    round,
    mark,
    done: (truth) => !truth.tabs.includes(made.tabId),
    extra: { tabId: made.tabId, paneId: made.paneId },
  })
}

// ── ⓒ pane exit — 셸에 진짜 `exit` 를 친다 (`pane_exited` 하나뿐인 경로) ─────
for (let round = 1; round <= TIMES; round++) {
  const workspaceId = await firstWorkspaceId()
  const made = await createTab(workspaceId)
  await until(async () => (await look(app)).일치, { what: '준비 수렴', timeoutMs: 10000, everyMs: 40 })
  const mark = Date.now()
  // 그 탭의 **마지막 pane** 이다 — 프로세스가 죽으면 탭도 herdr 에서 사라진다.
  const 친결과 = await sendExit(made.paneId, made.tabId)
  await settle({
    bucket: 'c',
    round,
    mark,
    done: (truth) => !truth.panes.includes(made.paneId) && !truth.tabs.includes(made.tabId),
    extra: { tabId: made.tabId, paneId: made.paneId, 방법: "pane.send_text 'exit\\n'", exit친횟수: 친결과.보낸횟수, 뒤늦게먹음: 친결과.뒤늦게먹음 },
  })
}

// ── ⓓ 마지막 탭 닫기 (workspace 연쇄) ────────────────────────────────────────
for (let round = 1; round <= TIMES; round++) {
  const stale = (await look(app)).corral.workspaces
  await tidySession(REPO_DIR)
  // **새 workspace 가 corral 에 올 때까지 기다린다.** 낡은 id 를 집으면 회차가 통째로 헛돈다.
  const fresh = await until(
    async () => {
      const state = await app.state()
      const workspaces = state.repos
        .flatMap((repo) => repo.worktrees.map((wt) => wt.workspace).filter((item) => item !== null))
        .filter((item) => !stale.includes(item.workspaceId))
      const row = workspaces[0]
      return row !== undefined && row.tabs.length > 0 ? { workspaceId: row.workspaceId, tabId: row.tabs[0].tabId } : null
    },
    { what: '새 workspace 반영', timeoutMs: 20000, everyMs: 60 },
  )
  if (!fresh.ok) throw new Error('ⓓ 준비 실패 — 새 workspace 가 corral 에 안 왔다')
  const { workspaceId, tabId } = fresh.value
  const paneId = (await request('pane.list', {})).panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null
  await waitPrompt(paneId)
  const mark = Date.now()
  await request('tab.close', { tab_id: tabId })
  await settle({
    bucket: 'd',
    round,
    mark,
    done: (truth) => !truth.workspaces.includes(workspaceId),
    extra: { workspaceId, tabId, paneId },
  })
}

// ── ⓔ 탭 이동 (`tab_moved`) — **순서**로 잰다 ──────────────────────────────
/** corral 화면의 탭 순서(그 workspace 안) · herdr tab.list 의 탭 순서. */
async function orderLook(workspaceId) {
  const [state, list] = await Promise.all([app.state(), request('tab.list', { workspace_id: workspaceId })])
  const rows = state.repos.flatMap((repo) =>
    repo.worktrees.map((wt) => wt.workspace).filter((item) => item !== null),
  )
  const corral = (rows.find((row) => row.workspaceId === workspaceId)?.tabs ?? []).map((tab) => tab.tabId)
  const herdr = list.tabs.map((tab) => tab.tab_id)
  return { at: Date.now(), mono: performance.now(), corral, herdr, 일치: JSON.stringify(corral) === JSON.stringify(herdr) }
}

for (let round = 1; round <= TIMES; round++) {
  const stale = (await look(app)).corral.workspaces
  await tidySession(REPO_DIR)
  const fresh = await until(
    async () => {
      const id = await firstWorkspaceId()
      if (id === null || stale.includes(id)) return null
      const seen = await orderLook(id)
      return seen.corral.length > 0 ? id : null
    },
    { what: 'ⓔ 새 workspace 반영', timeoutMs: 20000, everyMs: 60 },
  )
  if (!fresh.ok) throw new Error('ⓔ 준비 실패')
  const workspaceId = fresh.value
  // 탭 셋을 만들고 corral 이 따라온 뒤에 옮긴다 — 준비 구간의 지연이 회차 수치에 섞이지 않게.
  for (let i = 0; i < 2; i++) await request('tab.create', { workspace_id: workspaceId, cwd: REPO_DIR })
  await until(async () => (await orderLook(workspaceId)).corral.length === 3 && (await orderLook(workspaceId)).일치, {
    what: 'ⓔ 준비 수렴',
    timeoutMs: 15000,
    everyMs: 40,
  })
  const before = await orderLook(workspaceId)
  const target = before.herdr[before.herdr.length - 1]
  const mark = Date.now()
  await request('tab.move', { tab_id: target, insert_index: 0 })

  const confirmed = await until(
    async () => {
      const seen = await orderLook(workspaceId)
      return seen.herdr[0] === target ? seen : null
    },
    { what: 'ⓔ herdr 확정', timeoutMs: 15000, everyMs: 20 },
  )
  const first = confirmed.value ?? (await orderLook(workspaceId))
  const converged = await until(
    async () => {
      const seen = await orderLook(workspaceId)
      return seen.일치 ? seen : null
    },
    { what: 'ⓔ 수렴', timeoutMs: 10000, everyMs: 40 },
  )
  const final = await orderLook(workspaceId)
  const e수렴ms = 사이ms(first, converged.value)
  out.cases.e.push({
    round,
    workspaceId,
    옮긴탭: target,
    게이트: { herdr확정: confirmed.ok, 수렴: converged.ok, '수렴ms 표기 정합': first.일치 === (e수렴ms === 0) },
    herdr확정ms: confirmed.ms,
    해상도ms: 20,
    옮기기전: before,
    처음부터일치: first.일치,
    수렴ms: e수렴ms,
    스냅샷재조회: snapshotsSince(mark),
    // id 집합만 보면 공짜로 통과한다는 것을 원자료에 남긴다 — 판별자가 순서임을 보이는 자리다.
    'id 집합으로는 구분되나': JSON.stringify([...final.corral].sort()) !== JSON.stringify([...final.herdr].sort()),
    일치: final.일치,
    차이: final.일치 ? null : { corral: final.corral, herdr: final.herdr },
    corral: final.corral,
    herdr: final.herdr,
  })
  console.log(`e#${round}`, final.일치 ? 'OK' : JSON.stringify(final), `수렴 ${e수렴ms}ms`)
}

const roll = (rows) => ({
  회차: rows.length,
  불일치: rows.filter((item) => !item.일치).length,
  게이트실패: rows.filter((item) => !item.게이트.herdr확정 || !item.게이트.수렴 || !item.게이트['수렴ms 표기 정합'])
    .length,
  스냅샷재조회합: rows.reduce((sum, item) => sum + item.스냅샷재조회, 0),
  처음부터일치: rows.filter((item) => item.처음부터일치 === true).length,
  수렴ms: rows.map((item) => item.수렴ms),
  'herdr확정ms p50': pct(rows.map((item) => item.herdr확정ms), 50),
})
out.요약 = {
  'ⓐ 탭 생성': roll(out.cases.a),
  'ⓑ 탭 닫기': roll(out.cases.b),
  'ⓒ pane exit (마지막 pane)': roll(out.cases.c),
  'ⓓ 마지막 탭 닫기 (workspace 연쇄)': roll(out.cases.d),
  'ⓔ 탭 이동 (순서 비교)': roll(out.cases.e),
}
out.판정 = {
  '5케이스 × 5회': Object.values(out.요약).every((item) => item.회차 === TIMES),
  '불일치 합': Object.values(out.요약).reduce((sum, item) => sum + item.불일치, 0),
  '게이트실패 합': Object.values(out.요약).reduce((sum, item) => sum + item.게이트실패, 0),
  '스냅샷 재조회 합 (0이어야 이벤트 경로다)': Object.values(out.요약).reduce((sum, item) => sum + item.스냅샷재조회합, 0),
  'ⓔ 가 id 집합으로 구분되지 않는 회차 (전부여야 순서가 판별자다)': out.cases.e.filter(
    (row) => row['id 집합으로는 구분되나'] === false,
  ).length,
  '수렴ms 표기가 처음부터일치와 짝지나 (전 회차)': Object.values(out.cases)
    .flat()
    .every((row) => row.게이트['수렴ms 표기 정합'] === true),
}
// 이벤트 경로가 실제로 무엇을 했는지 — 적용 note 를 그대로 싣는다 (연쇄 삭제의 지문).
out.이벤트적용 = app
  .entries()
  .filter((entry) => entry.tag === 'push.applied')
  .map((entry) => ({ at: entry.at, event: entry.event, changed: entry.changed, note: entry.note }))
console.log(JSON.stringify({ 요약: out.요약, 판정: out.판정 }, null, 2))
writeRaw('n5-list-consistency.json', out)
await app.stop()
await tidySession(REPO_DIR)
