# 묶음 코디 절차 (체크포인트 feature worktree 세션에서 실행)

**묶음 코디 절차의 원본은 이 파일 하나다.** task-start(체크포인트 시작·자식 시작)와 task-coordinate(§8 묶음 자식)는 이리로 가리키기만 한다.
묶음 코디 = 서로 의존하는 작업 묶음(체크포인트) 하나를 맡는 코디네이터. feature worktree(`.claude/worktrees/LIFE-MMM-<슬러그>`,
`feature/LIFE-MMM-<슬러그>` 체크아웃)에서 돈다. **한 묶음에 묶음 코디는 하나다** — task-start 가 띄우고, 활성 묶음 코디가 있으면 새로 만들지 않는다.
작업 폴더는 체크포인트 폴더 `corral-specs/LIFE-MMM-<슬러그>/`(절대경로)다.

**이 문서에는 도구 명령이 없다.** 제어 도구 동작은 능력 이름(겹낫표)으로만 적고 명령은 선택한 하네스 매핑에서 읽는다(`.agents/harness/capabilities.md`).
git 명령 블록은 그대로 쓴다.

## 1. task-coordinate 중 무엇을 따르나

[task-coordinate](../SKILL.md) 의 절 가운데 묶음 코디가 따르는 것:

| task-coordinate | 묶음 코디 |
| --- | --- |
| §0 실제 세션 확인 | 따른다 — `00-start.md` 는 체크포인트 폴더의 것 |
| §1 분석 · §2 판정 기준 · §3 킥오프 · 게이트 ⓪ | **분해 전이면** 묶음 단위로 따른다(아래 2) — 분해가 끝났으면 하지 않는다 |
| §4 구현 · §5 코드 리뷰 · §6 판정 · §7 게이트 ① | 하지 않는다 — 자식 코디 몫. 묶음 코디는 구현 워커·리뷰어를 띄우지 않는다 |
| §8 게이트 ②·PR·정리 | 자식 몫은 자식 코디가 한다(`task-finish.sh --into`). 묶음 마무리는 아래 6 |
| 경로(경량/전체) | 묶음에는 없다 — 자식마다 그 자식의 게이트 ⓪ 에서 정한다 |

LA: `진행 중` 전이는 task-start 5단계를 실행한 쪽이 한다 — 체크포인트는 묶음 코디를 띄운 본체, 자식은 그 자식을 시작한 묶음 코디(3 절).
그 뒤 자식의 전이(`분석 중`·`개발 중`·`검증 중`)는 자식 코디, 체크포인트·자식의 `완료` 는 출고(release §7)다.

## 2. 분해 — 분해 전일 때만

- `00-start.md` 의 분해 상태가 `분해 전` 이면 §1~§3 을 묶음 단위로 한다: 체크포인트 본문·자식 후보 분석 → `00-analysis.md`,
  묶음 확인 기준(자식 기준이 아니라 묶음을 합쳤을 때 볼 것) → `01-criteria.md`, 분해 → `02-breakdown.md`
  (자식 목록·의존·순서·겹치는 파일·자식별 코디 도구·네이티브 관문을 쓰는 자식).
- **게이트 ⓪** 에서 분해를 보고하고 멈춘다. 승인 뒤 `00-start.md` 분해 상태를 `분해 끝` 으로 바꿔 커밋한다.
- **자식이 하나뿐이거나 0 이면** 게이트 ⓪ 에서 처리 방식을 제안한다 — 하나: feature 를 접고 독립 작업으로(feature 삭제는 사용자 확인 뒤)
  또는 feature 에서 그대로 진행 / 0(취소·분해 결과 없음): 원격·로컬 feature 와 feature worktree 삭제. 사용자 확인 없이 지우지 않는다.
- **다른 자식과 의존이 없는 자식**은 게이트 ⓪ 에서 묶음 밖(main 에서 따는 독립 작업 — 본체가 task-start)으로 뺄지 정한다. 독립 자식 여럿·혼합이어도 같다 —
  빼고 나서 서로 의존하는 자식이 둘 미만이면 위 「하나뿐이거나 0」 처리로 간다.
- `00-start.md` 가 `분해 끝, 다시 하지 않음` 이면(본체가 이미 분해·자식 시작을 한 경우) 분석·분해를 다시 하지 않는다 —
  기록된 자식과 그 코디 세션을 확인해 3·4 의 대상에 넣고 시작한다.

## 3. 자식 시작

- **자식 task-start 는 묶음 코디가 한다.** task-start 스킬을 이 세션에서 그대로 따른다 — 분기 기준은 `origin/feature/LIFE-MMM-<슬러그>`,
  상위 지정은 이 feature worktree.
- **worktree 는 task-start 2단계 블록 그대로 본체 기준 절대경로로 만든다.** 이 세션의 cwd 는 feature worktree 라
  상대경로 `.claude/worktrees/…` 는 feature worktree 아래로 풀려 중첩된다(AGENTS.md 「중첩 금지」).
- 자식 `00-start.md` 는 시작한 묶음 코디가 쓰고 킥오프 전달 *전* 에 그 자식 폴더만 커밋한다(task-start 3·6단계). 전달 뒤 자식 폴더·자식 `00-start.md` 는
  **자식 코디 것** — 묶음 코디는 고치지 않는다. 묶음 코디가 쓰고 커밋하는 것은 자기 폴더(`02-breakdown.md` 등)와 전달 전 자식 `00-start.md` 뿐이다.
  AGENTS.md 「산출물 규칙」의 「00-start 는 본체」는 묶음 자식에서는 그 자식을 시작한 묶음 코디로 읽는다.
