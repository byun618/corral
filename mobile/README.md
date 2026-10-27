# corral 모바일 (Android)

맥의 corral 에 Tailscale 망으로 붙는 폰 앱. 계정·클라우드를 거치지 않는다 — 폰이 맥의 `wss://<mac>.<tailnet>.ts.net:8577/ws` 에 직접 붙는다.
서버 쪽 정본은 `app/src/main/mobile/SURFACE.md`. 스택은 life-assistant `apps/mobile` 과 같다(Expo SDK 54 · RN 0.81 · expo-router 6 · NativeWind 4).

- 앱 이름 `corral`, 패키지 `io.github.byun618.corral.mobile` (개발 클라이언트만 `.dev`)
- EAS 프로젝트 `@byun618/corral-mobile` (`app.config.ts` `extra.eas.projectId`)
- 독립 npm 프로젝트 — `app/` 과 의존·스크립트를 섞지 않는다. node 20.19 이상(22·24 확인).

## 1. 준비물 (한 번)

| 어디 | 무엇 |
| --- | --- |
| 맥 | corral 설치본 — 설정 › **Mobile** 을 켠다. 상태가 「노출됨」 이어야 한다 |
| 맥 | Tailscale 로그인 · tailnet 의 **HTTPS 인증서** 켜기(관리 콘솔 DNS › HTTPS Certificates). 꺼져 있으면 Mobile 이 「HTTPS 꺼짐」 으로 막힌다 |
| 맥 | Funnel 은 꺼 둔다 — 켜진 노드에서는 corral 이 노출을 거부한다 |
| 폰 | Tailscale 앱 로그인(같은 tailnet) · 「Use Tailscale DNS」 켜기(`*.ts.net` 이름 해석) |
| 폰 | 설치용: 개발자 옵션 › **USB 디버깅** 허용(케이블 설치 시) 또는 APK 파일을 폰으로 옮겨 직접 설치 |
| 빌드 맥 | `npm ci`(이 폴더) · `eas` CLI 로그인(`eas whoami` = byun618) · 로컬 빌드는 Android SDK(`ANDROID_HOME`) + JDK 17 |

## 2. 빌드

LA 와 같은 스크립트 세트다. 프로필은 `eas.json` 셋 — 전부 `internal` 배포 + `apk`.

| 프로필 | 용도 | 패키지 |
| --- | --- | --- |
| `development` | 개발 클라이언트(Metro 에 붙음, 에뮬레이터 개발 접속 허용) | `…corral.mobile.dev` |
| `preview` | 판정 APK(작업 브랜치 dev 빌드)·**출고 APK**(`scripts/release-apk.sh` 가 출고 태그에서 로컬 빌드) | `io.github.byun618.corral.mobile` |
| `production` | **출고에 안 씀** — preview 와 동작이 같고(차이는 `extra.variant` 문자열뿐) 폰까지 실측된 경로는 preview 다 | `io.github.byun618.corral.mobile` |

**정식본은 출고 태그 빌드다.** 작업 브랜치에서 만든 APK 는 머지 전 확인용 dev 빌드이고, 출고(`scripts/release.sh`, `app/INSTALL.md` 「출고」)가 태그 위 깨끗한 트리에서
preview 로컬 빌드로 정식 APK 를 만들어 `app/dist/release/<태그>/` 에 둔다 — 폰은 그 APK 로 덮인다.

```sh
cd mobile
npm ci

# 클라우드 (EAS 서버에서 빌드 — 무료 쿼터 소모. 끝나면 링크로 APK 를 받는다)
npm run build:preview          # = eas build -p android --profile preview
# 로컬 (이 맥에서 빌드 — 쿼터 소모 없음, build-*.apk 가 이 폴더에 떨어진다)
npm run build:local:preview    # = eas build -p android --profile preview --local
```

- 서명 키는 EAS 원격 자격증명 하나를 클라우드·로컬이 같이 쓴다(첫 빌드 때 EAS 가 만든다). 그래서 어느 쪽 APK 로도 덮어쓰기 설치가 된다.
- 버전 문자열(versionName) = 출고 버전 — `app.config.ts` 가 `app/package.json` 의 `version` 을 읽는다(원천 하나, 출고가 올린다). 그래서 출고 태그 APK 는 태그 버전이고,
  작업 브랜치 빌드는 지난 출고 버전을 단다. 버전 코드는 EAS 원격 값이다(`appVersionSource: remote`, `autoIncrement` 없음 — 같은 값으로 덮어 설치된다).
- 빌드 산출물(`build-*.apk`·`android/`·`ios/`·`.expo/`)은 커밋하지 않는다(`.gitignore`).

## 3. 설치

```sh
# USB 디버깅을 허용한 폰을 케이블로 연결 — 여러 기기면 시리얼을 명시한다
adb devices
adb -s <폰 시리얼> install -r build-<…>.apk
# 기기가 하나뿐이면 가장 최근 APK 를 한 번에
npm run apk:install            # = adb install -r $(ls -t build-*.apk | head -1)
```

