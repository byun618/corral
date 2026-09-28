# gui-diff — Orca ↔ corral GUI 동일성 측정 도구 (LIFE-443)

명령 하나가 **두 실제 앱**(Orca 개발 인스턴스 · corral 격리 인스턴스)을 띄우고, 같은 fixture 레포를
물리고, 상태를 맞춘 뒤 영역별로 캡처·스타일 덤프·diff 해서 `report.md` + `*.json` 을 쓴다.

LIFE-447~450 은 **착수 전과 끝난 뒤에 같은 명령을 다시 돌려** "거의 같다" 를 판정한다.
그래서 이 폴더는 일감 번호 폴더가 아니라 고정 이름이다.

## 한 줄 사용법

```sh
~/.nvm/versions/node/v24.14.1/bin/node app/scripts/gui-diff/measure.mjs \
  --areas sidebar,tabbar --states default,agents-2,agents-5 --label before-448
```

결과는 `specs/LIFE-443-gui-diff/raw/claude/measure/<ISO타임스탬프>-<label>/` 에 떨어지고,
그 폴더의 `report.md` 가 사람이 읽는 표다. 실행 한 번은 `specs/LIFE-443-gui-diff/raw/claude/runs.md`
(명시 실행 목록)에 **도구가 스스로** 한 행 적는다 — 실패 회차도 적는다.

양성 대조(C6)까지 보려면 `--controls` 를 준다 — 기본 실행은 대조를 돌지 않는다(아래 「양성 대조」).

재현성 확인(C10):

```sh
node app/scripts/gui-diff/compare-runs.mjs <회차폴더A> <회차폴더B> [<회차폴더C> …] --out <md> --ledger <원장>
```

이 검사는 집합 비교 **전에 회차 유효성**을 본다 — diff 가 한 칸도 없거나 요청한 칸이 빠졌거나
그 회차가 자기 관문을 통과하지 못했으면 비교하지 않고 실패한다. **아무것도 재지 않은 회차 둘은
「같은」 회차가 아니다.** 판정 알맹이는 `lib/compare.mjs` 에 있고 단위 테스트가 있다.

## 전제 (없으면 못 돈다)

| 전제 | 확인 | 왜 |
| --- | --- | --- |
| **node ≥ 22** | `node -v` | 전역 `WebSocket`(raw CDP). 이 셸 기본은 node 20 이라 **절대경로로 node 24 를 부른다**. 아니면 즉시 종료코드 2 |
| Orca 소스 체크아웃 | 기본 `/tmp/l443/orca-198` (`--orca-repo` 로 변경) | 설치본과 같은 태그(`v1.4.198`)를 개발 모드로 띄운다 |
| Orca 쪽 pnpm 설치 완료 | 그 체크아웃에서 `pnpm install` | dev 런너가 electron-vite 를 쓴다 |
| corral 빌드 산출물 | 이 레포에서 `npm run build` (`app/out/`) | corral 은 dev 가 아니라 **빌드 산출물**로 띄운다 (아래 「비대칭」) |
| macOS | — | 설치본 대조(C3)가 `screencapture`·CoreGraphics 창 목록에 기댄다 |

## 인자

| 인자 | 기본 | 뜻 |
| --- | --- | --- |
| `--areas` | `sidebar,tabbar` | 영역 정의 파일 이름(쉼표). `areas/<이름>.json` |
| `--states` | `default,agents-2` | 상태 이름(쉼표). `default` · `agents-2` · `agents-5` |
| `--out` | `specs/LIFE-443-gui-diff/raw/claude/measure` | 결과 폴더의 부모 |
| `--ledger` | `specs/LIFE-443-gui-diff/raw/claude/runs.md` | 명시 실행 목록 |
| `--work` | `/tmp/l443` | 격리 userData·HOME·fixture 를 두는 작업 폴더 |
| `--orca-repo` | `/tmp/l443/orca-198` | Orca 소스 체크아웃 |
| `--tolerance` | `0.5` | 박스 허용치(px). 근거는 회차마다 함께 내는 **허용치 0 자기 diff** 다 (`report.md` 「잡음 바닥」의 두 칸) |
| `--width` `--height` | `1440` `900` | 두 앱에 **같은 인자**로 주는 뷰포트 |
| `--label` | (없음) | 결과 폴더 이름 꼬리표 |
| `--controls` | 끔 | 양성 대조(C6)를 함께 돌고 판정한다. **방향과 종류까지** 본다 — 부재 방향이 뒤집히거나 차이 종류가 다르면 실패 |
| `--keep` | 끔 | 끝나고 두 앱을 남긴다 (사람이 눈으로 볼 때만). **정리(C12)를 돌지 않으므로** 그 회차는 원장에서 C12 `해당 없음` 으로 적힌다 |
| `--no-fresh` | 끔(=매번 새로) | 격리 userData 를 지우지 않고 재사용 |
| `--dump-dom` | 끔 | 영역 루트 아래 DOM 윤곽(태그·속성·박스)을 덤프 (선택자 짜맞출 때). outerHTML 이 아니다 |

