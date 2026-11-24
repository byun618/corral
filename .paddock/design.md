# paddock 설계 — corral

- paddock: 0.11.0 · 판정: 기존 · 날짜: 2026-11-24
- 모듈: l1 l2 specs-repo bundle · harness: corral

## 분석

| 항목 | 값 | 출처 |
| --- | --- | --- |
| 스택 | Electron + React(electron-vite, TypeScript) 데스크톱 앱 `app/`, Expo 모바일 `mobile/` | app/package.json · mobile/package.json |
| 패키지 매니저 | npm (`npm ci`) | package-lock.json · .github/workflows/pr-ci.yml |
| 빌드 | `app/` 에서 `npm run build` (typecheck 포함) | app/package.json — 이 세션에서 실행 안 함 |
| 실행(개발) | `app/` 에서 `npm run dev` | app/package.json — 실행 안 함 |
| 테스트 | `app/` 에서 `npm test` (`vitest run && node scripts/run-nodetest.mjs`) · `mobile/` 에서 `npm run typecheck && npm test` | package.json — 실행 안 함 |
| 린트·경계 | `npm run lint` · `npm run check:boundary` | app/package.json — 실행 안 함 |
| CI | PR CI(self-hosted 러너): `npm ci` → typecheck → `npm test`. 참고 신호(출고가 보지 않음) | .github/workflows/pr-ci.yml · 옛 AGENTS.md |
| 배포 산출물 | dmg(`npm run package:mac`) · APK · GitHub Release · 태그 | app/package.json · scripts/release.sh · release 스킬 |
| 사용자 실행 경로 | 설치본 앱 + CLI shim, 동봉 herdr | app/INSTALL.md |
| 로컬 데이터·런타임 자원 | 앱 userData, 동봉 herdr 설정·상태, herdr worktree 폴더 | app/INSTALL.md |
| 외부 의존 | herdr, provider CLI(claude·codex·grok), gh, 일감 트래커(life-assistant MCP) | 옛 task-start·task-coordinate |
| 에이전트 도구 | claude · codex · grok — 설치 확인함 | `command -v` — 이 세션 |
| 터미널 제어 도구 | corral · orca · tmux 모두 설치 | `command -v` — 이 세션 |
| git 훅 | `core.hooksPath=.githooks`, gitleaks 설치 | `git config` — 이 세션 |
| 원격 | GitHub, private | `gh repo view` — 이 세션 |
| Codex 지정 모델 | 기존 defaults 의 지정 모델이 계정 카탈로그에 없음 — 리뷰어 「없음」 | 모델 카탈로그 조회 — 이 세션 |

## 결정

| 항목 | 값 | 근거 |
| --- | --- | --- |
| l1 · l2 | 켬 | 기존에 같은 흐름(task-start·task-coordinate·harness 매핑)을 쓰고 있었다 |
| specs-repo | 켬, `SPECS_ROOT=<본체>/../corral-specs` | 옛 AGENTS.md 「산출물 규칙」 — 이미 있는 레포, 새로 만들지 않음 |
| bundle | 켬, `BUNDLE_PREFIX=feature/` | 옛 AGENTS.md 「브랜치 규약」 묶음 브랜치·bundle.md |
| harness | corral | 설치돼 있고 옛 매핑 선택 순서의 첫째 |
| 옛 매핑 파일 | `corral.md` 지움(내용은 `corral/` 폴더와 `corral-notes.md` 로), `orca.md`·`bare.md` 는 참고용으로 남김 | 사용자 결정. paddock 은 harness 를 하나만 깐다 — 옛 「corral → orca → bare」 선택 순서는 쓰지 않는다 |
| 리뷰어 구성 | Codex 를 쓰지 않는다 — Claude(①)·Grok(②) 2자 리뷰가 기본, 경쟁 구현 없음 | 사용자 결정. 지정 Codex 모델이 계정 카탈로그에 없어 실제로 이 구성으로 돌고 있었다 |
| 격리 herdr 세션 정리 | 손 단계(D16 · corral-notes) | 사용자 결정. 새 task-finish.sh 는 멈추지 않는다 |
| devlog 형식 | 기존 세 관점 + 회고 세 렌즈 유지(`.agents/corral-coordinate.md`) | 사용자 결정 |
| 근거 표기(LIFE 번호·날짜) | 고정 문장과 뜻이 같은 덩이는 꼬리를 버림 | 사용자 결정 — git 이력에 남는다 |
| WORKTREE_DIR | .claude/worktrees | 옛 AGENTS.md |
| BASE_BRANCH · ISSUE_PREFIX | main · LIFE | git · 옛 AGENTS.md |
| MAX_FIX_ROUNDS | 3 | 옛 task-coordinate 수정 상한 |
| VARIANT_SUFFIXES | `-claude` | 옛 구현 브랜치 이름. Codex 를 쓰지 않아 `-codex` 는 뺌 |
| PR_FOOTER | Claude Code 서명 한 줄 | 옛 scripts/task-pr.sh 가 PR 본문 끝에 쓰던 줄 |
| PADDOCK_SKIP | (빈 값) | 깔지 않을 경로 없음 |
| 출고 | 기존 방식 유지 — release 스킬 + `scripts/release.sh`. 제안 없음 — 기존 확인 | 사용자 선택(「정하지 않음」도 선택지로 보임) |
| 프로젝트 소유 파일 | `.agents/rules/corral.md` · `.agents/corral-coordinate.md` · `.agents/harness/corral-notes.md` | paddock 고정 문서에 자리가 없는 기존 규칙을 원문 그대로 옮길 곳 |
| 훅 | 그대로(`.githooks`), pre-commit 은 렌더본 | 표기 줄만 다름 |
| 기존 스킬 release · design-brief · design-intake | 그대로 | paddock 에 대응 스킬 없음. 산출물은 이미 corral-specs |

## 설계 슬롯

| ID | 요약 | 근거·출처 | 확인 필요 |
| --- | --- | --- | --- |
| D1 | herdr 기반 AI 워크스페이스 소개 4줄 | 옛 AGENTS.md 머리말 원문 | — |
| D3 | 일감 조회 = life-assistant MCP `issue_by_seq`, 시작 전이 = `진행 중`, 체크포인트 부모 온보드 | 옛 task-start | — |
| D5 | 네이티브 = 설치본 앱 경로, 격리(userData·XDG 분리·창 없는 serve·fixture)는 세지 않음 | 옛 validation.md · app/INSTALL.md | — |
| D6 | 커밋 안 하는 사본(userData·herdr·provider 설정 백업), 직렬 자원(설치본 앱·본체 checkout) | 옛 validation.md · bundle.md | — |
| D7 | 빠른 확인 = 빌드·`npm test`·진입점 1회, 최종 관문 = 01-criteria 관문 + lint + 설치본 1회 | 옛 task-coordinate §2 · package.json | — |
| D8 | 경량 4범주(렌더러 UI·문서·정적 값·자산·설정), 전체 = PTY·herdr·에이전트 상태·IPC·레지스트리 동시성·영속 형식·출고 스크립트 | 옛 task-coordinate §3 원문 | — |
| D9 | 구현 worktree 하네스: `pathToFileURL` import, `node --import tsx`, `createRequire`, 도구 폴더 `app/scripts/<하는 일>/` | 옛 implementation.md 원문 | — |
| D12 | Grok 이 들어가면 herdr API·라이브러리 문서 대조, 하네스 프로브 유틸 자리 | 옛 reviewer.md | — |
| D13 | 외부 서치 = Grok, 한도는 기동 배너로 확인 | 옛 task-coordinate §1 · defaults.md | — |
| D15 | 사용자 확인 실행: 작업 worktree `app/` 에서 `npm ci && npm run dev`, 설치본은 `package:mac` | app/package.json · app/INSTALL.md | — (release 스킬 §3 에 같은 명령) |
| D16 | 머지 뒤 단계는 release 스킬 §6·§7. 격리 herdr 세션은 손으로 멈춘다 | release 스킬 · 옛 task-finish.sh | — |
| D17 | 출고는 release 스킬 + `scripts/release.sh`. task-close 의 머지 이후 단계는 쓰지 않음 | release 스킬 · 옛 AGENTS.md | — |

## 기존 파일 처리

파일 단위 요약. 덩어리(절·불릿 묶음) 단위 전수는 아래 「덩어리 전수」.

