// F2 통과선 — 탭 안 pane 이 실제로 서나 (LIFE-373 ②). 화면에서 본 것만 적는다.
//
//   ⓐ F2-1 헤더 `▥` 로 우분할 — herdr `pane.split` 이 불리고 연결 수는 그대로다(분할은 탭 안이다)
//   ⓑ F2-6 / F2-6b **레이아웃 정합** — corral 이 그린 상자 vs 제3 오라클 `pane.layout`.
//      영역이 하나면 좌표계가 같으므로 **절대 셀 비교**까지 요구한다 (F2-6b)
//   ⓒ R17-1 pane 메타 행 — 장식 행에 `{n} · {종류} · {cols}×{rows}`
//   ⓓ F2-1 아래 분할까지 걸어 3 pane
//   ⓔ F2-2 경계 드래그 — 끄는 동안 서버에 0, mouseup 에 1회. **배지가 말한 칸 수 == 커밋 결과**
//   ⓕ F2-2 도달 구간 **밖**으로 끌기 — 거기서도 배지와 결과가 같은가 (코디네이터 요구)
//   ⓖ F2-4 인접 pane 포커스 — `pane.neighbor` 로 물어보고 그 답으로 옮긴다
//   ⓗ F2-1 단축키 경로 (`⌘D`) — 헤더 버튼과 같은 길인가
//   ⓘ F2-5 pane 닫기 — 하나 닫고, 마지막까지 닫으면 탭이 닫힌다
//   ⓙ F2-3 / 3c / 3d 줌 — 서버 rect 는 그대로, 격자만 역산으로 커진다. 해제 뒤 격자 복원은
//      **두 얼굴 다** 본다: 창이 그대로인 경우와 줌 중 창이 바뀐 경우
//
// 격리: `life373-` 세션 전용(두 lib 가 각자 막는다). M0: 유령 앱 0 에서만 유효하다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startApp, sleep, SESSION } from '../l353/lib.mjs'
import { attachThisWorktree, dragPaneDivider, ensureTabs, focusedPane, g1, paneCalls, press, pressNative, quiesce, resizeEvents, snapshot, syncEvents, windowAlive } from './app-steps.mjs'
import { ensureWorkspace, layout as herdrLayout, m0End, m0Start, resetPanes, writeRaw } from './lib.mjs'

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
          // 글자가 DOM 에 **있는 것**과 **보이는 것**은 다르다. 결함 6 과 같은 부류라 여기서
          // 갈라 적는다 - 메타 상자가 스택 상자와 겹치는 높이가 0 이면 사용자는 못 본다.
          const metaBox = meta === null ? null : meta.getBoundingClientRect()
          const 보임 = metaBox === null ? null : Math.min(metaBox.bottom, origin.bottom) - Math.max(metaBox.top, origin.top)
          return {
            paneId: el.dataset.termPaneBox,
            선택: el.dataset.paneSelected,
            숨김: el.hidden,
            바깥: { x: round(box.left - origin.left), y: round(box.top - origin.top), width: round(box.width), height: round(box.height) },
            안쪽: inner === null ? null : { x: round(inner.left - origin.left), y: round(inner.top - origin.top), width: round(inner.width), height: round(inner.height) },
            메타: meta === null ? null : meta.textContent,
            메타상자: metaBox === null ? null : { y: round(metaBox.top - origin.top), height: round(metaBox.height) },
            메타보임: 보임 === null ? null : { 겹친높이: round(보임), 보인다: 보임 > 0 },
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

ensureWorkspace()
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
function 대조({ 그린것, 오라클, 상태, 대체셀 = null }) {
  // **셀은 창의 성질이지 pane 의 성질이 아니다.** `window.corralTermProbe` 는 **마지막에 마운트한
  // pane** 하나가 쥐는데, 그 pane 을 닫으면 프로브가 통째로 사라져 셀이 `null` 이 된다 — 그러면
  // 사슬2 가 "그린 상자가 없다"로 **거짓 미달**난다(라운드 3 재실행에서 실제로 났다: pane 닫기
  // 회차만 미달, 상자는 셋 다 멀쩡히 있었다). 폰트·DPI 가 안 바뀌면 셀 px 도 안 바뀌므로 **같은
  // 런의 앞 회차 실측값**으로 잰다 — 줌 블록이 이미 같은 이유로 그렇게 한다(§7 ⓱).
  // 대체했으면 원자료에 그렇게 적는다(`셀출처`) — 조용히 갈아끼우지 않는다.
  const 셀출처 = 그린것?.셀?.measured != null ? '이 회차 실측' : 대체셀 != null ? '앞 회차 실측(프로브 쥔 pane 이 닫혔다)' : '없음'
  const cell = 그린것?.셀?.measured ?? 대체셀 ?? null
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
    셀출처,
    원점: origin,
    id집합같다: JSON.stringify(views.map((v) => v.paneId).sort()) === JSON.stringify(오라클.pane.map((p) => p.paneId).sort()),
    사슬1_corral_vs_herdr: 사슬1,
    사슬2_그림_vs_사각형: 사슬2,
    통과: 사슬1.every((r) => r.같다) && 사슬2.every((r) => r.같다 && r.안쪽같다),
  }
}