## 영역을 늘리는 법 — 코드가 아니라 데이터 (C1)

`areas/<이름>.json` 파일을 하나 두면 `--areas <이름>` 으로 바로 잡힌다. `measure.mjs` 는 안 고친다.

```jsonc
{
  "root": { "orca": "<선택자>", "corral": "<선택자>" },
  "units": [
    {
      "id": "repo-header-icon",
      "note": "사람이 읽는 설명 — 보고서 행 이름이 된다",
      "orca": "<선택자>",          // 루트 기준 querySelector. 없으면 「그 앱에 없다」 선언
      "corral": "<선택자>",
      "props": ["box", "paint", "text"],
      "global": true,              // 루트 밖(document 기준)에서 찾는다
      "unpaired": "왜 못 재는지",   // 요소는 있는데 **같은 의미의 짝**이 없거나 안정 선택자가 없을 때
      "parent": "tab",              // **부모 단위 id** — 이 자식은 그 부모 **안에서만** 재고 짝짓는다
      "parentWhy": "왜 부모 단위인지",
      "conditional": true,          // 조건부 렌더(임계·hover·상태 의존) — 안 잡혀도 선택자 부패가 아니다
      "conditionalWhy": "왜 조건부인지",
      "axis": "tabCount"            // 이 단위가 어느 상태 축에 달려 있는지 (사람이 읽는 표시)
    }
  ]
}
```

네 가지를 **구분해서** 적는다. 이걸 섞으면 447~450 이 없는 것을 만들러 간다.

- 한쪽 선택자 **없음** = 그 앱에 그 요소가 없다 → `missing` 행 (「선언한 부재」)
- `unpaired` = 요소는 있는데 **같은 의미의 짝이 없거나** 안정 선택자가 없어 **못 잰다** → `unpaired` 행 (분류 자동 `보류`)
- 양쪽 선택자가 다 있는데 한쪽에서 **안 잡혔다** = `conditional` 로 표시한 단위면 `missing`,
  아니면 `selector-miss` 로 내고 **그 회차의 관문을 실패시킨다** — 선택자 부패를 「차이 없음」으로
  조용히 넘기지 않는다
- **양쪽 다** 0개인데 조건부·선언 부재가 아니면 = `selector-miss` (측정 실패, 관문 실패) — 양쪽 선택자가
  같이 썩은 자리를 「차이 없음」으로 통과시키지 않는다
- 선언한 부재가 양쪽 다면 = 차이 아님

**같은 의미의 요소끼리만 짝짓는다.** 점↔점, 로고↔로고, 행↔행이다. Orca 의 요약 패널과 corral 의
세션 행처럼 의미가 다른 둘을 짝지으면 그 행의 박스·스타일 차이는 제품 차이가 아니라 짝짓기 오류다.

**여러 개 있는 것은 부모 단위로 묶는다** (`parent`). 탭·카드의 **순번이 키**이고, 자식은 그 부모 안에서만
견준다. 자식이 없는 부모는 **그 자리에 부재**를 적어 순번이 밀리지 않는다 — 전역 순번으로 묶던 판은
Orca 가 idle 탭에 상태 점을 안 그리는 자리에서 **다른 탭의 점끼리** 비교했고, 그 거짓 차이(x −122.78px)가
보고서에 「해소 대상」으로 실렸다. 자식 선택자는 부모 **아래**를 먼저 보고, 없으면 **부모 자신**이
그 선택자인지 본다(`.main-tab.is-active` 처럼 부모 자신의 상태를 재는 단위).

부모가 없는 단위는 전역 순번으로 묶고, 걸린 요소를 **전부** 잰다(`[N번째]`, 상한 12 — 넘치면
`itemsTruncated`). 개수가 다르면 겹치는 순번까지만 보고, 개수 차이는 따로 한 건으로 나간다.

짝짓기 키는 **data 속성 > 구조 경로** 순이다. 글자(문구)와 `aria-label` 은 조인 키로 쓰지 않는다 —
번역·문구 차이가 있는 칸에서 짝이 조용히 깨진다.

