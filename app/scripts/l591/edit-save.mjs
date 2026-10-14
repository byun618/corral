// LIFE-591 빠른 확인 — 핵심 진입점 1회(01-criteria 「빠른 확인」): 격리 개발 Electron 에서 fixture 파일을 탐색기로 열기 → 편집기에 한 글자 → 수정 점·미리보기 고정
// → ⌘S → 수정 점 해제 → 디스크 sha256 = 기대 바이트(원본 앞에 그 글자). 저장 뒤 2.5 s 동안 다시 읽기·배너 없음(E2ⓒ 맛보기)도 본다.
// 입력은 제어 소켓 `type`·`key`(Chromium 입력 파이프라인 sendInputEvent — OS 키 입력 아님, G5). 쓰기는 fixture(/tmp/l591g-t/repo)에만.
// 사용(app/ 에서, iso.sh 안): node scripts/l591/edit-save.mjs --root /tmp/l591g-x --repo /tmp/l591g-t/repo --out <dir>
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, rel: { type: 'string', default: 'src/sample.ts' } } })
checkRoot(values.root)
if (!/^\/tmp\/l591[^/]*\/repo$/.test(values.repo ?? '')) throw new Error('repo 는 /tmp/l591*/repo')
const root = values.root
const repo = values.repo
const rel = values.rel
fs.mkdirSync(values.out, { recursive: true })
const checks = []
const check = (id, pass, value) => {
  checks.push({ id, pass: Boolean(pass), value })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(value).slice(0, 300)}`)
}
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 200, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const shot = async (name) => {
  const result = await ctl(root, { cmd: 'shot', name })
  if (result.file) fs.copyFileSync(result.file, path.join(values.out, `${name}.png`))
}
const expanded = async (row) => (await js(`document.querySelector('[data-explorer-row="${row}"]')?.getAttribute('aria-expanded') ?? null`)) === 'true'
const openFile = async (target) => {
  const parts = target.split('/')
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/')
    if (!(await expanded(dir))) await click(`[data-explorer-row="${dir}"]`)
    await until(() => expanded(dir), { label: `expand ${dir}` })
  }
  await click(`[data-explorer-row="${target}"]`)
  await until(() => js(`document.querySelector('[data-file-view="${target}"] [data-editor-ready]') !== null`), { label: `editor ${target}` })
}
const tabState = () => js(`(() => { const tab = document.querySelector('[data-file-tab="${rel}"]'); return tab === null ? null : { dirty: tab.dataset.fileDirty, preview: tab.dataset.tabPreview, close: getComputedStyle(tab.querySelector('.main-tab-close'), '::before').content } })()`)

const file = path.join(repo, rel)
const original = fs.readFileSync(file)
const expected = Buffer.concat([Buffer.from('X'), original])

await repoPane(root, { repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })

await openFile(rel)
check('open-preview-clean', (await tabState())?.dirty === 'false', await tabState())
// 편집기에 포커스 → 문서 맨 앞(⌘↑) → 한 글자.
await click(`[data-file-view="${rel}"] .view-lines`)
await key('Up', ['meta'])
await key('Home')
const typed = await ctl(root, { cmd: 'type', text: 'X' })
await until(async () => (await tabState())?.dirty === 'true', { label: 'dirty', timeoutMs: 5000 })
const dirtyTab = await tabState()
check('E1b-dirty-dot', dirtyTab?.dirty === 'true' && dirtyTab?.close !== 'none', dirtyTab)
check('E1d-preview-pinned', dirtyTab?.preview === 'false', dirtyTab)
check('E9-no-autosave', sha(fs.readFileSync(file)) === sha(original), { typedAt: typed.at })
await shot('dirty')

const updatedBefore = await js(`document.querySelector('[data-file-view="${rel}"] [data-file-editor]')?.dataset.editorUpdated ?? null`)
await key('S', ['meta'])
await until(async () => (await tabState())?.dirty === 'false', { label: 'saved', timeoutMs: 5000 })
const disk = fs.readFileSync(file)
check('E2a-disk-sha256', sha(disk) === sha(expected), { disk: sha(disk), expected: sha(expected), size: disk.length })
await sleep(2500)
const after = await js(`({ banner: document.querySelector('[data-file-notice="external-change"]') !== null, updated: document.querySelector('[data-file-view="${rel}"] [data-file-editor]')?.dataset.editorUpdated ?? null, dirty: document.querySelector('[data-file-tab="${rel}"]')?.dataset.fileDirty })`)
check('E2c-no-self-reload', after.banner === false && after.updated === updatedBefore && after.dirty === 'false', after)
const writes = fs.readFileSync(path.join(root, 'ud/corral.ndjson'), 'utf8').split('\n').filter((line) => line.includes('"tag":"file.write"')).map((line) => JSON.parse(line))
check('ipc-file-write-log', writes.length === 1 && writes[0].ok === true && writes[0].hooks === false, writes)
await shot('saved')

const failed = checks.filter((row) => !row.pass)
writeJson(path.join(values.out, 'edit-save.json'), { rel, checks, original: { sha256: sha(original), size: original.length }, expected: sha(expected) })
console.log(failed.length === 0 ? 'ALL PASS' : `FAILED ${failed.map((row) => row.id).join(',')}`)
process.exit(failed.length === 0 ? 0 : 1)