// 이 런에서 마지막으로 **실제로 잰** 셀. 프로브를 쥔 pane 이 닫히면 이 값으로 잰다 (위 `대조` 주석).
let 마지막셀 = null
const 기록 = async (label) => {
  await sleep(1200)
  const 그린것 = await drawn(app)
  if (그린것?.셀?.measured != null) 마지막셀 = 그린것.셀.measured
  const 오라클 = truth()
  const 상태 = await app.state()
  const row = { label, 그린것, 오라클, 화면: await snapshot(app, label, { cell: 마지막셀 }), 대조: 대조({ 그린것, 오라클, 상태, 대체셀: 마지막셀 }) }
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

// ⓙ F2-3 · F2-3c · F2-3d — 줌. pane 2개인 지금 상태에서 잰다 (드래그로 비율이 기울어 있어
// 역산 격자가 1:1 이 아닌 쪽이 더 엄한 시험이다).
{
  const groupId = (await app.state()).terminalGroups[0]?.groupId ?? null
  if (groupId === null) throw new Error('영역이 없다')
  const gridOf = async () => (await app.state()).terminalGroups[0]?.grid ?? null
  const 줌상태 = async () => {
    const live = truth()
    return {
      오라클zoomed: live.zoomed,
      // **서피스 격자**다. 줌은 여기서 커진다 — 영역이 역산 격자를 요청하기 때문이다.
      오라클area: live.area,
      오라클rect: live.pane.map((p) => [p.paneId, p.rect]),
      // 줌 대상 pane 의 내용 셀 — 상자 격자와 같아야 화면을 꽉 쓴다 (G1-b).
      줌pane내용: await (async () => {
        const sel = (await app.send({ cmd: 'eval', code: `document.querySelector('[data-pane-selected="true"]')?.dataset.termPaneBox ?? null` })).result
        const view = (await app.state()).terminalGroups[0]?.panes.find((p) => p.paneId === sel) ?? null
        return view === null ? null : { cols: view.innerRect.width, rows: view.innerRect.height }
      })(),
      // 렌더러가 아는 `grid` 는 **상자 격자**라 줌과 무관하게 그대로다. 둘을 같이 적어야
      // "무엇이 커지고 무엇이 안 커지는가"가 보인다.
      상자격자: await gridOf(),
      셀: (await drawn(app))?.셀?.measured ?? null,
    }
  }
  await quiesce(app)
  const 줌 = { 창: '1400×900' }
  줌.전 = await 줌상태()

  줌.활성영역 = (await app.send({
    cmd: 'eval',
    code: `document.querySelector('.tab-group.is-active-group')?.dataset.tabGroup ?? null`,
  })).result

  // 켜기 — 먼저 ⌘⇧Z. 안 먹으면 헤더 `⤢` 로 가고 **둘 다 적는다**(어느 길이 죽었는지가 사실이다).
  let since = Date.now()
  await press(app, { key: 'z', meta: true, shift: true })
  await sleep(1500)
  줌.단축키 = { zoomed: truth().zoomed, 상자격자: await gridOf() }
  if (줌.단축키.zoomed === null) {
    since = Date.now()
    await app.click(`[data-group-zoom="${groupId}"]`)
    await sleep(1500)
    줌.헤더버튼 = { zoomed: truth().zoomed, 상자격자: await gridOf() }
  }
  await sleep(1200) // 역산 보정 한 바퀴가 돌 시간을 준다 (`correctZoomGrid`).
  줌.보낸격자 = resizeEvents(app, since).map((e) => ({ cols: e.cols, rows: e.rows, kind: e.kind }))
  줌.켠뒤 = { ...(await 줌상태()), resize: resizeEvents(app, since).length, sync: syncEvents(app, since).length }
  줌.켠뒤.그린것 = await drawn(app)
  줌.켠뒤.G1 = await g1(app, { cell: 줌.전.셀 })
  await app.shot('f2-k-zoom-on')

  // 줌 중 창 바꾸기 — 여기서 '줌 이전 값'은 더 이상 옳은 목표가 아니다 (F2-3c 재표현).
  since = Date.now()
  await app.resizeWindow(1100, 800)
  await sleep(1800)
  줌.줌중창바꾼뒤 = { ...(await 줌상태()), resize: resizeEvents(app, since).length }
  await app.shot('f2-l-zoom-resized')

  // 끄기 — 지금 상자가 줌 없이 요청했을 값이어야 한다. 켤 때 먹힌 길로 끈다.
  since = Date.now()
  if (줌.단축키.zoomed === true) await press(app, { key: 'z', meta: true, shift: true })
  else await app.click(`[data-group-zoom="${groupId}"]`)
  await sleep(1800)
  줌.끈뒤_1100 = { ...(await 줌상태()), resize: resizeEvents(app, since).length }
  await app.shot('f2-m-zoom-off')

  // 대조 ①: 같은 창 크기를 **줌 없이** 다시 만들어 본 격자와 같은가.
  await app.resizeWindow(1400, 900)
  await sleep(1600)
  줌.복귀_1400 = await 줌상태()
  await app.resizeWindow(1100, 800)
  await sleep(1600)
  줌.무줌_1100 = await 줌상태()
  await app.resizeWindow(1400, 900)
  await sleep(1600)
  줌.무줌_1400 = await 줌상태()

  // 줌 pane 의 서버 rect 가 **서피스 전체가 아니다** — 서버가 다시 배치하지 않았다는 뜻이고,
  // 그게 "그리는 건 클라이언트"의 실물이다.
  // `pane.layout.zoomed` 는 boolean 이라 어느 pane 인지는 안 준다 — 줌 대상은 corral 이 안다.
  // 서버 rect 중 **어느 것도 서피스 전체가 아니면** 서버가 다시 배치하지 않았다는 뜻이고,
  // 그게 "그리는 건 클라이언트"의 실물이다.
  줌.판정 = {
    'F2-3 서버 zoomed 플래그': 줌.켠뒤.오라클zoomed === true && 줌.끈뒤_1100.오라클zoomed === false,
    'F2-3 서버는 다시 배치하지 않는다': 줌.켠뒤.오라클rect.every(
      ([, r]) => r.width < 줌.켠뒤.오라클area.width || r.height < 줌.켠뒤.오라클area.height,
    ),
    'F2-3 서피스 격자를 안 흔든다': JSON.stringify(줌.켠뒤.오라클area) === JSON.stringify(줌.전.오라클area),
    'F2-3 줌 중 연결에는 pane 이 하나만 실린다': (줌.켠뒤.그린것?.pane.length ?? 0) === 1,
    'F2-3 상자 격자는 그대로다': JSON.stringify(줌.켠뒤.상자격자) === JSON.stringify(줌.전.상자격자),
    'F2-3c 줌중 창변경 뒤 해제 == 그 상자의 무줌 격자': JSON.stringify(줌.끈뒤_1100.오라클area) === JSON.stringify(줌.무줌_1100.오라클area),
    'F2-3c 창이 그대로면 줌 이전 값': JSON.stringify(줌.복귀_1400.오라클area) === JSON.stringify(줌.전.오라클area),
    'F2-3 줌 pane 내용이 상자 격자와 같다': 줌.켠뒤.줌pane내용 !== null && JSON.stringify(줌.켠뒤.줌pane내용) === JSON.stringify(줌.전.상자격자),
    'F2-3b 줌 중에도 G1/G1-b/G1-c': 줌.켠뒤.G1.위반 === 0 && 줌.켠뒤.G1.여백위반 === 0 && 줌.켠뒤.G1.내용잘림 === 0,
    'F2-3d 줌 토글 resize 는 연결당 1회': 줌.켠뒤.resize === 1 && 줌.끈뒤_1100.resize === 1,
    'F2-3d 흔든 서피스 크기': { 전: 줌.전.오라클area, 줌중: 줌.켠뒤.오라클area },
    '켠 뒤 rect': 줌.켠뒤.오라클rect,
  }
  결과.줌 = 줌
  console.log('F2-3', JSON.stringify(줌.판정))
  console.log('  area', JSON.stringify([줌.전.오라클area, 줌.켠뒤.오라클area, 줌.줌중창바꾼뒤.오라클area, 줌.끈뒤_1100.오라클area, 줌.무줌_1100.오라클area, 줌.복귀_1400.오라클area]))
  console.log('  상자격자', JSON.stringify([줌.전.상자격자, 줌.켠뒤.상자격자, 줌.끈뒤_1100.상자격자, 줌.무줌_1100.상자격자, 줌.복귀_1400.상자격자]))
  console.log('  보낸격자', JSON.stringify(줌.보낸격자))
  console.log('  경로', JSON.stringify({ 활성영역: 줌.활성영역, 단축키: 줌.단축키, 헤더버튼: 줌.헤더버튼 ?? null }))
}

// ⓖ F2-4 — 인접 pane 포커스. 서버가 답한 이웃으로만 옮긴다.
{
  const 이동 = []
  for (const [key, 라벨] of [
    ['ArrowRight', '오른쪽'],
    ['ArrowDown', '아래'],
    ['ArrowUp', '위'],
    ['ArrowLeft', '왼쪽'],
  ]) {
    const before = await focusedPane(app)
    const since = Date.now()
    await press(app, { key, meta: true, alt: true })
    이동.push({ 키: `⌘⌥${라벨}`, 전: before, 후: await focusedPane(app), 부른것: paneCalls(app, since, 'pane.neighbor') })
  }
  결과.포커스이동 = 이동
  console.log('F2-4', JSON.stringify(이동.map((m) => [m.키, m.전.선택, '→', m.후.선택, m.후.포커스pane, m.부른것.length])))
  await app.shot('f2-g-focus-move')
}

// ⓗ F2-1 단축키 경로 — `⌘D` 로 하나 더.
{
  const since = Date.now()
  await press(app, { key: 'd', meta: true })
  await sleep(1200)
  결과.단축키분할 = {
    부른것: paneCalls(app, since, 'pane.split'),
    pane수: (await app.state()).terminalGroups[0]?.panes.length ?? 0,
    오라클: truth(),
  }
  결과.단축키분할.기록 = await 기록('⌘D 뒤 (pane 4)')
  console.log('F2-1 단축키 | pane', 결과.단축키분할.pane수, '| 부른것', 결과.단축키분할.부른것.length)
  await app.shot('f2-h-shortcut-split')
}

// ⓘ F2-5 — 헤더 ✕ 로 포커스 pane 을 닫는다. 마지막 하나까지 닫으면 탭이 닫혀야 한다.
//
// **탭 수를 먼저 박는다** (F1-7 이 접힘 분모를 박은 것과 같은 이유 — §7 ㊲). herdr 는 탭을
// 영속하는데 이 블록의 `⌘W` 연속 닫기가 탭을 줄여 놓고 끝나므로, 다음 런이 탭 하나에서
// 출발하면 **마지막 ⌘W 가 창까지 닫는다**(F2-5b 문언 그대로다). 그러면 뒤따르는 R23 곁불
// (⌘A·⌘Q)이 아예 못 돌아 원자료에 `창살아있나 false` 만 남는다 — 라운드 3 재실행에서 실제로
// 그랬다. 재는 것은 "pane 을 다 닫으면 탭이 닫히나"이지 "세션에 탭이 몇 개 남아 있었나"가 아니다.
await ensureTabs(app, 3)
{
  const groupId = (await app.state()).terminalGroups[0]?.groupId ?? null
  const 탭전 = (await app.state()).repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? []).length
  const since = Date.now()
  await app.click(`[data-group-close-pane="${groupId}"]`)
  await sleep(1400)
  결과.pane닫기 = {
    부른것: paneCalls(app, since, 'pane.close'),
    pane수: (await app.state()).terminalGroups[0]?.panes.length ?? 0,
    오라클: truth(),
    기록: await 기록('pane 하나 닫은 뒤'),
  }
  console.log('F2-5 | pane', 결과.pane닫기.pane수, '| 부른것', 결과.pane닫기.부른것.length)
  await app.shot('f2-i-close-pane')

  // 계속 닫는다 — 이번엔 **`⌘W`** 로 (F2-5a · R23). `✕` 는 핸드오프 글리프표대로 pane ≥ 2 에서만
  // 있어 마지막 하나에 못 닿는다. `⌘W` 는 Electron 기본 메뉴의 `File ▸ Close Window` 가 쥔 키를
  // main 이 `before-input-event` 로 뺏어 온 것이라 **진짜 입력 경로**(`pressNative`)로만 잰다 —
  // 합성 이벤트로 재면 창이 닫히는지가 영영 안 보인다. 그래서 회차마다 `창살아있나` 를 같이 적는다.
  const 연속 = []
  for (let i = 0; i < 6; i += 1) {
    const before = await app.state()
    const 남기전 = before.terminalGroups[0]?.panes.length ?? 0
    if (남기전 === 0) break
    const since각 = Date.now()
    await pressNative(app, { keyCode: 'w', modifiers: ['meta'], settleMs: 1500 })
    const alive = await windowAlive(app)
    if (!alive) {
      연속.push({ 보낸키: '⌘W', 창살아있나: false })
      break
    }
    const state = await app.state()
    연속.push({
      보낸키: '⌘W',
      창살아있나: true,
      쥐기전: 남기전,
      남은: state.terminalGroups[0]?.panes.length ?? 0,
      탭수: state.repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? []).length,
      부른것: paneCalls(app, since각, 'pane.close').length,
      닫기버튼: (await app.query(`[data-group-close-pane="${groupId}"]`)).found.length,
    })
    if (남기전 === 1) break // F2-5b — 마지막 pane 에서 한 번 더 누르면 탭이 닫힌다. 여기서 멈춘다.
  }
  결과.마지막pane = {
    탭전,
    연속,
    닫기버튼남았나: (await app.query(`[data-group-close-pane="${groupId}"]`)).found.length > 0,
    pane수: (await app.state()).terminalGroups[0]?.panes.length ?? 0,
    탭수: (await app.state()).repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? []).length,
    창살아있나: await windowAlive(app),
  }
  console.log('F2-5 마지막 | 탭전', 탭전, JSON.stringify(결과.마지막pane))
  await app.shot('f2-j-close-last')
}

