// H2 (붙기 실패 복구) — **첫 스냅샷이 실패해도 옛 pane 의 화면이 남지 않는다.**
//
// ## 무엇이 잘못돼 있었나 (판정 H2)
//
// `bootstrap()` 의 catch 가 로그만 남기고 끝났다. 그러면 그 세대의 `attach` 프레임이 영영
// 안 나오고, 렌더러 게이트(`frame.kind !== 'attach'` 면 버림)가 이후 `screen` 프레임을 전부
// 버린다. `alive` 는 true 라 죽음 표시도 안 뜬다 — **옛 pane 의 화면 위에 새 pane 의 헤더**가
// 얹힌 채로 굳는다. R5 가 "죽은 pane 을 살아있는 것처럼 그린다"를 미달로 규정한 것과 같은 층이다.
//
// ## 고친 방식
//
// 붙기가 성공한 세대를 기억하고, 아직 안 붙은 세대면 **읽기 대신 붙기부터 다시 한다.**
// 세대마다 즉시 재시도 한 번, 그 뒤로는 심장박동이 같은 경로로 계속 두드린다.
// 스크롤백 씨앗도 같이 되살아난다 — `screen` 프레임을 승격시키는 방식이었다면 씨앗을
// 영영 잃었을 것이다 (T5 가 지키는 것이 그것이다).
//
// ## 재현 스위치
//
// `CORRAL_INJECT_ATTACH_FAIL=<n>` — 세대마다 붙기 읽기를 n 번 실패시킨다.
//   n=1: 즉시 재시도가 살린다        n=3: 즉시 재시도까지 실패 → 심장박동이 살린다
//
// 두 팔 다 잰다. **"복구했다"를 증명하려면 결국 성공해야 하므로** 예산은 유한하다.

import { rendererErrors, request, run, sleep, startApp, tidySession, writeRaw } from './lib.mjs'

const OLD_MARK = 'H2OLDPANE'
const NEW_MARK = 'H2NEWPANE'

const paneId = await tidySession()
await run(paneId, `clear; printf '${OLD_MARK}\\n'`, { settleMs: 900 })

// 두 번째 pane — 여기로 옮겨 붙을 때 붙기를 실패시킨다.
const split = await request('pane.split', { pane_id: paneId, direction: 'right' })
const otherPane = split.pane?.pane_id ?? split.pane_id
await sleep(900)
// 히스토리를 **뷰포트보다 많이** 심는다 — 위로 밀려난 줄이 있어야 씨앗이 0보다 크다.
// (30줄만 심었더니 화면에 다 들어가 씨앗이 0이었다. 그러면 "씨앗도 되살아났다"를 못 잰다.)
await run(otherPane, 'clear; for i in $(seq 1 60); do echo "H2 HIST $i"; done', { settleMs: 2500 })
// 마커는 **마지막에** 찍는다. 히스토리에 밀려 화면 밖으로 나가면 찾을 수가 없다.
await run(otherPane, `printf '${NEW_MARK}\\n'`, { settleMs: 900 })

