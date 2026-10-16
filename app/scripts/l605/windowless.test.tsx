// @vitest-environment happy-dom
// LIFE-605 R1-Y — 창 없는 Jira 하네스(최종 관문 C1④⑤·C5 몫). **Electron 창을 띄우지 않는다**(LIFE-603 K1). LIFE-604 `scripts/l604/windowless.test.tsx` 를 본떴다.
// main 의 작업 경로를 `src/main/index.ts` 와 같은 부품으로 잇는다: WorkConnectionStore(연결 파일) · WorkActivityStore · CredentialVault(measurementCipher — 격리 실행 cipher) ·
// WorkSourceRegistry(LA 가짜 주소 + Jira 출처 → 같은 프로세스의 Jira REST fixture 127.0.0.1) · WorkService · log(openLog = CORRAL_LOG 파일) · UiPrefsStore.
// preload IPC 자리는 window.corral 로 같은 메서드를 부른다. 렌더러는 happy-dom 의 실제 TasksPage. **실제 Jira 사이트에 닿지 않는다**(fixture 주소만, 가짜 자격만).
//
//   app/ 에서: L605_ROOT=/tmp/l605w-<n> L605_PHASE=first   npx vitest run scripts/l605/windowless.test.tsx   → 연결·목록·질의 검색(요청 수)·폴백·쓰기 · 디스크·로그 grep
//              L605_ROOT=/tmp/l605w-<n> L605_PHASE=restart npx vitest run scripts/l605/windowless.test.tsx   → 새 프로세스 = 재시작 뒤 연결 유지·카드 표시 칸·grep
//              L605_ROOT=/tmp/l605w-<n> L605_PHASE=lifecycle …   → (restart 뒤) 실패한 추가 · 토큰 교체 · 해제를 지날 때마다 grep(R2-K). L605_PC=leak 이면 교체 뒤 새 토큰을 로그에.
// 양성 대조(판정이 늘 참이 아님을 보인다 — 시험이 실패해야 한다): L605_PC=leak(일부러 새게 한 빌드 — 토큰·Basic 값을 main 로그에 한 줄 → grep 적중) ·
// L605_PC=search-twice(디바운스를 건너뛴 것처럼 같은 질의를 한 번 더 보냄 → 요청 수 2).
// L605_ROOT·L605_PHASE 가 **둘 다** 없을 때만 건너뛴다(npm test 에서는 skipped). 하나라도 있으면 ROOT 가 `/tmp/l605w-*` 이고 PHASE 가 first·restart 여야 한다(빈 값 포함 실패).
// 결과 = ROOT/windowless-<phase>.json(판정 verdict 포함) · 판정이 틀리면 시험 실패(exit 1). 최종 관문은 「1 passed」 를 본다 — 「skipped」 는 무효.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { request as httpRequest } from 'node:http'
import path from 'node:path'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { WorkRequest, WorkResponse, WorkSettingsState } from '../../src/shared/work.js'
import { closeLog, log, openLog } from '../../src/main/log.js'
import { UiPrefsStore, type UiPrefs } from '../../src/main/ui-prefs.js'
import { WorkActivityStore } from '../../src/main/work/activity-store.js'
import { basicHeader } from '../../src/main/work/jira-http.js'
import { JiraRestFixture } from '../../src/main/work/jira-rest-fixture.js'
import { jiraSourceEntry } from '../../src/main/work/jira-source.js'
import { laSourceEntry } from '../../src/main/work/la-source.js'
import { WorkService } from '../../src/main/work/service.js'
import { WorkSourceRegistry } from '../../src/main/work/source.js'
import { WorkConnectionStore } from '../../src/main/work/store.js'
import { FAKE_JIRA_EMAIL, FAKE_JIRA_TOKEN, JIRA_ACCOUNT } from '../../src/main/work/test-kit.js'
import { CredentialVault, measurementCipher } from '../../src/main/work/vault.js'
import { SEARCH_DEBOUNCE_MS } from '../../src/renderer/src/hooks/useTasksPage.js'
import { TasksPage } from '../../src/renderer/src/components/TasksPage.js'

