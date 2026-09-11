// tab_moved 봉투 실측 (수정 1회차 M5).
//
// protocol.ts 의 규칙은 "**푸시 봉투 모양을 실제로 확인한 것만** 구독 목록에 넣는다" 다.
// 스키마가 `{tab_id, workspace_id, insert_index, tabs:[TabInfo…]}` 라고 말하지만, 스키마를
// 읽은 것은 실측이 아니다 — 구독해서 진짜 오는 줄을 받아 원자료로 남긴다.
//
// 겸사겸사 확인하는 것: `tab.moved` 를 목록에 넣어도 구독 요청이 거부되지 않는가
// (모르는 타입이 하나 섞이면 요청 **전체**가 invalid_request 다 — 스파이크 제약 4).

import net from 'node:net'
import { REPO_DIR, request, sleep, socketPath, tidySession, until, writeRaw } from './lib.mjs'

const SUB_TYPES = [
  'workspace.created', 'workspace.updated', 'workspace.metadata_updated', 'workspace.renamed',
  'workspace.moved', 'workspace.reordered', 'workspace.closed', 'workspace.focused',
  'worktree.created', 'worktree.opened', 'worktree.removed',
  'tab.created', 'tab.closed', 'tab.focused', 'tab.renamed', 'tab.moved',
  'pane.created', 'pane.closed', 'pane.updated', 'pane.exited', 'pane.agent_detected', 'layout.updated',
]

/** 앱과 같은 목록으로 구독하고, 오는 줄을 전부 모은다. */
function subscribe(types) {
  return new Promise((resolve, reject) => {
    const lines = []
    const socket = net.createConnection(socketPath())
    socket.setEncoding('utf8')
    let buffer = ''
    let acked = null
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index === -1) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length === 0) continue
        const parsed = JSON.parse(line)
        if (acked === null && (parsed.result !== undefined || parsed.error !== undefined)) {
          acked = parsed
          resolve({ ack: parsed, lines, close: () => socket.destroy() })
          continue
        }
        lines.push({ at: Date.now(), frame: parsed })
      }
    })
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write(JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: types.map((type) => ({ type })) } }) + '\n')
    })
  })
}

const out = { at: new Date().toISOString(), 질문: 'tab.moved 를 구독할 수 있나 · tab_moved 봉투는 무슨 모양인가' }

// ① 워크스페이스 하나 + 탭 셋을 만든다 (격리 세션에서만 — 관문 ④).
const workspaceId = await tidySession(REPO_DIR)
out.준비 = { workspaceId }

const sub = await subscribe(SUB_TYPES)
out['① 구독 ack'] = { 거부됐나: sub.ack.error !== undefined, ack: sub.ack }

for (let i = 0; i < 2; i++) await request('tab.create', { workspace_id: workspaceId })
await until(async () => (await request('tab.list', { workspace_id: workspaceId })).tabs.length >= 3, {
  what: '탭 3개',
})
const before = (await request('tab.list', { workspace_id: workspaceId })).tabs
out['② 옮기기 전 탭'] = before.map((tab) => ({ tab_id: tab.tab_id, number: tab.number }))

// ② 마지막 탭을 맨 앞으로.
const target = before[before.length - 1]
sub.lines.length = 0
await request('tab.move', { tab_id: target.tab_id, insert_index: 0 })
await until(() => sub.lines.some((item) => item.frame.event === 'tab_moved'), { what: 'tab_moved push', timeoutMs: 8000 })
await sleep(300)

const moved = sub.lines.filter((item) => item.frame.event === 'tab_moved')
out['③ tab_moved 봉투'] = moved.map((item) => item.frame)
out['④ 옮긴 뒤 탭'] = (await request('tab.list', { workspace_id: workspaceId })).tabs.map((tab) => ({
  tab_id: tab.tab_id,
  number: tab.number,
}))
// ③ **순서의 진실이 어디 있나.** number 가 따라 바뀌는지, 아니면 배열 자리가 진실인지.
const snapshot = await request('session.snapshot', {})
const snapshotTabs = (snapshot.snapshot ?? snapshot).tabs.map((tab) => ({ tab_id: tab.tab_id, number: tab.number }))
out['⑤ 옮긴 뒤 스냅샷 탭'] = snapshotTabs
sub.close()
await tidySession()

const first = moved[0]?.frame?.data ?? {}
out.읽은것 = {
  'tab.moved 구독이 거부되지 않았다': sub.ack.error === undefined,
  'tab_moved 가 실제로 왔다': moved.length > 0,
  '봉투에 tabs 목록이 통째로 실린다': Array.isArray(first.tabs),
  '실린 탭 수': Array.isArray(first.tabs) ? first.tabs.length : 0,
  '봉투 키': Object.keys(first).sort(),
  '순서가 실제로 바뀌었다':
    JSON.stringify(out['② 옮기기 전 탭'].map((tab) => tab.tab_id)) !==
    JSON.stringify(out['④ 옮긴 뒤 탭'].map((tab) => tab.tab_id)),
  // 여기가 이 실측의 핵심이다 — 1회차 store 는 `number` 로 정렬했다.
  'number 가 순서를 따라 바뀌나': JSON.stringify(out['④ 옮긴 뒤 탭'].map((tab) => tab.number)) === '[1,2,3]',
  '순서의 진실은 배열 자리다 (스냅샷도 같은 자리)':
    JSON.stringify(snapshotTabs.map((tab) => tab.tab_id)) ===
    JSON.stringify(out['④ 옮긴 뒤 탭'].map((tab) => tab.tab_id)),
  '옮긴 뒤 number 순': out['④ 옮긴 뒤 탭'].map((tab) => tab.number),
}
console.log(JSON.stringify(out.읽은것, null, 2))
writeRaw('00-shapes-fix1.json', out)
