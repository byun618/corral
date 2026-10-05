// LIFE-495 K8ⓒⓓⓕ — 네이티브 rename 시퀀스(LIFE-501 포커스 누출). l493/native-seq.mjs 의 걸음을 따른다:
//   첫 탭 클릭(활성) → **비활성** 대상 탭 클릭 → 곧바로(대기 없음 — K8ⓓ, 494 의 1.5초 대기를 뺀 판) 라벨 더블클릭
//   → 0/100/300ms document.activeElement → ⌘A · 글자 · Enter → 라벨이 바뀌었나 + 그 글자가 셸 화면에 새지 않았나.
// 대상 탭을 누르면 그 탭의 터미널이 마운트되며 포커스를 요청한다 — base(5147320b)는 이 마운트 포커스가 입력칸을 뺏는다(LIFE-501).
// 입력은 제어 소켓 key/type(webContents.sendInputEvent — 포커스된 요소가 받는다). 새어도 fixture 셸 pane 이다(assertOnlyFixture).
// fix1 R1-09 — 화면 read 실패 = 그 회차 실패(누출 미확인). 회차마다 read 성공 여부·원문 sha256·길이를 기록한다.
// 사용: node native-seq.mjs <ROOT=/tmp/l495n*> <raw 폴더> <fixture 경로(realpath)> <꼬리표> <회수>   (자기점검: L495_FAKE_READ_FAIL=<회차>)
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
/**
 * 화면 읽기 (fix1 R1-09) — 실패를 「누출 없음」으로 바꾸지 않는다: `{ ok:false }` 면 그 회차는 실패다(누출 판정 불가).
 * 성공이면 원문 해시·길이를 원자료에 남긴다. `L495_FAKE_READ_FAIL=<회차>` 면 그 회차는 **없는 pane id** 로 실제 herdr read 를 불러
 * 읽기 실패 길을 지난다(자기점검 — 그 회차가 실패로 기록되는지 본다).
 */
const fakeReadFail = Number(process.env.L495_FAKE_READ_FAIL ?? 0)
const screenOf = ({ paneId, n }) => {
  const target = fakeReadFail === n ? `${paneId}-l495-fake-missing` : paneId
  try {
    const text = execFileSync('/opt/homebrew/bin/herdr', ['pane', 'read', target, '--source', 'visible', '--format', 'text'], { encoding: 'utf8' })
    // herdr 는 오류도 JSON 으로 내고 exit 0 일 수 있다 — `{"error":…}` 꼴이면 실패로 센다.
    if (/^\s*\{"error"/.test(text)) return { ok: false, error: text.trim().slice(0, 300), faked: target !== paneId }
    return { ok: true, text, sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), faked: target !== paneId }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300), faked: target !== paneId }
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
/**
 * 입력 직전 검사(fix2 R2-04 — native-t3 와 같은 꼴을 이 하네스에도) — 화면 탭 전부 fixture 것, 포커스가 터미널이면 그 pane 과 선택 pane 이
 * fixture pane. 아니면 보내지 않고 멈춘다(exit 2). 모든 제어 소켓 key/type 이 여기를 지난다.
 */
async function input(request) {
  const ws = await fixtureWs()
  const panes = new Set((ws?.tabs ?? []).flatMap((tab) => tab.panes.map((pane) => pane.paneId)))
  const tabs = new Set((ws?.tabs ?? []).map((tab) => tab.tabId))
  const seen = await evaluate(`({ tabs: [...document.querySelectorAll('[data-main-tab]')].map((tab) => tab.dataset.mainTab), focus: document.activeElement?.closest?.('[data-term-pane]')?.dataset.termPane ?? null, selected: document.querySelector('[data-term-pane-box].is-selected')?.dataset.termPaneBox ?? null })`)
  const ok = seen.tabs.length > 0 && seen.tabs.every((id) => tabs.has(id)) && (seen.focus === null || panes.has(seen.focus)) && seen.selected !== null && panes.has(seen.selected)
  if (!ok) throw new Error(`fixture 밖 입력 대상 — 보내지 않고 멈춘다 ${JSON.stringify({ request, ...seen })}`)
  return control(request)
}
/** 탭 4개(넘침 없음) — 모자라면 ⌘T(제어 소켓 key), 남으면 마지막 탭을 ×. */
async function ensureFour() {
  for (;;) {
    const tabs = await domTabs()
    if (tabs.length === 4) return tabs
    if (tabs.length < 4) {
      await input({ cmd: 'key', keyCode: 't', modifiers: ['meta'] })
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
    await input({ cmd: 'key', keyCode: 'a', modifiers: ['meta'] })
    await input({ cmd: 'type', text })
    await input({ cmd: 'key', keyCode: 'Enter' })
    const renamed = await until(async () => (await domTabs()).find((tab) => tab.id === target.id)?.label === text, '이름', 4_000).then(() => true, () => false)
    const pane = ((await fixtureWs())?.tabs.find((tab) => tab.tabId === target.id)?.panes ?? [])[0]?.paneId ?? null
    const read = pane === null ? { ok: false, error: 'pane 없음', faked: false } : screenOf({ paneId: pane, n })
    // 읽기에 실패하면 누출 여부를 모른다 — null(미확인)로 두고 회차는 실패다(R1-09).
    const leaked = read.ok ? read.text.includes(text) : null
    const pass = clicked.ok === true && dbl.ok === true && renamed && read.ok && leaked === false
    result.runs.push({
      n, target: target.id, text, pass, renamed, leaked, pane, clickOk: clicked.ok === true, dblOk: dbl.ok === true, samples,
      read: read.ok ? { ok: true, sha256: read.sha256, bytes: read.bytes, faked: read.faked } : { ok: false, error: read.error, faked: read.faked },
      finalLabel: (await domTabs()).find((tab) => tab.id === target.id)?.label ?? null,
    })
    save()
    console.log(`[seq ${label}] ${n}/${runs} ${pass ? '✔' : '✘'} renamed=${renamed} read=${read.ok ? 'ok' : 'FAIL'} leaked=${leaked} focus@300=${samples[2].focus.cls}`)
    // 실패 회차 정리 — 편집이 열려 있으면 Esc, 셸에 샌 글자는 Ctrl+U 로 지운다(fixture 셸).
    if (!pass) {
      await input({ cmd: 'key', keyCode: 'Escape' })
      await input({ cmd: 'key', keyCode: 'u', modifiers: ['control'] })
      await pause(300)
    }
  }
  const failed = result.runs.filter((row) => !row.pass).length
  result.summary = { runs: result.runs.length, passed: result.runs.length - failed, failed, readOk: result.runs.filter((row) => row.read.ok).length, fakeReadFail: fakeReadFail || null }
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
