// ①×② 가 같이 선 화면 — 두 가지를 동시에 갚는다.
//
//   ⓐ **영역 3개(중첩 분할)** — ① 결함 4(`overheadOf` 가 깊이 훑어 형제 폭을 오버헤드로 셌다)의
//      실측 공백. 2영역만 재는 F1 으로는 안 잡히는 자리다. 바깥 경계를 끌어서 배지를 본다:
//      중첩된 쪽은 셀 수가 없으므로 `—`, 리프 쪽은 숫자 == 그 영역의 커밋된 격자여야 한다
//   ⓑ **§10-R21-1c** — 장식 행 메타가 철회됐으니 "① 영역 경계 / ② pane 경계"가 **탭바 관통
//      여부만으로** 갈리는지 화면으로 보인다 (2분할·3영역 중첩)
//
// 격리: `life373-` 세션 전용. M0: 유령 앱 0 에서만 유효하다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION, until } from '../l353/lib.mjs'
import { attachThisWorktree, dragDivider, ensureTabs, g1, moveTabToNewGroup, quiesce, snapshot, tabsOf } from './app-steps.mjs'
import { m0End, m0Start, resetPanes, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-f1b-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')

const 결과 = { at: new Date().toISOString(), 세션: SESSION, M0 }
결과.초기화 = await resetPanes()

const app = await startApp({ name: 'f1b-nested', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await ensureTabs(app, 3)
await sleep(800)
await quiesce(app)

/** 영역 하나하나의 격자 + 경계선 생김새. 두 층이 화면에서 어떻게 갈리는지를 숫자로도 남긴다. */
const 층 = async (label) => {
  const snap = await snapshot(app, label)
  const 경계 = (await app.send({
    cmd: 'eval',
    code: `(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: +r.left.toFixed(1), y: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) } }
      const bar = document.querySelector('[data-main-tabbar]')
      return {
        탭바: bar === null ? null : box(bar),
        영역경계: [...document.querySelectorAll('[data-group-divider]')].map((el) => ({ id: el.dataset.groupDivider, 상자: box(el) })),
        pane경계: [...document.querySelectorAll('[data-pane-divider]')].map((el) => ({ id: el.dataset.paneDivider, 상자: box(el) })),
      }
    })()`,
  })).result
  결과[label] = { 화면: snap, 경계 }
  console.log(label, '| 영역', snap.영역수, '| 영역경계', 경계.영역경계.length, '| pane경계', 경계.pane경계.length, '| G1', snap.G1.위반, snap.G1.여백위반, snap.G1.내용잘림)
  return 결과[label]
}

await 층('시작 (영역 1 · pane 1)')
await app.shot('f1b-a-single')

// ⓐ-1 영역 2개.
{
  const tabs = tabsOf(await app.state())
  await moveTabToNewGroup(app, { tabId: tabs[1].tabId, direction: 'right' })
  await sleep(1200)
  await 층('영역 2')
  await app.shot('f1b-b-two-groups')
}

// ⓑ 같은 화면에 ② 를 얹는다 — 활성 영역의 pane 을 하나 쪼갠다.
{
  const groupId = (await app.state()).terminalGroups.at(-1)?.groupId ?? null
  if (groupId === null) throw new Error('영역이 없다')
  await app.click(`[data-tab-group="${groupId}"]`)
  await sleep(500)
  await app.click(`[data-group-split-down="${groupId}"]`)
  await sleep(1500)
  await 층('영역 2 × pane 2 (두 층)')
  await app.shot('f1b-c-two-layers')
}

// ⓐ-2 영역 3개 — 한 쪽이 또 쪼개진 중첩 분할.
{
  // 탭이 2개 이상인 영역에서 골라야 한다 — 원 영역 탭이 하나면 메뉴 항목이 죽어 있다.
  const 영역별 = (await snapshot(app, '중첩 직전')).영역별탭
  const 넉넉한 = 영역별.find((g) => g.tabs.length > 1)
  if (넉넉한 === undefined) throw new Error('탭 2개 이상인 영역이 없다')
  const 활성탭 = (await app.state()).terminalGroups.find((t) => t.groupId === 넉넉한.groupId)?.tabId ?? null
  const other = 넉넉한.tabs.find((t) => t !== 활성탭) ?? 넉넉한.tabs[0]
  await moveTabToNewGroup(app, { tabId: other, direction: 'down' })
  await sleep(1500)
  await 층('영역 3 (중첩)')
  await app.shot('f1b-d-three-groups')
}

// ⓐ-3 **바깥 경계**를 끈다. 중첩된 쪽은 배지에 `—`, 리프 쪽은 숫자 == 커밋된 격자.
{
  const outer = (await app.send({
    cmd: 'eval',
    code: `(() => {
      const split = document.querySelector('[data-group-split]')
      const divider = split === null ? null : split.querySelector(':scope > [data-group-divider]')
      return divider === null ? null : { id: divider.dataset.groupDivider, dir: [...split.classList].find((c) => c.startsWith('dir-')) }
    })()`,
  })).result
  if (outer === null) throw new Error('바깥 경계가 없다')
  const direction = outer.dir === 'dir-row' ? 'row' : 'column'
  결과.바깥경계드래그 = await dragDivider(app, {
    selector: `[data-group-divider="${outer.id}"]`,
    direction,
    shot: 'f1b-e-outer-drag',
  })
  await sleep(600)
  결과.바깥경계드래그.뒤 = await 층('바깥 경계 커밋 뒤')
  console.log('바깥 경계', outer.id, direction, '| 배지', 결과.바깥경계드래그.고스트.배지)
  await app.shot('f1b-f-outer-committed')
}

await app.stop()
await sleep(800)
결과.M0b = m0End()
writeRaw('f1b-nested.json', 결과)
