// 수정 라운드 8 — **Orca 탭 제목 정책 4건을 화면에서 잰다** (C11 · C12 · C13 · C14).
//
//   ⓐ C11  거절 폐지 — 재료 없는 claude 탭에 **터미널 제목이 그대로** 뜬다(`claude N` 으로 안 떨어진다).
//   ⓑ C11ⓒ 프롬프트 모양은 **cwd 값으로 치환**된다 — worktree 에서 `..sion-identity`, 홈에서 **`~`**.
//           (홈 칸이 이 라운드의 요점이다: 그냥 15자로 자르면 `..-MacBookPro:~` 라 Orca 와 어긋난다)
//   ⓒ C12  스피너가 도는 동안 **제목 문자열이 한 가지**다. 반례는 여기서 2개 이상이 관측된다.
//   ⓓ C13  앱을 껐다 켜도 **같은 탭이 같은 번호**다.
//   ⓔ C14  split 한 탭에서 **포커스된 pane** 이 제목을 몬다.
//
// C1′ 순서 회귀도 같이 본다 — `ai-title` 을 주입하면 제목이 그쪽으로 올라가야 한다. 이 라운드가
// OSC 단을 위로 올렸다면 여기서 깨진다 (**절대 깨지 말 것**).
//
// 격리(관문 ④): 앱·herdr 세션·레포·트랜스크립트·ui-prefs 전부 격리 HOME 안이다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import {
  RAW_DIR,
  controlSocketPath,
  RAW_SUBDIR,
  SESSION,
  createTab,
  herdrCall,
  herdrRequest,
  isolatedHome,
  resetSession,
  sleep,
  startApp,
  tabsOf,
  until,
  writeRaw,
} from './lib.mjs'

const REPO_REL = 'repos/byun618/corral/.claude/worktrees/LIFE-366-session-identity'
const SESSION_ID = 'a8a8a8a8-b8b8-4b8b-8b8b-000000000088'
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼']

function makeRepoInHome(rel = REPO_REL) {
  const root = path.join(isolatedHome(), rel)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-b', 'main', root], { encoding: 'utf8' })
  fs.writeFileSync(path.join(root, 'README.md'), 'l366 r8 scratch\n')
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  git('add', 'README.md')
  git('-c', 'user.email=l366@test', '-c', 'user.name=l366', 'commit', '-m', 'init')
  return fs.realpathSync(root)
}

async function readTabs(app) {
  const code = `(() => [...document.querySelectorAll('.main-tab')].map((tab) => ({
    tabId: tab.getAttribute('data-main-tab'),
    label: (tab.querySelector('.main-tab-label') ?? {}).textContent ?? null,
  })))()`
  return (await app.send({ cmd: 'eval', code })).result
}

const labelOf = async (app, tabId) => (await readTabs(app)).find((row) => row.tabId === tabId)?.label ?? null

/**
 * 그 탭이 **탭바에 올라올 때까지** 워크스페이스를 활성으로 만든다.
 *
 * `.main-tab` 은 활성 워크스페이스의 탭만 그린다. 1차 실행에서 홈 아래 레포 칸이 `null` 로
 * 기록된 게 이것이었다 — 상태에는 탭이 있는데 화면에는 다른 워크스페이스가 떠 있었다.
 */
async function ensureActive(app, worktreePath, tabId) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const seen = await until(async () => (await readTabs(app)).some((row) => row.tabId === tabId), {
      timeoutMs: 6000,
      everyMs: 250,
      what: `탭바에 ${tabId}`,
    }).catch(() => ({ ok: false }))
    if (seen.ok) return true
    await app.click(`[data-worktree="${worktreePath}"]`)
  }
  return false
}

/** 화면에 **실제로 떠 있는** pane (C14 의 기준값) — `TerminalPane` 이 그 id 를 달고 있다. */
async function shownPane(app) {
  const code = `(() => { const el = document.querySelector('[data-term-pane]'); return el === null ? null : el.getAttribute('data-term-pane') })()`
  return (await app.send({ cmd: 'eval', code })).result
}

/** 그 pane 의 herdr 원문 제목 — 화면 값과 **나란히** 실어야 「무엇을 그렸나」가 검산된다. */
async function paneTitles(paneId) {
  const pane = (await herdrRequest('pane.get', { pane_id: paneId })).pane ?? {}
  return {
    terminal_title: pane.terminal_title ?? null,
    terminal_title_stripped: pane.terminal_title_stripped ?? null,
    title: pane.title ?? null,
    foreground_cwd: pane.foreground_cwd ?? null,
  }
}

