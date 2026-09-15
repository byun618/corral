// 수정 라운드 7 — **표시층 3건을 화면에서 잰다** (C8 · C9 · C10).
//
//   ⓐ C8  세션 행이 **한 줄**이다. 2차 줄이 있는 행과 없는 행의 **높이가 같고**(C8-② — B4 폐기),
//          제목과 2차 줄이 **한 칸에서 같이** 잘리며 전문은 툴팁에 있다. 2차 줄이 더 흐리고
//          활성 행에서는 둘 다 밝아진다.
//   ⓑ C9  셸 탭 폴백이 **잘린 경로**다 — `~/…/worktrees/LIFE-366-session-identity` → `..sion-identity`.
//          사용자가 Orca 화면에서 본 그 글자다. 그래서 스크래치 레포를 **격리 HOME 아래 그 경로**로 판다.
//   ⓒ C10 폴백 번호가 **비어 있는 가장 작은 번호**다. 탭 넷 중 둘을 닫고 하나 더 만들면 새 탭이
//          `2` 를 다시 쓴다 — herdr 표찰이었다면 계속 올라간다(사용자가 본 `terminal 7`).
//
// 반례 빌드에서 돌리면 ⓐ 는 높이가 갈리고, ⓑ 는 긴 프롬프트 문자열이나 `terminal N` 이 뜨고,
// ⓒ 는 새 탭이 `claude 5` 가 된다 (관문 ⑤ 반례 3건).
// 격리(관문 ④): 앱·herdr 세션·레포·트랜스크립트 전부 격리 HOME 안이다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  SESSION,
  createTab,
  herdrCall,
  isolatedHome,
  resetSession,
  sleep,
  startApp,
  tabsOf,
  until,
  writeRaw,
} from './lib.mjs'

/** 사용자가 본 그 이름 그대로 — 이 폴더 이름이 곧 C9 의 기대값(`..sion-identity`)을 만든다. */
const REPO_REL = 'repos/byun618/corral/.claude/worktrees/LIFE-366-session-identity'
const EXPECTED_CWD_LABEL = '..sion-identity'
const SESSION_ID = 'a7a7a7a7-b7b7-4b7b-8b7b-000000000077'
const SECONDARY_TEXT =
  '한 줄 행에서 2차 줄은 제목 뒤에 " - " 로 붙는다. 길면 제목과 **같이** 잘리고 전문은 툴팁에 남는다.'

/** 격리 HOME 아래 그 경로에 레포를 판다 — `makeScratchRepo` 는 tmpdir 이라 `~` 로 안 접힌다. */
function makeRepoInHome() {
  const root = path.join(isolatedHome(), REPO_REL)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-b', 'main', root], { encoding: 'utf8' })
  fs.writeFileSync(path.join(root, 'README.md'), 'l366 r7 scratch\n')
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  git('add', 'README.md')
  git('-c', 'user.email=l366@test', '-c', 'user.name=l366', 'commit', '-m', 'init')
  return { root: fs.realpathSync(root), git }
}

async function readTabs(app) {
  const code = `(() => [...document.querySelectorAll('.main-tab')].map((tab) => ({
    tabId: tab.getAttribute('data-main-tab'),
    label: (tab.querySelector('.main-tab-label') ?? {}).textContent ?? null,
  })))()`
  return (await app.send({ cmd: 'eval', code })).result
}

/** 사이드바 행을 **실측 상자**까지 읽는다 — C8 의 통과선이 높이라 글자만 봐서는 못 잰다. */
async function readRows(app) {
  const code = `(() => [...document.querySelectorAll('.session-row')].map((row) => {
    const text = row.querySelector('.session-row-text')
    const title = row.querySelector('.session-row-title')
    const second = row.querySelector('.session-row-second')
    const box = row.getBoundingClientRect()
    const styleOf = (node) => (node === null ? null : getComputedStyle(node).color)
    return {
      tabId: row.getAttribute('data-tab'),
      active: row.classList.contains('is-active'),
      높이: Math.round(box.height * 100) / 100,
      제목: title === null ? null : title.textContent,
      '2차 줄': second === null ? null : second.textContent,
      '한 칸 글': text === null ? null : text.textContent,
      툴팁: text === null ? null : text.getAttribute('title'),
      '칸이 넘치나': text === null ? null : text.scrollWidth > text.clientWidth,
      '제목 색': styleOf(title),
      '2차 줄 색': styleOf(second),
      '줄 수(글상자 높이 / 줄높이)':
        text === null ? null : Math.round((text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).fontSize)) * 100) / 100,
    }
  }))()`
  return (await app.send({ cmd: 'eval', code })).result
}