const arms = []
for (const failures of [1, 3]) {
  const app = await startApp({ name: `h2-${failures}`, env: { CORRAL_INJECT_ATTACH_FAIL: String(failures) } })
  await sleep(1200)

  // ① 먼저 옛 pane 에 붙는다. (이 세대도 실패 예산을 쓴다 — 그래도 결국 붙어야 한다.)
  await app.selectPane(paneId)
  await sleep(6000)
  const oldShown = (await app.find(OLD_MARK)).found
  const policy = (await app.policy()).policy

  // ② 새 pane 으로 옮긴다. 이 세대의 첫 붙기가 주입으로 실패한다.
  const at = Date.now()
  await app.selectPane(otherPane)
  let repairedMs = null
  let oldStillThereMs = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const newFound = (await app.find(NEW_MARK)).found
    const oldFound = (await app.find(OLD_MARK)).found
    if (oldFound) oldStillThereMs = Date.now() - at
    if (newFound && !oldFound) {
      repairedMs = Date.now() - at
      break
    }
    await sleep(60)
  }

  const state = (await app.state()).state.terminal
  const entries = app.entries()
  // 화면에서 찾은 시각과 별개로, **로그에서도** 복구 시각을 뽑는다 — 선택한 순간부터
  // 그 세대의 첫 `attach` 프레임까지가 "옛 화면이 남아 있던 시간"이다.
  const selectAt = entries.filter((entry) => entry.tag === 'ui.selection.set' && entry.paneId === otherPane).pop()
  const firstAttachFrame = entries.find(
    (entry) => entry.tag === 'term.frame' && entry.kind === 'attach' && entry.paneId === otherPane,
  )
  const repairFromLogMs =
    selectAt && firstAttachFrame ? firstAttachFrame.at - selectAt.at : null
  const failed = entries.filter((entry) => entry.tag === 'term.attach.failed')
  const retried = entries.filter((entry) => entry.tag === 'term.attach.retry')
  const attachFrames = entries.filter((entry) => entry.tag === 'term.frame' && entry.kind === 'attach')
  const arm = {
    injectedFailures: failures,
    oldPaneShownFirst: oldShown,
    repairedMs,
    repairFromLogMs,
    // 옛 화면이 언제까지 보였나. 복구가 없었다면 이 값이 창을 넘어 계속 자란다.
    oldScreenLastSeenMs: oldStillThereMs,
    promisedWindowMs: policy.recoveryWindowMs,
    withinPromise: repairFromLogMs !== null && repairFromLogMs <= policy.recoveryWindowMs,
    attachFailedLogs: failed.length,
    attachRetryLogs: retried.length,
    attachFramesEmitted: attachFrames.length,
    seededLinesAfterRepair: state.seededLines,
    seedRestored: (state.seededLines ?? 0) > 0,
    alive: state.alive,
    // 복구된 뒤에는 실패 표시가 없어야 한다 (G5 의 반대쪽 — 평시에 경고가 남으면 안 된다).
    attachFailedNotice: state.attachFailed,
    // **한 세대에 `attach` 프레임은 한 장이다** (2회차 리뷰 G2). 두 장 이상이면 씨앗이 겹친다.
    attachFramesByGeneration: attachFrames.reduce((acc, frame) => {
      acc[frame.generation] = (acc[frame.generation] ?? 0) + 1
      return acc
    }, {}),
    rendererErrors: rendererErrors(entries),
    shot: (await app.termShot(`h2-${failures}`)).file,
    fullShot: (await app.shot(`h2-${failures}-full`)).file,
  }
  arms.push(arm)
  console.log('H2 주입', failures, JSON.stringify({ ...arm, shot: undefined, fullShot: undefined }))
  await app.stop()
}