- **기기가 여럿이면(폰 + 에뮬레이터 등) `npm run apk:install` 은 쓰지 않는다** — 시리얼 없는 `adb install` 은 기기가 둘 이상이면 실패한다. `adb -s <시리얼>` 로 고른다.
- 출고 APK 는 `scripts/release-apk-install.sh --serial <시리얼> --apk <APK>` 로 깐다 — 설치본과 서명을 먼저 대조하고 같을 때만 `install -r` 한다(`app/INSTALL.md` 「출고」).
  서명이 다르면(예: 에뮬레이터의 Debug 서명 설치본) 덮어 설치가 안 된다 — 앱을 지우면 페어링·기록이 사라지므로 지우지 말고 멈춘다.

케이블 없이: 클라우드 빌드 링크를 폰 브라우저로 열어 받거나 APK 파일을 옮겨 「출처를 알 수 없는 앱」 설치를 허용한다.

## 4. 페어링

1. 맥 corral › 설정 › Mobile › 「QR 만들기」 (10분 · 1회용 코드)
2. 폰 앱 › 「QR 찍기」 → QR 을 네모 안에 → 「맥에 연결하는 중」 → 「<맥 이름> 와 연결했습니다」
3. 카메라를 못 쓰면: 맥 화면의 페어링 텍스트(QR 과 같은 JSON)를 폰 클립보드로 옮긴 뒤 「페어링 텍스트 붙여넣기」

기기 토큰은 폰의 보안 저장소(SecureStore)에만 있다. 다음부터는 앱을 열면 바로 붙는다.

- 맥이 토큰을 준 뒤 폰에 저장하는 동안(「폰에 저장하는 중」)은 「취소」 가 없다 — 맥은 이미 기기를 등록했고 저장은 짧다. 그사이 연결이 끊겨도 실패가 아니라 저장이 끝나면 그 토큰으로 다시 붙는다.
- 「대화방 보기」 는 페어링 화면들을 걷어 내고 홈을 바닥에 둔다 — 뒤로 가기가 안내 화면으로 돌아가지 않는다(토큰이 있는데 안내·스캔 화면에 오면 홈으로 보낸다).
- 저장이 늦게 끝났으면(3초 넘게) 곧장 「연결됨」 이 아니라 확인 중 → 서버 응답을 받은 뒤 연결됨.

## 5. 갱신

새 APK 를 **덮어쓰기**(`adb install -r` 또는 같은 패키지 설치)하면 토큰이 남아 다시 페어링하지 않는다.
앱을 **지우고** 설치하면 토큰도 지워진다 — 다시 페어링하고, 맥 설정 › Mobile 의 기기 목록에서 이전 항목을 해지한다(기기 상한 5대).

## 6. 해제·해지

- 폰 › 설정 › 「페어링 해제」 — 폰의 토큰만 지운다. **맥의 기기 목록에는 남는다** — 맥 설정 › Mobile 에서 해지한다.
  연결은 바로 닫고, 보안 저장소에서 토큰이 실제로 지워진 뒤에만 「해제했습니다」 를 보인다. 지우기가 실패하면 안내 화면에 「기기 토큰을 지우지 못했습니다」 +
  「다시 지우기」 가 나오고, 지울 때까지 새 페어링·재연결을 하지 않는다. 「다시 지우기」 는 해제와 같은 경로(연결 닫기·메모리 토큰 제거·저장소 삭제)를 다시 지난다.
- 맥에서 해지 — 열린 연결은 바로 끊기고 폰은 안내 화면(「맥에서 이 폰의 연결을 해지했습니다」)으로 간다. 앱이 꺼져 있었으면 다음 실행 때.

## 7. 연결 동작

| 상황 | 폰 화면 |
| --- | --- |
| 연결됨 | 앱 바 `<맥 이름> · 연결됨` + 초록 점, 띠 없음. **최근 서버 응답(hello·pong) 위에서만** 연결됨 |
| 앱 복귀·망 전환(Wi-Fi↔LTE) | 곧장 프로브(3초 마감). 3초 안에 되면 아무것도 안 보인다 |
| 재연결 중 3초 넘음 | 회색 띠 `재연결 중 · HH:MM 기준` — 재시도는 0.5→1→2→4→8→15초(상한) 간격으로 멈추지 않는다 |
| 20초 넘게 실패 · 맥 corral 종료 · 맥에서 Mobile 끔 | 빨간 띠 `끊김 · HH:MM 기준` + 「다시 연결」(즉시 시도). 홈은 당겨서 새로고침도 즉시 시도 |
| 버전 불일치 | 본문을 막고 양쪽 프로토콜을 보여 준다. 자동 재시도 안 함 — 업데이트 뒤 「다시 연결」 |

- 포그라운드 동안 8초마다 ping, 8초 안에 서버 응답이 없으면 끊고 새로 붙는다(half-open 감지 ≤ 16초).
  응답을 기다리는 동안의 추가 프로브(새로고침·망 바뀜)는 마감을 늦추지 않고 앞당기기만 한다 — 연타해도 감지가 밀리지 않는다.
