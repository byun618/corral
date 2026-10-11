# LIFE-582 Z12 네이티브 회차 체크리스트 (코디 + 사용자)

기준 `01-criteria.md` Z12 · `02-kickoff.md` 「네이티브 회차 물류」(기준 commit `4c6c64564`). 설치본 = 구현 브랜치 dmg + Z Flip7 에 구현 브랜치 APK.
**폰 조작·재페어링·맥 UI 는 사용자, 명령·기록은 코디.** 워커는 이 문서·dmg·APK 만 만들었다 — 설치본 교체·폰 조작·실제 tailscale 은 건드리지 않았다(아래 명령은 전부 **미실행**).
**588 W9 와 직렬** — 교체 전에 묶음 코디(`life-564-mobile-68`)에 알리고 시점을 맞춘다. 같은 설치본으로 W9 를 함께 보면 교체 1회로 끝난다(맨 아래 「LIFE-588 W9」).

## 준비물·변수

```sh
SER=<폰 시리얼>                                                    # ③ 에서 adb devices 로 — emulator-5554 와 섞이지 않게 늘 -s
DMG=$HOME/Library/Caches/l582fg/corral-0.1.2-arm64.dmg            # sha256 a68624d1c259c07b6b6f6bc606a0686fd203c7444191ea1dec75cea328fa2e49 · 138,001,981 B (HEAD d335aded4, f069·f071)
APK=$HOME/Library/Caches/l582fg/corral-preview-local.apk          # sha256 28527165a97210e81de584dc6f84daab0ec0dd8976425651650bbd324fc42361 · 104,914,051 B · 서명자 483a15fa…a617a (f070·f072)
UD="$HOME/Library/Application Support/corral"
LOG="$UD/corral.ndjson"                                            # 서버 쪽 근거(mobile.* · input.* 줄만 발췌, 읽기만 — 본문은 로그에 없다 Z9ⓕ)
RAW=specs/LIFE-582-mobile-input/raw/coordinator/native            # 회차 원자료(커밋 전 가림)
T=/tmp/l582n-$(date +%m%d)                                         # 백업·캡처 임시(0700, 커밋 안 함)
CORRAL=/Applications/corral.app/Contents/Resources/bin/corral
START=$(date +%s000)
```

- 세션 구성(물류): **GUI 로 연 Claude 2**(맥 corral 「새 세션」 — 관리 세션) + **하네스로 연 Claude 1**(`$CORRAL terminal create --agent claude --model haiku --effort low`) + **Codex 1** + **Grok 1**.
  전부 이 회차 전용 시험 폴더에서 연다(예: `$T/s1` … — 실제 작업 레포 아님). 프롬프트는 짧고 무해하게(「reply OK only」 류), 싼 모델.
- Codex 는 `-c check_for_update_on_startup=false -c model_reasoning_effort="low"` 로(업데이트 안내가 Enter 를 먹는다). provider 전역 설정은 읽기만 — ① 에서 해시.
- 폰 원자료는 **모양만**(상태·이유·시각·id·답 라벨) — 대화 본문·기기 토큰·페어링 코드·맥 이름·tailnet 이름은 커밋 전에 가린다(G5).

## ① 관문 전 — 백업·해시 (코디)

```sh
adb devices; $CORRAL --version; tailscale version; tailscale serve status --json     # serve {} 여야 정상
$CORRAL orchestration run-current                                                     # 바인딩 기록(복원 대조용)
osascript -e 'quit app "corral"'; sleep 2; pgrep -fl /Applications/corral.app/Contents/MacOS/corral || echo "app pid none"
pgrep -fl "corral.app/Contents/Resources/backend/herdr server"                         # 살아 있어야 한다
mkdir -m 700 $T
find "$UD" -type f -not -name '*.sock' -exec shasum -a 256 {} + | sort > $T/ud-before.sha && cp -Rp "$UD" $T/ud-backup
ditto /Applications/corral.app $T/corral.app.orig
shasum -a 256 /Applications/corral.app/Contents/MacOS/corral > $T/app-before.sha
(cd /Applications/corral.app && find . -type f -exec shasum -a 256 {} + | sort | shasum -a 256) > $T/app-tree-before.sha
(cd $T/corral.app.orig && find . -type f -exec shasum -a 256 {} + | sort | shasum -a 256) > $T/app-tree-bak.sha; diff $T/app-tree-before.sha $T/app-tree-bak.sha && echo MATCH
tailscale serve status --json > $T/serve-before.json
shasum -a 256 ~/.codex/config.toml ~/.grok/config.toml > $T/provider-before.sha; cp -p ~/.codex/config.toml $T/codex-config.toml   # ~/.claude.json 은 넣지 않는다
```

