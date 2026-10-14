// LIFE-591 편집 흐름 격리 확인(최종 관문 전 구현 확인 — E1ⓔ·E2ⓑⓒ·E4ⓐⓑⓒⓔ 맛보기). 대화상자 답은 `file-dialog-stub`, 외부 변경은 이 스크립트가 fixture 파일에 직접 쓴다.
//   ① E1ⓔ 수정 → 터미널 탭으로 → 돌아오기: 내용·수정 점 그대로, ⌘Z 가 편집을 되돌린다(실행 취소 기록 유지)
//   ② E2ⓑⓒ 저장 10회 연속(한 글자 → ⌘S): 매번 디스크 = 편집기, 저장 뒤 배너·다시 읽기 없음, 저장 뒤 ⌘Z = 수정됨
//   ③ E4ⓐ 수정 없는 탭 외부 변경 → 2 s 안에 내용 갱신
//   ④ E4ⓑ 수정 중 외부 변경 → 덮지 않고 배너 → 「디스크 내용으로 되돌리기」 → 디스크 내용·수정 해제 → ⌘Z = 내 변경
//   ⑤ E4ⓔ 수정 중 외부 변경 → 「내 변경 유지」 → ⌘S → 충돌 대화상자(취소) → 디스크 무변경 → ⌘S → 덮어쓰기 → 디스크 = 내 내용
//   ⑥ E4ⓒ 양성 대조: 폴더 감시를 끊고(`file-watch-drop`) 외부 변경 직후 ⌘S → 감시가 알기 전이어도 충돌 대화상자(묻지 않고 덮지 않음)
// 사용(app/ 에서, iso.sh 안): node scripts/l591/edit-flows.mjs --root /tmp/l591g-x --repo /tmp/l591g-t/repo --out <dir>
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
if (!/^\/tmp\/l591[^/]*\/repo$/.test(values.repo ?? '')) throw new Error('repo 는 /tmp/l591*/repo')
const root = values.root
const repo = values.repo
const rel = 'notes/edit.txt'
fs.mkdirSync(values.out, { recursive: true })
const checks = []
const check = (id, pass, value) => {
  checks.push({ id, pass: Boolean(pass), value })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(value).slice(0, 300)}`)
}
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 200, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const stub = (answers) => ctl(root, { cmd: 'file-dialog-stub', answers })
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const file = path.join(repo, rel)
const disk = () => fs.readFileSync(file, 'utf8')
const dirty = async () => (await js(`document.querySelector('[data-file-tab="${rel}"]')?.dataset.fileDirty ?? null`)) === 'true'
// 편집기 글 — Monaco 모델을 `window` 에 노출하지 않으므로 화면 줄(위치 순)로 본다. 짧은 파일이라 다 보인다.
const shown = async () => (await js(`(() => { const rows = [...document.querySelectorAll('[data-file-view="${rel}"] .view-line')]; rows.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)); return rows.map((el) => el.textContent.replace(/\\u00a0/g, ' ')).join('\\n') })()`))
/** 조건이 참이 될 때까지(화면 줄은 다음 프레임에 그려진다 — 모델이 먼저 바뀐다) 기다려 참/거짓. */
const settle = (condition, timeoutMs = 3000) => until(condition, { label: 'settle', timeoutMs, everyMs: 50 }).then(() => true, () => false)
const banner = () => js(`document.querySelector('[data-file-notice="external-change"]') !== null`)
const editorTop = async () => {
  await click(`[data-file-view="${rel}"] .view-lines`)
  await key('Up', ['meta'])
  await key('Home')
}
const expanded = async (row) => (await js(`document.querySelector('[data-explorer-row="${row}"]')?.getAttribute('aria-expanded') ?? null`)) === 'true'

fs.mkdirSync(path.dirname(file), { recursive: true })
fs.writeFileSync(file, 'alpha\nbeta\ngamma\n')
await repoPane(root, { repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
await until(async () => (await js(`document.querySelector('[data-explorer-row="notes"]') !== null`)), { label: 'notes row' })
if (!(await expanded('notes'))) await click('[data-explorer-row="notes"]')
await until(async () => (await js(`document.querySelector('[data-explorer-row="${rel}"]') !== null`)), { label: 'file row' })
await ctl(root, { cmd: 'dblclick', selector: `[data-explorer-row="${rel}"]` })
await until(() => js(`document.querySelector('[data-file-view="${rel}"] [data-editor-ready]') !== null`), { label: 'editor' })

// ① 탭 전환 왕복
await editorTop()
await ctl(root, { cmd: 'type', text: 'Z' })
await until(dirty, { label: 'dirty', timeoutMs: 5000 })
await click(`[data-main-tab]:not([data-file-tab])`)
await until(() => js(`document.querySelector('[data-file-view="${rel}"]') === null`), { label: 'unmounted' })
await click(`[data-file-tab="${rel}"]`)
await until(() => js(`document.querySelector('[data-file-view="${rel}"] [data-editor-ready]') !== null`), { label: 'remounted' })
const kept = await settle(async () => (await dirty()) && (await shown()).startsWith('Zalpha'))
check('E1e-tab-switch-keeps', kept, { text: await shown(), dirty: await dirty() })
await click(`[data-file-view="${rel}"] .view-lines`)
await key('Z', ['meta'])
check('E1e-undo-after-switch', await settle(async () => !(await dirty()) && (await shown()).startsWith('alpha')), { text: await shown(), dirty: await dirty() })

// ② 저장 10회 연속
const saveRounds = []
for (let round = 0; round < 10; round += 1) {
  await editorTop()
  await ctl(root, { cmd: 'type', text: String(round) })
  await until(dirty, { label: `dirty ${round}`, timeoutMs: 5000 })
  await key('S', ['meta'])
  await until(async () => !(await dirty()), { label: `saved ${round}`, timeoutMs: 5000 })
  saveRounds.push({ round, disk: disk().split('\n')[0] })
}
await sleep(2500)
const expectedHead = '9876543210alpha'
check('E2a-10-saves-disk', saveRounds.every((row, index) => row.disk.startsWith(String(index))) && disk().startsWith(expectedHead), saveRounds)
check('E2c-no-banner-after-saves', !(await banner()) && !(await dirty()), { banner: await banner() })
await click(`[data-file-view="${rel}"] .view-lines`)
await key('Z', ['meta'])
check('E2b-undo-after-save', await settle(async () => (await dirty()) && (await shown()).startsWith('876543210alpha')), { text: (await shown()).slice(0, 30) })
// ⌘⇧Z 다시 실행 — 앱 단축키(pane 줌)가 편집기 안에서는 양보한다(EDITOR_YIELD_ACTIONS).
await key('Z', ['meta', 'shift'])
check('E2b-redo-in-editor', await settle(async () => !(await dirty()) && (await shown()).startsWith('9876543210alpha')), { text: (await shown()).slice(0, 30), dirty: await dirty() })

// ③ 수정 없는 탭 외부 변경
const t3 = Date.now()
fs.writeFileSync(file, 'external one\nbeta\n')
const reloaded = await until(async () => (await shown()).startsWith('external one'), { label: 'reload', timeoutMs: 4000, everyMs: 50 }).then(() => Date.now() - t3, () => null)
check('E4a-clean-reload-2s', reloaded !== null && reloaded <= 2000 && !(await dirty()), { ms: reloaded })

// ④ 수정 중 외부 변경 → 배너 → 되돌리기
await editorTop()
await ctl(root, { cmd: 'type', text: 'M' })
await until(dirty, { label: 'dirty4', timeoutMs: 5000 })
fs.writeFileSync(file, 'external two\n')
const bannerUp = await settle(banner, 4000)
check('E4b-not-overwritten', bannerUp && (await settle(async () => (await shown()).startsWith('Mexternal one') && (await dirty()))), { banner: bannerUp, text: (await shown()).slice(0, 30) })
await click('[data-external-action="revert"]')
check('E4b-revert', await settle(async () => (await shown()).startsWith('external two') && !(await dirty()) && !(await banner()), 4000), { text: await shown() })
await click(`[data-file-view="${rel}"] .view-lines`)
await key('Z', ['meta'])
check('E4b-revert-undoable', await settle(async () => (await shown()).startsWith('Mexternal one') && (await dirty())), { text: (await shown()).slice(0, 30) })

// ⑤ 내 변경 유지 → 저장 = 충돌 확인
fs.writeFileSync(file, 'external three\n')
await until(banner, { label: 'banner5', timeoutMs: 4000 })
await click('[data-external-action="keep"]')
await until(async () => !(await banner()), { label: 'kept', timeoutMs: 2000 })
await stub(['cancel'])
await key('S', ['meta'])
await sleep(800)
check('E4e-keep-then-save-asks', disk() === 'external three\n' && (await dirty()), { disk: disk() })
await stub(['overwrite'])
await key('S', ['meta'])
check('E4c-overwrite', await settle(async () => !(await dirty()) && disk().startsWith('Mexternal one'), 4000), { disk: disk() })

// ⑥ 감시 끊고 외부 변경 직후 ⌘S
await ctl(root, { cmd: 'file-watch-drop' })
await editorTop()
await ctl(root, { cmd: 'type', text: 'P' })
await until(dirty, { label: 'dirty6', timeoutMs: 5000 })
await stub(['cancel'])
fs.writeFileSync(file, 'sneaky external\n')
const sneaky = sha(fs.readFileSync(file))
await key('S', ['meta'])
await sleep(800)
const asked = (await stub([])).asked
check('E4c-positive-control-no-silent-overwrite', sha(fs.readFileSync(file)) === sneaky && asked.at(-1) === 'conflict' && (await dirty()), { asked, disk: disk() })
// 정리 — g-down 이 확인 대화상자에 막히지 않게 수정 상태를 걷는다(디스크 내용으로 되돌리기).
await until(banner, { label: 'banner6', timeoutMs: 4000 }).catch(() => null)
if (await banner()) await click('[data-external-action="revert"]')
await until(async () => !(await dirty()), { label: 'clean end', timeoutMs: 4000 }).catch(() => null)

const failed = checks.filter((row) => !row.pass)
writeJson(path.join(values.out, 'edit-flows.json'), { rel, checks })
console.log(failed.length === 0 ? 'ALL PASS' : `FAILED ${failed.map((row) => row.id).join(',')}`)
process.exit(failed.length === 0 ? 0 : 1)
