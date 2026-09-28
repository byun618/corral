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

재현성 확인(C10):

```sh
node app/scripts/gui-diff/compare-runs.mjs <회차폴더A> <회차폴더B> [<회차폴더C> …] --out <md>
```

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
| `--tolerance` | `0.5` | 박스 허용치(px). 잡음 바닥의 근거는 `report.md` 「잡음 바닥」 |
| `--width` `--height` | `1440` `900` | 두 앱에 **같은 인자**로 주는 뷰포트 |
| `--label` | (없음) | 결과 폴더 이름 꼬리표 |
| `--keep` | 끔 | 끝나고 두 앱을 남긴다 (사람이 눈으로 볼 때만) |
| `--no-fresh` | 끔(=매번 새로) | 격리 userData 를 지우지 않고 재사용 |
| `--dump-dom` | 끔 | 영역 루트의 outerHTML 도 덤프 (선택자 짜맞출 때) |

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
      "unpaired": "왜 못 재는지"    // 요소는 있는데 안정 선택자가 없을 때
    }
  ]
}
```

세 가지를 **구분해서** 적는다. 이걸 섞으면 447~450 이 없는 것을 만들러 간다.

- 한쪽 선택자 **없음** = 그 앱에 그 요소가 없다 → `missing` 행
- `unpaired` = 요소는 있는데 안정 선택자가 없어 **못 잰다** → `unpaired` 행 (분류 자동 `보류`)
- 양쪽 다 없음 = 차이 아님

짝짓기 키는 **data 속성 > 구조 경로** 순이다. 글자(문구)와 `aria-label` 은 조인 키로 쓰지 않는다 —
번역·문구 차이가 있는 칸에서 짝이 조용히 깨진다.

## 무엇을 재고 무엇을 안 재나

`lib/probe.mjs` 의 `PROP_SETS` 가 재는 목록, `EXCLUDED_PROPS` 가 **사유와 함께** 뺀 목록이다.
`width`/`height` computed 값은 빼고 박스(`getBoundingClientRect`)만 본다 — 같은 값을 두 번 세지 않는다.

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
lib/diff.mjs          순수 diff (unpaired/missing/count/box/style)
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
- **상태는 주입** (C9) — Orca `window.__store.setAgentStatus`, corral `pane.report_agent`(backend RPC).
  실제 에이전트를 띄우면 시각·진행률이 회차마다 달라 C10 이 성립하지 않는다.
  Orca pane 키는 `${tabId}:${crypto.randomUUID()}` 여야 하고 타임스탬프는 `Date.now()` 여야 한다 —
  형식이 안 맞거나 과거 시각이면 Orca 가 조용히 버린다.
  corral pane 은 `pN` 숫자 순으로 정렬해 물린다 — `pane.list` 순서가 보장되지 않아 상태가 뒤바뀐다.

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

## 정리 (C12)

기본값으로 끝나면 corral desktop · herdr backend · Orca dev 런너(프로세스 그룹)를 닫고
생존 프로세스를 세어 `shutdown.json` 에 남긴다. `--keep` 을 주면 남긴다.
