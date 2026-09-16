// F2 통과선 — 탭 안 pane 이 실제로 서나 (LIFE-373 ②). 화면에서 본 것만 적는다.
//
//   ⓐ F2-1 헤더 `▥` 로 우분할 — herdr `pane.split` 이 불리고 연결 수는 그대로다(분할은 탭 안이다)
//   ⓑ F2-6 / F2-6b **레이아웃 정합** — corral 이 그린 상자 vs 제3 오라클 `pane.layout`.
//      영역이 하나면 좌표계가 같으므로 **절대 셀 비교**까지 요구한다 (F2-6b)
//   ⓒ R17-1 pane 메타 행 — 장식 행에 `{n} · {종류} · {cols}×{rows}`
//   ⓓ F2-1 아래 분할까지 걸어 3 pane
//   ⓔ F2-2 경계 드래그 — 끄는 동안 서버에 0, mouseup 에 1회. **배지가 말한 칸 수 == 커밋 결과**
//   ⓕ F2-2 도달 구간 **밖**으로 끌기 — 거기서도 배지와 결과가 같은가 (코디네이터 요구)
//
// 격리: `life373-` 세션 전용(두 lib 가 각자 막는다). M0: 유령 앱 0 에서만 유효하다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, dragPaneDivider, quiesce, resizeEvents, snapshot, syncEvents } from './app-steps.mjs'
import { layout as herdrLayout, m0End, m0Start, resetPanes, writeRaw } from './lib.mjs'

if (!SESSION.startsWith('life373-')) throw new Error(`거부: 격리 세션이 아니다 (${SESSION})`)
const M0 = m0Start()

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'l373-f2-'))
const APP_ENV = { CORRAL_UI_PREFS: path.join(RUN_DIR, 'ui-prefs.json') }
const REGISTRY = path.join(RUN_DIR, 'repos.json')

/** corral 이 **그린 것** — DOM 상자와 메타 행. 셀로 되짚지 않고 px 그대로 적는다. */
async function drawn(app) {
  return (await app.send({
    cmd: 'eval',
    code: `(() => {
      const stack = document.querySelector('.term-pane-stack')
      if (stack === null) return null
      const origin = stack.getBoundingClientRect()
      const round = (v) => +v.toFixed(3)
      const groupBox = document.querySelector('[data-term-group]')
      const groupStyle = groupBox === null ? null : getComputedStyle(groupBox)
      return {
        상자: { width: round(origin.width), height: round(origin.height) },
        // 격자의 분모가 어디인지 확인한다 - term-group 은 패딩이 있고 터미널이 실제로 서는 곳은
        // 그 안쪽(term-pane-stack)이다. 둘이 다르면 요청 격자가 상자보다 넓다.
        // (이 안은 템플릿 리터럴이다 - 역따옴표를 쓰면 문자열이 거기서 끊긴다)
        분모: groupBox === null ? null : {
          rect: { width: round(groupBox.getBoundingClientRect().width), height: round(groupBox.getBoundingClientRect().height) },
          computed: { width: groupStyle.width, height: groupStyle.height },
          parseInt: { width: Number.parseInt(groupStyle.width, 10), height: Number.parseInt(groupStyle.height, 10) },
          boxSizing: groupStyle.boxSizing,
          padding: [groupStyle.paddingTop, groupStyle.paddingRight, groupStyle.paddingBottom, groupStyle.paddingLeft].join(' '),
          client: { width: groupBox.clientWidth, height: groupBox.clientHeight },
        },
        셀: window.corralTermProbe ? window.corralTermProbe.cell() : null,
        pane: [...stack.querySelectorAll('[data-term-pane-box]')].map((el) => {
          const box = el.getBoundingClientRect()
          const inner = el.querySelector('.term-pane-inner')?.getBoundingClientRect() ?? null
          const meta = el.querySelector('[data-term-pane-meta]')
          return {
            paneId: el.dataset.termPaneBox,
            선택: el.dataset.paneSelected,
            숨김: el.hidden,
            바깥: { x: round(box.left - origin.left), y: round(box.top - origin.top), width: round(box.width), height: round(box.height) },
            안쪽: inner === null ? null : { x: round(inner.left - origin.left), y: round(inner.top - origin.top), width: round(inner.width), height: round(inner.height) },
            메타: meta === null ? null : meta.textContent,
          }
        }),
      }
    })()`,
  })).result
}

