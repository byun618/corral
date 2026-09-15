// 수정 라운드 3 — 게이트 ① 실환경 확인에서 나온 셋을 **화면에서** 잰다.
//
//   G1 셸 프롬프트 제목 필터 (`:~` 가 안 걸러졌다)
//   G2 새 탭이 포커스를 안 받는다 (`+ 빈 탭` · ⌘T 둘 다)
//   G3 셸 탭 제목의 **브랜치** 티어
//
// G1 의 재발 방지 본체는 **단위 테스트**다 (`session-title.test.ts` 에 실환경 실측 4줄을 박았다).
// 여기서는 그 필터가 **앱 안에서도** 같은 판정을 내는지만 확인한다 — 실환경 문자열을 격리 셸 pane 에
// OSC 2 로 쏴서(= herdr 가 실제로 주는 경로와 같은 경로) 제목이 브랜치 티어로 내려가는지 본다.
// **사용자 HOME 에는 아무것도 안 쓴다** (관문 ④): 앱·herdr·스크래치 레포 전부 격리 HOME 이고,
// 실환경에서 가져오는 것은 **문자열 4줄뿐**이다.
//
// 관문 ⑤ 반례:
//   ⓐ G2 — `createRow` 가 **실패**로 돌아오면 선택이 안 옮겨간다 (응답을 갈아끼워 일부러 실패시킨다)
//   ⓑ G3 — **ai-title 이 있는 에이전트 탭**은 브랜치로 안 바뀐다
//   ⓒ G3 — detached HEAD worktree 는 `(detached)` 가 아니라 `세션 N` 이다

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  SESSION,
  createTab,
  herdrCall,
  herdrRequest,
  isolatedEnv,
  isolatedHome,
  makeScratchRepo,
  resetSession,
  startApp,
  until,
  writeRaw,
} from './lib.mjs'

/** `04-gate1-check.md` §2 — 사용자 실환경 `herdr pane list` 실측 4줄. 손대지 않는다. */
const MEASURED_PROMPTS = [
  'byun@sanghyunui-MacBookPro:~',
  'byun@sanghyunui-MacBookPro:~/repos/byun618/corral',
  'byun@sanghyunui-MacBookPro:~/repos/byun618/corral/.claude/worktrees/LIFE-357-layout-redesign-claude-orca',
  'byun@sanghyunui-MacBookPro:/private/var/folders/x',
]

const BRANCH = 'LIFE-366-r3-shell'

/** 메인 탭바를 **DOM 에서** 읽는다 — 상태가 아니라 그려진 결과를 본다. */
async function readTabs(app) {
  const code = `(() => [...document.querySelectorAll('.main-tab')].map((tab) => ({
    tabId: tab.getAttribute('data-main-tab'),
    label: (tab.querySelector('.main-tab-label') ?? {}).textContent ?? null,
    active: tab.classList.contains('is-active'),
  })))()`
  return (await app.send({ cmd: 'eval', code })).result
}

const activeTabId = (tabs) => tabs.find((tab) => tab.active)?.tabId ?? null

async function tabsOfWorktree(app, worktreePath) {
  const state = await app.state()
  return state.repos.flatMap((repo) => repo.worktrees).find((worktree) => worktree.path === worktreePath)?.workspace?.tabs ?? []
}

/** 탭 하나를 만들고 **화면에서 선택이 옮겨갔는지** 본다 (G2). `make` 가 생성 경로다. */
async function measureFocus(app, worktreePath, { 경우, make }) {
  const before = await readTabs(app)
  const beforeIds = before.map((tab) => tab.tabId)
  const beforeActive = activeTabId(before)
  await make()
  const grew = await until(async () => (await readTabs(app)).length > before.length, {
    timeoutMs: 20000,
    everyMs: 150,
    what: `${경우} — 탭이 늘어난다`,
  })
  // 선택은 store push 뒤에 옮겨간다 — 탭이 늘어난 **직후**가 아니라 잠깐 뒤를 본다.
  const settled = await until(
    async () => {
      const tabs = await readTabs(app)
      const fresh = tabs.find((tab) => !beforeIds.includes(tab.tabId))
      return fresh !== undefined && fresh.active ? tabs : false
    },
    { timeoutMs: 8000, everyMs: 100, what: `${경우} — 새 탭이 선택된다` },
  )
  const after = settled.value ?? (await readTabs(app))
  const fresh = after.find((tab) => !beforeIds.includes(tab.tabId)) ?? null
  return {
    경우,
    '탭 수': { 전: before.length, 후: after.length },
    '늘었나': grew.ok,
    '선택 전': beforeActive,
    '선택 후': activeTabId(after),
    '새 탭': fresh === null ? null : { tabId: fresh.tabId, label: fresh.label },
    '새 탭이 선택됐나': fresh !== null && fresh.active,
    ms: settled.ms,
  }
}