멈춤: 백업·해시 중 하나라도 실패하면 dmg 를 설치하지 않는다.

## ② dmg 로 교체·기동 → Mobile 켜기

```sh
shasum -a 256 "$DMG"                                  # RESULT.md 값과 대조 — 다르면 멈춤
MNT=$(hdiutil attach -nobrowse "$DMG" | awk -F'\t' '/\/Volumes\//{print $NF}')
ditto "$MNT/corral.app" /Applications/corral.app && hdiutil detach "$MNT"
shasum -a 256 /Applications/corral.app/Contents/MacOS/corral
open -a /Applications/corral.app; sleep 3; $CORRAL --version; $CORRAL orchestration run-current
```

- 사용자: 맥 corral 설정 › Mobile 켜기 → 상태 「노출됨」.

## ③ APK 설치 (사용자: USB 디버깅 허용)

```sh
adb devices                                            # 폰 시리얼 확인 (emulator-* 와 구분)
shasum -a 256 "$APK"                                   # RESULT.md 값과 대조
adb -s $SER install -r "$APK"                          # Success
adb -s $SER shell dumpsys package io.github.byun618.corral.mobile | grep -E 'versionName|versionCode'
```

## ④ 재페어링 = Z12ⓐ (사용자)

맥: 설정 › Mobile › QR. 폰: corral → 「QR 찍기」 → 대화방 목록 → 아래 세션 중 하나 대화 열기.
근거: `grep '"mobile\.\(paired\|hello\|origin_rejected\)' "$LOG"` 를 `$START` 뒤로. 캡처 `n-a-paired.png`(폰 목록).

## ⑤ 세션 열기 (사용자 GUI 2 · 코디 3)

- 사용자: 맥 corral 에서 시험 폴더 두 곳에 Claude 「새 세션」 2개(G1·G2). 첫 화면이 한가(입력칸 빈 상태)인지 확인.
- 코디: `$CORRAL terminal create --agent claude --model haiku --effort low …`(H1) · Codex(X1) · Grok(K1) — 각 paneId·handle 을 기록.
- Codex·Grok 은 맥에서 「reply OK only」 한 번 보내 세션 기록을 만든다(첫 지시 전 기록 없음 = `no_session` 잠김이 정상).

## ⑥ 회차 — 사용자 손 동작 · 볼 화면 · 회수할 기록

각 행 = `runs.md` 한 행(실행 id `n-Z12ⓑ-1` …). 「기록」 = 그 세션 기록 파일에서 그 지시 글 1건(§4.6 규칙: Claude `type:user`+`origin.kind:human` · Codex `response_item` user `input_text` · Grok `user_message_chunk` 이어 붙임, 앞뒤 SPACE·TAB·CR·LF 뗌).
**탭 문자는 넣지 않는다**(Claude·Grok 이 기록에서 공백 4칸으로 바꿔 `확인하지 못했습니다` 가 된다 — SURFACE L14).