- 서버는 10초마다 WS ping 을 보내고 30초 무수신이면 그 연결을 정리한다. 같은 폰이 새로 붙으면 이전 연결을 닫는다(SURFACE §3).
- 토큰은 서버가 **명시적으로 거절**할 때만 지운다(해지 `revoked` · 인증 실패 `unauthorized`). 망 오류·마감·맥 종료·Mobile 꺼짐은 토큰을 유지하고 재시도한다.

## 8. 문제 해결

| 증상 | 확인 |
| --- | --- |
| 「맥에 닿지 않습니다」 | 원인을 고친 뒤 「다시 시도」(같은 QR 내용으로 — 앱이 켜져 있는 동안 메모리에만 둔다). 폰 Tailscale 켜짐 · 맥 깨어 있음 · 맥 corral 실행 + Mobile 켜짐 · 폰 「Use Tailscale DNS」(Android 에서 `*.ts.net` 해석만 실패하는 경우가 있다 — Private DNS 를 끄거나 Tailscale DNS 를 켠다). 폰 브라우저로 `https://<mac>.<tailnet>.ts.net:8577/` 을 열어 **404** 가 오면 이름·경로는 살아 있다 |
| 「코드가 만료」·「이미 쓴 코드」·「코드가 맞지 않습니다」 | 맥에서 「QR 만들기」 를 다시 누르고 새 QR 을 찍는다 |
| 「기기가 가득 찼습니다」 | 맥 설정 › Mobile 기기 목록에서 안 쓰는 기기를 해지 |
| 「맥이 지금 폰 연결을 받지 않습니다」 | 맥 설정 › Mobile 상태 — HTTPS 인증서·Funnel·8577 포트 점유 |
| 카메라를 쓸 수 없음 | 「권한 허용」(Android 가 더 묻지 않으면 「설정 열기」 → 권한 › 카메라 허용 → 앱으로 돌아오면 카메라가 바로 보인다). 또는 페어링 텍스트 붙여넣기. 앱이 권한을 스스로 묻는 것은 QR 화면에 처음 들어올 때 한 번뿐 — 앱으로 돌아올 때는 다시 읽기만 한다 |
| 연결이 이상하다 | 폰 › 설정 › **연결 기록** › 「복사」 — 시도·인증·프로브·끊김 사유가 시각과 함께 있다(토큰·코드 없음). 케이블이 있으면 `adb -s <시리얼> logcat -s ReactNativeJS \| grep corral-conn` |

## 9. 개발

```sh
cd mobile
npm run typecheck && npm run lint && npm test   # 단위 시험 + 실제 서버(app/) 통합 시험 — app/ 에서 npm ci 가 돼 있어야 한다
npx expo-doctor
```

- 연결 층은 RN 을 모르는 `src/core/`(관리자·페이로드·기록·띠·라우팅 판단) — vitest 가 node 에서 돌린다. RN 배선은 `src/runtime/`, 화면은 `app/`(expo-router), 공용 UI 는 `src/ui/`.
  화면 시험(`test/screens.test.tsx`)은 happy-dom 에서 RN·expo-router 를 DOM 가짜로 바꿔 실제 화면 코드를 그린다(네이티브 실행 아님).
- 의존: `react-dom` 을 `react` 와 같은 **19.1.0** 으로 개발 의존에 고정한다 — 화면 시험용이고, expo-router 의 웹 하위 의존(@radix-ui·vaul)이 요구하는 peer 를 채운다.
  고정하지 않으면 npm 이 최신 react-dom(react 19.3 요구)을 골라 설치가 ERESOLVE 로 멈춘다. `legacy-peer-deps` 우회는 쓰지 않는다 — 그 우회 아래에서는
  `npm ls --all` 이 picomatch peer 불일치(vitest → tinyglobby → fdir)까지 보고했다. 지금은 `npm ls --all` 이 exit 0.
- **에뮬레이터 개발 접속**: 에뮬레이터는 tailnet 주소를 쓸 수 없고, `10.0.2.2` 로 붙으면 RN 이 만드는 Origin(`http://10.0.2.2:…`)을 서버가 거절한다(서버 규칙은 바꾸지 않는다).
  개발 클라이언트(`development` 프로필 · Metro 개발 번들)에서만 `EXPO_PUBLIC_DEV_ENDPOINT=ws://10.0.2.2:<서버 포트>/ws` 를 주면 그 주소로 바이트를 보내고
  Origin 헤더는 QR 주소에서 만든 `https://<host>:8577` 을 단다(`src/runtime/socket.ts`). 배포 번들(`__DEV__` 거짓)에는 이 가지가 없다.
  개발 서버는 `CORRAL_USER_DATA=/tmp/…` + 가짜 tailscale(`app/scripts/mobile-repro/README.md` 「가짜 tailscale」) 로 띄운다.
