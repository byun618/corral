// 제목 **5단**의 순서를 못박는 테스트 (기준 C1′, 수정 라운드 5 「Orca 동등」)
// + LIFE-357 거절 목록 회귀 (기준 C3) + herdr 기본 label 판별 (G5·G7).
//
// C1′ 이 "순서가 이대로임을 단위 테스트로 고정" 이라고 쓴 이유는, 티어를 하나 더 끼우는 변경이
// 조용히 순서를 뒤집기 쉬워서다. 그래서 각 티어마다 **위 티어를 하나씩 벗기며** 다음 티어로
// 내려오는지 확인한다 — 한 티어만 단독으로 확인하면 순서는 안 고정된다.
//
// 수정 라운드 3 의 **브랜치 티어 테스트는 걷어냈다** — 그 티어 자체가 사라졌다 (P5/G8:
// 셸 탭 폴백은 `terminal N`). 프롬프트 거절 목록(G1) 회귀는 그대로 남는다.

import { describe, expect, it } from 'vitest'
import type { AgentSessionRef, PaneRow, SessionDigest, TabRow } from '../../shared/types.js'
import { EMPTY_SESSION_DIGEST } from '../../shared/types.js'
import {
  firstPromptTitle,
  isDefaultPositionLabel,
  paneTitleLabel,
  providerTitle,
  sessionTitle,
  tabAgent,
  userLabel,
} from './session-title.js'

/**
 * 제목 한 줄. `tabCount` 는 그 워크스페이스의 탭 수(G7) — 안 주면 **모름(null)** 이라
 * 범위 판별을 안 한다.
 */
function title(input: { tab: TabRow; tabCount?: number | null }): string {
  return sessionTitle({ tab: input.tab, tabCount: input.tabCount ?? null })
}

function pane(input: { title?: string; agent?: string | null; agentSession?: AgentSessionRef | null }): PaneRow {
  return {
    paneId: 'wA:p1',
    tabId: 'wA:t1',
    workspaceId: 'wA',
    title: input.title ?? '',
    agent: input.agent ?? null,
    agentStatus: 'idle',
    cwd: null,
    focused: false,
    agentSession: input.agentSession ?? null,
  }
}

function tab(input: { label?: string; number?: number; panes?: PaneRow[]; digest?: SessionDigest; tabId?: string }): TabRow {
  return {
    tabId: input.tabId ?? 'wA:t1',
    workspaceId: 'wA',
    label: input.label ?? String(input.number ?? 1),
    number: input.number ?? 1,
    order: 0,
    agentStatus: 'idle',
    focused: false,
    panes: input.panes ?? [],
    digest: input.digest ?? EMPTY_SESSION_DIGEST,
  }
}

function withProviderTitle(title: string | null): SessionDigest {
  return { ...EMPTY_SESSION_DIGEST, providerTitle: title }
}

function withDigest(input: { providerTitle?: string | null; firstPrompt?: string | null }): SessionDigest {
  return {
    ...EMPTY_SESSION_DIGEST,
    providerTitle: input.providerTitle ?? null,
    firstPrompt: input.firstPrompt ?? null,
  }
}

