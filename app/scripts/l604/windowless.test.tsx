// @vitest-environment happy-dom
// LIFE-604 R2-B — 창 없는 작업 하네스(최종 관문 C9·C5·C10 몫, 코디 답 A). **Electron 창을 띄우지 않는다.**
// main 의 작업 경로를 `src/main/index.ts` 와 같은 부품으로 그대로 잇는다: WorkConnectionStore(연결 파일) · WorkActivityStore(활동 파일) ·
// CredentialVault(measurementCipher — 격리 실행 cipher) · WorkSourceRegistry(LA 가짜 주소 + 모의 출처) · WorkService · log(openLog = CORRAL_LOG 파일) ·
// UiPrefsStore(ui-prefs 파일). preload IPC 자리는 window.corral 로 같은 메서드를 부른다(실제 Chromium·preload 는 창 회차 몫).
// 렌더러는 happy-dom 의 실제 TasksPage. 판정 = count-creates(로그) · draft-leak(ROOT/ud 전체) · 활동 파일.
//
//   app/ 에서: L604_ROOT=/tmp/l604w-<n> L604_PHASE=first   npx vitest run scripts/l604/windowless.test.tsx   → 만들기·초안·활동
//              L604_ROOT=/tmp/l604w-<n> L604_PHASE=restart npx vitest run scripts/l604/windowless.test.tsx   → 새 프로세스 = 재시작 뒤
// 양성 대조(판정이 늘 참이 아님을 보인다 — 시험이 실패해야 한다): L604_PC=c9-extra(같은 만들기 요청을 출처에 한 번 더 → 증가 2) ·
// L604_PC=c5-leak(초안 글을 main 로그에 한 줄 → draft-leak 적중).
// L604_ROOT·L604_PHASE 가 **둘 다** 없을 때만 건너뛴다(npm test 에서는 skipped). 하나라도 있으면 하네스를 부른 회차다 — ROOT 가 `/tmp/l604w-*` 가 아니거나
// PHASE 가 first·restart 가 아니면(빈 값 포함) 건너뛰지 않고 실패한다(R5-F). 최종 관문은 「1 passed」 를 본다 — 「skipped」 는 무효(final-gate-plan ⑦).
// 결과 = ROOT/windowless-<phase>.json(판정 verdict 포함) · 판정이 틀리면 시험 실패(exit 1).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { WorkRequest, WorkResponse, WorkSettingsState } from '../../src/shared/work.js'
import { closeLog, log, openLog } from '../../src/main/log.js'
import { UiPrefsStore, type UiPrefs } from '../../src/main/ui-prefs.js'
import { WorkActivityStore } from '../../src/main/work/activity-store.js'
import { laSourceEntry } from '../../src/main/work/la-source.js'
import { mockSourceEntry, seedMockDemoState } from '../../src/main/work/mock-source.js'
import { WorkService } from '../../src/main/work/service.js'
import { WorkSourceRegistry } from '../../src/main/work/source.js'
import { WorkConnectionStore } from '../../src/main/work/store.js'
import { CredentialVault, measurementCipher } from '../../src/main/work/vault.js'
import { TasksPage } from '../../src/renderer/src/components/TasksPage.js'

const ROOT = process.env.L604_ROOT ?? ''
const PHASE = process.env.L604_PHASE ?? ''
const PC = process.env.L604_PC ?? ''
const enabled = ROOT.startsWith('/tmp/l604w-') && !ROOT.includes('..')
/** 하네스를 부른 회차인가 — 환경변수 하나라도 있으면 그렇다(R5-F). */
const requested = ROOT !== '' || PHASE !== ''
const UD = path.join(ROOT, 'ud')
const APP = path.resolve(import.meta.dirname, '../..')
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const settle = async (rounds = 12): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
}
const node = (script: string, args: string[]): { status: number | null; out: unknown } => {
  const run = spawnSync(process.execPath, [path.join(APP, 'scripts/l604', script), ...args], { encoding: 'utf8' })
  let out: unknown = run.stdout
  try { out = JSON.parse(run.stdout) } catch { /* 글 그대로 */ }
  return { status: run.status, out }
}