const ROOT = process.env.L605_ROOT ?? ''
const PHASE = process.env.L605_PHASE ?? ''
const PC = process.env.L605_PC ?? ''
const enabled = ROOT.startsWith('/tmp/l605w-') && !ROOT.includes('..')
const requested = ROOT !== '' || PHASE !== ''
const UD = path.join(ROOT, 'ud')
const APP = path.resolve(import.meta.dirname, '../..')
const QUERY = 'status = Done'
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const settle = async (rounds = 12): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
}
const settleQuery = (): Promise<void> => settle(Math.ceil(SEARCH_DEBOUNCE_MS / 5) + 30)

/** happy-dom 의 fetch 는 CORS 로 127.0.0.1 fixture 응답을 막는다 — main 은 Node fetch 를 쓰므로 node:http 로 같은 일(TasksPage.jira.test 와 같은 다리). 리다이렉트는 따라가지 않는다. */
const nodeFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const headers = Object.fromEntries(new Headers(init?.headers).entries())
  const body = typeof init?.body === 'string' ? init.body : undefined
  return await new Promise<Response>((resolve, reject) => {
    const outgoing = httpRequest({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: init?.method ?? 'GET', headers }, (incoming) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') responseHeaders.set(name, value)
        const status = incoming.statusCode ?? 500
        resolve(new Response(status === 204 ? null : Buffer.concat(chunks).toString('utf8'), { status, headers: responseHeaders }))
      })
      incoming.on('error', reject)
    })
    outgoing.on('error', reject)
    init?.signal?.addEventListener('abort', () => outgoing.destroy(new Error('aborted')))
    outgoing.end(body)
  })
}

let listener: (value: WorkSettingsState) => void = () => {}

