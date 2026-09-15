// 수정 라운드 4 — G5. **herdr 기본 label 을 사용자 이름으로 오인한다** (높음).
//
// 사용자가 실환경에서 본 셋(셸 탭이 `1` · 제목이 `ai-title` 로 안 바뀜 · main 의 claude 가 `1`·`2`)이
// 한 원인이었다: `userLabel` 이 기본 label 을 **`String(number)` 와 같은지**로만 가려냈는데,
// herdr 의 기본 label 은 **워크스페이스 안 1-기반 위치**이고 탭을 닫으면 다시 매겨진다
// (`04-gate1-check.md` §7 실측표). 그래서 **탭을 하나라도 닫으면** 기본 label 이 사용자 이름으로
// 읽히고, 맨 위 티어라 아래 티어가 전부 가려진다.
//
// 재발 방지 본체는 **단위 테스트**다 (`session-title.test.ts` 의 실측표). 여기서는 앱 안에서도
// 같은 판정이 나는지를 **탭을 만들고 가운데를 닫은** 워크스페이스에서 본다 (지시문은 3개,
// 여기서는 4개 — 3개면 셸 칸이 판별력을 잃는다. 이유는 아래 탭 만드는 자리의 주석):
//
//   ⓐ 셸 탭이 `<브랜치> N` 으로 뜬다 (숫자 하나가 아니라)
//   ⓑ claude 탭이 `ai-title` 로 뜬다 (없는 동안은 `claude N`)
//   ⓒ `renameRow` 사전 차단 — **자리 번호로 개명하는 것**을 막고 알린다
//
// 관문 ⑤ 반례:
//   · 같은 실행 안: 자리 번호가 아닌 이름(`357`)은 **산다** (LIFE-357 J-4 회귀 — 차단이 넓어지면 죽는다)
//   · 별도 실행: 고침을 뺀 채 다시 빌드해 돌리면 ⓐⓑ 가 `1`·`2` 로 되돌아간다 (`r4-counterexample/`)
//
// 격리(관문 ④): 앱·herdr 세션·스크래치 레포 전부 격리 HOME. 사용자 HOME 에는 아무것도 안 쓴다.

import fs from 'node:fs'
import path from 'node:path'
import {
  SESSION,
  createTab,
  herdrCall,
  isolatedHome,
  makeScratchRepo,
  resetSession,
  sleep,
  startApp,
  tabsOf,
  until,
  writeRaw,
} from './lib.mjs'

const BRANCH = 'LIFE-366-r4-label'
const AI_TITLE = '기본 label 에 가려져 있던 이름'
const USER_NAME = '357'

/** 메인 탭바를 **DOM 에서** 읽는다 — 상태가 아니라 그려진 결과를 본다. */
async function readTabs(app) {
  const code = `(() => [...document.querySelectorAll('.main-tab')].map((tab) => ({
    tabId: tab.getAttribute('data-main-tab'),
    label: (tab.querySelector('.main-tab-label') ?? {}).textContent ?? null,
    active: tab.classList.contains('is-active'),
  })))()`
  return (await app.send({ cmd: 'eval', code })).result
}

/** 인라인 알림(`InlineNotice`) 의 글월 — 사전 차단이 **말을 했는지** 본다. */
async function readNotices(app) {
  return (await app.send({ cmd: 'eval', code: `(() => [...document.querySelectorAll('.inline-notice')].map((el) => el.textContent))()` })).result
}

/**
 * corral 이 들고 있는 (label, number, 자리) 와 **herdr 가 지금 주는 값**을 나란히 놓는다.
 *
 * 판별자가 위치를 보는 이상, corral 의 label 이 herdr 의 다시 매긴 값을 **실제로 받아 오는지**가
 * 전제다. 안 받아 오면(늦은 봉투로 옛 label 이 남으면) 위치 비교가 헛돈다 — 그래서 잰다.
 */
