---
name: task-start
description: >-
  corral 작업 시작. LIFE-N 일감의 작업 worktree를 만들고 선택한 Claude 또는 Codex
  코디네이터를 기동한다. main 세션에서 "LIFE-N 시작하자", "작업 시작",
  "이번 코디네이터는 Codex로" 같은 요청에 사용한다.
---

# task-start — 작업 시작 (main 세션에서 실행)

## 코디네이터 선택

- 신규 작업은 사용자가 지정한 `claude` 또는 `codex`를 사용한다. 미지정 기본값은 `claude`.
  이 선택은 해당 작업에만 적용한다. 현재 대화 도구나 전역 기본 모델로 추측해 바꾸지 않는다.
- 기존 작업은 `specs/LIFE-NNN-<슬러그>/00-start.md`를 먼저 읽는다. 미지정 재개는 기록된
  코디네이터를 따른다. 기록이 없는 과거 작업은 킥오프·실제 세션을 확인해 기록부터 보완한다.
- 선택이 기존 기록과 다르거나 `claude`·`codex` 외 도구를 요청하면 새 터미널을 만들지 않는다 — 도중 교체는
  이 스킬 밖이다. 기존 코디네이터·워커·Run과 미완 작업을 확인하고 인계 범위를 사용자와 정한 뒤 진행한다.
  동시에 두 코디네이터를 만들지 않는다.
- 코디네이터 선택과 워커·리뷰어 구성은 별개다. 신규 기본은 **Opus high + native Fable advisor
  단독 구현 → 3자 코드 리뷰(Astra xhigh · 별도 Claude Opus high · Grok)**다(task-coordinate §4–5).
  설계는 별도 단계가 아니라 구현 워커가 흡수한다.
  신규 작업은 [기본 구성](defaults.md)을 설정 질문 없이 적용하고 명시한 변경만 덮어쓴다.
  기존 작업 재개는 기록된 구성을 유지한다. 사용자 변경 지시는 예외 범위와 함께 기록한다.

## 절차

1. **일감·환경 확인**: life-assistant MCP `issue_by_seq`로 LIFE-N 본문을 읽는다.
   `git status`·`git worktree list`로 본체 main과 기존 작업을 확인하고,
   `command -v <선택 도구>`·`<선택 도구> --help`·`corral status --json`으로 기동 가능 여부를 확인한다.
   LA가 없거나 corral 런타임이 꺼져 있으면(`status`가 exit 1) 이 단계에서 원인을 보고한다. 다른 도구로 몰래 대체하지 않는다.
   **corral 런타임·herdr backend는 `CLAUDE_CODE_*`·`CLAUDECODE`·`CLAUDE_PID`·`CLAUDE_EFFORT`·`ORCA_AGENT_HOOK_*`를
   제거한 env로 띄운다**(`app/scripts/l394/env.mjs` 규칙). pane은 backend에서 env를 상속하므로 마커가 남으면
   provider가 세션 record를 쓰지 않아 `prompt`·`worker-start`의 배달 판정이 조용히 무력화된다 —
   `record.unavailableReason`이 null이 아니면 마커 상속부터 의심한다.
   슬러그는 타이틀에서 케밥케이스 1~3단어로 파생하며, 기존 LIFE-N의 슬러그는 재사용한다.
2. **작업 worktree 생성** (신규만, 본체는 main 유지):
   ```bash
   git worktree add .claude/worktrees/LIFE-NNN-<슬러그> -b LIFE-NNN-<슬러그> main
   ```
   재개는 기존 worktree와 코디네이터 터미널을 확인한다. 활성 코디네이터가 있으면 그 세션으로
   이어가며 새로 만들지 않는다. 세션이 없을 때만 기록된 도구로 재기동한다.
3. **기동 전에 선택 기록**: 작업 worktree에서 `specs/LIFE-NNN-<슬러그>/00-start.md`를 작성·커밋한다.
   최소 항목: LIFE-N, 슬러그, 작업 브랜치·절대 worktree 경로, 코디네이터 도구, 선택 근거
   (사용자 지정/신규 기본값/재개), 모델·effort(미지정 기본값은 [defaults.md](defaults.md):
   claude → `claude-fable-5-1` high, codex → `gpt-6-astra` high, 2026-09-22), 기동 상태.
   모든 역할의 요청 모델·effort·advisor·단독/경쟁 방식은 defaults.md에서 복사한다. 처음 상태는 `기동 전`.
   워커 구성·구현→3자 리뷰 흐름·사용자 예외, 수정 라운드용 워커 유지 요청도 기록하고, 재개는 이력을 덧붙인다.
