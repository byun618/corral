# L12 네이티브 회차 체크리스트 (LIFE-580 · K11 · J9)

설치본(구현 브랜치 dmg) + 사용자 폰에 넣은 **판정 APK** + 실제 Tailscale. **폰 조작은 사용자**, 명령은 코디. 워커는 손대지 않는다.
통과선은 `specs/LIFE-580-mobile-list/01-criteria.md` L12 그대로다. dmg·APK 경로·sha256 은 `specs/LIFE-580-mobile-list/raw/claude/RESULT.md` 「최종 관문」.
578 P12 체크리스트(`app/scripts/l578/native-p12.md`)의 백업·원복·연결 기록 회수 방법을 그대로 쓴다 — 여기는 580 이 더하는 것만 적는다.

## 준비물·변수

```sh
SER=<폰 시리얼>                       # adb devices 로 확인 — 에뮬레이터(emulator-5554)와 섞이지 않게 늘 -s 로
APK=/tmp/l580-final-artifacts/corral-preview-local.apk   # sha256 ed88ce04a5672434a0e6b868d8cc9a31882f4e47d33d1f6cdb0e1a8b64ff02e9 — 설치 전에 대조
                                      # (같은 파일 ~/Library/Caches/l580fg/corral-preview-local.apk · 서명자 SHA-256 483a15fa…a617a = 578 과 같은 키라 덮어 설치 가능)
DMG=/tmp/l580-final-artifacts/corral-0.1.2-arm64.dmg     # sha256 d6a46431b36c837b46ba7d9abf743ee0e9edd3289421e3cbd4dd5fca44be55da (HEAD df8b66d69, release 백엔드)
UD="$HOME/Library/Application Support/corral"
LOG="$UD/corral.ndjson"               # 서버 쪽 원자료 — mobile.* 줄(list_subscribe · list_built · list_push · paired · hello)
RAW=specs/LIFE-580-mobile-list/raw/coordinator/native   # 회차 원자료(커밋 전 G5 가림)
T=/tmp/l580n-$(date +%m%d)            # 백업·회수 임시(0700, 커밋 안 함)
START=$(date +%s000)                  # 관문 시작 ms — push-cost·로그 자르기 기준
```

- 서버 쪽 근거: `node -e` 로 `$LOG` 에서 `at >= $START` 이고 tag 가 `mobile.` 로 시작하는 줄만 `$T/main.ndjson` 으로 뽑는다(제목이 든 다른 줄은 가져오지 않는다).
- 폰 쪽 근거: 앱 › 설정 › 「연결 기록」 › 「복사」 → 사용자가 맥으로 옮긴다(`list_recv`·`clock` 줄 — `native-j5.md` 「폰 기록에서 쓰는 줄」). 케이블이 있으면 `adb -s $SER logcat -v time -s ReactNativeJS | grep --line-buffered corral-conn`.
- 커밋 전 G5: `grep -E 'tok_|"code"|[A-Z2-9]{8}'` 0 · 맥 이름·tailnet·기기 이름은 `<mac>`·`<tailnet>`·`<phone>`. 폰·맥 캡처도 같은 값은 가린 뒤 커밋.

## ⓗ-전 — 관문 전 백업 (코디)

578 `native-p12.md` 「ⓗ-전」 1~4 그대로(userData 해시·복사, 원래 `.app` ditto·해시, `tailscale serve status --json` 읽기만, dmg 해시 대조 뒤 설치). **백업·해시 중 하나라도 실패하면 dmg 를 설치하지 않는다.**

## 시나리오