## 무엇을 재고 무엇을 안 재나

`lib/probe.mjs` 의 `PROP_SETS` 가 재는 목록, `EXCLUDED_PROPS` 가 **사유와 함께** 뺀 목록이다.
`width`/`height` computed 값은 빼고 박스(`getBoundingClientRect`)만 본다 — 같은 값을 두 번 세지 않는다.

폰트는 **선언값과 렌더 폰트를 따로** 낸다 — `font-family`(선언)는 `style` 차이로, Chromium 이 실제로
고른 글꼴(`CSS.getPlatformFontsForNode`)은 `font` 차이로 낸다. 선언이 같아도 렌더가 다를 수 있다.

**잰 요소 전부**에서 받는다(대표 하나가 아니다). 페이지 안에서 요소마다 `data-l443-node="<단위>#<순번>"`
표시를 달고 CDP 가 그 표시로 같은 노드를 집는다 — 한 요소가 여러 단위에 걸릴 수 있으므로 표시는
**덧붙이고** `~=` 로 찾는다(덮어쓰면 앞 단위의 폰트가 「수집 실패」로 남는다). 표시는 캡처 뒤 지운다.
못 받은 자리는 「같다」가 아니라 **공백(사유)** 다: `수집 실패` · `글리프 없음` · `한쪽 부재` 를 구분해
보고서 「렌더 폰트를 못 잰 자리」 표에 적고, **수집 자체가 깨진 회차는 관문이 실패한다.**

박스 차이는 **허용치 아래도 버리지 않는다** — `belowTolerance` 로 세어 보고서에 따로 적고,
반올림은 부호 대칭이다(`sign(raw) * round(abs(raw)*100)/100`). 허용치의 근거는 같은 회차의
**허용치 0 자기 diff** 다 — 보고서 「잡음 바닥」에 허용치 0 칸과 그 최대 델타를 함께 낸다.

측정 조건은 두 앱에 똑같이 건다: `Emulation.setDeviceMetricsOverride`(같은 인자) ·
`Emulation.setFocusEmulationEnabled`(포커스 비대칭 제거) · `document.fonts.ready` ·
`*{transition:none;animation:none;caret-color:transparent}` 주입.

## 구조

```
measure.mjs           단일 명령 — 기동·시딩·상태·캡처·diff·보고·정리
compare-runs.mjs      C10 재현성 — 회차 폴더들의 차이 집합 대조
diff.test.mjs         diff 로직 단위 테스트 (node --test, I/O 없음)
areas/*.json          영역 정의 (데이터)
lib/cdp.mjs           raw CDP 클라이언트 (Playwright 안 씀 — 아래 「선택과 사유」)
lib/probe.mjs         페이지 안에서 도는 수집기 + 안정화
lib/diff.mjs          순수 diff (unpaired/selector-miss/missing/count/box/style/font)
lib/own.mjs           소유 판정(pid·자손·경로 경계) 순수 규칙 — 남의 프로세스를 죽이지 않는 자리
lib/png.mjs           최소 PNG 읽기/쓰기 + ROI 대조 (C3 양성·음성 대조)
lib/controls.mjs      양성 대조 정의와 판정 (방향·종류까지 본다)
lib/compare.mjs       C10 회차 유효성·집합 비교 (순수)
lib/runs.mjs          명시 실행 목록(runs.md) 행 쓰기 — 시작 때 쓰고 끝에 고쳐 쓴다
lib/report.mjs        json + md 쓰기 (C7 7칸 표)
lib/fixture.mjs       버리는 fixture git 레포
lib/orca.mjs          Orca 개발 인스턴스 기동·시딩·상태 주입
lib/corral.mjs        corral 격리 인스턴스 기동·시딩·상태 주입
installed-compare.mjs C3 설치본 읽기 전용 대조
```

## 선택과 사유

- **raw CDP, Playwright 아님** — 기존 자산(`app/scripts/l391-first/gui-verify.mjs`)이 이미 raw CDP 로
  Electron 에 붙는다(C11 「기존 자산에서 출발」). Playwright 의 `connectOverCDP` 는 기본으로
  포커스·미디어를 에뮬레이션해 두 앱에 비대칭을 심는다.
- **두 앱 다 CDP 한 채널** — corral 제어 소켓(`shot`·`computed-style`)과 CDP 를 섞으면
  같은 수치를 서로 다른 경로로 재게 된다. 제어 소켓은 시딩(`add-repo`·`rebuild-tree`)에만 쓴다.