/**
 * **제3 오라클**(control 소켓 별도 커넥션)이 보는 진짜 레이아웃. 앱 연결로 읽지 않는다 (관문 ④).
 * corral 이 그린 px 을 셀로 되짚지 않고, 셀 → px 로 **같은 방향**으로 환산해 맞춘다 (R13).
 */
function truth() {
  const live = herdrLayout()
  return {
    area: live.area,
    zoomed: live.zoomed,
    focused: live.focused_pane_id,
    splits: live.splits.map((split) => ({ id: split.id, direction: split.direction, ratio: split.ratio })),
    pane: live.panes.map((pane) => ({ paneId: pane.pane_id, rect: pane.rect, focused: pane.focused })),
  }
}

const 결과 = { at: new Date().toISOString(), 세션: SESSION, M0, 단계: [] }

결과.초기화 = await resetPanes()

const app = await startApp({ name: 'f2-panes', env: APP_ENV, registryFile: REGISTRY })
await attachThisWorktree(app)
await sleep(800)
await quiesce(app)

/**
 * **F2-6 / F2-6b 대조.** 사슬을 두 토막으로 끊어서 각각 잰다 — 한 번에 재면 어디서 어긋났는지
 * 안 보인다.
 *   ① corral 이 **아는** 사각형 == 제3 오라클 `pane.layout` (id 집합 · 절대 셀)
 *   ② corral 이 **그린** px == 그 사각형 × 바닥 셀 (원점 = 안쪽 사각형들의 왼쪽 위)
 * 영역이 하나뿐이라 좌표계가 같다 — F2-6b 가 요구하는 **절대 비교**를 그대로 한다.
 */
function 대조({ 그린것, 오라클, 상태 }) {
  const cell = 그린것?.셀?.measured ?? null
  const views = 상태.terminalGroups[0]?.panes ?? []
  const origin = {
    x: views.length === 0 ? 0 : Math.min(...views.map((v) => v.innerRect.x)),
    y: views.length === 0 ? 0 : Math.min(...views.map((v) => v.innerRect.y)),
  }
  const near = (a, b) => Math.abs(a - b) <= 0.5
  const 사슬1 = views.map((view) => {
    const truthRect = 오라클.pane.find((p) => p.paneId === view.paneId)?.rect ?? null
    return {
      paneId: view.paneId,
      corral: view.rect,
      herdr: truthRect,
      같다:
        truthRect !== null &&
        view.rect.x === truthRect.x &&
        view.rect.y === truthRect.y &&
        view.rect.width === truthRect.width &&
        view.rect.height === truthRect.height,
    }
  })
  const 사슬2 = views.map((view) => {
    const box = 그린것?.pane.find((p) => p.paneId === view.paneId) ?? null
    if (box === null || cell === null) return { paneId: view.paneId, 같다: false, 이유: '그린 상자가 없다' }
    const 기대 = {
      x: (view.rect.x - origin.x) * cell.width,
      y: (view.rect.y - origin.y) * cell.height,
      width: view.rect.width * cell.width,
      height: view.rect.height * cell.height,
    }
    const 안쪽기대 = {
      x: (view.innerRect.x - origin.x) * cell.width,
      y: (view.innerRect.y - origin.y) * cell.height,
      width: view.innerRect.width * cell.width,
      height: view.innerRect.height * cell.height,
    }
    return {
      paneId: view.paneId,
      기대,
      그림: box.바깥,
      안쪽기대,
      안쪽그림: box.안쪽,
      같다:
        near(기대.x, box.바깥.x) && near(기대.y, box.바깥.y) && near(기대.width, box.바깥.width) && near(기대.height, box.바깥.height),
      안쪽같다:
        box.안쪽 !== null &&
        near(안쪽기대.x, box.안쪽.x) &&
        near(안쪽기대.y, box.안쪽.y) &&
        near(안쪽기대.width, box.안쪽.width) &&
        near(안쪽기대.height, box.안쪽.height),
    }
  })
  return {
    원점: origin,
    id집합같다: JSON.stringify(views.map((v) => v.paneId).sort()) === JSON.stringify(오라클.pane.map((p) => p.paneId).sort()),
    사슬1_corral_vs_herdr: 사슬1,
    사슬2_그림_vs_사각형: 사슬2,
    통과: 사슬1.every((r) => r.같다) && 사슬2.every((r) => r.같다 && r.안쪽같다),
  }
}

