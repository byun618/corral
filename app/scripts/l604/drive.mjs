#!/usr/bin/env node
// LIFE-604 R1-G ① — 최종 관문 격리 앱 구동기(CDP). **수정 1 에서는 만들기만 하고 돌리지 않았다** — 최종 관문 일감이 돈다(final-gate-plan.md).
//   먼저: npm run build → sh scripts/l604/up.sh <ROOT> L604_EXTRA_ARGS=--remote-debugging-port=<PORT>(포커스 증거 exit 8 이면 『질의응답』 손 넘김)
//   node scripts/l604/drive.mjs <ROOT=/tmp/l604g-*> <OUT 폴더> [단계…]     단계 기본 = 전부: setup c1 c2 c9 c5 c6 c7 frames
//   node scripts/l604/drive.mjs <ROOT> <OUT> after-restart                 — down.sh·up.sh 재기동 뒤 C5 「재시작 뒤 초안 없음」 만
// 입력은 **렌더러 안의 DOM setter·합성 이벤트만**(element.click · 네이티브 value setter + input · dispatchEvent(KeyboardEvent)) — OS 키 입력·CGEvent·osascript 없음.
// 합성 KeyboardEvent 는 IME 를 거치지 않는다 — 한글 자판 `C`·Enter·Esc 의 실제 입력은 사람 단계(native-checklist N12–N14).
// 남기는 것: OUT/drive.ndjson(단계·판정 한 줄씩) · OUT/shots/<틀 id>.png(c12-frames.tsv) · OUT/verdict.json. 종료: 0 전부 통과 · 1 미달 있음 · 2 사용법.
// 토큰은 가짜(`mock_…`)만. 실제 LA·설치본·사용자 userData 무접촉(ROOT 가드).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [ROOT, OUT, ...picked] = process.argv.slice(2)
if (!ROOT?.startsWith('/tmp/l604g-') || ROOT.includes('..') || OUT === undefined) {
  console.error('쓰기: node scripts/l604/drive.mjs /tmp/l604g-<n> <OUT 폴더> [단계…]')
  process.exit(2)
}
process.env.L603_CDP_PORT ??= process.env.L604_CDP_PORT ?? '9604'
const { connect } = await import('../l603/cdp.mjs')
const APP = path.resolve(import.meta.dirname, '../..')
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true })
const journal = path.join(OUT, 'drive.ndjson')
const note = (row) => fs.appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n')
const verdicts = []
const judge = (item, pass, detail = null) => { verdicts.push({ item, pass }); note({ kind: 'judge', item, pass, detail }) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const cdp = await connect()
const js = (code) => cdp.evaluate(code)
async function until(code, { timeoutMs = 10_000, label }) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await js(code)) return true
    await sleep(150)
  }
  throw new Error(`시간 초과: ${label}`)
}
const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`
const click = (selector) => js(`(() => { const el = ${q(selector)}; if (!el) return false; el.click(); return true })()`)
const setValue = (selector, value) => js(`(() => {
  const el = ${q(selector)}; if (!el) return false
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
/** 합성 keydown — target 이 null 이면 document.body. */
const key = (selector, init) => js(`(() => { const el = ${selector === null ? 'document.body' : q(selector)}; if (!el) return false
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...${JSON.stringify(init)} })); return true })()`)
const exists = (selector) => js(`!!${q(selector)}`)
const text = (selector) => js(`${q(selector)}?.textContent ?? null`)
const value = (selector) => js(`${q(selector)}?.value ?? null`)
const shot = async (id) => { const out = path.join(OUT, 'shots', `${id}.png`); await cdp.shot(out); note({ kind: 'shot', id, out }) }
const creates = () => {
  const run = spawnSync(process.execPath, [path.join(APP, 'scripts/l604/count-creates.mjs'), path.join(ROOT, 'ud/corral.ndjson')], { encoding: 'utf8' })
  return JSON.parse(run.stdout).count
}
const leak = (needle) => {
  const run = spawnSync(process.execPath, [path.join(APP, 'scripts/l604/draft-leak.mjs'), path.join(ROOT, 'ud'), needle], { encoding: 'utf8' })
  note({ kind: 'draft-leak', needle: needle.length, out: run.stdout.trim(), status: run.status })
  return run.status
}
const openModal = async () => { await click('[data-tasks-create]'); await until(`!!${q('[data-quick-create]')}`, { label: '모달' }) }
const closeModal = async () => { await key(null, { key: 'Escape' }); await until(`!${q('[data-quick-create]')}`, { label: '모달 닫힘' }) }
const phase = () => js(`${q('[data-quick-create]')}?.getAttribute('data-quick-create-phase') ?? null`)

const STEPS = {
  async setup() {
    await until(`!!${q('[data-tasks-open]')}`, { timeoutMs: 30_000, label: '사이드바 「작업」' })
    const added = await js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: 'mock_l604_gate_delay-1500', replaceId: null }).then((r) => ({ ok: r.ok }))`)
    judge('setup 모의 연결(가짜 토큰, 1.5초 지연 — 연타 관측용)', added?.ok === true, added)
    await click('[data-tasks-open]')
    await until(`!!${q('[data-tasks-board] [data-issue-card]')}`, { timeoutMs: 20_000, label: '보드 카드' })
  },
  async c1() {
    const order = await js(`[...${q('.tasks-head')}.children].map((c) => c.hasAttribute('data-tasks-search') ? 's' : c.hasAttribute('data-tasks-create') ? 'c' : c.hasAttribute('data-tasks-close') ? 'x' : '').filter(Boolean).join('')`)
    judge('C1① 머리 「만들기」 검색과 닫기 사이', order === 'scx', order)
    await shot('c1-head')
    await openModal(); judge('C1① 누르면 모달', true); await closeModal()
    await key(null, { key: 'c', code: 'KeyC' }); judge('C1② C(합성)', await exists('[data-quick-create]')); await closeModal()
    await key(null, { key: 'ㅊ', code: 'KeyC' }); judge('C1② KeyC(ㅊ, 합성 — 실제 IME 는 사람 단계)', await exists('[data-quick-create]')); await closeModal()
    await key(null, { key: 'c', code: 'KeyC', metaKey: true }); judge('C1② ⌘C 무시', !(await exists('[data-quick-create]')))
    await click('[data-board-column] [data-inline-add-open]')
    judge('C1③ 칸 「+ 추가」 → 입력', await exists('[data-inline-add]'))
    await shot('c7-inline-open')
    await key('[data-inline-add]', { key: 'Escape' })
    await click('[data-tasks-view-tab="backlog"]'); await sleep(500)
    await click('[data-section-add="backlog"]')
    judge('C1④ 섹션 「추가」 → 백로그 배치 모달', (await js(`${q('[data-quick-create-placement="backlog"]')}?.getAttribute('aria-checked')`)) === 'true')
    await closeModal()
    await click('[data-tasks-view-tab="board"]'); await sleep(500)
  },
  async c2() {
    await openModal()
    await shot('c2-modal-empty')
    await click('[data-quick-create-status]'); await shot('c2-status-note')
    judge('C2 상태 각주(첫 상태만)', ((await text('[data-quick-create-status-note]')) ?? '').includes('첫 상태로만'))
    await click('[data-quick-create-status]')
    await click('[data-quick-create-kind="bug"]'); await sleep(400)
    judge('C8 Bug 필수 필드 상자', await exists('[data-quick-create-required]'))
    await shot('c8-required')
    await closeModal()
  },
  async c9() {
    const before = creates()
    await openModal()
    await setValue('[data-quick-create-title]', `연타 ${Date.now()}`)
    await click('[data-quick-create-submit]'); await click('[data-quick-create-submit]')
    await key('[data-quick-create-title]', { key: 'Enter', metaKey: true }); await key('[data-quick-create-title]', { key: 'Enter' })
    const during = await phase()
    judge('C9 보내는 중 표시(1.5초 지연 동안)', during === 'sending' || during === 'late', during)
    await sleep(4000)
    const delta = creates() - before
    judge('C9 연타(만들기 2·⌘↵·Enter) = 출처 만들기 1회(로그 work.request createItem 줄)', delta === 1, { before, delta })
  },
  async c5() {
    const needle = `초안관문${Date.now()}`
    await openModal()
    await setValue('[data-quick-create-title]', needle)
    await setValue('[data-quick-create-body]', `${needle} 본문`)
    await shot('c5-draft-note')
    await closeModal()
    await openModal()
    judge('C5 다시 열면 초안 복원', (await value('[data-quick-create-title]')) === needle)
    await closeModal()
    fs.writeFileSync(path.join(OUT, 'c5-needle.txt'), needle)
    judge('C5 초안 글이 userData 어디에도 없음(draft-leak 0)', leak(needle) === 0)
  },
  async 'after-restart'() {
    const needle = fs.readFileSync(path.join(OUT, 'c5-needle.txt'), 'utf8')
    await until(`!!${q('[data-tasks-open]')}`, { timeoutMs: 30_000, label: '사이드바' })
    await click('[data-tasks-open]')
    await until(`!!${q('[data-tasks-create]')}`, { timeoutMs: 20_000, label: '머리 「만들기」' })
    await openModal()
    judge('C5 재시작 뒤 초안 없음(메모리 전용)', (await value('[data-quick-create-title]')) === '')
    await closeModal()
    judge('C5 재시작 뒤에도 디스크에 초안 글 없음', leak(needle) === 0)
  },
  async c6() {
    await openModal()
    const title = `상세로 ${Date.now()}`
    await setValue('[data-quick-create-title]', title)
    await key('[data-quick-create-title]', { key: 'Enter' })
    await until(`!${q('[data-quick-create]')}`, { timeoutMs: 15_000, label: '닫힘(끔)' })
    await until(`!!${q('[data-issue-detail]')}`, { timeoutMs: 15_000, label: '상세' })
    await shot('c6-detail-after-create')
    judge('C6 끔 = 상세 열림', true)
    await openModal(); await click('[data-quick-create-another]')
    await setValue('[data-quick-create-title]', `하나 더 ${Date.now()}`)
    await key('[data-quick-create-title]', { key: 'Enter' }); await sleep(4000)
    judge('C6 켬 = 모달 유지·제목 비움', (await exists('[data-quick-create]')) && (await value('[data-quick-create-title]')) === '')
    await shot('c6-another-on')
    await click('[data-quick-create-another]'); await closeModal()
  },
  async c7() {
    await click('[data-board-column] [data-inline-add-open]')
    await setValue('[data-inline-add]', `인라인 ${Date.now()}`)
    const before = creates()
    await key('[data-inline-add]', { key: 'Enter' }); await sleep(4000)
    judge('C7 Enter = 만들고 입력은 비운 채 열림', (await value('[data-inline-add]')) === '' && creates() - before === 1)
    await setValue('[data-inline-add]', '쓰다 만 글')
    await js(`${q('[data-inline-add]')}.blur()`); await sleep(300)
    judge('C7 blur = 닫힘', !(await exists('[data-inline-add]')))
    await click('[data-board-column] [data-inline-add-open]')
    judge('R1-O 다시 열면 친 글', (await value('[data-inline-add]')) === '쓰다 만 글')
    await key('[data-inline-add]', { key: 'Escape' })
  },
  async frames() {
    // c12-frames.tsv 의 틀 중 위 단계가 못 찍은 것 — 다크/라이트 두 테마.
    for (const theme of ['dark', 'light']) {
      await js(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`)
      await openModal(); await shot(`c12-modal-${theme}`); await closeModal()
    }
  },
}

const order = picked.length > 0 ? picked : ['setup', 'c1', 'c2', 'c9', 'c5', 'c6', 'c7', 'frames']
try {
  for (const step of order) {
    const run = STEPS[step]
    if (run === undefined) { judge(`단계 ${step}`, false, '없는 단계'); continue }
    note({ kind: 'step', step })
    try { await run() } catch (error) { judge(`단계 ${step}`, false, String(error?.message ?? error)) }
  }
} finally { cdp.close() }
const failed = verdicts.filter((entry) => !entry.pass)
fs.writeFileSync(path.join(OUT, 'verdict.json'), JSON.stringify({ steps: order, verdicts, failed: failed.length }, null, 2))
console.log(failed.length === 0 ? 'drive: 전부 통과' : `drive: 미달 ${failed.length}`)
process.exit(failed.length === 0 ? 0 : 1)
