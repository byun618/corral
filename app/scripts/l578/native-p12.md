# P12 네이티브 회차 체크리스트 (LIFE-578)

설치본(구현 브랜치 dmg) + 사용자 폰(Z Flip7)에 넣은 **판정 APK** + 실제 Tailscale. **폰 조작은 사용자**, 명령은 코디. 워커는 손대지 않는다(02-kickoff E6).
통과선은 `specs/LIFE-578-mobile-app/01-criteria.md` P12 그대로다. dmg·APK 경로·sha256 은 `specs/LIFE-578-mobile-app/raw/claude/RESULT.md` 「최종 관문」.

## 준비물·변수

```sh
SER=<폰 시리얼>                       # adb devices 로 확인 — 에뮬레이터(emulator-5554)와 섞이지 않게 늘 -s 로
APK=~/Library/Caches/l578fg/corral-preview-local.apk   # sha256 32ce028941321a569c85b9e62310eb50dff567009a3ae0b96e468c9f8af093d3 — 설치 전에 대조
DMG=~/Library/Caches/l578fg/corral-0.1.2-arm64.dmg     # sha256 f9fb3b25968084c913776f4d52bf55bc421b56857bdc08b9308a0bb892314d33
UD="$HOME/Library/Application Support/corral"
LOG="$UD/corral.ndjson"               # 서버 쪽 원자료 — mobile.* 줄
RAW=specs/LIFE-578-mobile-app/raw/coordinator/native   # 회차 원자료(커밋 전 G5 가림)
T=/tmp/l578n                          # 백업·회수 임시(0700, 커밋 안 함)
```

- 서버 쪽 근거: `grep '"mobile\.' "$LOG"` — 이벤트 `mobile.server_listen · serve_added · pairing_code_created · paired · hello · device_revoked · replaced · idle_drop · server_stop · serve_removed · origin_rejected`.
  회차 시작 시각을 `date +%s000` 으로 적고 그 뒤 줄만 자른다: `node -e` 로 `at >= <시작 ms>` 필터, 또는 `tail -n +<시작 줄>`.
- 폰 쪽 근거(P8) 두 길:
  - **케이블 있음** — `adb -s $SER logcat -v time -s ReactNativeJS | grep --line-buffered corral-conn > $T/<시나리오>-logcat.txt` (시나리오 전에 띄우고 끝나면 끈다)
  - **케이블 없음·사후** — 앱 › 설정 › 「연결 기록」 › 「복사」 → 사용자가 메모·메신저(나에게 보내기)로 맥에 옮긴다. 파일은 앱 문서 폴더 `connection-log.ndjson`(앱을 다시 켜도 남는다, 최근 기록 상한까지)
  - 둘 다 토큰·코드 없음 — 커밋 전 `grep -E 'tok_|"code"|[A-Z2-9]{8}'` 0 확인, 맥 이름·tailnet 은 `<mac>`·`<tailnet>` 로 가린다(G5)
- 사용자 캡처: 폰 화면 캡처(전원+볼륨 아래) — 맥 이름·주소가 보이면 가린 뒤 커밋.

## ⓗ-전 — 관문 전 백업 (코디)

1. 설치본 종료 확인(⌘Q) → `mkdir -m 700 $T` → userData 해시 목록 `find "$UD" -type f -not -name '*.sock' -exec shasum -a 256 {} + | sort > $T/ud-before.sha` · `cp -Rp "$UD" $T/ud-backup`
2. 원래 `.app` 백업: `ditto /Applications/corral.app $T/corral.app.orig` · `shasum -a 256 /Applications/corral.app/Contents/MacOS/corral > $T/app-before.sha`
3. tailscale serve 원본(읽기만): `tailscale serve status --json > $T/serve-before.json` (`{}` 이어야 정상 — 아니면 그 값이 원복 기준)
4. dmg 설치: `shasum -a 256 $DMG` 대조 → dmg 열기 → `corral.app` 을 `/Applications` 로 덮어쓰기 → 실행 → 설정 › Mobile 켜기 → 상태 「노출됨」(캡처)

**멈춤**: 백업·해시 중 하나라도 실패하면 dmg 를 설치하지 않는다.

## 시나리오