async function labelTable(app, worktreePath) {
  const corral = await tabsOf(app, worktreePath)
  const herdr = (await herdrCall('tab.list', {})).result?.tabs ?? []
  return corral.map((tab, index) => {
    const mine = herdr.find((item) => item.tab_id === tab.tabId) ?? null
    return {
      tabId: tab.tabId,
      위치: index + 1,
      'corral label': tab.label,
      'corral number': tab.number,
      'herdr label': mine?.label ?? null,
      'herdr number': mine?.number ?? null,
      같은가: mine !== null && mine.label === tab.label && mine.number === tab.number,
    }
  })
}

/** 탭 하나를 닫는다 — 에이전트 탭이면 종료 확인 모달을 거친다. */
async function closeTab(app, tabId) {
  await app.click(`[data-main-tab-close="${tabId}"]`)
  await sleep(300)
  if ((await app.query('[data-confirm-close-modal]')).found.length > 0) await app.click('[data-close-confirm-ok]')
  return until(async () => (await app.query(`[data-main-tab="${tabId}"]`)).found.length === 0, {
    timeoutMs: 20000,
    everyMs: 200,
    what: `탭 ${tabId} 이 닫힌다`,
  })
}

/** 탭 이름을 인라인 편집으로 바꾼다 (사용자 손과 같은 경로 — 사전 차단이 여기 붙어 있다). */
async function renameTab(app, tabId, label) {
  await app.dblclick(`[data-main-tab="${tabId}"]`)
  await sleep(300)
  await app.key('a', ['meta'])
  await app.type(label)
  await app.key('Enter')
  await sleep(600)
}

