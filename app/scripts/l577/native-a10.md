# A10 네이티브 회차 체크리스트 (LIFE-577)

설치본(구현 브랜치 dmg) + 실제 Tailscale 에서 코디·사용자가 돌린다. 스크립트는 `native-a10.mjs` — **tailscale 에 쓰지 않는다**
(`version`·`status --json`·`serve status --json` 읽기만). serve 항목을 올리고 내리는 것은 corral 앱이다. 실제 Funnel 은 켜지 않는다.

```sh
cd app
RAW=../specs/LIFE-577-mobile-server/raw/a10     # 기본값. 다른 곳이면 --raw <폴더>
node scripts/l577/native-a10.mjs <걸음>
```

토큰·전후 원본은 `/tmp/l577a10`(0700, 커밋 안 함)에만 두고 `f` 에서 지운다. 원자료(`$RAW/a10-*.txt`)에는 토큰·코드 `<redacted>`,
맥 이름 `<mac-name>`, 노드 이름 `<host>`, tailnet 이름 `<tailnet>` 만 남는다 — 커밋 전에 그래도 한 번 grep 한다.
tailnet 이름·주소는 `status --json` 에서 읽는다(하드코딩 없음).

| # | 누가 | 할 일 | 판정 | 원자료 |
| --- | --- | --- | --- | --- |
| 0 | 코디 | 설치본 userData(`~/Library/Application Support/corral`) 백업·해시, 원래 `/Applications/corral.app` 백업(커밋 안 함) → dmg 설치 | — (코디 기록) | 코디 원장 |
| 1 | 스크립트 | `pre` — 로그인·HTTPS 인증서·Funnel 꺼짐·8577 비어 있음, serve 전 원본 보관 | 하나라도 미달이면 **여기서 멈춤**(아무것도 안 바뀐 상태) | `a10-00-pre.txt` |
| 2 | 사람 | **A10ⓐ** 설치본 › 설정 › Mobile › 「Mobile 켜기」. 점검표 4줄 ✓ · 상태 「노출됨」 확인(캡처 권장) | 화면 확인 | 캡처(코디 재량) |
| 3 | 스크립트 | `b` — **A10ⓑ** serve 전후: corral 항목 1개만 추가 · Funnel 꺼짐 유지 | 미달 → 멈춤·원복 | `a10-02-serve-diff.txt` |
| 4 | 사람+스크립트 | 「QR 만들기」 → `c` 실행 → 화면의 8자 코드 입력(에코 없음). **A10ⓒ** `wss://<CertDomains[0]>:8577/ws` 로 pair·hello·ping + 미페어링 거절 양성 대조 | 미달 → 멈춤·원복 | `a10-03-repro.txt` |
| 5 | 스크립트 | `d` — **A10ⓓ** 앱 프로세스 트리 LISTEN 이 127.0.0.1 만 | 미달 → 멈춤·원복 | `a10-04-lsof.txt` |
| 6 | 사람+스크립트 | `e` 를 먼저 띄우고 → 사람이 **⌘Q**(메뉴 corral › 종료) → 스크립트가 제거 확인 → 사람이 **Finder** 에서 corral.app 열기 → 재등록 확인. **A10ⓔ + A7ⓓ**(Finder 기동 ppid 1 에서 CLI 를 찾는다) | 미달 → 멈춤·원복 | `a10-05-quit-relaunch.txt` |
| 7 | 사람+스크립트 | 「Mobile 켜기」 끄기 → `f` — **A10ⓕ** serve 가 `pre` 와 같다(`{}` 였으면 `{}`) · 사람이 기기 「a10-repro」 해지 · 토큰 파일 지움 | 미달 → 멈춤·원복 | `a10-06-off-restore.txt` |
| 8 | 코디 | **A10ⓖ** 원래 `.app` 복원 · userData 해시 대조 · `/tmp/l577a10` 삭제 | 해시 일치 | 코디 원장 |

아무 때나 `node scripts/l577/native-a10.mjs status` — 지금 corral 항목·Funnel·앱 pid(원자료 `a10-99-status.txt`).

## 멈춤·원복 (어느 걸음이든 미달이면)

1. 더 진행하지 않는다. 그 걸음의 원자료를 지우지 않는다(실패 회차도 원자료).
2. 설치본에서 「Mobile 켜기」 를 끈다 → `status` 로 corral 항목이 사라졌는지 본다.
3. 앱이 응답하지 않으면 ⌘Q(안 되면 강제 종료) → `status`. 켜 둔 채 죽었으면 다음 기동이 소유 기록과 대조해 정리한다 — 끈 상태로 한 번 띄웠다 닫는다.
4. 그래도 `<host>:8577 /` 가 남으면 **사람이** 직접(스크립트는 실행하지 않는다):
   `tailscale serve --yes --https=8577 --set-path=/ off` — 이 한 줄만. `serve reset` 은 남의 항목까지 지우므로 쓰지 않는다.
5. `status` 의 serve 가 `pre` 원본과 같은지 확인 → 0번에서 백업한 `.app` 복원 · userData 해시 대조(8번).

## 드라이런 (가짜 CLI · 개발 실행)

실제 tailscale 쓰기 없이 이 스크립트 경로를 한 번 돌린 기록: `node scripts/l577/g-run.mjs a10dry <ROOT> <FAKE> [OUT]`.
환경 `A10_TAILSCALE`(가짜 CLI) · `A10_APP_MATCH`(개발 실행 userData) · `A10_URL`(`ws://127.0.0.1:<서버 포트>/ws` — 가짜 호스트는 DNS·TLS 가 없다) ·
`A10_STATE` · `A10_RAW` 로 바꾸고, 사람 걸음(켜기·QR 코드·⌘Q·Finder 기동·끄기·해지)은 제어 소켓 DOM 합성과 SIGTERM·g-up 재기동으로 대신한다.
그래서 드라이런은 **스크립트가 도는가**만 본다 — wss·실제 serve·⌘Q 키·Finder 기동(A7ⓓ)은 네이티브 회차에서만 판정한다.