const sendText = (paneId, text) => herdrCall('pane.send_text', { pane_id: paneId, text })
/** 셸에 한 줄 실행시킨다 — 개행까지 같이 보낸다. */
const runLine = (paneId, line) => sendText(paneId, `${line}\n`)

/** OSC 2 로 제목을 쏘는 셸 한 줄 (`printf`). 실측 근거는 10-gate1-fix2.md H-4 의 주입과 같다. */
const oscLine = (title) => `printf '\\033]2;${title}\\007'`

/**
 * herdr 가 **제목 변화를 언제 알리나** — `pane.updated` 푸시를 직접 받아서 센다.
 *
 * 이 라운드의 계측이 두 번 어긋난 원인이라 관측으로 박아 둔다. 구독 프레임은 corral 의
 * `adapter/internal/subscription.ts` 가 쓰는 것과 같은 모양이다(`events.subscribe` 한 줄).
 */
async function watchTitleEvents({ paneId, titles }) {
  const socket = net.createConnection(controlSocketPath())
  const pushes = []
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line.trim().length === 0) continue
      const frame = JSON.parse(line)
      if (frame.event === 'pane_updated') pushes.push(frame)
    }
  })
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write(`${JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: [{ type: 'pane.updated' }] } })}\n`)
  await sleep(800)
  const rows = []
  for (const title of titles) {
    const mark = pushes.length
    await sendText(paneId, `${oscLine(title)}\n`)
    await sleep(1800)
    const pane = (await herdrRequest('pane.get', { pane_id: paneId })).pane ?? {}
    rows.push({
      쏜: title,
      'pane.get 원문': pane.terminal_title ?? null,
      'pane.get 벗긴 값': pane.terminal_title_stripped ?? null,
      '푸시 수': pushes.length - mark,
    })
  }
  socket.end()
  return rows
}