describe('sessionTitle — 5단 우선순위 (C1′, Orca 순서)', () => {
  const panes = [pane({ title: 'SUMMARY.md 작성', agent: 'claude' })]
  const digest = withDigest({ providerTitle: '리뷰 지적 취합', firstPrompt: '테스트 깨진 것 고치기' })

  it('① 사용자가 준 이름이 맨 위다 — 아래 세 티어가 다 있어도 이긴다', () => {
    expect(title({ tab: tab({ label: '내 세션', number: 2, panes, digest }) })).toBe('내 세션')
  })

  it('② 사용자 이름이 없으면 ai-title — 첫 발화·터미널 제목보다 위다', () => {
    expect(title({ tab: tab({ number: 2, panes, digest }) })).toBe('리뷰 지적 취합')
  })

  it('③ ai-title 이 없으면 **첫 사용자 발화** — 터미널 제목보다 위다 (Orca aiVault 4단 > 라이브 6단)', () => {
    const noTitle = withDigest({ firstPrompt: '테스트 깨진 것 고치기' })
    expect(title({ tab: tab({ number: 2, panes, digest: noTitle }) })).toBe('테스트 깨진 것 고치기')
  })

  it('④ 둘 다 없으면 정제된 터미널 제목으로 내려온다', () => {
    expect(title({ tab: tab({ number: 2, panes, digest: withDigest({}) }) })).toBe('SUMMARY.md 작성')
  })

  it('⑤ 넷 다 없으면 폴백 — 에이전트 이름 + 표찰 번호', () => {
    expect(title({ tab: tab({ number: 3, panes: [pane({ agent: 'codex' })] }) })).toBe('codex 3')
  })

  it('⑤ 에이전트가 없는 셸 탭의 폴백은 `terminal N` 이다 (P5/G8 — 브랜치가 아니다)', () => {
    expect(title({ tab: tab({ number: 4 }) })).toBe('terminal 4')
  })

  it('같은 worktree 의 셸 탭 둘은 서로 다른 제목이다 (A4)', () => {
    expect(title({ tab: tab({ number: 1 }) })).toBe('terminal 1')
    expect(title({ tab: tab({ number: 2 }) })).toBe('terminal 2')
  })

  // 반례 (관문 ⑤) — 첫 발화 티어가 ai-title 을 **이기면 안 된다.** 순서를 뒤집으면 여기서 깨진다.
  it('반례: ai-title 과 첫 발화가 둘 다 있으면 ai-title 이 이긴다', () => {
    const both = withDigest({ providerTitle: '리뷰 지적 취합', firstPrompt: '테스트 깨진 것 고치기' })
    expect(title({ tab: tab({ number: 2, panes: [pane({ agent: 'claude' })], digest: both }) })).toBe('리뷰 지적 취합')
  })

  // 반례 — 첫 발화가 터미널 제목에 **져서는 안 된다** (앞선 미리보기의 순서로 되돌아가면 깨진다).
  it('반례: 첫 발화와 터미널 제목이 둘 다 있으면 첫 발화가 이긴다', () => {
    const onlyPrompt = withDigest({ firstPrompt: '테스트 깨진 것 고치기' })
    expect(title({ tab: tab({ number: 2, panes, digest: onlyPrompt }) })).toBe('테스트 깨진 것 고치기')
  })

  it('provider 제목이 공백뿐이면 티어를 건너뛴다 — 빈 제목을 그리지 않는다', () => {
    const blank = withDigest({ providerTitle: '   ', firstPrompt: null })
    expect(title({ tab: tab({ number: 2, panes, digest: blank }) })).toBe('SUMMARY.md 작성')
  })

  it('첫 발화가 공백뿐이어도 티어를 건너뛴다', () => {
    const blank = withDigest({ firstPrompt: '  ' })
    expect(title({ tab: tab({ number: 2, panes, digest: blank }) })).toBe('SUMMARY.md 작성')
  })

  it('상태 단어·에이전트 종류는 제목에 안 들어간다 (§4 ② — 빈 자리는 폴백이 받는다)', () => {
    const idle = tab({ number: 2, panes: [pane({ title: 'Claude Code', agent: 'claude' })] })
    expect(title({ tab: idle })).toBe('claude 2')
  })
})

