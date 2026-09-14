// F1(이름 지우기) · F2(탭 컨텍스트 메뉴) — **화면에서** 손잡이를 잡아 본다.
//
// 소켓으로 `tab.rename` 을 직접 때리는 프로브로는 F1 을 못 증명한다. 렌더러 → preload →
// main → 어댑터 중 한 층이 빈 이름을 막으면 소켓 프로브는 통과하는데 앱은 미달이다.
// 그래서 여기서는 **우클릭 → 이름 지우기** 를 실제로 눌러 제목이 다음 티어로 돌아가는지 본다.
//
// 티어가 돌아가는 것을 눈에 보이게 하려고 provider 제목(ai-title)이 있는 트랜스크립트를 깔아
// 둔다 — 사용자 이름을 지우면 제목이 **`ai-title` 로** 떨어져야 한다 (C1 순서).
//
// 관문 ⑤ 반례: 「이름 지우기」를 누르기 **전에** 같은 판정식을 돌린다. 그때는 사용자 이름이
// 그대로여야 한다 — 거기서도 통과하면 판정식이 아무거나 통과시키는 것이다.

import fs from 'node:fs'
import path from 'node:path'
import {
  herdrCall,
  isolatedHome,
  makeScratchRepo,
  resetSession,
  sleep,
  startApp,
  until,
  writeRaw,
} from './lib.mjs'

const SESSION_ID = 'f1000000-0000-4000-8000-000000000001'
const AI_TITLE = '이름을 지우면 이 제목이 나온다'
const USER_NAME = '내가 붙인 이름'

async function rightClick(app, selector) {
  const rect = await app.rect(selector)
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (el === null) return { ok: false }
        const box = el.getBoundingClientRect()
        const x = Math.round(box.x + box.width / 2)
        const y = Math.round(box.y + box.height / 2)
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
        return { ok: true, x, y }
      })()`,
    })
  ).result ?? { ok: false, rect }
}

async function titleOf(app, tabId) {
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const row = document.querySelector('[data-tab=${JSON.stringify(tabId)}]')
        const tab = document.querySelector('[data-main-tab=${JSON.stringify(tabId)}]')
        return {
          사이드바: row ? row.querySelector('.session-row-title').textContent : null,
          탭바: tab ? tab.querySelector('.main-tab-label').textContent : null,
        }
      })()`,
    })
  ).result
}

