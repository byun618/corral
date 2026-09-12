---
name: task-start
description: corral 작업 시작 — 일감(LIFE-N)을 받아 worktree·코디네이터 터미널을 기동. main 세션에서 "LIFE-N 시작하자" / "작업 시작" 시 발동. LIFE-342 첫 주행(2026-09-10)으로 검증된 절차.
---

# task-start — 작업 시작 (main 세션에서 실행)

## 절차

1. **일감 확인**: life-assistant MCP `issue_by_seq` 로 LIFE-N 본문 확보.
   슬러그를 타이틀에서 파생 — 케밥케이스 1~3단어, 생성 후 불변. 폴더·브랜치가 같이 쓴다
2. **작업 worktree 생성** (본체는 main 유지):
   ```bash
   git worktree add .claude/worktrees/LIFE-NNN-<슬러그> -b LIFE-NNN-<슬러그> main
   ```
3. **코디네이터 터미널 기동** (`--worktree path:` 는 절대경로):
   ```bash
   orca terminal create --worktree path:<worktree 절대경로> \
     --title "LIFE-NNN-<슬러그>" --command "claude" --focus --json
   ```
   `--focus` 는 코디네이터 터미널에만 — 사용자가 바로 볼 대상이므로. handle 을 확보한다
4. **LA 상태 전이**: `issue_transition` → "진행 중".
   **부모 체크포인트가 있으면 같이 움직인다** — 온보드(`issue_update` onBoard:true) + "진행 중" 전이.
   task 만 전이하고 체크포인트를 백로그·할 일로 방치하지 말 것 (LIFE-348 에서 사용자가 직접 고침, 2026-09-12).
   대칭: 라운드 종료(task 완료) 시 체크포인트도 완료 전이
5. **킥오프 주입** (Claude 부팅 — 프롬프트 `❯` — 확인 후):
   ```bash
   orca terminal send --terminal <handle> --text \
     "너는 LIFE-NNN 작업의 코디네이터야. .agents/skills/task-coordinate/SKILL.md 를 읽고 그 절차대로 진행해." --enter
   ```

## 주의

- `orca terminal create` 가 "Timed out waiting for terminal handle" 로 실패하면 (간헐적):
  **실패가 아니라 지연일 수 있다** — 핸들 응답만 타임아웃되고 터미널은 뒤늦게 생성된다
  (LIFE-345 실측: 타임아웃 3회 → 빈 Claude 터미널 3개가 나중에 나타남).
  재시도 전에 몇 초 기다렸다가 `terminal list` 로 해당 worktree 의 무제목 터미널을 확인하고,
  이미 생겼으면 그걸 쓴다 (제목은 `terminal rename`). 재시도로 새로 만들었으면
  뒤늦게 나타난 고아들을 `terminal close` 로 정리한다. `--focus` 는 빼고 생성 →
  `orca terminal switch` 로 포커스 전환이 안전
- 터미널 출력 읽기는 `orca terminal read --terminal <handle>` — 줄 수 제한 플래그는 `--limit` (`--lines` 아님)
- 이 스킬은 시작만 담당한다. 이후 전 과정은 코디네이터가 task-coordinate 스킬로 진행