| # | 기준 | 사용자 손 동작(폰) | 볼 화면 | 회수할 기록 |
| --- | --- | --- | --- | --- |
| 1 | Z12ⓑ ×5 | G1·G2·H1 에 한가할 때 지시 5회 이상(**한글 포함 ≥ 1, G1·G2 각 ≥ 1**) | 말풍선 `보내는 중` → `들어감 ✓`(≤ 10 s) · 맥 pane 에 그 글 | 회차별 보낸 시각·`들어감` 시각(폰 캡처 시계) · 기록 매칭 1건 · `$LOG` `input.*` 줄 |
| 2 | Z12ⓒ 큐 | G1 에 「Run `sleep 20` then reply DONE」 → 작업 중 지시 1회 | `기다리는 중 — 지금 답하는 중` → 턴 끝나면 `들어감 ✓` | 기록 순서(긴 지시 → 큐 지시) · 큐 지시 1건 |
| 3 | Z12ⓒ 취소 | 같은 방식으로 작업 중 지시 1회 → `기다리는 중` 동안 말풍선 「취소」 | `취소됨` | 기록 0건(턴 끝 + 20 s 뒤) |
| 4 | Z4ⓕ ×2 | H1(또는 G1)에 「AskUserQuestion 으로 A/B 중 하나 물어봐」 → 폰 질문 카드에서 **하나 고르기** 1회 · 「여러 개 고르게」 → **여러 개** 1회 | 카드 → 답 → `답함`, 맥 질문 닫힘 | 기록의 tool_result 답 = 고른 라벨 · 질문 해소 |
| 5 | Z5ⓖ ×2 | G1 에 긴 작업(`sleep 30`) → 폰 「이 턴 멈추기」(두 번 누름 — 장전 3 s) 2회 | `멈췄습니다` ≤ 5 s · 세션 살아 있음(맥 pane 입력 가능) | 중단 전후 agent 상태·시각 · 기록 interrupted · 세션 프로세스 생존 |
| 6 | Z6ⓖ 망 전환 | Wi-Fi → LTE 전환 직후 G2 에 지시 1회 | 재연결 띠 → 보내기 결과 | 폰 표시 = 기록(들어감 → 1건 / 실패 → 0건) |
| 7 | Z6ⓖ 화면 끔 | 화면 끔 ≥ 1분 → 켜고 G2 에 지시 1회 | 재연결 뒤 결과 | 폰 표시 = 기록 |
| 8 | Z12ⓖ Codex | X1 에 지시 1회(+ 질문 1회 — 「request_user_input 으로 A/B 물어봐」 가 뜨면) | `들어감 ✓` / 질문 카드 | 기록 1건 · 답 라벨 |
| 9 | Z12ⓖ Grok | K1 에 지시 1회(+ 질문 1회 — `ask_user_question` 이 뜨면). 입력칸에 흐린 제안(ghost)이 떠 있어도 `들어감` 이어야 한다(최종 관문 수정 `ba187246c`·`37a6224ac`) | `들어감 ✓` / 질문 카드 | 기록 1건(합쳐진 글 0) · 답 라벨 |
| 10 | Z10ⓓ | 폰 연결 중 맥에서 G1 에 직접 입력·Esc 중단 1회씩 | 맥 동작이 폰 연결 전과 같음 | 맥 직접 입력 기록 1건 · 중단 동작 |

