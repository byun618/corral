// S9 — cd 로 worktree 경계 넘나들기 → 목록 이중 바인딩(게이트 ① 사용자 확인 버그 ①).
//
// 사용자 실사용 증상: pane 안에서 cd 로 worktree 경계를 넘나들면(worktree → 부모 main → 복귀)
// 한 workspace 가 **두 worktree 행 아래 중복** 표시되고 '열림 2' 로 센다. herdr 진실은 한 worktree
// 에만 열림인데 corral 목록이 옛 바인딩을 안 걷고, 재동기도 '어긋난 것 없음'이라 자가 회복이 안 된다.
//
// # 근본 원인 (raw/claude/fix3/herdr-both-bind-probe.json 로 확인)
//
//   ① herdr 는 pane 이 부모 main 으로 cd 한 순간 open_workspace_id 를 **두 worktree(main + 아까
//      있던 nested wt)에 함께** 단다 — 실측된 과도기 both-bind. (nested worktree 가 main 디렉터리
//      **아래** 있는 corral worktree 레이아웃에서 난다.)
//   ② corral `buildSkeleton` 은 그 순간의 worktree.list 를 그대로 얼린다 — 두 worktree 의
//      `openWorkspaceId` 가 같은 wsId 가 된다. `joinTree` 는 이중 바인딩 가드가 없어 그 wsId 행을
//      **두 worktree 에 다** 붙인다 → 중복 렌더 · 열림 2 (열림 카운트는 App.tsx 가 openWorkspaceId
//      로, 행은 workspace 로 센다 — 그래서 둘 다 봐야 한다).
//   ③ pane 이 복귀해 herdr 가 한쪽으로 자가 회복해도, 그 순간 skeleton 재빌드가 안 걸리면
//      (rebuild 은 `pane_updated`(cwd 변화) push 로 걸린다 — worktree_* push 는 안 온다) 옛
//      골격이 얼어 있고, `resync`/`reconcile` 은 workspace/tab/pane 행만 대조하지 worktree→
//      workspace 바인딩은 안 본다 → 옛 이중 바인딩이 남는다 ('어긋난 것 없음').
//
// # 두 국면
//
//   ▷ 국면 A (자연 크로싱, **문서용 관측** — 게이트 아님): pane 을 진짜로 cd 넘나들게 두고 본다.
//     S2 에서 both-bind → push 로 rebuild → 중복이 렌더된다(과도기). S3 복귀에서 `pane_updated`
//     push 가 오면 rebuild 이 걸려 **자연 회복**한다. 이 회복은 push 가 왔을 때만이라 보장이 없다.
//   ▷ 국면 B (얼린 골격, **게이트**): 사용자가 실제로 겪은 *지속되는* 버그를 결정적으로 재현한다.
//     `pane_updated` push 를 **첫 cd 전에** 끊어(round-trip 상쇄) 골격을 both-bind 로 얼린다.
//     왕복 뒤 store 행은 복귀값(wt-a)이라 깨끗하고 skeleton 만 이중 바인딩으로 남는다 —
//     그러면 회복 경로는 오직 resync 뿐이고, 그게 바인딩을 덮는지가 판정 대상이다.
//
//   게이트(국면 B):
//     ⓐ 중복 렌더 없음 — 골격이 both-bind 로 얼어도 화면 openWorkspaceId 열림 1 · 워크스페이스 행 1.
//     ⓑ 자가 회복 — 복귀 후 resync 1회로 corral 바인딩이 herdr 진실과 일치, 그리고 **골격이 실제로
//        패치**됐다(가드가 가린 게 아니라 — 드리프트 로그의 정확한 패치 main:wF→null 로 증명).
//     ⓒ 드리프트 가시성 — 회복 resync 의 note 가 맨 '어긋난 것 없음'이 아니고, tree.binding_drift
//        로그가 남는다.
//   수정 전(red)은 ⓐⓑⓒ 미달, 수정 후(green)는 통과 — 원자료 쌍이 게이트가 게이트임을 증명한다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { request, sleep, startApp, until, writeRaw } from './s8-lib.mjs'

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'l353s9-'))
  const main = path.join(base, 'fixrepo')
  fs.mkdirSync(main)
  const git = (args, cwd = main) => execFileSync('git', args, { cwd, stdio: 'pipe' })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'x@x'])
  git(['config', 'user.name', 'x'])
  fs.writeFileSync(path.join(main, 'f.txt'), 'hi\n')
  git(['add', '.'])
  git(['commit', '-qm', 'init'])
  const wtA = path.join(main, 'nested', 'wt-a') // ← main 디렉터리 아래 중첩 (실측 both-bind 조건)
  git(['worktree', 'add', '-q', '-b', 'branch-a', wtA])
  return { base, main, wtA, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) }
}

