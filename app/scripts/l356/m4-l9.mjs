// M4 — L9. 그룹 닫기 거절 2종을 **UI 로** 일으켜, 사용자에게 그대로 보이고 멈추는지 + corral 이
// close_group:true/force 로 승격하지 않는지 판정한다.
//
// **킥오프 특별 지시**: 거절이 소켓 error payload 로 실제 왔는지 채널을 원자료에 남긴다.
//   채널 증거 = 어댑터 request.ts 가 `frame.error` 를 만났을 때 남기는 `req.rx.error` 로그의
//   `line` (소켓에서 읽은 error_response 원문). 그 줄을 파싱해 error.code 가 있으면 "소켓 error
//   payload 로 왔다" 가 증명된다. 화면 표시는 `.lifecycle-notice-text` (사용자가 보는 문구) 로 교차.
//
// 두 거절:
//   L9b — 열린 linked 그룹의 **primary workspace 를 close_group 없이** 닫기 → workspace_group_close_required
//   L9a — primary 의 **마지막 탭** 닫기 → confirmation_required (이 탭을 닫으면 worktree 그룹이 닫힌다)
// 둘 다 비파괴적이라 같은 그룹에서 연달아 잰다. 승격 금지 감사: 앱의 req.tx 중 workspace.close 에
// close_group":true 가 하나도 없어야 한다 (하네스 정리는 별도 커넥션이라 앱 로그에 안 남는다).

import { herdrRequest, makeScratchRepo, sleep, startApp, until, writeRaw } from './lib.mjs'

const app = await startApp({ name: 'm4-l9' })
const out = { at: new Date().toISOString(), ready: app.ready, l9b: {}, l9a: {}, escalationAudit: {} }

function rxError(method, sinceAt) {
  return app
    .entries()
    .filter((e) => e.tag === 'req.rx.error' && e.method === method && (sinceAt ? e.at >= sinceAt : true))
    .slice(-1)[0] ?? null
}
function rejectedLog(tag, sinceAt) {
  return app.entries().filter((e) => e.tag === tag && (sinceAt ? true : true)).slice(-1)[0] ?? null
}
async function noticeText() {
  const found = (await app.query('.lifecycle-notice-text')).found
  return found[0] ?? null
}
async function noticeCodeFromText() {
  // 화면 문구 "herdr 거절 (<code>): <message>" 에서 code 를 뽑는다 (사용자가 보는 것 그대로).
  const text = await noticeText()
  const m = text ? text.match(/거절 \(([^)]+)\)/) : null
  return m ? m[1] : null
}
async function workspaceCount() {
  return (await herdrRequest('workspace.list', {})).workspaces.length
}
/** 소켓 error payload 인지 — line 을 파싱해 error.code 를 꺼낸다. */
function parseChannel(entry) {
  if (!entry) return { present: false }
  try {
    const frame = JSON.parse(entry.line)
    return { present: true, isSocketError: !!frame.error, code: frame.error?.code ?? null, message: frame.error?.message ?? null, rawLine: entry.line }
  } catch {
    return { present: true, parseFailed: true, rawLine: entry.line }
  }
}

