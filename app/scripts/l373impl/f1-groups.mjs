// F1 통과선 — 영역이 실제로 서나 (LIFE-373 ①). 화면에서 본 것만 적는다.
//
// LIFE-353 하네스의 앱 구동·control 채널을 그대로 쓴다(재는 도구는 같은 것이 낫다).
// 판정 원자료는 **LIFE-373 쪽**에 쓴다 — 앱 로그·스크린샷만 l353 의 `_runs/` 에 남는다.
//
//   ⓐ F1-1 기본 1영역 → 탭 메뉴 「오른쪽 영역」 → 2영역(탭이 빠져나가고 연결이 하나 는다)
//   ⓑ F1-3 다른 영역 헤더를 누르면 포커스가 그리로 간다 (활성 표시·attach 순서)
//   ⓒ F1-7 창을 좁히면 비활성 탭이 아이콘만으로 접힌다 (폭 3점 — **드래그보다 먼저**, 아래 주석)
//   ⓓ F1-2 경계 드래그 — **끄는 동안 sync·resize 0**, mouseup 에 각각 1회. 셀 스냅·배지.
//   ⓔ F1-6 재기동 복원 — 같은 ui-prefs·registry 로 다시 띄워 배치가 돌아오나
//   ⓕ F1-4 영역의 마지막 탭을 닫으면 빈 카드가 서고 연결이 하나 준다
//   ⓖ F1-5 영역 닫기 — 형제가 자리를 먹고 탭을 물려받는다
//   ⓗ F1-2(세로) 아래 영역으로 나눈 뒤 경계 드래그 — overhead ≠ 0 · 배지 rows · 셀 바닥 1칸
//   ⓘ F1-2 클램프 양 끝(.15/.85) — 반 칸이 끝을 넘는지는 거기서만 드러난다
//
// 격리(관문 ⑤): `life373-` 세션에서만 돈다. l353 lib 는 `LIFE353_SESSION` 을 보므로 거기에
// 박아 넣고, 여기서 한 번 더 막는다 — 사용자 default 세션에 붙는 순간 끝이다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, dragDivider, ensureTabs, moveTabToNewGroup, resizeEvents, snapshot, syncEvents, tabsOf } from './app-steps.mjs'
import { m0End, m0Start, resetPanes, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION}) — LIFE353_SESSION=life373-… 로 띄워라`)

/** M0 — 이 런이 유효한가. 시작 전 잔여가 0 이 아니면 CPU·rAF 계열은 무효다. */
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-f1-'))
const PREFS = path.join(RUN_DIR, 'ui-prefs.json')
const REGISTRY = path.join(RUN_DIR, 'repos.json')
const APP_ENV = { CORRAL_UI_PREFS: PREFS }

const 결과 = { at: new Date().toISOString(), 세션: SESSION, prefs: PREFS, M0 }
// pane 이 둘 이상이면 장식이 생겨 격자가 달라진다 — ① 의 숫자는 pane 하나에서 잰다.
결과.초기화 = await resetPanes()

// ── 1회차: ⓐ ⓑ ⓒ ⓓ, 그리고 2영역인 채로 종료해서 ⓔ 의 씨앗을 남긴다 ──────────────
const app = await startApp({ name: 'f1-groups', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await sleep(600)
await ensureTabs(app, 4)

결과.기본 = await snapshot(app, '기본 1영역')
await app.shot('f1-a-single')

// ⓐ F1-1
const tabs = tabsOf(await app.state())
const second = tabs[1]?.tabId ?? null
if (second === null) throw new Error('두 번째 탭이 없다')
결과.분할클릭 = await moveTabToNewGroup(app, { tabId: second })
결과.분할후 = await snapshot(app, '오른쪽 영역으로 옮기기')
await app.shot('f1-b-two-groups')

// ⓑ F1-3 — 첫 영역 헤더를 눌러 포커스를 되돌린다.
{
  const groups = 결과.분할후.영역별탭.map((g) => g.groupId)
  const target = groups[0]
  const since = Date.now()
  await app.click(`[data-group-header="${target}"]`)
  await sleep(700)
  const after = await snapshot(app, `헤더 클릭 → ${target}`)
  결과.포커스전환 = {
    누른영역: target,
    이전활성: 결과.분할후.활성영역,
    이후활성: after.활성영역,
    /**
     * 화면이 **선언한** 순서 그대로다 — attach 순서가 아니다.
     * S2-b(활성이 마지막에 붙는다)는 main 이 `stream.ts` 에서 `active` 로 정렬해 지킨다
     * (`[...groups].sort((a, b) => Number(a.active) - Number(b.active))`). 그래서 여기 활성 영역이
     * 앞에 적혀 있어도 S2-b 위반이 아니다. S2-b 자체는 attach 로그로 따로 잰다.
     */
    선언순서_정렬전: syncEvents(app, since).at(-1)?.groups ?? null,
    /**
     * "활성 pane 도 같이 옮겨진다"를 **DOM 포커스로** 잰다 — 추정 금지. 헤더 div 는 포커스를
     * 받지 않으므로 이게 참이려면 `activateGroup` 의 `selectPane` → `focusToken` 경로가
     * 실제로 xterm 의 textarea 를 잡아야 한다. 잡은 쪽 영역 id 를 그대로 적는다.
     */
    포커스한영역: (await app.send({
      cmd: 'eval',
      code: `document.activeElement?.closest('[data-term-group]')?.dataset.termGroup ?? null`,
    })).result,
    포커스요소: (await app.send({
      cmd: 'eval',
      code: `document.activeElement === null ? null : (document.activeElement.tagName + '.' + (document.activeElement.className || ''))`,
    })).result,
    스냅샷: after,
  }
  await app.shot('f1-c-focus')
}

// ⓒ F1-7 — 폭 3점. 좁힐수록 비활성 탭이 접힌다.
//
// 경계 드래그보다 **먼저** 잰다. 드래그가 비율을 한쪽으로 몰아 놓으면 넓은 창에서도 이미 접힌
// 상태로 시작해서 "접힘이 켜지는 지점"이 안 보인다 (첫 회차에서 실제로 그랬다).
{
  const widths = [1400, 1000, 760]
  const 점 = []
  for (const width of widths) {
    await app.resizeWindow(width, 900)
    await sleep(1100)
    const shot = await app.shot(`f1-e-width-${width}`)
    const measured = (await app.send({
      cmd: 'eval',
      code: `[...document.querySelectorAll('[data-group-header]')].map((h) => ({
        groupId: h.dataset.groupHeader,
        헤더폭: Math.round(h.getBoundingClientRect().width),
        접힘: h.dataset.headerCompact,
        탭: [...h.querySelectorAll('[data-main-tab]')].map((t) => ({ 접힘: t.dataset.tabCompact, 폭: Math.round(t.getBoundingClientRect().width) })),
      }))`,
    })).result
    점.push({ width, 헤더: measured, shot: shot.file })
  }
  결과.탭접기 = 점
  await app.resizeWindow(1400, 900)
  await sleep(900)
}

// ⓓ F1-2 — 경계 드래그(가로). 끄는 동안 격자 요청이 **한 번도** 나가면 안 된다.
결과.경계드래그 = await dragDivider(app, { selector: '[data-group-divider]', direction: 'row', shot: 'f1-d-drag-ghost' })
await app.shot('f1-d-drag-committed')

// ⓘ F1-2 클램프 양 끝 — 반 칸(`+unit/2`)이 `.15`/`.85` 를 넘는지는 **끝에서만** 드러난다.
//    코디네이터 추가 요구(2026-09-16): 양 끝에서도 배지 == 커밋 격자임을 원자료로 보여라.
결과.클램프 = {
  최소: await dragDivider(app, { selector: '[data-group-divider]', direction: 'row', step: 240, shot: 'f1-k-clamp-min' }),
  최대: await dragDivider(app, { selector: '[data-group-divider]', direction: 'row', step: -240, shot: 'f1-k-clamp-max' }),
}

결과.종료직전 = await snapshot(app, '재기동 직전')
결과.종료직전저장 = JSON.parse(fs.readFileSync(PREFS, 'utf8')).groupLayouts ?? null
await app.stop()
await sleep(800)

// ── 2회차: ⓔ 복원 → ⓕ 빈 영역 → ⓖ 영역 닫기 ────────────────────────────────────
const app2 = await startApp({ name: 'f1-groups-restart', env: APP_ENV, registryFile: REGISTRY })
await sleep(2500)
결과.재기동후 = await snapshot(app2, '재기동 후 복원')
await app2.shot('f1-f-restored')

// ⓕ F1-4 — 두 번째 영역의 탭을 전부 닫으면 빈 카드가 선다.
{
  const groups = 결과.재기동후.영역별탭
  const victim = groups.at(-1)
  const before = 결과.재기동후.연결.length
  for (const tabId of victim?.tabs ?? []) {
    await app2.click(`[data-main-tab-close="${tabId}"]`)
    await sleep(900)
  }
  await sleep(1200)
  결과.빈영역 = {
    비운영역: victim?.groupId ?? null,
    연결_전: before,
    스냅샷: await snapshot(app2, '마지막 탭을 닫은 뒤'),
    카드: (await app2.query(`[data-empty-group-new]`)).found.length,
  }
  await app2.shot('f1-g-empty-group')
}

// ⓖ F1-5 — 영역 닫기. 형제가 자리를 먹고 남은 탭을 물려받는다.
{
  const closer = (await app2.query('[data-empty-group-close]')).found[0] ?? null
  결과.영역닫기 = { 버튼: closer }
  if (closer !== null) {
    await app2.click('[data-empty-group-close]')
    await sleep(1600)
    결과.영역닫기.스냅샷 = await snapshot(app2, '영역을 닫은 뒤')
    await app2.shot('f1-h-closed')
  }
}

결과.저장된배치 = JSON.parse(fs.readFileSync(PREFS, 'utf8')).groupLayouts ?? null

// ⓗ F1-2(세로) — 같은 경계를 세로로. 가로와 달리 각 쪽에 탭바가 얹혀 overhead ≠ 0 이고
//    배지 단위가 rows, 셀 바닥이 1칸이다. 이 경로는 여기서만 화면에서 돈다.
{
  const remaining = tabsOf(await app2.state())
  const victim = remaining[1]?.tabId ?? null
  if (victim === null) {
    결과.세로드래그 = { 건너뜀: '탭이 2개 미만이라 세로 분할을 못 만든다', 탭수: remaining.length }
  } else {
    결과.세로분할클릭 = await moveTabToNewGroup(app2, { tabId: victim, direction: 'down' })
    결과.세로분할후 = await snapshot(app2, '아래 영역으로 옮기기')
    await app2.shot('f1-i-column-split')
    결과.세로드래그 = await dragDivider(app2, { selector: '[data-group-divider]', direction: 'column', shot: 'f1-i-column-ghost' })
    await app2.shot('f1-j-column-committed')
  }
}

await app2.stop()
await sleep(800)
결과.M0b = m0End()

writeRaw('f1-groups.json', 결과)
console.log(JSON.stringify(결과, null, 2))
process.exit(0)