async function herdrBindings(repoRoot) {
  const r = await request('worktree.list', { cwd: repoRoot })
  const items = r.worktrees ?? r.items ?? []
  const wts = items.map((w) => ({ path: w.path, open: w.open_workspace_id ?? null }))
  return { wts, openCount: wts.filter((w) => w.open !== null).length }
}

/** corral 화면 바인딩 — 열림 카운트(openWorkspaceId)와 워크스페이스 행 수(workspace)를 따로 센다. */
function corralBindings(state) {
  const wts = []
  for (const repo of state.repos) for (const wt of repo.worktrees) {
    wts.push({ path: wt.path, open: wt.openWorkspaceId, ws: wt.workspace?.workspaceId ?? null })
  }
  const byOpen = {}
  for (const w of wts) if (w.open) byOpen[w.open] = (byOpen[w.open] ?? 0) + 1
  return {
    wts: wts.map((w) => `${w.path.split('/').slice(-2).join('/')} open=${w.open ?? '-'} ws=${w.ws ?? '-'}`),
    열림: wts.filter((w) => w.open !== null).length, // App.tsx 가 세는 '열림 N'
    행: wts.filter((w) => w.ws !== null).length, // 워크스페이스 행 수 (중복 렌더)
    중복: Object.keys(byOpen).filter((id) => byOpen[id] > 1),
  }
}

async function paneCwd(paneId) {
  return (await request('pane.get', { pane_id: paneId })).pane.foreground_cwd
}
async function waitCwd(paneId, want, timeoutMs = 10000) {
  return until(async () => ((await paneCwd(paneId)) === want ? true : null), { what: `cwd=${want}`, timeoutMs, everyMs: 120 })
}

function logsSince(app, mark, tags) {
  return app.entries().filter((e) => e.at >= mark && tags.includes(e.tag))
}

