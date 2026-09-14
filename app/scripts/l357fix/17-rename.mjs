// I-7 — 인라인 리네임. 사용자가 준 이름이 제목 1순위인가, 그리고 그 이름이 어디에 사는가.
//
// 재는 것:
//   ① 리네임 **전/후 `TabRow.label` 실측** — "herdr 기본 label 은 순수 숫자" 라는 판별자가
//      실제로 성립하는지. 지시서가 요구한 필수 원자료다. 안 성립하면 그 사실을 적는다.
//   ② **우선순위 2단** — OSC 제목(`PROBE-TITLE`)이 **살아 있는 채로** 사용자 이름이 이긴다.
//      이게 없으면 "1순위 > 폴백" 만 증명되고 "1순위 > 2순위(OSC)" 는 안 증명된다.
//   ③ 사이드바·탭바가 **같이** 바뀐다 (에이전트 탭 하나로).
//   ④ 편집 중 키가 터미널로 안 샌다 — **양성 대조 먼저**. 터미널이 포커스일 때 같은 글자가
//      화면에 뜨는 걸 보이고 나서, 편집 중엔 안 뜨는 걸 보인다. 못 실패하는 단언은 증거가 아니다.
//   ⑤ Esc 취소 · 공백만 취소 · 씨앗과 동일이면 무요청.
//   ⑥ 비활성 탭 더블클릭 — 첫 클릭이 pane 을 바꾸며 터미널 포커스를 뺏어가지 않는가.
//   ⑦ 재기동 후에도 이름이 남는가 — **로컬 영속 계층이 없다**는 판정의 근거다.
//
// **안 잰 것 (공백은 공백으로 명시)**: herdr 거절 통과(승격 금지). 거절을 억지로 만들려면 없는
// tab_id 로 `window.corral.renameRow` 를 직접 불러야 하는데, 제어 채널의 `eval` 은 **읽기 전용**이
// 규칙이다(control.ts) — 증거 하나 얻자고 하네스 규율을 깨지 않는다. 화면에서 갈 수 있는 길로는
// 거절이 안 나온다(탭이 있어야 더블클릭이 된다).
import { buildMixedFixture, createTab, makeScratchRepo, sleep, startApp, tabsOf, until, writeRaw } from './lib.mjs'

const USER_NAME = '배포 점검'
const OSC_TITLE = 'PROBE-TITLE'

async function screenText(app) {
  const r = await app.send({ cmd: 'term-read' }).catch(() => null)
  const term = r?.term ?? {}
  return (term.lines ?? term.rows ?? []).join('\n')
}

/** 화면에 그려진 제목 — 사이드바(세션 행)와 탭바 양쪽. */
async function shownTitles(app, tabId) {
  return (
    await app.send({
      cmd: 'eval',
      code: `(() => {
        const id = ${JSON.stringify(tabId)}
        const row = document.querySelector('[data-tab="' + id + '"] .session-row-title')
        const tab = document.querySelector('[data-main-tab="' + id + '"] .main-tab-label')
        const input = document.querySelector('[data-tab-rename="' + id + '"]')
        const style = input === null ? null : getComputedStyle(input)
        return {
          sidebar: row === null ? null : row.textContent,
          tabbar: tab === null ? null : tab.textContent,
          inputInDom: input !== null,
          inputOpacity: style === null ? null : style.opacity,
          inputPointerEvents: style === null ? null : style.pointerEvents,
          editingFlag: document.querySelector('[data-main-tab="' + id + '"]')?.getAttribute('data-tab-editing') ?? null,
          focusedIsRenameInput: document.activeElement === input,
          activeElement: document.activeElement === null ? null : document.activeElement.tagName.toLowerCase(),
        }
      })()`,
    })
  ).result
}

async function labelOf(app, worktreePath, tabId) {
  const tabs = await tabsOf(app, worktreePath)
  const tab = tabs.find((t) => t.tabId === tabId) ?? null
  return {
    label: tab?.label ?? null,
    paneTitles: tab?.panes.map((p) => p.title) ?? [],
  }
}

/** 편집 진입 — 더블클릭 후 입력칸이 실제로 포커스를 잡았는지까지 확인한다. */
async function beginEdit(app, tabId) {
  const dbl = await app.dblclick(`[data-main-tab="${tabId}"] .main-tab-label`)
  await until(async () => (await shownTitles(app, tabId)).focusedIsRenameInput === true, {
    timeoutMs: 5000,
    what: '리네임 입력칸 포커스',
  }).catch(() => ({ ok: false }))
  return { dbl, state: await shownTitles(app, tabId) }
}

