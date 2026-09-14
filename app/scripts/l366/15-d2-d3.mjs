// D2(`done`·`error` 글리프를 안 그리는 근거) · D3(상태 접두사는 herdr 가 이미 벗긴다) —
// **재는 항목이지 고치는 항목이 아니다.** 기준이 요구하는 것은 근거를 원자료로 남기는 것이다.
//
// 두 축으로 잰다:
//   ① herdr 가 스스로 밝히는 스키마 (`herdr api schema`) — 상태 enum 과 제목 필드의 정의
//   ② 살아 있는 pane 실측 — 셸 pane 에 **상태 접두사가 붙은 OSC 제목**을 직접 쏘고
//      `terminal_title` / `terminal_title_stripped` 두 값을 되읽는다
//
// ②가 필요한 이유: 스키마에 필드가 있다는 것과 herdr 가 실제로 벗긴다는 것은 다른 말이다.
// 관문 ⑤ 반례: 접두사가 **없는** 제목도 한 번 쏜다 — 그때 두 값이 같아야 한다. 늘 다르게
// 나오면 이 실측은 "벗긴다"가 아니라 "뭔가 늘 다르다"를 재는 것이다.

import { execFileSync } from 'node:child_process'
import {
  SESSION,
  herdrCall,
  herdrRequest,
  isolatedEnv,
  makeScratchRepo,
  resetSession,
  sleep,
  writeRaw,
} from './lib.mjs'

/** OSC 2 로 제목을 쏘고 herdr 가 되돌려주는 두 값을 읽는다. */
async function probeTitle(paneId, title) {
  await herdrRequest('pane.send_text', { pane_id: paneId, text: `printf '\\033]0;${title}\\007'\r` })
  await sleep(900)
  const info = (await herdrCall('pane.get', { pane_id: paneId })).result?.pane ?? {}
  return {
    쏜_제목: title,
    terminal_title: info.terminal_title ?? null,
    terminal_title_stripped: info.terminal_title_stripped ?? null,
    두_값이_다른가: (info.terminal_title ?? null) !== (info.terminal_title_stripped ?? null),
  }
}

async function main() {
  const out = { at: new Date().toISOString(), session: SESSION }
  out['세션 초기화'] = await resetSession()

  // ---------- ① 스키마 ---------- (`--json` 없이는 요약 4줄만 나온다 — 1차 실행에서 그걸 훑고
  //             "필드가 없다" 는 거짓 결론을 냈다.)
  const schemaText = execFileSync('herdr', ['api', 'schema', '--json'], { env: isolatedEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  let schema = null
  try {
    schema = JSON.parse(schemaText)
  } catch {
    out['스키마 파싱 실패'] = schemaText.slice(0, 400)
  }
  const flat = JSON.stringify(schema ?? schemaText)
  /** 스키마 안에서 이름이 `AgentStatus` 인 정의를 찾는다 — 경로는 버전마다 다를 수 있다. */
  const findEnum = (name) => {
    const found = []
    const walk = (node, keyPath) => {
      if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${keyPath}[${index}]`))
      if (node === null || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        if (key === name && value !== null && typeof value === 'object' && Array.isArray(value.enum)) {
          found.push({ 경로: `${keyPath}.${key}`, enum: value.enum })
        }
        walk(value, `${keyPath}.${key}`)
      }
    }
    walk(schema, '$')
    return found
  }
  out['D2 — 스키마의 AgentStatus'] = {
    정의: findEnum('AgentStatus'),
    'done 이 스키마에 있나': flat.includes('"done"'),
    'error 가 상태값으로 있나': /"AgentStatus"[^}]*error/.test(flat),
    설명:
      'herdr 0.9.0 스키마의 AgentStatus 는 idle·working·blocked·done·unknown 이다. ' +
      'corral 은 done 을 미상으로 옮기고 로그에 남긴다(protocol.ts). error 라는 상태값은 없다 — ' +
      '그래서 done·error 글리프를 그리지 않는다.',
  }
  out['D2 — agent 보고 경로에 message 가 오나'] = {
    'pane.report_agent 가 스키마에 있나': flat.includes('report_agent'),
    설명:
      '통합 훅은 report_agent_session 만 부른다(A3ⓐ 실측). 진행 중인 도구 이름을 담을 자리가 ' +
      'herdr 에는 있어도 아무도 안 채운다 — 그래서 2차 줄이 그 값을 쓰지 않는다.',
  }
  out['D3 — 스키마의 제목 필드'] = {
    'terminal_title 있나': flat.includes('terminal_title'),
    'terminal_title_stripped 있나': flat.includes('terminal_title_stripped'),
  }

  // ---------- ② 살아 있는 pane 실측 ----------
  const repo = makeScratchRepo('d3')
  const workspace = await herdrRequest('workspace.create', { path: repo.root })
  const workspaceId = workspace.workspace?.workspace_id ?? workspace.workspace_id
  const panes = (await herdrRequest('pane.list', {})).panes.filter((pane) => pane.workspace_id === workspaceId)
  const paneId = panes[0].pane_id
  await sleep(1200)
  out['D3 — 실측'] = [
    // 관문 ⑤ 반례 — 접두사 없는 제목. 두 값이 **같아야** 한다.
    await probeTitle(paneId, 'PLAIN-TITLE'),
    await probeTitle(paneId, '✳ Thinking… PROBE'),
    await probeTitle(paneId, '* Running PROBE'),
    await probeTitle(paneId, '. Waiting PROBE'),
  ]
  out['D3 판정'] = {
    '반례(접두사 없음)에서 두 값이 같나': out['D3 — 실측'][0].두_값이_다른가 === false,
    '접두사 붙은 제목에서 stripped 가 달라지나': out['D3 — 실측'].slice(1).map((row) => row.두_값이_다른가),
  }
  out['D4 재확인 — 살아 있는 pane 상태'] = (await herdrRequest('pane.list', {})).panes.map((pane) => ({
    pane_id: pane.pane_id,
    agent: pane.agent ?? null,
    agent_status: pane.agent_status ?? null,
  }))
  out.정리 = await herdrCall('workspace.close', { workspace_id: workspaceId })

  writeRaw('d2-d3-schema.json', out)
  console.log(
    JSON.stringify(
      { D2: out['D2 — 스키마의 AgentStatus'], D3필드: out['D3 — 스키마의 제목 필드'], 실측: out['D3 — 실측'], 판정: out['D3 판정'] },
      null,
      1,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