describe('거절 목록 회귀 — LIFE-357 이 그대로다 (C3)', () => {
  it('pane ID 는 제목이 아니다', () => {
    expect(paneTitleLabel(tab({ panes: [pane({ title: 'wG:p3', agent: 'claude' })] }))).toBeNull()
  })

  it('셸 프롬프트 제목(절대경로)은 제목이 아니다', () => {
    const title = 'byun@sanghyunui-MacBookPro:/private/var/folders/q4/T/x'
    expect(paneTitleLabel(tab({ panes: [pane({ title })] }))).toBeNull()
  })

  it('유휴 기본값(에이전트 이름 자체·`Claude Code`)은 제목이 아니다', () => {
    expect(paneTitleLabel(tab({ panes: [pane({ title: 'claude', agent: 'claude' })] }))).toBeNull()
    expect(paneTitleLabel(tab({ panes: [pane({ title: 'Claude Code', agent: 'claude' })] }))).toBeNull()
  })

  it('거절당한 pane 다음에 쓸 만한 제목이 있으면 그것을 쓴다', () => {
    const panes = [pane({ title: 'wG:p3', agent: 'claude' }), pane({ title: '테스트 고치기', agent: 'claude' })]
    expect(paneTitleLabel(tab({ panes }))).toBe('테스트 고치기')
  })

  it('herdr 기본 label(표찰 번호 문자열)은 사용자 이름이 아니다', () => {
    expect(userLabel({ tab: tab({ label: '2', number: 2 }), tabCount: 3 })).toBeNull()
    expect(userLabel({ tab: tab({ label: '357', number: 2 }), tabCount: 3 })).toBe('357')
  })

  it('사용자 이름이 지워지면 다음 티어로 되돌아간다 (F1 의 화면 쪽 계약)', () => {
    const panes = [pane({ title: 'SUMMARY.md 작성', agent: 'claude' })]
    const digest = withProviderTitle('리뷰 지적 취합')
    expect(title({ tab: tab({ label: '내 세션', number: 2, panes, digest }) })).toBe('내 세션')
    // herdr 가 빈 label 을 받으면 표찰 번호로 되돌린다 — 그때 제목은 provider 티어로 내려온다.
    expect(title({ tab: tab({ label: '2', number: 2, panes, digest }) })).toBe('리뷰 지적 취합')
  })
})

describe('tabAgent · providerTitle', () => {
  it('tabAgent 는 처음 붙은 에이전트를 준다', () => {
    expect(tabAgent(tab({ panes: [pane({}), pane({ agent: 'grok' })] }))).toBe('grok')
  })

  it('providerTitle 은 앞뒤 공백을 턴다', () => {
    expect(providerTitle(tab({ digest: withProviderTitle('  이름  ') }))).toBe('이름')
  })
})

// 수정 라운드 3 G1 — **실환경 문자열을 그대로 박는다.**
//
// 옛 필터 `/^\S+@\S+:\//` 는 격리 HOME(`/private/var/folders/…`)에서 나온 표본만 보고 지어져서
// `:~` 로 접히는 실환경 프롬프트를 못 걸렀다 (`04-gate1-check.md` §2). 아래 4줄은 사용자
// 실환경 `herdr pane list` 실측값 그대로다 — 다음 라운드가 또 격리 표본만 보고 좁히면 여기서 깨진다.
describe('셸 프롬프트 제목 — 실환경 실측 4줄 (G1)', () => {
  const MEASURED = [
    'byun@sanghyunui-MacBookPro:~',
    'byun@sanghyunui-MacBookPro:~/repos/byun618/corral',
    'byun@sanghyunui-MacBookPro:~/repos/byun618/corral/.claude/worktrees/LIFE-357-layout-redesign-claude-orca',
    'byun@sanghyunui-MacBookPro:/private/var/folders/x',
  ]

  for (const measured of MEASURED) {
    it(`걸러진다: ${measured}`, () => {
      expect(paneTitleLabel(tab({ panes: [pane({ title: measured })] }))).toBeNull()
    })
  }

  it('그래서 셸 탭 제목이 프롬프트 문자열이 되지 않는다', () => {
    const panes = [pane({ title: 'byun@sanghyunui-MacBookPro:~/repos/byun618/corral' })]
    expect(title({ tab: tab({ number: 2, panes }) })).toBe('terminal 2')
  })

  // 반례 — 걸러지면 **안 되는** 제목. 필터가 넓어지면 여기서 깨진다.
  it('정상 제목은 안 걸러진다', () => {
    expect(paneTitleLabel(tab({ panes: [pane({ title: 'SUMMARY.md 작성', agent: 'claude' })] }))).toBe('SUMMARY.md 작성')
    expect(paneTitleLabel(tab({ panes: [pane({ title: '리뷰 지적 취합', agent: 'claude' })] }))).toBe('리뷰 지적 취합')
    // `@` 가 **문장 가운데**에 있는 제목 — `^` 앵커가 일하고 있다는 증거다.
    expect(paneTitleLabel(tab({ panes: [pane({ title: 'review foo@bar PR' })] }))).toBe('review foo@bar PR')
  })

  it('사용자가 준 이름은 프롬프트 모양이어도 산다 — 필터는 터미널 제목 티어에만 있다', () => {
    const panes = [pane({ title: 'byun@sanghyunui-MacBookPro:~' })]
    expect(title({ tab: tab({ label: 'byun@sanghyunui-MacBookPro:~', number: 2, panes }) })).toBe(
      'byun@sanghyunui-MacBookPro:~',
    )
  })
})

