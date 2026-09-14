// `pane.report_agent_session` 의 갱신 규칙 — **설계가 여기 달려 있다.**
//
// 01-agent-session-probe 가 예기치 않은 것을 둘 보였다:
//   ① claude 훅이 id·경로를 **둘 다** 보내는데 herdr 가 돌려주는 `kind` 는 `id` 였다
//   ② 뒤이은 보고(다른 id·다른 agent)가 **먹지 않았다**
// 둘 다 00-analysis.md §2.1("세션 id 또는 파일 경로를 실어 준다")의 전제를 흔든다. 추측하지
// 않고 규칙 자체를 잰다 — pane 을 새로 만들어 가며 조합을 하나씩 태운다.
//
// 관문 ⑤ 반례: "아무 보고나 하면 값이 바뀐다" 가 아님을 ③(낡은 seq)·④(다른 에이전트)가 보인다.

import {
  ensureSession,
  herdrCall,
  herdrRequest,
  makeScratchRepo,
  sleep,
  until,
  writeRaw,
} from './lib.mjs'

const SETTLE_MS = 400

async function freshPane(scratchRoot) {
  const created = await herdrRequest('workspace.create', { cwd: scratchRoot })
  const workspaceId = created?.workspace?.workspace_id ?? created?.workspace_id
  await until(async () => (await herdrRequest('pane.list', { workspace_id: workspaceId }))?.panes?.length > 0, {
    timeoutMs: 15000,
    everyMs: 100,
    what: 'pane',
  })
  const panes = (await herdrRequest('pane.list', { workspace_id: workspaceId })).panes
  return { workspaceId, paneId: panes[0].pane_id }
}

async function readRef(paneId) {
  return (await herdrRequest('pane.get', { pane_id: paneId })).pane?.agent_session ?? null
}

async function report(paneId, params) {
  const response = await herdrCall('pane.report_agent_session', { pane_id: paneId, ...params })
  await sleep(SETTLE_MS)
  return { sent: params, error: response.error, result: response.result, after: await readRef(paneId) }
}

async function main() {
  await ensureSession()
  const scratch = makeScratchRepo('refsem')
  const cases = []
  const opened = []

  // ① 경로만 보고 — claude 훅이 못 하는 조합이지만, `kind:'path'` 가 도달 가능한지 가른다.
  {
    const pane = await freshPane(scratch.root)
    opened.push(pane.workspaceId)
    cases.push({
      case: '① 경로만 보고',
      ...(await report(pane.paneId, {
        source: 'herdr:claude',
        agent: 'claude',
        seq: 1000,
        agent_session_path: '/tmp/l366-path-only.jsonl',
      })),
    })
  }

  // ② id+경로 → 같은 pane 에 새 id (seq 증가) → 낡은 seq → 다른 에이전트.
  {
    const pane = await freshPane(scratch.root)
    opened.push(pane.workspaceId)
    cases.push({
      case: '②-a id+경로 첫 보고',
      ...(await report(pane.paneId, {
        source: 'herdr:claude',
        agent: 'claude',
        seq: 1000,
        agent_session_id: 'ID-A',
        agent_session_path: '/tmp/l366-a.jsonl',
      })),
    })
    cases.push({
      case: '②-b 같은 pane 에 새 id (seq 증가) — /clear·--resume 이 이 모양이다',
      ...(await report(pane.paneId, {
        source: 'herdr:claude',
        agent: 'claude',
        seq: 2000,
        agent_session_id: 'ID-B',
        agent_session_path: '/tmp/l366-b.jsonl',
      })),
    })
    cases.push({
      case: '②-c 낡은 seq — 무시돼야 한다 (반례)',
      ...(await report(pane.paneId, {
        source: 'herdr:claude',
        agent: 'claude',
        seq: 500,
        agent_session_id: 'ID-STALE',
      })),
    })
    cases.push({
      case: '②-d 다른 에이전트(codex)가 같은 pane 을 덮으려 한다',
      ...(await report(pane.paneId, {
        source: 'herdr:codex',
        agent: 'codex',
        seq: 3000,
        agent_session_id: 'CODEX-1',
      })),
    })
  }

  // ③ seq 를 아예 안 보내면 (스키마상 선택) 무엇이 되나.
  {
    const pane = await freshPane(scratch.root)
    opened.push(pane.workspaceId)
    cases.push({
      case: '③-a seq 없이 첫 보고',
      ...(await report(pane.paneId, { source: 'herdr:claude', agent: 'claude', agent_session_id: 'NOSEQ-1' })),
    })
    cases.push({
      case: '③-b seq 없이 두 번째 보고',
      ...(await report(pane.paneId, { source: 'herdr:claude', agent: 'claude', agent_session_id: 'NOSEQ-2' })),
    })
  }

  // ④ id 를 null 로 보내면 지워지나 (부재 vs 비움 — corral putPane 병합 규칙의 재료).
  {
    const pane = await freshPane(scratch.root)
    opened.push(pane.workspaceId)
    cases.push({
      case: '④-a 첫 보고',
      ...(await report(pane.paneId, {
        source: 'herdr:claude',
        agent: 'claude',
        seq: 1000,
        agent_session_id: 'CLR-1',
      })),
    })
    cases.push({
      case: '④-b id:null 로 지우기 시도',
      ...(await report(pane.paneId, {
        source: 'herdr:claude',
        agent: 'claude',
        seq: 2000,
        agent_session_id: null,
      })),
    })
  }

  const summary = {
    at: new Date().toISOString(),
    settleMs: SETTLE_MS,
    cases,
    읽어낸_규칙: {
      경로만_보고: cases[0].after === null ? 'agent_session 이 안 생긴다 — id 가 있어야 한다' : String(cases[0].after?.kind),
      kind값: cases[1].after?.kind ?? null,
      새_id_로_갱신되나: cases[2].after?.value === 'ID-B',
      낡은_seq_무시: cases[3].after?.value === 'ID-B',
      다른_에이전트_덮기: cases[4].after?.value,
      seq없이_갱신: cases[6]?.after?.value,
      null로_지워지나: cases[8]?.after === null,
    },
  }
  writeRaw('ref-semantics.json', summary)
  console.log(JSON.stringify(summary.읽어낸_규칙, null, 2))
  for (const workspaceId of opened) {
    await herdrRequest('workspace.close', { workspace_id: workspaceId, close_group: false }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