- 자식 `00-start.md` 에 **묶음 코디 연락처**(묶음 코디의 도구·세션 이름·handle)를 적는다 — 자식 코디가 반영 알림(task-coordinate §8)을 보낼 주소다.
- 시작 순서는 `02-breakdown.md` 를 따른다. 겹치는 파일이 있는 자식은 앞 자식이 feature 에 반영된 뒤 시작하거나, 동시면 겹치는 자리를 양쪽 킥오프에 적는다.

## 4. 감독·조율

- **게이트는 자식 코디가 사용자에게 직접 보고한다** — 묶음 코디는 자식의 게이트 ⓪①② 를 대신하지 않는다.
- 조율 대상: 겹치는 파일·반영 순서·**네이티브 관문 직렬**(설치본·사용자 런타임을 쓰는 관문은 한 번에 한 자식). 순서를 정하면 `02-breakdown.md` 에 적고 해당 자식 코디에게 알린다.
- 자식 코디 세션 상태는 『화면 관측』으로 본다. 그 능력이 공백인 매핑(bare)에서는 감독 관측이 공백이다 — 사용자에게 상태를 묻는다.
- **연락**:
  - claude 묶음 코디 ↔ claude 자식 코디: SendMessage. 주소는 세션 이름이다 — 자식 `00-start.md` 의 연락처, 없으면 세션 목록(ListAgents)에서 확인한다.
  - **codex 가 끼면(어느 쪽이든) SendMessage 는 공백이다**(claude↔claude 한정). 묶음 → 자식은 알릴 내용을 `02-breakdown.md` 「알림」 절에 적어 커밋하고,
    자식 세션이 입력 대기일 때 『본문 주입』으로 그 절을 읽으라는 한 줄만 넣는다 — 일하는 중인 세션에는 넣지 않는다. 자식 → 묶음 방향 통로는 없다:
    묶음 코디가 자식 폴더 파일과 『화면 관측』으로 읽는다.
  - 보장 수준: 배달은 매핑의 『본문 주입』 수준을 따른다(corral 은 배달 증명, bare 는 『본문 주입』 자체가 공백). 받은 쪽이 읽고 처리했다는 확인은 어느 매핑에서도 공백이다.
- 자식 폴더를 고쳐야 할 일이 보이면 고치지 않고 그 자식 코디에게 알린다.

## 5. feature worktree 따라가기

자식이 `task-finish.sh --into` 로 feature 에 반영하면(임시 worktree 에서 merge·push — 이 worktree 는 그대로다) 이 worktree 를 따라 올린다.
main 이 움직였으면 main 을 feature 로 merge 해 push 한다 — **rebase 금지**(자식 worktree 가 살아 있다). merge 가 멈추면 이 worktree 에서 풀고 커밋한다.

```bash
git pull --ff-only origin feature/LIFE-MMM-<슬러그>        # 자식 반영 뒤
git fetch origin main && git merge origin/main && git push origin feature/LIFE-MMM-<슬러그>   # main 이 움직였을 때
```

## 6. 묶음 마무리 — 마지막 자식이 feature 에 반영된 뒤

자식 코디는 자기 정리(`task-finish.sh --into`)까지만 한다. 그 뒤는 묶음 코디다.

1. 5 대로 feature worktree 를 올리고 **묶음 통합 확인** — 이 worktree 에서 빌드·실행해 `01-criteria.md` 의 묶음 기준을 확인하고
   사용자에게 직접 실행·확인을 요청한다(실행 방법 한 줄).
2. 묶음 폴더에 `verdict.md`(자식 판정 링크·묶음 확인 결과 — 판정표는 `.agents/rules/validation.md` 7칸)·`pr.md`(자식들을 묶어 task-coordinate §8 의 PR 원고 방식으로)·
   `handoff-main.md`(PR base `main`, 실린 자식 일감, LA 다음 전이)를 쓴다. 출고 회고(release §4)는 이 `verdict.md` 의 자식 판정 링크로 자식 폴더를 찾는다.
3. **⛔ 출고 승인 게이트** — 보고하고 멈춘다(PR 생성 전). 승인이 오면 묶음 폴더를 커밋·push 하고 `scripts/task-pr.sh feature/LIFE-MMM-<슬러그>` 로 feature → main PR 하나를 연다.
   스크립트의 「다음」 안내대로 남은 자식 worktree 가 없는지 본다.
4. 사용자에게 PR 번호·`handoff-main.md` 절대경로를 보고하고 끝낸다. **묶음 코디의 수명은 여기까지다** — 출고는 본체(release).
   feature worktree 는 출고 때까지 남긴다 — 아래 「출고 중 수정」의 재개 자리다. 출고 뒤 feature worktree·로컬 feature 브랜치 정리는 release §7 4번이다.
5. **출고 중 수정**(release §2)이 묶음 PR 에 필요하면: 본체가 묶음 코디를 같은 feature worktree 에서 재개한다(task-start 재개 규칙 — 세션이 없을 때만 재기동).
   묶음 코디는 수정 자식을 feature 에서 시작해(3 절) 반영을 받고(5 절) feature 를 push 한 뒤 본체에 알린다 — 본체가 같은 PR 을 다시 `gather` 한다.
