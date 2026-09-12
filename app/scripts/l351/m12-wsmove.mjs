// workspace_moved 봉투 실측 (수정 2회차 M-1).
//
// 수정 1회차가 탭 층에서 찾은 것: `tab.move` 는 `number` 를 **안 바꾼다** — 순서의 진실은
// 목록의 자리다. 재리뷰(claude M-1)가 그 발견이 **workspace 층에는 적용되지 않았다**고 짚었다.
// 그리고 그 자리에는 실측이 아예 없었다 (r1·fix1 원자료 어디에도 `workspace_moved` 봉투가 없다).
//
// 그래서 **가르는 실측을 먼저 한다** — 코드를 고치기 전에. 두 갈래뿐이다:
//   · `number` 가 자리를 따라 바뀐다 → 지금의 `number` 정렬이 우연히 맞다. 그 사실을 원자료로 남긴다
//   · 안 바뀐다 → 탭과 같은 병이 남아 있다. `Workspace.order` 로 같은 모델을 편다
//
// 스키마가 말하는 것(읽은 것이지 잰 것이 아니다): `workspace.move` params = `{workspace_id,
// insert_index}` · `workspace_moved` required = `{type, workspace_id, insert_index, workspaces}`.
// `workspace_reordered` 는 `{workspace_ids, workspaces}` 를 싣는다.

import net from 'node:net'
import { REPO_DIR, request, sleep, socketPath, tidySession, until, writeRaw } from './lib.mjs'

const SUB_TYPES = [
  'workspace.created', 'workspace.updated', 'workspace.metadata_updated', 'workspace.renamed',
  'workspace.moved', 'workspace.reordered', 'workspace.closed', 'workspace.focused',
  'worktree.created', 'worktree.opened', 'worktree.removed',
  'tab.created', 'tab.closed', 'tab.focused', 'tab.renamed', 'tab.moved',
  'pane.created', 'pane.closed', 'pane.updated', 'pane.exited', 'pane.agent_detected', 'layout.updated',
]

/** 앱과 같은 목록으로 구독하고 오는 줄을 전부 모은다 (m10 과 같은 방식). */
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
      socket.write(
        JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: types.map((type) => ({ type })) } }) + '\n',
      )
    })
  })
}

const listWorkspaces = async () =>
  (await request('workspace.list', {})).workspaces.map((item) => ({ workspace_id: item.workspace_id, number: item.number, label: item.label }))

const out = { at: new Date().toISOString(), 질문: 'workspace.move 가 number 를 바꾸나 — 순서의 진실이 어디 있나' }

// ① workspace 셋 (격리 세션에서만 — 관문 ④).
await tidySession(REPO_DIR)
await request('workspace.create', { label: 'l351-b', cwd: REPO_DIR })
await request('workspace.create', { label: 'l351-c', cwd: REPO_DIR })
await until(async () => (await listWorkspaces()).length >= 3, { what: 'workspace 3개', timeoutMs: 20000 })
const before = await listWorkspaces()
out['① 옮기기 전'] = before

const sub = await subscribe(SUB_TYPES)
out['② 구독 ack'] = { 거부됐나: sub.ack.error !== undefined, ack: sub.ack }

// ② 마지막 workspace 를 맨 앞으로 — 탭 실측과 **같은 동작**이라야 두 층을 견줄 수 있다.
const target = before[before.length - 1]
sub.lines.length = 0
const moveAt = Date.now()
let moveError = null
try {
  await request('workspace.move', { workspace_id: target.workspace_id, insert_index: 0 })
} catch (error) {
  moveError = String(error)
}
out['③ workspace.move'] = { 옮긴것: target, insert_index: 0, error: moveError }

const gotPush = await until(() => sub.lines.some((item) => item.frame.event === 'workspace_moved'), {
  what: 'workspace_moved push',
  timeoutMs: 8000,
})
await sleep(300)
const moved = sub.lines.filter((item) => item.frame.event === 'workspace_moved' || item.frame.event === 'workspace_reordered')
out['④ 봉투'] = moved.map((item) => ({ 지연ms: item.at - moveAt, frame: item.frame }))

