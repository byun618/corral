// C3 — 레포 접기/펼치기 + 앱 재기동 후 접힘 상태 유지.
// [data-repo-toggle] 클릭으로 레포를 접고([data-worktree] 가 DOM 에서 사라짐을 `query` 로
// 확인), ui-prefs.json(`window.corral.getUiPrefs`)에 반영됐는지 읽은 뒤 재기동해 유지를 본다.
import fs from 'node:fs'
import path from 'node:path'
import { makeScratchRepo, RAW_DIR, RAW_SUBDIR, startApp, until, writeRaw } from './lib.mjs'

const uiPrefsFile = path.join(RAW_DIR, RAW_SUBDIR, '_runs', '03-c3-collapse-ui-prefs.json')

async function main() {
  fs.mkdirSync(path.dirname(uiPrefsFile), { recursive: true })
  fs.rmSync(uiPrefsFile, { force: true })

  const repo = makeScratchRepo('c3-collapse')

  const app = await startApp({ name: '03-c3-collapse', env: { CORRAL_UI_PREFS: uiPrefsFile } })
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, {
    timeoutMs: 8000,
    what: 'repo row mounted',
  })

  const worktreeBefore = await app.query(`[data-worktree]`)
  console.log('worktree count before collapse', worktreeBefore.found.length)

  const click = await app.click(`[data-repo-toggle="${repo.root}"]`)
  console.log('toggle click hit', click.hit)

  const worktreeAfterCollapse = await (async () => {
    const r = await until(async () => (await app.query(`[data-worktree]`)).found.length === 0, {
      timeoutMs: 4000,
      what: 'worktree hidden after collapse',
    })
    return r.ok
  })()
  console.log('worktree hidden after collapse', worktreeAfterCollapse)

  const caret = await app.query(`[data-repo-caret="${repo.root}"]`)
  console.log('caret text after collapse', caret.found[0])

  const prefsAfterCollapse = await app.send({
    cmd: 'eval',
    code: 'window.corral.getUiPrefs().then((p) => p.collapsedRepos)',
  })
  console.log('ui-prefs collapsedRepos after collapse', prefsAfterCollapse.result)

  await app.stop()

  const app2 = await startApp({ name: '03-c3-collapse-restart', env: { CORRAL_UI_PREFS: uiPrefsFile } })
  await app2.addRepo(repo.root)
  await until(async () => (await app2.query(`[data-repo="${repo.root}"]`)).found.length > 0, {
    timeoutMs: 8000,
    what: 'repo row mounted (restart)',
  })
  // 접힘은 렌더 즉시가 아니라 ui-prefs IPC 응답(비동기) 이후 반영된다 — 폴링으로 기다린다.
  const worktreeAfterRestart = await until(async () => (await app2.query(`[data-worktree]`)).found.length === 0, {
    timeoutMs: 4000,
    what: 'worktree still hidden after restart',
  })
  console.log('worktree hidden after restart', worktreeAfterRestart.ok)
  const prefsAfterRestart = await app2.send({
    cmd: 'eval',
    code: 'window.corral.getUiPrefs().then((p) => p.collapsedRepos)',
  })
  console.log('ui-prefs collapsedRepos after restart', prefsAfterRestart.result)
  await app2.stop()

  const result = {
    worktreeCountBeforeCollapse: worktreeBefore.found.length,
    toggleClickHit: click.hit,
    worktreeHiddenAfterCollapse: worktreeAfterCollapse,
    caretAfterCollapse: caret.found[0],
    collapsedReposAfterCollapse: prefsAfterCollapse.result,
    worktreeHiddenAfterRestart: worktreeAfterRestart.ok,
    collapsedReposAfterRestart: prefsAfterRestart.result,
    persisted: worktreeAfterCollapse === true && worktreeAfterRestart.ok === true,
    uiPrefsFileOnDisk: fs.readFileSync(uiPrefsFile, 'utf8'),
  }
  console.log(result)
  writeRaw('c3-collapse.json', result)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
