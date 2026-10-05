// LIFE-495 K8ⓒⓓⓕ — 네이티브 rename 시퀀스(LIFE-501 포커스 누출). l493/native-seq.mjs 의 걸음을 따른다:
//   첫 탭 클릭(활성) → **비활성** 대상 탭 클릭 → 곧바로(대기 없음 — K8ⓓ, 494 의 1.5초 대기를 뺀 판) 라벨 더블클릭
//   → 0/100/300ms document.activeElement → ⌘A · 글자 · Enter → 라벨이 바뀌었나 + 그 글자가 셸 화면에 새지 않았나.
// 대상 탭을 누르면 그 탭의 터미널이 마운트되며 포커스를 요청한다 — base(5147320b)는 이 마운트 포커스가 입력칸을 뺏는다(LIFE-501).
// 입력은 제어 소켓 key/type(webContents.sendInputEvent — 포커스된 요소가 받는다). 새어도 fixture 셸 pane 이다(assertOnlyFixture).
// 사용: node native-seq.mjs <ROOT=/tmp/l495n*> <raw 폴더> <fixture 경로(realpath)> <꼬리표> <회수>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [root, rawd, fixture, label, runsArg] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l495n')) throw new Error('ROOT 는 /tmp/l495n*')
if (!fixture?.startsWith('/private/tmp/l495nfx')) throw new Error('fixture 는 /private/tmp/l495nfx*')
const runs = Number(runsArg ?? 30)
const ctl = path.join(root, 'ctl.sock')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const control = (request) => rpc(ctl, request, 30_000)
const evaluate = async (code) => (await control({ cmd: 'eval', code })).result
const result = { label, app: fs.readFileSync(path.join(root, 'app.dir'), 'utf8'), startedAt: new Date().toISOString(), runs: [] }
const outFile = path.join(rawd, `seq-${label}.json`)
const save = () => fs.writeFileSync(outFile, `${JSON.stringify(result, null, 1)}\n`)
const screenOf = (paneId) => {
  try {
    return execFileSync('/opt/homebrew/bin/herdr', ['pane', 'read', paneId, '--source', 'visible', '--format', 'text'], { encoding: 'utf8' })
  } catch (error) {
    return `herdr pane read 실패: ${error.message}`
  }
}
async function until(fn, what, timeout = 15_000, every = 150) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`시간 초과: ${what}`)
    await pause(every)
  }
}
async function fixtureWs() {
  const state = (await control({ cmd: 'state' })).state
  for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === fixture) return row.workspace
  return null
}
const domTabs = () => evaluate(`[...document.querySelectorAll('[data-main-tab]')].map((tab) => ({ id: tab.dataset.mainTab, active: tab.dataset.active === 'true', label: tab.querySelector('.main-tab-label')?.textContent ?? null }))`)
const focusNow = () => evaluate(`(() => { const el = document.activeElement; return { tag: el?.tagName ?? null, cls: (el?.className ?? '').toString().slice(0, 40), rename: el?.dataset?.tabRename ?? null, termPane: el?.closest?.('[data-term-pane]')?.dataset.termPane ?? null } })()`)
async function assertOnlyFixture() {
  const mine = new Set(((await fixtureWs())?.tabs ?? []).map((tab) => tab.tabId))
  const dom = await domTabs()
  if (dom.length === 0 || !dom.every((tab) => mine.has(tab.id))) throw new Error('화면에 fixture 밖 탭이 있다 — 멈춘다')
}
/** 탭 4개(넘침 없음) — 모자라면 ⌘T(제어 소켓 key), 남으면 마지막 탭을 ×. */
async function ensureFour() {
  for (;;) {
    const tabs = await domTabs()
    if (tabs.length === 4) return tabs
    if (tabs.length < 4) {
      await control({ cmd: 'key', keyCode: 't', modifiers: ['meta'] })
      await until(async () => (await domTabs()).length === tabs.length + 1, '⌘T')
    } else {
      await control({ cmd: 'click', selector: `[data-main-tab-close="${tabs.at(-1).id}"]` })
      await pause(400)
      if (await evaluate(`document.querySelector('[data-confirm-close-modal]') !== null`)) await control({ cmd: 'click', selector: '[data-close-confirm-ok]' })
      await until(async () => (await domTabs()).length === tabs.length - 1, '× 닫기')
    }
  }
}

async function main() {
  await assertOnlyFixture()
  for (let n = 1; n <= runs; n += 1) {
    const tabs = await ensureFour()
    await assertOnlyFixture()
    // 첫 탭 활성 → 대상(비활성, 2~4번째를 돌아가며).
    await control({ cmd: 'click', selector: `[data-main-tab="${tabs[0].id}"]` })
    await until(async () => (await domTabs())[0].active, '첫 탭 활성', 5_000)
    await pause(600)
    const target = tabs[1 + ((n - 1) % 3)]
    const text = `r${n}x${label.replace(/[^a-z0-9]/gi, '')}`
    const at = Date.now()
    const clicked = await control({ cmd: 'click', selector: `[data-main-tab="${target.id}"]` })
    const dbl = await control({ cmd: 'dblclick', selector: `[data-main-tab="${target.id}"] .main-tab-label` })
    const samples = []
    for (const ms of [0, 100, 300]) {
      const wait = at + ms - Date.now()
      if (wait > 0) await pause(wait)
      samples.push({ ms, focus: await focusNow() })
    }
    await control({ cmd: 'key', keyCode: 'a', modifiers: ['meta'] })
    await control({ cmd: 'type', text })
    await control({ cmd: 'key', keyCode: 'Enter' })
    const renamed = await until(async () => (await domTabs()).find((tab) => tab.id === target.id)?.label === text, '이름', 4_000).then(() => true, () => false)
    const pane = ((await fixtureWs())?.tabs.find((tab) => tab.tabId === target.id)?.panes ?? [])[0]?.paneId ?? null
    const leaked = pane === null ? null : screenOf(pane).includes(text)
    const pass = clicked.ok === true && dbl.ok === true && renamed && leaked === false
    result.runs.push({ n, target: target.id, text, pass, renamed, leaked, pane, clickOk: clicked.ok === true, dblOk: dbl.ok === true, samples, finalLabel: (await domTabs()).find((tab) => tab.id === target.id)?.label ?? null })
    save()
    console.log(`[seq ${label}] ${n}/${runs} ${pass ? '✔' : '✘'} renamed=${renamed} leaked=${leaked} focus@300=${samples[2].focus.cls}`)
    // 실패 회차 정리 — 편집이 열려 있으면 Esc, 셸에 샌 글자는 Ctrl+U 로 지운다(fixture 셸).
    if (!pass) {
      await control({ cmd: 'key', keyCode: 'Escape' })
      await control({ cmd: 'key', keyCode: 'u', modifiers: ['control'] })
      await pause(300)
    }
  }
  const failed = result.runs.filter((row) => !row.pass).length
  result.summary = { runs: result.runs.length, passed: result.runs.length - failed, failed }
  save()
  return failed
}
main().then(
  (failed) => process.exit(failed === 0 ? 0 : 1),
  (error) => {
    result.error = String(error?.stack ?? error).slice(0, 800)
    save()
    console.error(error)
    process.exit(2)
  },
)