- **Orca 는 dev, corral 은 빌드 산출물** — 여기만 비대칭이다. Orca 개발 인스턴스는 C3 이 요구하고,
  corral 은 dev 서버 없이 `out/` 으로 뜬다. 그래서 Vite 가 주입한 style 태그 수를 스냅샷 `meta.devStyleTags` 에
  따로 적고, 오류 오버레이만 `devOverlays` 로 센다 — dev 흔적을 차이로 착각하지 않게.
- **OS 창 크기 대신 뷰포트 override** — Electron 은 `Browser.getWindowForTarget`/`setWindowBounds` 를
  구현하지 않는다(두 앱 모두 `-32601`). `Emulation.setDeviceMetricsOverride` 를 **같은 인자로** 걸어
  대칭을 만들고, 그 사실을 보고서 「측정 조건」에 적는다.
- **상태는 주입하고, 주입 결과를 검증한다** (C9) — 실제 에이전트를 띄우면 시각·진행률이 회차마다
  달라 C10 이 성립하지 않는다. 그래서 두 앱 모두 **제품 경로**로 상태를 만든다:
  Orca `window.__store` 의 `createTab`/`closeTab`/`setAgentStatus`, corral herdr RPC
  `tab.create`/`tab.close`/`pane.report_agent`.
  주입 뒤 **여섯 축**을 두 앱에서 읽어 요청과 견주고, 한 축이라도 어긋나면 그 회차는 **실패**다:
  탭 수 · 에이전트 수 · 상태 분포 · 활성 탭 순번 · 화면 표현(각 앱의 자기 기대) ·
  **탭 점이 backend 집계에 탭마다 수렴**(corral). 마지막 축은 정렬한 점 목록 비교가 아니라
  **탭 id 별 대응**이다 — 「점 3개가 accent」가 맞고 그것이 다른 탭일 수 있다. 못 맞추는 축은
  `reproduced:false` + 사유로 남기고, 그 상태의 차이 행은 분류에서 「보류」로 내려간다 —
  **하네스가 만든 차이를 제품 차이로 보고하지 않기 위한 관문이다.**
  알게 된 제약:
  - Orca pane 키는 `${tabId}:${crypto.randomUUID()}` 여야 하고 타임스탬프는 `Date.now()` 여야 한다 —
    형식이 안 맞거나 과거 시각이면 Orca 가 조용히 버린다(30분 staleness 필터). 새 상태를 넣기 전에
    이전 주입을 `removeAgentStatusByTabPrefix` 로 지운다.
  - Orca 요약 패널의 "N agents" 문구는 `aria-label` 에만 있고 **번역된다** — 오라클로 못 쓴다.
    그래서 개수 오라클은 스토어 행 수이고, 화면 오라클은 **표현 모양**(none/row/summary)이다.
  - Orca 탭 선택은 **실제 마우스 입력**이어야 한다(dnd-kit) — CDP `Input.dispatchMouseEvent`.
    `element.click()` 으로는 활성 탭이 바뀌지 않는다.
  - corral 은 이미 `working` 이던 pane 에 `idle` 을 보고하면 `done` 으로 바꾼다 — 그래서 상태마다
    **새 탭**을 만들고 이전 탭을 닫는다. pane 재사용은 요청한 상태 분포를 조용히 바꾼다.
  - corral 탭 점은 탭 단위 집계라, 제어 소켓 `resync` 뒤 **우리 쪽 herdr 연결**의 `snapshot.tabs` 에
    화면이 수렴할 때까지 기다린다(제3 오라클).

## 양성 대조 (C6) — 기본이 아니라 `--controls`

알려진 차이 둘(Orca 에만 있는 "N agents" 묶음 · 레포 헤더 아이콘 vs 이니셜 사각형)을 도구가 잡는지
본다. 판정은 **존재/부재만 보지 않고 방향과 종류까지** 본다 — 부재 방향이 뒤집혀도 통과가 되던
자리를 막았다. 전제(Orca `compact` 표시 + send-target 모드 아님)가 깨진 회차는 통과로 세지 않는다.

**왜 모든 실행의 관문이 아닌가**: 447~450 이 그 차이를 실제로 해소하면 대조는 실패해야 정상이다.
관문으로 두면 도구가 성공한 회차를 실패로 만든다. 그리고 `--areas`/`--states` 를 좁혀 부분만 재는
회차에서는 대조 상태가 아예 없다. 그래서 명시 모드다 — `--controls` 없이 돈 회차는 **C6 의 근거가
아니다**(보고서가 그렇게 적는다).

## 격리 (C2) — 사용자 자원 무접촉