/** index.ts 의 작업 배선과 같은 부품 — 경로만 ROOT 아래, Jira 주소만 fixture. */
async function boot(): Promise<{ service: WorkService; prefs: UiPrefsStore; fixture: JiraRestFixture }> {
  fs.mkdirSync(UD, { recursive: true, mode: 0o700 })
  process.env.CORRAL_LOG = path.join(UD, 'corral.ndjson')
  openLog(UD)
  const fixture = new JiraRestFixture()
  fixture.allow({ email: FAKE_JIRA_EMAIL, token: FAKE_JIRA_TOKEN })
  fixture.allow({ email: FAKE_JIRA_EMAIL, token: SECOND_TOKEN })
  const url = await fixture.start()
  const prefs = new UiPrefsStore(UD)
  prefs.load()
  const store = new WorkConnectionStore(UD)
  store.load()
  const activity = new WorkActivityStore(UD)
  activity.load()
  const service = new WorkService({
    store, vault: new CredentialVault(measurementCipher()), activity,
    sources: new WorkSourceRegistry([laSourceEntry({ url: 'http://127.0.0.1:9/mcp', clientVersion: 'l605-windowless' }), jiraSourceEntry({ baseUrlOf: () => url, fetchImpl: nodeFetch, sleep: async () => {} })]),
    repos: () => [], onChange: (value) => listener(value),
  })
  return { service, prefs, fixture }
}

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
  await settle(20)
  return { host, unmount: () => { act(() => root.unmount()); host.remove() } }
}
const typeSearch = (host: HTMLElement, value: string): void => {
  const input = host.querySelector('[data-tasks-search]')
  if (!(input instanceof HTMLInputElement)) throw new Error('검색 칸 없음')
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const flushLog = async (): Promise<void> => { closeLog(); await new Promise((resolve) => setTimeout(resolve, 100)) }

/** 자격 글 grep — 토큰 · Basic 값 · base64 · `이메일:토큰` 은 어디에도, 이메일은 연결 파일 표시 칸 밖에. 글은 needles.json(ROOT 아래, ud 밖)에만. */
/** lifecycle 단계가 쓰는 두 번째(교체) 토큰·틀린 토큰 — 가짜. 둘 다 grep 바늘에 든다. */
const SECOND_TOKEN = 'ATATTwindowless0second00000000000000jira'
const WRONG_TOKEN = 'ATATTwindowless0wrong000000000000000jira'
function secretGrep(): { status: number | null; out: unknown } {
  const needles: { label: string; value: string; allowIn?: string[] }[] = [FAKE_JIRA_TOKEN, SECOND_TOKEN, WRONG_TOKEN].flatMap((token, index) => {
    const basic = basicHeader({ email: FAKE_JIRA_EMAIL, token })
    return [
      { label: `token${index}`, value: token },
      { label: `basic${index}`, value: basic },
      { label: `basic64-${index}`, value: basic.slice('Basic '.length) },
      { label: `email-token${index}`, value: `${FAKE_JIRA_EMAIL}:${token}` },
    ]
  })
  needles.push({ label: 'email', value: FAKE_JIRA_EMAIL, allowIn: ['work-connections.json'] })
  const file = path.join(ROOT, 'needles.json')
  fs.writeFileSync(file, JSON.stringify(needles))
  const run = spawnSync(process.execPath, [path.join(APP, 'scripts/l605/secret-grep.mjs'), UD, file], { encoding: 'utf8' })
  let out: unknown = run.stdout
  try { out = JSON.parse(run.stdout) } catch { /* 글 그대로 */ }
  return { status: run.status, out }
}
const grepClean = (run: { status: number | null; out: unknown }): boolean => {
  if (run.status !== 0 || typeof run.out !== 'object' || run.out === null) return false
  const files: unknown = Reflect.get(run.out, 'files')
  const hits: unknown = Reflect.get(run.out, 'hits')
  return typeof files === 'number' && files >= 2 && Array.isArray(hits) && hits.length === 0
}

describe.runIf(requested)('LIFE-605 창 없는 Jira 하네스', () => {
  it(`phase ${PHASE}`, async () => {
    expect({ root: enabled, phase: PHASE === 'first' || PHASE === 'restart' || PHASE === 'lifecycle' }, `L605_ROOT=/tmp/l605w-* · L605_PHASE=first|restart|lifecycle 가 필요하다 (지금 ROOT='${ROOT}' PHASE='${PHASE}')`).toEqual({ root: true, phase: true })
    const result: Record<string, unknown> = { phase: PHASE, at: new Date().toISOString() }
    const parts = await boot()
    bridge(parts)
    try {
      if (PHASE === 'first') {
        const added = await parts.service.addConnection({ sourceId: 'jira', token: FAKE_JIRA_TOKEN, account: JIRA_ACCOUNT, replaceId: null })
        if (!added.ok) throw new Error(added.error.message)
        result.connection = { ok: true, account: added.connection.account }
        parts.prefs.update({ tasksPage: { space: { kind: 'space', connectionId: added.connection.id, spaceKey: 'CORE' }, view: 'board' } })
        const { host, unmount } = await page()
        result.c1Card = host.querySelector('[data-issue-card="CORE-1"]') !== null
        // C5 — 질의 검색: 이어 쳐도 멈춘 뒤 한 번(요청 수) · 결과 「질의」 · 거부되면 텍스트 + 사유 줄.
        const jqlSent = (): string[] => parts.fixture.requests.filter((request) => request.path === '/rest/api/3/search/jql').map((request) => request.query.jql ?? '')
        const before = jqlSent().length
        for (const value of ['status', 'status =', 'status = D', QUERY]) { typeSearch(host, value); await settle(2) }
        await settleQuery()
        if (PC === 'search-twice') await parts.service.request({ requestId: 'l605-pc-search', connectionId: added.connection.id, call: { op: 'searchItems', spaceKeys: ['CORE'], query: QUERY } })
        const sent = jqlSent().slice(before).filter((jql) => jql.includes(QUERY))
        result.c5Query = { requests: sent.length, hits: host.querySelectorAll('[data-search-hit="query"]').length }
        typeSearch(host, '랜딩 ==')
        await settleQuery()
        result.c5Fallback = { note: host.querySelector('[data-search-note]')?.textContent?.includes('텍스트') === true }
        // 쓰기 한 번(코멘트) — 쓰기 경로의 로그·활동도 grep 대상에 든다.
        const comment = await parts.service.request({ requestId: 'l605-comment', connectionId: added.connection.id, call: { op: 'addComment', itemId: '20001', body: '하네스 코멘트' } })
        result.write = comment.ok
        unmount()
        if (PC === 'leak') log('l605.pc', { leaked: `${FAKE_JIRA_TOKEN} ${basicHeader({ email: FAKE_JIRA_EMAIL, token: FAKE_JIRA_TOKEN })}` })
        await flushLog()
        const secrets = secretGrep()
        result.c1Secrets = secrets
        result.verdict = { c1Card: result.c1Card, c5Query: result.c5Query, c5Fallback: result.c5Fallback, write: result.write, c1Secrets: grepClean(secrets) }
      } else if (PHASE === 'lifecycle') {
        // R2-K — 오류 문구가 새는 길(실패한 추가 · 토큰 교체 · 해제)을 지난 뒤마다 grep. restart 뒤에 돈다(연결 파일이 있다).
        const connection = parts.service.settings().connections.find((entry) => entry.sourceId === 'jira')
        if (connection === undefined) throw new Error('restart 뒤에 돌린다')
        const failedAdd = await parts.service.addConnection({ sourceId: 'jira', token: WRONG_TOKEN, account: JIRA_ACCOUNT, replaceId: null })
        await flushLog(); openLog(UD)
        const afterFailedAdd = secretGrep()
        const replaced = await parts.service.addConnection({ sourceId: 'jira', token: SECOND_TOKEN, account: JIRA_ACCOUNT, replaceId: connection.id })
        const listed = await parts.service.request({ requestId: 'l605-life-list', connectionId: connection.id, call: { op: 'listSpaces' } })
        if (PC === 'leak') log('l605.pc', { leaked: SECOND_TOKEN })
        await flushLog(); openLog(UD)
        const afterReplace = secretGrep()
        const removed = parts.service.removeConnection({ connectionId: connection.id })
        await flushLog()
        const afterRemove = secretGrep()
        result.c1Lifecycle = { failedAdd: failedAdd.ok, replaced: replaced.ok, listed: listed.ok, removed: removed.ok, left: parts.service.settings().connections.length }
        result.c1Secrets = { afterFailedAdd, afterReplace, afterRemove }
        result.verdict = { c1Lifecycle: result.c1Lifecycle, c1Secrets: { afterFailedAdd: grepClean(afterFailedAdd), afterReplace: grepClean(afterReplace), afterRemove: grepClean(afterRemove) } }
      } else {
        // 재시작 = 새 프로세스 — 연결 파일·봉인에서 연결이 돌아오고, 카드 표시 칸(사이트·이메일)이 그대로, 조회가 된다.
        const connection = parts.service.settings().connections.find((entry) => entry.sourceId === 'jira')
        result.c1Restart = { found: connection !== undefined, account: connection?.account ?? null }
        const { host, unmount } = await page()
        result.c1Card = host.querySelector('[data-issue-card="CORE-1"]') !== null
        unmount()
        if (PC === 'leak') log('l605.pc', { leaked: FAKE_JIRA_TOKEN })
        await flushLog()
        const secrets = secretGrep()
        result.c1Secrets = secrets
        result.verdict = { c1Restart: result.c1Restart, c1Card: result.c1Card, c1Secrets: grepClean(secrets) }
      }
    } finally {
      await parts.fixture.stop()
    }
    fs.writeFileSync(path.join(ROOT, `windowless-${PHASE}.json`), JSON.stringify(result, null, 2))
    const account = { site: 'fixture.atlassian.net', email: FAKE_JIRA_EMAIL }
    const want = {
      first: { c1Card: true, c5Query: { requests: 1, hits: expect.any(Number) }, c5Fallback: { note: true }, write: true, c1Secrets: true },
      restart: { c1Restart: { found: true, account }, c1Card: true, c1Secrets: true },
      lifecycle: { c1Lifecycle: { failedAdd: false, replaced: true, listed: true, removed: true, left: 0 }, c1Secrets: { afterFailedAdd: true, afterReplace: true, afterRemove: true } },
    }
    expect(result.verdict).toEqual(PHASE === 'first' ? want.first : PHASE === 'restart' ? want.restart : want.lifecycle)
  }, 120_000)
})