| # | 사용자 손 동작 (폰·맥) | 볼 화면 | 코디 명령 · 모을 기록 | 통과선 (L12) | 멈춤 조건 |
| --- | --- | --- | --- | --- | --- |
| ⓐ APK 설치 → 재페어링 → 목록 | 폰 USB 연결 · 디버깅 허용. 578 APK 가 있으면 덮어 설치(토큰은 그대로일 수 있다 — 홈이 바로 뜨면 재페어링 생략 가능, 아니면 맥 설정 › Mobile › QR → 폰 「QR 찍기」) → 「대화방 보기」 | 폰: 대화방 목록(레포 › 작업 › 채널, 상태 점, 「나를 기다리는 것」). 맥: 사이드바 | `shasum -a 256 $APK` 대조 → `adb -s $SER install -r $APK` → `dumpsys package io.github.byun618.corral.mobile \| grep version` · 서버 `mobile.paired`(재페어링 때)·`mobile.hello`·`mobile.list_subscribe`·`mobile.list_push` 1줄 이상 | 설치 성공 + 목록이 뜬다(빈 화면·「세션 0」 아님 — 맥에 AI 세션이 있을 때) | 해시 불일치 · `INSTALL_FAILED_*` · 목록 대신 오류/빈 화면 → 연결 기록 회수 |
| ⓑ L2ⓒ 나란히 캡처 | 맥 사이드바와 폰 목록을 **같은 순간** 찍는다(맥 ⌘⇧4 · 폰 전원+볼륨 아래, 손으로 1~2초 안). 맥에 AI 세션 ≥ 3(상태 섞어서)이 있을 때 | 두 화면의 채널 제목 · 상태 점 · 순서 · 그룹(레포 › 작업) | 두 캡처를 `$RAW/l12b-mac.png`·`l12b-phone.png`(가림 뒤) · 표로 채널마다 제목/점/순서 대조 | 보이는 채널의 제목·상태·순서 불일치 0, 사유 없는 차이 0(폰은 AI 세션만 — 셸 pane 이 맥에만 있는 것은 사유 있는 차이) | 불일치 → 그 순간 `$T/main.ndjson` 마지막 `mobile.list_push` seq 와 폰 연결 기록 마지막 `list_recv` seq 를 같이 남긴다 |
| ⓒ L3 네이티브 전이 ≥ 5 | 폰은 목록 화면에 둔다(앞에 켜 둠). 코디가 전용 셸 pane 에서 원인을 친다 | 폰: 그 채널 점이 바뀌고 「방금」 1.5초 | **`native-j5.md` 「체크리스트 (L12ⓒ)」 1~6 그대로** — `native-cause.mjs --sequence working,idle,blocked,working,idle,working --gap-ms 8000 --release` → 폰 「복사」 → `native-j5.mjs --phone … --cause … [--main …] --out $RAW/l12c-j5.json` · B5 「방금」 캡처 1장(사용자) | 셀 수 있는 전이 ≥ 5 전부 ⓐ·ⓑ ≤ 3000 ms (exit 0) + B5 캡처 1 | `native-cause` 가 exit 1(보고 실패·중단) → 그 회차는 실패로 적고 다시 |
| ⓓ L4ⓓ 화면 끔 · 망 전환 | ① 폰 화면 끔 ≥ 1분(시계로). 그 사이 맥에서 세 가지: AI 세션 하나 상태 바꿈(코디 `native-cause --state working`), 새 claude 세션 하나 열기, 세션 하나 닫기 → 화면 켬. ② Wi-Fi 끄기(LTE) → 그 사이 맥에서 상태 1건 → 연결됨 → Wi-Fi 켜기 → 상태 1건 | 복귀 뒤 폰 목록이 맥 사이드바와 같은가(**사용자 조작 없이** — 당겨 새로고침·다시 연결 누르지 않음) | 각 복귀 뒤 서버 `mobile.hello`·`mobile.list_subscribe`·`mobile.list_push`(새 seq) · 폰 연결 기록 `resume`/`network` → `hello_ok`/`probe_ok` → `list_recv` · 복귀 직후 폰 캡처 + 맥 사이드바 캡처 | 각 1회 복귀 뒤 목록 = 맥 상태(바꾼 상태·새 세션·닫힌 세션 반영) | 30초 넘게 옛 목록 → 「다시 연결」 누르기 전에 캡처·기록 회수 |
| ⓔ 실제 대기 1건이 맨 위 | 맥: 설치본 corral 의 claude 세션에서 권한이 필요한 명령(예: `Use the Bash tool to run exactly: touch l12-probe.txt`, **수동 권한 모드**) 또는 질문(AskUserQuestion)을 일으킨다 → 대화상자가 뜬 채로 둔다 | 폰: 「나를 기다리는 것」 맨 위 그 세션, 미리보기(권한이면 `맥에서 승인` + `Bash · touch l12-probe.txt`, 질문이면 질문 글) · 제자리 자국 행 | 폰 캡처 1 · 맥 화면 캡처 1 · 서버 `mobile.list_push` 그 시각 줄 | 실제 질문·권한 대기 1건이 맨 위(J11 미리보기) | 3초 넘게 안 올라옴 → 그대로 두고 ⓒ 방식으로 시각 기록 |
| ⓕ 안 읽음 → 읽음 | 폰을 홈 화면 밖(다른 앱)으로 두거나 목록에서 다른 곳을 보는 사이 맥 AI 세션에 활동(claude 에 짧은 질문 1개 → 응답 끝) → 폰 목록으로 → 그 채널을 눌러 대화 자리 화면 → 뒤로 | 활동 뒤: 채널 굵은 제목 + 흰 점, 작업 머리 점(접혀 있어도). 연 뒤: 굵기·흰 점 사라짐 | 폰 캡처 2(안 읽음 · 읽음) | 활동 뒤 안 읽음 → 열면 읽음 | 활동 뒤에도 안 읽음 표시 없음 → 연결 기록 `list_recv` 의 그 채널 `timeAt` 확인용으로 회수 |
| ⓖ L10ⓓ push 비용 + 체감 | 위 ⓐ~ⓕ 동안 평소처럼 맥 corral 사용(타이핑·탭 전환) | 맥: 입력·화면 지연 체감 | `node scripts/l580/push-cost.mjs --log "$LOG" --since $START --out $RAW/l12g-push-cost.json` (설치본 로그는 읽기만 — 코디가 사본을 `$T` 에 둔 뒤 그 사본으로 돌려도 된다) · 사용자 체감 한 줄 | p95 ≤ 5 ms (표본 ≥ 1, exit 0) + 체감 「느려짐 없음」 | 표본 0 → 폰이 붙어 있었는지부터 확인(미달) |
| ⓗ 원복 | 맥: 설정 › Mobile 시험 기기 해지 · Mobile 끄기. 폰: 앱은 사용자가 지우거나 둔다 | 맥 설정 › Mobile 기기 0(이번에 붙인 것) | 578 `native-p12.md` 「ⓗ 원복」 그대로 — `tailscale serve status --json`(읽기만) = 백업 · corral ⌘Q → `.app` ditto 복원 · 해시 대조 · userData 해시 대조(바뀐 파일은 사유) · `$T` 삭제 | serve `{}` · `.app` 해시 일치 · 기기 해지 | serve 에 corral 항목이 남음 → 사람이 `tailscale serve --yes --https=8577 --set-path=/ off` 한 줄만 |

