// M1 — N1(4종이 실제로 뜬다) · N2(기동 중과 기동 완료를 구분해 보인다) · A4(cwd 정책)
//
// 판정 규칙은 하나다: **`agent.start` 의 응답을 근거로 쓰지 않는다.** 4종 각각에 대해
// `pane.process_info` 의 `foreground_processes[0].cmdline` 을 떠서 원자료로 남긴다 (관문 ④).
//
// N2 는 그 사이 구간을 화면에 정직하게 그렸는지를 묻는다. 그래서 느린 쪽(grok)에서 **누른
// 순간부터 관측될 때까지** 사이드바를 연속으로 찍고, 각 샷과 같은 시각의 `phase` 를 함께 적는다.

import {
  clickLog,
  createRowByUi,
  firstWorkspaceId,
  herdrTruth,
  paneProcesses,
  request,
  sleep,
  startApp,
  tidySession,
  until,
  writeRaw,
} from './lib.mjs'

const KINDS = ['shell', 'claude', 'codex', 'grok']

await tidySession()
const app = await startApp({ name: 'm1-create' })
const workspaceId = await firstWorkspaceId(app)
const out = { at: new Date().toISOString(), workspaceId, kinds: [], n2: [], cwd: null }

for (const kind of KINDS) {
  const before = new Set((await herdrTruth()).tabs)
  const clickedAt = Date.now()
  await createRowByUi(app, workspaceId, kind)

  // 어느 탭이 새로 생겼나 — 그림이 아니라 herdr 에게 묻는다.
  const grew = await until(
    async () => (await herdrTruth()).tabs.find((tabId) => !before.has(tabId)) ?? null,
    { what: `${kind} 새 탭`, timeoutMs: 15000 },
  )
  const tabId = grew.value
  // pane id 를 탭 id 에서 **지어내지 않는다** — herdr 에게 묻는다.
  const paneId =
    tabId === null
      ? null
      : ((await request('pane.list', {})).panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null)

  // N2 의 연속 기록은 **에이전트 3종 전부**에서 뜬다. 기준은 느린 쪽 하나면 된다고 하지만
  // 어느 쪽이 느릴지는 회차마다 다르다 — 실제로 grok 이 0.6초, claude 가 6.2초인 회차가 있었다.
  const shots = []
  const trace = []
  const shooting = kind !== 'shell'
  const expected = kind === 'shell' ? ['zsh', 'bash', 'sh'] : [kind]

  /**
   * **판정은 우리가 직접 뜨는 `process_info` 로 한다.** 앱의 `phase` 는 같은 시각에 나란히
   * 적기만 한다 — 재는 대상 자신의 보고를 판별자로 쓰지 않는다 (LIFE-345 §R2).
   */
  const settled = await until(
    async () => {
      const at = Date.now()
      const processes = paneId === null ? { shellPid: null, foreground: [] } : await paneProcesses(paneId)
      const state = await app.state()
      const launch = state.lifecycle.launches.find((item) => item.paneId === paneId) ?? null
      const named = processes.foreground.filter((item) =>
        // argv0·name 이 빠진 채로 오는 프로세스가 있다 — 지어내지 말고 빈 문자열로 본다.
        expected.some(
          (want) => (item.argv0 ?? '').replace(/^-/, '') === want || (item.name ?? '').replace(/\.exe$/, '') === want,
        ),
      )
      // 셸은 **혼자** 포그라운드에 있을 때가 프롬프트다. 갓 만든 pane 은 zsh 기동 파이프라인이
      // 같이 떠 있어서, 그걸 "셸이 준비됐다" 로 읽으면 너무 이르게 적는다.
      const hit = (kind === 'shell' ? (processes.foreground.length === 1 ? named[0] : undefined) : named[0]) ?? null
      trace.push({
        at,
        sinceClickMs: at - clickedAt,
        appPhase: launch?.phase ?? 'gone',
        busyRetries: launch?.busyRetries ?? null,
        foreground: processes.foreground.map((item) => item.cmdline),
        hit: hit?.cmdline ?? null,
      })
      if (shooting && shots.length < 60) {
        const shot = await app.shot(`n2-${kind}-${launch?.phase ?? 'gone'}`, '.panel.grow')
        shots.push({
          seq: shot.seq,
          file: shot.file,
          at: shot.at,
          sinceClickMs: shot.at - clickedAt,
          appPhase: launch?.phase ?? 'gone',
          foreground: processes.foreground.map((item) => item.cmdline),
        })
      }
      return hit === null ? null : { hit, processes }
    },
    { what: `${kind} 기동 관측`, timeoutMs: 45000, everyMs: shooting ? 400 : 500 },
  )

  // N2 — **전이가 화면에 오는 것까지** 찍는다. 우리 관측이 먼저 히트해도 앱은 자기 폴링
  // 주기(600ms) 뒤에 안다. 그 뒤 화면이 실제로 바뀌는 것을 보여야 항목이 답해진다.
  let appSettled = null
  if (shooting) {
    const after = await until(
      async () => {
        const state = await app.state()
        const launch = state.lifecycle.launches.find((item) => item.paneId === paneId) ?? null
        const shot = await app.shot(`n2-${kind}-${launch?.phase ?? 'gone'}`, '.panel.grow')
        shots.push({
          seq: shot.seq,
          file: shot.file,
          at: shot.at,
          sinceClickMs: shot.at - clickedAt,
          appPhase: launch?.phase ?? 'gone',
          foreground: (await paneProcesses(paneId)).foreground.map((item) => item.cmdline),
        })
        return launch === null || launch.phase === 'running' || launch.phase === 'failed' ? (launch ?? { phase: 'turned' }) : null
      },
      { what: 'grok 앱 상태 전이', timeoutMs: 20000, everyMs: 300 },
    )
    appSettled = { ok: after.ok, ms: after.ms, phase: after.value?.phase ?? null }
  }

  const processes = paneId === null ? null : await paneProcesses(paneId)
  out.kinds.push({
    kind,
    clickedAt,
    tabId,
    paneId,
    tabAppearedMs: grew.ms,
    /**
     * **기점을 둘 다 적는다** (1차 리뷰 낮음 1 — codex·claude).
     * 1회차는 `observedMs` 하나만 싣고 결과 문서가 그걸 "클릭부터" 로 읽었다. 실제로는 새 탭을
     * 찾은 **뒤** 시작한 관측 루프의 경과다. 두 기점 차가 탭이 목록에 뜨는 시간(100~400ms)이다.
     */
    observedSinceClickMs: trace.find((item) => item.hit !== null)?.sinceClickMs ?? null,
    /** 관측 루프 기준 — 새 탭을 찾은 뒤부터 그 프로그램을 볼 때까지 */
    observedMs: settled.ok ? settled.ms : null,
    observed: settled.ok,
    /** ← 이 칸이 N1 의 근거다. 앱이 뭐라 했든 pane 의 포그라운드가 이것이다 */
    observedCmdline: settled.value?.hit?.cmdline ?? null,
    observedPid: settled.value?.hit?.pid ?? null,
    foregroundAtEnd: processes?.foreground ?? [],
    shellPid: processes?.shellPid ?? null,
    trace,
  })
  if (shooting) out.n2.push({ kind, clickedAt, shots, appSettled })
  console.log(kind, '→', settled.value?.hit?.cmdline ?? 'MISS', `${settled.ms}ms`)
}

// ── A4 — 새 행이 어느 cwd 에서 열렸나 ───────────────────────────────────────
const firstPane = out.kinds.find((item) => item.paneId !== null)
out.cwd = {
  정책: 'workspace 의 checkoutPath → 없으면 그 workspace pane 의 cwd → 둘 다 모르면 cwd 생략(herdr 세션 launch cwd)',
  로그: app.entries().filter((entry) => entry.tag === 'life.create.request').map((entry) => ({ kind: entry.kind, cwd: entry.cwd })),
  실제: firstPane === undefined ? null : (await request('pane.get', { pane_id: firstPane.paneId })).pane?.cwd ?? null,
}

const full = await app.shot('n1-four-kinds')
out.finalShot = full.file
out.herdrAfter = await herdrTruth()
out.corralAfter = (await app.state()).workspaces.map((row) => ({
  workspaceId: row.workspaceId,
  tabs: row.tabs.map((tab) => ({ tabId: tab.tabId, panes: tab.panes.map((pane) => `${pane.paneId}:${pane.agent ?? '-'}`) })),
}))

out.클릭증거 = clickLog()
writeRaw('n1-create-kinds.json', out)
await sleep(300)
await app.stop()
await tidySession()
