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
  // **첫 세대(옛 pane)는 성공시킨다** — 그래야 "이전 pane 이 그려져 있는데 새 pane 을 못 읽는"
  // 그 화면이 만들어진다. 드라이런에서 첫 붙기부터 실패시켰더니 화면이 비어 버려
  // (`oldPaneShownFirst: false`) 정작 재려던 상태가 안 나왔다.
  const app = await startApp({
    name: 'h2-forever',
    env: { CORRAL_INJECT_ATTACH_FAIL: '999', CORRAL_INJECT_ATTACH_FAIL_SKIP: '2' },
  })
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

// ==========================================================================
// H2-c — **응답 없이 매달리는 붙기** (3회차 리뷰 H2 · codex)
// ==========================================================================
//
// 2회차의 `forever` 팔은 `CORRAL_INJECT_ATTACH_FAIL` 로 **즉시 throw** 하는 fast-fail 이다.
// 그 모양에서는 실패가 `catch` 로 들어오는 시각과 시도를 시작한 시각이 사실상 같아서,
// 시계를 `catch` 에 두어도 값이 맞아 보였다(`noticeMs: 2316`). 진짜 장애는 다르다 —
// 요청이 매달리면 `pane.read` 타임아웃 8초 동안 `catch` 가 안 돌고 그동안은 아무 표시도 없다.
// 사용자가 보는 것은 그 10초 내내 "옛 pane 화면 + 새 pane 헤더"다.
//
// 3회차 수정은 시계를 **시도 시작**으로 옮겼다. 이 팔이 그 갈래를 실제로 밟는다.
// **판별자**: 매달림 6초인데 표시가 그보다 **먼저** 뜨면, 그 표시는 `catch` 가 만든 것일 수
// 없다 (옛 시계로는 6초 + 약속 창 ≈ 8.1초가 하한이다).
const hang = await (async () => {
  const hangMs = 6000
  // **이 팔은 제 pane 을 만든다.** 앞의 `forever` 팔이 죽음 이름표를 재느라 `otherPane` 을
  // 닫아 버린다 — 그대로 쓰면 매달림이 풀린 뒤의 읽기가 "pane 이 없다"로 실패해
  // **표시가 걷히는 것을 못 잰다**. 드라이런에서 `recovered: false` 로 드러났다.
  const hangSplit = await request('pane.split', { pane_id: paneId, direction: 'right' })
  const hangPane = hangSplit.pane?.pane_id ?? hangSplit.pane_id
  await sleep(900)
  await run(hangPane, 'clear; for i in $(seq 1 60); do echo "H2 HANG $i"; done', { settleMs: 2500 })
  await run(hangPane, `printf '${NEW_MARK}\\n'`, { settleMs: 900 })
  const app = await startApp({
    name: 'h2-hang',
    env: { CORRAL_INJECT_ATTACH_HANG_MS: String(hangMs), CORRAL_INJECT_ATTACH_FAIL_SKIP: '2' },
  })
  await sleep(1200)
  await app.selectPane(paneId)
  await sleep(6000)
  const oldShown = (await app.find(OLD_MARK)).found
  const policy = (await app.policy()).policy

  const at = Date.now()
  await app.selectPane(hangPane)
  let noticeMs = null
  let notice = null
  let failuresBeforeNotice = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const live = (await app.state()).state.terminal
    if (live.attachFailed !== null) {
      noticeMs = Date.now() - at
      notice = live.attachFailed
      // **`catch` 가 한 번도 안 돌았는데 표시가 떴다** — 시계가 시도 시작에 있다는 증거다.
      failuresBeforeNotice = app.entries().filter((entry) => entry.tag === 'term.attach.failed').length
      break
    }
    await sleep(120)
  }

  // 매달림이 풀리면 정상으로 붙고 표시도 걷힌다 — 켜지는 것만으로는 반쪽이다.
  let clearedMs = null
  let newShownMs = null
  const deadline2 = Date.now() + 20_000
  while (Date.now() < deadline2) {
    const live = (await app.state()).state.terminal
    if (clearedMs === null && live.attachFailed === null && live.paneId === hangPane) clearedMs = Date.now() - at
    if (newShownMs === null && (await app.find(NEW_MARK)).found) newShownMs = Date.now() - at
    if (clearedMs !== null && newShownMs !== null) break
    await sleep(150)
  }

  const entries = app.entries()
  const state = (await app.state()).state.terminal
  const out = {
    note: '붙기의 첫 읽기를 6초 매달아 둔다 — throw 가 아니라 in-flight 다 (3회차 리뷰 H2)',
    hangMs,
    hangLogs: entries.filter((entry) => entry.tag === 'term.attach.hang').length,
    oldPaneShownFirst: oldShown,
    promisedWindowMs: policy.recoveryWindowMs,
    noticeMs,
    notice,
    // 약속 창은 넘겼고, 매달림이 끝나기 **전에** 떴다. 뒤엣것이 옛 시계와 갈리는 자리다.
    noticeAfterPromise: noticeMs !== null && noticeMs > policy.recoveryWindowMs,
    noticeWhileInFlight: noticeMs !== null && noticeMs < hangMs,
    failuresBeforeNotice,
    // 2회차 코드(시계가 catch 안)라면 이 시각 이전에는 표시가 불가능했다 — 산술 하한이다.
    oldClockEarliestMs: hangMs + (policy.recoveryWindowMs ?? 0),
    clearedMs,
    newShownMs,
    // 매달림이 풀린 뒤 **씨앗까지** 제대로 심고 붙었나 — 표시가 걷히는 것만으로는 반쪽이다.
    seededLinesAfter: state.seededLines,
    recovered: state.attachFailed === null && (await app.find(NEW_MARK)).found,
    attachFramesByGeneration: entries
      .filter((entry) => entry.tag === 'term.frame' && entry.kind === 'attach')
      .reduce((acc, frame) => {
        acc[frame.generation] = (acc[frame.generation] ?? 0) + 1
        return acc
      }, {}),
    rendererErrors: rendererErrors(entries),
    shot: (await app.termShot('h2-hang')).file,
  }
  console.log('H2 매달림', JSON.stringify({ ...out, shot: undefined }))
  await app.stop()
  await request('pane.close', { pane_id: hangPane }).catch(() => {})
  return out
})()