4. **코디네이터 터미널 기동** (`--worktree path:`에는 기록한 절대경로):

   선택은 `--agent claude` 또는 `--agent codex`다 — corral이 pane 안에서 provider를 직접 띄우므로
   argv를 문자열로 조립하지 않는다. 모델·effort는 사용자 지정값, 미지정이면 3단계의 기본값을
   `--model`·`--effort` 플래그로 준다. `--advisor`는 `--agent claude`에만 붙고, `--command`와
   `--agent`는 상호배타다(위반은 효과 없는 `invalid_request`).

   ```bash
   corral terminal create --worktree path:<작업 worktree 절대경로> \
     --title "LIFE-NNN-<슬러그> · <코디네이터>" \
     --agent <claude|codex> --model <모델> --effort <등급> --focus --json
   ```
   생성 응답의 handle을 확보하고 `00-start.md`에 기록한다. `--focus`는 사용자에게 보여줄
   코디네이터 터미널에만 사용한다(헤드리스에서는 미지원).
5. **LA 상태 전이**: 시작 세션이 `issue_transition` → `진행 중`을 요청한다. 코디네이터가 먼저 전진했다면
   forward-only의 `same`·`backward` 응답을 존중한다. 부모가 checkpoint이면 함께 온보드(`issue_update`
   onBoard:true)하고 `진행 중`으로 전이하되 project이면 적용하지 않는다. 종료 때 부모 완료는 다른 미완
   자식이 없는지 확인한 뒤 판단한다 — task 하나 완료로 checkpoint 전체를 완료하지 않는다.

6. **준비 확인 후 킥오프 주입**:
   ```bash
   corral terminal wait --terminal <handle> --for agent-ready --timeout-ms 60000 --json
   ```
   `satisfied`를 확인한다. trust·로그인 화면이나 미검증 detect manifest면 기다리지 않고 즉시
   `satisfied: false`로 돌아온다 — 그 화면은 사람이 치우고 corral은 대답하지 않는다. 타임아웃은
   준비 완료가 아니며, 어느 쪽이었는지는 `agent.evidence`로 구분한다.
   준비가 확인되면 `00-start.md`의 상태를 `킥오프 전달 준비`로 갱신·커밋한다.
   그다음 아래 지시를 **한 번만** 보낸다(`prompt`가 managed agent 주입의 정본이고 `send`는 raw 입력이다).
   ```bash
   corral terminal prompt --terminal <handle> --wait accepted --json --text \
     "너는 LIFE-NNN 작업의 코디네이터야. specs/LIFE-NNN-<슬러그>/00-start.md와 .agents/skills/task-coordinate/SKILL.md를 읽고, 실제 세션에서 전제 도구를 확인한 뒤 절차대로 진행해."
   ```
   응답의 `requestId`(corral이 민팅한 `r1.<13자리 ms>.<UUID>`)와 `record.matchCount`를 `00-start.md`에 기록한다.
   `outcome: completed`만 배달 확인이고 그 밖(`queued`·`outcome_unknown`)은 중복 주입하지 않는다.
   전달 이후 이 파일과 작업 브랜치는 코디네이터가 맡는다. 시작 세션은 더 수정하지 않는다.
   실제 세션 점검 후 코디네이터가 `준비 완료` 또는 `차단 사유`를 기록한다.

## 기동 실패·재개

- `terminal create` 응답 타임아웃은 실패가 아니라 지연일 수 있다. 같은 worktree의
  `terminal list`로 해당 도구 터미널을 먼저 찾고, 살아 있으면 그 handle을 기록해 재사용한다.
  확인 없이 재시도해 중복 코디네이터를 만들지 않는다. 남은 상태·다음 조치를 `00-start.md`에 남긴다.
- 포커스 전환 때문에 문제가 나면 `--focus`를 빼고 생성 후 `terminal switch`를 쓴다.
- 터미널 읽기는 `corral terminal read --terminal <handle>` — `--limit`은 줄 수가 아니라 **바이트**다(1..262144).
- 시작 세션은 킥오프 전달 후 구현을 지휘하지 않는다. 이후 과정은 선택된 코디네이터가 맡고,
  출고 승인 후 본체 마무리 담당에게 `handoff-main.md`로 돌아온다(task-coordinate §8).