/** index.ts 의 작업 배선과 같은 부품 — 경로만 ROOT 아래. */
function boot(): { service: WorkService; prefs: UiPrefsStore; activity: WorkActivityStore } {
  fs.mkdirSync(UD, { recursive: true, mode: 0o700 })
  process.env.CORRAL_LOG = path.join(UD, 'corral.ndjson')
  openLog(UD)
  const prefs = new UiPrefsStore(UD)
  prefs.load()
  const store = new WorkConnectionStore(UD)
  store.load()
  const activity = new WorkActivityStore(UD)
  activity.load()
  const service = new WorkService({
    store, vault: new CredentialVault(measurementCipher()), activity,
    sources: new WorkSourceRegistry([laSourceEntry({ url: 'http://127.0.0.1:9/mcp', clientVersion: 'l604-windowless' }), mockSourceEntry({ state: seedMockDemoState() })]),
    repos: () => [], onChange: (value) => listener(value),
  })
  return { service, prefs, activity }
}
let listener: (value: WorkSettingsState) => void = () => {}

function bridge({ service, prefs }: { service: WorkService; prefs: UiPrefsStore }): void {
  Reflect.set(window, 'corral', {
    getUiPrefs: async () => prefs.get(),
    setUiPrefs: (patch: Partial<UiPrefs>) => prefs.update(patch),
    getWorkSettings: async () => service.settings(),
    onWorkSettings: (next: (value: WorkSettingsState) => void) => { listener = next; return () => {} },
    workActivity: async () => ({ ok: true, records: [] }),
    workRequest: (request: WorkRequest): Promise<WorkResponse> => service.request(request),
  })
}

async function page(): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(createElement(TasksPage, { open: true, repos: [], activeRepoRoot: null, shortcut: '⌘I', yieldKeys: false, onClose: () => {}, onOpenSettings: () => {}, onOpenWorktree: () => {} })))
  await settle()
  return { host, unmount: () => { act(() => root.unmount()); host.remove() } }
}
const setValue = (input: Element | null, value: string): void => {
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) throw new Error('입력 없음')
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => { Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const enter = (target: Element | null, init: KeyboardEventInit = {}): void => {
  if (target === null) throw new Error('대상 없음')
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }))
}
const createCount = (out: unknown): number => {
  const count: unknown = typeof out === 'object' && out !== null ? Reflect.get(out, 'count') : null
  return typeof count === 'number' ? count : Number.NaN
}
/** draft-leak 결과 — exit 0 · 읽은 파일 ≥1 · 적중 0 일 때만 참(읽은 게 없으면 관측 없음). */
const leakFree = (run: unknown): boolean => {
  if (typeof run !== 'object' || run === null || Reflect.get(run, 'status') !== 0) return false
  const out: unknown = Reflect.get(run, 'out')
  if (typeof out !== 'object' || out === null) return false
  const hits: unknown = Reflect.get(out, 'hits')
  const files: unknown = Reflect.get(out, 'files')
  return Array.isArray(hits) && hits.length === 0 && typeof files === 'number' && files > 0
}
const flushLog = async (): Promise<void> => { closeLog(); await new Promise((resolve) => setTimeout(resolve, 100)) }

