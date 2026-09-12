// M16 — 레포 추가 제스처 (게이트 ① 2번째 지시, 2026-09-12).
//
// 재는 것은 **모달 → 네이티브 다이얼로그 위임 → 등록** 한 줄기가 실제로 이어지는가다.
// 다섯 갈래를 본다: 열고 닫기(ESC·X) · 레포 폴더 직접 · 레포가 많은 폴더(1단계 훑기) ·
// 레포가 없는 폴더 · 취소.
//
// # 무엇이 스텁이고 무엇이 진짜인가
//
// macOS 폴더 선택기는 **OS 가 그리는 창**이다. `sendInputEvent` 는 BrowserWindow 안에만 닿으므로
// 하네스가 그 창을 누를 길이 없다. 그래서 "사용자가 이 폴더를 골랐다" 는 **한 줄만** 제어
// 채널로 갈아끼운다 (`browse-stub` → main 의 `dialogStub`). 그 앞뒤는 전부 진짜다:
// 버튼을 좌표로 누르고(관문 ⑤), preload 를 지나 `corral:browseForRepos` 로 가고, main 이
// `git rev-parse` 로 판별하고, `registry.add()` 가 정규화·중복을 처리하고, 상태가 화면에 온다.
// 어느 줄이 스텁이었는지는 앱 로그 `browse.dialog {stub:true}` 가 한 줄씩 말한다.
//
// # 오라클
//
// herdr 는 이 측정에 안 나온다 — 레지스트리는 corral 이 소유하는 상태다. 대조 상대는
// **디스크의 레지스트리 파일**과, 하네스가 자기 프로세스로 돌린 `git rev-parse --git-dir` 이다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clickLog, clickWhenVisible, sleep, startApp, tidySession, writeRaw } from './lib.mjs'

/**
 * **realpath 로 접어 둔다.** macOS 의 `/var` 는 `/private/var` 의 심링크고, 앱은 경로를
 * `canonicalPath` 로 접어 저장한다 (L8). 하네스가 안 접은 문자열로 대조하면 제품이 맞게
 * 동작해도 어긋난 것으로 읽힌다 — 첫 실행에서 실제로 그렇게 나왔다.
 */
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l351-browse-')))

/** 하네스 쪽 오라클 — 앱이 쓰는 것과 **다른 프로세스**로 같은 질문을 한다. */
function isRepo(dir) {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function 레포만들기(dir) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(dir, 'README.md'), '# l351\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init', '--no-gpg-sign'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'l351', GIT_AUTHOR_EMAIL: 'l351@local', GIT_COMMITTER_NAME: 'l351', GIT_COMMITTER_EMAIL: 'l351@local' },
  })
  return dir
}

// 홀로 선 레포 하나.
const 홀로레포 = 레포만들기(path.join(TMP, 'solo'))
// 레포가 많은 폴더 — 자식 둘은 레포, 하나는 아니다. **그 폴더 자체는 레포가 아니다.**
const 많은폴더 = path.join(TMP, 'many')
const 자식A = 레포만들기(path.join(많은폴더, 'alpha'))
const 자식B = 레포만들기(path.join(많은폴더, 'beta'))
const 자식C = path.join(많은폴더, 'not-a-repo')
fs.mkdirSync(자식C, { recursive: true })
fs.writeFileSync(path.join(자식C, 'note.txt'), 'git 아님\n')
// 레포가 하나도 없는 폴더.
const 빈폴더 = path.join(TMP, 'empty')
fs.mkdirSync(path.join(빈폴더, 'just-a-folder'), { recursive: true })

const registryFile = path.join(TMP, 'repos.json')
await tidySession()
const app = await startApp({ name: 'g-add-repo-modal', registryFile })
await sleep(1000)

const out = {
  at: new Date().toISOString(),
  질문: '「레포 추가」 → 모달 → 「폴더 찾아보기」 → main 의 네이티브 다이얼로그 위임 → 등록이 이어지는가',
  '스텁이 대신한 걸음': {
    무엇: '`dialog.showOpenDialog` 가 돌려주는 경로 한 줄',
    왜: 'macOS 가 그리는 창이라 sendInputEvent 가 안 닿는다 — 지시 (5) 가 허용한 스텁 주입이다',
    '진짜로 지난 것': '좌표 클릭(관문 ⑤) → preload → corral:browseForRepos → git rev-parse 판별 → registry.add() → 상태·화면',
  },
  준비: {
    홀로레포,
    많은폴더: { 경로: 많은폴더, 자식: [자식A, 자식B, 자식C], '폴더 자체가 레포인가(오라클)': isRepo(많은폴더) },
    빈폴더,
    '오라클 판정': { [자식A]: isRepo(자식A), [자식B]: isRepo(자식B), [자식C]: isRepo(자식C) },
  },
  갈래: {},
}

/** 모달을 연다. */
async function 연다() {
  const click = await clickWhenVisible(app, '[data-add-repo]')
  await sleep(200)
  return {
    클릭: click.record,
    제목: (await app.query('[data-modal-title]')).found,
    항목: (await app.query('[data-browse-folder]')).found,
    떠있나: (await app.query('[data-add-repo-modal]')).found.length === 1,
  }
}

/** 스텁을 세우고 「폴더 찾아보기」를 누른다. */
async function 찾아본다(target) {
  await app.browseStub(target)
  const click = await clickWhenVisible(app, '[data-browse-folder]')
  await sleep(900)
  return {
    클릭: click.record,
    모달남았나: (await app.query('[data-add-repo-modal]')).found.length === 1,
    모달안내: (await app.query('[data-browse-result]')).found,
    알림: (await app.query('[data-add-notice]')).found,
    레지스트리: (await app.state()).registry.roots,
  }
}

