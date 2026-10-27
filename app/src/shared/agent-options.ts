// 작업 시작 모달의 모델 · effort 목록 (LIFE-603 F10) — **이 파일 한 곳**이다.
//
// 「기본값」 = 빈 문자열 = 플래그를 빼고 그 CLI 의 기본에 맡긴다. 고른 값은 그대로 argv 로 간다(런타임은 값을 검증하지 않는다 —
// `providerArgv`). 값의 근거는 각 CLI `--help`·`task-start/defaults.md` 식별자 실측이다
// (`specs/LIFE-603-start-work-link/raw/claude/probe-cli-help.txt`, 2026-10-15: claude 2.1.296 · codex 0.162.1 · grok 1.0.52).
// 근거 없는 값은 넣지 않는다 — grok 의 effort 는 `--help` 가 값을 밝히지 않아 「기본값」 하나뿐이다.

import type { AgentKind } from './types.js'

export type AgentOption = { value: string; label: string }
export type StartAgent = AgentKind

export const DEFAULT_OPTION: AgentOption = { value: '', label: '기본값' }

type Catalog = { models: AgentOption[]; efforts: AgentOption[] }

const CATALOG: Record<Exclude<AgentKind, 'shell'>, Catalog> = {
  // `--model` 은 별칭(fable·opus·sonnet) 또는 전체 이름 — help 원문. 전체 이름은 defaults.md. `--effort` 는 help 의 다섯.
  claude: {
    models: [
      { value: 'opus', label: 'opus' },
      { value: 'sonnet', label: 'sonnet' },
      { value: 'fable', label: 'fable' },
      { value: 'claude-opus-5-5', label: 'claude-opus-5-5' },
      { value: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value })),
  },
  // `-m` 은 자유 문자열(help) — 첫 값은 defaults.md 의 지정 식별자 `gpt-6-astra`(구독 계정용, 바이너리 내장 카탈로그에 있음).
  // 나머지는 계정 카탈로그(`codex debug models`)에 `visibility: list` 로 있고 호출이 성공한 모델(LIFE-713, 2026-10-27, codex-cli 0.162.1).
  // effort(`-c model_reasoning_effort=`)는 defaults.md 가 쓰는 두 값.
  codex: {
    models: ['gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna'].map((value) => ({ value, label: value })),
    efforts: ['high', 'xhigh'].map((value) => ({ value, label: value })),
  },
  // `grok models` 목록 원문.
  grok: {
    models: ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'].map((value) => ({ value, label: value })),
    efforts: [],
  },
}

/** 그 에이전트의 모델 칸 선택지 — 맨 앞은 늘 「기본값」. 빈 터미널은 칸이 없다(빈 목록). */
export function modelOptions(agent: StartAgent): AgentOption[] {
  return agent === 'shell' ? [] : [DEFAULT_OPTION, ...CATALOG[agent].models]
}

export function effortOptions(agent: StartAgent): AgentOption[] {
  return agent === 'shell' ? [] : [DEFAULT_OPTION, ...CATALOG[agent].efforts]
}

/** 목록에 있는 값만 받는다 — 렌더러가 보낸 값을 main 이 다시 본다(모르는 값은 기본값). */
export function knownOption({ options, value }: { options: AgentOption[]; value: unknown }): string {
  return typeof value === 'string' && options.some((option) => option.value === value) ? value : ''
}
