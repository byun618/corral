# LIFE-597 U8 네이티브 체크리스트 (게이트 ⓪ N1 (가) — 설치본 교체 + herdr 재기동 1회, 출고까지 유지)

누가: **코디**(이 레포 worktree 의 터미널) · **사용자**(맥 앞 + 실제 폰, 설치된 v0.2.0 APK).
워커는 dmg 와 이 문서·도구만 준비했다. 설치·앱 종료·재실행은 하지 않았다.
원자료 자리: 구현 브랜치 `specs/LIFE-597-shell-session-input/raw/coordinator/u8/` (코디가 만든다). 백업 사본은 **커밋하지 않는다**(`/tmp/l597u8-bak/`) — 경로·해시만 커밋.

도구(레포 기준, node v24 — `PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"`):
- `node app/scripts/l597/handshake.mjs` — 설치본 동봉 herdr(`~/.config/corral-herdr/herdr.sock`)에 **읽기 전용** handshake 한 번. `unmanaged_prompt: 1` 이면 종료 0.
  워커가 교체 전에 돌린 기준선: `{"guard_version":1,"agent_ops":1,"unmanaged_prompt":null}` 종료 1(`raw/claude/final/f32-handshake-installed-before.log`).
- `node app/scripts/l597/u8-records.mjs --kind <claude|codex|grok> --cwd <탭 작업 폴더> --marker <표지>` — 표지가 든 사람 줄 수. 정확히 1 이면 종료 0. 본문은 출력하지 않는다.

## ⓪ 사전 백업 (코디, 사용자가 앱을 끄기 전)

설치본 기준 경로(2026-10-11 워커가 읽기 전용으로 확인):

| 대상 | 경로 | 비고 |
| --- | --- | --- |
| userData | `~/Library/Application Support/corral` | 약 1.5 GB(대부분 Chromium 캐시). `rpc.sock`·`owner.json`·`profile.json`·`orchestration/`·`terminal*/`·`mobile/`(기기 토큰 — 커밋 금지) 포함 |
| 동봉 herdr 설정·세션 | `~/.config/corral-herdr` | 약 1 MB — `herdr.sock`·`session.json`·`sessions/`·`herdr-server.log` |
| 동봉 herdr 상태 | `~/.local/state/corral-herdr` | 확인 시점에 없음 — 있으면 같이 |
| 앱 | `/Applications/corral.app` | **되돌리지 않는다**(N1 — 출고 dmg 가 덮는다). 해시만 기록 |

```sh
mkdir -p /tmp/l597u8-bak && chmod 700 /tmp/l597u8-bak
# 소켓·캐시는 빼고 묶는다(소켓은 복원 대상이 아니고 캐시는 재생성된다)
tar -C "$HOME/Library/Application Support" --exclude='corral/*.sock' --exclude='corral/Cache' --exclude='corral/Code Cache' --exclude='corral/GPUCache' --exclude='corral/DawnGraphiteCache' --exclude='corral/DawnWebGPUCache' -czf /tmp/l597u8-bak/userdata.tgz corral
tar -C "$HOME/.config" --exclude='corral-herdr/*.sock' -czf /tmp/l597u8-bak/corral-herdr.tgz corral-herdr
shasum -a 256 /tmp/l597u8-bak/*.tgz > raw/coordinator/u8/u0-backup-hash.txt          # 커밋하는 것은 이 해시만
# 비교 기준(파일 단위 해시 목록 — 캐시·소켓·로그 제외, 경로는 상대)
(cd "$HOME/Library/Application Support/corral" && find . -type f ! -path './Cache/*' ! -path './Code Cache/*' ! -path './GPUCache/*' ! -path './Dawn*' ! -name '*.ndjson' ! -name '*.log' -print0 | sort -z | xargs -0 shasum -a 256) > /tmp/l597u8-bak/userdata-before.sha
shasum -a 256 /Applications/corral.app/Contents/MacOS/corral /Applications/corral.app/Contents/Resources/backend/herdr >> raw/coordinator/u8/u0-backup-hash.txt
node app/scripts/l597/handshake.mjs > raw/coordinator/u8/u0-handshake-before.json; echo "exit=$?"   # 기대 exit 1 (옛 guard)
```

관측: `exit=1` · `unmanaged_prompt: null`. **다른 결과면 멈춘다**(이미 바뀐 설치본이다).

## ① 사용자 — 설치본 종료 → dmg 설치 → 재실행 (동봉 herdr 서버 재기동)

1. 설치본 corral 을 **⌘Q 로 완전히 종료**한다. 동봉 herdr 서버도 같이 내려가야 한다 — 코디가 확인:
   `pgrep -fl '/Applications/corral.app/Contents/Resources/backend/herdr'` → 줄 없음. 남아 있으면 사용자에게 알리고 기다린다(코디가 죽이지 않는다).
   이 순간 **모든 세션(코디 pane 포함)이 내려간다** — 코디는 재개용 메모를 specs 에 먼저 커밋해 둔다.
2. dmg 를 연다: `open <dmg 경로 — raw/claude/final/f33-dmg.txt 의 path>` → `corral.app` 을 `/Applications` 로 끌어 **대치**.
3. corral 을 실행한다. 첫 창이 뜨면 동봉 herdr 가 새로 뜬다.
4. 코디: `node app/scripts/l597/handshake.mjs > raw/coordinator/u8/u1-handshake-after.json; echo "exit=$?"` → **기대 exit 0, `unmanaged_prompt: 1`**.
   `shasum -a 256 /Applications/corral.app/Contents/Resources/backend/herdr` 를 dmg 의 동봉 herdr 해시(f33)와 대조해 기록.
   exit 1 이면 옛 herdr 서버가 남아 있는 것이다 — ①-1 로 돌아간다.