/**
 * 수정 라운드 4 (G5, 높음) — **herdr 기본 label 은 위치다.**
 * 수정 라운드 5 (G7) — 판별을 **자리 하나**에서 **`1..탭수` 범위**로 넓혔다.
 *
 * 아래 표는 코디네이터의 격리 실측 그대로다 (`04-gate1-check.md` §7, 탭 7개를 만들고 두 번째를
 * 닫음). G1 때와 같은 이유로 실측을 **그대로 박는다** — 이 표가 없으면 다음 라운드가 또
 * "기본 label = number" 라는 틀린 전제로 되돌아간다. 탭을 한 번도 안 닫은 워크스페이스만
 * 보면 `label === String(number)` 라서 이 결함이 안 보인다.
 *
 * 판별 규칙이 바뀌었어도 이 표는 **그대로 통과해야 한다** — 6행 전부 `1..6` 안의 숫자다.
 */
describe('herdr 기본 label 은 위치다 — 실측표 (G5·G7)', () => {
  /** `t2` 를 닫은 뒤: (tab_id, label, number). 남은 탭은 6개다. */
  const 닫은_뒤 = [
    { tabId: 't1', label: '1', number: 1 },
    { tabId: 't3', label: '2', number: 3 },
    { tabId: 't4', label: '3', number: 4 },
    { tabId: 't5', label: '4', number: 5 },
    { tabId: 't6', label: '5', number: 6 },
    { tabId: 't7', label: '6', number: 7 },
  ]

  for (const row of 닫은_뒤) {
    it(`${row.tabId} label "${row.label}" · number ${row.number} · 탭 6개 → 이름이 아니다`, () => {
      expect(userLabel({ tab: tab({ tabId: row.tabId, label: row.label, number: row.number }), tabCount: 6 })).toBeNull()
    })
  }

  it('생성 직후(label = number = 자리)도 그대로 거절한다', () => {
    expect(userLabel({ tab: tab({ label: '5', number: 5 }), tabCount: 7 })).toBeNull()
  })

  it('닫은 뒤 하나 더 만든 탭 — t8 label "7" · number 8 · 탭 7개', () => {
    expect(userLabel({ tab: tab({ label: '7', number: 8 }), tabCount: 7 })).toBeNull()
  })

  it('옛 기본값이 남아 있으면 `number` 쪽이 받는다 — 탭 2개인데 label "3" · number 3', () => {
    // 범위(1..2) 밖이라 범위 규칙만으로는 안 걸린다. 두 줄이 **둘 다** 필요한 이유다.
    expect(userLabel({ tab: tab({ label: '3', number: 3 }), tabCount: 2 })).toBeNull()
  })

  it('LIFE-357 J-4 회귀 — 사용자가 `357` 로 바꾸면 그건 이름이다', () => {
    expect(userLabel({ tab: tab({ label: '357', number: 3 }), tabCount: 6 })).toBe('357')
  })

  it('탭 수를 모르면(null) 범위 비교를 하지 않는다 — 모르는 값으로 이름을 지우지 않는다', () => {
    expect(userLabel({ tab: tab({ label: '2', number: 3 }), tabCount: null })).toBe('2')
  })

  it('숫자가 아닌 이름은 탭 수와 무관하게 산다', () => {
    expect(userLabel({ tab: tab({ label: '내 세션', number: 3 }), tabCount: 6 })).toBe('내 세션')
  })

  /** 반례 — 이 판별이 없으면 아래 두 칸이 `2` 로 되돌아간다 (사용자가 실환경에서 본 ⓐⓑ 그대로). */
  describe('가려져 있던 티어가 돌아온다', () => {
    it('셸 탭은 `terminal N` 으로 내려온다 — label "2" · number 3 · 탭 3개', () => {
      expect(title({ tab: tab({ label: '2', number: 3 }), tabCount: 3 })).toBe('terminal 3')
    })

    it('claude 탭은 ai-title 이 뜬다 — 같은 모양의 기본 label 이 위에 얹혀 있었다', () => {
      const claude = tab({
        label: '2',
        number: 3,
        panes: [pane({ title: 'Claude Code', agent: 'claude' })],
        digest: withProviderTitle('리뷰 지적 취합'),
      })
      expect(title({ tab: claude, tabCount: 3 })).toBe('리뷰 지적 취합')
    })

    it('ai-title 도 첫 발화도 없는 claude 탭은 `claude N` 이다', () => {
      const claude = tab({ label: '2', number: 3, panes: [pane({ title: 'Claude Code', agent: 'claude' })] })
      expect(title({ tab: claude, tabCount: 3 })).toBe('claude 3')
    })
  })
})

