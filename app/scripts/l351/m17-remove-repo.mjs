// M17 — 레포 제거 제스처 (게이트 ① 3번째 지시, 수정 6회차).
//
// 네 갈래를 잰다: ⓐ 확인 창이 **무엇을 말하나** ⓑ 취소·X·ESC 는 아무것도 안 뺀다
// ⓒ 「제거」는 **그 루트 하나만** 뺀다 ⓓ 재기동해도 안 돌아온다.
//
// 누르는 것은 전부 **화면의 진짜 버튼**이다 (관문 ⑤ — `elementFromPoint` 로 그 좌표의 맨 위가
// 그 요소인지 확인한 뒤 좌표로 마우스를 보낸다). `el.click()` 은 쓰지 않는다.
//
// 등록은 수정 5회차의 제스처를 그대로 쓴다 — 「레포 추가」 → 모달 → 「폴더 찾아보기」.
// 그 한 걸음(네이티브 다이얼로그가 돌려주는 경로)만 스텁이고 나머지는 진짜다.
//
// **제3 오라클이 둘이다.** 저장 파일은 하네스가 직접 읽고(앱 상태가 아니라 디스크),
// herdr 는 하네스 자기 커넥션으로 `workspace.list` 를 떠서 **제거 전후가 같은지** 본다 —
// 확인 창이 "herdr 세션도 건드리지 않는다" 고 적어 두었으니 그 말이 참인지는 herdr 에게 묻는다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clickLog, clickWhenVisible, request, sleep, startApp, tidySession, until, writeRaw } from './lib.mjs'

/** macOS 의 `/var` → `/private/var` 심링크 때문에 하네스도 앱과 같은 자리에서 비교해야 한다. */
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l351-rm-')))
const 등록폴더 = path.join(TMP, 'repos')
const REPO_A = path.join(등록폴더, 'alpha')
const REPO_B = path.join(등록폴더, 'bravo')

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['-C', dir, 'init', '-q'])
  fs.writeFileSync(path.join(dir, 'README.md'), '# ' + path.basename(dir) + '\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, '-c', 'user.email=l351@local', '-c', 'user.name=l351', 'commit', '-qm', 'init'])
}
makeRepo(REPO_A)
makeRepo(REPO_B)

const registryFile = path.join(TMP, 'repos.json')

/** 디스크에 실제로 저장된 것 — **앱이 말하는 상태가 아니라** 파일을 직접 읽는다. */
const 저장된파일 = () => (fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : null)
/** herdr 쪽 오라클 — 하네스 자기 커넥션. */
const herdr목록 = async () => (await request('workspace.list', {})).workspaces.map((item) => item.workspace_id).sort()

await tidySession()

const out = { at: new Date().toISOString(), TMP, registryFile, 만든레포: [REPO_A, REPO_B] }

const app = await startApp({ name: 'g-remove-repo', registryFile })
await sleep(900)

// ── 준비: 수정 5회차 제스처로 둘을 한 번에 등록한다 (부모 폴더 → 자식 스캔) ──────────
await app.browseStub(등록폴더)
await clickWhenVisible(app, '[data-add-repo]')
await sleep(200)
await clickWhenVisible(app, '[data-browse-folder]')
await until(async () => (await app.state()).repos.length === 2, { what: '레포 둘 등록', timeoutMs: 15000 })
await sleep(600)
out.준비 = {
  레지스트리: (await app.state()).registry.roots,
  저장파일: 저장된파일(),
  'herdr workspace (제거 전)': await herdr목록(),
}
out.등록직후샷 = (await app.shot('registered-two')).file

/** 제거 버튼을 눌러 확인 창을 연다. */
async function 확인창을연다(root) {
  await clickWhenVisible(app, `[data-remove-repo="${root}"]`)
  await sleep(250)
  return {
    제목: (await app.query('[data-confirm-title]')).found,
    이름: (await app.query('[data-confirm-name]')).found,
    루트: (await app.query('[data-confirm-root]')).found,
    문구: (await app.query('[data-confirm-note]')).found,
    창수: (await app.query('[data-confirm-remove]')).found.length,
  }
}