| 출처 | 목적지 | 처리 |
| --- | --- | --- |
| AGENTS.md | 렌더본 + D1 · `.agents/rules/corral.md`(브랜치·출고 사실, 루트 공용 파일, SendMessage, grok 자동 로드) · D17 | 옮김 뒤 렌더본으로 |
| CLAUDE.md · .codex/agents/reviewer.toml · docs/adr/template.md · .githooks/pre-commit | 렌더본 | 표기 줄만 다름 — 렌더본으로 |
| .agents/agents/reviewer.md | 렌더본 + D12 | 옮김 뒤 렌더본으로 |
| .agents/defaults.md | 같은 파일(seed 형식으로 다시 씀) | Claude 값·선택 근거 원문 유지. Codex 행·근거 3항·일시 중지·자동 전환 절은 사용자 결정으로 뺌 |
| .agents/rules/validation.md | 렌더본 + D5 · D6 · `.agents/rules/corral.md`(GUI 캡처·기록기·프로세스 판정 3건) | 옮김 뒤 렌더본으로 |
| .agents/rules/coding.md · writing.md | 그대로 | 렌더본과 충돌 없음 |
| .agents/skills/task-start/SKILL.md | 렌더본 + D3 | 옮김 뒤 렌더본으로 |
| .agents/skills/task-coordinate/SKILL.md | 렌더본 + D7 · D8 · D13 · D15 · `.agents/corral-coordinate.md` | 옮김 뒤 렌더본으로 |
| …/references/implementation.md | 렌더본 + D9 · `.agents/corral-coordinate.md` | 옮김 뒤 렌더본으로 |
| …/references/bundle.md | 렌더본 + D6 | 옮김 뒤 렌더본으로 |
| .agents/harness/capabilities.md · capability-check.mjs | 렌더본 | 렌더본으로 |
| .agents/harness/corral.md | `.agents/harness/corral/`(렌더본) + `.agents/harness/corral-notes.md`(도구 동작·설치본 네이티브 관문 원문) | 옮김 뒤 지움 |
| .agents/harness/orca.md · bare.md | 그대로 | 참고용으로 남김 |
| .agents/learnings/README.md · docs/adr/README.md | 렌더본. 「release §4」 지목은 D17 | 렌더본으로 |
| .agents/learnings/*.md · docs/adr/0001~0026 | 그대로 | 본문 그대로. learnings/harness.md 의 옛 매핑 경로 참조만 새 경로로 고침 |
| scripts/task-pr.sh · task-finish.sh | 렌더본 + `PR_FOOTER` · D16 · D17 | 렌더본으로. 격리 herdr 세션 자동 정지는 사라짐 → corral-notes · D16 |
| scripts/task-finish-test.sh · app/scripts/release-check/quick-check.sh | 같은 파일 | 새 스크립트·매핑 경로에 맞춰 고침 |
| .agents/skills/release · design-brief · design-intake · scripts/release.sh | 그대로 | 손대지 않음 |

## 변경 이력

| 날짜 | 변경 | 대상 | 사유 |
| --- | --- | --- | --- |
| 2026-11-24 | adopt 0.11.0 적용 | 전체 | 기존 흐름을 paddock 뼈대로 옮김 |
| 2026-11-24 | 문서 대조 검사 돌림 | app/scripts/release-check/doc-check.sh · quick-check.sh | 문구가 옮겨 간 행(브랜치·출고 규약 → `.agents/rules/corral.md`, devlog·세션 기록 → `.agents/corral-coordinate.md`, 세션 기동 → `corral/session-start.md`)은 자리를 돌렸다. 문구가 paddock 고정 문장으로 바뀐 행(quick-check 대조표 9개, doc-check 「흐름 표 8행」)은 고치지 않고 실패로 둔다 |
| 2026-11-24 | 시험 fixture 에 설정 추가 | scripts/task-finish-test.sh | 새 task-finish.sh 가 값을 `.paddock/config.sh` 에서 읽는다. 56/56 통과 |

## 덩어리 전수

### 전수 A

#### plan-A — corral OLD ↔ paddock NEW 전수 대조

- OLD = <대상>/<경로>, NEW = <STAGE>/out/<경로>
- 약칭: NEW 줄은 해당 절의 NEW 파일 기준. 「rules」= NEW .agents/defaults.rules.md, 「tools」= NEW .agents/agent-tools.md, 「defaults」= NEW .agents/defaults.md.
- 슬롯은 NEW 에서 AGENTS.md D1, reviewer.md D12, defaults.md 값 표·선택 근거(Dn 번호 없는 adopt 주석)뿐이다. D3·D16·D17 은 NEW task-start/task-close 스킬 쪽 슬롯(이 대조 범위 밖)이고, NEW AGENTS.md 가 이를 가리킨다.
- NEW 에는 release 스킬이 없다(OLD 에는 .agents/skills/release 있음). 출고 관련 「옮김」은 release 스킬 유지 또는 task-close D17(NEW .agents/skills/task-close/SKILL.md:18-20, 「이 프로젝트의 출고 방식」 슬롯)이 가리키는 곳으로 간다.

#### 먼저 볼 발견

1. **끊긴 참조**: NEW .agents/skills/task-coordinate/references/bundle.md:12 가 「AGENTS.md 「세션 간 통신」의 claude↔claude 보조 통로」(SendMessage)를 가리키는데, NEW AGENTS.md 「세션 간 통신」은 OLD 89행 「보조: Claude 세션 간 SendMessage (claude↔claude 한정)」을 뺐다 (표 A-47).
2. **뜻 바뀜 — 출고 → PR 생성/마무리**: OLD 의 「출고」는 두 가지 뜻이 섞여 있다. 게이트 ② 「출고(PR 생성 전)」는 NEW 에서 「PR 생성」으로 이름만 바뀌었고, 단계 8 「출고」(release/vX.Y.Z 모으기·태그·dmg·APK)는 NEW 에서 task-close(머지 뒤 마무리)로 뜻이 바뀌었다. 후자의 내용은 NEW 어디에도 없다.
3. **뜻 바뀜 — main 반영 방식**: OLD 는 release.sh 가 PR 을 release 브랜치에 모아 release→main PR 하나로 머지. NEW 는 각 PR 을 merge commit 으로 머지하고 scripts/task-finish.sh 가 정리. corral 은 release.sh 방식을 계속 쓰므로 D17/release 스킬이 맡아야 한다.
4. **harness 경로**: OLD `.agents/harness/<도구>.md` → NEW `.agents/harness/<도구>/` (디렉터리). 뜻 바뀜(구조 변경).
5. **공개/비공개 불일치**: OLD learnings README 43행·adr README 17행은 「공개 레포다」, OLD AGENTS.md 58행은 「레포가 private 인 동안」. NEW 는 「공개될 수 있는 레포라면」으로 일반화됐다.

---

#### 1. AGENTS.md (OLD 117줄 ↔ NEW 122줄)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW 겹치는 위치 / 제안 목적지 | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| A-01 | 1 | 제목 | 버림-중복 | AGENTS.md:1 | |
| A-02 | 3-4 | 프로젝트 정체(herdr 기반 AI 워크스페이스, herdr=바닥 레이어, Electron+React GUI). 근거 표기: LIFE-337 | 옮김-슬롯 D1 | AGENTS.md:3-5 (D1 주석: 무엇을 만드는가·주요 스택, 2~4줄) | herdr 기반 AI 워크스페이스 (LIFE-337). 세션·일감을 한 울타리에 모으는 미션 컨트롤.<br>herdr = 바닥 레이어(PTY·영속·에이전트 상태·worktree), 그 위 Electron + React GUI. |
| A-03 | 6 | 방향 문서 위치 | 옮김-슬롯 D1 | AGENTS.md:3-5 (D1 주석: 「방향 문서가 있으면 그 위치」) | 프로젝트 방향·체크포인트는 corral-specs/00-project.md 를 읽는다. |
| A-04 | 10-12 | 산출물은 별도 private 레포 corral-specs(본체 옆), main 하나·worktree 없음, 코드 레포엔 공개 가능한 것만. 근거 표기 빠짐: LIFE-705·2026-10-26 분리. 「private」·「main」 한정어도 NEW 에서 일반화됨 | 버림-중복 | AGENTS.md:9-10 | |
| A-05 | 13 | 작업 하나 = corral-specs/LIFE-NNN-<슬러그>/, 번호 파일 | 버림-중복 | AGENTS.md:11 | |
| A-06 | 14-17 | 쓰기·커밋: 절대경로 직접 쓰기, 커밋은 코디(00-start 는 시작 세션, 묶음 자식은 묶음 코디)만·게이트 시점·자기 폴더만, git -C 명령, index.lock, 워커·리뷰어 커밋 금지. **뜻 바뀜**: 「묶음 코디는 분해·알림·출고 중 수정 기록 때도 커밋」→ NEW 는 「열린 묶음 PR 수정 기록」(출고→PR). NEW 는 delivery.md 문장 추가 | 버림-중복 | AGENTS.md:12-17 | |
| A-07 | 18 | 루트 공용 파일 커밋 규칙 + corral 고유 파일 목록(app-screens.md·design-tokens*.css·reference/). 규칙은 중복, 목록은 NEW 가 「00-project.md 등」으로 줄임 | 옮김-규칙 | AGENTS.md:16 (규칙 부분 중복). 목록 → .agents/rules/corral.md(신설, 프로젝트 소유) 또는 D1 방향 문서 줄 옆 | 루트 공용 파일(00-project.md·app-screens.md·design-tokens*.css·reference/ 등) |
| A-08 | 19 | corral-specs 가 진실의 원천 | 버림-중복 | AGENTS.md:18 | |
| A-09 | 20-21 | 아티팩트는 진실의 원천 아님. 근거 표기 빠짐: LIFE-344 → 00-project.md 정정 | 버림-중복 | AGENTS.md:19-20 | |
| A-10 | 22-23 | validation.md 가 완료 조건 원본 | 버림-중복 | AGENTS.md:21-22 | |
| A-11 | 25 | 절 제목 「… → PR → 출고」. **뜻 바뀜**: NEW 「… → PR」 | 버림-중복 | AGENTS.md:24 (출고 쪽은 A-20 에서 처리) | |
| A-12 | 27-29 | 「지도다」·능력 이름·매핑 선택 | 버림-중복 | AGENTS.md:26-28 | |
| A-13 | 31 | 표 머리(산출물 경로) | 버림-중복 | AGENTS.md:30 | |
| A-14 | 33 | 표 0 시작(체크포인트는 feature, 묶음 자식은 묶음 코디) | 버림-중복 | AGENTS.md:32, 42 (묶음 변형 문단으로 분리) | |
| A-15 | 34-36 | 표 1~3 | 버림-중복 | AGENTS.md:33-35 | |
| A-16 | 37 | 표 4 구현 브랜치 `…-claude` | 버림-중복 | AGENTS.md:36 (`<구현 도구>` 로 일반화) | |
| A-17 | 38-39 | 표 5~6 | 버림-중복 | AGENTS.md:37-38 | |
| A-18 | 40 | 표 7 게이트 ②, 산출물(묶음 자식은 pr.md 없음) | 버림-중복 | AGENTS.md:39, 42 | |
| A-19 | 41 | 표 8 **출고**: release/vX.Y.Z 자르기·PR 모으기·통합 확인·회고 → main 머지·태그·릴리즈 노트·dmg·APK(폰 설치), 본체, GitHub Release·retro/vX.Y.Z.md, 절차 release. **뜻 바뀜**: NEW 8 은 「머지 뒤 마무리」(task-close, close.md) | 옮김-규칙 | AGENTS.md:40 은 다른 내용. 목적지 → release 스킬 유지 + task-close D17(출고 방식) | 8 출고 — release/vX.Y.Z 자르기·PR 모으기·통합 확인·회고 → main 머지·태그·릴리즈 노트·dmg·APK(폰 설치) / 본체 / GitHub Release, corral-specs/retro/vX.Y.Z.md / release |
| A-20 | 43 | 스킬 파일 목록(task-start·task-coordinate·release), defaults.md 설명. **뜻 바뀜**: NEW 는 release 대신 task-close, defaults 3파일 안내 | 옮김-규칙 | AGENTS.md:44 (task-close 로 교체됨). release 스킬 존속 시 → D17 에 위치 명시 | 스킬 파일: .agents/skills/task-start · task-coordinate · release (각 SKILL.md). |
| A-21 | 44 | 판정 규칙 위치 task-coordinate §2·§3·§5·§6 | 버림-중복 | AGENTS.md:45 | |
| A-22 | 45-47 | 승인 게이트 3단: ⓪ 킥오프 ① 채택 ② 출고(PR 생성 전), 묶음 코디 게이트(분해 승인·출고 승인), worktree 는 출고 승인 전까지 유지, feature worktree 는 출고 승인(PR 생성) 직후 정리. **뜻 바뀜**: ② 출고→PR 생성, 출고 승인→PR 생성 승인 (OLD 의 「출고 승인」은 PR 생성 승인을 뜻해서 이름 변경일 뿐 동작은 같음), feature→묶음 브랜치 | 버림-중복 | AGENTS.md:46-50 | |
| A-23 | 48 | 조용한 완료 금지 | 버림-중복 | AGENTS.md:51 | |
| A-24 | 49 | LA 상태 전이: 코디(진행)·본체(출고)가 forward-only. **뜻 바뀜**: 「LA」→「일감 트래커」, 「본체(출고)」→「본체(마무리)」. 방법은 task-start D3 | 버림-중복 | AGENTS.md:52 (D3: task-start/SKILL.md:37·111). 참고: D3 에 LA MCP(issue_transition) 방법을 채워야 함 | |
| A-25 | 53-54 | 작업 브랜치 LIFE-NNN-<슬러그>: main(독립) 또는 feature(묶음 자식)에서 분기, 단명, PR 열면 로컬 정리·원격만, 「출고 머지(또는 feature 로 merge) 후」 원격 삭제 | 버림-중복 | AGENTS.md:56-57, 60-62 (묶음 자식은 60-62 로 분리, 「출고 머지」→「머지 후」로 뜻 약간 바뀜) | |
| A-26 | 55-56 | **release.sh 모으기**: 출고 때 release.sh 가 고른 PR 을 release 브랜치에 순서대로 모으고(검사 없이 순서 merge, 충돌이면 멈춤) release→main PR 하나를 merge commit 으로 머지, 원래 PR 은 간접 머지로 MERGED 가정·확인 안 되면 exit 13(C14 실측 전). **뜻 바뀜**: NEW 는 각 PR 머지 + task-finish.sh | 옮김-규칙 | NEW AGENTS.md:58-59 는 다른 방식. 목적지 → release 스킬/D17 | 출고 때 scripts/release.sh 가 고른 PR 을 release 브랜치에 순서대로 모으고(검사 없이 순서 merge, 충돌이면 멈춤)<br>release → main PR 하나를 merge commit 으로 머지한다 — 원래 PR 은 기본 브랜치에서 간접 머지로 MERGED 를 가정하고 확인 안 되면 exit 13(C14 실측 전, squash·rebase 머지는 레포 설정으로 꺼 둠). |
| A-27 | 56 | squash·rebase 머지는 레포 설정으로 꺼 둠. **뜻 바뀜**: NEW 는 squash·rebase 머지면 task-finish.sh 가 멈춘다는 문장 | 옮김-규칙 | AGENTS.md:59 와 상충 가능. 목적지 → .agents/rules/corral.md (레포 설정 사실) | squash·rebase 머지는 레포 설정으로 꺼 둠 |
| A-28 | 57 | PR CI(.github/workflows/pr-ci.yml, 맥미니 self-hosted 러너, LIFE-575)는 참고 신호 — release.sh 는 안 보고, release→main PR 의 CI 는 머지 뒤라 통합 확인 대신 못 함 | 옮김-규칙 | NEW 어디에도 없음. 목적지 → .agents/rules/corral.md (CI 사실) + release 부분은 release 스킬/D17 | PR CI(.github/workflows/pr-ci.yml — 맥미니 self-hosted 러너, LIFE-575)는 참고 신호다 — release.sh 는 보지 않고, release→main PR 의 CI 는 머지 뒤에 와서 통합 확인을 대신하지 않는다. |
| A-29 | 57 | main 직접 push·웹 UI 머지 금지, main 에 직접 올라가는 것은 release.sh 의 태그뿐 | 옮김-규칙 | AGENTS.md:58 은 「main 직접 push 금지」만 중복. 웹 UI 머지 금지·태그 예외 → release 스킬/D17 | main 직접 push·웹 UI 머지 금지 — main 에 직접 올라가는 것은 release.sh 의 태그뿐이다. |
| A-30 | 58 | ruleset 「main 보호」(삭제·force push 금지, PR 필수(승인 0·merge commit 만), 우회 없음 — LIFE-718)는 private 인 동안 서버에서 효력 없음(공개 뒤 효력 — LIFE-729), required check 도 못 걸어 없음 | 옮김-규칙 | NEW 없음. 목적지 → .agents/rules/corral.md | ruleset 「main 보호」(main 삭제·force push 금지, PR 필수(승인 0·merge commit 만), 우회 없음 — LIFE-718)는 레포가 private 인 동안 서버에서 효력이 없다(공개 뒤 효력 — LIFE-729). 그때까지는 규약이다. required check 도 private 동안 걸 수 없어 없다 |
| A-31 | 59-62 | 묶음 브랜치 feature/LIFE-NNN-<슬러그>(NNN=체크포인트): 자식은 feature 에서 따고 feature 로 merge, 끝나면 feature→main PR, main 이 움직이면 main 을 feature 로 merge(rebase 금지), 독립 작업은 main 에서, 그 외 통합 브랜치 금지 | 버림-중복 | AGENTS.md:60-62 | |
| A-32 | 62 | 슬러그 자동 파생·불변 | 버림-중복 | AGENTS.md:63 | |
| A-33 | 63 | worktree 는 .claude/worktrees/ 형제, 중첩 금지, 구현 브랜치 생존 중 rebase 금지 | 버림-중복 | AGENTS.md:64 | |
| A-34 | 64-65 | **release 브랜치 release/vX.Y.Z**: 출고 1회 수명·한 번에 하나, main 에서 자르고(.claude/worktrees/release-vX.Y.Z) PR 모아 통합 확인 뒤 main 머지, 출고 확인 뒤 삭제(접으면 삭제·PR 은 열린 채), 자른 뒤엔 출고를 막는 수정만(예외는 release 스킬 §1) | 옮김-규칙 | NEW 없음. 목적지 → release 스킬/D17 | **release 브랜치 release/vX.Y.Z** (예외, 단명 원칙 안): 출고 1회 수명·한 번에 하나. main 에서 자르고(.claude/worktrees/release-vX.Y.Z)<br>PR 을 모아 통합 확인 뒤 main 머지, 출고 확인 뒤 삭제(접으면 삭제·PR 은 열린 채). 자른 뒤엔 출고를 막는 수정만 — 수정은 일감 브랜치에서 고쳐 다시 모은다(예외는 release 스킬 §1) |
| A-35 | 66 | 「출고 통합 확인은 release worktree 에서」 + throwaway integration/<이름>-YYYYMMDD | 옮김-규칙 (앞 문장) / 버림-중복 (뒷 문장) | 뒷 문장 AGENTS.md:65. 앞 문장 → release 스킬/D17 | 출고 통합 확인은 release worktree 에서 한다. |
| A-36 | 67 | feature·장기 통합 브랜치 만료일 | 버림-중복 | AGENTS.md:66 | |
| A-37 | 71-72 | 코디·판정 도구 선택, 값 원본은 defaults.md | 버림-중복 | AGENTS.md:70-71 | |
| A-38 | 73 | claude = 코디·판정·구현·코드 리뷰, native advisor | 버림-중복 | AGENTS.md:72 + defaults.md 값 표(14-23) | |
| A-39 | 74 | codex = 경쟁 구현 / 리뷰 ① | 버림-중복 | AGENTS.md:72 + defaults.md 값 표, rules:36-74 | |
| A-40 | 75 | grok = 외부 서치·사실 검증+보완 리뷰, 느림(수 분)·무료 쿼터·검색 1회 소진 가능 | 옮김-슬롯 (defaults.md 「선택 근거」, Dn 없음) | AGENTS.md:72 에 「느리고 쿼터가 있을 수 있다」만 남음. 구체 수치(수 분·1회 소진)는 빠짐 | grok = 외부 서치·사실 검증 + 보완 코드 리뷰 (느림 수 분, 무료 쿼터 주의 — 검색 1회 소진 가능) |
| A-41 | 76-78 | effort·모델 기동 시 명시, 중간 변경 금지(캐시). 근거 수치 빠짐: 환경 기본 medium, Fable 5.1 은 10만 토큰 접두사에서 약 50배 | 버림-중복 | AGENTS.md:73-74, rules:10-11 (수치 빠짐: 아래 A-41a) | |
| A-41a | 76-78 (괄호) | 비용 수치 근거 | 옮김-슬롯 (defaults.md 「선택 근거」) | 목적지 → defaults.md 선택 근거 | (Fable 5.1 은 10만 토큰 접두사에서 약 50배) |
| A-42 | 79 | advisor 는 내장 상담, 독립 리뷰 대신 아님, 「현재 기본 해제(defaults.md)」 | 버림-중복 | AGENTS.md:75, rules:17-18 | |
| A-43 | 80-82 | 제어 도구는 절차와 분리 | 버림-중복 | AGENTS.md:76-78 | |
| A-44 | 86 | 영속 산출물 corral-specs | 버림-중복 | AGENTS.md:82 | |
| A-45 | 87-88 | 제어 채널·완료는 종료 보고. **뜻 바뀜**: 매핑 경로 `.agents/harness/<도구>.md` → `<도구>/` | 버림-중복 | AGENTS.md:83-84 | |
| A-46 | 89 | 보조: Claude 세션 간 SendMessage (claude↔claude 한정) | 옮김-규칙 | NEW 없음 — 단 NEW task-coordinate/references/bundle.md:12 가 이 줄을 가리킴(끊긴 참조). 목적지 → .agents/rules/corral.md (또는 AGENTS.md 세션 간 통신에 한 줄 복원) | 보조: Claude 세션 간 SendMessage (claude↔claude 한정) |
| A-47 | 93-95 | 증상표 헤더·「프로젝트가 뭔지」→ AGENTS.md · corral-specs/00-project.md (NEW 는 AGENTS.md 만) | 버림-중복 | AGENTS.md:88-90 (00-project.md 위치는 A-03 로 D1 에 이동) | |
| A-48 | 96-98 | 문체·코드 스타일·완료 증상 행 | 버림-중복 | AGENTS.md:91-93 | |
| A-49 | 99-101 | 리뷰·도구 변경·명령 플래그 행. **뜻 바뀜**: `<도구>.md (corral·orca·bare 매핑)` → `설치한 매핑 (<도구>/)` | 버림-중복 | AGENTS.md:101-103 | |
| A-50 | 102-105 | 다단계 절차·criteria·learnings·ADR 행 | 버림-중복 | AGENTS.md:94-96, 107 | |
| A-51 | 109-110 | 원본 .agents/ 한정, 심링크 | 버림-중복 | AGENTS.md:111-112 | |
| A-52 | 111 | grok 은 AGENTS.md 와 .claude/rules/ 자동 로드(.grok/ 불필요) | 옮김-규칙 | NEW 는 codex 부분만 있음(AGENTS.md:113). 목적지 → .agents/rules/corral.md | grok 은 AGENTS.md 와 .claude/rules/ 를 자동 로드한다 — .grok/ 폴더 불필요. |
| A-53 | 111-112 | codex 는 AGENTS.md 만 읽음, .codex/agents 포인터, 고치면 확인 | 버림-중복 | AGENTS.md:113 | |
| A-54 | 113 | rules 스텁 사다리 | 버림-중복 | AGENTS.md:114 | |
| A-55 | 114 | 스킬 로컬 상태 .gitignore | 버림-중복 | AGENTS.md:115, gitignore.fragment:2-4 | |
| A-56 | 115 | 시크릿 점검 gitleaks(corral·corral-specs 둘 다) | 버림-중복 | AGENTS.md:116, 122 | |
| A-57 | 116-117 | 이 파일은 매 세션 로드, 200줄 초과 금지 | 버림-중복 | AGENTS.md:119-120 | |

(A-07 ~ A-35 의 「옮김」 중 release 관련은 출고 방식이 release.sh 인 한 D17/release 스킬이 맡는다. NEW AGENTS.md:58-59 의 PR 머지·task-finish.sh 문장과 충돌하므로 D17 에서 어느 쪽이 corral 의 기준인지 정해야 한다.)

#### 2. CLAUDE.md (OLD 1줄 ↔ NEW 2줄)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| C-01 | 1 | `@AGENTS.md` (NEW 는 앞에 `<!-- paddock:fixed -->` 추가) | 버림-중복 | CLAUDE.md:2 | |

#### 3. .agents/agents/reviewer.md (OLD 51줄 ↔ NEW 53줄)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW / 제안 목적지 | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| R-01 | 1 | 제목 | 버림-중복 | reviewer.md:1 | |
| R-02 | 3-4 | 고정 commit·specs 기준, 보고서·raw 는 corral-specs 작업 폴더 `raw/review/` 에 절대경로로 쓰고 커밋은 코디 | 버림-중복 | reviewer.md:3-4 | |
| R-03 | 8-10 | 리뷰어 구성은 defaults.md, 별도 세션, 역할 간 세션 재사용 금지 | 버림-중복 | reviewer.md:8-10 | |
| R-04 | 11-12 | 재리뷰는 새 세션. 근거 표기 빠짐: LIFE-394 같은 Codex 세션 4라운드 재사용, 매 라운드 새 높음 지적 | 버림-중복 | reviewer.md:11 | |
| R-05 | 13-14 | native advisor 는 독립 리뷰 아님 | 버림-중복 | reviewer.md:12-14 | |
| R-06 | 15-16 | 자기 구현분도 리뷰, 자기 리뷰는 승자 판정 근거 아님 | 버림-중복 | reviewer.md:14-15 | |
| R-07 | 17-18 | 기준·원자료 먼저, 중복 연결 | 버림-중복 | reviewer.md:16-17 | |
| R-08 | 19 | 심각도 | 버림-중복 | reviewer.md:18 | |
| R-09 | 20 | 취향·가설 단정 금지 | 버림-중복 | reviewer.md:19 | |
| R-10 | 21 | 제품·설계 파일 수정 금지 | 버림-중복 | reviewer.md:20 | |
| R-11 | 22 | 부하 장치 PID·종료 | 버림-중복 | reviewer.md:21 | |
| R-12 | 26-27 | 대상·설계 문서 단계 없음 | 버림-중복 | reviewer.md:25-26 | |
| R-13 | 28-29 | 전원 기술 정확성 검토, **Grok 이 들어가면 외부 사실(herdr API·라이브러리 문서)을 추가 대조**, 보완 역할도 지적·미실행 범위 보고 | 옮김-슬롯 D12 | reviewer.md:27-28 은 「외부 서치 도구가 있으면 외부 사실(아래 「프로젝트별 관점」에 적은 대상)」로 일반화, 대상은 D12(reviewer.md:51-53)에 적도록 돼 있음. 나머지 문장은 중복 | Grok 이 들어가면 외부 사실<br>(herdr API·라이브러리 문서)을 추가 대조한다. |
| R-14 | 30-31 | 네이티브 실행 관문 확인 | 버림-중복 | reviewer.md:29-30 | |
| R-15 | 32-33 | 라운드 리뷰 시점엔 최종 관문 원자료 없음 | 버림-중복 | reviewer.md:31-32 | |
| R-16 | 34-37 | 약한 보장을 강한 보장처럼 쓴 문장 | 버림-중복 | reviewer.md:33-36 | |
| R-17 | 38-40 | 경로(경량/전체) 적합 | 버림-중복 | reviewer.md:37-39 | |
| R-18 | 41-42 | 결과 raw/review/<도구>-rN.md, 전원 보고 | 버림-중복 | reviewer.md:40-41 | |
| R-19 | 43 | 다른 리뷰어 침묵은 통과 근거 아님 | 버림-중복 | reviewer.md:42 | |
| R-20 | 44 | 수치·버전 출처 | 버림-중복 | reviewer.md:43 | |
| R-21 | 45-48 | 하네스 프로브 유틸 리뷰: 작업 폴더 scripts/ 와 **`app/scripts/<하는 일>/` 의 `lib.mjs` 류**, **`until()`류 대기 헬퍼가 타임아웃을 실패로 전파하는지(`{ok:false}` 확인·`.then(()=>true).catch(()=>false)` 패턴)**, 판별력 자기점검(`differsFromStateArray` 류). 일반 원칙은 NEW 에 중복, **corral 파일·함수 이름은 빠짐** | 옮김-슬롯 D12 | 일반 원칙은 reviewer.md:44-46 와 중복. 구체 이름은 D12(reviewer.md:51-53, 「이 프로젝트에서 리뷰어가 특히 볼 것」)에 | 작업 폴더 `scripts/`(일감 관문)·`app/scripts/<하는 일>/` 의 `lib.mjs` 류<br>자체 검증 스크립트를 그냥 통과시키지 않는다. `until()`류 대기 헬퍼가 타임아웃을 **실패로<br>명확히 전파**하는지(`{ok:false}`를 호출부가 실제로 확인하는지, `.then(()=>true).catch(()=>false)`<br>처럼 실패를 성공으로 읽는 패턴은 없는지), 그리고 판별력 자기점검(다른 상태를 실제로 구분하는지<br>— `differsFromStateArray` 류)이 있는지 확인한다. |
| R-22 | 49-51 | 「아무것도 안 해도 통과하는 테스트는 찾기 어렵다」 + 근거 표기 빠짐: LIFE-357 fix4 에서 리뷰어 3명(claude·codex·grok) 전부 놓치고 구현자가 발견, 근거 경로 corral-specs/LIFE-357-layout-redesign/14-handoff-main.md §3-② | 버림-중복 | reviewer.md:47 (「리뷰어 여럿이 함께 놓칠 수 있다」) | |

#### 4. .codex/agents/reviewer.toml (OLD 6줄 ↔ NEW 7줄)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| T-01 | 1-6 | name·description·developer_instructions 포인터 (NEW 는 1행에 `# paddock:fixed` 주석 추가, 내용 동일) | 버림-중복 | reviewer.toml:2-7 | |

#### 5. .agents/learnings/README.md (OLD 65줄 ↔ NEW 67줄)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW / 제안 목적지 | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| L-01 | 1-5 | 제목·임시 수신함·원본은 이 파일. 근거 표기 빠짐: LIFE-704 | 버림-중복 | README.md:2-6 | |
| L-02 | 7 | 영역 파일은 첫 항목 때 생성 | 버림-중복 | README.md:8 | |
| L-03 | 8 | 제안 = task-coordinate §8 게이트 ②, **채택·승격·재검토 = release §4 회고**. **뜻 바뀜**: NEW 는 「task-close §5 — 출고 방식이 맡으면 D17」(README.md:54) | 옮김-규칙 | 제안 부분은 README.md:10 중복. 「release §4 회고」는 D17 이 가리킬 곳 → release 스킬/D17 | 채택·승격·재검토 = release §4 회고. |
| L-04 | 10-24 | 목적지 분류표·같은 실수 사다리·기존 먼저 찾기 | 버림-중복 | README.md:12-26 | |
| L-05 | 26-39 | 형식 코드블록. 「(예: task-coordinate §5)」·「LIFE 번호로만」→「일감 번호로만」 | 버림-중복 | README.md:28-41 | |
| L-06 | 41-42 | 일반화 규칙 | 버림-중복 | README.md:43-44 | |
| L-07 | 43 | 「공개 레포다」: 홈 경로·사용자 이름·corral-specs 원자료 경로·세션 id·사용자 원문 금지. **뜻 바뀜**: NEW 「공개될 수 있는 레포라면 … 작업 원자료 경로」(단정→가정, corral-specs 이름 일반화) | 버림-중복 | README.md:45 | |
| L-08 | 47-49 | 상한 10개·8KB, 쓰기 전 압축 | 버림-중복 | README.md:49-51 | |
| L-09 | 50-51 | 90일 재검토는 파일 단위, **고치는 것은 출고 회고다(release §4)**, 작업 중엔 고치지 않는다, 넘기는 법은 §8. **뜻 바뀜**: NEW 「재검토 자리는 회고 절차가 정한다 … 작업 중에 낡은 파일을 보면 고치지 않고 알린다」 | 버림-중복 (release §4 지목은 L-03 과 같은 이유로 D17) | README.md:52-54 | |
| L-10 | 52 | 영역 파일 0개 항목까지 가능 | 버림-중복 | README.md:55 | |
| L-11 | 56-59 | 승격 시 learnings 항목 삭제, 안 통하는 자리 세기(예: 경량 경로, codex 코디, 매핑의 공백 능력)·시나리오 열거. 예시 괄호 빠짐 | 버림-중복 | README.md:59-62 | |
| L-12 | 60 | **승격된 규칙·스킬을 어디서 반영하나(회고 커밋 또는 별도 LIFE 일감)는 release §4 가 정한다** | 옮김-규칙 | NEW 없음. 목적지 → release 스킬/D17 | 승격된 규칙·스킬을 어디서 반영하나(회고 커밋 또는 별도 LIFE 일감)는 release §4 가 정한다. |
| L-13 | 64-65 | 읽기: 모든 작업에 주입 안 함, 「코디가 분석 때 한다(task-coordinate §1)」, 권위 순서. **뜻 바뀜**: 「코디가 분석 때 한다」 누락 | 버림-중복 (누락 문구는 task-coordinate §1 쪽 책임, 확인 필요) | README.md:66-67 | |

#### 6. docs/adr/README.md (OLD 25줄 ↔ NEW 28줄), docs/adr/template.md

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW / 제안 목적지 | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| D-01 | README 1-4 | 제목·MADR·원본 이 파일. 근거 표기 빠짐: LIFE-704 | 버림-중복 | README.md:2-5 | |
| D-02 | README 6-9 | 언제 쓰나 | 버림-중복 | README.md:7-10 | |
| D-03 | README 13 | 초안은 게이트 ②(§8), **채택은 출고 회고(release §4)**. **뜻 바뀜**: NEW 「채택 = 머지 뒤 회고(task-close §5 — 출고 방식이 맡으면 D17)」 | 옮김-규칙 | README.md:14-16. 「출고 회고(release §4)」→ release 스킬/D17 | 채택은 출고 회고(release §4)에 — 언제·어디서는 그 스킬들이 정한다. |
| D-04 | README 14-16 | 파일명·번호는 채택 때 매김(병렬 일감) | 버림-중복 | README.md:17-19 | |
| D-05 | README 17 | 공개 레포 주의 + 근거는 LIFE 번호. **뜻 바뀜**: 공개→공개될 수 있는, LIFE→일감 번호 | 버림-중복 | README.md:20 | |
| D-06 | README 19-25 | 상태 값·accepted 뒤 수정 금지·proposed/rejected 는 초안에서만 | 버림-중복 | README.md:22-28 | |
| D-07 | template.md 전체(51줄) | 차이는 11행·51행 「LIFE 번호」→「일감 번호」뿐 (diff 확인) | 버림-중복 | template.md:11, 51 외 동일 | |

#### 7. .githooks/pre-commit (OLD 5줄 ↔ NEW 6줄)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| H-01 | 1 | shebang | 버림-중복 | pre-commit:1 | |
| H-02 | 2 | 스테이징 시크릿 차단 설명. 근거 표기 빠짐: LIFE-705 | 버림-중복 | pre-commit:3 | |
| H-03 | 3-5 | gitleaks:allow·.gitleaksignore 안내, gitleaks 없음 안내, gitleaks 실행 (NEW 는 2행에 `# paddock:fixed` 추가) | 버림-중복 | pre-commit:4-6 | |

#### 8. .agents/defaults.md (OLD 161줄 ↔ NEW defaults.md 30줄 + defaults.rules.md 101줄 + agent-tools.md 122줄)

주: OLD 실제 줄 수는 159(wc). 아래 「값」은 NEW defaults.md 칸으로, 「규칙」은 defaults.rules.md 로, 「방법」은 agent-tools.md 로 간다.

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW / 제안 목적지 | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| F-01 | 1 | 제목 | 버림-중복 | defaults.md:2 | |
| F-02 | 3 | 도구가 자동으로 읽는 파일 아님 | 버림-중복 | defaults.md:4 | |
| F-03 | 5-6 | 2026-09-29 사용자 합의(2026-09-22 구성 대체), 신규 작업은 설정 질문 없이 시작, 원본은 이 파일 하나, 명시 변경은 해당 작업만 | 버림-중복 (날짜 근거 표기 빠짐: 2026-09-29·2026-09-22) | defaults.md:6 | |
| F-04 | 7 | 2026-09-22 구성의 판단 근거는 corral-specs/flow-redesign/ | 옮김-슬롯 (defaults.md 「선택 근거」, Dn 없음) | defaults.md:25-30 | 2026-09-22 구성의 판단 근거는 `corral-specs/flow-redesign/` 에 있다. |
| F-05 | 9-10 | 표 머리(역할·도구·모델·effort·advisor). NEW 는 도구/모델 칸 분리 | 버림-중복 | defaults.md:14-15 | |
| F-06 | 11 | 본체 세션: Claude claude-sonnet-5-5, high, advisor 없음 | 옮김-슬롯 (defaults.md 역할 기본값 행) | defaults.md:16 | 본체 세션 (시작·마무리) / Claude `claude-sonnet-5-5` / high / 없음 |
| F-07 | 12 | 코디네이터·판정: Claude claude-opus-5-5, high, 없음 | 옮김-슬롯 (역할 기본값 행) | defaults.md:17 | 코디네이터·판정 / Claude `claude-opus-5-5` / high / 없음 |
| F-08 | 13 | 구현 워커(단독·기본): Claude claude-opus-5-5, medium(2026-09-30), 없음 | 옮김-슬롯 (역할 기본값 행) | defaults.md:18 | 구현 워커 (단독·기본) / Claude `claude-opus-5-5` / **medium** (2026-09-30) / 없음 |
| F-09 | 14 | 구현 워커(경쟁 시 Codex 측): Codex gpt-6-astra, 카탈로그에 있을 때만, 없으면 경쟁 불가, high, 해당 없음 | 옮김-슬롯 (역할 기본값 행) | defaults.md:19 (조건 문구는 rules:70 와 중복) | 구현 워커 (경쟁 시 Codex 측) / Codex `gpt-6-astra` — 계정 카탈로그에 있을 때만, 없으면 경쟁 불가 / high / 해당 없음 |
| F-10 | 15 | 코드 리뷰 ①: 별도 Codex gpt-6-astra, 구독·카탈로그에 있을 때, 라운드마다 재확인, 2026-10-27 관측: 계정 Free 라 카탈로그에 없어 전환, xhigh | 옮김-슬롯 (역할 기본값 행) | defaults.md:20. 관측 메모는 선택 근거에 | 코드 리뷰 ① / 별도 Codex `gpt-6-astra` — 구독·계정 카탈로그에 있을 때. 있는지는 라운드마다 「Codex 사용 불가 시 자동 전환」으로 다시 본다 (2026-10-27 관측: 계정 Free 라 카탈로그에 없어 전환) / xhigh / 해당 없음 |
| F-11 | 16 | 코드 리뷰 ②: 별도 Claude claude-sonnet-5-5, high, 없음, **일시 중지**(Codex 사용 불가 시 자동 재개) | 옮김-슬롯 (역할 기본값 행, 「일시 중지」 표기) | defaults.md:21, 주석 11-12 | 코드 리뷰 ② — **일시 중지** (Codex 사용 불가 시 자동 재개) / 별도 Claude `claude-sonnet-5-5` / high / 없음 |
| F-12 | 17 | 코드 리뷰 ③: Grok, grok-search 설치 기본값, **일시 중지** | 옮김-슬롯 (역할 기본값 행, 「일시 중지」 표기) | defaults.md:22 | 코드 리뷰 ③ — **일시 중지** (Codex 사용 불가 시 자동 재개) / Grok / grok-search 설치 기본값 / 해당 없음 |
| F-13 | 18 | 서브에이전트 부모 상속 | 버림-중복 | defaults.md:23 | |
| F-14 | 20-23 | 「코드 리뷰 일시 중지 — 2026-09-30 사용자 지시」: 당분간 Codex 단독, ②③ 기동 안 함, 재개는 사용자 지시만·재개 시 절 삭제. **현재 상태(Codex 단독)** 는 값 표 쪽 정보 | 옮김-슬롯 (역할 기본값 행의 「일시 중지」 표기가 대신함) | 규칙 부분은 rules:25-34 와 중복(rules:32 「재개할 때 defaults.md 의 중지 표시를 지운다」). 상태·날짜는 defaults.md:21-22 | 당분간 코드 리뷰는 Codex(리뷰 ①) 단독이다. 리뷰 ②(Claude)·③(Grok)은 기동하지 않는다. (2026-09-30 사용자 지시) |
| F-15 | 25 | 00-start.md 에 ②·③ 일시 중지 기록, 재리뷰도 Codex 새 세션 하나 | 버림-중복 | rules:29 | |
| F-16 | 26 | verdict.md 에 「Codex 단독 리뷰(2026-09-30 일시 중지)」 | 버림-중복 (날짜 근거 표기 빠짐) | rules:30 | |
| F-17 | 27 | 단일 리뷰어라도 전원 침묵 통과 근거 아님 | 버림-중복 | rules:31 | |
| F-18 | 28 | grok 분석 단계 외부 서치는 중지 대상 아님 | 버림-중복 | rules:33 | |
| F-19 | 29 | 재개 중인 기존 작업은 기록된 구성 유지 | 버림-중복 | rules:34 | |
| F-20 | 31-34 | 「Codex 사용 불가 시 자동 전환」(2026-10-02 승인, 10-27 추가, LIFE-713): 라운드마다 확인, 쓸 수 없으면 Claude(②)·Grok(③) 2자 리뷰로 전환, 사용자 재승인 불필요 | 버림-중복 (근거 표기 빠짐: 2026-10-02·2026-10-27·LIFE-713) | rules:36-39 | |
| F-21 | 36-38 | 조건 둘: ① 지정 모델이 계정 카탈로그에 없음 ② primary·secondary 창 used_percent ≥ 90 | 버림-중복 | rules:41-43 | |
| F-22 | 38-39 | 확인 순서: 카탈로그 먼저(LIFE-713) | 버림-중복 | rules:44-45 | |
| F-23 | 40-41 | `codex debug models`=계정 카탈로그, `--bundled`=내장이라 부재 판정에 쓰지 않음(codex-cli 0.162.1·2026-10-27 실측: 내장엔 gpt-6-astra 있고 계정엔 없음) | 버림-중복 | rules:46-47, tools:21-22 (실측 수치는 tools:17 버전만 남고 gpt-6-astra 예는 빠짐) | |
| F-24 | 42-47 | 카탈로그 확인 bash 블록(slugs·grep -qxF) | 버림-중복 | tools:24-36 (확인 실패·내장 목록 대조가 추가된 상위판) | |
| F-25 | 48-49 | 출력 비면 확인 실패, 정확히 같은 줄 대조, visibility: hide 도 「있음」 | 버림-중복 | rules:47-48, tools:38 | |
| F-26 | 50-52 | 갱신 실패 시 내장 목록으로 조용히 떨어질 수 있다(0.162.1, 캐시 상태, LIFE-713), 「있음」은 보장 아님, slug 목록 원문은 reviews.md 에 붙임 | 버림-중복 (근거 표기 빠짐: LIFE-713) | rules:49-50, tools:39-42 | |
| F-27 | 53-54 | 사용량 확인: rate_limits 가 든 가장 최근 세션 로그의 마지막 rate_limits(LIFE-713 재현) | 버림-중복 | rules:51, tools:48-49 | |
| F-28 | 55-60 | 사용량 확인 bash 블록(최근 50개) | 버림-중복 | tools:51-59 (rollout-*.jsonl·CODEX_HOME 개선판) | |
| F-29 | 61-65 | 50개 안에 없으면 확인 실패, 경로 적기, plan_type·used_percent·window_minutes·resets_at, secondary 둘이면 둘 다, resets_at 지났으면 지난 창 취급 | 버림-중복 | tools:61, 63-64, rules:51-53 | |
| F-30 | 66-67 | 창 길이는 등급마다 다름(2026-10-18 까지 10080분, 10-27 Free 43200분), 마지막 호출 시점 값, 공식 API 아님(0.159.2 기준) | 버림-중복 (날짜 근거 표기 빠짐) | tools:17, 65-66, rules:54 | |
| F-31 | 68-69 | 임계값 90%: 한 세션이 주간 1~3%(2026-09-30~10-02 실측 15세션), 로그 값 낮을 수 있음, 다른 창 길이는 실측 없음 | 버림-중복 (근거 표기 빠짐: 2026-09-30~10-02 15세션) | rules:55, tools:67 | |
| F-32 | 70-71 | 확인 실패는 사용 불가가 아님, 다른 조건도 불가 아니면 Codex 띄움, 완료 보고에 기대지 않고 기동 단계 확인 | 버림-중복 | rules:56-58 | |
| F-33 | 73-77 | 거절 확인: 본문 주입 직후 화면 관측, 400 model_not_found 는 수 초 내(0.162.1, LIFE-713 관측: +3초), 감독 경로 보고 불명 | 버림-중복 (근거 표기 빠짐: LIFE-713·0.162.1 중 일부는 tools:71-72 에 남음) | rules:59-62, tools:71-72 | |
| F-34 | 78-81 | 주입 미확정은 모델 부재 신호 아님(LIFE-713), 재개는 매핑 복구 조건, **corral 의 `dispatch_input_unprovable` 등** 재개로 수렴하지 않는 상태면 재개 안 함 | 버림-중복 (corral 고유 코드 이름은 NEW harness 매핑에 있음) | rules:63-65, NEW .agents/harness/corral/supervised-worker.md:70 | |
| F-35 | 82-83 | Grok 도 실패하면 Claude 단독 진행, Claude 리뷰어는 구현자(Opus)와 다른 모델(Sonnet) | 버림-중복 (모델 이름은 값 표 F-11 에 있음) | rules:66-67 | |
| F-36 | 84-85 | 전환 대상은 Claude·Grok 뿐, 다른 Codex 모델로 안 바꿈 | 버림-중복 | rules:68-69 | |
| F-37 | 86 | 경쟁 구현 Codex 측: 사용 불가면 경쟁 불가 보고 | 버림-중복 | rules:70 | |
| F-38 | 87 | 복귀: 라운드마다 재판단 | 버림-중복 | rules:71 | |
| F-39 | 88-90 | 기록·보고: reviews.md·verdict.md·사용자 한 줄 | 버림-중복 | rules:72-74 | |
| F-40 | 92-96 | 「Grok 한도 소진 시 외부 서치 생략」(2026-10-02 승인): 소진이면 코디 검색만, task-coordinate §0 예외, §1-2 에서 띄우기로 한 경우만 확인 | 버림-중복 (근거 표기 빠짐: 2026-10-02) | rules:76-80 | |
| F-41 | 98-99 | 확인 방법: grok 기동 배너 `Weekly limit left: N%` 를 화면 관측, 입력 없이 닫음, LIFE-478 c41-grok-probe 방식, grok_status 는 한도 없음 | 버림-중복 (근거 표기 빠짐: LIFE-478 raw/coordinator/c41-grok-probe-*) | rules:82-83, tools:92-95 | |
| F-42 | 100-101 | 0% 면 생략, 못 읽으면 소진 아님, 서치 도중 초과 처리 | 버림-중복 | rules:84-85, tools:96-97 | |
| F-43 | 102-103 | 대체: 코디 웹 검색 + gh 로 이슈·PR, 흉내 금지 | 버림-중복 | rules:86-87 | |
| F-44 | 104-105 | 00-analysis.md 에 「Grok 미기동 — 주간 한도 0%(관측 시각)」, 교차 대조 칸 공백, 게이트 ⓪ 보고 | 버림-중복 | rules:88-89 | |
| F-45 | 109-110 | 선택 근거: 2026-09-29 전환 전제(Opus 5.5·Sonnet 5.5 가 Fable 5.1 보다 높다는 외부 평, 실측 없이 전환, 틀린 신호 — 리뷰 라운드 증가·판정 번복 — 이면 이 파일부터 되돌림) | 옮김-슬롯 (defaults.md 「선택 근거」) | defaults.md:25-30 | **2026-09-29 전환 전제**: Opus 5.5·Sonnet 5.5 가 Fable 5.1 보다 지능이 높다는 외부 평을 받아들여<br>실측 없이 전환했다. 전제가 틀린 신호(리뷰 라운드 증가, 판정 번복)가 보이면 이 파일부터 되돌린다. |
| F-46 | 111-114 | 코디 = Opus 5.5: 판단이 가장 비싼 자리, 캐시 읽기 단가 비교(Opus $4×5%=$0.20 vs Fable $10×2.5%=$0.25, 2026-09-29), Fable 별도 주간 천장, effort high | 옮김-슬롯 (선택 근거) | defaults.md:25-30 | **코디네이터 = Opus 5.5**: 판단이 가장 비싼 자리라 가장 높은 모델을 둔다. 캐시 읽기 단가도<br>불리하지 않다 — Opus 5.5 는 입력 $4 × 캐시 읽기 5% = $0.20/MTok, Fable 5.1 은 $10 × 2.5%<br>= $0.25/MTok (2026-09-29 공식 모델 개요 기준). Fable 의 별도 주간 천장에서도 벗어난다.<br>effort 는 high — API 기본값이 medium 이라 명시하지 않으면 내려간다. |
| F-47 | 115-116 | 구현 = Opus 5.5 medium(2026-09-30 사용자 지시, high→medium), 기동 플래그 `--effort medium` 명시, 라운드가 늘면 high 로 되돌리는 신호 | 옮김-슬롯 (선택 근거) | defaults.md:25-30 | **구현 = Opus 5.5 medium** (2026-09-30 사용자 지시, high → medium): 구현 품질이 리뷰 라운드 수를 정한다.<br>effort 는 기동 플래그로 **명시**한다(`--effort medium`) — 기본값에 맡기지 않는다. 리뷰 라운드가 늘면 high 로 되돌리는 신호로 본다. |
| F-48 | 117-118 | advisor 기본 해제 근거: 실행 모델과 등급 차가 있을 때만 발동(LIFE-394 실측: Fable 코디 0회, Opus 5 워커 23회), Opus 5.5 위 등급 없음 | 옮김-슬롯 (선택 근거) | defaults.md:25-30 (규칙 rules:17 은 「기본 해제」만) | **advisor 기본 해제**: advisor 는 실행 모델과 등급 차가 있을 때만 발동한다(LIFE-394 실측:<br>Fable 코디 0회, Opus 5 워커 23회). Opus 5.5 위의 등급이 없으므로 걸 대상이 없다. |
| F-49 | 119-120 | 코드 리뷰 ② = Sonnet 5.5: 구현자와 다른 모델로 다양성, 같은 모델은 같은 결함 함께 놓침(LIFE-394 에서 3자가 모두 놓친 높음 결함) | 옮김-슬롯 (선택 근거) | defaults.md:30 에 일반 문장(「같은 모델은 같은 결함을 함께 놓친다」)이 있음. 모델명·근거만 추가 | **코드 리뷰 ② = Sonnet 5.5**: 구현자와 다른 모델로 리뷰어 3자의 모델 다양성을 올린다 — 같은<br>모델은 같은 결함을 함께 놓친다(LIFE-394 에서 3자가 모두 놓친 높음 결함이 있었다). |
| F-50 | 121 | 본체 세션 = Sonnet 5.5: 시작·마무리는 기계적 절차 | 옮김-슬롯 (선택 근거) | defaults.md:25-30 | **본체 세션 = Sonnet 5.5**: 시작·마무리는 브랜치·worktree·머지·정리 같은 기계적 절차다. |
| F-51 | 122-124 | Codex 구현 = high: 벤더 가이드 대역 medium~high, xhigh 는 평가로 이득 확인될 때만, effort 를 올리면 통과율 정체·동시성·I/O 결함 비중 증가 | 옮김-슬롯 (선택 근거) | defaults.md:25-30 | **Codex 구현 = high**: 벤더 가이드가 에이전트 코딩에 지정한 대역이 medium~high 다. xhigh 는<br>"평가로 이득이 확인될 때만"이고 코딩 이득 수치가 공개되어 있지 않다. effort 를 올리면<br>통과율은 정체하고 동시성·I/O 계열의 미묘한 결함 비중이 오른다. |
| F-52 | 125-127 | 코드 리뷰 Codex = xhigh: 벤더 가이드가 보안·코드 리뷰를 xhigh 예시로, 구현 high 와 리뷰 xhigh 등급을 벌림 | 옮김-슬롯 (선택 근거) | defaults.md:29 가 「구현과 리뷰의 등급을 벌려 둔다」 일반 문장으로 중복. 벤더 근거 문장만 추가 | **코드 리뷰 Codex = xhigh**: 벤더 가이드가 xhigh 의 예시 용도로 보안·코드 리뷰를 든다.<br>구현(high)과 리뷰(xhigh)의 등급을 벌려 두면 높은 effort 가 만드는 미묘한 결함을 더 깊은<br>리뷰가 받는다. |
| F-53 | 131-132 | 운영 규칙: effort·모델 명시, 중간 변경 금지(medium 기본) | 버림-중복 | rules:10-11 | |
| F-54 | 133-134 | Codex 워커는 모델·effort 를 킥오프에 명시(「Astra high 일 것」은 성립 안 함) | 버림-중복 | rules:12-13 | |
| F-55 | 135 | **Codex 워커는 대기 예산을 넉넉히 잡는다**(Claude 보다 느리고 타임아웃 잦음) | 옮김-규칙 | NEW 없음(agent-tools.md Codex 절은 paddock 고정). 목적지 → .agents/rules/corral.md | **Codex 워커는 대기 예산을 넉넉히 잡는다.** 같은 과제에서 Claude 보다 느리고 타임아웃이 잦다. |
| F-56 | 136-139 | 전체 식별자 `claude-opus-5-5`·`claude-sonnet-5-5` 로 요청, 별칭은 버전 고정 아님, 요청 식별자와 해석된 모델 구분 기록 | 버림-중복 (식별자 값은 F-06~F-12 값 표로) | rules:14-16 | |
| F-57 | 140-142 | advisor 기본 해제, **`claude --advisor <모델>` 로 켠다**, 독립 리뷰어 아님 | 옮김-규칙 | 대부분 rules:17-18 중복. `claude --advisor <모델>` 명령만 빠짐 → .agents/rules/corral.md 또는 defaults.md advisor 칸 주석 | 명시 변경으로 켤 때는 `claude --advisor <모델>` 로 켜고, 별도 effort·호출<br>횟수 옵션을 가정하지 않는다. |
| F-58 | 143-144 | 00-start.md 에 역할 구성 복사, 재개 시 새 기본값 소급 안 함 | 버림-중복 | rules:19-20 | |
| F-59 | 145-146 | 모델 미지원·사용량 소진 시 임의 대체 금지, 사전 승인 예외 둘 | 버림-중복 | rules:21-22 | |
| F-60 | 147 | 「세 사용자 승인(킥오프·채택·출고)」. **뜻 바뀜**: 출고→PR 생성 (NEW 「킥오프·채택·PR 생성」) | 버림-중복 | rules:23 | |
| F-61 | 151-153 | 경쟁 구현(옵션): 기본 단독, 발동 근거 킥오프 명시: ① 접근 갈림 ② 되돌리기 비쌈 **③ 터미널·에이전트 제어 계층** ④ Claude 주간 쿼터 임계. **뜻 바뀜**: NEW 는 ③=「주 구현 도구의 주간 쿼터가 임계」(OLD ④ 일반화), OLD ③ 은 빠짐 | 옮김-규칙 (OLD ③) / 버림-중복 (나머지) | rules:95-96. 목적지(OLD ③) → .agents/rules/corral.md | ③ 터미널·에이전트 제어 계층 |
| F-62 | 154-157 | 경쟁 페어 Claude `claude-opus-5-5` medium ∥ Codex `gpt-6-astra` high, Codex 측 불가면 경쟁 불가, 명시 모델 우선, Codex 별도 구독이라 Claude 쿼터 안 늘림 | 버림-중복 (페어 값은 F-08·F-09 값 표) | rules:97-99 | |
| F-63 | 158 | 각 후보 독립 구현 | 버림-중복 | rules:100 | |
| F-64 | 159 | 자기 구현 리뷰는 승자 판정 근거 아님 | 버림-중복 | rules:101 | |

---

#### 옮김 행 요약 (파일별 개수)

「옮김」 = 판정에 「옮김-슬롯」 또는 「옮김-규칙」이 든 행 (혼합 판정 행·분할 행 A-41a 포함). 표의 칸 값을 세어 만들었다.

| 파일 | 옮김 행 수 | 행 |
| --- | --- | --- |
| 1. AGENTS.md | 16 | 슬롯 D1: A-02, A-03 / 슬롯 defaults.md 선택 근거: A-40, A-41a / 규칙: A-07, A-27, A-28, A-30, A-46, A-52 (corral.md 신설), A-19, A-20, A-26, A-28, A-29, A-34, A-35 (release 스킬/D17) |
| 2. CLAUDE.md | 0 | |
| 3. .agents/agents/reviewer.md | 2 | 슬롯 D12: R-13, R-21 |
| 4. .codex/agents/reviewer.toml | 0 | |
| 5. .agents/learnings/README.md | 2 | 규칙(release §4 → D17): L-03, L-12 |
| 6. docs/adr/README.md, template.md | 1 | 규칙(release §4 → D17): D-03 |
| 7. .githooks/pre-commit | 0 | |
| 8. .agents/defaults.md (+rules, agent-tools) | 20 | 슬롯 역할 기본값 행: F-06~F-12, F-14 (8) / 슬롯 선택 근거: F-04, F-45~F-52 (9) / 규칙(corral.md): F-55, F-57, F-61 (3) |
| 합계 | 41 | |

뜻 바뀜 표시 행(18): A-06, A-11, A-19, A-20, A-22, A-24, A-26, A-27, A-45, A-49, L-03, L-07, L-09, L-13, D-03, D-05, F-60, F-61. 이 밖에 A-25(「출고 머지」→「머지 후」)·F-26 등은 NEW 열에만 표기했다.

### 전수 B

#### plan-B — OLD(corral) vs NEW(paddock 렌더) 대조 전수표

OLD = <대상>/<경로>, NEW = <STAGE>/out/<경로>.
NEW 약칭: SKILL = NEW `.agents/skills/task-coordinate/SKILL.md`, IMPL = NEW `.agents/skills/task-coordinate/references/implementation.md`, VAL = NEW `.agents/rules/validation.md`.
「뜻 바뀜」은 요지 칸에 표시. 옮김 원문은 OLD 문장 그대로.

공통 관찰 (out/ 전체 grep 결과)
- LA → 「트래커」 일반화, `능력 계약 H4/H6/H2/H5/H8` → `.agents/harness/contract.md`, 리뷰어 전환·외부 서치 한도 소진 → `.agents/defaults.rules.md`(「리뷰어 사용 불가 시 자동 전환」·「외부 서치 한도 소진 시 생략」·「경쟁 구현」), 출고 회고(release §4) → `task-close` §5.
- herdr 격리 세션 정리는 `scripts/task-finish.sh` 에서 `.agents/harness/session-cleanup.sh` 훅(NEW harness/corral/cleanup.md:31)으로 옮겨 갔다. OLD scripts/task-finish.sh:258-261 의 herdr 정리와 :54 의 묶음 코디 예외 주석이 훅에 보존됐는지는 이 대조 범위 밖(별도 확인 필요).
- NEW 에 `design-brief`·`app-screens`·`script(1)`·`캡처`·`기록기`·`pgrep` 는 한 건도 없다(grep 0건).
- 렌더 외 부수 확인: OLD 레포 `app/src/main/adapter/internal/attach-session.ts` 에 문자열 `00-analysis-grok` 이 있다 — 아래 SKILL #20 의 파일 이름 바뀜과 함께 코드 쪽 참조 여부 확인 필요.

---

#### 1. `.agents/skills/task-coordinate/SKILL.md` (OLD 326줄 / NEW 332줄)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW 겹치는 위치 / 제안 목적지 | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| 1 | 1-7 | frontmatter. description 의 「Claude 또는 Codex 코디네이터」→「코디네이터」(뜻 바뀜: 도구 일반화) | 버림-중복 | SKILL:2-6 | |
| 2 | 11-13 | 전제(작업 worktree)·규칙 위치·「LA 전이 시점은 §1·§4·§5 첫 줄(진행 중은 task-start, 완료는 release)」. 뜻 바뀜: LA→트래커, 완료 전이 주체 release→task-close | 버림-중복 | SKILL:11-14 (완료 전이는 task-close, 리뷰어 전환 예외는 defaults.rules.md) | |
| 3 | 14-15 | 산출물은 `corral-specs/LIFE-NNN-<슬러그>/` 절대경로, 게이트 시점에 그 폴더만 커밋·push, 작업 브랜치엔 코드만 | 버림-중복 | SKILL:15-16 (`<본체>/../corral-specs/…` 로 일반화) | |
| 4 | 16 | 묶음 코디는 bundle.md 먼저 | 버림-중복 | SKILL:17 | |
| 5 | 18-20 | 이 문서에는 도구 명령이 없다·능력 계약·매핑 선택 | 버림-중복 | SKILL:19-21 | |
| 6 | 24-26 | §0 00-start.md 대조·불일치 보고·재개 시 중복 기동 금지 | 버림-중복 | SKILL:25-27 | |
| 7 | 27-29 | 이 세션에서 LA 조회·웹 검색·**`grok-search` 본문 읽기**·『전제 점검』 실행. 뜻 바뀜: grok-search 본문 읽기 → 「지정한 외부 서치 도구의 사용 가능 여부(§1 2)」 | 옮김-슬롯 D13 | SKILL:53-55 (D13 외부 서치 도구) | 이 세션에서 … 웹 검색 도구의 사용 가능 여부, `grok-search` 본문 읽기 … (D13 에 「도구 = grok, 사용 전 전역 `grok-search` 스킬 본문을 읽는다」로 넣는다) |
| 8 | 30-31 | 『전제 점검』 불일치면 멈춘다·맨터미널 공백 | 버림-중복 | SKILL:31-32 | |
| 9 | 32-35 | provider 실행 파일(claude·codex·grok)을 셸이 찾는지 확인·몰래 대체 금지·사전 승인 예외 둘(Codex 사용 불가 시 리뷰어 전환·Grok 한도 소진 시 서치 생략) = defaults.md 원본. 뜻 바뀜: 「defaults.md 역할 표의 도구」·defaults.rules.md 로 일반화 | 버림-중복 | SKILL:33-36, defaults.rules.md:36(리뷰어 사용 불가 시 자동 전환)·:76(외부 서치 한도 소진 시 생략) | |
| 10 | 36-38 | 빠진 도구·권한 보고, 임의 코디 교체 금지 | 버림-중복 | SKILL:37-38 | |
| 11 | 38 | 통과하면 00-start 를 `준비 완료` 로 갱신·커밋 | 버림-중복 | SKILL:40 | |
| 12 | 39-40 | rules 를 단계마다 읽는다(writing·coding·validation) | 버림-중복 | SKILL:41-42 | |
| 13 | 44 | §1 첫 줄: LA 를 「분석 중」 으로 전이. 뜻 바뀜: LA→트래커·상태 이름은 task-start D3 슬롯으로 위임 | 버림-중복 | SKILL:46 (상태 이름은 task-start D3 가 채움) | |
| 14 | 46-47 | 일감 본문 확보·`00-analysis.md` 스냅샷(능력 계약 H4) | 버림-중복 | SKILL:48-49 | |
| 15 | 48-50 | 외부 서치: 코디 자체 서치(WebSearch/WebFetch, Codex 도구) 먼저, grok 은 판단해 띄움. 뜻 바뀜: grok→「외부 서치 도구」 일반화 | 옮김-슬롯 D13 | SKILL:50-55 | 코디네이터의 웹 검색(Claude Code는 WebSearch/WebFetch, Codex는 제공된 웹 검색·페이지 열기 도구) + 코드 읽기 + 짧은 실측을 수 분 하고 나서 grok 기동을 정한다. (D13: 외부 서치 도구 = grok) |
| 16a | 51-54 | 띄우는 조건 ①②③·애매하면 띄운다 | 버림-중복 | SKILL:56-59 | |
| 16b | 51-53 | 조건 ① 의 corral 예시 「(git·herdr·provider CLI 동작, upstream 수정 여부 등)」 → NEW 는 「사용하는 CLI·라이브러리·외부 서비스」. 근거 표기 빠짐: LIFE-672(L55 — 로컬 실측으로 닫혔고 Grok 은 외부 근거 두 줄만 보탬) | 옮김-슬롯 D13 | SKILL:53-55 (D13 「띄우는 조건의 프로젝트 예시」) | (git·herdr·provider CLI 동작, upstream 수정 여부 등) |
| 17 | 56-57 | 생략 기록: 「Grok 생략 — 사유」·교차 대조 칸 공백·게이트 ⓪ 보고 한 줄. 뜻 바뀜: 「Grok 생략」→「외부 서치 생략」 | 버림-중복 | SKILL:60-61 | |
| 18 | 58-62 | 띄우면 별도 세션 병렬 위임(『세션 기동』(grok)→…→『화면 관측』 회수)·전역 grok-search 는 리서치 규칙만·한도 소진이면 defaults.md 대로 생략. 뜻 바뀜: grok→외부 서치 도구, 원본 defaults.md→defaults.rules.md | 버림-중복 | SKILL:62-66, defaults.rules.md:76-88 | |
| 19 | 63-64 | 서치 대기 중 기준 초안·서치 취합 후 기준 확정(freeze=킥오프 승인 시점) | 버림-중복 | SKILL:67-68 | |
| 20 | 66-67 | 선행 문서 사실 주장 대조표. **뜻 바뀜: 외부 서치 원문 파일 이름 `00-analysis-grok.md` → `00-analysis-search.md`** (기존 일감 폴더·코드 참조 영향, 위 공통 관찰 참조) | 옮김-규칙 | .agents/rules/corral.md(신설) 에 「이 프로젝트의 외부 서치 원문 파일은 기존 일감과 같게 `00-analysis-grok.md`」 또는 이름 변경 수용 결정 기록. 소관: 사용자 결정 | 산출물: `00-analysis.md` (+ 외부 서치 원문 `00-analysis-grok.md`) |
| 21 | 68-69 | learnings 를 골라 읽고 02-kickoff 제약에 인용. 뜻 바뀜: 인용 항목을 「출고 회고(release §4)」→「머지 뒤 회고(task-close §5)」가 대조 | 버림-중복 | SKILL:72-74 | |
| 22 | 70 | 절차 어긋남 섹션 누적 | 버림-중복 | SKILL:75 | |
| 23 | 71-74 | **UI 비중이 큰 일감이면 `design-brief`/`design-intake` 삽입 여부 검토**: app-screens.md → design-brief → 외부 Claude Design → design-intake → 01-criteria/02-kickoff freeze, 안 넣으면 사유 한 줄 | 옮김-규칙 | .agents/rules/corral.md(신설) | **UI 비중이 큰 일감이면 `design-brief`/`design-intake` 삽입 여부를 검토한다** — 비주얼 디테일이 판정 기준에 안 잡히면 목업 없이 구현자 재량에 맡길 때 재작업 위험이 있다. 넣으면 `corral-specs/app-screens.md`(없으면 먼저) → `design-brief` → 외부 Claude Design → `design-intake` → 그 결과로 `01-criteria.md`/`02-kickoff.md` freeze. 안 넣으면 사유를 `00-analysis.md` 에 한 줄 (판단 없이 생략 금지) |
| 24 | 78-80 | §2 필수 관문 ①~④ | 버림-중복 | SKILL:79-81 | |
| 25 | 81-82 | **신호를 좁히거나 조건을 거는 일감은 그 신호의 소비자를 코드로 전부 열거**, 소비자마다 그대로/바뀜/따로 보호 (LIFE-683·708) | 옮김-규칙 | .agents/rules/corral.md(신설) (일반 규칙이라 paddock 환원 후보이기도 함) | **신호를 좁히거나 조건을 거는 일감은 그 신호를 읽는 소비자를 코드로 전부 열거하고 소비자마다 그대로/바뀜/따로 보호를 칸에 적는다** (함수 호출처만이 아니라 대상 값의 리터럴 목록까지 — 새 신호를 더하기만 하면 해당 없음, 문서·스킬 일감은 참조 grep 으로 대신)(LIFE-683·708). |
| 26 | 83-84 | **지연·경합 수정의 관문은 고친 경로가 실제로 난 횟수를 로그로 따로 세어 증상 결과와 짝지음** (LIFE-710·595) | 옮김-규칙 | .agents/rules/corral.md(신설) | **지연·경합 수정의 관문은 고친 경로(목표 순서)가 실제로 난 횟수를 로그로 따로 세어 증상 동작 결과와 짝지어 칸에 둔다** — 다른 경로가 따라잡아도 통과로 보이므로 증상 통과만으로 수정 효과를 증명했다고 쓰지 않는다. 손으로 그 창을 못 맞히면 게이트 ⓪ 에서 공백을 합의한다(LIFE-710·595). |
| 27 | 85-86 | **관측 대상이 데이터·상태면 기준 동결 때 조회 명령과 결과를 붙이고, 없으면 대체 대상을 그 자리에서 정함** (LIFE-746·812) | 옮김-규칙 | .agents/rules/corral.md(신설) | **관측 대상이 데이터·상태(특정 pane·레인·목록)면 기준을 동결할 때 조회 명령과 결과를 기준에 붙이고, 없으면 대체 대상을 그 자리에서 정한다** — 사후에 바꾼 대상의 값은 통과로 올리지 않는다. 구현 뒤에야 생기는 대상은 「구현 뒤 만드는 픽스처」로 적는다(LIFE-746·812). |
| 28 | 87 | 매핑에서 공백인 능력은 통과선으로 쓰지 않는다 | 버림-중복 | SKILL:84 | |
| 29 | 88-89 | 경량 경로면 기준 3~5개·필수 관문 ①~④ 유지·원장 생략 | 버림-중복 | SKILL:85-86 | |
| 30a | 90-92 | 빠른 확인/최종 관문 구분. corral 구체: 빠른 확인=빌드·typecheck·`npm test`·핵심 진입점 1회, 최종 관문=변이 시험·전후 행렬·lint 전후 비교·네이티브 실행·판정표 집계 | 옮김-슬롯 D7 | SKILL:89-91(§2), SKILL:227-229(§5) | 빠른 확인 = 수 분 안에 끝나는 것 (빌드·typecheck·`npm test`·핵심 진입점 1회). 최종 관문 = 나머지(변이 시험·전후 행렬·lint 전후 비교·네이티브 실행·판정표 집계 등). (§5 슬롯은 명령 한 줄씩 — 명령 자체는 OLD 에 없음, `npm test` 외 확인 필요) |
| 30b | 93-94 | **문서·스킬 일감의 빠른 확인은 문구 대조만으로 끝내지 않는다** — 바뀐 명령 블록을 문서에서 그대로 추출해 정상·빈 입력·실패 분기를 한 번씩 돌린다, 손으로 옮긴 복제본 금지 (LIFE-713·683) | 옮김-규칙 | .agents/rules/corral.md(신설) | 문서·스킬 일감의 빠른 확인은 문구 대조만으로 끝내지 않는다 — 바뀐 명령 블록을 문서에서 그대로 추출해 정상·빈 입력·실패 분기를 한 번씩 돌린다. 손으로 옮긴 복제본으로 대신하지 않는다(LIFE-713·683). |
| 31 | 95-96 | 레포 전체 장치를 통과선으로 쓰면 동결 전 base 에서 한 번 돌림. 근거 표기 빠짐: LIFE-714·716·717 | 버림-중복 | SKILL:92-93 | |
| 32 | 97 | 기준 없이 구현 시작 금지 | 버림-중복 | SKILL:94 | |
| 33 | 101-102 | §3 설계는 워커가 흡수 | 버림-중복 | SKILL:98-99 | |
| 34 | 103-104 | 경로 경량/전체·게이트 ⓪ 에서 확정 | 버림-중복 | SKILL:100-101 | |
| 35 | 105-107 | 왜 이 축인가(원장은 반복 위험) | 버림-중복 | SKILL:102-104 | |
| 36 | 108-111 | 경량 정의·조건 ⓐⓑⓒ | 버림-중복 | SKILL:105-108 | |
| 37 | 112-119 | 경량 범주 닫힌 목록 4종(렌더러 UI / 문서·스킬·규칙·매핑 문구 / 정적 값 / 자산·설정)과 각 경계 | 옮김-슬롯 D8 | SKILL:109-112 (닫힌 목록 슬롯) | - 렌더러 UI — 렌더러의 컴포넌트·순수 함수·CSS<br>- 문서·스킬·규칙·매핑 문구 — `.agents/` 의 절차 문서와 README·ADR 같은 산문. 하네스 매핑의 선언 블록(검사 스크립트가 읽는 것)과 문서 속 명령이 가리키는 스크립트 자체는 아니다<br>- 정적 값 — 선택지·표시 값과 그 값을 따라 바뀐 테스트 기대값. 값을 검증·분기하는 로직은 그대로일 때만. 제품 로직의 주기·횟수·임계 상수는 정적 값이 아니다(목록 밖 — 전체)<br>- 자산·설정 — 아이콘·이미지 같은 자산과 사용자 대면 표시 설정(앱 이름·아이콘·표시 문구). 같은 설정 파일 안이라도 바뀐 항목으로 가른다 — 패키지 식별자·버전·권한·서명·빌드 프로필은 패키징 설정(전체)이다 |
| 38 | 120-121 | 전체 정의·문서·스킬 일감이어도 명령 블록이 원격·사용자 자원을 바꾸면 전체 | 버림-중복 | SKILL:113-114 | |
| 39 | 122 | 전체로 올리는 것: PTY·herdr·에이전트 상태·IPC·레지스트리 동시성·영속 데이터 형식 | 옮김-슬롯 D8 | SKILL:115-117 (「전체로 올리는 것」 줄 슬롯) | - PTY·herdr·에이전트 상태·IPC·레지스트리 동시성·영속 데이터 형식 |
| 40 | 123 | 원격 상태 쓰기 — 「GitHub 설정·브랜치·태그·릴리즈」→「저장소 설정…」로 일반화 | 버림-중복 | SKILL:118 | |
| 41 | 124 | **뜻 바뀜: 「출고·PR·정리 스크립트의 동작」→「배포·PR·정리 스크립트의 동작」** — corral 의 출고(`scripts/release.sh`)가 이름에서 빠짐(패키징 설정 포함은 유지) | 옮김-슬롯 D8 | SKILL:115-117 슬롯에 추가 (출고 스크립트 자체는 release 스킬/D17 소관이나 「전체로 올리는 것」 목록에는 필요) | - 출고(`scripts/release.sh`)·PR·정리 스크립트의 동작 — 패키징 설정(패키지 식별자·버전·권한·서명·빌드 프로필) 포함 |
| 42 | 125-127 | 판정 장치·되돌리기 비싼 변경 | 버림-중복 | SKILL:120-122 | |
| 43 | 128-130 | 애매하면 전체·경로 무관 공통 사항·경량이 전체 대상 건드리면 재승인 | 버림-중복 | SKILL:123-125 | |
| 44 | 131-134 | 정체 표·00-start 선택 옮김·advisor 공백 | 버림-중복 | SKILL:126-129 | |
| 45 | 135-136 | 경쟁 구현 발동 근거 기록(defaults.md「경쟁 구현」) | 버림-중복 | SKILL:130-131 (defaults.rules.md:91 「경쟁 구현」) | |
| 46 | 137-139 | 격리 규칙: 사용자가 실제 쓰는 리소스(**default 세션·소켓 등**)를 건드리지 않는다·외부 도구 실측은 전용 격리 인스턴스·제어 문맥 격리 | 옮김-슬롯 D6 | SKILL:132-137 (D6 슬롯 135-137) | 사용자가 실제 쓰는 리소스(default 세션·소켓 등)를 건드리지 않는다. 외부 도구 실측은 전용 격리 인스턴스에서. |
| 47 | 140-141 | **격리 기동이 헤드리스라 안 된다고 단정하지 않는다** — 필요한 것은 TTY, `script(1)` 류 PTY 래퍼로 가능. 탭 경로 수십 초·PTY 경로 수십 ms, 재기동 시간이 통과선이면 경로를 적는다 | 옮김-규칙 | .agents/rules/corral.md(신설) (또는 .agents/learnings/harness.md — 한 번 겪은 배움 성격) | **격리 기동이 헤드리스라 안 된다고 단정하지 않는다** — 필요한 것은 TTY 이고 `script(1)` 류 PTY 래퍼로 띄울 수 있다. 기동 경로에 따라 시간이 자릿수로 갈리므로(탭 경로 수십 초 · PTY 경로 수십 ms) 재기동 시간이 통과선이면 경로를 적는다. |
| 48 | 142-143 | 원자료 규칙 `raw/<도구>/`·근거 칸 실물 없으면 무효 | 버림-중복 | SKILL:138-139 | |
| 49 | 144-145 | 일감 명세 첫 단계 = LA 조회 결과 원자료(H4) | 버림-중복 | SKILL:140-141 (트래커를 쓰면) | |
| 50 | 146-147 | 결과 문서·DONE.md·완료 감지는 §4 | 버림-중복 | SKILL:142-143 | |
| 51 | 149-151 | 게이트 ⓪ 머리·00/01/02 커밋 후 보고하고 멈춘다 | 버림-중복 | SKILL:145-147 | |
| 52 | 153-156 | 게이트 ⓪ 보고 4항목. **진행 방식 항목의 「디자인 브리프 삽입 여부와 사유」 빠짐**(NEW:152 는 「역할별 모델/effort·advisor」까지) | 옮김-규칙 | .agents/rules/corral.md(신설) — #23 의 design-brief 규칙과 한 묶음 | **진행 방식**: 단독 구현(또는 경쟁 발동 근거), 역할별 모델/effort·advisor, 디자인 브리프 삽입 여부와 사유 |
| 53 | 158-159 | 승인 후 §4·재승인 규칙 | 버림-중복 | SKILL:154-155 | |
| 54 | 163-164 | §4 첫 줄 LA 「개발 중」 전이·역할 구성은 00-start | 버림-중복 | SKILL:159-160 | |
| 55 | 166-168 | 요청·해소 모델 관측 | 버림-중복 | SKILL:162-164 | |
| 56 | 170-172 | 기동 전 implementation.md 읽기·경쟁 구현 분리 | 버림-중복 | SKILL:166-168 | |
| 57 | 176-177 | §4.1 implement 일감 발급·완료 보고 | 버림-중복 | SKILL:172-173 | |
| 58 | 178-180 | 일감 명세에 **corral-specs 커밋 해시**·절대경로·네이티브 실행 관문 명시, 격리만으로 통과 보고 금지 | 버림-중복 | SKILL:174-176 (「산출물 커밋 해시」) | |
| 59 | 181-184 | 구현 중 범위 변경은 질의응답·재승인, 수정 라운드용 워커 보존 | 버림-중복 | SKILL:177-180 | |
| 60 | 188-190 | §4.2 식별자 확인·완료는 완료 보고 | 버림-중복 | SKILL:184-186 | |
| 61 | 192-197 | 배치 처리·ACK, 타임아웃≠새 워커, 회수 우회 금지 | 버림-중복 | SKILL:188-193 | |
| 62 | 198-202 | 차단 화면은 질문 아님·세션 기록 오라클은 사후 확인만 | 버림-중복 | SKILL:194-198 | |
| 63 | 206 | §5 첫 줄 LA 「검증 중」 유지(forward-only) — 「세부 단계는 specs 에 적는다」→「작업 폴더」 | 버림-중복 | SKILL:202 | |
| 64 | 208-210 | 리뷰어 구성은 defaults.md 가 정함(현재 기본 Codex 단독·라운드마다 Codex 사용 가능 확인(카탈로그·사용량)·「코드 리뷰 일시 중지」·「Codex 사용 불가 시 자동 전환」). 뜻 바뀜: 「일시 중지」 절 참조 삭제, 「리뷰어 구성 변경 기록」 추가 | 버림-중복 | SKILL:204-206, defaults.rules.md:25(구성 변경 기록)·:36(자동 전환). 「코드 리뷰 일시 중지」 절은 defaults.rules.md 에 없음(grep) — defaults.md 쪽 이관 여부는 별도 확인 | |
| 65 | 211-213 | reviewer.md 먼저·별도 세션·자기 구현분도 리뷰 | 버림-중복 | SKILL:207-209 | |
| 66a | 214-216 | 기동: 감독 워커 기동(grok 처럼 감독 경로 없으면 세션 기동+준비 대기+본문 주입)·리뷰어마다 일감 따로 | 버림-중복 | SKILL:210-212 | |
| 66b | 217 | **첫 리뷰어를 띄우기 직전에 LA 「검증 중」 전이를 확인한다 — 절 머리의 전이는 이 자리에서 한다. (LIFE-713·822·834)** — NEW 에서 빠짐 | 옮김-규칙 | .agents/rules/corral.md(신설) (또는 SKILL:202 의 전이 줄에 한 문장 추가) | **첫 리뷰어를 띄우기 직전에 LA 「검증 중」 전이를 확인한다** — 절 머리의 전이는 이 자리에서 한다. (LIFE-713·822·834) |
| 67 | 218 | 큰 스펙은 파일 전달 경로 | 버림-중복 | SKILL:213 | |
| 68 | 219-220 | 결과 `raw/review/<도구>-rN.md`(예 codex-r1→reviewer-r1) | 버림-중복 | SKILL:214-215 | |
| 69 | 221-222 | reviews.md 한 파일 덧붙임 | 버림-중복 | SKILL:216-217 | |
| 70 | 223 | Grok 이 리뷰에 들어가면 외부 사실 대조 추가. 뜻 바뀜: 「Grok」→「외부 서치 도구」 | 버림-중복 | SKILL:218 | |
| 71 | 224 | 수정 라운드 재리뷰는 새 리뷰 세션 | 버림-중복 | SKILL:219 | |
| 72a | 225 | 수정 라운드는 같은 워커에 새 일감·새 시도 | 버림-중복 | SKILL:220 | |
| 72b | 226 | **수정 diff 정독 시 01-criteria 가 가리키는 정의 자리(문구·bullet)가 여전히 맞는지, 기준을 보강했으면 기존 행과 문자 그대로 양립하는지 대조 (LIFE-714·835)** — NEW 에서 빠짐 | 옮김-규칙 | .agents/rules/corral.md(신설) | 수정 diff 를 정독할 때 01-criteria 가 가리키는 정의 자리(문구·bullet)가 여전히 맞는지, 기준을 보강했으면 같은 항목의 기존 행과 문자 그대로 양립하는지도 대조한다. (LIFE-714·835) |
| 73 | 227-232 | 테스트 계층(빠른 확인만→수렴 뒤 최종 관문 1회·재리뷰 1회·실행 목록 누적) | 버림-중복 | SKILL:221-226 (+D7 명령 슬롯 227-229 → #30a) | |
| 74 | 236-237 | §6 raw 확인·커밋, 구현자 파일 직접 수정 금지 | 버림-중복 | SKILL:233-234 | |
| 75 | 238 | **뜻 바뀜: 구현 HEAD 태그 `LIFE-NNN-<도구>-final` → `LIFE-NNN-<슬러그>-<도구>-final`** (태그 이름 형식. OLD scripts/task-finish.sh:245 는 `LIFE-NNN-*-final` 유지로 적음 — 스크립트가 어느 패턴인지 확인 필요) | 옮김-규칙 | .agents/rules/corral.md 가 아니라 결정 사항: NEW 이름(슬러그 포함)으로 통일 수용 여부를 사용자에게 확인. 수용이면 옮길 것 없음 | 구현 HEAD를 `LIFE-NNN-<도구>-final`로 고정한다. 단독 구현에 비교 승자/탈락 후보를 꾸며 쓰지 않는다. |
| 76 | 239-240 | verdict.md 라운드 요약표+판정표만, 지적별은 reviews.md 링크 | 버림-중복 | SKILL:236-237 | |
| 77 | 241-243 | 판정표 7칸·원장/실행 칸 비움 금지·경량 `해당 없음 — 경량 경로`·공백 능력 보류 | 버림-중복 | SKILL:238-240 | |
| 78 | 244-245 | 다수결 기각 금지·전원 침묵 근거 금지. 근거 표기 빠짐: 「리뷰어가 모두 놓친 높음 결함을 게이트 ① 사용자 확인이 잡은 전례가 있다」→「잡을 수 있다」 | 버림-중복 | SKILL:241-242 | |
| 79 | 246 | codex 의 「구조를 버리고 다시 쓰라」 류 지적은 독립 재현 후 채택 (codex→리뷰어 일반화) | 버림-중복 | SKILL:243 | |
| 80 | 247-250 | advisor 조언은 지적 아님·기각 사유 기록·경쟁 시 자기 리뷰 제외 | 버림-중복 | SKILL:244-247 | |
| 81 | 251 | 수렴 조건·수정 상한 3회 | 버림-중복 | SKILL:248 | |
| 82 | 255 | §7 게이트 ① 보고하고 멈춘다·조용한 완료 금지 | 버림-중복 | SKILL:252 | |
| 83 | 257 | **뜻 바뀜: §8 제목 「승인 게이트 ② — 출고 승인 = PR 생성」→「PR 생성 승인」** (출고라는 말을 PR 생성에서 분리) | 버림-중복 | SKILL:254 | |
| 84 | 259-264 | 머지 후 통합 결과 직접 확인 요청(실행 방법 한 줄)·문제 시 수정 라운드 | 옮김-슬롯 D15 | SKILL:260-264 (D15 슬롯 262-264). 본문은 중복이나 「실행 방법 한 줄」의 corral 값은 OLD 파일에 없음 — adopt 가 AGENTS.md/memory(설치본 `/Applications/corral.app`·`~/.local/bin/corral` shim)에서 채움 | (OLD 에 명령 원문 없음) |
| 85 | 265-268 | 게이트 ① 사용자 수정 라운드(`## 게이트 ① 수정 N`) | 버림-중복 | SKILL:265-268 | |
| 86 | 269-270 | 게이트 ② 기록을 **출고 승인 요청 전**에 씀(LIFE-704)·셋 다 작업 폴더·PR 에 싣지 않음·채택은 **출고 회고(release §4)** 가 하고 공개 파일·ADR 번호는 그때. 뜻 바뀜: 출고 승인→PR 생성 승인, release §4→task-close §5. 근거 표기 빠짐: LIFE-704 | 버림-중복 | SKILL:269-272 | |
| 87 | 271-275 | devlog `devlog.md`(**비공개**)·날짜별 절·**세 관점(사람·LLM·LLM 이 본 지시)**·끝에 **회고 절(문제 정의·검증 설계·방식 개선 세 렌즈)**. **뜻 바뀜: 「날짜마다 두 절」(사람·LLM)로 줄고 「LLM 이 본 지시」와 회고 절이 삭제됨** | 옮김-규칙 | .agents/rules/corral.md(신설) 또는 사용자 결정(paddock 정본을 따를지). IMPL #28 의 「LLM 절」(OLD「LLM 관점」)과도 연동 | devlog `devlog.md` (비공개) — 한 파일, 날짜별 절(`## YYYY-MM-DD`). 날짜마다 세 관점: **사람**(그날의 결정·승인·지시 원문 — LLM 초안이고 사용자가 고친다. 감정·의도를 추측해 쓰지 않는다) · **LLM**(시도 → 실패 → 원인 → 해결) · **LLM 이 본 지시**(방향을 바꾼 지시, 반복된 지적, 모호했던 지시). 끝에 **회고** 절 — 일감 전체를 세 렌즈로 본다: 문제 정의(처음 정의가 맞았나) · 검증 설계(기준·관문이 결함을 잡았나) · 방식 개선(다음엔 무엇을 바꾸나). 관점은 누구의 시선이고 렌즈는 무엇을 보나다. |
| 88 | 276-277 | devlog 재료는 transcript·git log 로 대조·reviews.md 는 내용 대조 | 버림-중복 | SKILL:276-277 | |
| 89 | 278-282 | 코디 세션 기록 찾기. **뜻 바뀜: 「기록 경로가 없는 경우」에서 「지금 corral 매핑의 Codex 코디, 매핑 『세션 기동』 절」 예시와 「즉 transcript 대조는 지금 Claude 코디 일감에서만 된다」 문장 삭제** (능력 계약 H6→contract.md H6) | 옮김-규칙 | .agents/harness/corral/session-start.md (매핑 소관, 현재 :13 은 claude 만 서술) — 매핑 파일에 한 줄 | 경로가 없으면(기동 응답에 경로를 주지 않는 도구 — 지금 corral 매핑의 Codex 코디, 매핑 『세션 기동』 절 — 또는 그 기록을 남기기 전에 시작한 일감) … 즉 transcript 대조는 지금 Claude 코디 일감에서만 된다. |
| 90 | 283-285 | 세션 기록 오라클·관측이라 증명 아님·GUI 직접 친 입력 놓침(H2) | 버림-중복 | SKILL:282-284 | |
| 91 | 286-287 | worklog.md 에서 읽기·보존 워커에게 새 일감·질의응답은 코디→워커용 아님 | 버림-중복 | SKILL:285-286 | |
| 92 | 288-291 | learnings 제안·ADR 초안(template.md, `status: proposed`) | 버림-중복 | SKILL:287-290 | |
| 93 | 292-294 | 사람 절 확인은 정리 전에 끝낸다. 뜻 바뀜: 「출고 승인」→「PR 생성 승인」 | 버림-중복 | SKILL:291-293 | |
| 94 | 295 | **뜻 바뀜: 「출고 승인은 PR 생성이다. main 머지가 아니다」→「승인하는 것은 PR 생성이다」** | 버림-중복 | SKILL:294 | |
| 95 | 296-299 | handoff-main.md 내용: 「출고 때 본체 세션이 볼 사항」·「LA의 현재 상태(검증 중)와 다음 전이(출고 머지 뒤 완료)」. **뜻 바뀜: 「머지 뒤 확인할 것·필수 후속 항목(task-close §3·§4)」·트래커 상태로 교체** | 버림-중복 | SKILL:295-301 (task-close 흐름이 대체) | |
| 96 | 300-303 | pr.md: 묶음 자식 없음·`LIFE-NNN:` 접두·본문 구성·내부 절차 금지·**「(private 레포라 링크가 아닌 텍스트)」** 빠짐. 근거 표기: private 레포 | 버림-중복 | SKILL:302-307 (판정문 위치는 스크립트가 붙임) | |
| 97 | 304 | pr.md 마지막: 「코드 레포가 공개될 수 있으므로 원자료 경로·내부 세션 정보 금지. **출고 때 릴리즈 노트가 이 본문을 재료로 쓴다.**」→ 뒷 문장 빠짐 | 옮김-규칙 | release 스킬/D17 (릴리즈 노트 재료 규칙은 출고 방식 소관) | 출고 때 릴리즈 노트가 이 본문을 재료로 쓴다. |
| 98 | 305 | 원고 없거나 첫 줄이 제목 아니면 task-pr.sh 가 멈춤 | 버림-중복 | SKILL:309 | |
| 99 | 306-309 | task-pr.sh 로 PR 연다·`gh pr list --head`·묶음 자식은 PR 안 염 | 버림-중복 | SKILL:310-313 | |
| 100 | 310-311 | 정리까지 한다(코디 마지막 실행)·task-finish.sh 는 본체 경로에서 | 버림-중복 | SKILL:314-315 | |
| 101 | 312-314 | task-finish.sh 독립 작업: **「격리 herdr 세션」 정리 빠짐**, 태그 `LIFE-NNN-*-final`→`LIFE-NNN-<슬러그>-*-final`. 뜻 바뀜 | 버림-중복 | SKILL:316-318, herdr 정리는 `.agents/harness/session-cleanup.sh` 훅(NEW harness/corral/cleanup.md:31, scripts/task-finish.sh:305)으로 이동. 태그 형식은 #75 와 같은 결정 | |
| 102 | 315-318 | 묶음 자식 `--into feature/…`·반영 시작 알림(bundle.md 4)·묶음 마무리는 묶음 코디(bundle.md 6) | 버림-중복 | SKILL:319-322 | |
| 103 | 319-321 | 마지막 보고: PR 번호·인계 문서 경로·**「PR 생성·정리 완료, 출고 대기」**·**열린 PR 이 3~4건을 넘거나 같은 파일을 건드리면 출고를 권한다**·LA 는 검증 중. **뜻 바뀜: 「출고 대기」→「PR 생성·정리 완료」+「머지는 본체 세션이 한다」, 출고 권고 문장 삭제** | 옮김-규칙 | release 스킬/D17 (출고 권고 기준 3~4건·같은 파일은 출고 방식 소관) | 열린 PR 이 3~4건을 넘거나 같은 파일을 건드리면 출고를 권한다. (보고 끝 문구: "PR 생성·정리 완료, 출고 대기") |
| 104 | 322 | 스크립트 실패 시 멈추고 원문 보고·task-pr 재사용·정리 멱등 | 버림-중복 | SKILL:327 | |
| 105 | 323 | **뜻 바뀜: 「코디네이터가 직접 실행하는 것은 PR 생성과 정리까지. 출고(release 브랜치에 PR 모으기·main 머지·태그·릴리즈 노트·dmg·APK·LA 완료)는 본체 세션 release 스킬 몫」→「코디는 머지하지 않는다·머지는 본체 task-close」** | 옮김-규칙 | release 스킬/D17 (task-close 머리 D17 에 「출고 = release 스킬: release 브랜치에 PR 모으기·main 머지·태그·릴리즈 노트·dmg·APK·LA 완료」) | **출고**(release 브랜치에 PR 모으기·main 머지·태그·릴리즈 노트·dmg·APK·LA 완료)는 본체 세션의 `release` 스킬 몫이다. |
| 106 | 324 | **작업 관문에서 만든 브랜치 dmg·APK 는 dev 빌드 — 정식본은 출고 태그에서 만들고 폰의 브랜치 APK 도 출고 때 태그 APK 로 덮인다** — NEW 에서 빠짐 | 옮김-규칙 | release 스킬/D17 | 작업 관문에서 만든 브랜치 dmg·APK 는 dev 빌드다 — 정식본은 출고 태그에서 만들고, 폰의 브랜치 APK 도 출고 때 태그 APK 로 덮인다. |
| 107 | 325-326 | worktree 는 PR 생성·정리까지 유지·pane 정리는 회수·정리·빌린 pane 따로 닫기 | 버림-중복 | SKILL:331-332 | |

---

#### 2. `.agents/skills/task-coordinate/references/implementation.md` (OLD 110줄 / NEW 101줄)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW 겹치는 위치 / 제안 목적지 | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| 1 | 1-6 | 머리말. 매핑 위치 `.agents/harness/<도구>.md`→`<도구>/ — 00-mapping.md 목차에서 그 능력 파일` (뜻 바뀜: 매핑이 폴더 구조로) | 버림-중복 | IMPL:1-6 | |
| 2 | 10-14 | 모델/effort 는 00-start·실제 해소 모델 관측·advisor picker 조회 후 취소 | 버림-중복 | IMPL:10-14 | |
| 3 | 15-17 | 워커는 구현 브랜치에 커밋·raw 는 `corral-specs/LIFE-NNN-*/raw/<도구>/`(상대 표기)·별도 설계 문서 없음 | 버림-중복 | IMPL:15-17 (`<본체>/../corral-specs/LIFE-NNN-<슬러그>/` 로 명시) | |
| 4 | 18-19 | 리뷰어 결과 경로·commit/add 금지 | 버림-중복 | IMPL:18-19 | |
| 5 | 20-21 | 워커에게 기준 문서 경로+corral-specs 커밋 해시 | 버림-중복 | IMPL:20-21 | |
| 6a | 22-23 | 일감 전용 관문 스크립트는 작업 폴더 `scripts/` 에 둠·코드 레포에 커밋 안 함 | 버림-중복 | IMPL:22-23 | |
| 6b | 23-26 | worktree 경로는 절대경로 인자·환경변수. corral 구체: 상대 import(`../../src/…`) 금지, `import(pathToFileURL(path.join(wt, 'app/src/…')).href)`, TS 면 worktree `app/` 에서 `node --import tsx <스크립트>`, vitest 는 루트 밖 파일 미수집, `createRequire(path.join(wt, 'app/package.json'))` | 옮김-슬롯 D9 | IMPL:26-28 (D9 슬롯) | 상대 import(`../../src/…`)는 안 된다. 소스는 `import(pathToFileURL(path.join(wt, 'app/src/…')).href)` 로 읽고 TS 면 그 worktree `app/` 에서 `node --import tsx <스크립트>` 로 돌린다(vitest 는 루트 밖 파일을 수집하지 않는다). node_modules 는 `createRequire(path.join(wt, 'app/package.json'))` 로 푼다. |
| 6c | 26-27 | 작업 폴더 scripts/ 는 코디가 게이트 시점 커밋·코드 레포엔 하는 일 이름으로(시험은 검사 대상 옆, 도구는 `app/scripts/<하는 일>/`, LIFE 번호 없이). NEW 는 「레포의 스크립트 폴더에 `<하는 일>/`」로 일반화 | 옮김-슬롯 D9 | IMPL:29-30 (본문은 중복) — `app/scripts/<하는 일>/` 경로 구체값은 D9 슬롯 또는 .agents/rules/corral.md | 도구는 `app/scripts/<하는 일>/`, 경로에 LIFE 번호 없이. |
| 6d | 28-31 | **옛 일감 하네스(LIFE-717 이전 코드 레포의 일감 번호 폴더)**: `corral-specs/LIFE-<번호>-*/scripts/<원래 폴더명>/`(원래 폴더명은 `l`+일감 번호), 색인·돌리는 커밋·worktree 만드는 법은 LIFE-717 작업 폴더(`…-script-cleanup`) 루트 `moved-index.md` 「재현」, 기본 출력이 worktree 안 `specs/…` 인 옛 하네스는 출력 경로를 작업 폴더로 지정(남은 파일은 task-finish.sh 가 멈춰 알림) — NEW 에서 통째로 빠짐(grep `LIFE-717`·`moved-index` 0건) | 옮김-규칙 | .agents/rules/corral.md(신설) 또는 .agents/learnings/testing.md (옛 하네스 재현 안내) | 옛 일감 하네스(LIFE-717 이전 코드 레포의 일감 번호 폴더)는 `corral-specs/LIFE-<번호>-*/scripts/<원래 폴더명>/`(원래 폴더명은 `l` 뒤에 일감 번호)에 있고, 폴더별 색인과 돌리는 커밋·worktree 만드는 법은 LIFE-717 작업 폴더(`…-script-cleanup`) 루트 `moved-index.md` 「재현」에 있다. 옛 하네스 가운데 기본 출력이 worktree 안 `specs/…` 인 것을 돌릴 때는 출력 경로를 작업 폴더로 지정하게 한다 (거기 남은 파일은 `task-finish.sh` 가 정리 전에 멈춰 알린다). |
| 7 | 32-35 | native advisor 는 별도 구현자·독립 리뷰어 아님·advisor 조언은 리뷰 지적 아님 | 버림-중복 | IMPL:31-34 | |
| 8 | 39-41 | §2-1 킥오프 후 구현 브랜치·형제 worktree 생성·repo hook 없으면 setup 단계 없음 | 버림-중복 | IMPL:38-40 | |
| 9 | 43-47 | `git worktree add … "${TASK_BRANCH}-claude"`. 뜻 바뀜: 접미사 고정 `-claude`→`${IMPL}` 변수(`VARIANT_SUFFIXES`) | 버림-중복 | IMPL:42-48 | |
| 10 | 49-53 | **생성 직후 상위 지정(LIFE-576 D7)**: 구현·리뷰 worktree 의 상위를 작업 worktree 로 지정(사이드바 표시용 메타)·매핑의 『감독 워커 기동』「git 으로 만든 직후 상위를 지정한다」·실패는 경고만·능력 없으면 공백 — NEW IMPL 에서 빠짐(단 task-start/매핑에는 있음) | 버림-중복 | NEW 에서 IMPL 본문엔 없으나 같은 내용이 .agents/harness/corral/supervised-worker.md:32-36, commands.md:44, task-start/SKILL.md:80 에 있음(이동). 근거 표기 빠짐: LIFE-576 D7 | |
| 11 | 55-58 | §2-2 『제어 문맥 격리』·기존 Run 우선·복원 | 버림-중복 | IMPL:50-53 | |
| 12 | 60-62 | 소유권(빌린 pane·H5)·02-kickoff 에 handle 기록·회수가 닫았다고 가정 금지 | 버림-중복 | IMPL:55-57 | |
| 13 | 66-69 | §3 일감 명세 항목: 기준 commit·**네이티브 설치 경로에서 최소 1회 실행**·**첫 단계로 LA 조회 결과(H4)**·관문 층. 뜻 바뀜: 「네이티브 실행 관문(validation.md)」참조·「트래커를 쓰면」 | 버림-중복 | IMPL:61-64 | |
| 14 | 70-72 | 시도·실패 기록 `raw/<도구>/worklog.md`·게이트 ② devlog 의 「LLM 관점」 재료. 뜻 바뀜: 「LLM 관점」→「LLM 절」(SKILL #87 의 devlog 구조 변경과 연동) | 버림-중복 | IMPL:65-67 | |
| 15 | 73-75 | 감독 워커 기동·pane 재사용/새 기동 하나만·재사용 인자 규칙 | 버림-중복 | IMPL:68-70 | |
| 16 | 76-79 | **재사용 배달 직전 — 그리고 pane 에 글을 넣는 모든 경우(질의 답 주입 포함) — 『화면 관측』을 따로 하고 입력줄이 비었는지 본다.** 읽기·주입 한 명령에 묶지 않음·글이 있으면 배달 않고 사용자에게 묻기·Claude Code 의 다음 입력 제안도 같이 묻기(Enter 만으로 제출 안 됨, 사용자가 제안이라 하면 『본문 주입』)·『화면 관측』 공백 매핑은 새 기동 (LIFE-724·683·745·746) — NEW 에서 통째로 빠짐(grep `입력줄` 은 supervised-worker.md:69 의 `input_line` 설명뿐) | 옮김-규칙 | .agents/rules/corral.md(신설) 또는 .agents/harness/corral/inject.md(『본문 주입』 매핑 소관) | **재사용 배달 직전 — 그리고 pane 에 글을 넣는 모든 경우(질의 답 주입 포함) — 『화면 관측』을 따로 하고 입력줄이 비었는지 본다.** 읽기와 주입을 한 명령에 묶지 않는다. 글이 있으면 배달하지 않고 그 글을 보여 사용자에게 묻는다(제안이 직전 코디 본문과 같은 문장이면 기록 대조로 갈음) — 배달이 덮어쓰면 사람이 쳐 둔 미제출 글은 복구할 길이 없다. Claude Code 가 입력줄에 그리는 다음 입력 제안도 화면으로는 같은 모양이므로 같이 묻는다(제안은 Enter 만으로 제출되지 않는다 — 사용자가 제안이라 하면 『본문 주입』으로 배달한다). 『화면 관측』이 공백인 매핑은 재사용 배달 대신 새 기동을 쓴다(LIFE-724·683·745·746). |
| 17 | 80-81 | 단계별 결과 읽고 기록·실패 단계 남은 자원 보고 | 버림-중복 | IMPL:71-72 | |
| 18 | 82-85 | 복구 2단(화면 관측·trust 는 사람 몫·재개/거절) | 버림-중복 | IMPL:73-76 | |
| 19 | 86-88 | 보존(retain)은 의사 기록·새 세션 인계 | 버림-중복 | IMPL:77-78 | |
| 20 | 88-90 | 수정 가능성 워커 보존·코드 리뷰는 리뷰어마다 새 세션·재리뷰는 새 세션·수정 최대 3회 | 버림-중복 | IMPL:79-81 | |
| 21 | 91-92 | 범위 변경 시 질의응답 대기·겹쳐 기동 금지 | 버림-중복 | IMPL:82-83 | |
| 22 | 93-94 | 경쟁 구현이면 **Codex 측은** 모델·effort 명시, **Codex 워커는 Claude보다 느리고 타임아웃이 잦으므로** 대기 예산 넉넉히. 뜻 바뀜: 「후보마다」·「느린 도구」로 일반화·defaults.rules.md 「경쟁 구현」 | 버림-중복 | IMPL:84-85, defaults.rules.md:91(경쟁 구현). Codex 특정 문장은 일반화됨(corral 의 지정 도구 Codex 는 defaults.md 몫) | |
| 23 | 98 | §4 끝난 모든 시도의 회수 확인 | 버림-중복 | IMPL:89 | |
| 24 | 99-102 | 사람이 만든 pane 보존(H5)·불확실하면 보존·두 번째 강제 종료 우회 금지 | 버림-중복 | IMPL:90-93 | |
| 25 | 103 | 재사용된 옛 시도 회수≠현재 워커 정리 | 버림-중복 | IMPL:94 | |
| 26 | 104-106 | 사용자 확인용 worktree 는 **출고 승인까지** 유지(「출고 승인 = PR 생성」)·task-finish.sh 정리·작업 브랜치는 원격 PR head. **뜻 바뀜: 「출고 승인」→「PR 생성 승인」** | 버림-중복 | IMPL:95-97 | |
| 27 | 107-109 | 부하 장치·측정 프로세스는 PID 기록 후 끈다·**출고 인계 전** 잔존 확인에 부모 launchd(PPID 1) 고아 포함·**「리뷰어가 건 부하 장치가 며칠 남아 뒤 작업 측정을 오염시킨 전례」**. 뜻 바뀜: 「출고 인계 전」→「인계 전」, 「launchd」→「init/launchd」, 전례 문장→「남은 부하 장치가 뒤 작업의 측정을 오염시킨다」. 근거 표기 빠짐(전례) | 버림-중복 | IMPL:98-100 | |
| 28 | 110 | 역할별 사용량은 도구가 제공하는 값만 기록 | 버림-중복 | IMPL:101 | |

---

#### 3. `.agents/rules/validation.md` (OLD 55줄 / NEW 59줄)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW 겹치는 위치 / 제안 목적지 | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| 1 | 3 | 작업 산출물이 `corral-specs/LIFE-NNN-*/` 에 파일로 존재(대화에만 있으면 미완). 뜻 바뀜: 경로 지정이 「파일·커밋으로 남아 있는가」로 일반화 | 버림-중복 | VAL:3 (산출물 경로는 VAL:47 이 별도로 명시) | |
| 2 | 4-6 | **네이티브 실행 관문**: 사용자 네이티브 설치 경로에서 최소 1회·격리/fixture 만으로 불인정·경량 경로도 1회 | 버림-중복 | VAL:8-10 | |
| 3 | 4-6 (구체) | NEW D5 슬롯(VAL:11-13) 이 요구하는 「네이티브 설치 경로」·「격리 실행」의 정의 — OLD 파일엔 구체값 없음(corral 값은 AGENTS.md·memory 의 설치본 `/Applications/corral.app` + `~/.local/bin/corral` shim, 격리 = 격리 herdr·Electron 인스턴스) | 옮김-슬롯 D5 | VAL:11-13 | (OLD validation.md 에 원문 없음 — adopt 가 AGENTS.md/memory 에서 채움) |
| 4 | 7-8 | 문서·스킬·규칙 일감의 1회·새 독자 리허설 | 버림-중복 | VAL:14-15 | |
| 5 | 9-12 | 판정표 7칸 형식 | 버림-중복 | VAL:16-19 | |
| 6 | 14-16 | 원장(H8ⓐ)·절대경로·`해당 없음 — <이유>`·빈칸 무효. 뜻 보강: 「원장이 없는 프로젝트는 `해당 없음 — 원장 없음`」 추가 | 버림-중복 | VAL:21-23 (H8ⓐ → contract.md:132) | |
| 7 | 17-19 | 실행 n/총 m(H8ⓑ)·실패 회차 원자료·통과 회차만 적기 무효 | 버림-중복 | VAL:24-26 (contract.md:137) | |
| 8 | 20-21 | 수정 라운드 누적 집계 | 버림-중복 | VAL:27-28 | |
| 9 | 22-27 | 분모 출처=명시 실행 목록·행 항목·요약 불인정·`미확정`·칸 값 세기·집계기 금지. 근거 표기 빠짐: 「(LIFE-440 에서 그 방식이 세 라운드 연속 회차를 빠뜨리고 실패를 통과로 셌다)」→「그런 집계기는 회차를 빠뜨리고 실패를 통과로 센다」 | 버림-중복 | VAL:29-34 | |
| 10 | 28-31 | 실행 없는 항목은 `해당 없음 — 문서 검사`·검사를 스크립트로 돌렸다면 실행 | 버림-중복 | VAL:35-38 | |
| 11 | 32-35 | 경량 경로 예외(2026-10-02, task-coordinate §3). 근거 표기 빠짐: 날짜 | 버림-중복 | VAL:39-42 | |
| 12 | 36 | 「다 됐다」 선언 전 실제 실행 결과 | 버림-중복 | VAL:4 | |
| 13 | 37 | **레이아웃을 옮기는 변경의 GUI 관문은 통과 회차도 캡처를 눈으로 본다** — 찾은 결함은 판정 항목으로 올리고 그 회차를 실패로 남김·캡처 없는 관문·화면 안 바꾸는 변경은 대상 아님 (LIFE-682·811) — NEW 에 없음(grep `캡처` 0건) | 옮김-규칙 | .agents/rules/corral.md(신설) | **레이아웃을 옮기는 변경의 GUI 관문은 통과 회차도 캡처를 눈으로 본다** — 찾은 결함은 판정 항목으로 올리고 그 회차를 실패로 남긴다. 캡처가 없는 관문(창 없는 serve·CLI·문서 일감)과 화면을 바꾸지 않는 변경은 대상이 아니다. (LIFE-682·811) |
| 14 | 38 | **사람 손·눈 확인 회차는 읽기 전용 기록기와 대조한 뒤 센다** — 보고가 기록과 어긋나면 그 회차 무효·기록기 못 켜면 시각을 박아 묻기·체감만 보는 칸은 기록을 보조로 (LIFE-781·808) — NEW 에 없음(grep `기록기` 0건) | 옮김-규칙 | .agents/rules/corral.md(신설) | **사람 손·눈 확인 회차는 읽기 전용 기록기와 대조한 뒤 센다** — 맡기기 전에 화면 상태(탭·포커스·대상 행·기록 파일 시각)를 읽기만 하는 기록기를 켜 두고, 보고가 기록과 어긋나면 그 회차를 무효로 적고 다시 받는다. 기록기를 못 켜는 도구는 시각을 박아 묻고, 체감만 보는 칸(타이핑 끊김 등)은 기록을 보조로만 쓴다. (LIFE-781·808) |
| 15 | 39-40 | **TUI idle·파일 존재·exit 0 을 완료로 대신하지 않는다**·완료는 『완료 감지』·공백 도구는 `보류` | 버림-중복 | VAL:5(TUI idle 명시는 「화면이 조용해진 것」으로 일반화), VAL:43 | |
| 16 | 41 | 스파이크는 「더 확인해도 알 수 없음」도 유효한 결론 | 버림-중복 | VAL:6 | |
| 17 | 42 | **프로세스를 끝내거나 살았는지 판정할 때 명령줄 패턴(`pgrep -f`·`pkill`)을 쓰지 않는다** — 띄울 때 받은 PID·zsh 함수 `&` 의 `$!` 는 서브셸·내가 띄우지 않은 프로세스는 정확한 패턴으로 PID 한 번 얻고 PID 로 봄·이름 훑기는 보조 (LIFE-575·813) — NEW 에 없음(grep `pgrep` 0건; reviewer.md:21 은 부하 장치 PID 기록뿐) | 옮김-규칙 | .agents/rules/corral.md(신설) | **프로세스를 끝내거나 살았는지 판정할 때 명령줄 패턴(`pgrep -f`·`pkill`)을 쓰지 않는다** — 띄울 때 받은 PID 로 하고 그 PID 가 정말 대상인지 확인한다(zsh 에서 함수를 `&` 로 띄우면 `$!` 는 서브셸이다). 내가 띄우지 않은 프로세스는 정확한 패턴(끝 고정·인자 허용)으로 PID 를 한 번 얻고 그 뒤엔 PID 로 본다. 이름으로 잔존을 훑는 것은 PID 확인의 보조로만 쓴다. (LIFE-575·813) |
| 18 | 44 | 절 제목 「원자료 보관 (2026-10-05)」. 근거 표기 빠짐: 날짜 | 버림-중복 | VAL:45 | |
| 19 | 46 | 원자료는 corral-specs 에만·코드 레포 커밋 금지·「커밋한다」는 specs 커밋. 근거 표기 빠짐: 2026-10-26 LIFE-705 | 버림-중복 | VAL:47 (「산출물 레포」 표기) | |
| 20 | 47 | 커밋한다: 판정표·reviews.md·실행 목록이 가리키는 회차의 원자료·실패 회차 전부 | 버림-중복 | VAL:48 | |
| 21 | 48-50 | 커밋하지 않는다 ① 사용자 데이터 사본: 작업 폴더 밖에 두고 경로·해시만·원복 해시 통과·사용자 확인 후 삭제. **뜻 바뀜: 「작업 출고 때」→「작업이 끝날 때」(출고→작업 종료)**, 목록 구체(`userData·herdr·provider 설정 백업`)는 「이 프로젝트의 목록은 아래」 슬롯로 위임 | 버림-중복 | VAL:50-52 (본문) | |
| 22 | 49 | 사용자 데이터 사본의 corral 구체 목록: `userData·herdr·provider 설정 백업` | 옮김-슬롯 D6 | VAL:53-55 (D6 슬롯) | 사용자 데이터 사본(userData·herdr·provider 설정 백업). |
| 23 | 51 | 재생 가능한 산출물(빌드 결과·`node_modules`·설치본 사본) | 버림-중복 | VAL:56 (`node_modules`→「의존성 폴더」 일반화) | |
| 24 | 52 | 판정 회차 아닌 구현 중 반복 실행·원인 증명·양성 대조는 판정 회차·애매하면 커밋 | 버림-중복 | VAL:57 | |
| 25 | 53 | 시크릿: 환경변수 덤프는 키 이름만·「(`env`·`printenv`·`LC_ALL` 변이 로그 등)」·**LIFE-637 raw 에 실제 키 모양 값이 커밋된 전례** — 근거 표기·예시 `LC_ALL` 빠짐 | 버림-중복 | VAL:58 (근거 표기 빠짐: LIFE-637) | |
| 26 | 54-55 | 크기 경보 5MB/50MB·verdict.md 에 사유 한 줄. 근거 표기 빠짐: 「기준 실측 2026-10-05: git pack 전체 307MB, 작업당 원자료 13~21MB(493·494·496), 예외 LIFE-373 548MB」 | 버림-중복 | VAL:59 (기준 실측 수치는 빠짐 — 판정 규칙 아님) | |

---

#### 4. 「옮김」 행 요약

파일별 개수 (행 번호는 위 표 기준)

| 파일 | 옮김-슬롯 | 옮김-규칙 | 합계 | 뜻 바뀜 표시 행 수 |
| --- | --- | --- | --- | --- |
| task-coordinate/SKILL.md | 7 (D13: #7·#15·#16b / D7: #30a / D8: #37·#39·#41 / D6: #46 / D15: #84 — 단 #84 는 OLD 에 원문 없음이라 실제 옮길 원문 6개) | 12 | 19 | 24 |
| task-coordinate/references/implementation.md | 3 (D9: #6b·#6c, 6d 는 규칙) → 슬롯 2 | 2 (#6d·#16) | 4 | 6 |
| rules/validation.md | 2 (D5: #3 — OLD 원문 없음 / D6: #22) → 실제 원문 있는 슬롯 1 | 3 (#13·#14·#17) | 5 | 3 |

정리: 원문이 실제로 있는 「옮김」 행만 세면 SKILL 슬롯 6 + 규칙 12 = 18, IMPL 슬롯 2 + 규칙 2 = 4, VAL 슬롯 1 + 규칙 3 = 4. (D5·D15 는 OLD 에 원문이 없어 AGENTS.md·memory 에서 채울 자리이며 옮김이 아니라 확인 대상.)

### 옮김 목록

SKILL.md
- 슬롯 D13: #7(grok-search 본문 읽기 확인), #15(외부 서치 = grok·코디 자체 서치 선행), #16b(조건 예시 git·herdr·provider CLI 동작)
- 슬롯 D7: #30a(빠른 확인·최종 관문 구분)
- 슬롯 D8: #37(경량 범주 4종), #39(PTY·herdr… 전체로 올리는 것), #41(출고 스크립트를 「전체로 올리는 것」에)
- 슬롯 D6: #46(default 세션·소켓)
- 슬롯 D15: #84(OLD 원문 없음 — 확인 대상)
- 규칙 → corral.md: #20(00-analysis-grok.md 파일명, 사용자 결정), #23(design-brief/design-intake), #25(소비자 열거), #26(지연·경합 횟수), #27(관측 대상 동결), #30b(문서·스킬 빠른 확인), #47(헤드리스 script(1)), #52(게이트 ⓪ 보고의 디자인 브리프 항목), #66b(첫 리뷰어 직전 전이 확인), #72b(수정 diff 정독 시 정의 자리 대조), #75(final 태그 이름, 사용자 결정), #87(devlog 세 관점·회고 절, 사용자 결정)
- 규칙 → 매핑: #89(.agents/harness/corral/session-start.md — Codex 코디 transcript 한계)
- 규칙 → release 스킬/D17: #97(릴리즈 노트가 pr.md 재료), #103(출고 권고·「출고 대기」 보고), #105(출고 = release 스킬 몫 정의), #106(브랜치 dmg·APK 는 dev 빌드)

implementation.md
- 슬롯 D9: #6b(worktree 경로로 소스·의존성 읽는 법), #6c(`app/scripts/<하는 일>/`)
- 규칙 → corral.md(또는 learnings/testing.md): #6d(옛 일감 하네스 LIFE-717 재현 안내)
- 규칙 → corral.md(또는 harness/corral/inject.md): #16(재사용 배달 직전 입력줄 확인)

validation.md
- 슬롯 D6: #22(userData·herdr·provider 설정 백업)
- 슬롯 D5: #3(OLD 원문 없음 — 확인 대상)
- 규칙 → corral.md: #13(GUI 레이아웃 캡처), #14(사람 손·눈 확인 기록기), #17(pgrep/pkill 금지·PID)

### 뜻 바뀜 목록 (사용자 결정 필요 우선)
1. SKILL #20 외부 서치 원문 파일 이름 `00-analysis-grok.md`→`00-analysis-search.md`
2. SKILL #75·#101 구현 HEAD 태그 `LIFE-NNN-<도구>-final`→`LIFE-NNN-<슬러그>-<도구>-final`(및 task-finish 의 `LIFE-NNN-*-final`→`LIFE-NNN-<슬러그>-*-final`)
3. SKILL #87 devlog 세 관점+회고 절 → 두 절
4. SKILL #83·#86·#93·#94·#95·#103·#105, IMPL #26, VAL #21 「출고 승인」→「PR 생성 승인」, 「출고 대기」 보고 삭제, 완료 전이 주체 release→task-close
5. SKILL #2·#13·#54·#63 LA→트래커 전이(상태 이름은 task-start D3)
6. SKILL #41 「출고·PR·정리 스크립트」→「배포·PR·정리 스크립트」
7. SKILL #89 Codex 코디 transcript 한계 문장 삭제

### 전수 C

#### plan-C — OLD(corral) vs NEW(paddock 렌더) 전수 대조: task-start · bundle.md · task-pr.sh · task-finish.sh

OLD = <대상>/<경로>, NEW = .../paddock-adopt.PRr214/out/<경로> (아래 NEW 줄 번호는 out/ 기준).
판정: 버림-중복 / 옮김-슬롯 Dn / 옮김-규칙. 「뜻 바뀜」 표시는 판정 칸에 병기.
out/ 전체 grep 결과: out/ 에 release 스킬은 없다(OLD 레포의 .agents/skills/release/SKILL.md 가 그대로 남는다고 가정). `herdr session`·`life<NNN>` 문자열은 out/ 어디에도 없다.
NEW 슬롯 위치: D3 = task-start :36-39(일감 읽기) · :110-113(상태 전이), D6 = task-coordinate/SKILL.md :135-137, D15 = 같은 파일 :262-264, D16 = task-close/SKILL.md :59-63, D17 = task-close/SKILL.md :18-20.

---

#### 1. .agents/skills/task-start/SKILL.md (OLD 134줄 → NEW 151줄)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW 겹치는 위치 / 제안 목적지 | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| 1 | 1-7 | frontmatter description(LIFE-N 시작·묶음 자식은 묶음 코디가) | 버림-중복 | SKILL.md:1-9(설명 재서술), :13(묶음 자식 문장) | |
| 2 | 9 | 제목 「본체 세션에서, 묶음 자식은 묶음 코디가 실행」 | 버림-중복 | :11, :13 | |
| 3 | 11-12 | 도구 명령 없음·매핑 선택·00-start 에 매핑 기록 | 버림-중복 | :15-16 | |
| 4 | 16-17 | 신규는 지정 도구, 미지정 기본 claude | 버림-중복(조건: defaults.md 표 채움 — 행 38 참조) | :20-22 | |
| 5 | 18-19 | 기존 작업은 00-start.md(절대경로) 먼저·미지정 재개는 기록 따름 | 버림-중복 | :23-24 | |
| 6 | 20-22 | 선택 불일치·claude·codex 외 도구 요청 시 새 터미널 금지·동시 두 코디 금지 | 버림-중복 | :25-27 | |
| 7 | 23-27 | 코디 선택과 워커·리뷰어 구성 별개, 단독 구현→리뷰, 기본 구성 무질문 적용 | 버림-중복 | :28-32 | |
| 8 | 31 | 1단계: life-assistant MCP `issue_by_seq` 로 LIFE-N 본문 읽기 | 옮김-슬롯 D3 | :36-39 (D3 슬롯 1) | life-assistant MCP `issue_by_seq`로 LIFE-N 본문을 읽는다. |
| 9 | 32-34 | git status·worktree list·도구 실행 가능 확인·매핑 고르고 『전제 점검』·제어 런타임/LA 없으면 보고, 몰래 대체 금지 | 버림-중복(「LA가 없으면」→「일감 트래커를 읽을 수 없으면」) | :40-43 (묶음 코디 ROOT 안내 :42) | |
| 10 | 35-38 | 전제 점검 불일치 시 멈춤·공백 처리·env 마커 조건 | 버림-중복 | :44-48 (NEW 에 「레포 미등록 승인」 :46 추가) | |
| 11 | 39-40 | corral-specs 존재·코드 레포+specs hooksPath=.githooks·gitleaks PATH | 버림-중복 | :49-51 | |
| 12 | 41 | 슬러그 케밥 1~3단어·기존 슬러그 재사용 | 버림-중복 | :52 | |
| 13 | 42-49 | 2단계 분기 기준: 독립 작업(main)/묶음 자식(feature 에서, 묶음 코디가 시작, 게이트 ② 는 feature 로 로컬 merge)·LA 부모가 checkpoint 라는 것만으로 묶음 자식 아님 | 버림-중복 | :53-60 (「LA 부모→트래커 부모」 용어만) | |
| 14 | 50-53 | 체크포인트 시작: feature 만들고 push·feature worktree 가 묶음 코디 worktree·만료일 기본 +2주·「LA kind 가 checkpoint」·재오픈 사례가 「출고 중 수정으로 정리된 feature worktree」 | 버림-중복 + **뜻 바뀜**(재오픈 사유 「출고 중 수정」→「PR 을 연 뒤 수정」) | :61-64 | |
| 15 | 55-57 | bash: feature 브랜치 생성·push 블록 | 버림-중복 | :66-68 | |
| 16 | 58-59 | worktree 는 본체 기준 절대경로(중첩 금지) | 버림-중복 | :69-70 | |
| 17 | 60-65 | bash: ROOT·fetch·worktree add(독립·자식 한 줄, feature worktree 한 줄) | 버림-중복(NEW 는 독립/자식을 3줄로 분리, 동작 동일) | :71-77 | |
| 18 | 66-70 | 묶음 자식 생성 직후 상위를 feature worktree 로 지정(LIFE-576 D7 과 같은 규칙), corral 매핑 = `worktree set --worktree path:… --parent-worktree path:…`, 실패는 경고만 | 버림-중복 (근거 표기 빠짐: LIFE-576 D7) | :78-81, 명령은 .agents/harness/corral/supervised-worker.md:32,36 | |
| 19 | 71-73 | 재개: 기존 worktree·활성 코디 이어감, 정리 끝난 묶음 코디 세션은 활성 아님 | 버림-중복 | :82-85 | |
| 20 | 74-75 | 3단계 00-start.md 를 corral-specs 에 커밋·push, 작업 worktree 에 산출물 두지 않음 | 버림-중복 | :86-87 | |
| 21 | 76-77 | 00-start 최소 항목(LIFE-N·슬러그·브랜치·분기 기준·절대경로·산출물 폴더 절대경로·코디 도구·선택 근거) | 버림-중복 | :88-90, :96 | |
| 22 | 78-81 | 모델·effort 기본값(claude → claude-opus-5-5 high, codex → gpt-6-astra high, 2026-09-29), codex 카탈로그 확인·「Codex 사용 불가 시 자동 전환」·「운영 규칙」 | 옮김-슬롯(defaults.md 역할 기본값 표 — 이 4파일 밖) + 나머지는 버림-중복 | 절차 :90-93 (agent-tools.md·defaults.rules.md 로 이동). 값은 out/.agents/defaults.md:14-23 표가 비어 있다 — adopt 가 채워야 한다 | claude → `claude-opus-5-5` high, codex → `gpt-6-astra` high, 2026-09-29 |
| 23 | 81-83 | 처음 상태 `기동 전`·워커 구성·경량/전체 지정·수정 라운드용 워커 유지 기록 | 버림-중복 | :94-97 | |
| 24 | 84-86 | 체크포인트 시작이면 00-start 에 묶음 표시·분해 상태·이미 시작된 자식·구현 워커/리뷰어 안 적음, 6단계 전달 전 커밋 | 버림-중복 | :98-100 | |
| 25 | 87-95 | 4단계 세션 기동·모델·effort 명시·advisor 불가 기록·handle·세션 기록 경로(「corral 매핑은 지금 Claude 만」)·포커스 전환 | 버림-중복 | :101-109, corral 사실은 .agents/harness/corral/session-start.md:12-13 | |
| 26 | 96-99 | 5단계 LA: `issue_transition` → `진행 중`, 코디가 먼저 전진했으면 same/backward 존중, 부모가 checkpoint 면 함께 onBoard·`진행 중`(project 는 적용 안 함), 종료 때 부모 완료는 미완 자식 확인 | 옮김-슬롯 D3(상태 전이) + 공통 문장은 버림-중복 | :110-117(공통 문장 :114-117, LA 고유부는 D3 슬롯 :111-113 자리) | 시작 세션이 `issue_transition` → `진행 중`을 요청한다. 부모가 checkpoint이면 함께 온보드(`issue_update` onBoard:true)하고 `진행 중`으로 전이하되 project이면 적용하지 않는다. |
| 27 | 100 | 체크포인트 시작이면 그 일감 자체를 `진행 중`·온보드(부모 project 는 적용 안 함) | 옮김-슬롯 D3(상태 전이) | :117 「체크포인트 시작이면 그 체크포인트 일감 자체를 전이한다」 + D3 슬롯 :111-113 | 체크포인트 시작이면 그 체크포인트 일감 자체를 `진행 중`으로 전이하고 온보드한다(부모 project 는 적용하지 않는다). |
| 28 | 102-110 | 6단계 준비 대기·trust/로그인 사람이 치움·킥오프 전달 전 커밋(2026-09-27 LIFE-440 사례) | 버림-중복 (근거 표기 빠짐: 2026-09-27 LIFE-440 에서 실제로 났다) | :118-126 | |
| 29 | 111-113 | 『본문 주입』 한 번만·**배달 확인값을 `00-start.md` 에 기록**·배달 증명 공백이면 사람 확인 시각 | 버림-중복 + **뜻 바뀜**(기록처 00-start.md → 작업 폴더 `delivery.md`, 커밋 안 함, 코디가 다음 커밋에 포함) | :127-129 | |
| 30 | 114-122 | 킥오프 지시문 2종(코디·묶음 코디) | 버림-중복(`<corral-specs 절대경로>`→`<산출물 루트 절대경로>`) | :130-138 | |
| 31 | 123-124 | 전달 후 00-start·폴더·브랜치는 코디 소유, 시작 세션 수정 금지 | 버림-중복 + **뜻 바뀜**(시작 세션은 `delivery.md` 만 예외로 씀) | :139-140 | |
| 32 | 126-132 | 기동 실패·재개(타임아웃은 지연일 수 있음·포커스·수치 상한은 매핑) | 버림-중복 (NEW 에 `delivery.md` 없다고 미배달 단정 금지 :147 추가) | :142-149 | |
| 33 | 133-134 | 시작 세션은 지휘 안 함, **출고 승인(= PR 생성) 뒤 코디가 PR 열고 정리**, **본체 세션은 출고(`release.sh` cut·gather·ship — release 스킬) 때 돌아온다(task-coordinate §8)** | 옮김-슬롯 D17 + **뜻 바뀜**(출고 승인→PR 생성 승인, 본체 복귀 계기 출고→머지 뒤 마무리 task-close) | :150-151 는 「머지 뒤 마무리(`task-close`)」로 대체됨. release 흐름은 task-close D17 슬롯(:18-20)에 | 본체 세션은 출고(`release.sh` cut·gather·ship — release 스킬) 때 돌아온다(task-coordinate §8). |

task-start 옮김 개수: 4 (D3 ×3 [행 8·26·27 — 같은 두 슬롯에 들어감, 문장 3개], D17 ×1[행 33]) + 밖 1(행 22 defaults.md 값). 뜻 바뀜: 3(행 14·29·31) + 행 33 = 4.

---

#### 2. .agents/skills/task-coordinate/references/bundle.md (OLD 113줄 → NEW 120줄, NEW 는 `paddock:fixed` — 슬롯 없음)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW 겹치는 위치 / 제안 목적지 | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 제목 | 버림-중복 | :1-2 | |
| 2 | 3-5 | 원본은 이 파일 하나·묶음 코디 정의·한 묶음 코디 하나 | 버림-중복 | :4-6 | |
| 3 | 6 | 재개 규칙: 마지막 상태+feature PR 유무, **PR 열림이면 6 의 「출고 중 수정」** | 버림-중복 + **뜻 바뀜**(절 이름 「출고 중 수정」→「열린 묶음 PR 수정」) | :7-8 | |
| 4 | 7 | 작업 폴더 corral-specs/LIFE-MMM-<슬러그>/ | 버림-중복 | :9 (`<본체>/../corral-specs/`) | |
| 5 | 9-10 | 도구 명령 없음·SendMessage 는 claude↔claude 보조 | 버림-중복 | :11-12 | |
| 6 | 12-22 | 1절: task-coordinate 중 무엇을 따르나(표 5행) | 버림-중복 | :14-24 (표 동일) | |
| 7 | 24-26 | LA 전이: `진행 중`은 task-start 5단계 실행한 쪽, 자식 전이 `분석 중`·`개발 중`·`검증 중`은 자식 코디, **`완료` 는 출고(release §7)**, 체크포인트 자신은 `진행 중` | 버림-중복(전이 주체·체크포인트 유지) + 옮김-슬롯 D17 + **뜻 바뀜**(완료 전이 주체 release §7 → task-close 6단계) | :26-29 | 체크포인트·자식의 `완료` 는 출고(release §7)다. |
| 8 | 28-43 | 2절 분해(분해 전일 때만·게이트 ⓪·자식 0/1개·독립 자식 묶음 밖·`분해 끝` 재분해 금지·02-breakdown 없으면 만듦) | 버림-중복 | :31-46 | |
| 9 | 45-48 | 3절 자식 task-start 는 묶음 코디가(분기 origin/feature·상위 feature worktree) | 버림-중복 | :48-51 | |
| 10 | 49-50 | worktree 는 task-start 2단계 블록 그대로 본체 기준 절대경로 | 버림-중복 | :52-53 | |
| 11 | 51-52 | 자식 00-start 는 묶음 코디가 쓰고 전달 전 커밋, 이후 자식 코디 것 | 버림-중복 (NEW 는 예외로 `delivery.md` 추가 :56) | :54-56 | |
| 12 | 53-54 | 자식 00-start 에 묶음 코디 연락처·시작 순서 `02-breakdown.md` | 버림-중복 | :57-58 | |
| 13 | 58 | 게이트는 자식 코디가 사용자에게 직접 | 버림-중복 | :62 | |
| 14 | 59 | 조율: 겹치는 파일·반영 순서·**네이티브 관문 직렬**(설치본·사용자 런타임을 쓰는 관문은 한 번에 한 자식) | 옮김-슬롯 D6 + **뜻 바뀜**(corral 고유 「설치본·사용자 런타임」 표현 사라지고 「task-coordinate §3 격리 규칙의 직렬 자원」을 가리킴) | :63 → 가리키는 곳 task-coordinate/SKILL.md D6 슬롯 :135-137(빈 슬롯) | 설치본·사용자 런타임을 쓰는 관문은 한 번에 한 자식 |
| 15 | 60 | 자식 세션 상태는 『화면 관측』(bare 에서도 유일한 관측 수단) | 버림-중복 | :64 | |
| 16 | 62 | claude↔claude 는 SendMessage·주소는 세션 이름 | 버림-중복 | :66 | |
| 17 | 63-65 | **codex 가 끼면** SendMessage 공백·『본문 주입』 한 줄·항목 번호·시각 | 버림-중복(「codex 가 끼면」→「한쪽이라도 claude 가 아니면」, 일반화) | :67-69 | |
| 18 | 66-69 | 통로 공백 방향은 사람이 전달(자식→묶음, 본체→묶음, 묶음→본체: 「6 의 출고 중 수정 반영」) | 버림-중복 + **뜻 바뀜**(「6 의 출고 중 수정 반영」→「6 의 열린 묶음 PR 수정 반영 통지」) | :70-74 | |
| 19 | 70 | 보장 수준: 배달=『본문 주입』 수준, corral 은 그 pane 이 소유한 세션 기록 있을 때만 배달 증명, bare 는 주입·완료 감지 공백 | 버림-중복 | :75 (일반화), corral 사실 .agents/harness/corral/inject.md:11, 00-mapping.md:56, bare 사실 capabilities.md:18,63 | |
| 20 | 71-77 | 반영 알림(`--into` 직전 알림=반영 시작·원격 feature 가 HEAD 와 다르면 반영·bash ls-remote) | 버림-중복 | :76-82 | |
| 21 | 78 | 자식 폴더 고칠 일은 자식 코디에게 알림 | 버림-중복 | :83 | |
| 22 | 80-88 | 5절 feature worktree 따라가기(pull --ff-only·main merge·rebase 금지) | 버림-중복 | :85-93 | |
| 23 | 90-92 | 6절 머리: 자식 코디는 자기 정리까지, 그 뒤는 묶음 코디 | 버림-중복 | :95-97 | |
| 24 | 94-95 | 6.1 묶음 통합 확인(빌드·실행·`01-criteria.md` 묶음 기준·사용자에게 실행 방법 한 줄) | 버림-중복 | :99-100 (실행 방법은 D15 슬롯 task-coordinate/SKILL.md:262-264) | |
| 25 | 96-97 | 6.2 verdict.md·pr.md·handoff-main.md(PR base main·실린 자식·**LA 다음 전이**)·**「출고 회고(release §4)는 이 verdict.md 의 자식 판정 링크로 자식 폴더를 찾는다」** | 버림-중복(앞부분은 :101-102, 「LA→트래커」 용어; NEW 는 handoff 에 머지 뒤 확인·필수 후속 항목 추가) / 「출고 회고」 문장은 release 스킬에 이미 있음 | :101-102 / OLD 레포 .agents/skills/release/SKILL.md:54(같은 뜻 보유) — out/ 에는 없음 | (release 스킬 :54 에 이미 있으므로 새로 쓸 필요 없음) |
| 26 | 98 | 6.3 **⛔ 출고 승인 게이트**(PR 생성 전), 승인 뒤 묶음 폴더 커밋·push·`scripts/task-pr.sh feature/…` | 버림-중복 + **뜻 바뀜**(출고 승인→PR 생성 승인) | :103-105 | |
| 27 | 99-105 | 6.4 정리까지(task-finish 는 feature worktree 안 거절·본체에서 실행·남은 자식 있으면 멈춤·`push -u`/`--no-track` 한계 안내·멱등) | 버림-중복 | :106-112 | |
| 28 | 106-107 | 보고 「PR 생성·정리 완료, **출고 대기**」·**「묶음 코디의 수명은 여기까지다 — 출고는 본체(release)」** | 옮김-슬롯 D17 + **뜻 바뀜**(출고 대기 삭제, 「머지와 머지 뒤 마무리는 task-close」) | :113-114 | 묶음 코디의 수명은 여기까지다 — 출고는 본체(release). |
| 29 | 108-110 | 6.5 **출고 중 수정**(release §2): 본체가 feature worktree 다시 열고 묶음 코디 재기동·로컬 feature 없어도 원격에서 추적 브랜치 | 버림-중복 + **뜻 바뀜**(release §2 참조·「출고 중」 → 「머지 전 열린 PR 수정」) | :115-117 | |
| 30 | 111 | 정리 마친 옛 묶음 코디 세션은 쓰지 않음·『회수·정리』로 닫고 새로 기동 | 버림-중복 | :118 | |
| 31 | 112-113 | 수정 자식 시작·반영·feature push·verdict 링크·handoff 실린 자식 갱신 후 본체에 알림 — **「본체가 같은 PR 을 다시 `gather` 한다」** | 옮김-슬롯 D17 + **뜻 바뀜**(gather → 「push 로 같은 PR 이 갱신된다」) | :119-120 (release SKILL.md:39-40 이 gather 를 이미 말함 — 그 스킬이 D17 이 가리키는 곳이면 중복) | 본체가 같은 PR 을 다시 `gather` 한다. |

bundle.md 옮김 개수: 4(행 7·28·31 = D17, 행 14 = D6). 뜻 바뀜: 8(행 3·7·14·18·26·28·29·31).
release 스킬 → bundle.md 참조(:39-40·54·115)는 절 번호 `6` 로만 가리켜 NEW 에서도 유효하다. 단 :39-40 「출고 중 수정 = bundle.md 6」 은 NEW 6.5 의 제목·본문과 용어가 어긋난다(release 가 gather 를 직접 설명하므로 기능 문제는 없음).

---

#### 3. scripts/task-pr.sh (OLD 119줄 → NEW 164줄)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW 겹치는 위치 / 제안 목적지 | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| 1 | 2-12 | 사용법·옵션(--base/--pr/--verdict/--draft)·흐름 주석 | 버림-중복 | :3-15 | |
| 2 | 3 | 「게이트 ② 출고 승인 = PR 생성 (LIFE-574). 머지는 하지 않는다 — **머지는 출고 때 scripts/release.sh 만 한다**」 | 옮김-규칙 release 스킬/D17(주석 소실) + **뜻 바뀜**(출고 승인→PR 생성 승인) | :4 「PR 생성 승인 뒤 PR 을 연다. 머지는 하지 않는다.」 | 머지는 출고 때 scripts/release.sh 만 한다. |
| 3 | 9, 46-49 | corral-specs 위치: 기본 본체 옆 폴더, **`CORRAL_SPECS` 환경변수로 변경**, 폴더·git 레포 확인 | 버림-중복(`SPECS_ROOT`(.paddock/config.sh:9)가 대체; env 오버라이드는 NEW 에서 사라짐 — 레포 내 다른 사용처 없음) | :74-80 (메시지 「corral-specs 폴더 없음」→「산출물 폴더 없음」) | |
| 4 | 15-31 | die/note·인자 파싱·`head 와 base 가 같다`·`main 은 head 가 될 수 없다` | 버림-중복(`main`→`$BASE_BRANCH`) | :18-19, :43-59 | |
| 5 | 33-39 | REPO = git 공통 디렉터리에서 역산·`cd` | 버림-중복 | :21-26, :64 | |
| 6 | 40-45 | SPEC_ID=feature/ 뗀 이름·LIFE 번호 추출(「LIFE 번호를 못 찾음」)·기본 verdict/pr 경로 | 버림-중복 | :65-73 (메시지는 `$ISSUE_PREFIX` 치환 = 동일 문구) | |
| 7 | 50-55 | 원고·판정문이 corral-specs 에 커밋돼 있어야 함 | 버림-중복 | :81-87 (`doc_ready`, specs-repo 모듈 조건) | |
| 8 | 57-72 | 0. 상태 파악(fetch·로컬 브랜치·원격 base·미커밋 거절·판정문·작업 폴더 전체 커밋·새 커밋 존재) | 버림-중복 (근거 표기 없음) | :89-106 | |
| 9 | 74-79 | PR 원고 첫 줄 `# 제목`·본문 필수 | 버림-중복 | :108-113 | |
| 10 | 81-84 | corral-specs push·작업 브랜치 `push -u`·원격=로컬 확인 | 버림-중복 | :115-120 | |
| 11 | 87 | 제목에 LIFE 번호 접두 | 버림-중복 | :123-125 | |
| 12 | 94 | 본문 「판정문: corral-specs `$VERDICT` (private — 링크 없음)」 | 버림-중복 (「private」 낱말 빠짐) | :133 | |
| 13 | 95 | 본문 「head … → base … **— 머지는 출고 때 `scripts/release.sh` 로만 한다**」 | 옮김-규칙 release 스킬/D17 + **뜻 바뀜**(문장 삭제) | :137 은 head/base 만 | 머지는 출고 때 `scripts/release.sh` 로만 한다 |
| 14 | 97 | 본문 서명 「🤖 Generated with [Claude Code](https://claude.com/claude-code)」 | 옮김-규칙(.paddock/config.sh `PR_FOOTER`) | NEW :138-141 은 `PR_FOOTER` 가 비어 있으면 출력 안 함 — out/.paddock/config.sh:13 `PR_FOOTER=""` 라서 서명이 **사라진다** | `PR_FOOTER="🤖 Generated with [Claude Code](https://claude.com/claude-code)"` |
| 15 | 100-113 | 같은 head 열린 PR 재사용/여럿이면 멈춤/base 불일치 멈춤/없으면 생성(--draft) | 버림-중복 | :144-157 | |
| 16 | 115 | 완료 출력 `✔ head → base : URL` | 버림-중복 | :159 | |
| 17 | 116-119 | `□ 다음` 안내: 묶음·작업 정리는 task-finish.sh(묶음 코디 마지막 실행)·**머지·태그·dmg·APK 는 출고 때 scripts/release.sh** | 버림-중복(task-finish 안내) / 옮김-규칙 release 스킬/D17(release.sh 안내 삭제) + **뜻 바뀜**(NEW 는 「PR 을 머지한 뒤 …정리는 task-finish.sh」 로 정리 시점을 머지 뒤로 안내 — 같은 NEW 의 bundle.md:106-113·task-finish.sh:186 은 PR 생성 **직후** 정리라 NEW 끼리 모순) | :160-164 | 머지·태그·dmg·APK 는 출고 때 scripts/release.sh |
| 18 | — | NEW 에만 있는 동작·가드 | (NEW 전용) | :28-41 `.paddock/config.sh` 필수(없으면 die) · :43-62 bundle 모듈 꺼진 프로젝트에서 묶음 브랜치 거절 · ISSUE_PREFIX 빈 모드(ID 접두 없음) · :116-118 specs-repo 모듈일 때만 산출물 레포 push · :164 task-close 안내 | |

task-pr.sh 옮김 개수: 3(행 2·13·17 = 출고 문구 → release/D17, 사실상 한 문장군) + 1(행 14 = config.sh PR_FOOTER) = 4 행(서로 다른 목적지 2곳). 뜻 바뀜: 4(행 2·13·17, 안내 모순).

---

#### 4. scripts/task-finish.sh (OLD 285줄 → NEW 313줄)

| # | OLD 위치 | 덩어리 요지 | 판정 | NEW 겹치는 위치 / 제안 목적지 | 옮길 원문 |
| --- | --- | --- | --- | --- | --- |
| 1 | 2-9 | 사용법·기본/--into/feature 모드 설명·「작업 정리 — worktree·로컬 브랜치·**격리 herdr 세션**」·「main 반영은 출고 때 release.sh 가 PR 머지로만」 | 버림-중복(모드 설명 :3-10) + **뜻 바뀜**(「격리 herdr 세션」→「세션 정리 훅」, release.sh 언급 삭제) | :3-10 | |
| 2 | 11-14 | 2026-09-14 (LIFE-357 인계 §3-①) 변형 브랜치 접두 매칭 일반화·-claude/-codex 강제 삭제·그 외 변형은 조상 확인 | 버림-중복 (근거 표기 빠짐: 2026-09-14 LIFE-357 인계 §3-①) | :14-16 | |
| 3 | 17-25 | 인자 파싱·`--into`·모르는 옵션 exit 1·사용법 | 버림-중복(사용법 문구가 모듈에 따라 생성됨) | :46-56 | |
| 4 | 26-31 | REPO = 스크립트 위치 git 공통 디렉터리에서 역산 | 버림-중복 | :24-29 | |
| 5 | 32 | `WT="$REPO/.claude/worktrees"` | 버림-중복(config WORKTREE_DIR) | :38,57; .paddock/config.sh:6 | |
| 6 | 33 | `NNN` = TASK 의 LIFE 번호(herdr 세션 접두용) | 옮김-슬롯 D16(행 22 와 한 묶음) | NEW 에서 변수 자체가 사라짐 | (행 22 참조) |
| 7 | 35-40 | die·note·is_throwaway(-claude/-codex)·has_local·has_remote | 버림-중복 | :21-22, :64-66; VARIANT_SUFFIXES=.paddock/config.sh:12 | |
| 8 | 42-53 | finish_feature 머리 주석(LIFE-724: PR→보존 위치→깨끗함→자식 0→정리, 자식 정의 ⓐⓑ·한계 두 가지·잔해 폴더 한계) | 버림-중복 (근거 표기 빠짐: LIFE-724) | :68-79 | |
| 9 | 54 | herdr 격리 세션 정리는 안 한다(묶음 코디는 워커 안 띄움·체크포인트 번호 접두 매칭은 자식 세션 오탐) | 버림-중복(「세션 정리 훅은 부르지 않는다」) | :80 | |
| 10 | 57-58 | guard f-name(`feature/LIFE-<번호>-<슬러그>` 꼴)·f-into | 버림-중복 | :83-85 (정규식은 ISSUE_PREFIX·BUNDLE_PREFIX 로 생성 — 동일 결과) | |
| 11 | 59-63 | FWT 경로·guard f-cwd(「feature worktree 안에서 실행 금지」)·cd·guard f-fetch | 버림-중복 + 메시지 변경(**「feature worktree」→「묶음 worktree」**, 시험이 grep) | :86-90 (:88 문구) | |
| 12 | 65-87 | PR 조회 guard f-gh·f-nopr·f-state·f-base-open·f-base-merged·f-ahead·f-remote-ahead·보존 위치 KEEP | 버림-중복 | :92-114 | |
| 13 | 89-108 | feature worktree 검사: f-main·f-cwd-wt·f-wt-head·f-dirty·f-specs(`specs/` 파일 있으면 멈춤) | 버림-중복(f-specs 는 specs-repo 모듈일 때만, 문구 「corral-specs 작업 폴더」→「산출물 레포의 작업 폴더」) | :116-136 | |
| 14 | 110-132 | 남은 자식 검사: ⓐ upstream ⓑ 고유 커밋·f-release(`main`·`PR_BASE`·`release/*`·`feature/*` 제외)·f-up·f-child-detached·f-child-wt·f-child-branch | 버림-중복(`main`→`$BASE_BRANCH`, `feature/*`→`$BUNDLE_PREFIX*`, `release/*` 는 그대로) | :138-160 | |
| 15 | 134-147 | 정리: guard f-no-force·f-wt-remove·f-prune·f-cas(update-ref 구 값 비교)·branch 설정 지움 | 버림-중복 | :162-175 | |
| 16 | 148-153 | MERGED 이면 원격 feature 삭제(`--force-with-lease` f-lease·f-remote-del), 주석 「release.sh ship 이 대개 먼저 지운다」 | 버림-중복(주석 「머지 쪽이 대개 먼저」) | :176-181 | |
| 17 | 155-156 | 「정리할 것 없음 — 이미 정리됨」·`✔ … 정리 완료 — 보존 위치` | 버림-중복 | :183-184 | |
| 18 | 157-161 | 묶음 완료 안내: OPEN → 「**출고 대기**(열린 PR #n). 묶음 코디는 여기서 끝 — **출고 중 수정**이 필요하면 본체가 feature worktree 를 다시 열고 …(bundle.md 6). **LA 는 그대로**」, MERGED → 「출고된 묶음의 남은 로컬 정리 끝. **LA 전이는 release §7 1번**」 | 옮김-슬롯 D17 + **뜻 바뀜**(OPEN: 「PR #n 머지 대기·머지 전에 수정」, MERGED: 「머지된 묶음의 남은 로컬 정리 끝」 — LA 전이 포인터 삭제) | :185-189 | LA 전이는 release §7 1번 |
| 19 | 163 | feature 모드 분기 후 exit 0 | 버림-중복 | :191 | |
| 20 | 165-170 | 0. 안전 확인: 작업 worktree 안 실행 금지·fetch·작업 worktree 미커밋 거절 | 버림-중복 | :193-199 | |
| 21 | 172-177 | `specs/` 안 파일 있으면 멈춤(LIFE-705: worktree 안 specs/ 는 .gitignore 라 status 에 안 보임·옛 측정 스크립트 기본 출력 경로) | 버림-중복 (근거 표기 빠짐: LIFE-705; specs-repo 모듈 조건부) | :200-208 | |
| 22 | 179-204 | 1. `--into F`: feature 만 받음(`feature/LIFE-*`·main 등은 거절)·임시 worktree 에서 merge --no-ff·push·충돌 시 abort·이미 들어 있음·로컬 없음 처리 | 버림-중복 | :210-236 | |
| 23 | 206-219 | 일반 모드: PR 조회·`task-pr.sh` 먼저·OPEN/MERGED/그 외 거절·로컬이 KEEP 조상인지 | 버림-중복(+ NEW 신규 가드 guard:f-squash — 머지됐는데 조상이 아니면 「squash·rebase 머지는 자동 정리하지 않는다」 :248) | :237-252 | |
| 24 | 222-237 | 2. 변형 브랜치·worktree 전수 발견(`$TASK-*`)·throwaway(-claude/-codex)가 아닌 변형이 KEEP 조상 아니면 멈춤(로컬만 검사) | 버림-중복(NEW 가 더 엄격: guard:variant-dirty·variant-remote·noid-variant 추가) | :254-283 | |
| 25 | 239-243 | 3. worktree 제거(`--force`, $TASK 와 변형) | 버림-중복 | :285-289 | |
| 26 | 245-256 | 4. 로컬 브랜치 삭제·원격 throwaway 삭제·「**태그 LIFE-NNN-*-final 은 유지**」(주석)·MERGED/feature 반영 뒤 원격 작업 브랜치 삭제 | 버림-중복(동작 동일; 태그 유지 주석만 소실) | :291-302 | |
| 27 | 258-280 | **5. 격리 herdr 세션 정리 — `life<NNN>*` 세션을 `herdr session list` 로 찾아 running 만 `herdr session stop` 4회 재시도(pane 233 개에서 15초 초과 실측)·stopped 확인·실패는 ⚠ 수동 확인, 사용자 default 세션 불가침** | **옮김-슬롯 D16(task-close 머지 뒤 단계 슬롯의 「끝나지 않은 watcher·세션 수거」 자리, 수동 단계로) — 자동 동작은 NEW 에서 소멸** | NEW :304-308 은 `.agents/harness/session-cleanup.sh` 훅만 부름. 훅(session-cleanup.sh:49-73)은 `corral terminal list` 로 worktree 아래 corral pane 후보를 **출력만** 하고 `herdr` 를 전혀 부르지 않는다. out/ 전체에 `herdr session` 문자열 0건 | 머지 뒤(또는 정리 뒤) `herdr session list \| awk 'NR>1 && index($1,"life<NNN>")==1 {print $1}'` 로 `life<NNN>*` 세션을 찾아 running 인 것만 `herdr session stop <이름>` (pane 이 많으면 15초 안에 안 끝나 최대 4회 재시도, stopped 확인, 실패는 수동 확인). 사용자 default 세션은 건드리지 않는다. |
| 28 | 282-285 | 완료 출력 + 「□ 다음: **출고 대기**(열린 PR). **LA 는 '검증 중' 유지 — '완료' 는 출고(scripts/release.sh) 머지 뒤 본체 세션이 전이**」 | 옮김-슬롯 D17 + **뜻 바뀜**(「PR 이 열려 있다. 머지한 뒤 task-finish.sh <작업> 를 다시 돌리면 남은 원격 브랜치까지 정리」, LA 완료 전이 안내 삭제) | :310-313 | LA 는 '검증 중' 유지 — '완료' 는 출고(scripts/release.sh) 머지 뒤 본체 세션이 전이 |
| 29 | — | NEW 에만 있는 동작·가드 | (NEW 전용) | .paddock/config.sh 필수(:32-35 없으면 exit 1)·guard:nobundle(:60-61)·guard:f-squash(:248)·guard:noid-variant(:263)·guard:variant-dirty(:272)·guard:variant-remote(:281)·guard:s-hook(:307, 훅 실패는 경고만) | |

task-finish.sh 옮김 개수: 3(행 18·28 = D17, 행 27(+6) = D16). 뜻 바뀜: 5(행 1·11(문구)·18·27·28).

---

#### (a) 스크립트 동작 차이 — OLD 에만 있는 것 / NEW 에만 있는 것

OLD 에만 있고 NEW 에서 **사라진 동작**
1. **herdr 격리 세션 정지**(task-finish.sh OLD :258-280): `life<NNN>*` 세션 running → `herdr session stop` 최대 4회·stopped 확인. NEW 훅 `.agents/harness/session-cleanup.sh` 는 `corral terminal list` 로 worktree 아래 corral pane 후보를 출력만 하고 닫지도 않으며(:3-10 주석), `herdr` 를 호출하지 않는다 → **herdr 세션 정지는 실제로 사라진다.** 또 NEW 훅은 `.claude/worktrees/<작업>` 아래 pane 만 보므로 격리 herdr 세션(life<NNN>*)과 대상이 다르다. 제안: D16(task-close 슬롯)에 위 원문을 수동 단계로 적고 corral 안내를 `.agents/rules/corral.md` 에도 한 줄. session-cleanup.sh 는 `paddock:fixed` 라 직접 고치면 sync 충돌.
2. NNN(LIFE 번호) 추출 변수 — 위 1 과 함께 소멸.
3. task-pr.sh `CORRAL_SPECS` 환경변수 오버라이드 → 폐기(config 의 SPECS_ROOT 만; 레포 내 다른 사용처 없음).
4. task-pr.sh PR 본문 서명 `🤖 Generated with [Claude Code]…` → `PR_FOOTER=""`(config.sh:13) 라 사라짐. 사용자 attribution 지침상 `.paddock/config.sh` 의 `PR_FOOTER` 에 그 줄을 채워야 한다.
5. 출력/주석의 release.sh·LA 완료 전이 안내(task-pr 본문 한 줄·`□ 다음` 2곳, task-finish 머리·`□ 다음` 3곳) → 전부 삭제. D17 이 대신 담아야 한다.
6. 메시지 문구: 「feature worktree 안에서 실행 금지」→「묶음 worktree 안에서 실행 금지」, 「corral-specs …」→「산출물 …」.

NEW 에만 있는 동작·가드
- `.paddock/config.sh` 필수(없으면 exit 1) · bundle/specs-repo 모듈 조건 · ISSUE_PREFIX 빈 모드 · `PR_FOOTER`.
- task-finish: guard:nobundle(bundle 꺼진 프로젝트에서 `--into`·묶음 브랜치 거절) · guard:f-squash(squash·rebase 머지는 자동 정리 안 함, 일반 모드) · guard:variant-dirty(비-throwaway 변형 worktree 미커밋 변경 시 멈춤) · guard:variant-remote(원격 변형이 KEEP 조상 아니면 멈춤) · guard:noid-variant · guard:s-hook(세션 정리 훅 호출, 실패는 경고만, 훅이 없거나 비실행이면 조용히 건너뜀).
- 안내 불일치 1건: NEW task-pr.sh :161-162 는 「PR 을 머지한 뒤 … task-finish.sh」, NEW task-finish.sh :186 은 PR 열림 상태에서 「PR #n 머지 대기. 묶음 코디는 여기서 끝」, NEW bundle.md :106-113 은 PR 생성 직후 정리. 같은 NEW 안에서 정리 시점 안내가 갈린다(동작은 모두 PR OPEN 에서 정리 가능, MERGED 뒤에도 멱등).

#### (b) 호환 — task-finish-test.sh · release.sh · release SKILL

**task-finish-test.sh 가 NEW task-finish.sh 로 돌 수 있는가: 그대로는 불가, 시험 setup 에 config 한 개를 심으면 거의 전부 가능(2건은 문구 불일치).**
- 막는 것: 시험 `setup()`(task-finish-test.sh:77-93)은 B 에 `.gitignore`·`a` 만 커밋하고 `scripts/task-finish.sh` 사본만 복사한다. NEW task-finish.sh :31-33 은 `$REPO/.paddock/config.sh` 가 없으면 `✖ 설정 파일 없음` exit 1 → **모든 정상 케이스(C1a·C1b·C1c·C1d·C1e·C4*·C5a·C5c 등)가 FAIL**, 「멈춤」 케이스는 `✖`·exit≠0·무변경만 보는 것은 우연히 PASS 하지만 사유 문구 검사(has "…")는 FAIL. 훅(`.agents/harness/session-cleanup.sh`)은 B 에 없어 :305-308 에서 조용히 건너뛴다(시험이 훅을 보지 않으므로 영향 없음; fake herdr 의 「herdr-calls.txt 없음」 C1e 는 통과).
- 해결: `setup()` 에서 B 에 `.paddock/config.sh` 를 쓰고 `/.paddock/` 를 `.git/info/exclude` 에 추가(86행과 같은 방식 — fixture 해시 유지). 내용은 최소 `PADDOCK_MODULES="specs-repo bundle"`, `ISSUE_PREFIX=LIFE`, `BASE_BRANCH=main`, `WORKTREE_DIR=.claude/worktrees`, `BUNDLE_PREFIX=feature/`, `VARIANT_SUFFIXES="-claude -codex"`. specs-repo 가 빠지면 C2j(「specs 에 파일」)가 깨지고 bundle 이 빠지면 `--into`(C5c)·묶음 케이스 전부 깨진다.
- 줄 번호와 함께 NEW 에서 달라진 것(config 를 심은 뒤에도 남는 것):
  - 사유 문구 `feature worktree 안에서 실행 금지`(test :237 C2h-root, :239 C2h-sub) → NEW task-finish.sh:88 은 `묶음 worktree 안에서 실행 금지` → **2 케이스 FAIL**(시험 문구 또는 NEW 문구를 맞춰야 함).
  - 그 밖의 `has` 문구는 모두 일치: `상태가 CLOSED`(NEW :103) · `미커밋 변경`(:130) · `자식 worktree 가 남아 있다`(:155) · `브랜치 없는 worktree`(:150) · `자식 브랜치 LIFE-901-c`(:158) · `통합 확인용 throwaway 면 지운 뒤 다시`(:155,:158) · `체크아웃한 worktree`(:125) · `본체 checkout`(:124) · `HEAD 가 $F 가 아니고`(:128) · `git fetch 실패`(:90) · `gh pr list 실패`(:94) · `base 원격 develop 가 없다`(:100,:102) · `specs 에 파일`(:132, specs-repo 필요) · `꼴만 받는다`(:84) · `다 들어 있지 않다`(:112) · `이미 정리됨`(:183) · `가 남아 있다`(:159) · `✔ $F 정리 완료`(:184) · 마지막 줄 `□ 다음`(:186, :188).
  - 가드 이름(`# guard:` 줄 끝 표지)과 양성 대조 mutate()(test :66-75): OLD 가드 전부 NEW 에 같은 이름·같은 줄 끝 위치로 존재(f-name·f-into·f-cwd·f-fetch·f-gh·f-nopr·f-base-open·f-base-merged·f-state·f-ahead·f-remote-ahead·f-main·f-cwd-wt·f-wt-head·f-dirty·f-specs·f-child-detached·f-child-wt·f-child-branch·f-no-force·f-wt-remove·f-prune·f-cas·f-lease·f-remote-del·f-release·f-up — `grep -o 'guard:…'` 대조로 확인). mutate 의 sed 식 f-up(NEW :144)·f-release(:143 `|release/*` 포함)·f-no-force(:165)·f-prune(:170)·f-lease(:178) 도 문자열이 그대로 맞는다. NEW 전용 가드(f-squash·nobundle·noid-variant·variant-dirty·variant-remote·s-hook)는 시험에 케이스가 없다.
  - 종료코드: 모든 die 가 exit 1 로 동일. 변경 없음.
  - NEW 가 가드 누락·동작 차이를 만드는 케이스는 없다(C5a 의 -claude 변형은 VARIANT_SUFFIXES 로 throwaway 취급 — config 필요; C5b·C5d 는 `✖`·무변경 확인 통과). bash 3.2 호환 문법은 읽어 확인했을 뿐 실행하지 않았다.
  - herdr: 시험의 fake herdr 는 C1e 에서 「호출 없음」만 본다 → herdr 정지 소멸을 시험이 잡지 못한다(양성 케이스 없음).

**release.sh · release SKILL 이 task-pr.sh·task-finish.sh 에 기대는 곳**
- scripts/release.sh:754 — 출력 문구 「⑤ 남은 로컬 정리 scripts/task-finish.sh <LIFE-NNN-슬러그>」 한 줄뿐. release.sh 가 두 스크립트를 실행하거나 출력·종료코드를 파싱하는 곳은 없음(grep 확인) → 깨지지 않음.
- .agents/skills/release/SKILL.md:114 `scripts/task-finish.sh <LIFE-NNN-슬러그>` · :115 `scripts/task-finish.sh feature/LIFE-MMM-<슬러그>`(+「정리는 묶음 코디가 PR 생성 직후 하므로(bundle.md 6) 안전망」) — 인자·MERGED 경로 동일 → 호환. 「PR 생성 직후」 설명은 NEW bundle.md 6.4 와도 맞다.
- release SKILL.md:39-40(출고 중 수정 → bundle.md 6) · :54(verdict.md 자식 판정 링크 → bundle.md 6): 절 번호 6 은 유지돼 참조는 유효하나 NEW 6.5 제목이 「열린 묶음 PR 수정」으로 바뀌고 6.2 의 「출고 회고용 링크」 문장이 사라져 **용어만 어긋남**(기능 영향 없음).
- release SKILL.md:103 의 LA 완료 전이는 task-close 6단계와 이중(D17 로 어느 쪽이 맡는지 정해야 함).
- 결론: release.sh·release SKILL 은 NEW 스크립트에서 **깨지지 않는다**. 깨지는 것은 task-finish-test.sh 뿐(config 부재 + 문구 2건).

---

#### 「옮김」 행 요약 (파일별 개수)

| 파일 | 옮김 개수 | 내역 | 뜻 바뀜 |
| --- | --- | --- | --- |
| task-start/SKILL.md | 4 (+ defaults.md 값 1 — 이 4파일 밖) | D3 슬롯 문장 3(행 8·26·27), D17 1(행 33) | 4 (행 14·29·31·33) |
| bundle.md | 4 | D17 3(행 7·28·31), D6 1(행 14) | 8 (행 3·7·14·18·26·28·29·31) |
| task-pr.sh | 4 행 / 목적지 2곳 | release/D17 3(행 2·13·17), config.sh PR_FOOTER 1(행 14) | 4 |
| task-finish.sh | 3 | D16 1(행 27+6: herdr 세션 정지), D17 2(행 18·28) | 5 |
| 합계 | 15 (+1) | | 21 |

`.agents/rules/corral.md(신설)` 로 가야 하는 순수 corral 규칙은 없다 — 모두 기존 슬롯(D3·D6·D16·D17)·config(PR_FOOTER)·defaults.md 표로 수용된다. 단 herdr 세션 정지는 D16 이 수동 단계라 **자동 → 수동 강등**이므로 사용자 결정 필요(자동 유지하려면 fixed 인 session-cleanup.sh 를 고쳐 sync 충돌을 감수하거나 훅을 부르는 별도 corral 전용 스크립트를 task-close 에서 부르게 해야 함).

