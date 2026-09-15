// 제목 3단의 **순서를 못박는 테스트** (기준 C1) + LIFE-357 거절 목록 회귀 (기준 C3).
//
// C1 이 "순서가 이대로임을 단위 테스트로 고정" 이라고 쓴 이유는, 티어를 하나 더 끼우는 변경이
// 조용히 순서를 뒤집기 쉬워서다. 그래서 각 티어마다 **위 티어를 하나씩 벗기며** 다음 티어로
// 내려오는지 확인한다 — 한 티어만 단독으로 확인하면 순서는 안 고정된다.

import { describe, expect, it } from 'vitest'
import type { AgentSessionRef, PaneRow, SessionDigest, TabRow } from '../../shared/types.js'
import { EMPTY_SESSION_DIGEST } from '../../shared/types.js'
import { paneTitleLabel, providerTitle, sessionTitle, tabAgent, tabPosition, userLabel } from './session-title.js'

/**
 * 제목 한 줄. 브랜치 티어(G3)는 **에이전트 없는 탭**에만 닿으므로 대부분의 경우와 무관하다 —
 * 기본은 브랜치 없음이고, G3 절에서만 값을 준다.
 */
function title(input: { tab: TabRow; branch?: string | null; position?: number | null }): string {
  return sessionTitle({ tab: input.tab, branch: input.branch ?? null, position: input.position ?? null })
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

describe('sessionTitle — 3단 우선순위 (C1)', () => {
  const panes = [pane({ title: 'SUMMARY.md 작성', agent: 'claude' })]
  const digest = withProviderTitle('리뷰 지적 취합')

  it('① 사용자가 준 이름이 맨 위다 — provider 제목·터미널 제목이 다 있어도 이긴다', () => {
    expect(title({ tab: tab({ label: '내 세션', number: 2, panes, digest }) })).toBe('내 세션')
  })

  it('② 사용자 이름이 없으면 provider 세션 제목 — 터미널 제목보다 위다', () => {
    expect(title({ tab: tab({ number: 2, panes, digest }) })).toBe('리뷰 지적 취합')
  })

  it('③ provider 제목이 없으면 정제된 터미널 제목으로 내려온다', () => {
    expect(title({ tab: tab({ number: 2, panes, digest: withProviderTitle(null) }) })).toBe('SUMMARY.md 작성')
  })

  it('④ 셋 다 없으면 폴백 — 에이전트 이름 + 표찰 번호', () => {
    expect(title({ tab: tab({ number: 3, panes: [pane({ agent: 'codex' })] }) })).toBe('codex 3')
  })

  it('④ 에이전트가 없는 셸 탭의 폴백', () => {
    expect(title({ tab: tab({ number: 4 }) })).toBe('세션 4')
  })

  it('provider 제목이 공백뿐이면 티어를 건너뛴다 — 빈 제목을 그리지 않는다', () => {
    expect(title({ tab: tab({ number: 2, panes, digest: withProviderTitle('   ') }) })).toBe('SUMMARY.md 작성')
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
    expect(userLabel({ tab: tab({ label: '2', number: 2 }), position: 2 })).toBeNull()
    expect(userLabel({ tab: tab({ label: '357', number: 2 }), position: 2 })).toBe('357')
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
    expect(title({ tab: tab({ number: 2, panes }), branch: 'main' })).toBe('main 2')
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

// 수정 라운드 3 G3 — 브랜치 티어. 순서는 사용자 이름 → ai-title → 터미널 제목 → **브랜치** → 폴백.
describe('브랜치 티어 (G3)', () => {
  it('에이전트 없는 셸 탭은 그 worktree 의 브랜치를 보인다', () => {
    expect(title({ tab: tab({ number: 1 }), branch: 'LIFE-366-session-identity' })).toBe('LIFE-366-session-identity 1')
  })

  it('같은 worktree 의 셸 탭 둘은 서로 다른 제목이다 (A4)', () => {
    const first = title({ tab: tab({ number: 1 }), branch: 'main' })
    const second = title({ tab: tab({ number: 2 }), branch: 'main' })
    expect(first).toBe('main 1')
    expect(second).toBe('main 2')
    expect(first).not.toBe(second)
  })

  it('브랜치가 없으면(detached HEAD·非git) `세션 N` 이다 — 빈 문자열·null 을 그리지 않는다', () => {
    expect(title({ tab: tab({ number: 3 }), branch: null })).toBe('세션 3')
    expect(title({ tab: tab({ number: 3 }), branch: '   ' })).toBe('세션 3')
  })

  it('위 티어가 먼저다 — 사용자 이름·터미널 제목이 있으면 브랜치까지 안 내려온다', () => {
    expect(title({ tab: tab({ label: '내 셸', number: 2 }), branch: 'main' })).toBe('내 셸')
    const panes = [pane({ title: 'PROBE-TITLE' })]
    expect(title({ tab: tab({ number: 2, panes }), branch: 'main' })).toBe('PROBE-TITLE')
  })

  // 반례 — **에이전트 탭은 영향을 안 받는다.** 브랜치를 무조건 끼우면 여기서 깨진다.
  it('반례 ⓐ ai-title 이 있는 에이전트 탭은 브랜치로 안 바뀐다', () => {
    const panes = [pane({ title: 'Claude Code', agent: 'claude' })]
    const digest = withProviderTitle('리뷰 지적 취합')
    expect(title({ tab: tab({ number: 2, panes, digest }), branch: 'main' })).toBe('리뷰 지적 취합')
  })

  it('반례 ⓑ 갓 띄운 에이전트 탭(제목이 전부 거절됨)도 브랜치가 아니라 `claude N` 이다', () => {
    const panes = [pane({ title: 'Claude Code', agent: 'claude' })]
    expect(title({ tab: tab({ number: 2, panes }), branch: 'main' })).toBe('claude 2')
  })
})

// detached HEAD 는 판독층이 `(detached)` 표식으로 준다 (`main/git-worktrees.ts:42`).
// 표식은 브랜치 이름이 아니라 **없음**이다 — 그대로 쓰면 detached worktree 들이 전부 같은 이름이 된다.
describe('브랜치 티어 — detached HEAD (G3)', () => {
  it('`(detached)` 는 브랜치로 안 쓴다', () => {
    expect(title({ tab: tab({ number: 1 }), branch: '(detached)' })).toBe('세션 1')
  })
})

/**
 * 수정 라운드 4 (G5, 높음) — **herdr 기본 label 은 위치다.**
 *
 * 아래 표는 코디네이터의 격리 실측 그대로다 (`04-gate1-check.md` §7, 탭 7개를 만들고 두 번째를
 * 닫음). G1 때와 같은 이유로 실측을 **그대로 박는다** — 이 표가 없으면 다음 라운드가 또
 * "기본 label = number" 라는 틀린 전제로 되돌아간다. 탭을 한 번도 안 닫은 워크스페이스만
 * 보면 `label === String(number)` 라서 이 결함이 안 보인다.
 */
describe('herdr 기본 label 은 위치다 — 실측표 (G5)', () => {
  /** `t2` 를 닫은 뒤: (tab_id, label, number) — 위치는 배열 자리다. */
  const 닫은_뒤 = [
    { tabId: 't1', label: '1', number: 1 },
    { tabId: 't3', label: '2', number: 3 },
    { tabId: 't4', label: '3', number: 4 },
    { tabId: 't5', label: '4', number: 5 },
    { tabId: 't6', label: '5', number: 6 },
    { tabId: 't7', label: '6', number: 7 },
  ]

  for (const [index, row] of 닫은_뒤.entries()) {
    it(`${row.tabId} label "${row.label}" · number ${row.number} · 위치 ${index + 1} → 이름이 아니다`, () => {
      expect(userLabel({ tab: tab({ tabId: row.tabId, label: row.label, number: row.number }), position: index + 1 })).toBeNull()
    })
  }

  it('생성 직후(label = number = 위치)도 그대로 거절한다', () => {
    expect(userLabel({ tab: tab({ label: '5', number: 5 }), position: 5 })).toBeNull()
  })

  it('닫은 뒤 하나 더 만든 탭 — t8 label "7" · number 8 · 위치 7', () => {
    expect(userLabel({ tab: tab({ label: '7', number: 8 }), position: 7 })).toBeNull()
  })

  it('옛 기본값이 남아 있어도(label = number ≠ 위치) 거절한다 — J-4 가 보던 자리', () => {
    expect(userLabel({ tab: tab({ label: '3', number: 3 }), position: 2 })).toBeNull()
  })

  it('LIFE-357 J-4 회귀 — 사용자가 `357` 로 바꾸면 그건 이름이다', () => {
    expect(userLabel({ tab: tab({ label: '357', number: 3 }), position: 2 })).toBe('357')
  })

  it('위치를 모르면(목록에 없다) 위치 비교를 하지 않는다 — 모르는 값으로 이름을 지우지 않는다', () => {
    expect(userLabel({ tab: tab({ label: '2', number: 3 }), position: null })).toBe('2')
  })

  it('숫자가 아닌 이름은 위치와 무관하게 산다', () => {
    expect(userLabel({ tab: tab({ label: '내 세션', number: 3 }), position: 2 })).toBe('내 세션')
  })

  /** 반례 — 위치를 안 보면 이 두 칸이 `2` 로 되돌아간다 (사용자가 실환경에서 본 ⓐⓑ 그대로). */
  describe('가려져 있던 티어가 돌아온다', () => {
    it('셸 탭은 브랜치 티어로 내려온다 — label "2" · number 3 · 위치 2', () => {
      expect(title({ tab: tab({ label: '2', number: 3 }), branch: 'main', position: 2 })).toBe('main 3')
    })

    it('claude 탭은 ai-title 이 뜬다 — 같은 모양의 기본 label 이 위에 얹혀 있었다', () => {
      const claude = tab({
        label: '2',
        number: 3,
        panes: [pane({ title: 'Claude Code', agent: 'claude' })],
        digest: withProviderTitle('리뷰 지적 취합'),
      })
      expect(title({ tab: claude, branch: 'main', position: 2 })).toBe('리뷰 지적 취합')
    })

    it('ai-title 이 아직 없는 claude 탭은 `claude N` 이다 (브랜치로 덮이지 않는다)', () => {
      const claude = tab({ label: '2', number: 3, panes: [pane({ title: 'Claude Code', agent: 'claude' })] })
      expect(title({ tab: claude, branch: 'main', position: 2 })).toBe('claude 3')
    })
  })
})

describe('tabPosition — 전체 목록의 1-기반 자리 (G5)', () => {
  const tabs = [tab({ tabId: 't1', label: '1', number: 1 }), tab({ tabId: 't3', label: '2', number: 3 }), tab({ tabId: 't4', label: '3', number: 4 })]

  it('배열 자리로 센다 — 가운데를 닫아 number 에 구멍이 나도 위치는 1,2,3 이다', () => {
    expect(tabs.map((row) => tabPosition({ tabs, tabId: row.tabId }))).toEqual([1, 2, 3])
  })

  it('목록에 없으면 null', () => {
    expect(tabPosition({ tabs, tabId: 't9' })).toBeNull()
  })

  it('빈 목록도 null', () => {
    expect(tabPosition({ tabs: [], tabId: 't1' })).toBeNull()
  })
})