async function main() {
  const out = { at: new Date().toISOString(), session: SESSION, isolatedHome: isolatedHome() }
  out['세션 초기화'] = await resetSession()
  for (const folder of ['l366-r3']) {
    fs.rmSync(path.join(isolatedHome(), '.claude', 'projects', folder), { recursive: true, force: true })
  }

  // 브랜치 이름이 **폴더 이름과 다르게** 되도록 일부러 갈아탄다 — 제목에 뜬 것이 경로 조각이
  // 아니라 브랜치임을 가르려면 둘이 달라야 한다 (04-gate1-check.md §4 의 Orca 오해와 같은 함정).
  const repo = makeScratchRepo('r3-gates')
  repo.git('checkout', '-b', BRANCH)
  out['스크래치 레포'] = { root: repo.root, branch: BRANCH, leaf: path.basename(repo.root) }

  const app = await startApp({ name: '19-r3-gates' })
  out.appReady = app.ready
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length === 1, {
    timeoutMs: 15000,
    what: 'worktree row',
  })
  await app.click(`[data-worktree="${repo.root}"]`)
  const opened = await until(async () => (await tabsOfWorktree(app, repo.root)).length > 0, {
    timeoutMs: 30000,
    what: 'worktree opened',
  })
  out['worktree 열림'] = { ok: opened.ok, ms: opened.ms }

  // --- G3 ① 셸 탭이 브랜치를 보인다 ------------------------------------------------
  const first = await until(
    async () => {
      const tabs = await readTabs(app)
      return tabs.length === 1 && tabs[0].label !== null && tabs[0].label.length > 0 ? tabs : false
    },
    { timeoutMs: 20000, everyMs: 200, what: 'G3 — 첫 셸 탭 제목' },
  )
  const firstTabs = first.value ?? (await readTabs(app))
  out['G3 ① 셸 탭이 브랜치를 보인다'] = {
    탭: firstTabs,
    기대: `${BRANCH} 1`,
    통과: firstTabs.length === 1 && firstTabs[0].label === `${BRANCH} 1`,
    '폴더 이름이 아니다': path.basename(repo.root) !== BRANCH,
  }

  // --- G2 ① `+ 빈 탭` 경로 + G3 ② 같은 worktree 셸 탭 둘이 갈린다 ---------------------
  out['G2 ① + 빈 탭 경로'] = await measureFocus(app, repo.root, {
    경우: '+ 빈 탭',
    make: () => app.click('[data-main-tabbar-add]'),
  })
  const twoTabs = await readTabs(app)
  const labels = twoTabs.map((tab) => tab.label)
  out['G3 ② 셸 탭 둘이 서로 다르다'] = {
    제목: labels,
    통과: labels.length === 2 && labels[0] !== labels[1] && labels.every((label) => label.startsWith(BRANCH)),
  }

  // --- G2 ② ⌘T 경로 ------------------------------------------------------------
  out['G2 ② ⌘T 경로'] = await measureFocus(app, repo.root, {
    경우: '⌘T',
    // `key` 는 Electron 의 keyCode 를 그대로 쓴다 — 렌더러 document 리스너가 받는다.
    make: () => app.key('T', ['meta']),
  })

  // --- G1 — 실환경 프롬프트 문자열을 **앱 안에서** 확인한다 ------------------------------
  //
  // 격리 셸 pane 에 OSC 2 를 쏜다 = herdr 가 실제로 제목을 받는 경로 그대로다.
  const shellTabs = await tabsOfWorktree(app, repo.root)
  const probeTab = shellTabs[0]
  const probePane = probeTab.panes[0].paneId
  const g1 = []
  for (const measured of MEASURED_PROMPTS) {
    // `printf` 한 줄 — 셸에 들어가는 건 이 문자열뿐이다.
    await herdrRequest('pane.send_text', { pane_id: probePane, text: `printf '\\033]2;${measured}\\007'\r` })
    const seen = await until(
      async () => {
        const tabs = await tabsOfWorktree(app, repo.root)
        const pane = tabs.flatMap((tab) => tab.panes).find((item) => item.paneId === probePane)
        return pane?.title === measured ? pane : false
      },
      { timeoutMs: 8000, everyMs: 150, what: `G1 — pane 제목이 ${measured.slice(0, 20)}` },
    )
    const drawn = (await readTabs(app)).find((tab) => tab.tabId === probeTab.tabId) ?? null
    g1.push({
      '쏜 제목': measured,
      'pane.title 로 도착했나': seen.ok,
      '탭에 그려진 제목': drawn?.label ?? null,
      '프롬프트가 그대로 떴나': drawn?.label === measured,
      '브랜치 티어로 내려갔나': drawn?.label === `${BRANCH} ${probeTab.number}`,
    })
  }
  out['G1 — 실환경 프롬프트 4줄이 앱에서도 걸러진다'] = {
    출처: '04-gate1-check.md §2 (사용자 실환경 herdr pane list). 문자열만 가져왔다 — 쓰기는 격리 HOME 뿐이다.',
    표: g1,
    통과: g1.every((row) => row['pane.title 로 도착했나'] && !row['프롬프트가 그대로 떴나'] && row['브랜치 티어로 내려갔나']),
  }
  // 반례 — **안 걸러져야 하는** 제목. 같은 경로로 쏜다.
  const OK_TITLE = 'PROBE-TITLE 정상 제목'
  await herdrRequest('pane.send_text', { pane_id: probePane, text: `printf '\\033]2;${OK_TITLE}\\007'\r` })
  const okSeen = await until(
    async () => ((await readTabs(app)).find((tab) => tab.tabId === probeTab.tabId)?.label === OK_TITLE ? true : false),
    { timeoutMs: 8000, everyMs: 150, what: 'G1 반례 — 정상 제목은 뜬다' },
  )
  out['관문⑤ 반례 — 정상 터미널 제목은 안 걸러진다'] = {
    쏜_제목: OK_TITLE,
    '탭에 떴나': okSeen.ok,
    설명: '이게 안 뜨면 필터가 넓어져 터미널 제목 티어를 통째로 죽인 것이다.',
  }
  const shotG3 = await app.shot('r3-g3-branch-title')

  // --- 관문 ⑤ 반례 ⓑ — ai-title 이 있는 에이전트 탭은 브랜치로 안 바뀐다 -------------------
  const agentClick = await createTab(app, repo.root, 'claude')
  const agentTab = await until(
    async () => {
      const tabs = await tabsOfWorktree(app, repo.root)
      return tabs.find((tab) => tab.panes.some((pane) => pane.agent !== null)) ?? false
    },
    { timeoutMs: 30000, everyMs: 300, what: '에이전트 탭' },
  )
  out['에이전트 탭 생성'] = { clickHit: agentClick.hit, ok: agentTab.ok, ms: agentTab.ms }
  if (agentTab.ok) {
    const tab = agentTab.value
    const id = '55555555-eeee-4eee-8eee-000000000005'
    const AI_TITLE = '브랜치가 아니라 이 이름이 떠야 한다'
    const dir = path.join(isolatedHome(), '.claude', 'projects', 'l366-r3')
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
    out['참조 주입'] = await herdrCall('pane.report_agent_session', {
      pane_id: tab.panes[0].paneId,
      source: 'herdr:claude',
      agent: 'claude',
      seq: Date.now(),
      agent_session_id: id,
    })
    await app.send({ cmd: 'resync', reason: 'l366-r3-ref' })
    const titled = await until(
      async () => ((await readTabs(app)).find((row) => row.tabId === tab.tabId)?.label === AI_TITLE ? true : false),
      { timeoutMs: 30000, everyMs: 300, what: '반례 ⓑ — ai-title 이 제목이 된다' },
    )
    const drawn = (await readTabs(app)).find((row) => row.tabId === tab.tabId) ?? null
    out['관문⑤ 반례 ⓑ — 에이전트 탭은 브랜치로 안 바뀐다'] = {
      'ai-title': AI_TITLE,
      '그려진 제목': drawn?.label ?? null,
      '브랜치가 아닌가': drawn?.label !== `${BRANCH} ${tab.number}`,
      '반례가 성립하나': titled.ok,
      ms: titled.ms,
    }
  }
  const shotAgent = await app.shot('r3-agent-title-unchanged')

  // --- 관문 ⑤ 반례 ⓒ — detached HEAD 는 `세션 N` 이다 ---------------------------------
  const detached = makeScratchRepo('r3-detached')
  execFileSync('git', ['-C', detached.root, 'checkout', '--detach'], { encoding: 'utf8' })
  await app.addRepo(detached.root)
  await until(async () => (await app.query(`[data-worktree="${detached.root}"]`)).found.length === 1, {
    timeoutMs: 15000,
    what: 'detached worktree row',
  })
  await app.click(`[data-worktree="${detached.root}"]`)
  const detachedOpened = await until(async () => (await tabsOfWorktree(app, detached.root)).length > 0, {
    timeoutMs: 30000,
    what: 'detached worktree opened',
  })
  // 블록 클릭은 **두 번** 필요하다 — 첫 클릭은 열기(`openWorktree`), 그 다음 클릭이
  // 활성화(`activateWorkspace` + 첫 세션 선택)다 (`Sidebar.tsx` onSelectBlock).
  // 1차 실행은 한 번만 눌러서 탭바가 앞 worktree 그대로였고 반례가 미달로 찍혔다.
  await app.click(`[data-worktree="${detached.root}"]`)
  const detachedState = await app.state()
  const detachedRow = detachedState.repos
    .flatMap((repo2) => repo2.worktrees)
    .find((worktree) => worktree.path === detached.root)
  // ⚠ 탭바가 **detached workspace 로 바뀐 뒤**를 읽어야 한다. 1차 실행은 "탭이 있고 제목이
  // 비어있지 않다" 로만 기다려서 **앞 worktree 의 탭바**를 그대로 읽고 미달로 찍혔다.
  const detachedTabIds = (await tabsOfWorktree(app, detached.root)).map((tab) => tab.tabId)
  const detachedTabs = await until(
    async () => {
      const tabs = await readTabs(app)
      return tabs.length > 0 && tabs.every((tab) => detachedTabIds.includes(tab.tabId)) ? tabs : false
    },
    { timeoutMs: 20000, everyMs: 200, what: 'detached 탭바로 바뀐다' },
  )
  const drawnDetached = detachedTabs.value ?? (await readTabs(app))
  out['관문⑤ 반례 ⓒ — detached HEAD 는 세션 N'] = {
    열렸나: detachedOpened.ok,
    '탭바가 바뀌었나': detachedTabs.ok,
    'WorktreeRow.branch': detachedRow?.branch ?? null,
    '그려진 제목': drawnDetached.map((tab) => tab.label),
    '표식이 제목에 없나': drawnDetached.every((tab) => !(tab.label ?? '').includes('(detached)')),
    '세션 N 인가': drawnDetached.every((tab) => /^세션 \d+$/.test(tab.label ?? '')),
  }
  const shotDetached = await app.shot('r3-detached-fallback')

  // --- 관문 ⑤ 반례 ⓐ — **생성이 실패하면 선택이 안 옮겨간다** (맨 끝에 둔다: 세션을 죽인다) ---
  //
  // 렌더러에서 응답만 갈아끼우는 방법은 **불가능하다**: `window.corral` 은 contextBridge 가
  // 얼려서 내놓는다 (실측 — `window` 의 `corral` 서술자 `writable:false, configurable:false`,
  // `createRow` 도 같다. 대입은 조용히 무시되고 `defineProperty` 는 "Cannot redefine" 로 던진다).
  // 그래서 **진짜로 실패시킨다**: herdr 세션을 세우면 `tab.create` 가 갈 곳이 없다.
  // 이것이 제품 경로 그대로의 실패다 — 스텁이 아니라서 "훅이 ok 를 본다"를 있는 그대로 잰다.
  const beforeFail = await readTabs(app)
  const beforeFailActive = activeTabId(beforeFail)
  const stopped = (() => {
    try {
      return execFileSync('herdr', ['session', 'stop', SESSION], { env: isolatedEnv(), encoding: 'utf8' }).trim()
    } catch (error) {
      return `실패: ${String(error.stderr ?? error.message).trim().slice(0, 200)}`
    }
  })()
  const dropped = await until(
    async () => app.entries().some((entry) => entry.tag === 'link.phase' && entry.phase === 'reconnecting'),
    { timeoutMs: 15000, everyMs: 200, what: '링크가 끊긴다' },
  )
  const failClick = await app.click('[data-main-tabbar-add]')
  // 옮겨갈 시간을 넉넉히 준다 — "안 옮겨갔다" 가 결론이 되려면 기다려 본 뒤여야 한다.
  const movedAnyway = await until(
    async () => {
      const tabs = await readTabs(app)
      return tabs.length > beforeFail.length || activeTabId(tabs) !== beforeFailActive ? tabs : false
    },
    { timeoutMs: 8000, everyMs: 200, what: '반례 — 선택이 옮겨가면 안 된다' },
  )
  const afterFail = await readTabs(app)
  out['관문⑤ 반례 ⓐ — 생성 실패면 선택이 안 옮겨간다'] = {
    방법: 'herdr 세션을 세운다 — 제품 경로 그대로의 실패다. 렌더러 스텁은 불가능(contextBridge 가 window.corral 을 얼린다).',
    '세션 정지': stopped,
    '링크가 끊겼나': dropped.ok,
    클릭: failClick.hit,
    '탭 수': { 전: beforeFail.length, 후: afterFail.length },
    '선택 전': beforeFailActive,
    '선택 후': activeTabId(afterFail),
    '선택이 그대로인가': activeTabId(afterFail) === beforeFailActive,
    '탭이 안 늘었나': afterFail.length === beforeFail.length,
    '반례가 성립하나':
      dropped.ok && !movedAnyway.ok && afterFail.length === beforeFail.length && activeTabId(afterFail) === beforeFailActive,
  }

  out.스크린샷 = [shotG3, shotAgent, shotDetached]
  out.클릭로그 = app.clickLog()
  out.원자료사슬 = app.rawChain()
  out.판정 = {
    'G1 실환경 4줄이 걸러진다': out['G1 — 실환경 프롬프트 4줄이 앱에서도 걸러진다'].통과,
    'G1 반례 — 정상 제목은 산다': out['관문⑤ 반례 — 정상 터미널 제목은 안 걸러진다']['탭에 떴나'],
    'G2 + 빈 탭 경로': out['G2 ① + 빈 탭 경로']['새 탭이 선택됐나'],
    'G2 ⌘T 경로': out['G2 ② ⌘T 경로']['새 탭이 선택됐나'],
    'G2 반례 — 실패면 안 옮긴다': out['관문⑤ 반례 ⓐ — 생성 실패면 선택이 안 옮겨간다']['반례가 성립하나'],
    'G3 셸 탭이 브랜치를 보인다': out['G3 ① 셸 탭이 브랜치를 보인다'].통과,
    'G3 셸 탭 둘이 갈린다': out['G3 ② 셸 탭 둘이 서로 다르다'].통과,
    'G3 반례 ⓑ 에이전트 탭 불변': out['관문⑤ 반례 ⓑ — 에이전트 탭은 브랜치로 안 바뀐다']?.['반례가 성립하나'] ?? null,
    'G3 반례 ⓒ detached 는 세션 N': out['관문⑤ 반례 ⓒ — detached HEAD 는 세션 N']['세션 N 인가'],
  }

  await app.stop()
  writeRaw('r3-gates.json', JSON.stringify(out, null, 2) + '\n')
  console.log(JSON.stringify(out, null, 1))
}

await main()
