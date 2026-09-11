// M8 — 종료 확인의 판별자 근거 (N6 보강).
//
// "이 행에서 잃을 것이 있나" 를 **포그라운드 프로세스 그룹**으로 가른다는 규칙의 실측 근거다.
// 앱을 띄우지 않는다 — herdr 에 직접 물어 세 상태의 값을 나란히 적는다.
//
//   ① 셸이 `.zshrc` 를 읽는 동안  ② claude 가 도는 동안  ③ 사용자가 친 `sleep 100` 이 도는 동안
//
// 이 근거가 없으면 "포그라운드에 뭐가 있으니 묻는다" 가 되고, 그러면 **갓 만든 셸을 닫을 때마다**
// 확인이 뜬다 (M5 1회차: 5회 중 3회).

import { request, sleep, tidySession, until, writeRaw } from './lib.mjs'

const out = { at: new Date().toISOString(), 규칙: 'foreground_process_group_id === shell_pid 이면 잃을 것이 없다', 표본: [] }

const snap = async (paneId, label) => {
  const info = (await request('pane.process_info', { pane_id: paneId })).process_info
  const row = {
    label,
    paneId,
    shell_pid: info.shell_pid,
    foreground_process_group_id: info.foreground_process_group_id,
    같은가: info.shell_pid === info.foreground_process_group_id,
    foreground: (info.foreground_processes ?? []).map((item) => item.argv0),
  }
  out.표본.push(row)
  console.log(label, row.shell_pid, row.foreground_process_group_id, row.같은가, JSON.stringify(row.foreground))
  return row
}

await tidySession()
const workspaceId = (await request('workspace.list', {})).workspaces[0].workspace_id

// ── ① 셸 기동 중 ──────────────────────────────────────────────────────────
{
  const created = await request('tab.create', { workspace_id: workspaceId, focus: false })
  const paneId = created.root_pane.pane_id
  for (let i = 0; i < 8; i++) {
    await snap(paneId, `①-셸기동-${i * 250}ms`)
    await sleep(250)
  }
  // ② 같은 pane 에 claude 를 올린다. 튕기면 다시 건다 — **떴다는 것을 관측한 뒤에** 잰다.
  const starts = []
  for (let attempt = 1; attempt <= 20; attempt++) {
    const result = await request('agent.start', { name: 'fgprobe', kind: 'claude', pane_id: paneId }).catch((error) =>
      String(error),
    )
    starts.push(typeof result === 'string' ? result : 'ok')
    if (typeof result !== 'string') break
    await sleep(300)
  }
  out.agentStart = starts
  const up = await until(
    async () =>
      ((await request('pane.process_info', { pane_id: paneId })).process_info.foreground_processes ?? []).some(
        (item) => item.argv0 === 'claude',
      ),
    { what: 'claude 기동', timeoutMs: 60000, everyMs: 400 },
  )
  out.claude기동ms = up.ok ? up.ms : null
  await snap(paneId, '②-claude-실행중')
  await request('tab.close', { tab_id: created.tab.tab_id })
}

// ── ③ 사용자가 친 명령 ────────────────────────────────────────────────────
{
  const created = await request('tab.create', { workspace_id: workspaceId, focus: false })
  const paneId = created.root_pane.pane_id
  await sleep(3000)
  await snap(paneId, '③-프롬프트')
  await request('pane.send_text', { pane_id: paneId, text: 'sleep 100\n' })
  await sleep(1500)
  await snap(paneId, '③-sleep100-실행중')
  await request('tab.close', { tab_id: created.tab.tab_id })
}

out.판정 = {
  '① 셸 기동 중 전부 같은가': out.표본.filter((row) => row.label.startsWith('①')).every((row) => row.같은가),
  '② claude 실행 중 다른가': out.표본.filter((row) => row.label.startsWith('②')).every((row) => !row.같은가),
  '③ 사용자 명령 실행 중 다른가': out.표본.filter((row) => row.label === '③-sleep100-실행중').every((row) => !row.같은가),
  '③ 프롬프트에서는 같은가': out.표본.filter((row) => row.label === '③-프롬프트').every((row) => row.같은가),
}
console.log(JSON.stringify(out.판정, null, 2))
writeRaw('n6-foreground-group.json', out)
await tidySession()