- 질문 회차(#4·#8·#9)는 **맥 pane 폭 ≥ 50열**에서 한다 — 40열이면 herdr 가 Claude 질문을 질문 대기로 못 봐 폰 답이 「질문이 이미 닫혔습니다」(키 0)로 끝난다(최종 관문 관찰 `final/claude40/`, SURFACE L10).
- Codex 질문(#8)은 ~2초 뒤 턴이 끝나 카드가 「Codex 가 턴을 마쳤습니다 — 아래 입력창에 답을 지시로 보내 주세요」 로 잠기는 것이 정상(D10·L15) — 입력창에 답을 지시로 보내 `들어감` 을 본다.
- 권한 대기(C6)는 provider 마다 다르게 보인다(최종 관문 `final/grok-perm/`·z8 s55~s60): Claude 「맥에서 승인을 기다립니다」 + 중단 열림 · Codex 는 「대기 중」(다른 대기) · Grok 은 『질의응답』 msg_a953bc0c117b 결정에 따름.
- 셸에서 직접 띄운 세션에 보내면 말풍선 아래 「보내지 못했습니다 · 맥 셸에서 직접 띄운 세션이라…」 + 다시 보내기가 보이는 것이 정상(r9 A, z8 s44).
- 각 회차 뒤 폰 캡처(`adb -s $SER exec-out screencap -p > $T/n-<#>.png`) — 커밋 전 대화 본문·맥 이름은 가림.
- 실패·`확인하지 못했습니다` 도 지우지 않고 행으로 남긴다. 폰 표시 ↔ 기록 불일치는 따로 셈(Z6ⓕ 규칙).

## ⑦ 관문 뒤 — 원복 = Z12ⓗ

```sh
# 사용자: 맥 설정 › Mobile 시험 기기 해지 → Mobile 끄기
tailscale serve status --json                          # = $T/serve-before.json ({})
$CORRAL terminal close --terminal <H1·X1·K1 handle>    # 사용자: G1·G2 닫기
osascript -e 'quit app "corral"'; sleep 2; pgrep -fl /Applications/corral.app/Contents/MacOS/corral || echo "app pid none"
ditto $T/corral.app.orig /Applications/corral.app
shasum -a 256 /Applications/corral.app/Contents/MacOS/corral | diff - $T/app-before.sha && echo APP-BIN-MATCH
(cd /Applications/corral.app && find . -type f -exec shasum -a 256 {} + | sort | shasum -a 256) | diff - $T/app-tree-before.sha && echo APP-TREE-MATCH
find "$UD" -type f -not -name '*.sock' -exec shasum -a 256 {} + | sort > $T/ud-after.sha; diff $T/ud-before.sha $T/ud-after.sha   # 바뀐 파일은 사유
shasum -a 256 ~/.codex/config.toml ~/.grok/config.toml | diff - $T/provider-before.sha || cp -p $T/codex-config.toml ~/.codex/config.toml   # codex 는 신뢰 줄을 스스로 쓴다 — 백업 바이트 복원 뒤 다시 대조
open -a /Applications/corral.app; sleep 3; $CORRAL --version; $CORRAL orchestration run-current
```

- `APP-TREE-MATCH` 가 안 나오면 `rm -rf /Applications/corral.app && ditto $T/corral.app.orig /Applications/corral.app` 뒤 다시 대조.
- 폰: 581 r7 판정 APK 로 되돌릴지 사용자에게 묻는다(다음 작업이 같은 APK 를 쓰면 그대로).
- `$T` 는 사용자 확인 뒤 지운다(백업은 커밋 안 함).

---

## LIFE-588 W9 (같은 설치본으로 함께 볼 때)

원본 `specs/LIFE-588-worktree-label/raw/claude/final/w9-checklist.md` ⑤⑥. 582 dmg 가 588 변경을 포함하는지 먼저 확인한다(`git merge-base --is-ancestor <588 구현 commit> <582 dmg HEAD>`) — 아니면 W9 는 588 dmg 로 따로.
**확인함(워커, f069 dmg HEAD d335aded4)**: 588 머지 `a8af89a6a`·`e6a1edf15` 모두 조상(`--is-ancestor` exit 0) — 이 dmg 로 W9 를 함께 본다.

### 장면 (코디 명령 — W9 ⑤)

- 하위 셋: **브랜치 하위 2**(`LIFE-588-worktree-label` · `LIFE-588-worktree-label-claude`) + **detached 하위 1**(`git -C $WORK worktree add --detach $PROBE HEAD` → `corral worktree set --parent-worktree path:$WORK`).
- 각 하위에 셸 pane 하나 + `herdr pane report-agent --state working`(폰 목록에 머리가 생기는 것이 양성 대조).
- **보존 행 하나**: WORK 에 pane 하나 더 → working → idle(done) → herdr 에서 직접 닫기(corral 이 닫으면 보존 안 됨). 포커스된 pane 이면 done 을 건너뛴다 — 다른 pane 을 보게 한 뒤.

### 같은 순간 캡처 3장 (W9 ⑥)

```sh
screencapture -x $T/w9-desktop-sidebar.png                    # 데스크톱 사이드바
adb -s $SER exec-out screencap -p > $T/w9-phone-list.png       # 폰 목록(같은 순간)
adb -s $SER exec-out screencap -p > $T/w9-phone-header.png     # PROBE 세션 대화 머리
```

| 확인 | 기대 |
| --- | --- |
| 하위 머리 이름 | `↳ LIFE-588-worktree-label` · `↳ LIFE-588-worktree-label-claude` = 데스크톱 카드 제목 그대로 |
| detached 머리 | `↳ corral · Detached HEAD @ <sha>` — sha = `rev-parse --short=7` = 데스크톱 배지 |
| 대화 머리 | 셋째 줄 `↳ corral @ <sha>`, 둘째 줄 `corral › feature/LIFE-564-mobile` |
| 보존 행 | `l588-retained` 가 `↳ LIFE-588-worktree-label` 머리 아래 끝, 「닫힌 세션」 |
| crumb 하위 이름 잘림 | 위 섹션 crumb `corral › feature/LIFE-564-mobile › LIFE-588-…` 가 실제 폰 폭에서 어디서 잘리는지(말줄임 `…`) 기록 — 워커 렌더(411px)는 `LIFE-581-mo…` |

원복은 W9 ⑦(PROBE 제거·pane 닫기)을 이 문서 ⑦ 앞에 한다.

## 기록 칸

시나리오마다 한 행(`raw/coordinator/runs.md` 형식): 실행 id `n-Z12…` · 기준 · 사람 동작 요지 · 기대 · 실제(시각) · 원자료 · 통과/실패. 실패 회차도 지우지 않는다.