try {
  const repo = makeScratchRepo('m4')
  out.repo = repo.root
  await app.addRepo(repo.root)
  await until(async () => (await app.query(`[data-repo="${repo.root}"]`)).found.length > 0, { what: 'repo row' })

  // primary 열기
  await app.click(`[data-open-worktree="${repo.root}"]`)
  const primarySeen = await until(
    async () => {
      const wt = (await app.state()).repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)
      return wt?.workspace?.workspaceId ?? null
    },
    { what: 'primary ws', timeoutMs: 15000 },
  )
  const primaryWs = primarySeen.value

  // linked worktree 를 만들어 그룹 형성 (setup — herdr 직접). auto-open + parent auto-open.
  const parent = repo.root.replace(/\/[^/]+$/, '')
  const base = repo.root.split('/').pop()
  const linkedPath = `${parent}/${base}-l356-l9`
  await herdrRequest('worktree.create', { workspace_id: primaryWs, branch: 'l356-l9', path: linkedPath })
  await until(async () => ((await workspaceCount()) >= 2 ? true : null), { what: 'group formed', timeoutMs: 15000 })
  await sleep(1000) // corral 이 그룹을 반영할 시간
  out.setup = { primaryWs, linkedPath, workspaceCount: await workspaceCount() }

  // ---------- L9b: primary workspace 를 close_group 없이 닫기 ----------
  {
    const before = await workspaceCount()
    const mark = Date.now()
    const click = await app.click(`[data-close-worktree="${repo.root}"]`)
    // 거절 알림이 뜰 때까지
    const shown = await until(async () => ((await app.query('[data-lifecycle-notice]')).found.length > 0 ? true : null), { what: 'notice', timeoutMs: 8000, everyMs: 100 })
    await sleep(200)
    const text = await noticeText()
    const shownCode = await noticeCodeFromText()
    const rejLog = rejectedLog('lifecycle.workspace_close_rejected')
    const channel = parseChannel(rxError('workspace.close', mark))
    const after = await workspaceCount()
    out.l9b = {
      clickHit: click.hit,
      noticeShown: shown.ok,
      noticeText: text,
      noticeCodeShown: shownCode,
      rejectionLog: rejLog ? { code: rejLog.code, message: rejLog.message } : null,
      channel, // ← 소켓 error payload 증거
      nothingClosed: before === after,
      workspaceCountBefore: before,
      workspaceCountAfter: after,
    }
    console.log(`[L9b] shown=${shown.ok} code=${channel.code} socketError=${channel.isSocketError} nothingClosed=${before === after}`)
    // 다음 측정 전 알림 닫기
    await app.click('[data-notice-dismiss]').catch(() => {})
    await sleep(200)
  }

  // ---------- L9a: primary 의 마지막 탭 닫기 ----------
  {
    // primary 워크스페이스의 탭 id (마지막 탭 = 유일 root 탭)
    const state = await app.state()
    const pws = state.repos.flatMap((r) => r.worktrees).find((w) => w.path === repo.root)?.workspace
    const tabs = pws?.tabs ?? []
    const lastTab = tabs[tabs.length - 1]
    const before = await workspaceCount()
    const mark = Date.now()
    const click = await app.click(`[data-close-tab="${lastTab.tabId}"]`)
    const shown = await until(async () => ((await app.query('[data-lifecycle-notice]')).found.length > 0 ? true : null), { what: 'notice', timeoutMs: 8000, everyMs: 100 })
    await sleep(200)
    const text = await noticeText()
    const shownCode = await noticeCodeFromText()
    const rejLog = rejectedLog('lifecycle.tab_close_rejected')
    const channel = parseChannel(rxError('tab.close', mark))
    const after = await workspaceCount()
    out.l9a = {
      tabId: lastTab.tabId,
      tabCount: tabs.length,
      clickHit: click.hit,
      noticeShown: shown.ok,
      noticeText: text,
      noticeCodeShown: shownCode,
      rejectionLog: rejLog ? { code: rejLog.code, message: rejLog.message } : null,
      channel, // ← 소켓 error payload 증거
      nothingClosed: before === after,
      workspaceCountBefore: before,
      workspaceCountAfter: after,
    }
    console.log(`[L9a] shown=${shown.ok} code=${channel.code} socketError=${channel.isSocketError} nothingClosed=${before === after}`)
  }

  // ---------- 승격 금지 감사: 앱이 보낸 workspace.close 에 close_group:true 가 없어야 ----------
  const txCloses = app.entries().filter((e) => e.tag === 'req.tx' && e.method === 'workspace.close')
  const escalated = txCloses.filter((e) => /close_group"\s*:\s*true/.test(e.line ?? '') || /"force"\s*:\s*true/.test(e.line ?? ''))
  const txTabCloses = app.entries().filter((e) => e.tag === 'req.tx' && e.method === 'tab.close')
  const tabForced = txTabCloses.filter((e) => /"force"\s*:\s*true/.test(e.line ?? '') || /close_group"\s*:\s*true/.test(e.line ?? ''))
  out.escalationAudit = {
    appWorkspaceCloseCalls: txCloses.map((e) => e.line),
    escalatedWorkspaceCloses: escalated.length,
    appTabCloseCalls: txTabCloses.length,
    escalatedTabCloses: tabForced.length,
    clean: escalated.length === 0 && tabForced.length === 0,
  }

  out.summary = {
    l9bRejectionShown: out.l9b.noticeShown && out.l9b.channel.isSocketError,
    l9bCode: out.l9b.channel.code,
    l9bNothingClosed: out.l9b.nothingClosed,
    l9aRejectionShown: out.l9a.noticeShown && out.l9a.channel.isSocketError,
    l9aCode: out.l9a.channel.code,
    l9aNothingClosed: out.l9a.nothingClosed,
    noEscalation: out.escalationAudit.clean,
  }
  out.verdict =
    out.l9b.noticeShown &&
    out.l9b.channel.isSocketError &&
    out.l9b.channel.code === 'workspace_group_close_required' &&
    out.l9b.nothingClosed &&
    out.l9a.noticeShown &&
    out.l9a.channel.isSocketError &&
    out.l9a.channel.code === 'confirmation_required' &&
    out.l9a.nothingClosed &&
    out.escalationAudit.clean
      ? 'PASS'
      : 'FAIL'

  // 정리 (하네스 — 별도 커넥션, 앱 로그에 안 남는다)
  for (const w of (await herdrRequest('workspace.list', {})).workspaces) {
    await herdrRequest('workspace.close', { workspace_id: w.workspace_id, close_group: true }).catch(() => {})
  }
} catch (error) {
  out.error = String(error)
  out.verdict = 'FAIL'
} finally {
  await app.stop()
}

writeRaw('m4-l9.json', out)
console.log('\nM4:', out.verdict, JSON.stringify(out.summary))
if (out.verdict !== 'PASS') process.exitCode = 1