async function main() {
  const fx = makeFixture()
  const app = await startApp({
    name: 's9-cd-rebind',
    // 재동기가 우리가 부르기 전에 저절로 돌면 회복 근거가 흐려진다 — 크게 밀고 우리가 명시적으로 부른다.
    env: { CORRAL_RESYNC_MS: '3600000' },
  })
  const out = { at: new Date().toISOString(), buildCheck: app.buildCheck, fixtureMain: fx.main, fixtureWtA: fx.wtA, 국면A: [], 국면B: [] }

  try {
    await app.addRepo(fx.main)
    await until(async () => (await app.state()).repos.some((r) => r.root === fx.main), { what: '레포 등록' })

    const ws = await request('workspace.create', { label: 's9', cwd: fx.wtA })
    const wsId = ws.workspace?.workspace_id ?? ws.workspace_id
    await sleep(800)
    const paneId = (await request('pane.list', {})).panes.find((p) => p.workspace_id === wsId)?.pane_id
    out.workspaceId = wsId
    out.paneId = paneId

    await app.rebuildTree()
    await until(async () => corralBindings(await app.state()).열림 === 1, { what: 'wt-a 초기 바인딩' })

    async function snap(bucket, label, { rebuild = false, resync = false } = {}) {
      const mark = Date.now()
      let resyncReply = null
      if (rebuild) await app.rebuildTree()
      if (resync) resyncReply = await app.resync('s9-probe')
      await sleep(120)
      const [state, herdr] = await Promise.all([app.state(), herdrBindings(fx.main)])
      const corral = corralBindings(state)
      const row = {
        label,
        forced: { rebuild, resync },
        paneCwd: await paneCwd(paneId),
        herdr,
        corral,
        일치: herdr.openCount === corral.열림 && corral.중복.length === 0,
        ...(resync
          ? {
              resyncNote: resyncReply?.note ?? null,
              driftLogs: logsSince(app, mark, ['tree.binding_drift']).map((e) => ({ note: e.note ?? null, drift: e.drift ?? null })),
            }
          : {}),
      }
      out[bucket].push(row)
      console.log(`[${label}] herdr열림 ${herdr.openCount} · corral열림 ${corral.열림} · 행 ${corral.행} · 중복 ${JSON.stringify(corral.중복)} · 일치 ${row.일치}${resync ? ` · note "${row.resyncNote}" · 드리프트로그 ${row.driftLogs.length}` : ''}`)
      return row
    }

    // ── 국면 A: 자연 크로싱 (문서용 관측) ──────────────────────────────────────
    await snap('국면A', 'A1 초기 (cwd=wt-a)')
    await request('pane.send_text', { pane_id: paneId, text: `cd ${fx.main}\n` })
    await waitCwd(paneId, fx.main)
    await sleep(500)
    await snap('국면A', 'A2 cd 부모 main (자연)')
    await snap('국면A', 'A2 cd 부모 main (강제 rebuild)', { rebuild: true })
    await request('pane.send_text', { pane_id: paneId, text: `cd ${fx.wtA}\n` })
    await waitCwd(paneId, fx.wtA)
    await sleep(500)
    await snap('국면A', 'A3 복귀 (자연 — push 로 회복될 수 있음)')
    await app.rebuildTree() // 국면 B 전에 골격을 깨끗한 상태로 되돌린다
    await until(async () => corralBindings(await app.state()).열림 === 1, { what: '국면B 전 초기화' })

    // ── 국면 B: 얼린 골격 (게이트) — round-trip 상쇄로 골격만 이중 바인딩 ────────
    // 1) 첫 cd 전에 pane_updated push 를 끊는다 → store 행이 얼어 왕복 뒤 복귀값과 다시 맞는다.
    await app.dropPush(true, ['pane_updated'])
    // 2) 부모 main 으로 cd → herdr both-bind 까지 본 뒤 강제 rebuild 로 골격을 얼린다.
    await request('pane.send_text', { pane_id: paneId, text: `cd ${fx.main}\n` })
    await until(async () => ((await herdrBindings(fx.main)).openCount === 2 ? true : null), { what: 'herdr both-bind', timeoutMs: 10000, everyMs: 120 })
    const bFrozen = await snap('국면B', 'B1 both-bind 순간 강제 rebuild (골격 얼림)', { rebuild: true }) // ⓐ 게이트
    // 3) wt-a 로 복귀 → herdr 가 child-only 로 자가 회복할 때까지 본다 (골격은 얼어 있음).
    await request('pane.send_text', { pane_id: paneId, text: `cd ${fx.wtA}\n` })
    await until(async () => ((await herdrBindings(fx.main)).openCount === 1 ? true : null), { what: 'herdr child-only 회복', timeoutMs: 10000, everyMs: 120 })
    // pane_updated 는 **계속 끊어 둔다** — 사용자 버그는 복귀 뒤 아무 rebuild 도 안 걸리는 경우다.
    //   store pane 행은 시작부터 wt-a 로 얼어 있어(왕복 상쇄) 복귀 현실값과 같다 → reconcile 은
    //   행 드리프트를 못 찾는다. skeleton 만 이중 바인딩으로 남고, 회복 경로는 오직 resync 다.
    //   (resync 는 자기 session.snapshot 요청이라 push 끊김과 무관하게 돈다.)
    await sleep(200)
    const bBefore = await snap('국면B', 'B2 복귀 (resync 전 — 골격 얼림 유지)')
    // 5) resync 1회 — 바인딩을 걷나(자가 회복 + 드리프트 가시성).
    const driftMark = Date.now()
    const bAfter = await snap('국면B', 'B3 복귀 (resync 1회)', { resync: true })
    // ⓑ 보조 오라클: 골격이 dirty 인 동안 가드는 emit 마다 tree.double_bind 를 남긴다(tree.unregistered 선례).
    //   회복 resync 뒤 emit 에서 사라지면 = 골격이 실제로 패치됐다(가드 마스킹이 아니라).
    out.doubleBind = {
      회복전: logsSince(app, driftMark - 3000, ['tree.double_bind']).filter((e) => e.at < driftMark).length,
      회복후: logsSince(app, driftMark, ['tree.double_bind']).length,
    }

    out.게이트 = {
      'ⓐ 중복 렌더 없음 (골격 both-bind 얼림)': bFrozen.corral.열림 === 1 && bFrozen.corral.행 === 1 && bFrozen.corral.중복.length === 0,
      'ⓑ 자가 회복 (resync 1회로 일치 + 골격 패치)':
        bAfter.일치 && bAfter.corral.열림 === 1 && bAfter.driftLogs.length > 0,
      'ⓒ 드리프트 가시성 (note ≠ 맨 어긋난 것 없음 + 드리프트 로그)':
        bAfter.driftLogs.length > 0 && bAfter.resyncNote !== null && bAfter.resyncNote !== '어긋난 것 없음',
    }
    out.판정 = Object.values(out.게이트).every(Boolean) ? '통과' : '미달'
    console.log('\n게이트:', JSON.stringify(out.게이트, null, 2))
    console.log('doubleBind 로그(회복전/후):', JSON.stringify(out.doubleBind), '\n판정:', out.판정)

    await app.dropPush(false) // push 재개 — 정리 전 원상복구
    await request('workspace.close', { workspace_id: wsId }).catch(() => {})
    await sleep(300)
  } finally {
    await app.stop()
    try {
      execFileSync('git', ['worktree', 'remove', '--force', fx.wtA], { cwd: fx.main, stdio: 'pipe' })
    } catch {
      /* fixture 통째로 지운다 */
    }
    fx.cleanup()
  }

  writeRaw(process.env.S9_OUT ?? 's9-cd-rebind.json', out)
  process.exit(out.판정 === '통과' ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