async function main() {
  const out = { at: new Date().toISOString(), session: SESSION, isolatedHome: isolatedHome() }
  out['세션 초기화'] = await resetSession()
  fs.rmSync(path.join(isolatedHome(), '.claude', 'projects', 'l366-r4'), { recursive: true, force: true })

  const repo = makeScratchRepo('r4-label')
  repo.git('checkout', '-b', BRANCH)
  out['스크래치 레포'] = { root: repo.root, branch: BRANCH, leaf: path.basename(repo.root) }

  const app = await startApp({ name: '20-r4-label' })
  out.appReady = app.ready
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length === 1, { timeoutMs: 15000, what: 'worktree row' })
  await app.click(`[data-worktree="${repo.root}"]`)
  const opened = await until(async () => (await tabsOf(app, repo.root)).length > 0, { timeoutMs: 30000, what: 'worktree opened' })
  out['worktree 열림'] = { ok: opened.ok, ms: opened.ms }

  // --- 탭 4개: 셸(기본) · 셸 · 셸 · claude --------------------------------------------
  //
  // 지시문은 "탭 3개를 만들고 가운데를 닫는다" 인데, 3개로는 **셸 탭 칸이 판별력을 잃는다**:
  // 가운데를 닫으면 자리가 밀리는 건 뒤쪽 탭뿐이라 살아남는 셸(첫 탭)은 `label === number` 그대로다
  // (옛 판별자로도 통과한다). 그래서 셸을 하나 더 만들어 **닫힌 자리 뒤에 셸과 claude 를 하나씩**
  // 둔다 — 두 칸 다 `label !== number` 가 되는 모양이 사용자 실환경(`wS`)과 같은 모양이다.
  for (const nth of ['두 번째 탭', '세 번째 탭']) {
    const count = (await tabsOf(app, repo.root)).length
    await app.click('[data-main-tabbar-add]')
    await until(async () => (await tabsOf(app, repo.root)).length === count + 1, { timeoutMs: 20000, everyMs: 200, what: nth })
  }
  await createTab(app, repo.root, 'claude')
  const four = await until(
    async () => {
      const tabs = await tabsOf(app, repo.root)
      return tabs.length === 4 && tabs.some((tab) => tab.panes.some((pane) => pane.agent !== null)) ? tabs : false
    },
    { timeoutMs: 40000, everyMs: 300, what: '네 번째 탭(claude)' },
  )
  const before = four.value ?? (await tabsOf(app, repo.root))
  out['① 탭 4개 (닫기 전)'] = { 표: await labelTable(app, repo.root), 그려진_제목: await readTabs(app) }

  // --- 가운데를 닫는다 — 여기서부터 herdr 가 label 을 다시 매긴다 ------------------------
  const middle = before[1]
  out['② 가운데 탭 닫기'] = { tabId: middle.tabId, 닫혔나: (await closeTab(app, middle.tabId)).ok }
  const table = await until(
    async () => {
      const rows = await labelTable(app, repo.root)
      return rows.length === 3 ? rows : false
    },
    { timeoutMs: 20000, everyMs: 200, what: '닫은 뒤 탭 3개' },
  )
  const afterClose = table.value ?? (await labelTable(app, repo.root))
  out['③ 닫은 직후 label 표 (resync 전)'] = {
    표: afterClose,
    'herdr 와 같은가': afterClose.every((row) => row.같은가),
    설명:
      '**닫기 봉투만으로는 label 이 안 따라온다** — herdr 는 이미 다시 매겼는데 corral 은 옛 label 을 ' +
      '들고 있다. 그래서 이 순간에는 `label === String(number)` 라 옛 판별자로도 안 깨진다. ' +
      '사용자 실환경이 깨진 것은 그 뒤 목록을 다시 받은 상태였기 때문이다(`wS`: label 1·2·3 / number 5·6·7).',
  }

  // **목록을 다시 받는다** — 앱 재시작·재동기가 하는 일이다. 여기서부터 corral 의 label 이
  // herdr 의 위치 값이 되고, 그게 사용자 실환경에서 본 상태다 (그 전에는 결함이 안 뜬다).
  await app.send({ cmd: 'resync', reason: 'l366-r4-relabel' })
  const synced = await until(
    async () => {
      const rows = await labelTable(app, repo.root)
      return rows.length === 3 && rows.every((row) => row.같은가) ? rows : false
    },
    { timeoutMs: 20000, everyMs: 300, what: 'resync 뒤 label 이 herdr 와 같아진다' },
  )
  const after = synced.value ?? (await labelTable(app, repo.root))
  out['③ resync 뒤 label 표'] = {
    표: after,
    'herdr 와 같은가': after.every((row) => row.같은가),
    '기본 label 이 위치인가': after.every((row) => row['corral label'] === String(row.위치)),
    'label 과 number 가 갈렸나': after.some((row) => row['corral label'] !== String(row['corral number'])),
    ms: synced.ms,
    설명: '여기가 사용자 실환경과 같은 상태다 — 이 표가 성립해야 ⓐⓑ 가 판별력을 갖는다.',
  }

  // 닫은 뒤 두 탭(셸 하나 · claude 하나)이 **둘 다 보일 때까지** 기다린다. 에이전트 표시는 pane
  // 갱신을 한 박자 늦게 타는 주기가 있어서, 바로 읽으면 claude 탭이 셸로 보이는 순간을 잡는다
  // (한 실행이 거기서 죽었다).
  const pair = await until(
    async () => {
      const rows = await tabsOf(app, repo.root)
      // **자리가 밀린** 행만 고른다 (`label !== String(number)`) — 안 밀린 행은 옛 판별자로도
      // 통과해서 판별력이 없다.
      const shellRow = rows.find((tab) => tab.panes.length > 0 && tab.panes.every((pane) => pane.agent === null) && tab.label !== String(tab.number)) ?? null
      const agentRow = rows.find((tab) => tab.panes.some((pane) => pane.agent !== null) && tab.label !== String(tab.number)) ?? null
      return shellRow !== null && agentRow !== null ? { shell: shellRow, agent: agentRow } : false
    },
    { timeoutMs: 30000, everyMs: 300, what: '닫은 뒤 자리가 밀린 셸 탭 · claude 탭' },
  )
  out['④ 닫은 뒤 두 탭'] = {
    찾았나: pair.ok,
    ms: pair.ms,
    탭: (await tabsOf(app, repo.root)).map((tab) => ({ tabId: tab.tabId, label: tab.label, number: tab.number, agents: tab.panes.map((pane) => pane.agent) })),
  }
  if (!pair.ok) throw new Error('닫은 뒤 셸/claude 탭을 못 찾았다 — 원자료 ④ 표를 봐라')
  const shell = pair.value.shell
  const agent = pair.value.agent
  const drawnOf = async (tabId) => (await readTabs(app)).find((row) => row.tabId === tabId)?.label ?? null

  // --- ⓐ 셸 탭이 브랜치를 보인다 ------------------------------------------------------
  const shellTitle = await until(async () => ((await drawnOf(shell.tabId)) === `${BRANCH} ${shell.number}` ? true : false), {
    timeoutMs: 15000,
    everyMs: 200,
    what: 'ⓐ 셸 탭이 브랜치 티어',
  })
  out['ⓐ 셸 탭 제목'] = {
    tabId: shell.tabId,
    label: shell.label,
    number: shell.number,
    '그려진 제목': await drawnOf(shell.tabId),
    기대: `${BRANCH} ${shell.number}`,
    통과: shellTitle.ok,
  }

  // --- ⓑ claude 탭 — ai-title 이 없는 동안은 `claude N`, 오면 그 이름 ---------------------
  out['ⓑ-1 ai-title 전 claude 탭'] = {
    tabId: agent.tabId,
    label: agent.label,
    number: agent.number,
    '그려진 제목': await drawnOf(agent.tabId),
    기대: `claude ${agent.number}`,
    통과: (await drawnOf(agent.tabId)) === `claude ${agent.number}`,
  }

  // ai-title 을 깔고 **참조를 주입한다** (r3 반례 ⓑ 와 같은 경로 — 이 격리 HOME 에는 통합 훅이
  // 없어서 에이전트가 스스로 참조를 보고하지 않는다).
  //
  // ⚠ id 는 **격리 HOME 전체에서 유일**해야 한다. 1차 실행은 `4444…004` 를 썼는데 1회차 D 프로브가
  // 만들어 둔 같은 id 의 파일(`l366-d/`, 199바이트)이 남아 있어서, 판독층이 폴더를 훑다가 **그쪽을**
  // 집었다 — 참조는 앉았는데 ai-title 은 영영 안 왔다. 그래서 여기서 충돌을 먼저 확인한다.
  const id = 'a4a4a4a4-b4b4-4b4b-8b4b-000000000044'
  const projects = path.join(isolatedHome(), '.claude', 'projects')
  const collisions = fs
    .readdirSync(projects)
    .map((folder) => path.join(projects, folder, `${id}.jsonl`))
    .filter((candidate) => fs.existsSync(candidate))
  const dir = path.join(projects, 'l366-r4')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    [
      JSON.stringify({ type: 'ai-title', sessionId: id, aiTitle: AI_TITLE, timestamp: new Date().toISOString() }),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: '하네스가 지어낸 문장이다.' }] },
      }),
    ].join('\n') + '\n',
  )
  out['참조 주입'] = {
    'id 충돌': collisions,
    보고: await herdrCall('pane.report_agent_session', {
      pane_id: agent.panes[0].paneId,
      source: 'herdr:claude',
      agent: 'claude',
      seq: Date.now(),
      agent_session_id: id,
    }),
  }
  await app.send({ cmd: 'resync', reason: 'l366-r4-ref' })
  const titled = await until(async () => ((await drawnOf(agent.tabId)) === AI_TITLE ? true : false), {
    timeoutMs: 30000,
    everyMs: 300,
    what: 'ⓑ claude 탭이 ai-title',
  })
  out['ⓑ-2 ai-title 이 온 claude 탭'] = {
    'ai-title': AI_TITLE,
    '그려진 제목': await drawnOf(agent.tabId),
    'id 가 유일한가': collisions.length === 0,
    통과: titled.ok,
    ms: titled.ms,
  }
  const shotMain = await app.shot('r4-titles-after-close')

  // --- ⓒ `renameRow` 사전 차단 — 자리 번호는 막고, 다른 이름은 산다 ----------------------
  //
  // claude 탭은 **자리 2 · number 3** 이다. `"2"` 는 위치 판별자만 잡는다 — number 만 보던
  // 옛 차단은 이 이름을 그대로 보냈고, 보낸 뒤에는 제목이 조용히 안 바뀌었다.
  const position = (await tabsOf(app, repo.root)).findIndex((tab) => tab.tabId === agent.tabId) + 1
  const titleBeforeRename = await drawnOf(agent.tabId)
  await renameTab(app, agent.tabId, String(position))
  const notices = await readNotices(app)
  out['ⓒ-1 자리 번호로 개명 → 막힌다'] = {
    tabId: agent.tabId,
    친_이름: String(position),
    위치: position,
    number: agent.number,
    알림: notices,
    // **막았다고 말했는지**가 이 칸의 판별력이다 — 제목만 보면 안 된다. 고침을 빼면 이 이름이
    // 그대로 저장되는데, 그 이름은 어차피 기본 표찰과 **같은 문자열**이라 화면이 안 바뀐다.
    '막았다고 알렸나': notices.some((text) => typeof text === 'string' && text.includes('기본 표찰과 같아')),
    '그려진 제목': await drawnOf(agent.tabId),
    '개명 전 제목': titleBeforeRename,
    '제목이 그대로인가': (await drawnOf(agent.tabId)) === titleBeforeRename,
    'herdr label 이 그대로인가':
      ((await herdrCall('tab.list', {})).result?.tabs ?? []).find((item) => item.tab_id === agent.tabId)?.label === String(position),
  }
  const shotBlocked = await app.shot('r4-rename-blocked')

  // 반례 — 자리 번호가 **아닌** 이름은 살아야 한다 (LIFE-357 J-4 회귀).
  await renameTab(app, agent.tabId, USER_NAME)
  const named = await until(async () => ((await drawnOf(agent.tabId)) === USER_NAME ? true : false), {
    timeoutMs: 10000,
    everyMs: 200,
    what: '관문⑤ 반례 — `357` 은 이름으로 산다',
  })
  out['ⓒ-2 관문⑤ 반례 — 357 은 이름이다'] = {
    친_이름: USER_NAME,
    '그려진 제목': await drawnOf(agent.tabId),
    통과: named.ok,
    설명: '차단이 숫자 전체로 넓어지면 여기서 깨진다 (J-4 가 고친 자리).',
  }

  out.판정 = {
    '잰 행이 자리가 밀린 행인가 (판별력)': shell.label !== String(shell.number) && agent.label !== String(agent.number),
    'ⓐ 셸 탭이 브랜치 티어': out['ⓐ 셸 탭 제목'].통과,
    'ⓑ-1 ai-title 전에는 claude N': out['ⓑ-1 ai-title 전 claude 탭'].통과,
    'ⓑ-2 ai-title 이 제목이 된다': out['ⓑ-2 ai-title 이 온 claude 탭'].통과,
    'ⓒ-1 자리 번호 개명이 막힌다':
      out['ⓒ-1 자리 번호로 개명 → 막힌다']['막았다고 알렸나'] && out['ⓒ-1 자리 번호로 개명 → 막힌다']['제목이 그대로인가'],
    'ⓒ-2 다른 이름은 산다': out['ⓒ-2 관문⑤ 반례 — 357 은 이름이다'].통과,
    '기본 label 이 위치다 (실측)': out['③ resync 뒤 label 표']['기본 label 이 위치인가'],
    'label 과 number 가 갈린 상태다 (옛 판별자가 뚫리는 조건)': out['③ resync 뒤 label 표']['label 과 number 가 갈렸나'],
  }
  out.샷 = { shotMain, shotBlocked }
  await app.stop()
  writeRaw('r4-label.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out.판정, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