const transcriptDir = () => path.join(isolatedHome(), '.claude', 'projects', 'l366-r7')

function writeTranscript(lines) {
  const dir = transcriptDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

const metaRecord = () => JSON.stringify({ type: 'attachment', sessionId: SESSION_ID })

const userRecord = (text) =>
  JSON.stringify({
    type: 'user',
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  })

const assistantText = (text) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })

async function closeTab(app, tabId) {
  await app.click(`[data-close-tab="${tabId}"]`)
  // 에이전트가 돌고 있으면 종료 확인이 뜬다 (F2) — 같은 손잡이를 탄다.
  const modal = await until(async () => (await app.query('[data-confirm-close-modal]')).found.length > 0, {
    timeoutMs: 4000,
    everyMs: 150,
    what: '종료 확인',
  }).catch(() => ({ ok: false }))
  if (modal.ok) await app.click('[data-close-confirm-ok]')
  return until(async () => (await app.query(`[data-main-tab="${tabId}"]`)).found.length === 0, {
    timeoutMs: 20000,
    everyMs: 200,
    what: `탭 ${tabId} 닫힘`,
  })
}

/** 에이전트 탭이 `agents` 개가 될 때까지 만들고, **새로 생긴 탭**을 돌려준다. */
async function addAgentTab(app, root) {
  const before = new Set((await tabsOf(app, root)).map((tab) => tab.tabId))
  await createTab(app, root, 'claude')
  const found = await until(
    async () => {
      const tabs = await tabsOf(app, root)
      const fresh = tabs.find((tab) => !before.has(tab.tabId) && tab.panes.some((pane) => pane.agent !== null)) ?? null
      return fresh === null ? false : fresh
    },
    { timeoutMs: 60000, everyMs: 300, what: 'claude 탭' },
  )
  return found.value
}

async function labelOf(app, tabId) {
  return (await readTabs(app)).find((row) => row.tabId === tabId)?.label ?? null
}