## ② 코디 — 설치본에 새 탭 → 셸에서 provider 직접 타자

1. 설치본 GUI 에서 **새 탭**(셸)을 연다 — 작업 폴더는 이 작업 전용 빈 레포(예: `mkdir -p /tmp/l597u8/repo && git -C /tmp/l597u8/repo init`), 사용자 레포가 아니다.
2. 그 탭의 셸에 **직접** `claude --model claude-haiku-5-5` 를 친다(설치본 GUI 의 「에이전트 실행」 이 아니라 셸 타자 — 관리 밖). 신뢰 확인이 뜨면 맥에서 답한다.
3. 같은 방식으로 탭 두 개를 더: `codex -c check_for_update_on_startup=false` · `grok`. Codex 는 맥에서 첫 지시 1회(세션 참조가 생겨야 폰 목록에 뜬다 — `no_session`).
4. 관리 밖인지 확인(읽기 전용): `corral terminal show --terminal <handle> --json` 의 `agent.evidence.interactiveReady` 가 **false**. 화면 캡처 → `u2-tabs.png`.

## ③ 사용자 — 폰(v0.2.0 APK)으로 지시

각 지시에 **표지**를 넣는다(예: `u8-1 한국어로 짧게 OK 라고만 답해`). 폰에서 `들어감 ✓` 가 뜨는지 본다.

| 회차 | 채널 | 글 | 관측 |
| --- | --- | --- | --- |
| u8-1 | claude 탭 | `u8-1 …`(한글) | `들어감 ✓` |
| u8-2 | claude 탭 | `u8-2 …` | `들어감 ✓` |
| u8-3 | claude 탭 | `u8-3 …`(한글) | `들어감 ✓` |
| u8-4 | claude 탭 — **작업 중에** | 맥에서 먼저 `Run sleep 15 then reply DONE` 을 지시하고, 도는 동안 폰으로 `u8-4 …` | 폰 「대기 중 · 이 턴이 끝나면 들어갑니다」 → 턴 뒤 `들어감 ✓` |
| u8-5 | codex 탭 | `u8-5 …` | `들어감 ✓` |
| u8-6 | grok 탭 | `u8-6 …` | `들어감 ✓` |

폰 화면 캡처(회차마다 `들어감 ✓` 줄) → `u3-phone-<회차>.png`. **기기 토큰·페어링 코드가 보이는 화면은 찍지 않는다.**
`대기 중` 이 3 s 남짓 보였다 들어가는 것은 정상이다(막 끝난 턴·막 띄운 세션의 settle).

## ④ 코디 — 회차마다 기록 1건 대조

```sh
node app/scripts/l597/u8-records.mjs --kind claude --cwd /tmp/l597u8/repo --marker u8-1 >> raw/coordinator/u8/u4-records.ndjson   # u8-1·2·3·4 — 각각 count 1
node app/scripts/l597/u8-records.mjs --kind codex  --cwd /tmp/l597u8/repo-codex --marker u8-5 >> raw/coordinator/u8/u4-records.ndjson
node app/scripts/l597/u8-records.mjs --kind grok   --cwd /tmp/l597u8/repo-grok  --marker u8-6 >> raw/coordinator/u8/u4-records.ndjson
```

(탭마다 작업 폴더가 다르면 그 폴더를 `--cwd` 로.) 회차마다 `count: 1` · 폰 `들어감 ✓` 가 짝이어야 통과다. 0·2 는 실패 — 실패 회차도 지우지 않는다.
u8-4 는 기록에서 `DONE` 답 뒤에 `u8-4` 줄이 오는지도 본다(대기 → 턴 뒤).

## ⑤ 사후

- userData 대조: ⓪ 의 `find … | shasum` 을 다시 돌려 `userdata-after.sha` → `diff` 의 바뀐 줄 **수와 파일 이름 종류**만 기록(`u5-userdata-diff.txt`). 앱 실행으로 바뀌는 파일(설정·런타임 기록)은 정상이다 — 지워진 파일이 없고 `mobile/` 기기 목록이 그대로인지 본다.
- `.app` 은 **되돌리지 않는다**(N1 — 원래 `.app` 으로 되돌리면 도는 herdr 서버의 실행 파일이 바뀐다, 상류 #4474). 출고 dmg 가 덮는다.
- 백업 `/tmp/l597u8-bak/` 은 사용자 확인 뒤 지운다(validation.md 원자료 보관 — 사용자 데이터 사본은 출고 때 삭제).
- provider 전역 설정: `~/.codex/config.toml`·`~/.grok/config.toml`·`~/.grok/trusted_folders.toml` 해시를 ② 전·⑤ 뒤 대조. Codex·Grok 이 새 폴더 신뢰를 스스로 적으면(워커 격리 회차에서 Codex 가 `[projects."<폴더>"] trust_level` 3블록을 붙였다) 백업 바이트로 복원하고 그 사실을 적는다. `~/.claude.json` 은 해시 관문에 넣지 않는다.
- 판정표 행: `raw/claude/runs.md` 와 같은 형식으로 코디가 `u8-*` 행을 덧붙인다(실행 id · 기준 · 명령/손 동작 · 기대 · 실제 · 원자료 · 통과/실패).