/**
 * 수정 라운드 5 (G7) — **탭을 닫는 과도기에 제목이 깜빡이지 않는다.**
 *
 * herdr 가 label 을 다시 매긴 봉투와 목록 갱신이 같은 틱에 안 온다. 그 사이 프레임에서는
 * 어떤 탭의 label 이 **자기 자리와 다른 숫자**로 보인다 — r4 의 자리 정확 일치는 그 프레임에서
 * 깨져 제목이 `main 2` → `2` → `main 2` 로 깜빡였다.
 */
describe('닫는 과도기 — 범위 규칙 (G7)', () => {
  it('과도기 모양(label "2" · 배열 자리 1 · 탭 2개)도 기본값으로 읽는다', () => {
    expect(userLabel({ tab: tab({ label: '2', number: 1 }), tabCount: 2 })).toBeNull()
  })

  it('그래서 그 프레임의 제목이 `2` 로 떨어지지 않는다', () => {
    const shell = tab({ label: '2', number: 1 })
    expect(title({ tab: shell, tabCount: 2 })).toBe('terminal 1')
  })

  it('claude 탭도 마찬가지 — 과도기에 ai-title 이 안 가려진다', () => {
    const claude = tab({
      label: '3',
      number: 2,
      panes: [pane({ title: 'Claude Code', agent: 'claude' })],
      digest: withProviderTitle('리뷰 지적 취합'),
    })
    expect(title({ tab: claude, tabCount: 3 })).toBe('리뷰 지적 취합')
  })

  /** 반례 (관문 ⑤) — 범위가 넓어져도 **이름은 안 먹는다.** 여기가 깨지면 G7 이 J-4 를 먹은 것이다. */
  it('반례: 탭 수보다 큰 숫자 이름은 산다', () => {
    expect(userLabel({ tab: tab({ label: '357', number: 2 }), tabCount: 6 })).toBe('357')
    expect(userLabel({ tab: tab({ label: '7', number: 2 }), tabCount: 6 })).toBe('7')
  })

  it('반례: 숫자로 **시작만** 하는 이름은 기본값이 아니다 (순수 정수만 본다)', () => {
    expect(userLabel({ tab: tab({ label: '2번 세션', number: 5 }), tabCount: 6 })).toBe('2번 세션')
    expect(userLabel({ tab: tab({ label: ' 2 ', number: 5 }), tabCount: 6 })).toBeNull() // 공백은 턴 뒤 순수 정수다
  })
})

describe('isDefaultPositionLabel — 범위 판별 (G7)', () => {
  it('1..탭수 안의 순수 정수만 기본값이다', () => {
    expect(isDefaultPositionLabel('1', 3)).toBe(true)
    expect(isDefaultPositionLabel('3', 3)).toBe(true)
    expect(isDefaultPositionLabel('4', 3)).toBe(false)
    expect(isDefaultPositionLabel('0', 3)).toBe(false)
  })

  it('숫자가 아니면 기본값이 아니다', () => {
    expect(isDefaultPositionLabel('2a', 3)).toBe(false)
    expect(isDefaultPositionLabel('-1', 3)).toBe(false)
    expect(isDefaultPositionLabel('1.0', 3)).toBe(false)
    expect(isDefaultPositionLabel('', 3)).toBe(false)
  })
})

describe('firstPromptTitle', () => {
  it('앞뒤 공백을 턴다', () => {
    expect(firstPromptTitle(tab({ digest: withDigest({ firstPrompt: '  테스트 고치기  ' }) }))).toBe('테스트 고치기')
  })

  it('없으면 null', () => {
    expect(firstPromptTitle(tab({}))).toBeNull()
  })
})