async function main() {
  const out = { at: new Date().toISOString(), session: SESSION, isolatedHome: isolatedHome() }
  out['세션 초기화'] = await resetSession()

  const root = makeRepoInHome()
  out['스크래치 레포'] = { root, '홈 아래인가': root.startsWith(fs.realpathSync(isolatedHome())) }

  // 재기동 칸(C13)이 같은 파일을 두 번 보려면 **실행 밖**에 둬야 한다.
  const sharedDir = path.join(RAW_DIR, RAW_SUBDIR, 'r8-shared')
  fs.rmSync(sharedDir, { recursive: true, force: true })
  fs.mkdirSync(sharedDir, { recursive: true })
  const prefsFile = path.join(sharedDir, 'ui-prefs.json')
  const registryFile = path.join(sharedDir, 'repos.json')

  const app = await startApp({ name: '28-r8-orca', env: { CORRAL_UI_PREFS: prefsFile }, registryFile })
  out.appReady = app.ready
  await app.addRepo(root)
  await until(async () => (await app.query(`[data-worktree="${root}"]`)).found.length === 1, { timeoutMs: 15000, what: 'worktree row' })
  await app.click(`[data-worktree="${root}"]`)
  await until(async () => (await tabsOf(app, root)).length > 0, { timeoutMs: 30000, what: 'worktree opened' })

  const shellTab = (await tabsOf(app, root))[0]
  const shellPane = shellTab.panes[0].paneId

  // --- ⓑ C11ⓒ 프롬프트 모양 → cwd 값 ------------------------------------------------------
  //
  // 먼저 worktree 에서, 그다음 `cd ~` 로 홈에서. **홈 칸이 판별 칸**이다: 그냥 자르면
  // `..-MacBookPro:~` 가 되어 Orca 화면(`~`)과 어긋난다.
  await runLine(shellPane, oscLine('byun@sanghyunui-MacBookPro:~/repos/byun618/corral/.claude/worktrees/LIFE-366-session-identity'))
  const atWorktree = await until(async () => (await labelOf(app, shellTab.tabId)) === '..sion-identity', {
    timeoutMs: 20000,
    everyMs: 250,
    what: 'ⓑ worktree 치환',
  }).catch(() => ({ ok: false, ms: null }))
  const worktreeTitles = await paneTitles(shellPane)

  // **홈 바로 아래 레포**를 따로 하나 연다. `cd ~` 로 옮기는 길은 안 쓴다 — 1차 실행에서
  // pane 의 cwd 가 worktree 밖으로 나가자 corral 이 그 workspace 를 **미등록**으로 떨궈
  // (`tree.unregistered`) 뒤 칸들이 통째로 무너졌다. 실측으로 밟은 함정이라 기록해 둔다.
  const nearHome = makeRepoInHome('p')
  const homePrompt = 'byun@sanghyunui-MacBookPro:~/p'
  await app.addRepo(nearHome)
  await until(async () => (await app.query(`[data-worktree="${nearHome}"]`)).found.length === 1, { timeoutMs: 15000, what: 'worktree row (홈 아래)' })
  await app.click(`[data-worktree="${nearHome}"]`)
  await until(async () => (await tabsOf(app, nearHome)).length > 0, { timeoutMs: 30000, what: 'worktree opened (홈 아래)' })
  const homeTab = (await tabsOf(app, nearHome))[0]
  const homeTabShown = await ensureActive(app, nearHome, homeTab.tabId)
  await runLine(homeTab.panes[0].paneId, oscLine(homePrompt))
  const atHome = await until(async () => (await labelOf(app, homeTab.tabId)) === '~/p', {
    timeoutMs: 20000,
    everyMs: 250,
    what: 'ⓑ 홈 아래 치환',
  }).catch(() => ({ ok: false, ms: null }))
  const homeTitles = await paneTitles(homeTab.panes[0].paneId)
  out['ⓑ 프롬프트 모양은 cwd 값으로 바뀐다 (C11ⓒ)'] = {
    'worktree — herdr 원문': worktreeTitles,
    'worktree — 그려진 제목': await labelOf(app, shellTab.tabId),
    'worktree 통과': atWorktree.ok,
    '홈 아래 — herdr 원문': homeTitles,
    '홈 아래 — 그려진 제목': await labelOf(app, homeTab.tabId),
    '홈 아래 — 그냥 15자로 잘랐다면': homePrompt.length <= 15 ? homePrompt : `..${homePrompt.slice(-13)}`,
    '홈 아래 — 탭바에 올라왔나': homeTabShown,
    '홈 아래 통과': atHome.ok,
    통과: atWorktree.ok && atHome.ok,
    설명:
      'herdr 는 OSC 2 만 준다 — OSC 1(`%15<..<%~%<<`) 값을 corral 이 만들어 Orca 와 같은 글자를 낸다. ' +
      '홈 쪽 칸이 판별 칸이다: 그냥 자르면 프롬프트 접두사가 그대로 남는다.',
  }
  // 다시 원래 worktree 를 활성으로 — 뒤 칸들이 그 탭을 본다.
  await app.click(`[data-worktree="${root}"]`)
  await sleep(1200)
  const shotPrompt = await app.shot('r8-prompt-to-cwd')

  // --- ⓔ C14 포커스된 pane 만 제목을 몬다 ---------------------------------------------------
  // `pane.split` 의 대상 칸은 `target_pane_id` 다 (`herdr api schema --json` 의 `PaneSplitParams`).
  // 1차 실행에서 `pane_id` 로 보냈다가 두 번째 pane 이 안 생겨 멈췄다.
  let shotFocus = null
  const split = await herdrCall('pane.split', { target_pane_id: shellPane, direction: 'right', focus: false })
  const secondPane = await until(
    async () => {
      const tabs = await tabsOf(app, root)
      const tab = tabs.find((row) => row.tabId === shellTab.tabId) ?? null
      const fresh = tab?.panes.find((pane) => pane.paneId !== shellPane) ?? null
      return fresh === null ? false : fresh
    },
    { timeoutMs: 30000, everyMs: 250, what: 'ⓔ 두 번째 pane' },
  )
  // 못 찾으면 **멈추지 말고 기록한다** — 1차 실행이 여기서 죽어 앞 칸들까지 날렸다.
  const other = secondPane.value?.paneId ?? null
  if (other === null) {
    out['ⓔ 포커스된 pane 만 제목을 몬다 (C14)'] = {
      'split 응답': split,
      '그때 탭의 pane 들': (await tabsOf(app, root)).find((row) => row.tabId === shellTab.tabId)?.panes.map((pane) => pane.paneId) ?? null,
      통과: false,
      설명: 'split 한 pane 이 앱 상태에 안 들어왔다 — 화면으로는 못 재는 칸이다(단위가 잡는다).',
    }
  }
  if (other !== null) {
    await runLine(shellPane, oscLine('첫 pane 제목'))
    await runLine(other, oscLine('둘째 pane 제목'))
    await sleep(2500)
    const panesOf = async () => {
      const tabs = await tabsOf(app, root)
      return (tabs.find((row) => row.tabId === shellTab.tabId)?.panes ?? []).map((pane) => ({
        paneId: pane.paneId,
        focused: pane.focused,
        title: pane.title,
      }))
    }
    // **이 탭을 배경으로 돌린다.** corral 은 탭 하나에 pane 하나만 화면에 띄우므로(`TerminalPane`),
    // 활성 탭에서는 「화면에 뜬 pane」이 제목을 몬다 — split 한 둘째 pane 은 화면에 뜨질 않아
    // 그 자리에서는 게이트를 잴 수 없다(1차·2차 실행에서 그렇게 어긋났다). 배경 탭은 화면에 뜬
    // pane 이 **없어서** 다음 칸인 `focused` 가 정확히 드러난다 — 그게 C14 가 말하는 자리다.
    const seenBefore = new Set((await tabsOf(app, root)).map((tab) => tab.tabId))
    await createTab(app, root, 'shell')
    const sideTab = await until(
      async () => {
        const fresh = (await tabsOf(app, root)).find((tab) => !seenBefore.has(tab.tabId)) ?? null
        return fresh === null ? false : fresh
      },
      { timeoutMs: 30000, everyMs: 250, what: 'ⓔ 배경으로 돌릴 다른 탭' },
    )
    await app.click(`[data-main-tab="${sideTab.value.tabId}"]`)
    const asideShown = await until(async () => (await shownPane(app)) !== shellPane, {
      timeoutMs: 20000,
      everyMs: 250,
      what: 'ⓔ 다른 탭이 화면을 쥔다',
    }).catch(() => ({ ok: false }))

    // herdr 의 focus 는 **연결마다 따로**다 (`adapter/internal/protocol.ts` 의 제외 목록) —
    // 그래서 「포커스를 옮겼다」가 아니라 **corral 상태가 그 pane 을 focused 로 아는 시점**을
    // 기다렸다가, 그때 그려진 제목이 그 pane 을 따라갔는지 본다.
    const followFocus = async (paneId, expected) => {
      await herdrCall('pane.focus', { pane_id: paneId })
      const learned = await until(
        async () => (await panesOf()).some((pane) => pane.paneId === paneId && pane.focused),
        { timeoutMs: 20000, everyMs: 300, what: `ⓔ corral 이 ${paneId} 를 focused 로 안다` },
      ).catch(() => ({ ok: false }))
      const moved = await until(async () => (await labelOf(app, shellTab.tabId)) === expected, {
        timeoutMs: 20000,
        everyMs: 250,
        what: `ⓔ 제목이 ${paneId} 를 따라간다`,
      }).catch(() => ({ ok: false }))
      return {
        'focus 준 pane': paneId,
        기대: expected,
        'corral 이 focused 로 아나': learned.ok,
        '그려진 제목': await labelOf(app, shellTab.tabId),
        '화면에 뜬 pane': await shownPane(app),
        통과: learned.ok && moved.ok,
      }
    }
    const toSecond = await followFocus(other, '둘째 pane 제목')
    // **판별 순간에** 찍는다 — 제목이 둘째 pane 으로 옮겨간 그 화면이 반례와 갈리는 자리다.
    shotFocus = await app.shot('r8-focus-gate')
    // 되돌리기는 **관측**으로만 싣는다 — 판별 칸이 아니다. 포커스가 아무 데도 없으면 게이트는
    // `panes[0]` 으로 떨어지므로(단위에 그 칸이 있다) 첫 pane 으로 돌아온 제목은 양쪽 이유로
    // 설명된다. 2차 실행에서 실제로 corral 이 「p1 이 focused」를 못 배웠는데도 제목은 돌아왔다.
    const backToFirst = await followFocus(shellPane, '첫 pane 제목')
    out['ⓔ 포커스된 pane 만 제목을 몬다 (C14)'] = {
      'split 전/후 pane': [shellPane, other],
      '배경으로 돌렸나': asideShown.ok,
      '그때 pane 들': await panesOf(),
      '둘째 pane 으로 (판별 칸)': toSecond,
      '다시 첫 pane 으로 (관측)': backToFirst,
      통과: asideShown.ok && toSecond.통과,
      설명:
        '게이트가 없으면 **목록의 첫 pane**(`panes[0]`, r8 이전 구현)이 계속 제목을 몬다 — 포커스를 옮겨도 `첫 pane 제목` 에 머문다(반례 ⓓ). ' +
        '활성 탭에서는 「화면에 뜬 pane」이 앞 단이라 이 칸은 **배경 탭**에서 잰다. ' +
        '판별은 「첫 pane 이 아닌 pane 으로 제목이 옮겨가나」 한 방향이다.',
    }
  }
  if (other !== null) await herdrCall('pane.close', { pane_id: other }).catch(() => null)
  await sleep(1500)

  // --- ⓒ C12 스피너 프레임 억제 ------------------------------------------------------------
  //
  // 셸에 점자 프레임을 줄줄이 쏘게 하고 **그려진 제목의 가짓수**를 센다. 억제가 없으면
  // 프레임마다 다른 글자가 잡힌다 (관문 ⑤ 반례 ⓒ).
  // 본문을 **짧게** 쓴다(`⠋ PROBE`, 7자). C11ⓓ 의 15자 왼쪽 절단이 긴 제목의 **앞쪽**을 잘라
  // 내는데, 스피너 글리프가 바로 그 앞쪽이라 `⠋ Thinking PROBE` 는 잘린 뒤 `..hinking PROBE` 로
  // 프레임이 구별되지 않는다 — 1차 반례(c12)가 그래서 화면에서 안 뒤집혔다(단위 2칸만 뒤집혔다).
  // 루프 끝에 **표식**을 붙인다 — 다음 칸(ⓐ)이 루프가 도는 동안 글자를 쏘면 셸 입력 버퍼에
  // 쌓였다가 루프가 끝난 뒤 한꺼번에 실행돼, 두 제목이 한 폴링 안에 지나가 버린다.
  // 1차 실행에서 ⓐ 의 두 번째 칸이 그렇게 어긋났다(제품 결함이 아니라 계측 결함이었다).
  const spinLoop = `for g in ${SPIN.join(' ')} ${SPIN.join(' ')} ${SPIN.join(' ')} ${SPIN.join(' ')}; do printf '\\033]2;%s PROBE\\007' "$g"; sleep 0.35; done; printf '\\033]2;SPIN-DONE\\007'`
  await runLine(shellPane, spinLoop)
  const spinning = await until(async () => ((await labelOf(app, shellTab.tabId)) ?? '').includes('PROBE'), {
    timeoutMs: 20000,
    everyMs: 150,
    what: 'ⓒ 첫 스피너 프레임',
  }).catch(() => ({ ok: false }))
  // **표본마다 재동기**를 때린다. herdr 는 스피너 프레임마다 `pane_updated` 를 안 보낸다
  // (`r8-herdr-title-events.json`: 벗긴 제목이 같으면 푸시가 없다) — 그래서 이벤트만 보면
  // 억제가 있으나 없으나 한 가지로 보인다. 스냅샷 재동기는 **그 순간의 원문**을 통째로 실어
  // 오므로, 억제가 없으면 재동기가 떨어진 프레임마다 다른 글자가 화면에 박힌다.
  const samples = []
  let shotSpin = null
  for (let index = 0; index < 12; index += 1) {
    await app.send({ cmd: 'resync', reason: `l366-r8-spin-${index}` })
    await sleep(120)
    samples.push(await labelOf(app, shellTab.tabId))
    // 스피너가 **도는 한가운데**서 찍는다 — 루프가 끝난 뒤 찍으면 반례와 같은 그림이 된다.
    if (index === 5) shotSpin = await app.shot('r8-spinner-stable')
    await sleep(230)
  }
  const spinTitles = await paneTitles(shellPane)
  const distinct = [...new Set(samples.filter((value) => (value ?? '').includes('PROBE')))]
  const spinDone = await until(async () => (await labelOf(app, shellTab.tabId)) === 'SPIN-DONE', {
    timeoutMs: 30000,
    everyMs: 250,
    what: 'ⓒ 루프 끝(SPIN-DONE)',
  }).catch(() => ({ ok: false }))
  out['ⓒ 스피너가 도는 동안 제목은 한 가지 (C12)'] = {
    '쏜 프레임': SPIN,
    '샘플 12회(0.35초 간격)': samples,
    'PROBE 가 든 서로 다른 제목': distinct,
    'herdr 원문(마지막)': spinTitles,
    '첫 프레임을 봤나': spinning.ok,
    '루프가 끝난 것을 봤나': spinDone.ok,
    통과: spinning.ok && distinct.length === 1,
    설명: '억제를 빼면 프레임마다 다른 글자가 잡힌다 — 그게 반례 ⓒ 다.',
  }

  // --- 관측: herdr 는 **벗긴 제목이 바뀔 때만** 알린다 ---------------------------------------
  const eventRows = await watchTitleEvents({
    paneId: shellPane,
    titles: ['EVT-BASE', '⠋ Thinking EVT', '⠙ Thinking EVT', '✳ Claude EVT', 'Claude EVT', 'EVT-END'],
  })
  out['관측 — herdr 가 제목 변화를 언제 알리나'] = {
    표: eventRows,
    '푸시가 0 건이었던 줄': eventRows.filter((row) => row['푸시 수'] === 0).map((row) => row.쏜),
    설명:
      '`terminal_title_stripped` 가 그대로면 `pane_updated` 가 **안 온다** — 스피너 프레임과 `✳` 접두사만 다른 제목이 그렇다. ' +
      '그래서 ⓒ 는 재동기를 때려서 재고, ⓐ 는 벗긴 제목이 매번 달라지는 문자열로 잰다. ' +
      '이 성질은 C11ⓑ(원문을 쓴다)의 대가이기도 하다 — 화면의 장식 접두사가 본문이 바뀔 때까지 옛 값에 머문다(공백에 기록).',
  }

  // --- ⓐ C11 거절 폐지 ---------------------------------------------------------------------
  //
  // 두 칸으로 나눈다. **판별 칸은 문자열**이다: r7 은 `Claude Code`·`claude` 를 「유휴 기본값」
  // 이라고 통째로 거절했고, 그 거절이 폐지됐는지는 그 문자열이 그려지는지로 갈린다. 실물 claude 를
  // 기다릴 필요가 없어서 셸 pane 에 같은 글자를 쏜다(제목 티어는 글자만 본다).
  // 두 번째 칸은 **실물 claude pane 의 관측**이다 — 이 격리 실행의 claude 가 무슨 제목을 쏘는지.
  //
  // ⚠ 세 문자열의 **벗긴 제목이 서로 달라야** 한다. herdr 는 `terminal_title_stripped` 가 안
  // 바뀌면 `pane_updated` 를 아예 안 보낸다(`r8-herdr-title-events.json` — 이 라운드에서 실측).
  // 1차 실행은 `✳ Claude Code` → `Claude Code` 로 이어서 둘째 칸이 영영 안 왔다. 제품이 아니라
  // 계측이 틀린 자리였고, 그 성질 자체는 공백으로 기록한다.
  const vendorStrings = ['Claude Code', 'claude', '✳ Claude Code']
  const vendorSeen = []
  for (const title of vendorStrings) {
    await runLine(shellPane, oscLine(title))
    const drawn = await until(async () => (await labelOf(app, shellTab.tabId)) === title, {
      timeoutMs: 20000,
      everyMs: 250,
      what: `ⓐ 벤더 문자열 ${title}`,
    }).catch(() => ({ ok: false }))
    vendorSeen.push({ 쏜: title, 'herdr 원문': await paneTitles(shellPane), 그려진: await labelOf(app, shellTab.tabId), 통과: drawn.ok })
  }
  out['ⓐ 거절 폐지 — 벤더 문자열이 그대로 뜬다 (C11ⓐⓑ)'] = {
    '쏜 제목': vendorStrings,
    관측: vendorSeen,
    'r7 이었다면': '셋 다 거절 → cwd 티어로 내려가 `..sion-identity`',
    통과: vendorSeen.every((row) => row.통과),
    설명: 'r7 은 `Claude Code`·`claude`·`✳ Claude Code` 를 유휴 기본값으로 거절했다 — 반례 ⓐ 가 그 목록을 되살린다.',
  }
  const shotVendor = await app.shot('r8-vendor-title')

  // --- ⓐ-2 실물 claude pane 이 무슨 제목을 쏘나 (관측) ---------------------------------------
  const before2 = new Set((await tabsOf(app, root)).map((tab) => tab.tabId))
  await createTab(app, root, 'claude')
  const found = await until(
    async () => {
      const tabs = await tabsOf(app, root)
      const fresh = tabs.find((tab) => !before2.has(tab.tabId) && tab.panes.some((pane) => pane.agent !== null)) ?? null
      return fresh === null ? false : fresh
    },
    { timeoutMs: 60000, everyMs: 300, what: 'claude 탭' },
  )
  const agentTab = found.value
  const agentPane = agentTab.panes[0].paneId
  await sleep(6000)
  const agentTitles = await paneTitles(agentPane)
  out['ⓐ-2 실물 claude pane 의 제목 (관측)'] = {
    'herdr 원문': agentTitles,
    '그려진 제목': await labelOf(app, agentTab.tabId),
    '실환경 실측(00-analysis.md §2.4)': { terminal_title: '✳ Claude Code', terminal_title_stripped: 'Claude Code' },
    설명:
      '격리 실행의 claude 는 첫 화면(테마 고르기)에 서 있어 OSC 제목을 **안 쏜다** — 그래서 제목 티어가 비고 폴백(`claude N`)이 그려진다. ' +
      '거절 폐지의 판별은 위 ⓐ 칸(문자열)이 한다.',
  }

  // --- ⓓ C13 재기동 후에도 같은 번호 ---------------------------------------------------------
  //
  // 번호가 **보이는** 자리가 필요하다. 셸 탭은 이제 cwd 티어가 받아서 `terminal N` 이 안 뜨므로
  // (C9 가 C10 의 화면을 덮는다 — r7 에 적어 둔 성질) claude 탭을 쓴다: 이 격리 실행의 claude 는
  // 제목을 안 쏘니 폴백 `claude N` 이 그대로 그려진다.
  //
  // 그리고 **가운데를 비운다**: 그냥 만든 순서면 재기동 후 다시 매겨도 같은 번호라 판별이 안 된다.
  // 하나 닫아 번호를 풀고 새로 만들면, 그 탭이 **빈 번호**를 쥔다 — 영속이 없으면 재기동 때
  // 보이는 순서대로 다시 매겨져 그 값이 달라진다.
  const ordinalTabs = []
  for (let index = 0; index < 2; index += 1) {
    const seen = new Set((await tabsOf(app, root)).map((tab) => tab.tabId))
    await createTab(app, root, 'claude')
    const fresh = await until(
      async () => {
        const tabs = await tabsOf(app, root)
        const row = tabs.find((tab) => !seen.has(tab.tabId)) ?? null
        return row === null ? false : row
      },
      { timeoutMs: 60000, everyMs: 300, what: `claude 탭 ${index + 1}` },
    )
    ordinalTabs.push(fresh.value)
  }
  await sleep(3000)
  const drawnBeforeClose = []
  for (const tab of [agentTab, ...ordinalTabs]) {
    drawnBeforeClose.push({ tabId: tab.tabId, 'herdr 표찰(number)': tab.number, 그려진: await labelOf(app, tab.tabId) })
  }
  // 가운데 것을 닫는다 — 그 번호가 풀린다.
  const closed = ordinalTabs[0]
  await app.click(`[data-close-tab="${closed.tabId}"]`).catch(() => null)
  const modal = await until(async () => (await app.query('[data-confirm-close-modal]')).found.length > 0, {
    timeoutMs: 5000,
    everyMs: 150,
    what: '종료 확인',
  }).catch(() => ({ ok: false }))
  if (modal.ok) await app.click('[data-close-confirm-ok]')
  await until(async () => (await app.query(`[data-main-tab="${closed.tabId}"]`)).found.length === 0, {
    timeoutMs: 20000,
    everyMs: 250,
    what: '탭 닫힘',
  }).catch(() => ({ ok: false }))
  // 새 claude 탭이 **풀린 번호**를 쥔다.
  const seenAfter = new Set((await tabsOf(app, root)).map((tab) => tab.tabId))
  await createTab(app, root, 'claude')
  const reused = await until(
    async () => {
      const tabs = await tabsOf(app, root)
      const row = tabs.find((tab) => !seenAfter.has(tab.tabId)) ?? null
      return row === null ? false : row
    },
    { timeoutMs: 60000, everyMs: 300, what: '빈 번호를 쓸 새 탭' },
  )
  await sleep(3000)
  const watch = [agentTab, ordinalTabs[1], reused.value]
  const numbered = []
  for (const tab of watch) {
    numbered.push({ tabId: tab.tabId, 'herdr 표찰(number)': tab.number, 그려진: await labelOf(app, tab.tabId) })
  }
  const beforeRestart = await readTabs(app)
  await app.stop()
  await sleep(1500)
  const prefsOnDisk = fs.existsSync(prefsFile) ? JSON.parse(fs.readFileSync(prefsFile, 'utf8')) : null

  const again = await startApp({ name: '28-r8-orca-restart', env: { CORRAL_UI_PREFS: prefsFile }, registryFile })
  await until(async () => (await again.query(`[data-worktree="${root}"]`)).found.length === 1, { timeoutMs: 20000, what: 'worktree row (재기동)' })
  await again.click(`[data-worktree="${root}"]`)
  await until(async () => (await tabsOf(again, root)).length > 0, { timeoutMs: 30000, what: 'worktree opened (재기동)' })
  await sleep(3000)
  const afterRestart = await readTabs(again)
  const sameNumbers = numbered.map((row) => ({
    tabId: row.tabId,
    '껐다 켜기 전': row.그려진,
    '켠 뒤': afterRestart.find((item) => item.tabId === row.tabId)?.label ?? null,
  }))
  out['ⓓ 재기동해도 같은 번호 (C13)'] = {
    '닫기 전 번호': drawnBeforeClose,
    '닫은 탭': closed.tabId,
    '닫고 새로 만든 뒤': numbered,
    'ui-prefs.json 의 배정표': prefsOnDisk?.tabOrdinals ?? null,
    '재기동 대조': sameNumbers,
    통과:
      sameNumbers.length > 0 &&
      sameNumbers.every((row) => row['껐다 켜기 전'] !== null && row['껐다 켜기 전'] === row['켠 뒤']),
    설명: '영속을 빼면 재기동 때 보이는 순서대로 1..N 이 다시 매겨진다 — 가운데를 비워 뒀으므로 값이 달라진다(반례 ⓑ).',
    '탭 목록(재기동 전)': beforeRestart,
    '탭 목록(재기동 후)': afterRestart,
  }
  const shotRestart = await again.shot('r8-after-restart')

  // --- C1′ 순서 회귀 — **깨지 말아야 할 것** (재기동한 앱에서) --------------------------------
  const dir = path.join(isolatedHome(), '.claude', 'projects', 'l366-r8')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${SESSION_ID}.jsonl`),
    [
      JSON.stringify({ type: 'attachment', sessionId: SESSION_ID }),
      JSON.stringify({ type: 'user', sessionId: SESSION_ID, timestamp: new Date().toISOString(), message: { role: 'user', content: '첫 발화가 제목이 되어야 한다. OSC 단이 위로 오면 안 된다.' } }),
      JSON.stringify({ type: 'assistant', sessionId: SESSION_ID, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '확인했다' }] } }),
    ].join('\n') + '\n',
  )
  // 제목이 있는 pane 에 붙여야 **순서**가 증명된다 — 셸 pane 에 벤더 문자열을 다시 쏜다.
  const shellAfter = (await tabsOf(again, root)).find((tab) => tab.tabId === shellTab.tabId) ?? null
  const shellPaneAfter = shellAfter?.panes[0]?.paneId ?? null
  if (shellPaneAfter !== null) await runLine(shellPaneAfter, oscLine('✳ Claude Code'))
  // 그려질 때까지 **기다렸다가** 읽는다 — 1차 실행은 고정 2초 뒤에 읽어 앞 칸의 글자를 봤다.
  await until(async () => (await labelOf(again, shellTab.tabId)) === '✳ Claude Code', {
    timeoutMs: 30000,
    everyMs: 250,
    what: "C1′ — OSC 만 있는 상태",
  }).catch(() => ({ ok: false }))
  const oscOnly = await labelOf(again, shellTab.tabId)
  await herdrCall('pane.report_agent_session', {
    pane_id: shellPaneAfter,
    source: 'herdr:claude',
    agent: 'claude',
    seq: Date.now(),
    agent_session_id: SESSION_ID,
  })
  await again.send({ cmd: 'resync', reason: 'l366-r8-c1' })
  const overOsc = await until(async () => (await labelOf(again, shellTab.tabId)) === '첫 발화가 제목이 되어야 한다', {
    timeoutMs: 30000,
    everyMs: 300,
    what: "C1′ — 첫 발화가 OSC 를 이긴다",
  }).catch(() => ({ ok: false }))
  out["C1′ 순서 회귀 — 재료가 OSC 보다 위다"] = {
    'OSC 만 있을 때': oscOnly,
    '첫 발화를 붙인 뒤': await labelOf(again, shellTab.tabId),
    통과: oscOnly === '✳ Claude Code' && overOsc.ok,
    설명: '이 칸이 깨지면 재료 있는 세션까지 `✳ Claude Code` 가 된다 — 이 일감이 푸는 문제가 되돌아온다.',
  }
  const shotC1 = await again.shot('r8-c1-order')
  await again.stop()

  out.판정 = {
    'ⓐ 거절 폐지 (C11ⓐⓑ)': out['ⓐ 거절 폐지 — 벤더 문자열이 그대로 뜬다 (C11ⓐⓑ)'].통과,
    'ⓑ 프롬프트 → cwd 치환 (C11ⓒ)': out['ⓑ 프롬프트 모양은 cwd 값으로 바뀐다 (C11ⓒ)'].통과,
    'ⓒ 스피너 억제 (C12)': out['ⓒ 스피너가 도는 동안 제목은 한 가지 (C12)'].통과,
    'ⓓ 번호 영속 (C13)': out['ⓓ 재기동해도 같은 번호 (C13)'].통과,
    'ⓔ 포커스 게이트 (C14)': out['ⓔ 포커스된 pane 만 제목을 몬다 (C14)'].통과,
    'C1′ 순서 (깨면 안 되는 것)': out['C1′ 순서 회귀 — 재료가 OSC 보다 위다'].통과,
  }
  out.샷 = { shotPrompt, shotSpin, shotFocus, shotVendor, shotRestart, shotC1 }
  writeRaw('r8-orca.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out.판정, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