- Orca dev 는 **버리는 `HOME`**(`<work>/orca-dev-home`)으로 띄운다. Orca 의 hook 설치기는
  `os.homedir()` 를 보므로 `CLAUDE_CONFIG_DIR` 만으로는 막히지 않는다. 실제
  `~/.claude/settings.json`·`~/.codex/` hook 파일 해시는 측정 전·후 같아야 한다
  (양성 대조: 버리는 HOME 쪽에는 hook 이 **써졌다** — `raw/claude/c2/disposable-home-listing.txt`).
- Orca userData 는 경로에 `orca-dev` 를 포함해야 한다 — devMode 판정이 문자열 포함 검사다.
- corral 은 전용 `CORRAL_USER_DATA` · 전용 herdr 세션(`l443-gui-diff`) · 전용 제어 소켓으로 띄운다.
  사용자 기본 userData 와 herdr 기본 세션은 건드리지 않는다.
- fixture 는 `<work>/gui-diff-fixture` 의 버리는 git 레포다. corral 레포 자체를 두 앱에 등록하지 않는다.
- 설치본 Orca 는 이 하네스의 제어 런타임이다 — **재시작·입력 금지**, 읽기 전용으로만 본다.

## 정리 (C12) — **소유한 것만** 닫는다

소유의 **1순위는 기동 때 받은 pid 와 그 자손**이다. 죽이기 전에 `pgrep -P` 로 자손을 적어 두고
(부모를 먼저 끝내면 부모 관계가 끊겨 손자를 못 찾는다) 그 목록만 신호를 보낸다. pid 마다
`process.kill(pid, 0)` 으로 죽었는지 확인해 `shutdown.json` 에 적고, 정리에 실패하면 **종료코드 1** 과
원장 행에 남긴다.

- **등록은 spawn 직후**다. launcher 가 성공 handle 을 돌려준 뒤가 아니다 — CDP 대기가 타임아웃되면
  앱은 떠 있는데 정리 목록이 비는 자리를 막았다. 경로 소유는 폴더를 만든 순간부터다.
- **경로 검사는 보조이고, 경계까지 정확히 비교한다** (`lib/own.mjs`). `pgrep -f <경로>` 는 부분 문자열
  일치라 `<경로>-other` 를 쓰는 **남의 Electron** 도 잡는다. 그래서 pgrep 은 후보만 만들고, 소유는
  argv 옵션 값(`--user-data-dir=`·crashpad `--database=`)이 소유 경로 자신이거나 그 **아래**일 때만
  인정한다. 거른 후보와 사유는 `shutdown.json` 의 `diagnostics.rejectedCandidates` 에 남는다.
- **이름 검색(`pgrep -fl <이름>`)은 진단이다 — 죽이는 근거가 아니다.**
- `--no-fresh` 는 격리 프로필을 남기므로, **이번 실행 전부터** 그 경로를 쓰던 pid 를 시작 시점에
  `preexisting` 으로 적고 정리에서 건드리지 않는다. 재사용과 소유는 다르다.
- **격리 userData 삭제는 포트·사용 중 검사 뒤에만** 한다(`assertPortFree`, 프로필 사용 중 검사).
- `--keep` 을 주면 남긴다 — 그 회차는 정리를 돌지 않으므로 원장에 C12 `해당 없음` 으로 적힌다.

## 설치본 대조의 양성·음성 대조 (C3)

```sh
node app/scripts/gui-diff/installed-compare.mjs --control \
  --installed <설치본.png> --dev <개발본.png> --ledger <원장>
```

**앱을 건드리지 않는다** — 이미 찍어 둔 PNG 만 읽는다. 하는 일은 「이 비교 방법이 차이를 보는가」를
값으로 내는 것이다: 원본↔원본(음성, 0 이어야 한다) · 원본↔**사본**(양성 — ROI 색을 Δ1·2·4·8 옮기고,
ROI 내용을 1·2·4px 밀어 본다). 그 위에서 설치본↔개발본의 **크롬 배경 밴드**를 같은 함수로 견준다.

한계를 결과에 함께 적는다: 선언한 ROI 밖은 비교하지 않으므로 **전체 동일성 증명이 아니고**,
균일한 배경 ROI 에서는 **이동을 검출하지 못한다**(구조가 없으면 밀어도 픽셀이 그대로다 — 그래서
기하 민감도는 구조가 있는 ROI 에서만 말한다). 설치본 창에는 fixture 가 아니라 사용자의 실제 작업
상태가 떠 있어 **내용**은 겹칠 수 없다.