async function main() {
  const out = { at: new Date().toISOString(), session: SESSION, isolatedHome: isolatedHome() }
  out['세션 초기화'] = await resetSession()
  fs.rmSync(transcriptDir(), { recursive: true, force: true })

  const repo = makeRepoInHome()
  out['스크래치 레포'] = { root: repo.root, '홈 아래인가': repo.root.startsWith(isolatedHome()) }

  const app = await startApp({ name: '26-r7-orca' })
  out.appReady = app.ready
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length === 1, { timeoutMs: 15000, what: 'worktree row' })
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(async () => (await tabsOf(app, repo.root)).length > 0, { timeoutMs: 30000, what: 'worktree opened' })

  // --- ⓑ C9 — 셸 탭 폴백이 **잘린 경로**다 --------------------------------------------------
  const shell = (await tabsOf(app, repo.root))[0]
  const shellLabel = await until(async () => (await labelOf(app, shell.tabId)) === EXPECTED_CWD_LABEL, {
    timeoutMs: 20000,
    everyMs: 250,
    what: 'ⓑ 잘린 경로',
  }).catch(() => ({ ok: false, ms: null }))
  out['ⓑ 셸 탭 폴백 = 잘린 경로 (C9)'] = {
    'pane cwd': shell.panes[0]?.cwd ?? null,
    'pane 제목(OSC 2 — 거절 대상)': shell.panes[0]?.title ?? null,
    기대: EXPECTED_CWD_LABEL,
    '그려진 탭 제목': await labelOf(app, shell.tabId),
    '자릿수(zsh %15<)': (await labelOf(app, shell.tabId))?.length ?? null,
    ms: shellLabel.ms ?? null,
    통과: (await labelOf(app, shell.tabId)) === EXPECTED_CWD_LABEL,
    설명: 'herdr 가 OSC 1 을 안 줘서 corral 이 같은 값을 계산한다 — 반례(절단 규칙 제거)는 여기서 긴 문자열이나 `terminal N` 이 된다.',
  }
  const shotShell = await app.shot('r7-shell-cwd-label')

  // --- ⓒ C10 — 비어 있는 **가장 작은** 번호 -------------------------------------------------
  //
  // 셸 탭이 1번을 쥐고, 에이전트 탭 셋이 2·3·4 를 받는다. 2·3 을 닫고 하나 더 만들면 새 탭이
  // **2** 를 다시 쓴다. herdr 표찰이었다면 `claude 5` 다.
  const agents = []
  for (let index = 0; index < 3; index += 1) agents.push(await addAgentTab(app, repo.root))
  const labels = []
  for (const tab of agents) {
    const label = await until(async () => (await labelOf(app, tab.tabId))?.startsWith('claude ') === true, {
      timeoutMs: 30000,
      everyMs: 300,
      what: `claude 폴백 제목 (${tab.tabId})`,
    }).catch(() => ({ ok: false }))
    labels.push({ tabId: tab.tabId, 'herdr 표찰(number)': tab.number, 그려진: await labelOf(app, tab.tabId), ok: label.ok })
  }
  const keep = agents[2]
  const keepBefore = await labelOf(app, keep.tabId)
  for (const tab of [agents[0], agents[1]]) await closeTab(app, tab.tabId)
  await sleep(1200)
  const keepAfter = await labelOf(app, keep.tabId)
  const fresh = await addAgentTab(app, repo.root)
  await until(async () => (await labelOf(app, fresh.tabId))?.startsWith('claude ') === true, {
    timeoutMs: 30000,
    everyMs: 300,
    what: '새 탭 폴백 제목',
  }).catch(() => ({ ok: false }))
  const freshLabel = await labelOf(app, fresh.tabId)
  out['ⓒ 폴백 번호 = 비어 있는 가장 작은 번호 (C10)'] = {
    '만든 순서대로': labels,
    '닫은 탭': [agents[0].tabId, agents[1].tabId],
    '남은 탭 — 닫기 전': keepBefore,
    '남은 탭 — 닫은 뒤': keepAfter,
    '남은 탭의 번호가 그대로인가 (②)': keepBefore !== null && keepBefore === keepAfter,
    '새 탭 herdr 표찰(number)': fresh.number,
    '새 탭에 그려진 제목': freshLabel,
    '빈 번호를 다시 쓰는가 (①)': freshLabel === 'claude 2',
    통과: keepBefore === keepAfter && freshLabel === 'claude 2',
    설명: '표찰이었다면 새 탭은 `claude ' + fresh.number + '` 였다 — 사용자가 본 `terminal 7` 이 그 모양이다.',
  }

  // --- ⓐ C8 — 한 줄 · 높이 고정 · 한 칸에서 같이 잘림 ---------------------------------------
  //
  // 사이드바에 에이전트 행 둘이 있다. 하나에만 트랜스크립트를 붙여 **2차 줄이 있는 행과 없는 행**을
  // 같은 화면에 세운다 — B4(빈 슬롯 유지)를 폐기하고도 높이가 같은지는 이 두 행을 나란히 재야 안다.
  writeTranscript([metaRecord(), userRecord('한 줄 행을 재는 세션이다. 제목은 이 말에서 나온다.'), assistantText(SECONDARY_TEXT)])
  await herdrCall('pane.report_agent_session', {
    pane_id: keep.panes[0].paneId,
    source: 'herdr:claude',
    agent: 'claude',
    seq: Date.now(),
    agent_session_id: SESSION_ID,
  })
  await app.send({ cmd: 'resync', reason: 'l366-r7-secondary' })
  await until(
    async () => {
      const rows = await readRows(app)
      return rows.some((row) => row['2차 줄'] !== null)
    },
    { timeoutMs: 30000, everyMs: 400, what: 'ⓐ 2차 줄이 붙은 행' },
  )
  const rows = await readRows(app)
  const withSecond = rows.filter((row) => row['2차 줄'] !== null)
  const withoutSecond = rows.filter((row) => row['2차 줄'] === null)
  const heights = [...new Set(rows.map((row) => row.높이))]
  out['ⓐ 세션 행은 한 줄 (C8)'] = {
    행: rows,
    '2차 줄이 있는 행': withSecond.length,
    '2차 줄이 없는 행': withoutSecond.length,
    '행 높이(중복 제거)': heights,
    '높이가 하나뿐인가 (C8-② — B4 폐기해도 안 튄다)': heights.length === 1,
    '한 줄 높이인가 (21px 토큰)': heights.length === 1 && heights[0] <= 22,
    '한 칸에서 같이 잘리나': withSecond.every((row) => row['칸이 넘치나'] === true),
    '툴팁에 전문이 있나': withSecond.every((row) => row.툴팁 === `${row.제목} - ${row['2차 줄'].replace(/^ - /, '')}`),
    '2차 줄이 더 흐린가': withSecond.every((row) => row['2차 줄 색'] !== row['제목 색']),
    '2차 줄이 없으면 " - " 도 없나': withoutSecond.every((row) => (row['한 칸 글'] ?? '').includes(' - ') === false),
    통과:
      heights.length === 1 &&
      heights[0] <= 22 &&
      withSecond.length > 0 &&
      withoutSecond.length > 0 &&
      withSecond.every((row) => row['칸이 넘치나'] === true && row['2차 줄 색'] !== row['제목 색']),
  }
  const shotRow = await app.shot('r7-one-line-row')

  // 활성 행에서 **둘 다** 밝아지는지 — 행을 눌러 활성으로 만들고 같은 두 색을 다시 잰다.
  await app.click(`[data-tab="${keep.tabId}"]`)
  await sleep(600)
  const activeRows = await readRows(app)
  const active = activeRows.find((row) => row.tabId === keep.tabId) ?? null
  const before = rows.find((row) => row.tabId === keep.tabId) ?? null
  out['ⓐ-2 활성 행에서는 둘 다 밝아진다 (C8)'] = {
    '활성 전': before === null ? null : { 제목: before['제목 색'], '2차 줄': before['2차 줄 색'] },
    '활성 후': active === null ? null : { 제목: active['제목 색'], '2차 줄': active['2차 줄 색'] },
    '2차 줄이 밝아졌나': before !== null && active !== null && before['2차 줄 색'] !== active['2차 줄 색'],
    '여전히 제목보다 흐린가': active !== null && active['2차 줄 색'] !== active['제목 색'],
    통과:
      before !== null &&
      active !== null &&
      before['2차 줄 색'] !== active['2차 줄 색'] &&
      active['2차 줄 색'] !== active['제목 색'],
  }
  const shotActive = await app.shot('r7-active-row')

  out.판정 = {
    'ⓐ 세션 행 한 줄 · 높이 고정 (C8·C8-②)': out['ⓐ 세션 행은 한 줄 (C8)'].통과,
    'ⓐ-2 활성 행에서 둘 다 밝아진다 (C8)': out['ⓐ-2 활성 행에서는 둘 다 밝아진다 (C8)'].통과,
    'ⓑ 셸 탭 폴백 = 잘린 경로 (C9)': out['ⓑ 셸 탭 폴백 = 잘린 경로 (C9)'].통과,
    'ⓒ 폴백 번호 재사용 (C10 ①)': out['ⓒ 폴백 번호 = 비어 있는 가장 작은 번호 (C10)']['빈 번호를 다시 쓰는가 (①)'],
    'ⓒ 남은 탭 번호 불변 (C10 ②)': out['ⓒ 폴백 번호 = 비어 있는 가장 작은 번호 (C10)']['남은 탭의 번호가 그대로인가 (②)'],
  }
  out.샷 = { shotShell, shotRow, shotActive }
  await app.stop()
  writeRaw('r7-orca.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out.판정, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
