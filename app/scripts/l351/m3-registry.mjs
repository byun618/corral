// M3 — N3(레포 레지스트리: 추가되고, 재시작을 견딘다).
//
// **UI 조작만으로** 넣는다: 입력칸을 눌러 포커스 → 글자를 쳐서 경로를 넣고 → 추가 버튼을 누른다.
// 세 걸음 전부 관문 ⑤ 를 지난다 — `elementFromPoint` 로 그 좌표의 맨 위가 그 요소인지 확인한
// 뒤 **좌표로** 마우스를 보낸다. `el.click()` 은 쓰지 않는다.
//
// 그리고 앱을 **완전히 죽였다가** 같은 레지스트리 경로로 다시 띄워 목록이 남아 있는지 본다.
// 저장 파일의 내용도 그대로 싣는다 — corral 이 소유하는 것이 **레포 루트뿐**임을 보이려면
// 파일에 무엇이 들었는지가 근거다.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPO_DIR, clickLog, clickWhenVisible, sleep, startApp, tidySession, until, writeRaw } from './lib.mjs'

const SECOND_REPO = process.env.LIFE351_SECOND_REPO ?? path.join(os.homedir(), 'repos/byun618/home-coffing')
// 일부러 **worktree 안쪽 깊은 경로**를 준다 (이 워크트리 자체가 링크된 worktree 다) —
// 레포 루트(`.../byun618/corral`)로 접히는지까지 한 번에 본다.
const INSIDE_WORKTREE = path.join(REPO_DIR, 'app/src/shared')
/** 접혔을 때 나와야 할 값. worktree 의 `.git` 파일이 가리키는 주 체크아웃이다. */
const EXPECTED_ROOT = path.resolve(REPO_DIR, '../../..')

const registryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l351-reg-')), 'repos.json')

await tidySession()

async function addByUi(app, text) {
  // ① 입력칸을 눌러 포커스를 준다 (클릭도 히트테스트를 지난다).
  const focus = await clickWhenVisible(app, '[data-repo-input]')
  // ② 남아 있던 글자를 **키로** 지운다 (⌘A → Backspace). 상태를 프로그램으로 비우지 않는다.
  await app.key('a', ['meta'])
  await app.key('Backspace')
  await sleep(80)
  const 지운뒤 = (await app.query('[data-repo-input]')).found
  // ③ 경로를 친다.
  const typed = await app.type(text)
  await sleep(150)
  const 입력칸 = (await app.query('[data-repo-input]')).found
  // ④ 추가 버튼.
  const click = await clickWhenVisible(app, '[data-add-repo]')
  await sleep(500)
  const notice = (await app.query('[data-add-notice]')).found
  return { typed: typed.typed, 지운뒤, 입력칸, 알림: notice, 클릭: [focus.record, click.record] }
}

const out = { at: new Date().toISOString(), registryFile, 걸음: [] }

// ── 1회차: 빈 레지스트리로 띄워 UI 로 둘을 넣는다 ──────────────────────────────
const first = await startApp({ name: 'n3-add', registryFile })
await sleep(1000)
out.걸음.push({ 단계: '기동', 레지스트리: (await first.state()).registry })
out['접힘 기대값'] = { 준값: INSIDE_WORKTREE, 기대루트: EXPECTED_ROOT }
out.첫화면 = (await first.shot('n3-empty')).file

const addA = await addByUi(first, INSIDE_WORKTREE)
const addB = await addByUi(first, SECOND_REPO)
await sleep(800)
const afterAdd = await first.state()
out.추가 = {
  'worktree 안쪽 경로로 넣음': { 준값: INSIDE_WORKTREE, ...addA },
  '두 번째 레포': { 준값: SECOND_REPO, ...addB },
  레지스트리: afterAdd.registry,
  '화면의 레포': afterAdd.repos.map((repo) => repo.root),
}
out.추가후화면 = (await first.shot('n3-added')).file
out['저장된 파일'] = {
  경로: registryFile,
  존재: fs.existsSync(registryFile),
  내용: fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : null,
}
await first.stop()

// ── 앱이 정말 죽었나 (OS 에게 묻는다 — "종료했다" 는 우리 말은 근거가 아니다) ──────
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
await sleep(500)
out['완전 종료 확인'] = { pid: first.child.pid, exitCode: first.child.exitCode, 살아있나: alive(first.child.pid) }

// ── 2회차: 같은 레지스트리 경로로 새 프로세스를 띄운다 ───────────────────────────
const second = await startApp({ name: 'n3-restart', registryFile })
const restored = await until(async () => (await second.state()).repos.length >= 2, { what: '재기동 뒤 목록', timeoutMs: 15000 })
await sleep(600)
const afterRestart = await second.state()
out.재기동 = {
  pid: second.child.pid,
  '다른 프로세스인가': second.child.pid !== first.child.pid,
  복구ms: restored.ms,
  레지스트리: afterRestart.registry,
  '화면의 레포': afterRestart.repos.map((repo) => ({ root: repo.root, name: repo.name, worktrees: repo.worktrees.length })),
}
out.재기동화면 = (await second.shot('n3-after-restart')).file
await second.stop()

const rootsAfter = out.재기동.레지스트리.roots
out.판정 = {
  'UI 조작만으로 추가됐나': afterAdd.registry.roots.length === 2,
  'worktree 안쪽 경로가 레포 루트로 접혔나': rootsAfter.includes(EXPECTED_ROOT),
  '두 레포 모두 남았나': rootsAfter.length === 2 && rootsAfter.includes(SECOND_REPO),
  '재기동 뒤에도 목록에 있나': out.재기동['화면의 레포'].length === 2,
  '다른 프로세스였나': out.재기동['다른 프로세스인가'] && !out['완전 종료 확인'].살아있나,
  '저장한 것이 레포 루트뿐인가':
    JSON.stringify(Object.keys(out['저장된 파일'].내용 ?? {}).sort()) === JSON.stringify(['repos', 'version']) &&
    (out['저장된 파일'].내용?.repos ?? []).every((item) => typeof item === 'string'),
}
out.클릭증거 = clickLog()
console.log(JSON.stringify(out.판정, null, 2))
writeRaw('n3-registry.json', out)
