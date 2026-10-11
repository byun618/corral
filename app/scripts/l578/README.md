# l578 — 모바일 앱 최종 관문 격리 회차 도구 (LIFE-578)

에뮬레이터(`emulator-5554` 만) + 개발 Electron(`/tmp/l578g-*`, 가짜 tailscale) 실제 모바일 서버. 설치본·실제 tailscale·폰 무접촉.

| 파일 | 하는 일 |
| --- | --- |
| `relay.mjs` | 고정 포트(127.0.0.1:18577) TCP 중계 → 서버의 바뀌는 포트. 상태 파일 `{"target":<포트>,"frozen":bool}` — `frozen` 이면 바이트·끊김을 버린다(half-open) |
| `srv.mjs` | 개발 Electron 제어 소켓 — `status` · `enable <relay 상태>`(설정 › Mobile 켜기 + 중계 대상 갱신) · `disable` · `pairing <비밀 파일>`(페이로드를 0600 새 파일에만) · `revoke <id\|all>` |
| `emu.mjs` | 에뮬레이터 UI — `texts` · `tap "<글자>"` · `wait`/`gone "<글자>" [ms]` · `shot <png>` (uiautomator dump · input tap · screencap) |
| `qr.mjs` | 페이로드 → QR PNG(가상 장면 포스터 시도용 — 헤드리스 에뮬레이터에서 카메라 미리보기가 검게 나와 스캔은 못 돌렸다) |
| `native-p12.md` | P12 네이티브 회차 체크리스트(코디·사용자) |

## 순서

```sh
cd app
mkdir -p /tmp/l578g-fa && echo '{"backendState":"Running","dnsName":"fake-mac.example.ts.net","certDomains":["fake-mac.example.ts.net"],"serve":{}}' > /tmp/l578g-fa/state.json
sh scripts/l577/g-up.sh /tmp/l578g-a /tmp/l578g-fa             # 개발 Electron (ROOT /tmp/l578g-* 허용)
node scripts/l578/relay.mjs 18577 /tmp/l578g-a/relay/state.json /tmp/l578g-a/relay/events.ndjson &
node scripts/l578/srv.mjs /tmp/l578g-a enable /tmp/l578g-a/relay/state.json
# 앱: 개발 변형(APP_VARIANT=development) 디버그 빌드 + Metro(EXPO_PUBLIC_DEV_ENDPOINT=ws://10.0.2.2:18577/ws)
#     Origin 은 QR 주소(https://fake-mac.example.ts.net:8577)로 단다 — 서버 Origin 규칙 그대로(mobile/src/runtime/socket.ts)
```

끝나면: `srv.mjs revoke all` → `srv.mjs disable` → relay 종료 → `sh scripts/l577/g-down.sh /tmp/l578g-a term herdr` → 고아(PPID 1) 확인.