const 기록 = async (label) => {
  await sleep(1200)
  const 그린것 = await drawn(app)
  const 오라클 = truth()
  const 상태 = await app.state()
  const row = { label, 그린것, 오라클, 화면: await snapshot(app, label), 대조: 대조({ 그린것, 오라클, 상태 }) }
  결과.단계.push(row)
  console.log(label, '| 정합', row.대조.통과, JSON.stringify(row.그린것?.pane.map((p) => [p.paneId, p.메타])))
  return row
}

결과.시작 = await 기록('분할 전 (pane 1)')
await app.shot('f2-a-single')

// ⓐ F2-1 — 헤더 `▥`. 실제 UI 경로로 연다.
{
  const groupId = (await app.state()).terminalGroups[0]?.groupId ?? null
  if (groupId === null) throw new Error('영역이 없다')
  const since = Date.now()
  await app.click(`[data-group-split-right="${groupId}"]`)
  결과.우분할 = await 기록('우분할 뒤 (pane 2)')
  결과.우분할.연결 = { resize: resizeEvents(app, since).length, sync: syncEvents(app, since).length }
  await app.shot('f2-b-split-right')

  await quiesce(app)
  await app.click(`[data-group-split-down="${groupId}"]`)
  결과.하분할 = await 기록('아래 분할 뒤 (pane 3)')
  await app.shot('f2-c-split-down')
}

// ⓔ·ⓕ F2-2 — 경계 드래그. 배지가 말한 칸 수와 커밋 결과가 같아야 한다.
/** 커밋 뒤 pane 들의 **내용 칸 수** — 배지와 같은 단위로 읽는다. */
const 내용칸 = async (direction) => {
  const views = (await app.state()).terminalGroups[0]?.panes ?? []
  return views
    .map((v) => ({ paneId: v.paneId, rect: v.rect, inner: v.innerRect }))
    .sort((a, b) => (direction === 'row' ? a.rect.x - b.rect.x : a.rect.y - b.rect.y))
}

{
  const drag = await dragPaneDivider(app, { direction: 'row', px: 120, shot: 'f2-d-drag-row' })
  결과.가로드래그 = { ...drag, 커밋후칸: await 내용칸('row'), 오라클: truth(), G1: (await snapshot(app, '가로 드래그 커밋')).G1 }
  결과.가로드래그.그린것 = await drawn(app)
  console.log('가로 드래그 | 배지', drag.고스트.배지, '| 칸', JSON.stringify(결과.가로드래그.커밋후칸.map((p) => [p.paneId, p.inner.width])))
  await app.shot('f2-d-drag-committed')
}

{
  // 도달 구간 밖 — 한 번에 갈 수 있는 것보다 훨씬 멀리 민다. 고스트가 구간 끝에 서야 하고,
  // 그 자리의 배지가 커밋 결과와 같아야 한다.
  const drag = await dragPaneDivider(app, { direction: 'row', px: -2000, shot: 'f2-e-drag-far' })
  결과.도달밖 = { ...drag, 커밋후칸: await 내용칸('row'), 오라클: truth() }
  console.log('도달 밖 | 배지', drag.고스트.배지, '| 칸', JSON.stringify(결과.도달밖.커밋후칸.map((p) => [p.paneId, p.inner.width])))
  await app.shot('f2-e-drag-far-committed')
}

{
  const drag = await dragPaneDivider(app, { direction: 'column', px: 90, shot: 'f2-f-drag-column' })
  결과.세로드래그 = { ...drag, 커밋후칸: await 내용칸('column'), 오라클: truth() }
  console.log('세로 드래그 | 배지', drag.고스트.배지, '| 칸', JSON.stringify(결과.세로드래그.커밋후칸.map((p) => [p.paneId, p.inner.height])))
  await app.shot('f2-f-drag-column-committed')
}

결과.끝 = await 기록('드래그 뒤 (pane 3)')

// M0-b 는 **앱을 멈춘 뒤** 잰다 — 먼저 재면 이 런이 띄운 Electron 을 유령으로 센다.
await app.stop()
await sleep(800)
결과.M0b = m0End()
writeRaw('f2-panes.json', 결과)
