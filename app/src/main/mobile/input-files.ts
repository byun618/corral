// 지시 허브의 기록 찾기 (LIFE-582 R1-A13 · LIFE-832 리뷰 r1 A9) — 폰 허브(`service.ts`)와 데스크톱 diff 메모 허브(`diff-notes-send.ts`)가 같은 규칙을 쓴다.
// 대화와 같은 파일이되 **유일한 후보만**(표시용 첫 일치를 소유 증명으로 쓰지 않는다). 아직 없으면 그 세션이 쓸 경로(Claude·Grok — CLI `sessionRecordPaths` 와 같은 규칙).
import { sessionRecordPaths } from '../../runtime/terminal/agent.js'
import type { AgentSessionRef } from '../../shared/types.js'
import { resolveTranscriptUnique, type TranscriptResolution } from '../transcript.js'
import { chatFileOf } from './chat.js'
import type { InputHubDeps } from './input.js'

/** `resolve` — 세션 → 기록(유일 후보). 시험이 격리 파일을 꽂는다. 기본은 `resolveTranscriptUnique`. */
export function inputFileDeps(resolve: (session: AgentSessionRef) => TranscriptResolution = resolveTranscriptUnique): Pick<InputHubDeps, 'resolveFile' | 'expectedFile'> {
  return {
    resolveFile: ({ session, agent }) => {
      const resolved = resolve(session)
      return resolved.kind === 'found' ? { kind: 'found', file: chatFileOf({ agent, transcript: resolved.file }), continuedAs: resolved.continuedAs } : resolved
    },
    expectedFile: ({ channel, cwd }) => {
      const { session, agent } = channel
      if (session.kind !== 'id' || agent === 'codex') return null
      return sessionRecordPaths(agent, { cwd, sessionId: session.id, t0Ms: 0, nowMs: 0 })[0] ?? null
    },
  }
}