// ── ⓐ 확인 창이 무엇을 말하나 ────────────────────────────────────────────────
const 확인 = await 확인창을연다(REPO_A)
out['ⓐ 확인 창'] = 확인
out.확인창샷 = (await app.shot('confirm-open')).file
const 기대문구 = '제거는 corral 목록에서만 빠진다 — 디스크의 폴더도, herdr 세션도 건드리지 않는다.'

// ── ⓑ 취소 세 갈래 — 취소 버튼 · X · ESC. 셋 다 아무것도 안 뺀다 ─────────────────
const 안뺀다 = []
// ⓑ-1 「취소」 버튼 (확인 창은 이미 떠 있다)
await clickWhenVisible(app, '[data-confirm-cancel]')
await sleep(300)
안뺀다.push({
  길: '취소 버튼',
  남은창: (await app.query('[data-confirm-remove]')).found.length,
  레지스트리: (await app.state()).registry.roots.length,
  저장파일: (저장된파일()?.repos ?? []).length,
})
// ⓑ-2 닫기 X
await 확인창을연다(REPO_A)
await clickWhenVisible(app, '[data-confirm-close]')
await sleep(300)
안뺀다.push({
  길: '닫기 X',
  남은창: (await app.query('[data-confirm-remove]')).found.length,
  레지스트리: (await app.state()).registry.roots.length,
  저장파일: (저장된파일()?.repos ?? []).length,
})
// ⓑ-3 ESC (키는 창에 보낸다 — 좌표 클릭이 아니라 키 입력이다)
await 확인창을연다(REPO_A)
await app.key('Escape')
await sleep(300)
안뺀다.push({
  길: 'ESC',
  남은창: (await app.query('[data-confirm-remove]')).found.length,
  레지스트리: (await app.state()).registry.roots.length,
  저장파일: (저장된파일()?.repos ?? []).length,
})
out['ⓑ 안 뺀 세 갈래'] = 안뺀다

// ── ⓒ 「제거」 — A 만 빠진다 ──────────────────────────────────────────────────
await 확인창을연다(REPO_A)
const 누른시각 = Date.now()
await clickWhenVisible(app, '[data-confirm-ok]')
// "즉시 갱신" 을 시간으로 잰다 — 화면 목록에서 A 줄이 사라지기까지.
const 사라짐 = await until(async () => (await app.query(`[data-repo="${REPO_A}"]`)).found.length === 0, {
  what: 'A 줄이 목록에서 사라짐',
  timeoutMs: 10000,
  everyMs: 20,
})
await sleep(500)
const 제거후 = await app.state()
out['ⓒ 제거'] = {
  뺀것: REPO_A,
  '목록에서 사라지기까지ms': 사라짐.ms,
  '누른 시각부터ms': Date.now() - 누른시각,
  '남은 창': (await app.query('[data-confirm-remove]')).found.length,
  'DOM 의 A 줄': (await app.query(`[data-repo="${REPO_A}"]`)).found.length,
  'DOM 의 B 줄': (await app.query(`[data-repo="${REPO_B}"]`)).found.length,
  레지스트리: 제거후.registry.roots,
  '화면의 레포': 제거후.repos.map((repo) => repo.root),
  저장파일: 저장된파일(),
  'herdr workspace (제거 후)': await herdr목록(),
  'A 폴더가 디스크에 그대로 있나': fs.existsSync(REPO_A),
  'A 가 아직 git 레포인가': fs.existsSync(path.join(REPO_A, '.git')),
}
out.제거후샷 = (await app.shot('after-remove')).file

