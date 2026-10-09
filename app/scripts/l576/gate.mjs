// LIFE-576 최종 관문 단계 — `node scripts/l576/gate.mjs <단계> <원자료 폴더>`. 앱은 up.sh / app-up.sh 로 먼저 띄운다.
// 실제 corral 레포(본체)와 실제 worktree 를 격리 userData 에 등록해 본다. 부모 관계는 격리 CLI(격리 rpc 소켓)로만 만들고 지운다.
// 단계마다 <원자료>/<단계>.json 에 검사 행(id·기준·통과·관측)을 쓰고 하나라도 실패면 exit 1. 입력은 회차마다 `input` 칸에 적는다
// (`cdp` = 디버깅 포트 Input.dispatchMouseEvent + 포커스 에뮬레이션, OS 입력은 os-drag.sh).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as l from './lib.mjs'

const [step, outArg, runArg] = process.argv.slice(2)
/** 회차 id — 결과 파일·캡처 이름 꼬리(같은 단계를 다시 돌려도 앞 회차 원자료를 덮지 않는다). */
const run = runArg ?? String(Date.now())
const out = path.resolve(outArg ?? '.')
fs.mkdirSync(out, { recursive: true })
const M = '/Users/byun/repos/byun618/corral'
const W = `${M}/.claude/worktrees`
const T = `${W}/LIFE-576-worktree-nesting`
const C = `${T}-claude`
const R1 = `${T}-review-r1`
const R2 = `${T}-review-r2`
const R3 = `${T}-review-r3`
const X = `${W}/LIFE-564-mobile`
const FX = '/tmp/l576fx/repo'
const FXW = '/tmp/l576fx/repo-wt/fx-child'
const short = (p) => (p === null || p === undefined ? p : p.replace(`${W}/`, '').replace(M, 'MAIN').replace('/tmp/l576fx/', 'fx:'))

