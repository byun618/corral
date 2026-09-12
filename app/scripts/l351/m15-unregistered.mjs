// M15 — G1(게이트 ① 지시): **미등록 workspace 가 있어도 화면에 안 그려진다.**
//
// 사용자가 앱을 직접 굴려보고 결정했다 — 등록한 레포만 보인다 (2026-09-12). 그래서 `AppState`
// 에서 `unregistered` 칸 자체가 사라졌다. 여기서 재는 것은 그 결정이 **실물로** 지켜지는가다.
//
// # 왜 `look()` 의 일치 자를 안 쓰나
//
// 다른 측정(N5)은 "corral 이 herdr 와 같은가" 를 재고, 어긋나면 미달이다. 이번 것은 **어긋남이
// 의도**다 — herdr 에는 있고 화면에는 없어야 통과다. 같은 자를 쓰면 이 회차는 원리적으로 못
// 통과한다. 그래서 일치 자를 안 쓰고, 네 군데를 따로 본다: herdr(있다) · main 로그(봤다) ·
// AppState(안 싣는다) · DOM(안 그린다).
//
// # 왜 양성 대조가 같은 실행 안에 있나
//
// "안 그려졌다" 는 **렌더러가 죽어 있어도** 참이다. 그래서 같은 실행·같은 샷 안에 등록 레포의
// workspace 를 하나 띄워 두고 그것은 **그려진다**는 것까지 본다. 둘이 같은 화면에 있어야
// "숨긴 것" 과 "아무것도 못 그린 것" 이 갈린다.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPO_DIR, request, sleep, startApp, tidySession, until, writeRaw } from './lib.mjs'

const 등록레포 = path.resolve(REPO_DIR, '../../..')

/** 레지스트리에 **안 넣을** 레포. 사용자 레포를 건드리지 않게 임시 폴더에 새로 만든다. */
function 미등록레포만들기() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l351-unreg-'))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(dir, 'README.md'), '# l351 미등록 레포 (G1 측정용)\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init', '--no-gpg-sign'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'l351', GIT_AUTHOR_EMAIL: 'l351@local', GIT_COMMITTER_NAME: 'l351', GIT_COMMITTER_EMAIL: 'l351@local' },
  })
  return dir
}

const 미등록레포 = 미등록레포만들기()
const registryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'l351-g1-')), 'repos.json')
// 레지스트리에는 **등록레포 하나만** 넣는다 — 미등록레포는 끝까지 안 넣는다.
fs.writeFileSync(registryFile, JSON.stringify({ version: 1, repos: [등록레포] }, null, 2))

// 양성 대조용 — 등록 레포(이 워크트리) 밑에 workspace 하나.
const 등록ws = await tidySession(REPO_DIR)
const app = await startApp({ name: 'g1-unregistered', registryFile })
await until(
  async () => {
    const state = await app.state()
    return state.repos.some((repo) => repo.worktrees.some((item) => item.openWorkspaceId === 등록ws))
  },
  { what: '등록 workspace 가 화면에 옴', timeoutMs: 20000 },
)

// 이제 **레지스트리 밖**에서 workspace 를 연다. 앱이 떠 있는 동안 여니 push 경로로 들어온다.
const 미등록ws = (await request('workspace.create', { label: 'l351-unreg', cwd: 미등록레포 })).workspace?.workspace_id ?? null
if (미등록ws === null) throw new Error('미등록 workspace 를 못 만들었다 — 측정 불가')
await sleep(1500)

/** main 이 그것을 **보긴 봤나** — 화면에서 뺐을 뿐 말없이 사라지지 않았다는 자취 (진단 로그). */
const 로그 = await until(
  async () => {
    const hit = app.entries().filter((entry) => entry.tag === 'tree.unregistered' && (entry.ids ?? []).includes(미등록ws))
    return hit.length > 0 ? hit : null
  },
  { what: 'tree.unregistered 로그', timeoutMs: 20000 },
)

const at = Date.now()
const state = await app.state()
const truth = (await request('workspace.list', {})).workspaces.map((item) => item.workspace_id).sort()
const shot = await app.shot('g1-unregistered')
const domUnreg = await app.query('[data-unregistered]')
const dom미등록 = await app.query(`[data-workspace="${미등록ws}"]`)
const dom등록 = await app.query(`[data-workspace="${등록ws}"]`)
const 화면ws = state.repos
  .flatMap((repo) => repo.worktrees.map((item) => item.workspace).filter((item) => item !== null))
  .map((item) => item.workspaceId)
  .sort()

const out = {
  at: new Date(at).toISOString(),
  질문: '레지스트리 밖에서 열린 workspace 가 herdr 에는 있는데 화면에는 안 나오는가 (게이트 ① 지시)',
  지시: '미등록 workspace 그룹을 화면에서 뺀다 — 등록한 레포만 보이게 한다 (게이트 ① 사용자 지시, 2026-09-12)',
  레포: { 등록: 등록레포, 미등록: 미등록레포, 레지스트리: state.registry },
  workspace: { 등록: 등록ws, 미등록: 미등록ws },
  'herdr 가 아는 workspace': truth,
  '화면이 든 workspace': 화면ws,
  'main 로그 (tree.unregistered)': 로그.ok ? 로그.value : null,
  DOM: {
    '[data-unregistered]': domUnreg.found.length,
    '미등록 workspace 칸': dom미등록.found.length,
    '등록 workspace 칸': dom등록.found.length,
  },
  'AppState 키': Object.keys(state).sort(),
  shot: shot.file,
}
out.판정 = {
  'ⓐ herdr 에는 미등록 workspace 가 실제로 있다': truth.includes(미등록ws),
  'ⓑ main 은 그것을 보고 로그로 남겼다 (말없이 사라지지 않는다)': 로그.ok === true,
  'ⓒ AppState 에 unregistered 칸이 없다': !('unregistered' in state),
  'ⓓ AppState 어디에도 그 id 가 없다': !JSON.stringify(state).includes(미등록ws),
  'ⓔ DOM 에 미등록 칸이 없다': domUnreg.found.length === 0 && dom미등록.found.length === 0,
  'ⓕ 양성 대조 — 등록 workspace 는 같은 화면에 그려진다': 화면ws.includes(등록ws) && dom등록.found.length === 1,
  'ⓖ 숨긴 것이지 못 그린 것이 아니다 (herdr 2 · 화면 1)': truth.length === 화면ws.length + 1,
}
out.어긋난것 = Object.entries(out.판정)
  .filter(([, value]) => value !== true)
  .map(([key]) => key)
console.log(JSON.stringify({ 판정: out.판정, 어긋난것: out.어긋난것 }, null, 2))
writeRaw('g1-unregistered.json', out)
await app.stop()
// 임시 레포는 지운다 — 레지스트리에 들어간 적이 없으니 앱 상태에는 자취가 없다.
await request('workspace.close', { workspace_id: 미등록ws }).catch(() => {})
fs.rmSync(미등록레포, { recursive: true, force: true })
