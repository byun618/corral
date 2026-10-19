#!/usr/bin/env node
// LIFE-604 R1-G ① — 최종 관문 격리 앱 구동기(CDP). **수정 1·2 에서는 만들기만 하고 돌리지 않았다** — 최종 관문(창 회차, 손 넘김 뒤)이 돈다(final-gate-plan.md).
//   먼저: npm run build → L604_HANDOFF=<질의응답 답 id> sh scripts/l604/up.sh <ROOT> L604_EXTRA_ARGS=--remote-debugging-port=<PORT>
//   node scripts/l604/drive.mjs <ROOT=/tmp/l604g-*> <OUT 폴더> [단계…]     단계 기본 = 전부: setup c1 c1blocked c2 c8 all c9 c5 c6 c7 frames
// 판정은 모두 화면·로그에서 읽은 값이다(R2-C — 상수 참 판정 없음). 스페이스 바꾸기 = ui-prefs 에 쓰고 렌더러를 다시 싣는다(prefs 는 첫 싣기에만 읽힌다).
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
/** 연결 id — setup·c1blocked·c8 이 더한다. 판정에 쓰는 「연결 하나의 CORE 스페이스」 를 고르는 데 쓴다. */
const conns = {}
const addConnection = async (token) => js(`window.corral.addWorkConnection({ sourceId: 'mock-jira', token: ${JSON.stringify(token)}, replaceId: null }).then((r) => ({ ok: r.ok, id: r.ok ? r.connection.id : null }))`)
/** 스페이스를 ui-prefs 에 쓰고 렌더러를 다시 실어 작업 페이지를 그 스페이스로 연다. space = { kind: 'all' } | { kind: 'space', connectionId, spaceKey }. */
async function openOn(space) {
  await js(`(window.corral.setUiPrefs({ tasksPage: { space: ${JSON.stringify(space)}, view: 'board' } }), true)`)
  await sleep(500)
  await js('(location.reload(), true)')
  await sleep(1500)
  await until(`!!${q('[data-tasks-open]')}`, { timeoutMs: 30_000, label: '다시 실은 뒤 사이드바' })
  await click('[data-tasks-open]')
  await until(`!!${q('[data-tasks-create]')}`, { timeoutMs: 20_000, label: '머리 「만들기」' })
}
/** 상세 활동 목록의 「만들었음」 줄 수(R3-J — C10 렌더 단계). 활동은 받는 데 시간이 걸려 잠깐 기다린다. */
async function createdRows() {
  await until(`!!${q('[data-issue-detail] [data-issue-activity]')}`, { timeoutMs: 10_000, label: '상세 활동' })
  await sleep(1000)
  return js(`[...document.querySelectorAll('[data-issue-detail] [data-activity-row]')].filter((row) => row.textContent.includes('만들었음')).length`)
}
const cardsWithTitle = (title) => js(`[...document.querySelectorAll('[data-issue-card]')].filter((card) => card.textContent.includes(${JSON.stringify(title)})).length`)