const repo = makeScratchRepo('rename')
const app = await startApp({ name: '17-rename' })
const out = { criterion: 'I-7 — 인라인 리네임 (사용자 이름 → OSC 제목 → 폴백)' }
try {
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-worktree="${repo.root}"]`)).found.length > 0, { timeoutMs: 15000, what: 'worktree 행' })
  await app.click(`[data-worktree="${repo.root}"]`)
  await until(
    async () => (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace != null,
    { timeoutMs: 20000, what: 'workspace 열림' },
  )

  // ---------- fixture: 셸 탭 1 + 에이전트 탭 1 ----------
  // 셸 탭은 ② OSC 우선순위와 ④ 키 누출을 재는 자리, 에이전트 탭은 ③ 사이드바를 재는 자리다
  // (사이드바는 에이전트 탭만 나열한다).
  await createTab(app, repo.root, 'shell')
  await until(async () => (await tabsOf(app, repo.root)).length >= 2, { timeoutMs: 20000, what: '셸 탭' })
  const shellTab = (await tabsOf(app, repo.root)).at(-1)
  await app.click(`[data-main-tab="${shellTab.tabId}"]`)
  await sleep(900)

  // OSC 제목을 실제로 심는다 — fix2 에서 122ms 만에 전파되는 걸 확인한 경로다.
  // ⚠ 1차 실행에선 제목이 안 남았다: zsh 가 **프롬프트를 그릴 때마다** 제목을 셸 프롬프트 꼴로
  // 되돌린다(`byun@host:/path`). 그래서 제목을 심은 뒤 `sleep` 으로 프롬프트를 막아 둔다 —
  // 그 사이에는 OSC 제목이 살아 있고, 그 상태에서 리네임이 그것을 이기는지 볼 수 있다.
  await app.type(`printf '\\033]0;${OSC_TITLE}\\007'; sleep 120\r`)
  const oscLanded = await until(
    async () => (await labelOf(app, repo.root, shellTab.tabId)).paneTitles.some((t) => t === OSC_TITLE),
    { timeoutMs: 15000, what: 'OSC 제목 전파' },
  )
    .then(() => true)
    .catch(() => false)

  const before = await labelOf(app, repo.root, shellTab.tabId)
  const shownBefore = await shownTitles(app, shellTab.tabId)

  // ---------- ④ 양성 대조: 터미널이 포커스면 글자가 화면에 뜬다 ----------
  // **편집 중과 같은 조건**(sleep 이 도는 중)에서 재야 대조가 성립한다. 지우지 않는다 —
  // 뒤에서 보는 건 다른 문자열(USER_NAME)이고, 지우는 동작이 또 하나의 변수가 된다.
  const CONTROL_WORD = 'LEAKCHECK'
  await app.type(CONTROL_WORD)
  await sleep(800)
  const controlScreen = await screenText(app)

  // ---------- ① ② 리네임 ----------
  const entered = await beginEdit(app, shellTab.tabId)
  // 편집 중 타이핑 — 이 글자들이 터미널에 뜨면 누출이다.
  await app.type(USER_NAME)
  await sleep(500)
  const screenWhileEditing = await screenText(app)
  const draftShown = (await app.query(`[data-tab-rename="${shellTab.tabId}"]`)).found
  await app.key('Return')
  const renamed = await until(
    async () => (await labelOf(app, repo.root, shellTab.tabId)).label === USER_NAME,
    { timeoutMs: 10000, what: 'label 갱신' },
  )
    .then(() => true)
    .catch(() => false)
  await sleep(400)
  const after = await labelOf(app, repo.root, shellTab.tabId)
  const shownAfter = await shownTitles(app, shellTab.tabId)

  // ---------- ⑤ Esc 취소 ----------
  await beginEdit(app, shellTab.tabId)
  await app.type('버려질 이름')
  await app.key('Escape')
  await sleep(600)
  const afterEscape = await labelOf(app, repo.root, shellTab.tabId)

  // ---------- ⑤ 공백만 → 취소 ----------
  await beginEdit(app, shellTab.tabId)
  // 기존 글자가 select 돼 있으므로 공백 하나를 치면 통째로 대체된다.
  await app.type('   ')
  await app.key('Return')
  await sleep(600)
  const afterBlank = await labelOf(app, repo.root, shellTab.tabId)

  // ---------- ③ 에이전트 탭: 사이드바·탭바 동시 반영 ----------
  await buildMixedFixture(app, repo.root, { agents: 1, shells: 0 })
  // `pane.agent` 부착은 기동 뒤에 온다 — 16-agent-icon-render 1차와 같은 함정이라 기다린다.
  await until(async () => (await tabsOf(app, repo.root)).some((t) => t.panes.some((p) => p.agent !== null)), {
    timeoutMs: 45000,
    what: '에이전트 pane 부착',
  })
  const agentTab = (await tabsOf(app, repo.root)).find((t) => t.panes.some((p) => p.agent !== null))
  await app.click(`[data-main-tab="${agentTab.tabId}"]`)
  await sleep(700)
  const agentBefore = await labelOf(app, repo.root, agentTab.tabId)
  await beginEdit(app, agentTab.tabId)
  await app.type('클로드 작업')
  await app.key('Return')
  await until(async () => (await labelOf(app, repo.root, agentTab.tabId)).label === '클로드 작업', {
    timeoutMs: 10000,
    what: '에이전트 탭 label 갱신',
  }).catch(() => ({ ok: false }))
  await sleep(500)
  const agentShown = await shownTitles(app, agentTab.tabId)

  // ---------- ⑥ 비활성 탭 더블클릭 ----------
  // 첫 클릭이 pane 을 바꾸면 터미널이 focus() 를 부른다. 그 포커스가 입력칸을 뺏는지 본다.
  await app.click(`[data-main-tab="${shellTab.tabId}"]`)
  await sleep(800)
  const inactiveEntry = await beginEdit(app, agentTab.tabId)
  await app.key('Escape')
  await sleep(300)

  const shot = await app.shot('rename-after')
  await app.stop()

  // ---------- ⑦ 재기동 ----------
  // 11-worktree-order 와 같은 결: 레지스트리를 공유하지 않고 같은 레포를 다시 담는다.
  // workspace 는 herdr 가 계속 들고 있으므로 탭도 이름도 그대로 돌아와야 한다.
  const app2 = await startApp({ name: '17-rename-restart' })
  await app2.addRepo(repo.root)
  await until(async () => (await app2.query('[data-worktree]')).found.length > 0, { timeoutMs: 20000, what: '재기동 후 worktree 행' })
  await sleep(1500)
  const restartTabs = await tabsOf(app2, repo.root)
  const restartLabels = restartTabs.map((t) => ({ tabId: t.tabId, label: t.label }))
  const restartShown = await shownTitles(app2, agentTab.tabId)
  await app2.stop()

  const leaked = screenWhileEditing.includes(USER_NAME)
  const controlVisible = controlScreen.includes(CONTROL_WORD)
  const checks = {
    a_defaultLabelIsNumeric: /^\d+$/.test(before.label ?? ''),
    b_labelBecameUserName: after.label === USER_NAME,
    c_oscTitleStillAlive: after.paneTitles.includes(OSC_TITLE),
    d_userNameBeatsOscTitle: shownAfter.tabbar === USER_NAME && shownBefore.tabbar === OSC_TITLE,
    e_sidebarAndTabbarAgree: agentShown.sidebar === '클로드 작업' && agentShown.tabbar === '클로드 작업',
    f_keyLeakPositiveControl: controlVisible,
    g_noLeakWhileEditing: !leaked,
    h_escapeCancels: afterEscape.label === USER_NAME,
    i_blankCancels: afterBlank.label === USER_NAME,
    j_inputAlwaysInDom: shownBefore.inputInDom && shownBefore.inputPointerEvents === 'none' && shownBefore.inputOpacity === '0',
    k_inactiveTabKeepsFocus: inactiveEntry.state.focusedIsRenameInput === true,
    l_survivesRestart: restartLabels.some((t) => t.label === '클로드 작업'),
  }

  Object.assign(out, {
    fixture: { repo: repo.root, shellTab: shellTab.tabId, agentTab: agentTab.tabId },
    labelBefore: before,
    labelAfter: after,
    shownBefore,
    shownAfter,
    agentBefore,
    agentShown,
    oscLanded,
    renamed,
    draftShown,
    entered: entered.state,
    inactiveEntry: inactiveEntry.state,
    afterEscape,
    afterBlank,
    keyLeak: { controlWord: CONTROL_WORD, controlVisible, leaked, screenWhileEditingTail: screenWhileEditing.slice(-200) },
    notMeasured: {
      rejectionPassthrough: 'eval 은 읽기 전용 규칙 — 거절을 만들 화면 경로가 없어 이번 라운드는 안 쟀다',
    },
    restart: { labels: restartLabels, shown: restartShown },
    checks,
    pass: Object.values(checks).every(Boolean),
    shot,
    clicks: app.clickLog(),
    rawChain: app.rawChain(),
  })
} catch (error) {
  out.error = String(error?.stack ?? error)
  await app.stop().catch(() => {})
}
writeRaw('rename/rename.json', out)
if (out.error) throw new Error(out.error)