async function menuState(app, tabId) {
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const menu = document.querySelector('[data-tab-menu=${JSON.stringify(tabId)}]')
        if (menu === null) return { 열렸나: false }
        const item = (attr) => {
          const el = menu.querySelector('[' + attr + ']')
          return el === null ? null : { 글자: el.textContent, 비활성: el.getAttribute('data-disabled') }
        }
        const box = menu.getBoundingClientRect()
        return {
          열렸나: true,
          위치: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width) },
          이름변경: item('data-tab-menu-rename'),
          이름지우기: item('data-tab-menu-clear'),
          닫기: item('data-tab-menu-close'),
        }
      })()`,
    })
  ).result
}

async function main() {
  const out = { at: new Date().toISOString() }
  out['세션 초기화'] = await resetSession()
  const projects = path.join(isolatedHome(), '.claude', 'projects', 'l366-f1')
  fs.rmSync(projects, { recursive: true, force: true })
  fs.mkdirSync(projects, { recursive: true })
  fs.writeFileSync(
    path.join(projects, `${SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(Date.now() - 300000).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: '이름 지우기 실측용 마지막 말' }] },
      }),
      JSON.stringify({ type: 'ai-title', sessionId: SESSION_ID, aiTitle: AI_TITLE, timestamp: new Date(Date.now() - 240000).toISOString() }),
    ].join('\n') + '\n',
  )

  const repo = makeScratchRepo('f1')
  const app = await startApp({ name: '14-f1-f2' })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length === 1, { timeoutMs: 15000, what: 'worktree row' })
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace != null,
    { timeoutMs: 30000, what: 'worktree opened' },
  )
  // 에이전트 탭 하나만 있으면 된다. 탭바는 탭이 2개 이상일 때만 뜨므로(C5) 셸 탭을 남겨 둔다.
  // **클릭 반환값을 버리지 않는다** (수정 라운드 1, V9). 다른 프로브는 `clickLog()` 로 `hit` 을
  // 남기는데 이 둘만 버려서, 가려진 버튼을 눌렀을 때 30초 뒤 엉뚱한 곳에서 터졌다.
  out['탭 만들기 클릭'] = [
    await app.click(`[data-worktree-menu-toggle="${repo.root}"]`),
    await app.click(`[data-worktree-create-agent="${repo.root}"][data-kind="claude"]`),
  ].map((result) => ({ hit: result.hit ?? null, target: result.target ?? null, blockedBy: result.blockedBy ?? null }))
  const gotTab = await until(async () => {
    const workspace = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace
    const tab = workspace?.tabs.find((item) => item.panes.some((pane) => pane.agent !== null))
    return tab ?? false
  }, { timeoutMs: 30000, everyMs: 300, what: '에이전트 탭' })
  const tab = gotTab.value
  out.탭 = { tabId: tab.tabId, paneId: tab.panes[0].paneId, number: tab.number }

  out['참조 주입'] = await herdrCall('pane.report_agent_session', {
    pane_id: tab.panes[0].paneId,
    source: 'herdr:claude',
    agent: 'claude',
    seq: Date.now(),
    agent_session_id: SESSION_ID,
  })
  await app.send({ cmd: 'resync', reason: 'l366-f1' })
  const gotTitle = await until(async () => {
    const titles = await titleOf(app, tab.tabId)
    return titles.사이드바 === AI_TITLE ? titles : false
  }, { timeoutMs: 30000, everyMs: 400, what: 'provider 제목이 붙는다' })
  out['① provider 제목이 붙었다'] = { ok: gotTitle.ok, 제목: gotTitle.value ?? (await titleOf(app, tab.tabId)) }

  // ---------- F2 — 우클릭 메뉴 ----------
  out['② 우클릭'] = await rightClick(app, `[data-main-tab="${tab.tabId}"]`)
  await sleep(300)
  out['② 메뉴 상태(이름 없음 — 지우기 비활성)'] = await menuState(app, tab.tabId)
  out['② 메뉴 스크린샷'] = await app.shot('f2-menu-no-name')

  // ---------- F2 — 메뉴에서 이름 변경 ----------
  await app.click(`[data-tab-menu-rename="${tab.tabId}"]`)
  await sleep(300)
  out['③ 편집 진입'] = (await app.query(`[data-main-tab="${tab.tabId}"]`)).found.length > 0
    ? (await app.send({ cmd: 'eval', code: `document.querySelector('[data-main-tab=${JSON.stringify(tab.tabId)}]').getAttribute('data-tab-editing')` })).result
    : null
  // 입력칸을 비우고 새 이름을 친다.
  await app.key('a', ['meta'])
  await app.type(USER_NAME)
  await app.key('Enter')
  const named = await until(async () => {
    const titles = await titleOf(app, tab.tabId)
    return titles.사이드바 === USER_NAME ? titles : false
  }, { timeoutMs: 20000, everyMs: 300, what: '사용자 이름이 붙는다' })
  out['③ 이름 변경 결과'] = { ok: named.ok, 제목: named.value ?? (await titleOf(app, tab.tabId)) }
  out['③ herdr label'] = (await herdrCall('tab.list', {})).result?.tabs?.find?.((item) => item.tab_id === tab.tabId) ?? null

  // ---------- 관문 ⑤ 반례 — 지우기 전에 같은 판정식 ----------
  const 판정식 = (titles) => titles.사이드바 === AI_TITLE && titles.탭바 === AI_TITLE
  out['관문⑤ 반례 — 지우기 전 판정식'] = {
    설명: '「이름 지우기」 전에 같은 식을 돌린다. 통과하면 식이 아무 상태나 통과시킨다는 뜻이다.',
    통과하나: 판정식(await titleOf(app, tab.tabId)),
    기대: false,
  }

  // ---------- F1 — 이름 지우기 ----------
  out['④ 우클릭(이름 있음)'] = await rightClick(app, `[data-main-tab="${tab.tabId}"]`)
  await sleep(300)
  out['④ 메뉴 상태(이름 있음 — 지우기 활성)'] = await menuState(app, tab.tabId)
  out['④ 메뉴 스크린샷'] = await app.shot('f2-menu-with-name')
  const clearedAt = Date.now()
  await app.click(`[data-tab-menu-clear="${tab.tabId}"]`)
  const cleared = await until(async () => {
    const titles = await titleOf(app, tab.tabId)
    return 판정식(titles) ? titles : false
  }, { timeoutMs: 20000, everyMs: 300, what: '제목이 provider 티어로 돌아온다' })
  out['④ 이름 지우기 결과'] = {
    통과: cleared.ok,
    ms: Date.now() - clearedAt,
    제목: cleared.value ?? (await titleOf(app, tab.tabId)),
    'herdr label': (await herdrCall('tab.list', {})).result?.tabs?.find?.((item) => item.tab_id === tab.tabId) ?? null,
  }
  out['④ 스크린샷'] = await app.shot('f1-name-cleared')
  // 거절이 있었으면 화면에 그대로 떠야 한다 (승격 금지) — 안내 줄을 그대로 싣는다.
  out['④ 화면 안내(있으면)'] = (
    await app.send({ cmd: 'eval', code: `(() => [...document.querySelectorAll('.inline-notice')].map((el) => el.textContent))()` })
  ).result

  // ---------- F2 — 메뉴의 닫기가 hover × 와 같은 손잡이인가 ----------
  const beforeClose = (await app.query('[data-main-tab]')).found.length
  out['⑤ 우클릭(닫기용)'] = await rightClick(app, `[data-main-tab="${tab.tabId}"]`)
  await sleep(300)
  await app.click(`[data-tab-menu-close="${tab.tabId}"]`)
  // **종료 확인 모달이 뜬다** — 에이전트가 떠 있는 탭이라 LIFE-357 의 종료 게이트가 걸린다.
  // 그게 hover `×` 와 **같은 손잡이**(`closeRow`)를 탄다는 증거다(F2 통과선). 1차 실행은 이
  // 모달을 몰라서 "안 닫힌다" 로 읽었다 — 모달을 확인하고 넘어간다.
  const modal = await until(async () => (await app.query('[data-confirm-close-modal]')).found.length > 0, {
    timeoutMs: 10000,
    everyMs: 200,
    what: '종료 확인 모달',
  })
  out['⑤ 종료 확인 모달'] = {
    떴나: modal.ok,
    ms: modal.ms,
    제목: (await app.query('[data-confirm-close-title]')).found,
    전경: (await app.query('[data-confirm-close-fg]')).found,
    설명: 'hover × 와 같은 손잡이(closeRow)를 타므로 같은 종료 게이트가 걸린다',
  }
  out['⑤ 모달 스크린샷'] = await app.shot('f2-menu-close-confirm')
  await app.click('[data-close-confirm-ok]')
  const closed = await until(async () => (await app.query(`[data-main-tab="${tab.tabId}"]`)).found.length === 0, {
    timeoutMs: 20000,
    everyMs: 300,
    what: '탭이 닫힌다',
  })
  out['⑤ 메뉴 닫기'] = { 통과: closed.ok, ms: closed.ms, 닫기전_탭수: beforeClose, 확인모달을_거쳤나: modal.ok }

  // ---------- V7 — 메뉴가 뷰포트 밖으로 나가나 ----------
  //
  // 1회차 실측은 창 1400px 에 탭 2개라 우클릭 좌표가 `x: 558`·`521` 이었다 — **엣지케이스를
  // 한 번도 안 밟았다.** 여기서는 창을 좁히고 탭을 채워 **가장 오른쪽 탭**을 우클릭한다.
  // 클램프가 없으면 메뉴(168px) 오른쪽 끝이 창 밖으로 나간다.
  await app.resizeWindow(900, 800)
  await sleep(500)
  for (let i = 0; i < 5; i += 1) {
    await app.click(`[data-worktree-menu-toggle="${repo.root}"]`)
    await app.click(`[data-worktree-create-agent="${repo.root}"][data-kind="claude"]`)
    await sleep(500)
  }
  const tabIds = (await app.query('[data-main-tab]')).found
  const lastTab = (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const tabs = [...document.querySelectorAll('[data-main-tab]')]
        if (tabs.length === 0) return null
        const last = tabs[tabs.length - 1]
        const box = last.getBoundingClientRect()
        return { tabId: last.getAttribute('data-main-tab'), right: Math.round(box.right), center: Math.round(box.x + box.width / 2), innerWidth: window.innerWidth }
      })()`,
    })
  ).result
  const clampProbe = lastTab === null ? null : await (async () => {
    await rightClick(app, `[data-main-tab="${lastTab.tabId}"]`)
    await sleep(300)
    return (
      await app.send({
        cmd: 'eval',
        code: `(() => {
          const menu = document.querySelector('.tab-context-menu')
          if (menu === null) return { 열렸나: false }
          const box = menu.getBoundingClientRect()
          const anchorX = Number(menu.getAttribute('data-menu-anchor-x'))
          const anchorY = Number(menu.getAttribute('data-menu-anchor-y'))
          return {
            열렸나: true,
            창: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
            우클릭_좌표: { x: anchorX, y: anchorY },
            메뉴: { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom), w: Math.round(box.width), h: Math.round(box.height) },
            '클램프가 없었으면 넘쳤을 양': Math.round(anchorX + box.width - window.innerWidth),
            '오른쪽 끝이 창 안인가': box.right <= window.innerWidth,
            '아래 끝이 창 안인가': box.bottom <= window.innerHeight,
          }
        })()`,
      })
    ).result
  })()
  out['V7 — 메뉴 클램프'] = {
    설명: '창을 900px 로 좁히고 탭을 채운 뒤 가장 오른쪽 탭을 우클릭한다.',
    탭수: tabIds.length,
    '가장 오른쪽 탭': lastTab,
    측정: clampProbe,
    통과: clampProbe !== null && clampProbe.열렸나 === true && clampProbe['오른쪽 끝이 창 안인가'] === true,
    '엣지케이스를 실제로 밟았나': clampProbe !== null && (clampProbe['클램프가 없었으면 넘쳤을 양'] ?? 0) > 0,
  }
  out['V7 스크린샷'] = await app.shot('v7-menu-clamped')

  out.rawChain = app.rawChain()
  out.클릭기록 = app.clickLog()
  await app.stop()
  writeRaw('f1-f2-menu-r1.json', out)
  console.log(
    JSON.stringify(
      {
        provider제목: out['① provider 제목이 붙었다'],
        메뉴_이름없음: out['② 메뉴 상태(이름 없음 — 지우기 비활성)'],
        이름변경: out['③ 이름 변경 결과'],
        반례: out['관문⑤ 반례 — 지우기 전 판정식'],
        이름지우기: out['④ 이름 지우기 결과'],
        메뉴닫기: out['⑤ 메뉴 닫기'],
        확인모달: out['⑤ 종료 확인 모달'],
      },
      null,
      1,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