const STEPS = {
  async setup() {
    await until(`!!${q('[data-tasks-open]')}`, { timeoutMs: 30_000, label: '사이드바 「작업」' })
    const added = await addConnection('mock_l604_gate_delay-1500')
    judge('setup 모의 연결(가짜 토큰, 1.5초 지연 — 연타 관측용)', added?.ok === true, added)
    conns.main = added?.id ?? null
    await openOn({ kind: 'space', connectionId: conns.main, spaceKey: 'CORE' })
    await until(`!!${q('[data-tasks-board] [data-issue-card]')}`, { timeoutMs: 20_000, label: '보드 카드' })
  },
  async c1() {
    const order = await js(`[...${q('.tasks-head')}.children].map((c) => c.hasAttribute('data-tasks-search') ? 's' : c.hasAttribute('data-tasks-create') ? 'c' : c.hasAttribute('data-tasks-close') ? 'x' : '').filter(Boolean).join('')`)
    judge('C1① 머리 「만들기」 검색과 닫기 사이', order === 'scx', order)
    await shot('c1-head')
    await click('[data-tasks-create]'); await sleep(400)
    judge('C1① 누르면 모달', await exists('[data-quick-create]')); await closeModal()
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
  async c1blocked() {
    // 쓰기 막힘 — 권한 부족 연결(fault-forbidden)의 스페이스: 머리 「만들기」 흐림 + 이유, 누르거나 C 를 쳐도 모달이 안 열린다.
    const added = await addConnection('mock_l604_gate_fault-forbidden')
    conns.forbidden = added?.id ?? null
    await openOn({ kind: 'space', connectionId: conns.forbidden, spaceKey: 'CORE' })
    await until(`!!${q('[data-tasks-banner]')}`, { timeoutMs: 15_000, label: '권한 배너' })
    const head = await js(`(() => { const el = ${q('[data-tasks-create]')}; return el ? { disabled: el.getAttribute('aria-disabled'), dim: el.classList.contains('is-disabled'), title: el.getAttribute('title') } : null })()`)
    judge('C1 쓰기 막힘 = 머리 「만들기」 흐림(aria-disabled·is-disabled) + 이유(권한)', head?.disabled === 'true' && head.dim === true && (head.title ?? '').includes('권한'), head)
    await shot('c1-write-blocked')
    await click('[data-tasks-create]'); await key(null, { key: 'c', code: 'KeyC' }); await sleep(400)
    judge('C1 쓰기 막힘 = 누름·C 로 모달 안 열림', !(await exists('[data-quick-create]')))
    await openOn({ kind: 'space', connectionId: conns.main, spaceKey: 'CORE' })
  },
  async c8() {
    // 지원 밖 필수 필드 — createmeta-unsupported 연결의 Epic: 「corral 에서 채울 수 없음」 + 만들기 막힘 + 연타해도 출처 만들기 0.
    const added = await addConnection('mock_l604_gate_createmeta-unsupported')
    conns.unsupported = added?.id ?? null
    await openOn({ kind: 'space', connectionId: conns.unsupported, spaceKey: 'CORE' })
    await openModal()
    await setValue('[data-quick-create-title]', `에픽 ${Date.now()}`)
    await click('[data-quick-create-kind="epic"]'); await sleep(600)
    const before = creates()
    const shape = await js(`({ text: ${q('[data-quick-create-unsupported]')}?.textContent ?? null, submitDisabled: ${q('[data-quick-create-submit]')}?.hasAttribute('disabled') ?? null })`)
    await key('[data-quick-create-title]', { key: 'Enter' }); await sleep(1000)
    judge('C8 지원 밖 필수 필드 = 「corral 에서 채울 수 없음」 · 만들기 막힘 · Enter 로도 출처 만들기 0', (shape?.text ?? '').includes('corral 에서 채울 수 없음') && shape.submitDisabled === true && creates() - before === 0, shape)
    await shot('c8-unsupported')
    await closeModal()
    await openOn({ kind: 'space', connectionId: conns.main, spaceKey: 'CORE' })
  },
  async all() {
    // 「전체」 스페이스 — 모달 머리에 만들 스페이스가 보이고 고를 수 있다 · 보드 분류 칸에는 「+ 추가」 가 없다.
    await openOn({ kind: 'all' })
    await sleep(1500)
    judge('「전체」 보드 칸 「+ 추가」 없음', !(await exists('[data-inline-add-open]')))
    await openModal()
    const target = await text('[data-quick-create-target]')
    await click('[data-quick-create-target]'); await sleep(300)
    const rows = await js(`[...document.querySelectorAll('[data-quick-create-target-row]')].map((row) => row.getAttribute('data-quick-create-target-row'))`)
    judge('「전체」 모달 머리 = 만들 스페이스 표시 + 고르기 목록', typeof target === 'string' && target.length > 0 && Array.isArray(rows) && rows.length >= 1, { target, rows })
    await shot('c1-all-target')
    await closeModal()
    await openOn({ kind: 'space', connectionId: conns.main, spaceKey: 'CORE' })
  },
  async c2() {
    await openModal()
    await shot('c2-modal-empty')
    await click('[data-quick-create-status]'); await shot('c2-status-note')
    judge('C2 상태 각주(첫 상태만)', ((await text('[data-quick-create-status-note]')) ?? '').includes('첫 상태로만'))
    await click('[data-quick-create-status]')
    await click('[data-quick-create-kind="bug"]'); await sleep(400)
    judge('C8 Bug 필수 필드 상자', await exists('[data-quick-create-required]'))
    // R2-H — 모의 출처는 배치를 받는다(applies): 배치 칩이 켜져 있어야 한다(LA bug 도 LIFE-665 부터 applies — 흐림은 Jira·모의 placement-ignored 만).
    judge('R2-H 모의 Bug 배치 칩 켜짐', (await js(`${q('[data-quick-create-placement]')}?.hasAttribute('disabled') ?? null`)) === false)
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
    // R3-J — c6 에서 만든 작업의 상세 활동 「만들었음」 이 재시작 뒤에도 1줄(활동 파일을 다시 읽어 그린다).
    if (fs.existsSync(path.join(OUT, 'c6-title.txt'))) {
      const made = fs.readFileSync(path.join(OUT, 'c6-title.txt'), 'utf8')
      await until(`[...document.querySelectorAll('[data-issue-card]')].some((card) => card.textContent.includes(${JSON.stringify(made)}))`, { timeoutMs: 15_000, label: '만든 카드' })
      await js(`[...document.querySelectorAll('[data-issue-card]')].find((card) => card.textContent.includes(${JSON.stringify(made)}))?.click()`)
      await until(`${q('[data-issue-detail] [data-issue-title]')}?.value === ${JSON.stringify(made)}`, { timeoutMs: 15_000, label: '만든 작업 상세' })
      const rows = await createdRows()
      judge('C10 재시작 뒤 상세 활동 「만들었음」 1줄', rows === 1, rows)
    } else judge('C10 재시작 뒤 상세 활동(c6 제목 없음 — c6 를 먼저)', false)
  },
  async c6() {
    await openModal()
    const title = `상세로 ${Date.now()}`
    await setValue('[data-quick-create-title]', title)
    const before = creates()
    await key('[data-quick-create-title]', { key: 'Enter' })
    await until(`!${q('[data-quick-create]')}`, { timeoutMs: 15_000, label: '닫힘(끔)' })
    await until(`!!${q('[data-issue-detail] [data-issue-title]')}`, { timeoutMs: 15_000, label: '상세' })
    await sleep(800)
    const detail = await value('[data-issue-detail] [data-issue-title]')
    const toast = await text('[data-toast="created"]')
    judge('C6 끔 = 상세가 만든 작업(제목 같음) · 출처 만들기 1', detail === title && creates() - before === 1, { detail, delta: creates() - before })
    judge('C6 「만들었습니다」 토스트', (toast ?? '').includes('만들었습니다'), toast)
    judge('C6 보드에 만든 카드 1장', (await cardsWithTitle(title)) === 1)
    const rows = await createdRows()
    judge('C10 상세 활동 「만들었음」 1줄', rows === 1, rows)
    fs.writeFileSync(path.join(OUT, 'c6-title.txt'), title)
    await shot('c6-detail-after-create')
    await click('[data-issue-close]'); await sleep(300)
    await openModal(); await click('[data-quick-create-another]')
    const another = `하나 더 ${Date.now()}`
    const beforeAnother = creates()
    await setValue('[data-quick-create-title]', another)
    await key('[data-quick-create-title]', { key: 'Enter' }); await sleep(4000)
    judge('C6 켬 = 모달 유지·제목 비움', (await exists('[data-quick-create]')) && (await value('[data-quick-create-title]')) === '')
    judge('C6 켬 = 출처 만들기 1 · 보드 카드 1장', creates() - beforeAnother === 1 && (await cardsWithTitle(another)) === 1, { delta: creates() - beforeAnother })
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

const order = picked.length > 0 ? picked : ['setup', 'c1', 'c1blocked', 'c2', 'c8', 'all', 'c9', 'c5', 'c6', 'c7', 'frames']
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