const checks = []
function check(id, criterion, pass, observed) {
  checks.push({ id, criterion, pass: pass === true, observed })
  console.log(pass === true ? 'PASS' : 'FAIL', id, JSON.stringify(observed).slice(0, 400))
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const parentOf = (p) => l.show(p).result.worktree.parentWorktreeId
const idOf = (p) => l.show(p).result.worktree.id
const setParent = (child, parent) => l.cli(['worktree', 'set', '--worktree', `path:${child}`, ...(parent === null ? ['--no-parent'] : ['--parent-worktree', `path:${parent}`])])
/** 이 단계의 부모 관계 전부를 정한다 — 적지 않은 카드는 부모 없음. 앞 단계가 남긴 관계에 기대지 않는다(3회차 전 관문 틀 결함). */
function prep(relations) {
  // 먼저 전부 풀고 나서 건다 — 남은 관계와 새 관계가 엮여 서버가 순환으로 거절하지 않게.
  for (const p of [T, C, R1, R2, R3, X, M]) setParent(p, null)
  for (const [child, parent] of Object.entries(relations)) setParent(child, parent)
}
const TREE = { [C]: T, [R1]: T, [R2]: T, [R3]: C }
/** G5 값이 기대값이 될 때까지(최대 15초) 본다 — 쓰기·트리 재조립이 비동기라 고정 대기로 읽으면 늦은 쓰기를 실패로 센다(k4 2회차). 걸린 ms 를 남긴다. */
async function waitParent(p, expected) {
  const start = Date.now()
  for (;;) {
    const value = parentOf(p)
    if (value === expected) return { ok: true, ms: Date.now() - start, value }
    if (Date.now() - start > 15_000) return { ok: false, ms: Date.now() - start, value }
    await l.pause(250)
  }
}
const byPath = (list) => Object.fromEntries(list.map((card) => [card.path, card]))
/** 화면 카드 요약 — 경로@깊이(소유) */
const layout = (list) => list.map((card) => `${short(card.path)}@${card.depth}${card.owner ? `<${short(card.owner)}` : ''}`)
const repoOrder = () => (l.prefs().manualWorktreeOrder[M] ?? []).map(short)
async function settle() {
  await l.pause(900)
  return l.cards()
}
/** 카드 내용 영역 가운데(상위 지정 지점) · 덩어리 경계 바로 아래(순서 줄 지점). 좌표는 창 client(= sendInputEvent). */
const centerOf = (card) => ({ x: card.left + 60, y: (card.contentTop + card.contentBottom) / 2 })
const grab = (card) => ({ x: card.left + 60, y: card.contentTop + 14 })
async function dragRaw({ source, toY, via = [], during }) {
  const from = grab(source)
  return l.rawDrag({ x: from.x, fromY: from.y, ys: [from.y + 6, from.y + 14, ...via, toY], during })
}
async function shot(name) {
  const file = await l.shot(name)
  const target = path.join(out, 'shots', `${name}-${run}.png`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (typeof file === 'string' && fs.existsSync(file)) fs.copyFileSync(file, target)
  return path.relative(out, target)
}
const toastTexts = () => l.evalJs(`[...document.querySelectorAll('[data-sonner-toast]')].map((el) => el.textContent.trim())`)

const steps = {
  /** 부모 관계 초기화 — 이 관문이 만든 관계만 지운다(격리 레지스트리). */
  async reset() {
    for (const p of [T, C, R1, R2, R3, X, M]) setParent(p, null)
    const cards = await settle()
    check('reset', '격리 레지스트리 부모 관계 0', [T, C, R1, R2, R3, X].every((p) => parentOf(p) === null), layout(cards))
  },

  /** K1 — 같은 레포 다단계 중첩 · 「N 하위」 · 다른 레포 부모 레코드(fixture 레포) · 필터 전 칩 없음. */
  async k1() {
    prep({ ...TREE, [X]: M })
    // 다른 레포 부모 — fixture 레포(/tmp/l576fx)를 격리 레지스트리에 등록하고 그 worktree 의 부모를 corral 의 T 로(격리 CLI). 서버가 거절하면 원문을 남긴다.
    if (!fs.existsSync(FXW)) {
      fs.mkdirSync(FX, { recursive: true })
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: FX })
      execFileSync('git', ['-c', 'user.email=l576@example.invalid', '-c', 'user.name=l576', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: FX })
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'fx-child', FXW], { cwd: FX })
    }
    const added = await l.control({ cmd: 'add-repo', root: FX })
    await l.until(async () => (await l.state()).repos.some((repo) => repo.root === fs.realpathSync(FX)), 'fixture repo', 20_000)
    const realFxw = fs.realpathSync(FXW)
    const cross = l.cliTry(['worktree', 'set', '--worktree', `path:${realFxw}`, '--parent-worktree', `path:${T}`])
    const cards = await settle()
    const at = byPath(cards)
    l.write(out, `k1-cards-${run}.json`, cards.map((card) => ({ ...card, path: short(card.path), owner: short(card.owner) })))
    const unit = cards.filter((card) => card.path === T || card.owner === T).map((card) => `${short(card.path)}@${card.depth}`)
    // 자식 순서 = 구획(저장) 순서(Orca 와 같다) — 저장 순서에서 R1·R2 가 C 보다 앞이다. 손자 R3 는 C 바로 뒤. (1·2회차는 이 오라클을 잘못 적었다)
    check('K1a-multilevel', 'T 덩어리 = T@0 · R1@1 · R2@1 · C@1 · R3@2 (후손은 T 행 안, 자식 순서 = 구획 순서, 손자는 자기 부모 바로 뒤)', same(unit, ['LIFE-576-worktree-nesting@0', 'LIFE-576-worktree-nesting-review-r1@1', 'LIFE-576-worktree-nesting-review-r2@1', 'LIFE-576-worktree-nesting-claude@1', 'LIFE-576-worktree-nesting-review-r3@2']), unit)
    check('K1a-indent', '단계 들여쓰기 — C 왼쪽 = T + 18, R3 = T + 36', Math.abs(at[C].left - at[T].left - 18) < 1 && Math.abs(at[R3].left - at[T].left - 36) < 1, { T: at[T].left, C: at[C].left, R3: at[R3].left })
    check('K1b-chip', '「N 하위」 N = 직계 자식 수 — T 3, C 1', /3/.test(at[T].chip ?? '') && /1/.test(at[C].chip ?? ''), { T: at[T].chip, C: at[C].chip })
    check('K1-main-child', '주 체크아웃 부모(같은 레포)도 중첩 — X 는 MAIN 행 안 깊이 1', at[X].owner === M && at[X].depth === 1, { owner: short(at[X].owner), depth: at[X].depth })
    check('K1-registry', 'G5 — 레지스트리 parentWorktreeId 가 화면과 같다', parentOf(C) === idOf(T) && parentOf(R3) === idOf(C) && parentOf(R1) === idOf(T) && parentOf(X) === idOf(M), { C: parentOf(C), R3: parentOf(R3) })
    const fxCard = at[realFxw]
    check('K1c-cross-repo', '다른 레포 부모 = 유효 간선 아님 → 자기 레포 구획 평소 자리(깊이 0) + `↳ 부모` 칩', cross.ok ? fxCard !== undefined && fxCard.depth === 0 && fxCard.owner === null && fxCard.section === fs.realpathSync(FX) && /↳/.test(fxCard.parentChip ?? '') : false, { cliSet: cross.ok ? 'ok' : cross, added: added.ok, card: fxCard && { depth: fxCard.depth, owner: fxCard.owner, section: short(fxCard.section), parentChip: fxCard.parentChip } })
    check('K1-shot', '화면 캡처', true, { shot: await shot('k1-nest') })
  },

  /** K3 — 끌어서 상위 지정(G5 전후) · 표시 동시성(강조만, 표시 줄 없음) · 무효 대상 변화 0. 입력 cdp. */
  async k3() {
    prep(TREE)
    let cards = await settle()
    let at = byPath(cards)
    const before = parentOf(X)
    const during = await dragRaw({ source: at[X], toY: centerOf(at[R2]).y, via: [centerOf(at[R2]).y - 20], during: async () => ({ view: await l.dragView(), shot: await shot('k3-during-nest') }) })
    const waited = await waitParent(X, idOf(R2))
    const after = waited.value
    check('K3a-nest-g5', 'X 를 R2 내용 영역 가운데에 놓으면 X 의 부모 = R2 (worktree show 전후)', before === null && waited.ok, { input: 'cdp', before, after, ms: waited.ms })
    check('K3b-exclusive', '끄는 동안 상위 지정 대상 = R2 강조만, 순서 표시 줄 없음', same(during.view.targets, [R2]) && during.view.indicator.length === 0, { targets: during.view.targets.map(short), indicator: during.view.indicator, shot: during.shot })
    cards = await settle()
    at = byPath(cards)
    check('K3a-render', '놓은 뒤 X 는 R2 아래 깊이 2(T 덩어리 안)', at[X].owner === T && at[X].depth === 2, { owner: short(at[X].owner), depth: at[X].depth })
    // 무효 대상 — T 를 자기 후손 C 가운데로. 강조 없음, 놓아도 T 의 부모 그대로.
    const tBefore = parentOf(T)
    const invalid = await dragRaw({ source: at[T], toY: centerOf(at[C]).y, via: [centerOf(at[C]).y - 10], during: async () => l.dragView() })
    await l.pause(800)
    check('K3c-invalid-descendant', '무효 대상(자기 후손 C) 위 — 상위 지정 강조 없음 · 놓아도 T parentWorktreeId 그대로', invalid.preview.length === 1 && invalid.targets.length === 0 && parentOf(T) === tBefore, { input: 'cdp', dragging: invalid.preview.length, targets: invalid.targets.map(short), before: tBefore, after: parentOf(T) })
    cards = await settle()
    at = byPath(cards)
    // 무효 대상 — 현재 부모와 같음: X(부모 R2) 를 R2 가운데로.
    const xParent = parentOf(X)
    const sameParent = await dragRaw({ source: at[X], toY: centerOf(at[R2]).y, via: [centerOf(at[R2]).y + 10], during: async () => l.dragView() })
    await l.pause(800)
    check('K3c-invalid-same-parent', '무효 대상(현재 부모 R2) 위 — 강조 없음 · 부모 그대로', sameParent.targets.length === 0 && parentOf(X) === xParent, { input: 'cdp', targets: sameParent.targets.map(short), after: parentOf(X) })
    // 기준 K3ⓒ 문구(「놓아도 레지스트리 변화 0」)와 승인된 K4ⓒ(M2 — 순서 줄 드롭은 유효 lineage 를 푼다)가 이 경우 겹친다: 무효 대상 위 드롭은 순서 경로라
    // 부모가 풀린다(Orca 도 같다). 위 엄격 행은 기준 문구 그대로 두고, 아래 행은 리뷰 r3 해석(「변화 0」 = 상위 지정 쓰기 없음)으로 따로 본다.
    check('K3c-invalid-same-parent-nonest', '해석 — 무효 대상 위: 강조 없음 · 대상으로의 상위 지정 쓰기 없음(부모가 R2 그대로이거나 순서 줄 해제로 null, 다른 값 아님)', sameParent.preview.length === 1 && sameParent.targets.length === 0 && (parentOf(X) === xParent || parentOf(X) === null), { input: 'cdp', dragging: sameParent.preview.length, before: xParent, after: parentOf(X) })
    l.write(out, `k3-cards-${run}.json`, layout(await settle()))
  },

  /** K3ⓓ 실패 주입 — 끄는 동안 후보를 낡게 만들어(격리 CLI 로 대상의 부모를 끄는 카드의 후손으로) 놓으면 서버가 순환을 거절 → 화면 알림. */
  async k3fail() {
    prep(TREE)
    let cards = await settle()
    let at = byPath(cards)
    const tBefore = parentOf(T)
    const toast0 = await toastTexts()
    const target = centerOf(at[X])
    const from = grab(at[T])
    await l.mouse('mouseMove', from.x, Math.round(from.y))
    await l.mouse('mouseDown', from.x, Math.round(from.y))
    for (const y of [from.y + 6, from.y + 14, target.y - 10, target.y]) {
      await l.mouse('mouseMove', from.x, Math.round(y))
      await l.pause(90)
    }
    await l.pause(300)
    const armed = await l.dragView()
    // 끄는 도중 — X 의 부모를 C(T 의 후손)로. 드래그 시작 때 구한 후보 Set 에는 X 가 그대로다.
    const injected = l.cliTry(['worktree', 'set', '--worktree', `path:${X}`, '--parent-worktree', `path:${C}`])
    await l.pause(1200)
    // 목록이 다시 그려져 X 가 T 덩어리 안으로 옮겨 갔다 — 지금 X 자리로 포인터를 옮긴다.
    cards = await l.cards()
    at = byPath(cards)
    const moved = centerOf(at[X])
    await l.mouse('mouseMove', from.x, Math.round(moved.y))
    await l.pause(300)
    const beforeDrop = await l.dragView()
    await l.mouse('mouseUp', from.x, Math.round(moved.y))
    await l.pause(1500)
    const toasts = await toastTexts()
    const shotFile = await shot('k3-fail-toast')
    check('K3d-fail-visible', '서버 거절(순환)이 화면 알림 「상위 워크트리를 지정하지 못했습니다: …」 로 보이고 T 의 부모는 그대로', toasts.some((text) => text.includes('상위 워크트리를 지정하지 못했습니다')) && parentOf(T) === tBefore, { input: 'cdp', armed: armed.targets.map(short), injected: injected.ok ? 'ok' : injected, beforeDrop: beforeDrop.targets.map(short), toastBefore: toast0, toasts, tAfter: parentOf(T), shot: shotFile })
    setParent(X, null)
  },

  /** K4 — 순서 끌기 회귀(평범한 카드) · 부모 덩어리 끌기 · 순서 줄 부모 해제(R2-A 제자리 착지) · 손자 있는 하위 카드 끌기(R1-B·R2-C). 수동 정렬. */
  async k4() {
    prep(TREE)
    let cards = await settle()
    let at = byPath(cards)
    const units = () => cards.filter((card) => card.owner === null && card.section === M)
    // ⓐ 평범한 카드 X(부모·자식 없음)를 그 구획 맨 위 덩어리 윗변으로.
    let first = units()[0]
    const order0 = repoOrder()
    const xParent0 = parentOf(X)
    await dragRaw({ source: at[X], toY: first.top + 2, via: [first.top + 30] })
    cards = await settle()
    at = byPath(cards)
    check('K4a-plain', '평범한 카드 순서 끌기 — X 가 맨 위 덩어리, ui-prefs 순서 첫 자리, 부모 값 그대로(null)', units()[0].path === X && repoOrder()[0] === short(X) && parentOf(X) === xParent0, { input: 'cdp', before: order0, after: repoOrder(), parent: parentOf(X) })
    // ⓑ 부모 덩어리(T + 펼친 후손) 를 맨 위로.
    first = units()[0]
    const block = cards.filter((card) => card.path === T || card.owner === T).map((card) => card.path)
    const parents0 = block.map((p) => parentOf(p))
    await dragRaw({ source: at[T], toY: first.top + 2, via: [first.top + 30] })
    cards = await settle()
    at = byPath(cards)
    const ord = repoOrder()
    check('K4b-block', '부모 덩어리 끌기 — T 덩어리가 맨 위, ui-prefs 순서 앞자리 = 덩어리 순서 그대로, 부모 값 전부 그대로', units()[0].path === T && same(ord.slice(0, block.length), block.map(short)) && same(block.map((p) => parentOf(p)), parents0), { input: 'cdp', block: block.map(short), order: ord })
    // ⓒ R2-A — 하위 카드 R1 을 T 덩어리 바로 뒤 경계(다음 덩어리 윗변)에 놓기: 부모 해제(G5 null) + 표시 줄 자리(T 덩어리 바로 뒤)에 착지.
    const next = units()[1]
    const r1Before = parentOf(R1)
    const shownBefore = layout(cards)
    const seenA = await dragRaw({ source: at[R1], toY: next.top + 2, via: [next.top + 20], during: async () => l.dragView() })
    const waitA = await waitParent(R1, null)
    cards = await settle()
    at = byPath(cards)
    const tBlockNow = cards.filter((card) => card.path === T || card.owner === T).map((card) => card.path)
    const unitPaths = units().map((card) => card.path)
    const ordA = repoOrder()
    check('K4c-unnest-land', 'R2-A — 순서 줄 부모 해제: R1 부모 null(G5) · 루트로 T 덩어리 바로 뒤 · ui-prefs 순서도 T 덩어리 바로 뒤', r1Before === idOf(T) && waitA.ok && unitPaths[1] === R1 && ordA[tBlockNow.length] === short(R1), { input: 'cdp', unnestMs: waitA.ms, indicatorDuring: seenA.indicator.length, before: shownBefore, after: layout(cards), order: ordA })
    // ⓓ R1-B·R2-C — 손자 있는 하위 카드 C(자식 R3) 를 끈다: 사본에 C+R3, 원래 자리 투명 C·R3. 놓는 곳 = T 덩어리 바로 뒤.
    const next2 = units()[1]
    const seenC = await dragRaw({ source: at[C], toY: next2.top + 2, via: [next2.top + 20], during: async () => ({ view: await l.dragView(), shot: await shot('k4-grandchild-drag') }) })
    const waitC = await waitParent(C, null)
    cards = await settle()
    at = byPath(cards)
    const ordC = repoOrder()
    const tBlock2 = cards.filter((card) => card.path === T || card.owner === T).map((card) => card.path)
    check('K4d-grandchild-drag', '손자 있는 하위 카드 끌기 — 사본 행 2(C+R3) · 투명 C·R3 · 놓으면 C 부모 null, R3 는 C 아래 그대로, 순서 C·R3 붙어서 T 덩어리 뒤', seenC.view.preview[0]?.kids === 2 && same([...seenC.view.sources].sort(), [C, R3].sort()) && waitC.ok && parentOf(R3) === idOf(C) && same(ordC.slice(tBlock2.length, tBlock2.length + 2), [short(C), short(R3)]), { input: 'cdp', unnestMs: waitC.ms, preview: seenC.view.preview, sources: seenC.view.sources.map(short), order: ordC, shot: seenC.shot })
    l.write(out, `k4-cards-${run}.json`, layout(cards))
  },

  /** K2 접기(클릭) → ui-prefs 값. 재시작 뒤 검사는 k2after. */
  async k2collapse() {
    // 활성 카드(C — k2active 가 연 작업 공간)는 T 밖에 둔다 — T 안이면 재기동 때 R1-C 가 T 를 펼치는 것이 맞는 동작이다(k2after 2회차).
    prep({ [R1]: T, [R2]: T, [R3]: R1 })
    let cards = await settle()
    const toggle = await l.clickAt(`[data-lineage-toggle="${T}"]`)
    cards = await settle()
    const hidden = !cards.some((card) => card.owner === T)
    check('K2a-collapse', '「N 하위」 칩 클릭 → T 후손 전부 숨김 · ui-prefs collapsedLineage = [T]', toggle.ok === true && hidden && same(l.prefs().collapsedLineage, [T]), { click: toggle.ok, layout: layout(cards), prefs: l.prefs().collapsedLineage.map(short) })
    l.write(out, 'k2-before-restart.json', { order: repoOrder(), collapsed: l.prefs().collapsedLineage.map(short), layout: layout(cards) })
    check('K2-shot', '접힌 화면', true, { shot: await shot('k2-collapsed') })
  },
  async k2after() {
    await l.untilTreeBuilt()
    const cards = await l.until(async () => {
      const list = await l.cards()
      return list.length > 0 ? list : null
    }, 'cards after restart', 30_000)
    await l.pause(1000)
    const now = await l.cards()
    const before = l.readJson(path.join(out, 'k2-before-restart.json'))
    check('K2b-restart-collapsed', '재시작 뒤 T 접힘 유지(후손 숨김) · ui-prefs 그대로', !now.some((card) => card.owner === T) && same(l.prefs().collapsedLineage, [T]), { layout: layout(now), prefs: l.prefs().collapsedLineage.map(short), count: cards.length })
    check('K4d-restart-order', 'K4ⓓ — 수동 순서 재시작 뒤 유지(ui-prefs 같음 · 화면 덩어리 순서 같음)', same(repoOrder(), before.order) && same(layout(now), before.layout), { before: before.order, after: repoOrder() })
  },

  /** K2ⓓ R2-B — 활성 카드를 이미 접힌 부모로 끌어 넣으면 펼쳐진다. 그 뒤 사용자가 직접 접는다(허용) → 재시작 검사는 k2activeafter. */
  async k2active() {
    prep({ [R1]: T, [R2]: T, [R3]: C })
    let cards = await settle()
    let at = byPath(cards)
    // C 를 활성으로 — 카드 표면 클릭(작업 공간 열기·활성화).
    const clicked = await l.clickAt(`[data-worktree="${C}"] [data-worktree-card-surface]`)
    await l.until(async () => (await l.evalJs(`document.querySelector('[data-worktree="${C}"] [data-worktree-card-surface]')?.closest('[data-active], .is-active, [aria-current]') !== null || document.querySelector('[data-worktree="${C}"] [data-selected="true"], [data-worktree="${C}"] .is-selected') !== null`)), 'C active', 20_000).catch(() => null)
    const st = await l.state()
    const active = st.repos.flatMap((repo) => repo.worktrees).find((row) => row.path === C)
    l.write(out, `k2active-state-${run}.json`, { openWorkspaceId: active?.openWorkspaceId ?? null })
    if (!l.prefs().collapsedLineage.includes(T)) await l.clickAt(`[data-lineage-toggle="${T}"]`)
    cards = await settle()
    at = byPath(cards)
    check('K2d-precondition', 'T 접힘 · C 루트 · C 작업 공간 열림', l.prefs().collapsedLineage.includes(T) && at[C]?.owner === null && (active?.openWorkspaceId ?? null) !== null, { clicked: clicked.ok, collapsed: l.prefs().collapsedLineage.map(short), open: active?.openWorkspaceId ?? null })
    await dragRaw({ source: at[C], toY: centerOf(at[T]).y, via: [centerOf(at[T]).y - 8] })
    const waitN = await waitParent(C, idOf(T))
    cards = await settle()
    at = byPath(cards)
    check('K2d-R2B', 'R2-B — 활성 C 를 접힌 T 로 끌어 넣으면 C 부모 = T(G5) · T 펼침 · C 보임', waitN.ok && !l.prefs().collapsedLineage.includes(T) && at[C]?.owner === T, { input: 'cdp', ms: waitN.ms, parent: parentOf(C), collapsed: l.prefs().collapsedLineage.map(short), layout: layout(cards) })
    // 사용자가 활성 카드의 조상을 직접 접는다(M10 허용).
    await l.clickAt(`[data-lineage-toggle="${T}"]`)
    cards = await settle()
    check('K2d-M10', 'M10 — 사용자가 활성 C 의 조상 T 를 직접 접는 것은 허용(C 숨음)', l.prefs().collapsedLineage.includes(T) && !cards.some((card) => card.path === C), { collapsed: l.prefs().collapsedLineage.map(short) })
  },
  async k2activeafter() {
    await l.untilTreeBuilt()
    await l.until(async () => ((await l.cards()).length > 0 ? true : null), 'cards', 30_000)
    await l.pause(2500)
    const cards = await l.cards()
    const st = await l.state()
    const active = st.repos.flatMap((repo) => repo.worktrees).find((row) => row.path === C)
    check('K2d-R1C-restart', 'R1-C — 활성 C 가 접힌 T 의 자식인 채 종료 → 재기동 시 T 펼침 · C 보임', !l.prefs().collapsedLineage.includes(T) && cards.some((card) => card.path === C && card.owner === T), { collapsed: l.prefs().collapsedLineage.map(short), open: active?.openWorkspaceId ?? null, layout: layout(cards) })
  },

  /** K3ⓒ 무효 대상 — 고정 카드(R2, ui-prefs pinnedWorktrees 로 띄운 뒤). 부모 없는 X 를 고정 구획의 R2 가운데로: 강조 없음 · X 부모 그대로(null). */
  async k3pinned() {
    await l.untilTreeBuilt()
    prep({})
    const cards = await settle()
    const at = byPath(cards)
    const pinnedR2 = cards.find((card) => card.path === R2 && card.section === 'pinned')
    const seen = await dragRaw({ source: at[X], toY: centerOf(pinnedR2).y, via: [centerOf(pinnedR2).y + 12], during: async () => l.dragView() })
    await l.pause(1500)
    check('K3c-invalid-pinned', '무효 대상(고정 카드 R2) 위 — 끌기 중 · 상위 지정 강조 없음 · 놓아도 X parentWorktreeId 그대로(null)', pinnedR2 !== undefined && seen.preview.length === 1 && seen.targets.length === 0 && parentOf(X) === null, { input: 'cdp', pinned: pinnedR2 !== undefined, dragging: seen.preview.length, targets: seen.targets.map(short), after: parentOf(X) })
  },

  /** K2ⓑ 격리 회차 — fixture 레포(/tmp/l576fx, 실제 레포 아님)에서 접기 → 재시작 유지. 검사는 k2fxafter. */
  async k2fx() {
    const fx = fs.realpathSync(FX)
    const fxw = fs.realpathSync(FXW)
    l.cli(['worktree', 'set', '--worktree', `path:${fxw}`, '--parent-worktree', `path:${fx}`])
    let cards = await settle()
    const nested = byPath(cards)[fxw]?.owner === fx
    if (!l.prefs().collapsedLineage.includes(fx)) await l.clickAt(`[data-lineage-toggle="${fx}"]`)
    cards = await settle()
    check('K2b-fx-collapse', 'fixture 레포 — fx-child 가 fx 본체 아래 중첩 · 칩 클릭으로 접힘 · ui-prefs 에 fx 본체', nested && !cards.some((card) => card.path === fxw) && l.prefs().collapsedLineage.includes(fx), { nested, prefs: l.prefs().collapsedLineage.map(short) })
  },
  async k2fxafter() {
    await l.untilTreeBuilt()
    await l.pause(1000)
    const fx = fs.realpathSync(FX)
    const fxw = fs.realpathSync(FXW)
    const cards = await l.cards()
    check('K2b-fx-restart', 'fixture 레포 — 재시작 뒤 fx 본체 접힘 유지(fx-child 숨김) · ui-prefs 그대로', !cards.some((card) => card.path === fxw) && cards.some((card) => card.path === fx) && l.prefs().collapsedLineage.includes(fx), { prefs: l.prefs().collapsedLineage.map(short) })
  },

  /** 이름 정렬에서 R2-A — 재시작 전 ui-prefs `sidebarSortBy: name` 로 띄운 뒤. */
  async k4name() {
    await l.untilTreeBuilt()
    prep(TREE)
    let cards = await settle()
    let at = byPath(cards)
    const sortBefore = l.prefs().sidebarSortBy
    const units = () => cards.filter((card) => card.owner === null && card.section === M)
    const ui = units()
    const tIndex = ui.findIndex((card) => card.path === T)
    const next = ui[tIndex + 1]
    const shownBefore = layout(cards)
    await dragRaw({ source: at[R1], toY: next.top + 2, via: [next.top + 20] })
    const waitR = await waitParent(R1, null)
    cards = await settle()
    at = byPath(cards)
    const nowUnits = units().map((card) => card.path)
    check('K4c-unnest-land-name', 'R2-A 이름 정렬 — 부모 해제(G5 null) · R1 이 T 덩어리 바로 뒤 루트 · 정렬 Manual 로 전환(ui-prefs)', sortBefore === 'name' && waitR.ok && nowUnits[nowUnits.indexOf(T) + 1] === R1 && l.prefs().sidebarSortBy === 'manual', { input: 'cdp', sortBefore, sortAfter: l.prefs().sidebarSortBy, before: shownBefore, after: layout(cards) })
  },

  /** K1 고정 부모 끌어올림 · 필터 숨김 칩 — ui-prefs pinnedWorktrees=[T]·sidebarHideDefaultBranch 로 띄운 뒤. */
  async k1pin() {
    await l.untilTreeBuilt()
    prep({ ...TREE, [X]: M })
    const cards = await settle()
    const pinned = cards.filter((card) => card.section === 'pinned').map((card) => `${short(card.path)}@${card.depth}`)
    const at = byPath(cards)
    check('K1c-pinned', '고정한 T 의 보이는 후손이 고정 구획으로 함께 올라가 그 안에 중첩', pinned[0] === 'LIFE-576-worktree-nesting@0' && pinned.length > 1 && cards.filter((card) => card.section === 'pinned').slice(1).every((card) => card.owner === T), { pinned })
    check('K1c-filter-chip', '필터(Hide default branch)로 부모 MAIN 이 숨으면 X 는 평소 자리(깊이 0) + `↳` 칩', at[M] === undefined && at[X]?.depth === 0 && /↳/.test(at[X]?.parentChip ?? ''), { x: at[X] && { depth: at[X].depth, chip: at[X].parentChip } })
    check('K1-pin-shot', '화면 캡처', true, { shot: await shot('k1-pinned-filter') })
  },

  /** R2-D 필터 단독 — 핀 없이(C·X 같은 구획) C 를 접고 R1(detached)을 필터로 숨긴 상태. */
  async k1cyclefilter() {
    await l.untilTreeBuilt()
    const cards = await settle()
    const at = byPath(cards)
    l.write(out, `k1cyclefilter-cards-${run}.json`, layout(cards))
    check('R2D-filter-same-section', '순환 C→R1→X→C · R1 필터로 숨김 · C 접힘 · 핀 없음 — C·X 둘 다 같은 레포 구획의 루트(깊이 0)로 보이고 C 에 칩 없음', at[R1] === undefined && at[C]?.section === M && at[X]?.section === M && at[C]?.depth === 0 && at[X]?.depth === 0 && at[X]?.owner === null && at[C]?.chip === null, { C: at[C] && { section: short(at[C].section), depth: at[C].depth, chip: at[C].chip }, X: at[X] && { section: short(at[X].section), depth: at[X].depth, owner: short(at[X].owner) } })
    check('R2D-filter-shot', '화면 캡처', true, { shot: await shot('k1-cycle-filter') })
  },

  /** R2-D — 순환 + 필터/핀(앱 정지 중 격리 repos.json 직접 편집으로 만든 순환). */
  async k1cycle() {
    const cards = await settle()
    const at = byPath(cards)
    l.write(out, `k1cycle-cards-${run}.json`, layout(cards))
    check('R2D-filter', 'C→R1→X→C 순환에서 R1(detached)을 필터로 숨기고 C 를 접어도 X 는 루트로 보인다 — 렌더 정상', at[R1] === undefined && at[C]?.owner === null && at[X]?.owner === null && at[X]?.depth === 0, { C: at[C] && { owner: at[C].owner }, X: at[X] && { owner: short(at[X].owner), depth: at[X].depth } })
    const pinned = cards.filter((card) => card.section === 'pinned').map((card) => short(card.path))
    check('R2D-pin', '순환 구성원 C 를 고정해도 순환 간선(X)을 따라 끌어올리지 않는다', pinned.includes(short(C)) && !pinned.includes(short(X)), { pinned })
    check('R2D-shot', '화면 캡처', true, { shot: await shot('k1-cycle') })
  },
}

const fn = steps[step]
if (fn === undefined) throw new Error(`단계 ${step} — ${Object.keys(steps).join(' · ')}`)
const started = new Date().toISOString()
try {
  await fn()
} catch (error) {
  check(`${step}-error`, '단계가 예외 없이 끝난다', false, { error: String(error?.stack ?? error).slice(0, 1500) })
}
await l.closeCdp()
const failed = checks.filter((row) => !row.pass).map((row) => row.id)
l.write(out, `${step}-${run}.json`, { step, run, started, finished: new Date().toISOString(), failed, checks })
process.exit(failed.length === 0 ? 0 : 1)
