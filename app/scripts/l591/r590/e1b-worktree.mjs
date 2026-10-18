// LIFE-591 E7ⓑ 무회귀 사본 — scripts/l590/e1b-worktree.mjs 에서 격리 루트(/tmp/l591g-*)·fixture 경로(/tmp/l591g-u)만 바꿨다.
/* eslint-disable -- 원본 사본(본문 그대로 — 고치지 않는다) */
// LIFE-590 E1ⓑ — 파일 탭은 worktree 에 속한다(격리). A 에 파일 탭(고정 README · 미리보기 sample.ts) → linked worktree B 로 전환: A 파일 탭이 안 보이고
// B 에서 연 README 는 B 내용 → A 로 돌아오면 A 의 파일 탭·순서·활성·미리보기 그대로·A 내용 → 다시 B 로 가면 B 파일 탭 그대로. (리뷰 r1 worktree-repro 조건 + 판정)
// 사용(app/ 에서): node scripts/l590/e1b-worktree.mjs --root /tmp/l590g-* --repo /tmp/l591g-u/repo --out <json>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, herdr, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const root = values.root
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 100, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const repoReal = fs.realpathSync(values.repo)
const wtB = path.join(path.dirname(repoReal), 'wt-b')
// fixture 가 레포를 새로 만들므로 B 도 매번 새로(남은 폴더·가지는 지운다)
fs.rmSync(wtB, { recursive: true, force: true })
execFileSync('git', ['-C', repoReal, 'worktree', 'prune'])
try {
  execFileSync('git', ['-C', repoReal, 'branch', '-D', 'l590-wt-b'], { stdio: 'ignore' })
} catch {
  // 가지가 없으면(첫 실행) 지울 것이 없다
}
execFileSync('git', ['-C', repoReal, 'worktree', 'add', '-q', '-b', 'l590-wt-b', wtB])
fs.writeFileSync(path.join(wtB, 'README.md'), '# WORKTREE B\n\nB 쪽 내용\n')

const tabs = () => js(`[...document.querySelectorAll('[data-main-tab]')].map((e) => ({ id: e.dataset.mainTab, active: e.dataset.active, preview: e.dataset.tabPreview ?? null }))`)
const fileTabs = async () => (await tabs()).filter((tab) => tab.id.startsWith('file:'))
const viewText = (rel) => js(`[...document.querySelectorAll('[data-file-view="${rel}"] .view-line')].map((e) => e.textContent.replace(/\\u00a0/g, ' ')).join('\\n')`)
const openRow = async ({ rel, pin }) => {
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/')
    if ((await js(`document.querySelector('[data-explorer-row="${dir}"]')?.getAttribute('aria-expanded') ?? null`)) !== 'true') await click(`[data-explorer-row="${dir}"]`)
  }
  await until(async () => (await ctl(root, { cmd: pin ? 'dblclick' : 'click', selector: `[data-explorer-row="${rel}"]` })).ok === true, { label: rel })
  await until(() => js(`!!document.querySelector('[data-file-view="${rel}"] [data-editor-ready]')`), { label: `ready ${rel}` })
}
const selectWorktree = async (worktreePath) => {
  await click(`[data-worktree="${worktreePath}"]`)
  await until(async () => (await js(`document.querySelector('[data-worktree="${worktreePath}"]')?.getAttribute('aria-current') ?? document.querySelector('[data-worktree="${worktreePath}"]')?.dataset.active ?? null`)) !== null, { timeoutMs: 3000, label: 'wt active' }).catch(() => null)
  await sleep(800)
}

const out = {}
await repoPane(root, { repo: values.repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })

// A 에 파일 탭 둘
await openRow({ rel: 'README.md', pin: true })
await openRow({ rel: 'src/sample.ts', pin: false })
out.aBefore = await tabs()
out.aReadme = (await viewText('src/sample.ts')).slice(0, 80)

// B 열기(linked worktree workspace) → B 로 전환
await js('window.corral.refreshTree()')
out.openB = await js(`window.corral.openWorktree({ repoRoot: ${JSON.stringify(repoReal)}, path: ${JSON.stringify(wtB)}, isLinked: true })`)
const paneB = await until(async () => ((await herdr(root, 'pane.list')).panes ?? []).find((pane) => typeof pane.cwd === 'string' && pane.cwd.includes('wt-b')) ?? null, { timeoutMs: 15_000, label: 'pane B' })
await until(() => js(`!!document.querySelector('[data-worktree="${wtB}"]')`), { label: 'B card' })
await selectWorktree(wtB)
out.bFirst = await tabs()
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'B rows' })
await openRow({ rel: 'README.md', pin: true })
out.bAfterOpen = await tabs()
out.bReadmeText = await viewText('README.md')

// A 로 돌아오기
await selectWorktree(repoReal)
out.aBack = await tabs()
await click('[data-main-tab="file:README.md"]')
await until(() => js(`!!document.querySelector('[data-file-view="README.md"] [data-editor-ready]')`), { label: 'A readme' })
out.aReadmeText = await viewText('README.md')

// 다시 B
await selectWorktree(wtB)
out.bBack = await tabs()
// 카드 클릭은 그 worktree 의 터미널 세션을 고른다(R3-e reveal — 그 탭이 활성) → 파일 탭 내용은 탭을 눌러 본다
await click('[data-main-tab="file:README.md"]')
await until(() => js(`!!document.querySelector('[data-file-view="README.md"] [data-editor-ready]')`), { label: 'B readme back' })
out.bReadmeTextBack = await viewText('README.md')
out.paneB = paneB.value?.pane_id ?? null

const ids = (list) => list.filter((tab) => tab.id.startsWith('file:')).map((tab) => `${tab.id}|${tab.preview}`)
const activeOf = (list) => list.find((tab) => tab.active === 'true')?.id ?? null
const checks = {
  'b-starts-without-a-file-tabs': out.bFirst.every((tab) => !tab.id.startsWith('file:')),
  'b-readme-is-b-content': out.bReadmeText.includes('WORKTREE B'),
  'a-file-tabs-restored-same': JSON.stringify(ids(out.aBack)) === JSON.stringify(ids(out.aBefore)),
  // 활성 탭 복원 — 카드 클릭이 터미널 세션을 고르는 기존 동작(R3-e)이라 터미널이 활성이 된다(Z13). 판정은 DONE 에서 미달로 따로 적고 여기서는 관찰.
  'observe-a-active-tab (판정 제외)': true,
  'a-readme-is-a-content': !out.aReadmeText.includes('WORKTREE B') && out.aReadmeText.length > 0,
  'b-file-tab-kept': out.bBack.some((tab) => tab.id === 'file:README.md') && out.bBack.filter((tab) => tab.id.startsWith('file:')).length === 1,
  'b-readme-back-is-b-content': out.bReadmeTextBack.includes('WORKTREE B'),
}
out.checks = checks
writeJson(values.out, out)
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
console.log(JSON.stringify({ aBefore: ids(out.aBefore), bFirst: out.bFirst.map((t) => t.id), bAfterOpen: ids(out.bAfterOpen), aBack: ids(out.aBack), activeBefore: activeOf(out.aBefore), activeBack: activeOf(out.aBack), bActiveBack: activeOf(out.bBack), bBack: ids(out.bBack), failed }))
process.exit(failed.length === 0 ? 0 : 1)