const after = await listWorkspaces()
out['⑤ 옮긴 뒤 workspace.list'] = after
const snapshot = await request('session.snapshot', {})
const snapshotWorkspaces = (snapshot.snapshot ?? snapshot).workspaces.map((item) => ({
  workspace_id: item.workspace_id,
  number: item.number,
}))
out['⑥ 옮긴 뒤 스냅샷'] = snapshotWorkspaces
sub.close()

// ⑦ **불변을 한 번 더 민다.** 한 번의 이동으로 "number 가 자리를 따라간다" 를 말하면 그건
//    표본 1이다. 두 번째 이동과 **중간 workspace 닫기**까지 보고, 매번 `workspace.list` 의
//    배열 순서에서 number 가 **단조 증가**하는지를 본다 — 그 불변이 참일 때에만
//    `rows()` 의 number 정렬이 herdr 의 목록 순서와 같다.
const 단조증가 = (list) => list.every((item, index) => index === 0 || item.number > list[index - 1].number)
const 확인 = [{ 언제: '옮긴 뒤', list: after, 단조증가: 단조증가(after) }]

// 맨 앞을 맨 뒤로 — 자리가 **실제로 바뀌는** 두 번째 표본이라야 불변이 밀린다.
const second = after[0]
await request('workspace.move', { workspace_id: second.workspace_id, insert_index: 2 })
await sleep(600)
const after2 = await listWorkspaces()
확인.push({
  언제: '두 번째 이동 뒤',
  옮긴것: second.workspace_id,
  '자리가 바뀌었나': JSON.stringify(after2.map((item) => item.workspace_id)) !== JSON.stringify(after.map((item) => item.workspace_id)),
  list: after2,
  단조증가: 단조증가(after2),
})

// 가운데 것을 닫는다 — 번호가 다시 매겨지나, 구멍이 남나. 어느 쪽이든 **자리 순서와
// number 순서가 같기만 하면** 정렬은 맞다.
const middle = after2[1]
await request('workspace.close', { workspace_id: middle.workspace_id })
await sleep(600)
const after3 = await listWorkspaces()
확인.push({ 언제: '가운데 닫은 뒤', 닫은것: middle.workspace_id, list: after3, 단조증가: 단조증가(after3) })
out['⑦ 불변 확인'] = 확인

const first = moved[0]?.frame?.data ?? {}
const ids = (list) => JSON.stringify(list.map((item) => item.workspace_id))
const numbers = (list) => JSON.stringify(list.map((item) => item.number))
out.읽은것 = {
  'workspace.move 가 받아들여졌다': moveError === null,
  'workspace_moved 가 실제로 왔다': gotPush.ok && moved.length > 0,
  '봉투 키': Object.keys(first).sort(),
  '봉투에 workspaces 목록이 통째로 실린다': Array.isArray(first.workspaces),
  '실린 workspace 수': Array.isArray(first.workspaces) ? first.workspaces.length : 0,
  '봉투 목록 순서': Array.isArray(first.workspaces) ? first.workspaces.map((item) => item.workspace_id) : null,
  '순서가 실제로 바뀌었다': ids(before) !== ids(after),
  // **여기가 이 실측의 핵심이다.** 탭 층에서는 false 였다.
  'number 가 순서를 따라 바뀌나': numbers(after) === '[1,2,3]',
  '옮기기 전 number 순': before.map((item) => item.number),
  '옮긴 뒤 number 순': after.map((item) => item.number),
  '스냅샷도 같은 자리인가': ids(snapshotWorkspaces) === ids(after),
  'number 순서 = 배열 순서 (세 시점 전부)': 확인.every((item) => item.단조증가),
  '봉투 순서 = list 순서인가':
    Array.isArray(first.workspaces) && JSON.stringify(first.workspaces.map((item) => item.workspace_id)) === ids(after),
}
console.log(JSON.stringify(out.읽은것, null, 2))
writeRaw('00-shapes-fix2.json', out)
await tidySession(REPO_DIR)