// ⓚ 힌트줄 (F2-5c · R6-J) — 목록·버림 순서가 **화면에 선** 것으로 잰다.
//    글자만 보면 `.is-dropped`(흐름 밖·visibility:hidden)를 못 가른다 — 보이는 상자로 센다.
{
  const 힌트 = async (label) => (await app.send({
    cmd: 'eval',
    code: `(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: +r.left.toFixed(1), w: +r.width.toFixed(1) } }
      const row = document.querySelector('[data-term-hint]')
      const strip = document.querySelector('[data-pane-strip]')
      return {
        라벨: ${JSON.stringify(label)},
        줄폭: row === null ? null : +row.getBoundingClientRect().width.toFixed(1),
        스트립폭: strip === null ? null : +strip.getBoundingClientRect().width.toFixed(1),
        항목: [...document.querySelectorAll('[data-hint-key]')].map((el) => ({
          key: el.dataset.hintKey,
          글: el.textContent,
          버림: el.dataset.hintDropped,
          보임: getComputedStyle(el).visibility,
          상자: box(el),
        })),
      }
    })()`,
  })).result
  const 점 = []
  for (const width of [1400, 1000, 820, 700]) {
    await app.resizeWindow(width, 900)
    await sleep(900)
    const 잰것 = await 힌트(`창 ${width}`)
    잰것.창 = width
    잰것.남은수 = 잰것.항목.filter((i) => i.버림 === 'false').length
    점.push(잰것)
    console.log('힌트줄', width, '| 남은', 잰것.남은수, '|', 잰것.항목.filter((i) => i.버림 === 'false').map((i) => i.key).join(' '))
  }
  await app.resizeWindow(1400, 900)
  await sleep(700)
  결과.힌트줄 = 점
  await app.shot('f2-k-hint-strip')
}