| # | 사용자 손 동작 (폰·맥) | 코디 명령 | 기대 관측 | 통과선 (P12) | 멈춤 조건 |
| --- | --- | --- | --- | --- | --- |
| ⓐ APK 설치 | 폰 USB 연결 · 「USB 디버깅 허용」 1회 | `shasum -a 256 $APK`(RESULT 값과 대조) → `adb -s $SER install -r $APK` → `adb -s $SER shell dumpsys package io.github.byun618.corral.mobile \| grep -E 'versionName\|versionCode'` | `Success` · 패키지 `io.github.byun618.corral.mobile` · 앱 서랍에 corral | 설치 성공 원자료 | 해시 불일치 · `INSTALL_FAILED_*` |
| ⓑ 페어링 | 맥: 설정 › Mobile › 「QR 만들기」. 폰: corral 열기 → 「QR 찍기」 → 카메라 권한 허용 → QR 비춤 → A4 「<맥> 와 연결했습니다」 → 「대화방 보기」 → 홈 | logcat 띄움 · 시작 ms 기록 · 끝나면 `grep '"mobile\.\(paired\|hello\|origin_rejected\)' "$LOG"` | 서버 `mobile.paired` 1줄(그 뒤 같은 연결이 인증 연결), `origin_rejected` 0 · 폰 앱 바 `<맥> · 연결됨`(초록 점) · 연결 기록 `pair_send → paired` | 연결됨 + 맥 이름 = **RN 실기 Origin 허용 확인** | `origin_rejected` 가 찍힘 · A8 「맥에 닿지 않습니다」 → 폰 브라우저로 `https://<mac>.<tailnet>.ts.net:8577/` 404 확인 뒤 판단 |
| ⓒ 화면 끔 ≥ 5분 **(케이블 없이)** | 케이블을 **뺀다**(충전 중엔 Doze 가 안 걸린다) → 홈 화면 연결됨 확인 → 전원 버튼으로 화면 끔 → **≥ 5분**(시계로) → 화면 켬·잠금 해제 → corral 이 앞에 있으면 그대로, 아니면 열기 → 「연결됨」 이 될 때까지 스톱워치(또는 화면 녹화) | 끄기 전·켠 뒤 시각을 사용자에게 받아 적음 · 서버 쪽 `mobile.hello`·`replaced`·`idle_drop` 줄(켠 뒤 새 hello 시각) | 복귀 직후 `연결 확인 중` 또는 바로 연결됨 → **≤ 10초 연결됨** | **≤ 10초 연결됨** | 30초 넘게 재연결 중 → 「다시 연결」 누르기 전에 캡처·연결 기록부터 회수 |
| ⓒ 근거 회수 | 케이블 없이 끝난 뒤: 앱 › 설정 › 연결 기록 › 「복사」 → 맥으로 옮김(메모 공유 등) | 받은 기록을 `$RAW/p12c-conn-log.txt` 로 · `background`·`resume`·`probe`·`probe_ok`/`connect`·`hello_ok` 줄의 시각 차이로 ≤ 10초 계산 | 연결 기록에 resume 시각 → hello_ok/probe_ok 시각 | 사후 기록이 폰 쪽 근거 | 기록이 비어 있음 → 미달(보류)로 적는다 |
| ⓓ 앱 전환 ≥ 1분 | (케이블 다시 꽂아도 됨) 홈에서 다른 앱으로 전환 → ≥ 1분 → corral 로 복귀 | logcat 띄움 · 서버 줄 | `resume` → `probe` → `probe_ok`(또는 재연결 `hello_ok`) · 띠 3초 넘게 보이지 않거나 잠깐 | **≤ 10초 연결됨** | 10초 초과 → 캡처·기록 회수 뒤 미달 |
| ⓔ Wi-Fi ↔ LTE | 앱 포그라운드(홈)에서 Wi-Fi 끄기(LTE 로) → 연결됨 될 때까지 대기 → Wi-Fi 켜기 → 다시 연결됨 | logcat · 서버 `mobile.hello`·`replaced` 줄 | 각 전환 뒤 `network` → `probe`/`connect` → 연결됨, **사용자 조작 없이**. 서버 쪽 그 기기 이전 연결은 `replaced`(4006) 또는 `idle_drop` | 각 1회 조작 없이 연결됨 | 1분 넘게 끊김 → 캡처 뒤 「다시 연결」 은 누르지 말고 기록 회수 |
| ⓕ 맥에서 해지 | 맥: 설정 › Mobile 기기 목록 → 이 폰 「해지」. 폰: 화면 지켜봄 | 해지 직전 ms 기록 · 서버 `mobile.device_revoked` · logcat `closed code=4003 error=revoked` → `unpaired` | 폰이 A1 「맥에서 이 폰의 연결을 해지했습니다」 | A1 (P9ⓐ ≤ 3초 참고) | A1 로 안 감 → 기록 회수, 원복 |
| ⓖ corral ⌘Q → 재기동 | (ⓕ 전에 하려면 순서를 바꿔 ⓖ → ⓕ) 맥: corral ⌘Q → 폰 「끊김 · HH:MM 기준」 확인(캡처) → 맥: corral 다시 열기 | 서버 `mobile.server_stop`·`serve_removed` → 재기동 `server_listen`·`serve_added`·`hello` | 폰 띠 빨강 「끊김」(1001 → 즉시) → 재기동 뒤 사용자 조작 없이 연결됨 | 자동 재접속 | 재기동 뒤 2분 넘게 끊김 |
| ⓗ 원복 | 맥: 설정 › Mobile 끄기 · 시험 기기 해지(ⓕ 를 했으면 이미). 폰: 앱은 사용자가 지우거나 둔다 | `tailscale serve status --json`(읽기만) = `$T/serve-before.json` · corral ⌘Q → `ditto $T/corral.app.orig /Applications/corral.app` · `shasum` 대조 · userData 해시 대조(`ud-before.sha`, 바뀐 파일은 사유) · `$T` 삭제 | serve `{}` · `.app` 해시 일치 | 해시 대조 원자료 | serve 에 corral 항목이 남음 → 사람이 `tailscale serve --yes --https=8577 --set-path=/ off` 한 줄만 |

순서 권장: ⓐ → ⓑ → ⓓ → ⓔ → ⓖ → ⓒ(케이블 뺌) → ⓕ → ⓗ. ⓒ 는 시간이 길어 뒤로, ⓕ 는 토큰을 지우므로 맨 뒤.

## 멈춤·원복 (어느 걸음이든)

1. 더 진행하지 않는다. 그 걸음의 캡처·연결 기록·서버 줄을 먼저 회수한다(실패 회차도 원자료).
2. 설치본 설정 › Mobile 끄기 → `tailscale serve status --json` 으로 corral 항목이 사라졌는지 본다.
3. 앱이 응답하지 않으면 ⌘Q(안 되면 강제 종료) → 원래 `.app` 복원 → userData 해시 대조.
4. 폰 쪽 시험 기기는 맥에서 해지한다(기기 상한 5).

## 기록 칸 (코디가 runs.md 형식으로)

시나리오마다 한 행: 실행 id `n-ⓐ…` · 항목 P12ⓐ… · 사람 동작 요지 · 기대 · 실제(시각 포함) · 원자료(`$RAW/…`) · 통과/실패. 실패 회차도 지우지 않는다.