// ── ⓐ 열고 닫기 (ESC · X) ─────────────────────────────────────────────────────
const 열기1 = await 연다()
const shot모달 = await app.shot('modal-open')
await app.key('Escape')
await sleep(300)
const esc뒤 = (await app.query('[data-add-repo-modal]')).found.length
const 열기2 = await 연다()
const x클릭 = await clickWhenVisible(app, '[data-modal-close]')
await sleep(300)
const x뒤 = (await app.query('[data-add-repo-modal]')).found.length
out.갈래['ⓐ 열고 닫기'] = { 열기1, shot: shot모달.file, 'ESC 뒤 모달 수': esc뒤, 열기2, 'X 클릭': x클릭.record, 'X 뒤 모달 수': x뒤 }

// ── ⓑ 취소 (다이얼로그를 그냥 닫았다) ─────────────────────────────────────────
await 연다()
const 취소 = await 찾아본다('취소')
out.갈래['ⓑ 취소'] = 취소

// ── ⓒ 레포 폴더를 직접 골랐다 ────────────────────────────────────────────────
const 직접 = await 찾아본다(홀로레포)
out.갈래['ⓒ 레포 직접'] = 직접

// ── ⓓ 레포가 많은 폴더 (1단계 자식 훑기) ────────────────────────────────────
const 열기3 = await 연다()
const 훑기 = await 찾아본다(많은폴더)
const shot등록 = await app.shot('after-scan')
out.갈래['ⓓ 레포 많은 폴더'] = { 열기: 열기3.떠있나, ...훑기, shot: shot등록.file }

// ── ⓔ 레포가 없는 폴더 ──────────────────────────────────────────────────────
const 열기4 = await 연다()
const 없음 = await 찾아본다(빈폴더)
const shot없음 = await app.shot('no-repo-found')
out.갈래['ⓔ 레포 없는 폴더'] = { 열기: 열기4.떠있나, ...없음, shot: shot없음.file }
await app.key('Escape')

await sleep(400)
const 최종 = await app.state()
const 파일 = fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')) : null
out.최종 = {
  '화면의 레포': 최종.repos.map((repo) => repo.root).sort(),
  '레지스트리 파일': 파일,
  '파일의 레포가 전부 진짜 git 레포인가(오라클)': (파일?.repos ?? []).map((root) => ({ root, repo: isRepo(root) })),
}
out['browse 로그'] = app
  .entries()
  .filter((entry) => typeof entry.tag === 'string' && entry.tag.startsWith('browse.'))
  .map((entry) => ({ tag: entry.tag, ...entry, ts: undefined, at: undefined }))

const 기대 = [홀로레포, 자식A, 자식B].sort()
out.판정 = {
  'ⓐ 버튼을 누르면 모달이 뜬다 (제목·항목 각 1개)':
    열기1.떠있나 && 열기1.제목.length === 1 && 열기1.항목.length === 1 && 열기1.제목[0] === '레포 추가',
  'ⓐ ESC 로 닫힌다': esc뒤 === 0,
  'ⓐ X 로 닫힌다': x뒤 === 0,
  'ⓑ 취소는 아무것도 등록하지 않고 아무 말도 안 한다':
    취소.레지스트리.length === 0 && 취소.모달안내.length === 0 && 취소.알림.length === 0 && 취소.모달남았나,
  'ⓒ 레포 폴더는 그대로 등록된다': 직접.레지스트리.includes(홀로레포) && !직접.모달남았나,
  'ⓒ 등록되면 모달이 닫히고 알림이 뜬다': 직접.알림.length === 1 && 직접.알림[0] === '1개 등록',
  'ⓓ 1단계 자식 중 git 레포만 전부 등록된다':
    훑기.레지스트리.includes(자식A) && 훑기.레지스트리.includes(자식B) && !훑기.레지스트리.includes(자식C),
  'ⓓ 등록 개수를 알린다': 훑기.알림.length === 1 && 훑기.알림[0] === '2개 등록',
  'ⓔ 레포가 없으면 지시가 준 문안 그대로 안내한다':
    없음.모달안내.length === 1 && 없음.모달안내[0] === '이 폴더에서 git 레포를 찾지 못했다',
  'ⓔ 그때 모달은 안 닫힌다 (다시 고를 수 있다)': 없음.모달남았나,
  '레지스트리에 앉은 것이 전부 진짜 git 레포다 (제3 오라클)':
    out.최종['파일의 레포가 전부 진짜 git 레포인가(오라클)'].every((item) => item.repo) &&
    JSON.stringify(out.최종['화면의 레포']) === JSON.stringify(기대),
  '네이티브 다이얼로그 호출은 전부 스텁이었다 (원자료가 그렇게 말한다)':
    out['browse 로그'].filter((entry) => entry.tag === 'browse.dialog').every((entry) => entry.stub === true),
}
out.어긋난것 = Object.entries(out.판정)
  .filter(([, value]) => value !== true)
  .map(([key]) => key)
out.클릭증거 = clickLog()
console.log(JSON.stringify({ 판정: out.판정, 어긋난것: out.어긋난것 }, null, 2))
writeRaw('add-repo-modal.json', out)
await app.stop()
fs.rmSync(TMP, { recursive: true, force: true })
