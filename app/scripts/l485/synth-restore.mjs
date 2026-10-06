// LIFE-485 — 합성 session.json(현재 형식): claude 2 · codex 1 재개 대상 + 셸 1. 사용자 파일(claude 1·grok 2)과 종류가 달라 어느 파일을 읽었는지 가린다.
import fs from 'node:fs'
const agent = (kind, id) => ({ cwd: '/tmp', agent_session: { agent: kind, kind: 'id', source: `herdr:${kind}`, value: id } })
const session = { version: 3, workspaces: [{ id: 'w1', identity_cwd: '/tmp', tabs: [{ layout: { Pane: 1 }, panes: { 1: { cwd: '/tmp' }, 2: agent('claude', 'a'), 3: agent('claude', 'b'), 4: agent('codex', 'c') } }] }] }
fs.writeFileSync(process.argv[2], JSON.stringify(session))