const 로그 = app.entries().filter((entry) => entry.tag === 'registry.removed')
out['registry.removed 로그'] = 로그.map((entry) => ({ root: entry.root, roots: entry.roots }))
await app.stop()
await sleep(500)

// ── ⓓ 재기동 — 같은 레지스트리 파일로 새 프로세스 ───────────────────────────────
const second = await startApp({ name: 'g-remove-restart', registryFile })
const 복구 = await until(async () => (await second.state()).repos.length >= 1, { what: '재기동 뒤 목록', timeoutMs: 15000 })
await sleep(600)
const 재기동후 = await second.state()
out['ⓓ 재기동'] = {
  '다른 프로세스인가': second.child.pid !== app.child.pid,
  복구ms: 복구.ms,
  레지스트리: 재기동후.registry.roots,
  '화면의 레포': 재기동후.repos.map((repo) => repo.root),
  'DOM 의 A 줄': (await second.query(`[data-repo="${REPO_A}"]`)).found.length,
  'DOM 의 B 줄': (await second.query(`[data-repo="${REPO_B}"]`)).found.length,
}
out.재기동샷 = (await second.shot('after-restart')).file
await second.stop()

const 제거 = out['ⓒ 제거']
out.판정 = {
  'ⓐ 확인 창이 떴나': 확인.창수 === 1 && 확인.제목[0] === '레포 제거',
  'ⓐ 문구에 레포 이름이 있나': 확인.이름[0] === path.basename(REPO_A),
  'ⓐ 어느 레포인지 경로까지 말하나': 확인.루트[0] === REPO_A,
  'ⓐ 안 하는 일을 적었나 (문구 그대로)': 확인.문구[0] === 기대문구,
  'ⓑ 취소 버튼은 아무것도 안 뺐나': 안뺀다[0].남은창 === 0 && 안뺀다[0].레지스트리 === 2 && 안뺀다[0].저장파일 === 2,
  'ⓑ 닫기 X 도 안 뺐나': 안뺀다[1].남은창 === 0 && 안뺀다[1].레지스트리 === 2 && 안뺀다[1].저장파일 === 2,
  'ⓑ ESC 도 안 뺐나': 안뺀다[2].남은창 === 0 && 안뺀다[2].레지스트리 === 2 && 안뺀다[2].저장파일 === 2,
  'ⓒ 목록에서 즉시 사라졌나 (1초 안)': 사라짐.ok && 사라짐.ms < 1000,
  'ⓒ 확인 창이 닫혔나': 제거['남은 창'] === 0,
  'ⓒ 그 루트만 빠졌나 (B 는 그대로)':
    제거.레지스트리.length === 1 && 제거.레지스트리[0] === REPO_B && 제거['DOM 의 B 줄'] === 1,
  'ⓒ 저장 파일도 B 하나뿐인가':
    JSON.stringify(제거.저장파일) === JSON.stringify({ version: 1, repos: [REPO_B] }),
  'ⓒ 디스크는 안 건드렸나 (A 폴더·.git 그대로)': 제거['A 폴더가 디스크에 그대로 있나'] && 제거['A 가 아직 git 레포인가'],
  'ⓒ herdr 는 안 건드렸나 (workspace 목록 전후 동일)':
    JSON.stringify(out.준비['herdr workspace (제거 전)']) === JSON.stringify(제거['herdr workspace (제거 후)']),
  'ⓓ 재기동해도 A 가 안 돌아왔나':
    out['ⓓ 재기동'].레지스트리.length === 1 &&
    out['ⓓ 재기동'].레지스트리[0] === REPO_B &&
    out['ⓓ 재기동']['DOM 의 A 줄'] === 0 &&
    out['ⓓ 재기동']['DOM 의 B 줄'] === 1,
  'ⓓ 다른 프로세스였나': out['ⓓ 재기동']['다른 프로세스인가'],
}
out.클릭증거 = clickLog()
console.log(JSON.stringify(out.판정, null, 2))
writeRaw('remove-repo.json', out)