// ⓛ R23 곁불 — **`⌘W` 만 가져왔다**. 다른 메뉴 액셀러레이터는 그대로 사는가.
//    Edit role(`⌘A` 전체 선택)을 **편집 가능한 칸**에서 잰다(사이드바 검색칸은 disabled 다).
//    이 확인이 `⌘W` 판정의 판별자이기도 하다: 같은 주입 경로로 다른 액셀러레이터가 먹는다면,
//    `⌘W` 가 창을 안 닫은 것은 "경로가 메뉴에 안 닿아서"가 아니라 **우리가 삼켰기 때문**이다.
{
  const tabId = (await app.state()).repos.flatMap((r) => r.worktrees).flatMap((w) => w.workspace?.tabs ?? [])[0]?.tabId ?? null
  결과.R23곁불 = { tabId }
  if (tabId !== null) {
    await app.send({ cmd: 'dblclick', selector: `[data-main-tab="${tabId}"] .main-tab-label` })
    await sleep(500)
    const 쓰기 = await app.send({ cmd: 'eval', code: `(() => { const el = document.querySelector('.main-tab-rename'); return el === null ? null : { 있나: true, 값: el.value } })()` })
    // 편집을 켜면 corral 이 이미 `select()` 해 둔다 — 그대로 ⌘A 를 재면 **아무것도 안 해도 통과**다.
    // 방향키로 선택을 한 번 풀고(캐럿만 남는다) 나서 ⌘A 가 되돌리는지를 본다.
    await app.send({ cmd: 'key', keyCode: 'Right', modifiers: [] })
    await sleep(300)
    결과.R23곁불.푼뒤 = (await app.send({
      cmd: 'eval',
      code: `(() => { const el = document.querySelector('.main-tab-rename'); return el === null ? null : { start: el.selectionStart, end: el.selectionEnd } })()`,
    })).result
    await pressNative(app, { keyCode: 'a', modifiers: ['meta'], settleMs: 600 })
    결과.R23곁불.전체선택 = (await app.send({
      cmd: 'eval',
      code: `(() => {
        const el = document.querySelector('.main-tab-rename')
        if (el === null) return null
        return { 값: el.value, start: el.selectionStart, end: el.selectionEnd, 전부: el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value.length > 0 }
      })()`,
    })).result
    결과.R23곁불.입력칸 = 쓰기.result
    await app.send({ cmd: 'key', keyCode: 'Escape', modifiers: [] })
    await sleep(400)
  }
  결과.R23곁불.창살아있나 = await windowAlive(app)
  console.log('R23 곁불 | ⌘A 전체선택', JSON.stringify(결과.R23곁불.전체선택))
}