// ==========================================================================
// H2-b — **영원히 실패하면** 화면을 정직하게 바꾸나 (2회차 리뷰 G5)
// ==========================================================================
//
// 1차 수정은 "일시적 실패"만 덮었다. 계속 실패하면 옛 pane 의 화면이 그대로 남고 `alive` 는
// true 라 아무 표시도 없다 — 1차 H2 가 지적한 그 화면이고, 트리거만 좁아졌을 뿐이다.
// (`FIXED.md` §3 은 이 경우를 R3·R5 관할이라고 적었는데 **틀렸다**: R3 은 링크 단절,
// R5 는 pane 사망이고, 여기는 링크 live · pane 생존 · 그 pane 의 읽기만 실패다.)
//
// 그래서 약속 창을 넘기면 화면을 덮는다. 여기서 재는 것은 ① 표시가 뜨는가 ② 언제 뜨는가
// ③ 그 뒤에도 계속 다시 붙는가 — 포기하는 것이 아니라 **정직해지는 것**이 고침이다.
const forever = await (async () => {
  const app = await startApp({ name: 'h2-forever', env: { CORRAL_INJECT_ATTACH_FAIL: '999' } })
  await sleep(1200)
  await app.selectPane(paneId)
  await sleep(6000)
  const oldShown = (await app.find(OLD_MARK)).found
  const policy = (await app.policy()).policy

  const at = Date.now()
  await app.selectPane(otherPane)
  let noticeMs = null
  let notice = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const live = (await app.state()).state.terminal
    if (live.attachFailed !== null) {
      noticeMs = Date.now() - at
      notice = live.attachFailed
      break
    }
    await sleep(120)
  }
  await sleep(2500)
  const state = (await app.state()).state.terminal
  const entries = app.entries()
  const broken = entries.filter((entry) => entry.tag === 'term.attach.broken')
  const shot = await app.termShot('h2-forever')
  const full = await app.shot('h2-forever-full')
  const out = {
    note: '붙기가 계속 실패하는 동안 화면이 정직해지나 (G5). 주입 999회라 이 팔은 끝내 복구되지 않는다',
    injectedFailures: 999,
    oldPaneShownFirst: oldShown,
    promisedWindowMs: policy.recoveryWindowMs,
    noticeMs,
    notice,
    // 약속 창 안에는 조용히 다시 붙고, 넘어가면 알린다 — 두 조건을 같이 본다.
    noticeAfterPromise: noticeMs !== null && noticeMs > policy.recoveryWindowMs,
    brokenLogs: broken.length,
    // 표시를 띄운 뒤에도 **계속 다시 붙는다** — 포기가 아니다.
    attachAttempts: entries.filter((entry) => entry.tag === 'term.attach.failed').length,
    stillAlive: state.alive,
    attachFailedNotice: state.attachFailed,
    oldScreenStillUnderneath: (await app.find(OLD_MARK)).found,
    rendererErrors: rendererErrors(entries),
    shot: shot.file,
    fullShot: full.file,
  }

  // **더 나쁜 갈래**: 그 상태에서 pane 이 죽으면? 화면은 여전히 옛 pane 것인데 죽음 이름표가
  // 붙는다 — 엉뚱한 화면에 붙은 이름표다 (2회차 리뷰 G5). 이름표가 그 사실을 말하는지 본다.
  await request('pane.close', { pane_id: otherPane }).catch(() => {})
  await sleep(3000)
  const dead = (await app.state()).state.terminal
  out.deathWhileNeverAttached = {
    note: '한 번도 못 붙은 pane 이 죽었을 때 이름표가 정직한가',
    alive: dead.alive,
    deadReason: dead.deadReason,
    saysScreenIsNotThisPane: String(dead.deadReason ?? '').includes('이 pane 의 것이 아니다'),
    shot: (await app.termShot('h2-forever-dead')).file,
  }
  console.log('H2 영구실패·사망', JSON.stringify({ ...out.deathWhileNeverAttached, shot: undefined }))
  console.log('H2 영구실패', JSON.stringify({ ...out, shot: undefined, fullShot: undefined }))
  await app.stop()
  return out
})()

await request('pane.close', { pane_id: otherPane }).catch(() => {})

writeRaw('31-h2-repair.json', {
  measuredAt: new Date().toISOString(),
  injection: 'CORRAL_INJECT_ATTACH_FAIL=<n> — 세대마다 붙기 읽기를 n 번 실패시킨다',
  fix: 'attachedGeneration 을 두고, 안 붙은 세대면 readOnce 가 읽기 대신 bootstrap 을 다시 부른다. 세대당 즉시 재시도 1회 + 그 뒤 심장박동',
  panes: { old: paneId, new: otherPane },
  injectionBudgetNote:
    '주입 예산은 **모듈 전역 + 세대당**이다 — 세대가 바뀌면 다시 찬다 (2회차 리뷰 N3). 그래서 n=1 이라도 옛 pane 붙기 1회 + 새 pane 붙기 1회 = attachFailedLogs 2 가 정상이다. 계측 전용 스위치이고 제품 경로에는 없다',
  arms,
  forever,
  allRepaired: arms.every((arm) => arm.repairFromLogMs !== null && arm.attachFramesEmitted > 0),
  allWithinPromise: arms.every((arm) => arm.withinPromise),
  allSeedsRestored: arms.every((arm) => arm.seedRestored),
  /** 복구된 팔에는 경고가 남으면 안 되고, 영영 실패하는 팔에는 반드시 떠야 한다 (G5). */
  noticeOnlyWhenBroken: arms.every((arm) => arm.attachFailedNotice === null) && forever.notice !== null,
  /** 한 세대에 attach 프레임 한 장 (G2). */
  oneAttachFramePerGeneration: arms.every((arm) =>
    Object.values(arm.attachFramesByGeneration).every((count) => count === 1),
  ),
})
process.exit(0)
