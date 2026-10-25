// LIFE-694 최종 관문 장면 — up.sh 가 띄운 격리 앱(제어 소켓)·격리 herdr 세션에서 한 장면을 돌리고 원자료 JSON 을 남긴다.
//   node scripts/l694/gate.mjs <ROOT=/tmp/l694g-*> <FAKE=/tmp/l694g-f*> <장면> <OUT 디렉터리>
// 장면: selfcheck · c1 · c2a · c2c · c3 · f1 · f2 · c5 · c6 · g1h1 · c7a · c7b
// 판정 근거 = 공급(`ctl state` → AppState.retainedAgents)·DOM 값(eval/rect/computed-style)·로그(corral.ndjson)·캡처(ctl shot).
// 대기는 시간 초과를 예외로 올리고, 장면은 예외를 실패로 적는다(exit 1). 통과선을 낮추는 재시도는 없다.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { checkRoot, ctl, evalJs, herdrCli, logs, makeDone, retained, rpc, sleep, state, waitFor, waitTreeAfter, writeJson } from './lib.mjs'

const [root, fake, scene, out] = process.argv.slice(2)
checkRoot(root)
if (!/^\/tmp\/l694g-f[a-z0-9]*$/.test(fake ?? '')) throw new Error(`FAKE 는 /tmp/l694g-f*: ${fake}`)
const RR = fs.realpathSync(root)
const REPO = path.join(RR, 'repos/r')
const REPO2 = path.join(RR, 'repos/r2')
const SLOTS = path.join(REPO, '.claude/worktrees')
const HOME = fs.realpathSync(process.env.HOME)
// 회차 id(원자료 폴더 앞머리 gNN) — 자리 경로·브랜치 이름에 붙여 같은 인스턴스에서 장면을 다시 돌려도 겹치지 않게 한다.
const RUN = path.basename(out ?? '').split('-')[0] || 'x'
const slotPath = (name, ...rest) => path.join(SLOTS, `${name}-${RUN}`, ...rest)
const record = { scene, root, startedAt: new Date().toISOString(), uptime: execFileSync('uptime').toString().trim(), steps: [], checks: [] }
const step = (name, data = {}) => { record.steps.push({ t: new Date().toISOString(), at: Date.now(), name, ...data }) }
const check = (name, ok, data = {}) => { record.checks.push({ name, ok: ok === true, ...data }) }
const git = (...args) => execFileSync('/usr/bin/git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const gitctl = (name, value) => { const file = path.join(root, 'gitctl', name); if (value === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, String(value)) }

const supplyHas = async (paneId) => (await retained(root)).some((row) => row.paneId === paneId)
const create = async (cwd, label) => {
  const result = await rpc(root, 'workspace.create', { cwd, label, focus: false })
  step('workspace.create', { cwd, label, workspaceId: result.workspace.workspace_id, paneId: result.root_pane.pane_id })
  return { workspaceId: result.workspace.workspace_id, paneId: result.root_pane.pane_id, at: Date.now() }
}
const split = async (target, cwd) => {
  const result = await rpc(root, 'pane.split', { target_pane_id: target, direction: 'right', cwd, focus: false })
  const paneId = result.pane?.pane_id ?? result.root_pane?.pane_id
  step('pane.split', { target, cwd, paneId, raw: JSON.stringify(result).slice(0, 300) })
  return paneId
}
const cliClose = async (kind, id) => {
  const r = await herdrCli(root, [kind, 'close', id])
  step(`herdr ${kind} close (corral 밖)`, r)
  if (r.exit !== 0) throw new Error(`herdr ${kind} close 실패 ${JSON.stringify(r)}`)
  const at = Date.now()
  // 닫기는 corral 의 재동기(`agent-session-nudge`)를 부른다 — 그 스냅숏 안에 다음 닫기가 들어가면 push 가 아니라 재동기로 지워져
  // 보존 판정을 안 지난다(g20 C2ⓒ wN — 기존 동작, 이 작업 밖). 연달아 닫지 않게 2.5초 둔다.
  await sleep(2500)
  return at
}
// done 직후 corral 이 에이전트 감지로 재동기(`agent-session-nudge` 스냅숏)를 건다 — 그 사이에 닫으면 push 가 아니라 재동기로 지워져
// 보존 판정을 지나지 않는다(g11 C1ⓑ). 재동기가 끝나도록 2.5초 둔다. 판정은 보존 여부 + 로그(skip/없음)로 같이 본다.
const done = async (paneId) => { step('done', { paneId, ms: await makeDone(root, paneId) }); await sleep(2500) }
const logSince = (t, tags) => logs(root).filter((entry) => entry.at >= t && tags.includes(entry.tag))
const workspaces = async () => ((await rpc(root, 'workspace.list')).workspaces ?? []).map((item) => item.workspace_id)
const cardOf = async (wtPath) => (await state(root)).repos.flatMap((repo) => repo.worktrees).find((item) => item.path === wtPath) ?? null
/** 사이드바에서 그 paneId 의 「닫힌 탭」 행이 붙은 카드 경로(없으면 null) — 두 빌드 공통 표식 `[data-agent-row-source="retained"]`. */
const DOM_RETAINED = `(() => [...document.querySelectorAll('[data-agent-row-source="retained"]')].map((el) => ({
  key: el.getAttribute('data-agent-row'), worktree: el.closest('[data-worktree]')?.getAttribute('data-worktree') ?? null,
  dismiss: el.querySelector('[data-dismiss-retained]')?.getAttribute('data-dismiss-retained') ?? null, text: (el.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 120) })))()`
/** 행이 둘 이상인 카드는 접힌 묶음(알약)이다 — 접힌 행은 DOM 에 없으므로 펼친 뒤 읽는다(사용자가 알약을 누르는 것과 같은 클릭). */
const domRetained = async () => {
  const folded = await evalJs(root, `[...document.querySelectorAll('[data-agent-group][data-agent-group-expanded="false"]')].map((el) => el.getAttribute('data-agent-group'))`)
  for (const wt of folded) {
    const r = await ctl(root, { cmd: 'click', selector: `[data-agent-group="${wt}"]` })
    step('묶음 펼치기', { wt, ok: r.ok })
  }
  if (folded.length > 0) await sleep(300)
  return evalJs(root, DOM_RETAINED)
}
const shot = async (name) => { const r = await ctl(root, { cmd: 'shot', name: `l694-${scene}-${name}` }); step('shot', r); if (r.ok && r.file) fs.copyFileSync(r.file, path.join(out, `${scene}-${name}.png`)); return r }
/** 골격이 이 workspace 를 본 뒤 — 생성 이후 시작한 빌드가 끝났다(로그 `tree.built`). */
const seen = async (since) => step('tree.built after', { since, entry: await waitTreeAfter(root, since) })

const scenes = {
  // 판정력 자기점검 — 대기 헬퍼가 시간 초과를 예외로 올리는지, 공급·DOM 판별이 있는 것/없는 것을 가르는지(c2a 이후엔 실제 행으로 다시 본다).
  async selfcheck() {
    let threw = false
    try { await waitFor(async () => false, { timeoutMs: 300, label: 'never' }) } catch { threw = true }
    check('waitFor 시간 초과는 예외', threw)
    check('없는 paneId 는 공급에 없다', !(await supplyHas('nope:p0')))
    const s = await state(root)
    check('링크 live·자기 세션', s.link.phase === 'live' && s.selectedSession === fs.readFileSync(path.join(root, 'herdr.session'), 'utf8').trim(), { link: s.link.phase, session: s.selectedSession })
    check('등록 레포 r·r2', s.repos.map((repo) => repo.root).sort().join(',') === [REPO, REPO2].sort().join(','), { roots: s.repos.map((repo) => repo.root) })
    record.anchor = (await rpc(root, 'pane.list')).panes.filter((item) => item.focused).map((item) => ({ paneId: item.pane_id, cwd: item.cwd }))
    check('포커스된 pane 은 anchor 하나', record.anchor.length === 1 && record.anchor[0].cwd === RR, { anchor: record.anchor })
  },

  // C1 — 카드 밖·주인 없음 외부 닫기 → 공급에 없음(ⓐ 사라진 죽은 자리 ⓑ 폴더만 남은 죽은 자리 ⓒ HOME). 음성 대조: 골격 전 닫기 → 보존.
  async c1() {
    // ⓐ git worktree 를 만들고 그 자리에 workspace(카드 밖 — worktree.open 아님) → worktree 를 지우고 골격 갱신을 기다린다.
    const aPath = slotPath('c1a')
    git('worktree', 'add', '-q', '-b', `c1a-${RUN}`, aPath)
    const a = await create(aPath, 'c1a')
    git('worktree', 'remove', '--force', aPath)
    step('git worktree remove', { path: aPath, exists: fs.existsSync(aPath) })
    // ⓑ 폴더만(.git 없음, 목록에 없음)
    const bPath = slotPath('c1b', 'apps')
    fs.mkdirSync(bPath, { recursive: true })
    const b = await create(bPath, 'c1b')
    // ⓒ HOME
    const c = await create(HOME, 'c1c')
    await seen(Date.now())
    const card = await cardOf(aPath)
    check('ⓐ 골격 목록에 c1a 없음(죽은 자리)', card === null, { card })
    for (const [shape, item, cwd] of [['ⓐ', a, aPath], ['ⓑ', b, bPath], ['ⓒ', c, HOME]]) {
      check(`${shape} 닫기 전 카드 밖(어느 카드도 귀속 안 함)`, !(await state(root)).repos.flatMap((repo) => repo.worktrees).some((wt) => wt.openWorkspaceId === item.workspaceId))
      await done(item.paneId)
      const closedAt = await cliClose('workspace', item.workspaceId)
      await sleep(1500)
      check(`${shape} 공급에 없음`, !(await supplyHas(item.paneId)), { paneId: item.paneId, cwd })
      const skip = logSince(closedAt - 200, ['retained.skip_ownerless']).filter((entry) => entry.workspaceId === item.workspaceId)
      check(`${shape} 로그 retained.skip_ownerless`, skip.length === 1, { skip })
    }
    // 음성 대조 — 골격을 늦춰(4초, git-worktrees 5초 제한 안) 만든 직후 닫는다: 그 workspace 를 본 골격이 아직 없다 → 보존.
    gitctl('slow-r', 4)
    try {
      const n = await create(HOME, 'c1neg')
      await done(n.paneId)
      const closedAt = await cliClose('workspace', n.workspaceId)
      const builtBefore = logs(root).filter((entry) => entry.tag === 'tree.built' && entry.at <= closedAt && entry.at - entry.ms > n.at - 50)
      check('음성 대조 — 닫기 전에 그 workspace 이후 시작한 골격 없음(골격 전)', builtBefore.length === 0, { builtBefore })
      await sleep(1500)
      check('음성 대조 — 골격 전 닫기는 보존(공급에 있음)', await supplyHas(n.paneId), { paneId: n.paneId })
      record.negativePane = n.paneId
    } finally { gitctl('slow-r', null) }
  },

  // C2ⓐ — 카드에 붙은 workspace 외부 닫기 → 보존·그 카드에 행. pane 둘(p1·p2) — C5 가 이 두 행을 쓴다.
  async c2a() {
    const wt = slotPath('c2a')
    git('worktree', 'add', '-q', '-b', `c2a-${RUN}`, wt)
    await seen(Date.now())
    const opened = await rpc(root, 'worktree.open', { cwd: REPO, path: wt, trust_repository: true, focus: false })
    step('worktree.open', { raw: JSON.stringify(opened).slice(0, 400) })
    const card = (await waitFor(async () => { const c = await cardOf(wt); return c?.openWorkspaceId ? c : null }, { timeoutMs: 15_000, label: 'c2a 카드 귀속' })).value
    const ws = card.workspace
    const p1 = ws.tabs[0].panes[0].paneId
    const p2 = await split(p1, wt)
    await waitFor(async () => (await cardOf(wt))?.workspace?.tabs.flatMap((tab) => tab.panes).some((item) => item.paneId === p2), { label: 'p2 가 카드에' })
    await done(p1); await done(p2)
    await cliClose('pane', p2)
    await cliClose('workspace', card.openWorkspaceId)
    await waitFor(async () => (await supplyHas(p1)) && (await supplyHas(p2)), { timeoutMs: 8000, label: 'c2a 보존' })
    check('ⓐ 공급에 있음(p1·p2)', true, { p1, p2 })
    const rows = await waitFor(async () => { const r = await domRetained(); return r.filter((item) => item.worktree === wt).length === 2 ? r : null }, { timeoutMs: 8000, label: 'c2a 카드에 「닫힌 탭」 행 둘' })
    check('ⓐ 그 카드(c2a)에 「닫힌 탭」 행 둘', true, { rows: rows.value })
    record.c2a = { wt, p1, p2 }
    writeJson(path.join(out, 'c2a-panes.json'), record.c2a)
    await shot('card-rows')
  },

  // C2ⓒ — 판정 불가(다른 등록 레포 r2 의 `git worktree list` 실패 주입 → cardlessGate null)에서 사라진 done pane → 보존.
  //        판정이 가능해진 뒤 죽은 자리 행만 걷힘(HOME 행은 남음). C4 — 그 사이 사이드바 main 카드에 죽은 자리 행이 안 붙는다.
  async c2c() {
    const dPath = slotPath('c2c')
    fs.mkdirSync(dPath, { recursive: true })
    const d = await create(dPath, 'c2c-dead')
    const h = await create(HOME, 'c2c-home')
    await seen(Date.now())
    gitctl('fail-r2', 1)
    try {
      const since = Date.now()
      await seen(since)
      // 스냅숏은 주기 수집(2초) 캐시다 — 주입 뒤에 수집된 것만 본다(g13: 주입 전 스냅숏을 읽어 거짓 미달 · 수집 시각 필드는 `collectedAt`, g18).
      const snap = (await waitFor(async () => { const x = await evalJs(root, 'window.corral.getResourceSnapshot()'); return x !== null && x.collectedAt > since + 300 ? x : null }, { timeoutMs: 10_000, label: '주입 뒤 스냅숏' })).value
      const r2err = (await state(root)).repos.find((repo) => repo.root === REPO2)?.error ?? null
      check('판정 불가 — 주입 뒤 수집한 Resource 카드 밖 목록 null(보류)·r2 git 오류', snap.orphans === null && r2err !== null, { snapAt: snap.collectedAt, since, orphans: snap.orphans, r2err })
      await done(d.paneId); await done(h.paneId)
      await cliClose('workspace', d.workspaceId)
      await cliClose('workspace', h.workspaceId)
      await waitFor(async () => (await supplyHas(d.paneId)) && (await supplyHas(h.paneId)), { timeoutMs: 8000, label: '판정 불가 중 보존' })
      check('ⓒ 판정 불가 중 사라진 done pane 은 보존(죽은 자리·HOME 둘 다)', true, { dead: d.paneId, home: h.paneId })
      await sleep(2500) // 렌더러 반영 대기(push 박자)
      const dom = await domRetained()
      const deadRow = dom.filter((item) => item.dismiss === d.paneId || (item.key ?? '').includes(d.paneId))
      check('C4 — 죽은 자리 보존 행이 사이드바 어느 카드에도(main 포함) 안 붙음', deadRow.length === 0, { dom })
      writeJson(path.join(out, 'c2c-during.json'), { supply: await retained(root), dom })
      await shot('undeterminable')
    } finally { gitctl('fail-r2', null) }
    const back = Date.now()
    await seen(back)
    await waitFor(async () => { const x = await evalJs(root, 'window.corral.getResourceSnapshot()'); return x !== null && x.collectedAt > back + 300 && x.orphans !== null }, { timeoutMs: 15_000, label: '판정 가능 복귀(복귀 뒤 수집한 스냅숏)' })
    check('양성 대조 — 복귀 뒤 수집한 카드 밖 목록은 null 아님', true)
    await waitFor(async () => !(await supplyHas(d.paneId)), { timeoutMs: 10_000, label: '죽은 자리 행 걷힘' })
    check('판정 가능 뒤 죽은 자리 행 걷힘', true)
    check('HOME 행은 남음(C3 규칙은 죽은 자리만)', await supplyHas(h.paneId), { home: h.paneId })
    const pruned = logSince(back, ['retained.pruned_dead_slot'])
    check('로그 retained.pruned_dead_slot 에 그 pane', pruned.some((entry) => String(entry.panes).split(',').includes(d.paneId)), { pruned })
    record.c2cHome = h.paneId
  },

  // C3 — 보존 뒤 worktree 삭제 → 골격 갱신 → 그 행 공급에서 빠짐 → 같은 경로 재생성 → 옛 행 안 붙음. 음성 대조: 살아 있는 c2a 행은 남음.
  async c3() {
    const c2a = JSON.parse(fs.readFileSync(path.join(out, 'c2a-panes.json'), 'utf8'))
    const wt = slotPath('c3')
    git('worktree', 'add', '-q', '-b', `c3-${RUN}`, wt)
    await seen(Date.now())
    await rpc(root, 'worktree.open', { cwd: REPO, path: wt, trust_repository: true, focus: false })
    const card = (await waitFor(async () => { const c = await cardOf(wt); return c?.openWorkspaceId ? c : null }, { timeoutMs: 15_000, label: 'c3 카드 귀속' })).value
    const p = card.workspace.tabs[0].panes[0].paneId
    await done(p)
    await cliClose('workspace', card.openWorkspaceId)
    await waitFor(async () => supplyHas(p), { timeoutMs: 8000, label: 'c3 보존' })
    await waitFor(async () => (await domRetained()).some((item) => item.worktree === wt), { timeoutMs: 8000, label: 'c3 카드에 행' })
    check('보존·그 카드에 행', true, { paneId: p })
    const removedAt = Date.now()
    git('worktree', 'remove', '--force', wt)
    step('git worktree remove', { path: wt, exists: fs.existsSync(wt) })
    const built = await waitTreeAfter(root, removedAt, '삭제 뒤 골격')
    step('골격 갱신(삭제 뒤)', { built })
    await waitFor(async () => !(await supplyHas(p)), { timeoutMs: 10_000, label: 'c3 행 걷힘' })
    check('삭제 → 골격 갱신 → 공급에서 빠짐', true)
    const pruned = logSince(removedAt, ['retained.pruned_dead_slot'])
    check('로그 retained.pruned_dead_slot', pruned.some((entry) => String(entry.panes).split(',').includes(p)), { pruned })
    check('음성 대조 — 살아 있는 c2a 행 둘은 재빌드 뒤에도 남음', (await supplyHas(c2a.p1)) || (await supplyHas(c2a.p2)), { c2a, supply: (await retained(root)).map((row) => row.paneId) })
    const recreatedAt = Date.now()
    git('worktree', 'add', '-q', wt, `c3-${RUN}`)
    await waitTreeAfter(root, recreatedAt, '재생성 뒤 골격')
    await waitFor(async () => (await cardOf(wt)) !== null, { timeoutMs: 10_000, label: 'c3 카드 재생성' })
    await sleep(2500)
    check('재생성 뒤 옛 행 공급에 없음', !(await supplyHas(p)))
    const dom = await domRetained()
    check('재생성 뒤 c3 카드에 「닫힌 탭」 행 없음', !dom.some((item) => item.worktree === wt), { dom })
    const order = logs(root).filter((entry) => entry.at >= removedAt && ['tree.built', 'retained.pruned_dead_slot', 'worktree.changed'].includes(entry.tag)).map((entry) => ({ tag: entry.tag, at: entry.at, ms: entry.ms ?? null }))
    record.order = { removedAt, recreatedAt, log: order }
    check('순서 — 삭제 → 골격 → 걷기 → 재생성', order.some((entry) => entry.tag === 'retained.pruned_dead_slot' && entry.at < recreatedAt), { removedAt, recreatedAt })
    await shot('recreated')
  },

  // F1 배선 — 골격이 새 worktree 를 따라오기 전(목록상 죽은 자리, 디스크엔 .git)에 닫으면 보존된다. 폴더만·사라진 자리는 C1 ⓐⓑ.
  async f1() {
    const wt = slotPath('f1')
    fs.mkdirSync(wt, { recursive: true })
    const w = await create(wt, 'f1')
    await seen(Date.now())
    gitctl('slow-r', 4)
    try {
      git('worktree', 'add', '-q', '-b', `f1-${RUN}`, wt)
      step('git worktree add (빈 폴더 자리에)', { gitExists: fs.existsSync(path.join(wt, '.git')) })
      await done(w.paneId)
      const before = await cardOf(wt)
      check('닫기 직전 골격 목록에 f1 없음(따라오기 전)', before === null, { before })
      const closedAt = await cliClose('workspace', w.workspaceId)
      await sleep(1500)
      check('골격 전 새 worktree 자리의 done pane 은 보존', await supplyHas(w.paneId), { paneId: w.paneId })
      check('skip 로그 없음', logSince(closedAt - 200, ['retained.skip_ownerless']).every((entry) => entry.workspaceId !== w.workspaceId))
      record.f1 = w.paneId
    } finally { gitctl('slow-r', null) }
  },

  // F2 — 카드 밖 workspace 에 HOME pane + 살아 있는 경로 pane: workspace 째 닫기 / pane 따로 닫기 두 장면의 공급(그 장면 pane 의 보존 cwd)이 같다.
  async f2() {
    const live = path.join(RR, 'live')
    fs.mkdirSync(live, { recursive: true })
    const shapes = {}
    for (const how of ['workspace', 'panes']) {
      const w = await create(HOME, `f2-${how}`)
      const lp = await split(w.paneId, live)
      await seen(Date.now())
      await done(w.paneId); await done(lp)
      if (how === 'workspace') await cliClose('workspace', w.workspaceId)
      else { await cliClose('pane', w.paneId); await cliClose('pane', lp) }
      await sleep(1500)
      const supply = await retained(root)
      shapes[how] = { home: supply.some((row) => row.paneId === w.paneId), live: supply.some((row) => row.paneId === lp), cwds: supply.filter((row) => row.paneId === w.paneId || row.paneId === lp).map((row) => row.cwd).sort(), panes: { home: w.paneId, live: lp } }
    }
    record.shapes = shapes
    check('두 닫기 모양의 공급이 같다', JSON.stringify(shapes.workspace.cwds) === JSON.stringify(shapes.panes.cwds), shapes)
    check('HOME pane 은 둘 다 없음 · 살아 있는 경로 pane 은 둘 다 있음', !shapes.workspace.home && !shapes.panes.home && shapes.workspace.live && shapes.panes.live, shapes)
  },

  // C5 — 보존 행 hover ✕ · 클릭 → DOM·공급에서 빠짐 · 다른 행 무변화 · live 행에 ✕ 없음 · 행 활성화 없음 · Tab 포커스 때 ✕ 보임 · IPC 잘못된 인자 · 모바일 목록.
  async c5() {
    const { wt, p1, p2 } = JSON.parse(fs.readFileSync(path.join(out, 'c2a-panes.json'), 'utf8'))
    check('전제 — c2a 행 둘이 공급에 있음', (await supplyHas(p1)) && (await supplyHas(p2)))
    // 전제 — c2a 를 다시 열고 그 pane 을 working 으로 보고한다: ① 폰 목록은 열린 AI 세션이 없는 작업을 숨긴다(M3-b, `list.ts` — g19·g21)
    // ② 같은 카드에 실제 live 에이전트 행이 서야 「live 행에 ✕ 없음」 이 공허하지 않다.
    await rpc(root, 'worktree.open', { cwd: REPO, path: wt, trust_repository: true, focus: false })
    const reopened = (await waitFor(async () => { const c = await cardOf(wt); return c?.openWorkspaceId ? c : null }, { timeoutMs: 15_000, label: 'c2a 다시 열림' })).value
    const livePane = reopened.workspace.tabs[0].panes[0].paneId
    await rpc(root, 'pane.report_agent', { pane_id: livePane, source: 'l694-live', agent: 'claude', state: 'working', seq: 1 })
    step('c2a 다시 열고 live pane working 보고', { workspaceId: reopened.openWorkspaceId, livePane })
    await waitFor(async () => { await domRetained(); return evalJs(root, `!!document.querySelector('[data-agent-row-source="live"][data-agent-row="${livePane}"]')`) }, { timeoutMs: 10_000, label: 'c2a live 행 뜸' })
    const selectedBefore = await evalJs(root, `[...document.querySelectorAll('[data-worktree-card-active]')].map((el) => el.closest('[data-worktree]')?.getAttribute('data-worktree'))`)
    const terminalBefore = (await state(root)).terminal.paneId
    // live·서브에이전트 행에는 ✕ 가 없다(기존 닫기 버튼은 그대로).
    const sources = await evalJs(root, `[...document.querySelectorAll('[data-agent-row]')].map((el) => ({ key: el.getAttribute('data-agent-row'), source: el.getAttribute('data-agent-row-source'), worktree: el.closest('[data-worktree]')?.getAttribute('data-worktree'), dismiss: !!el.querySelector('[data-dismiss-retained]'), close: !!el.querySelector('.session-row-close,.agent-full-close:not([data-dismiss-retained])') }))`)
    record.sources = sources
    const liveRows = sources.filter((item) => item.source === 'live')
    check('live 행이 실제로 있고(c2a) 걷기 ✕ 없음·기존 닫기 버튼 있음', liveRows.some((item) => item.worktree === wt) && liveRows.every((item) => !item.dismiss && item.close), { liveRows })
    check('서브에이전트 행에 걷기 ✕ 없음(장면에 서브에이전트 행이 있으면)', sources.filter((item) => item.source === 'subagent').every((item) => !item.dismiss), { subagent: sources.filter((item) => item.source === 'subagent').length })
    check('보존 행에는 걷기 ✕ 있음', sources.filter((item) => item.source === 'retained').every((item) => item.dismiss))
    // 모바일 — 켜고 폰 자리로 목록을 받는다.
    const { setMobile, phone, revokeAll } = await import('../l580/lib.mjs')
    await setMobile(root, fake, true)
    const lists = []
    const client = await phone(root, { name: 'l694-c5', onList: ({ message, recvAt }) => { lists.push({ recvAt, ids: message.list.available ? message.list.repos.flatMap((repo) => repo.tasks.flatMap((task) => task.channels.map((c) => c.id))) : null }) } })
    try {
      await waitFor(() => lists.some((item) => item.ids?.includes(`retained:${p1}`)), { timeoutMs: 10_000, label: '폰 목록에 retained:p1' })
      check('모바일 — 걷기 전 폰 목록에 retained:p1', true)
      // hover
      const sel = `[data-dismiss-retained="${p1}"]`
      const rowRect = (await ctl(root, { cmd: 'rect', selector: `[data-agent-row-source="retained"]:has(${sel})` })).rect
      const before = (await ctl(root, { cmd: 'computed-style', selector: sel, properties: ['opacity'] })).values
      await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', x: Math.round(rowRect.left + rowRect.width / 2), y: Math.round(rowRect.top + rowRect.height / 2) })
      await sleep(300)
      const hovered = (await ctl(root, { cmd: 'computed-style', selector: sel, properties: ['opacity'] })).values
      const other = (await ctl(root, { cmd: 'computed-style', selector: `[data-dismiss-retained="${p2}"]`, properties: ['opacity'] })).values
      const place = await evalJs(root, `(() => { const b = document.querySelector('${sel}'); const row = b.closest('[data-agent-row]'); const t = row.querySelector('[data-elapsed]'); const r = (el) => { if (!el) return null; const x = el.getBoundingClientRect(); return { left: x.left, right: x.right, top: x.top, bottom: x.bottom } }; return { button: r(b), time: r(t), timeClass: t?.className ?? null, sameParent: t ? t.parentElement === b.parentElement : null, aria: b.getAttribute('aria-label') } })()`)
      record.hover = { before, hovered, other, place }
      check('hover 전 ✕ 안 보임(opacity 0)', before?.opacity === '0', { before })
      check('hover 때 ✕ 보임(opacity 1)·다른 행 ✕ 는 안 보임', hovered?.opacity === '1' && other?.opacity === '0', { hovered, other })
      check('✕ 는 시간 칸과 한 자리(같은 부모·가로 겹침)·aria-label', place.aria !== null && (place.time === null || (place.sameParent === true && place.button.right >= place.time.left && place.button.left <= place.time.right)), place)
      await shot('hover')
      // 클릭
      const clickedAt = Date.now()
      const click = await ctl(root, { cmd: 'click', selector: sel })
      step('click ✕', click)
      check('✕ 클릭 hit', click.ok === true, { click })
      await waitFor(async () => !(await supplyHas(p1)), { timeoutMs: 5000, label: 'p1 공급에서 빠짐' })
      await waitFor(async () => !(await domRetained()).some((item) => item.dismiss === p1), { timeoutMs: 5000, label: 'p1 DOM 에서 빠짐' })
      check('클릭 → 공급·DOM 에서 빠짐', true)
      check('다른 보존 행(p2) 무변화', (await supplyHas(p2)) && (await domRetained()).some((item) => item.dismiss === p2))
      check('로그 retained.dismissed', logSince(clickedAt, ['retained.dismissed']).some((entry) => entry.paneId === p1))
      const selectedAfter = await evalJs(root, `[...document.querySelectorAll('[data-worktree-card-active]')].map((el) => el.closest('[data-worktree]')?.getAttribute('data-worktree'))`)
      const terminalAfter = (await state(root)).terminal.paneId
      check('클릭이 행 활성화(카드 선택·pane 이동)를 안 일으킴', JSON.stringify(selectedBefore) === JSON.stringify(selectedAfter) && terminalBefore === terminalAfter, { selectedBefore, selectedAfter, terminalBefore, terminalAfter })
      await waitFor(() => lists.some((item) => item.recvAt > clickedAt && item.ids !== null && !item.ids.includes(`retained:${p1}`)), { timeoutMs: 10_000, label: '폰 목록에서 retained:p1 사라짐' })
      const last = lists[lists.length - 1]
      check('모바일 — 걷은 뒤 push 에서 retained:p1 사라짐·retained:p2 는 남음', !last.ids.includes(`retained:${p1}`) && last.ids.includes(`retained:${p2}`), { last })
      record.lists = lists
      await shot('after-dismiss')
    } finally {
      await client.close()
      await revokeAll(root)
      await setMobile(root, fake, false)
    }
    // Tab 포커스(F6) — p2 ✕ 바로 앞 포커스 대상에 포커스를 두고 Tab 한 번. 창 비활성 래퍼라 페이지 포커스를 CDP 로 흉내 낸다(g22).
    await ctl(root, { cmd: 'raw-mouse', type: 'mouseMove', x: 1, y: 1 })
    const { cdp } = await import('./lib.mjs')
    const devtools = await cdp(root)
    await devtools.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    record.focusEmulation = await evalJs(root, 'document.hasFocus()')
    step('CDP 포커스 흉내', { hasFocus: record.focusEmulation })
    const sel2 = `[data-dismiss-retained="${p2}"]`
    const prepared = await evalJs(root, `(() => { const all = [...document.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null || el.matches('${sel2}')); const i = all.findIndex((el) => el.matches('${sel2}')); if (i < 1) return { i }; all[i - 1].focus(); return { i, prev: all[i - 1].outerHTML.slice(0, 120), active: document.activeElement === all[i - 1] } })()`)
    await ctl(root, { cmd: 'key', keyCode: 'Tab' })
    await sleep(200)
    const focused = await evalJs(root, `(() => { const b = document.querySelector('${sel2}'); return { active: document.activeElement === b, focusVisible: b.matches(':focus-visible'), opacity: getComputedStyle(b).opacity, activeHtml: document.activeElement?.outerHTML.slice(0, 120) } })()`)
    record.tab = { prepared, focused }
    check('F6 — Tab 포커스 때 ✕ 보임(:focus-visible·opacity 1)', focused.active && focused.focusVisible && focused.opacity === '1', record.tab)
    await shot('tab-focus')
    // 판정력 — 포커스를 빼면(blur) ✕ 는 다시 안 보인다(hover 도 없음).
    const blurred = await evalJs(root, `(() => { const b = document.querySelector('${sel2}'); b.blur(); return getComputedStyle(b).opacity })()`)
    check('대조 — 포커스를 빼면 ✕ 다시 안 보임(opacity 0)', blurred === '0', { blurred })
    await devtools.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    devtools.close()
    // IPC 잘못된 인자 → false·무변화.
    const supplyBefore = (await retained(root)).map((row) => row.paneId).sort()
    const bad = {}
    for (const [name, arg] of [['number', '123'], ['paneId-number', '{ paneId: 5 }'], ['null', 'null'], ['unknown-id', '{ paneId: "w99:p99" }'], ['empty', '{}']]) bad[name] = await evalJs(root, `window.corral.dismissRetained(${arg}).then((v) => ({ value: v }), (e) => ({ error: String(e) }))`)
    const supplyAfter = (await retained(root)).map((row) => row.paneId).sort()
    record.bad = { bad, supplyBefore, supplyAfter }
    check('IPC 잘못된 인자·모르는 id → false·오류 없음', Object.values(bad).every((item) => item.value === false), bad)
    check('IPC 잘못된 인자 뒤 공급 무변화', JSON.stringify(supplyBefore) === JSON.stringify(supplyAfter), { supplyBefore, supplyAfter })
  },

  // C6 — 폴더만 남은 죽은 자리 카드 밖 줄 → 주인 없음 배지·툴팁(줄이 뜬 뒤 ≥3틱 뒤 읽음). 「모두 닫기」 1회 → 그 줄 닫힘·main 하위 폴더 줄은 남음.
  async c6() { await orphanScene({ expectOwnerless: true, closeAll: true }) },
  // C7ⓑ(기준 빌드) — 같은 장면에서 「경로 있음」(697 재현). 닫기는 하지 않는다.
  async c7b() { await orphanScene({ expectOwnerless: false, closeAll: false }) },

  // G1·H1 end-to-end — 주인 없음으로 뜬 뒤 5초 안에 ① 그 자리에 .git 생성 ② (별도 회차) 같은 자리 재생성 → 「모두 닫기」 → skip·생존·로그, 되돌리면 닫힘.
  async g1h1() {
    await openPanel()
    for (const [name, mutate] of [['g1-git', (slot) => fs.writeFileSync(path.join(slot, '.git'), 'gitdir: /nonexistent\n')], ['h1-recreate', (slot) => { fs.rmSync(slot, { recursive: true, force: true }); fs.mkdirSync(slot); fs.writeFileSync(path.join(slot, '.git'), 'gitdir: /nonexistent\n') }]]) {
      const slot = slotPath(name)
      fs.mkdirSync(slot, { recursive: true })
      const w = await create(slot, name)
      await seen(Date.now())
      const shown = await waitForBadge(w.workspaceId, 'ownerless', 20_000)
      const mutatedAt = Date.now()
      mutate(slot)
      step(`${name} 자리 변경`, { sinceOwnerlessMs: mutatedAt - shown.at })
      const clickedAt = Date.now()
      await bulkClose()
      const skipped = await waitFor(() => evalJs(root, `document.querySelector('[data-statusbar-resource-error]')?.textContent ?? null`), { timeoutMs: 10_000, label: `${name} skip 안내` })
      await sleep(500)
      const alive = (await workspaces()).includes(w.workspaceId)
      check(`${name} — 주인 없음 표시 뒤 5초 안에 바뀜`, mutatedAt - shown.at < 5000 && clickedAt - shown.at < 5000, { sinceOwnerlessMs: mutatedAt - shown.at, clickSinceOwnerlessMs: clickedAt - shown.at })
      check(`${name} — 「모두 닫기」 가 건너뜀·workspace 생존`, alive, { notice: skipped.value })
      const closeLog = logSince(clickedAt, ['resource.close_orphan_skipped', 'resource.close_orphans'])
      record[`${name}-log`] = closeLog
      check(`${name} — 로그에 not-ownerless skip`, JSON.stringify(closeLog).includes('not-ownerless'), { closeLog })
      await shot(`${name}-skipped`)
      // 양성 대조 — 되돌리면(.git 제거) 닫힌다.
      fs.rmSync(path.join(slot, '.git'), { force: true })
      await waitForBadge(w.workspaceId, 'ownerless', 20_000)
      await bulkClose()
      await waitFor(async () => !(await workspaces()).includes(w.workspaceId), { timeoutMs: 10_000, label: `${name} 되돌린 뒤 닫힘` })
      check(`${name} — 되돌리면 닫힘(양성 대조)`, true)
    }
  },

  // C7ⓐ(기준 빌드) — C1ⓐ 장면 → 공급에 행이 있고 main 카드 밑 「닫힌 탭」 행(695 재현).
  async c7a() {
    const aPath = slotPath('c7a')
    git('worktree', 'add', '-q', '-b', `c7a-${RUN}`, aPath)
    const a = await create(aPath, 'c7a')
    git('worktree', 'remove', '--force', aPath)
    await seen(Date.now())
    await done(a.paneId)
    await cliClose('workspace', a.workspaceId)
    await waitFor(async () => supplyHas(a.paneId), { timeoutMs: 8000, label: '기준 빌드 — 공급에 있음' })
    check('기준 빌드 — 공급에 행이 있음(694 재현)', true, { paneId: a.paneId })
    const rows = await waitFor(async () => { const dom = await domRetained(); return dom.some((item) => item.worktree === REPO) ? dom : null }, { timeoutMs: 8000, label: '기준 빌드 — main 카드 밑 행' })
    check('기준 빌드 — main 카드 밑 「닫힌 탭」 행(695 재현)', true, { dom: rows.value })
    await shot('main-card-row')
  },
}

async function openPanel() {
  const open = await evalJs(root, `!!document.querySelector('[data-statusbar-resource-panel]')`)
  if (!open) {
    const r = await ctl(root, { cmd: 'click', selector: '[data-statusbar-resource]' })
    step('Resource 패널 열기', r)
    await waitFor(() => evalJs(root, `!!document.querySelector('[data-statusbar-resource-panel]')`), { timeoutMs: 8000, label: 'Resource 패널' })
  }
}
const badgeOf = (workspaceId) => evalJs(root, `(() => { const row = document.querySelector('[data-statusbar-resource-orphan="${workspaceId}"]'); if (!row) return null; const b = row.querySelector('[data-statusbar-resource-orphan-owner]'); return { kind: b?.getAttribute('data-statusbar-resource-orphan-owner') ?? null, text: b?.textContent ?? null, tooltip: b?.getAttribute('title') ?? null, rowTooltip: row.querySelector('.statusbar-resource-orphan-line')?.getAttribute('title') ?? null, path: row.querySelector('[data-statusbar-resource-orphan-path]')?.textContent ?? null } })()`)
async function waitForBadge(workspaceId, kind, timeoutMs) {
  const r = await waitFor(async () => { const b = await badgeOf(workspaceId); return b?.kind === kind ? b : null }, { timeoutMs, label: `배지 ${kind} ${workspaceId}` })
  return { ...r.value, at: Date.now() }
}
async function bulkClose() {
  const click = await ctl(root, { cmd: 'click', selector: '[data-statusbar-resource-orphan-close-all]' })
  step('「모두 닫기」 클릭', click)
  if (!click.ok) throw new Error(`모두 닫기 클릭 실패 ${JSON.stringify(click)}`)
  await waitFor(() => evalJs(root, `!!document.querySelector('[data-confirm-close-modal]')`), { timeoutMs: 8000, label: '개수 확인 창' })
  const modal = await evalJs(root, `document.querySelector('[data-confirm-close-modal]')?.textContent?.replace(/\\s+/g, ' ').slice(0, 300) ?? null`)
  step('확인 창', { modal })
  const ok = await ctl(root, { cmd: 'click', selector: '[data-close-confirm-ok]' })
  step('확인', ok)
  if (!ok.ok) throw new Error(`확인 클릭 실패 ${JSON.stringify(ok)}`)
}
async function orphanScene({ expectOwnerless, closeAll }) {
  const slot = slotPath(scene)
  const deadCwd = path.join(slot, 'apps')
  fs.mkdirSync(deadCwd, { recursive: true })
  const sub = path.join(REPO, 'app')
  fs.mkdirSync(sub, { recursive: true })
  const d = await create(deadCwd, `${scene}-dead`)
  const s = await create(sub, `${scene}-sub`)
  await seen(Date.now())
  await openPanel()
  const appeared = (await waitFor(() => badgeOf(d.workspaceId), { timeoutMs: 15_000, label: '카드 밖 줄 뜸' })).value
  const appearedAt = Date.now()
  step('줄 뜸', { appeared })
  await sleep(6500) // ≥3틱(2초 주기) 뒤에 읽는다
  const dead = await badgeOf(d.workspaceId)
  const owned = await badgeOf(s.workspaceId)
  record.badges = { dead, owned, readAfterMs: Date.now() - appearedAt }
  writeJson(path.join(out, `${scene}-badges.json`), record.badges)
  await shot('badges')
  if (expectOwnerless) {
    check('ⓐ 죽은 자리(폴더만) 줄 = 주인 없음', dead?.kind === 'ownerless' && dead?.text === '주인 없음', { dead })
    check('ⓐ 툴팁에 「worktree 아님(폴더만 남음)」', (dead?.tooltip ?? '').includes('worktree 아님(폴더만 남음)') && (dead?.rowTooltip ?? '').includes('worktree 아님(폴더만 남음)'), { dead })
    check('ⓒ main 하위 폴더 줄 = 경로 있음', owned?.kind === 'owned' && owned?.text === '경로 있음', { owned })
  } else {
    check('기준 빌드 — 죽은 자리(폴더만) 줄 = 경로 있음(697 재현)', dead?.kind === 'owned' && dead?.text === '경로 있음', { dead })
  }
  if (!closeAll) return
  await bulkClose()
  await shot('confirm-done')
  await waitFor(async () => !(await workspaces()).includes(d.workspaceId), { timeoutMs: 10_000, label: '죽은 자리 workspace 닫힘' })
  check('「모두 닫기」 → 죽은 자리 줄 닫힘', true)
  check('main 하위 폴더 줄은 남음', (await workspaces()).includes(s.workspaceId))
  await sleep(2500)
  check('패널에서 그 줄 사라짐', (await badgeOf(d.workspaceId)) === null)
}

let exit = 0
try {
  fs.mkdirSync(out, { recursive: true })
  if (!(scene in scenes)) throw new Error(`장면? ${scene}`)
  await scenes[scene]()
} catch (error) {
  record.error = String(error?.stack ?? error)
  exit = 1
}
record.finishedAt = new Date().toISOString()
record.failed = record.checks.filter((item) => !item.ok).map((item) => item.name)
if (record.checks.length === 0 || record.failed.length > 0) exit = 1
record.exit = exit
writeJson(path.join(out, `${scene}.json`), record)
console.log(JSON.stringify({ scene, exit, checks: record.checks.length, failed: record.failed, error: record.error ?? null }))
process.exit(exit)