// ==========================================================================
// H2-d — **붙은 뒤** 읽기가 끊기면 (3회차 리뷰 N2)
// ==========================================================================
//
// 한 번 붙으면 `readOnce` 가 `bootstrap` 을 다시 안 부른다. 그래서 그 뒤의 실패는
// `term.read.failed` 로만 쌓이고 화면은 **정지한 과거**인데 `alive` 는 true 다 — 2회차까지
// 아무 표시도 없었다. 이쪽 화면은 "남의 pane" 이 아니라 **이 pane 의 낡은 화면**이므로
// 덮지 않고 머리말에만 적는다(`staleScreen`). 켜지고 **꺼지는 것**까지 잰다.
const afterAttach = await (async () => {
  // **예산이 40 인 이유**: 붙은 직후는 hot 창이라 심장박동이 250ms 다. 문턱은 두 주기
  // (≈4.1초)이므로, 실패가 그보다 오래 이어져야 이름표가 켜진다 — 6회(1.5초)면 문턱에
  // 닿기 전에 예산이 떨어져 **검사가 아무것도 안 문다**.
  const app = await startApp({ name: 'h2-stale', env: { CORRAL_INJECT_READ_FAIL: '40' } })
  await sleep(1200)
  const at = Date.now()
  await app.selectPane(paneId)
  let attachedMs = null
  let staleMs = null
  let stale = null
  let clearedMs = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const live = (await app.state()).state.terminal
    if (attachedMs === null && live.frames > 0) attachedMs = Date.now() - at
    if (staleMs === null && live.staleScreen !== null) {
      staleMs = Date.now() - at
      stale = live.staleScreen
    }
    if (staleMs !== null && clearedMs === null && live.staleScreen === null) {
      clearedMs = Date.now() - at
      break
    }
    await sleep(150)
  }
  const entries = app.entries()
  const state = (await app.state()).state.terminal
  const out = {
    note: '붙은 뒤 읽기를 40회 실패시킨다 — 화면은 이 pane 의 것이 맞고 낡았을 뿐이라 덮지 않는다',
    injectedReadFailures: 40,
    readFailedLogs: entries.filter((entry) => entry.tag === 'term.read.failed').length,
    attachedMs,
    // 붙기는 성공했다 = 이 갈래는 `attachFailed` 가 아니라 `staleScreen` 관할이다.
    attachedThenFailed: attachedMs !== null,
    staleNoticeMs: staleMs,
    staleNotice: stale,
    // 덮개가 아니라 이름표다 — 아래 화면은 이 pane 의 것이 맞다.
    veiledInstead: state.attachFailed,
    oldScreenStillReadable: (await app.find(OLD_MARK)).found,
    clearedMs,
    recovered: state.staleScreen === null,
    rendererErrors: rendererErrors(entries),
    shot: (await app.termShot('h2-stale')).file,
  }
  console.log('H2 붙은뒤끊김', JSON.stringify({ ...out, shot: undefined }))
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
  hang,
  afterAttach,
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