describe.runIf(requested)('LIFE-604 창 없는 작업 하네스', () => {
  it(`phase ${PHASE}`, async () => {
    // 빈·모르는 PHASE 를 first 로 읽거나 건너뛰지 않는다 — 아무것도 안 하고 통과하는 길을 막는다(R5-F).
    expect({ root: enabled, phase: PHASE === 'first' || PHASE === 'restart' }, `L604_ROOT=/tmp/l604w-* · L604_PHASE=first|restart 가 필요하다 (지금 ROOT='${ROOT}' PHASE='${PHASE}')`).toEqual({ root: true, phase: true })
    const result: Record<string, unknown> = { phase: PHASE, at: new Date().toISOString() }
    const parts = boot()
    bridge(parts)
    if (PHASE === 'first') {
      const added = await parts.service.addConnection({ sourceId: 'mock-jira', token: 'mock_l604_windowless', replaceId: null })
      result.connection = added.ok
      if (!added.ok) throw new Error(added.error.message)
      parts.prefs.update({ tasksPage: { space: { kind: 'space', connectionId: added.connection.id, spaceKey: 'CORE' }, view: 'board' } })
      const { host, unmount } = await page()
      // C9 — 같은 틱 만들기·⌘↵·Enter → 로그 work.request createItem 증가 1
      const before = node('count-creates.mjs', [path.join(UD, 'corral.ndjson')])
      host.ownerDocument.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true, cancelable: true }))
      await settle()
      const title = `하네스 만들기 ${Date.now()}`
      setValue(host.querySelector('[data-quick-create-title]'), title)
      act(() => {
        host.querySelector<HTMLElement>('[data-quick-create-submit]')?.click()
        enter(host.querySelector('[data-quick-create-title]'), { metaKey: true })
        enter(host.querySelector('[data-quick-create-title]'))
      })
      await settle(30)
      if (PC === 'c9-extra') await parts.service.request({ requestId: 'l604-pc-c9', connectionId: added.connection.id, call: { op: 'createItem', spaceKey: 'CORE', parentId: null, kindKey: 'story', title: `${title} pc` } })
      await flushLog()
      openLog(UD)
      const after = node('count-creates.mjs', [path.join(UD, 'corral.ndjson')])
      result.c9 = { before: before.out, after: after.out }
      // C10 — 활동 파일에 「만들었음」 1건
      const records = fs.readFileSync(parts.activity.file, 'utf8')
      result.c10 = { createdLines: (records.match(/"field":"created"/g) ?? []).length }
      // C5 — 초안을 남기고 디스크 전체에서 찾는다(0 이어야)
      const needle = `하네스초안${Date.now()}`
      host.ownerDocument.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true, cancelable: true }))
      await settle()
      setValue(host.querySelector('[data-quick-create-title]'), needle)
      setValue(host.querySelector('[data-quick-create-body]'), `${needle} 본문`)
      act(() => { host.querySelector<HTMLElement>('[data-quick-create-cancel]')?.click() })
      await settle()
      if (PC === 'c5-leak') log('l604.pc', { draft: needle })
      await flushLog()
      fs.writeFileSync(path.join(ROOT, 'c5-needle.txt'), needle)
      result.c5 = node('draft-leak.mjs', [UD, needle])
      unmount()
      result.verdict = { c9: createCount(after.out) - createCount(before.out) === 1, c10: result.c10, c5: leakFree(result.c5) }
    } else {
      // 재시작 = 새 프로세스. 활동 기록 유지·중복 0 · 초안 없음 · 디스크 누출 0.
      const records = fs.readFileSync(parts.activity.file, 'utf8')
      result.c10 = { createdLines: (records.match(/"field":"created"/g) ?? []).length }
      const { host, unmount } = await page()
      host.ownerDocument.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true, cancelable: true }))
      await settle()
      const titleInput = host.querySelector('[data-quick-create-title]')
      result.c5Restart = { modal: titleInput !== null, title: titleInput instanceof HTMLInputElement ? titleInput.value : null }
      await flushLog()
      const needle = fs.readFileSync(path.join(ROOT, 'c5-needle.txt'), 'utf8')
      result.c5 = node('draft-leak.mjs', [UD, needle])
      unmount()
      result.verdict = { c10: result.c10, c5Restart: result.c5Restart, c5: leakFree(result.c5) }
    }
    fs.writeFileSync(path.join(ROOT, `windowless-${PHASE}.json`), JSON.stringify(result, null, 2))
    expect(result.verdict).toEqual(PHASE === 'first'
      ? { c9: true, c10: { createdLines: 1 }, c5: true }
      : { c10: { createdLines: 1 }, c5Restart: { modal: true, title: '' }, c5: true })
  }, 60_000)
})