순서 권장: ⓗ-전 → ⓐ → ⓑ → ⓔ → ⓒ → ⓕ → ⓓ → ⓖ(로그 계산) → ⓗ. ⓓ 는 화면 끔·망 전환이 길어 뒤로, ⓖ 는 앞 회차 로그를 모아 마지막에 한 번.

## 격리 최종 관문에서 확인한 함정 (RESULT 「최종 관문」 f17~f35)

- **안 읽음(ⓕ)은 실제 에이전트 활동으로만 생긴다** — 폰 규칙은 `activityAt`(= `digest.lastActivityAt`)·턴 결과 변화다. `herdr pane report-agent`·`native-cause.mjs` 로 바꾼 상태는 점만 바꾸고 안 읽음을 만들지 않는다(f23). ⓕ 는 claude 에 실제 지시 1회.
- **닫힌 세션 행은 「끝났는데 안 본」(done) pane 을 corral 밖에서 닫을 때만 남는다**(store `retain` ①②). 한가 pane·corral 이 닫은 pane 은 남지 않는다(f28 1회차).
- **폰 캡처 G5**: 앱 바 둘째 줄이 `<맥> · 연결됨`, 끊김일 땐 점 없이 이름이 왼쪽 끝부터다 — 그 줄 전체를 가린다(f22·f30).
- 맥 쪽 캡처·스크린샷에 다른 작업(사용자 실제 레포·세션 제목)이 보이면 그것도 가린다.
- 「당겨 새로고침」(목록 맨 위에서 아래로 끌기)은 `list_subscribe reason refresh` 로 전체를 다시 받는다 — ⓓ 의 「조작 없이」 판정 중에는 목록을 끌지 않는다(f30 보충).

## 멈춤·원복 (어느 걸음이든)

578 `native-p12.md` 「멈춤·원복」 1~4 그대로. 실패 회차의 캡처·연결 기록·서버 줄도 지우지 않는다.

## 기록 칸 (코디가 runs.md 형식으로)

시나리오마다 한 행: 실행 id `n-ⓐ…` · 항목 L12ⓐ… · 사람 동작 요지 · 기대 · 실제(시각 포함) · 원자료(`$RAW/…`) · 통과/실패.