// ⓜ R23 — **`⌘Q` 는 그대로 산다**. 맨 끝에 잰다(먹으면 앱이 죽는다).
//    이게 먹는다는 것은 같은 주입 경로가 **메뉴 액셀러레이터까지 닿는다**는 뜻이다 → ⓛ 과 함께
//    `⌘W` 가 안 닫힌 이유가 "우리가 삼켜서"임을 가른다.
{
  await pressNative(app, { keyCode: 'q', modifiers: ['meta'], settleMs: 2500 })
  결과.R23종료 = { 보낸키: '⌘Q', 창살아있나: await windowAlive(app) }
  console.log('R23 ⌘Q | 창살아있나', 결과.R23종료.창살아있나)
}

// M0-b 는 **앱을 멈춘 뒤** 잰다 — 먼저 재면 이 런이 띄운 Electron 을 유령으로 센다.
await app.stop()
await sleep(800)
결과.M0b = m0End()
// 결과 파일 이름을 밖에서 준다 (`L373_OUT`) — 같은 하네스를 같은 빌드에서 두 번 돌릴 때
// 뒤 회차가 앞 회차를 말없이 덮는다(§5 사고 3·4 와 같은 기전).
writeRaw(process.env.L373_OUT ?? 'f2-panes.json', 결과)
