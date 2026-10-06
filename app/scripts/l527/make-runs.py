import json, re
B = 'build'
rows = []
def row(crit, cmd, want, got, raw, verdict):
    rows.append((crit, cmd, want, got, raw, verdict))
P = '통과'; F = '실패'
row('G6(전)', '사용자 설정 5개 `shasum -a 256` + 설치본 Orca·corral Electron 프로세스 확인', 0, 0, '`g6-before.txt`', '통과 (c6 값과 5개 모두 같음, 사용자 corral Electron 없음)')
row('K7 before 빌드', '`git archive 56446ed5` → `/tmp/l527-base/app` `npm run build`', 0, '미확정', f'`{B}/before-build.log` · `{B}/before-head.txt`', '미확정 — 로그에 종료코드 줄이 없다(산출물 `/tmp/l527-base/app/out` 은 있고 K7 before 측정이 그 빌드로 돌았다)')
# measure ledger
for line in open('measure-runs.md'):
    m = re.match(r'^\| (R\d+) \| ([^|]*) \| `([^`]*)` \| (\d+) \| (\d+) \| ([^|]*) \| (.*) \|$', line.strip())
    if not m: continue
    rid, crit, cmd, want, got, raw, verdict = m.groups()
    raw = raw.strip().replace('specs/LIFE-527-titlebar/raw/claude/', '')
    note = ''
    if 'k7-' in raw and got == '1' and '504' in verdict: note = ' (504 가드가 측정을 띄운 래퍼 셸 자신을 잡음 — 가드 정상 동작, 래퍼를 파일 실행으로 바꿔 r2)'
    if raw.endswith('k7-before-a-r2'): note = ' (옛 빌드엔 `[data-sidebar-head]` 없음 → corral 선택자에 `[data-brandbar]` 대체 추가, a 묶음 전후 r3)'
    if raw.endswith('before-titlebar'): note = ' (옛 corral 에 없는 머리 단위 — conditional 로 고침)'
    row(f'K7 측정(measure-runs {rid}) {crit.strip()}', f'`{cmd}`', want, got, f'`{raw}` · `{B}/measure-*.stdout`', verdict.strip()[:160] + note)
row('K7 측정(디버그 --keep, 판정 외)', '`measure.mjs --keep …` (debug-keep)', 0, '미확정', '`debug/`', '미확정 — --keep 프로세스가 끝나지 않아 measure pid 를 죽였다(판정에 쓰지 않음)')
row('K7 대조표', '`node app/scripts/l527/k7-compare.mjs`(= /tmp/l527-k7cmp.mjs) → `k7-diff-before-after.md`', 0, 0, '`k7-diff-before-after.md`', '실패 — 탭바 영역 접힘 3장면에서 차이 수 +8(영역 root 정의 차이, 상세 k7-diff-before-after.md). 머리·탭 줄 단위는 의도적 분류 밖 0')
# toast
tv = {1: (1, '실패 — 경로 ④ worktree 모달 대기 시간 초과(만들기 버튼이 hover 때만 눌린다 → 레포 행 hover 추가)'),
      2: (1, '실패 — 격리 userData 가 남아 fixture worktree 행 2개 대기 시간 초과 → 매 회차 새 격리 프로필'),
      3: (0, '실패(K4ⓑ) — 닫기 버튼 테두리 Orca .14 ↔ corral .07 → 다크 테마 전용 규칙 추가. 경로 ①④ 발생'),
      4: (0, '통과(K4ⓑⓒ) — 위치·폭·수명·쌓임·닫기 Orca 측정값과 같음. 경로 ①④'),
      5: (0, '통과(K4ⓐⓑⓒ) — 경로 ①③④ 실제 발생(격리) · 측정값 r4 와 같음 · F18 통과')}
for r, (got, v) in tv.items():
    row('K4 토스트', f'`node app/scripts/l527/toast-probe.mjs --out …/k4-toast-r{r}`', 0, got, f'`k4-toast-r{r}/` · `k4-toast-r{r}.stdout`', v)
row('K4ⓐ ② pane 사라짐', '`vitest App.confirm-settings.test.mjs` (LIFE-527 K4ⓐ ② 단위 시험 — UI 로 경쟁 상태를 못 만든다)', 0, 0, f'`{B}/k8-vitest-final.log`', '통과(단위 시험 — 실제 발생 아님, 보류 사유 RESULT)')
row('K4ⓓ 번들', '`ls -l out/renderer/assets` 전후', 0, 0, f'`{B}/k4d-bundle-size.txt`', '통과(기록) — js +59161 B · css +6841 B · sonner 2.0.7 MIT')
# K8
row('K8ⓐ typecheck', '`npm run typecheck`', 0, 0, f'`{B}/k8-typecheck.log`', P)
row('K8ⓒ lint', '`npx eslint . -f unix` (전·후)', 0, 2, f'`{B}/k8-lint-after.log`', '실패 — unix 포매터가 ESLint 코어에서 빠졌다(도구 오류, 비교 불가) → json 포매터로')
row('K8ⓒ lint', '`npx eslint . -f json` 전(/tmp/l527-base/app)·후 비교', 0, 0, f'`{B}/k8-lint-compare.txt` · `{B}/k8-lint-after.json.gz` · `{B}/k8-lint-before.json.gz`', '실패 — 새 오류 키 5(toast-probe.mjs 브라우저 전역 no-undef 4 · 시험 setTimeout 1) → /* global */')
row('K8ⓑ vitest', '`TMPDIR=/tmp/l527t npx vitest run --exclude scripts/gui-diff/diff.test.mjs`', 0, 1, f'`{B}/k8-vitest.log`', '실패 — 2318/2319, `src/runtime/terminal/receipts.test.ts` 5초 시간 초과(K7 측정 6회가 같은 기계에서 돌던 중 — 이 작업이 건드리지 않은 파일)')
row('K8ⓑ vitest 재실행', '`npx vitest run src/runtime/terminal/receipts.test.ts`', 0, 0, f'`{B}/k8-vitest-receipts-rerun.log`', '통과 38/38 (부하 없을 때)')
row('K8ⓑ node --test', '`node --test scripts/gui-diff/diff.test.mjs`', 0, 0, f'`{B}/k8-diff-test.log`', '통과 95/95')
row('K8ⓐ build', '`npm run build` (floor 반영 최종)', 0, 0, f'`{B}/k8-build.log` · `{B}/k8-build-head.txt`', P)
row('K8ⓐ typecheck(최종)', '`npm run typecheck`', 0, 0, f'`{B}/k8-typecheck-final.log`', P)
row('K8ⓑ vitest(최종)', '`TMPDIR=/tmp/l527t npx vitest run --exclude scripts/gui-diff/diff.test.mjs`', 0, 0, f'`{B}/k8-vitest-final.log`', '통과 113 파일 · 2320 시험')
row('K8ⓑ node --test(최종)', '`node --test scripts/gui-diff/diff.test.mjs`', 0, 0, f'`{B}/k8-diff-test-final.log`', '통과 95/95')
row('K8ⓒ lint(최종 r2)', '`npx eslint . -f json` 후 · `node app/scripts/l527/lint-compare.mjs`', 0, 0, f'`{B}/k8-lint-compare-r2-fail.txt` · `{B}/k8-lint-after2.json.gz`', '실패 — 새 오류 키 11(l527 측정 스크립트의 브라우저 전역·fetch no-undef) → /* global */')
row('K8ⓒ lint(최종 r3)', '같음', 0, 0, f'`{B}/k8-lint-compare-r3.txt` · `{B}/k8-lint-after3.json.gz`', '통과 — 전 405 = 후 405, 새 오류 키 0, 경고 0=0')
row('K2ⓑ 단축키', '`npx vitest run src/renderer/src/App.null-binding.test.mjs` (⌘B 접기·펼치기 + 바인딩 비움 대조 — 이 작업에서 추가)', 0, 0, f'`{B}/k2b-shortcut-test.log`', '통과 5/5 — ⌘B → show → ⌘B → hide, 비우면 hide 그대로')
row('K8ⓒ lint(r4 — 시험 추가 뒤)', '`npx eslint . -f json` · `lint-compare.mjs`(당시 .cjs)', 0, 0, f'`{B}/k8-lint-compare-r4.txt` · `{B}/k8-lint-after4.json.gz`', '실패 — 새 오류 키 4(비교 도구 lint-compare.cjs 자신 — cjs 설정의 require·process) → .mjs 로')
row('K8ⓒ lint(r5 최종)', '같음(lint-compare.mjs)', 0, 0, f'`{B}/k8-lint-compare-r5.txt` · `{B}/k8-lint-after5.json.gz`', '통과 — 전 405 → 후 402, 새 오류 키 0, 경고 0=0')
row('K8ⓑ vitest(최종 2 — 시험 추가 뒤)', '`TMPDIR=/tmp/l527t npx vitest run --exclude scripts/gui-diff/diff.test.mjs`', 0, 0, f'`{B}/k8-vitest-final2.log`', '통과 113 파일 · 2322 시험')
row('K8ⓐ typecheck(최종 2)', '`npm run typecheck`', 0, 0, f'`{B}/k8-typecheck-final2.log`', P)
# K1 captures
row('K1ⓑ 캡처 격리', '`screencapture -l` corral(펼침·접힘) · Orca 개발(활성) → `python3 app/scripts/l527/traffic-lights.py`', 0, 0, '`os/cap/corral-expanded-z100.png` · `corral-collapsed-z100.png` · `orca-dev-active-z100.png`', '통과 — 세 원 x0 16/39/62 · y0 12 · 14×14, 차이 0')
row('K1ⓑ 캡처 설치본 Orca(읽기만)', '`screencapture -x -o -l 37847`', 0, 1, '`native/r2/orca-installed-window.json`', '실패 → 공백 — 「could not create image from window」: 설치본 Orca 창이 다른 Space 전체화면(onscreen false). 앞으로 가져오려면 입력이 필요 — 금지')
row('K1ⓒ U5 줌(round)', '⌘+ ⌘− (cliclick) → 캡처 → traffic-lights.py, corral·Orca 개발 둘 다', 0, 0, '`os/cap/corral-expanded-zoomin1.png` · `orca-dev-zoomin1.png` · `*-zoomout1.png` · `os/k5-corral.jsonl` 44–46 · `os/k5-orca.jsonl` 1–3', '실패 — ⌘+ 에서 신호등 중심 21 ↔ 띠 중심 19.71(1.28, Orca 도 같다) → `floor` 로 바꿈')
row('K1ⓒ U5 줌(floor 빌드)', '같음(corral)', 0, 0, '`os/cap/corral-r2-z100.png` · `corral-r2-zoomin1.png` · `corral-r2-zoomout1.png` · `os/k5-corral.jsonl` 58–60', '통과 — 줌1 y0 12(=Orca) · ⌘+ 중심 20 ↔ 19.71 · ⌘− 17 ↔ 16.43 · 여백 80pt 안(신호등 끝 76)')
row('K1ⓓ 전체화면', '⌃⌘F 진입·나오기(cliclick) + `getWindowChrome`·DOM', 0, 0, '`os/k1d-fullscreen-in.json` · `os/k1d-fullscreen-out.json` · `os/cap/corral-fullscreen.png` · `os/k5-corral.jsonl` 47–49', '통과 — 안: fullScreen true·신호등 여백 없음(앱 이름 x10) / 밖: 여백 복귀(x82)·프레임 원복. 48행 = 안전 확인 거절(맨 앞 창이 같은 pid 의 위 막대) → 키 입력은 pid 확인으로 고쳐 49행')
row('U4 도달', '`act.sh` m:@600,400 (corral 격리)', 0, 0, '`os/actions.jsonl` 1행 · 렌더러 mousemove (600,400)', '통과 — OS 입력이 렌더러에 닿는다(창 좌표 = 클라이언트 좌표)')
# OS jsonl judgments
J = {
 'T1':('K5ⓐ 탭 줄 끌기',P,'Δ(+100,+60)'), 'T1b':('원복',P,''), 'T2':('K5ⓐ 위 4px 띠 y=2',F,'이동 0 — y≤2 는 OS 창 가장자리(Orca O5 같음)'),
 'T2b':('원복(무효)',F,'창이 안 움직인 줄 모르고 되돌리기 — 터미널 위에서 눌림(격리, 해 없음)'), 'T3':('K5ⓐ 머리 빈 곳 끌기',P,'Δ(+100,+60)'), 'T3b':('원복',P,''),
 'T4':('K5ⓐ 머리 신호등 칸 아래',P,'Δ(+100,+60)'), 'T4b':('원복',P,''), 'T5':('K5ⓑ 앱 이름',P,'이동 0 · mousedown 앱 이름'),
 'T2c':('K5ⓐ 위 띠 y=3',P,'Δ(+100,+60)'), 'T2d':('원복',P,''), 'T6':('K5ⓑ 토글(접기)',P,'접힘'),
 'C1':('K2ⓒ 접힘 머리 y=30 끌기',P,'이동 0 = Orca O7 과 같음(spacer no-drag 가 덮는다)'), 'C1b':('원복(불필요)',P,'이동 0 — 포인터가 창 밖까지, mouseup 은 corral'),
 'C2':('K5ⓐ 접힘 탭 줄 끌기',P,'Δ(+100,+60)'), 'C2b':('원복',P,''), 'C3':('K5ⓑ 접힘 탭 클릭',P,'이동 0 · 탭'), 'C3b':('K2ⓒ spacer 끝 경계',P,'x=166 = 첫 탭'),
 'C4':('K2ⓒ 떠 있는 토글(펼치기)',P,'펼침'), 'T9':('K5ⓑ + 클릭',P,'메뉴 열림(y40 — 띠 밖)'), 'T9b':('준비(새 터미널)',P,'탭 2'),
 'T10':('K5ⓑ 탭 메뉴 트리거',P,'메뉴 (330,20)'), 'T10b':('K5ⓓ 겹침 끌기',F,'근거 부족 — 기록기가 조상(main-tabbar)만 적었다. 이 끌기가 기존 결함(메뉴 mousedown 이 탭 드래그로 버블)을 일으켰다'),
 'T10c':('정리 Esc',F,'cliclick `kp:` 특수키가 앱에 닿지 않음'), 'T10d':('K5ⓓ 겹침 클릭',F,'근거 부족 — 같은 기록기 문제'),
 'T10e':('K5ⓓ 겹침 클릭(섹션 제목)',P,'raw 대상 tab-menu-section · 이동 0'), 'T10f':('K5ⓓ 겹침 끌기(섹션 제목)',P,'raw 대상 tab-menu-section · 창 이동 0 (탭 순서는 기존 결함으로 바뀜 — RESULT)'),
 'T10g':('정리',P,''), 'T11':('K5ⓑ 탭 순서 바꾸기',P,'t2,t1 → t1,t2 · 창 이동 0'),
 'T12':('K5ⓒ 탭 줄 더블클릭',P,'확대 1920×1050(다음 행 boundsBefore)'), 'T12b':('K5ⓒ 원복 더블클릭',P,'1180×800 (370,76)(다음 행)'),
 'T12c':('K5ⓒ 머리 더블클릭',P,'확대'), 'T12d':('K5ⓒ 원복',P,'1180×800 (370,76)'), 'T13':('준비 ⌘,',P,'설정 열림'),
 'T13b':('K5ⓐ 설정 띠 끌기',P,'Δ(+100,+60)'), 'T13c':('원복',P,''), 'T13d':('K6ⓐ 띠 아래 클릭',P,'settings-content'), 'T13e':('K6ⓐ 설정 띠 신호등 칸 아래',P,'Δ(+100,+60)'), 'T13f':('원복',P,''),
 'T13g':('정리 Esc',F,'`kp:` 미도달 + 설정은 Esc 2단계'), 'T13h':('정리 돌아가기',P,''),
 'K1':('K1ⓑ 캡처 준비',P,''), 'K1ⓓ':('K1ⓓ',P,'판정은 위 K1ⓓ 행'), 'U5':('K1ⓒ',P,'캡처 행은 위 K1ⓒ 참조'), 'U5r2':('K1ⓒ',P,'캡처 행은 위 K1ⓒ 참조'),
 'C5':('준비',P,''), 'C5b':('K2ⓒ 접힘 머리 y=3 끌기',P,'Δ(+100,0) = Orca O7b'), 'C5c':('원복',P,''), 'C5d':('준비',P,''),
 'T14':('K5ⓓ 준비(y=6 메뉴)',P,'첫 항목 y32–58'), 'T14b':('K5ⓓ 띠 안 항목 클릭',P,'「오른쪽 영역」 실행(영역 1→2) · 창 이동 0'),
 'T15':('K5ⓓ 팔레트',P,'첫 항목 y163 — 띠와 안 겹침'), 'T15b':('정리 Esc',F,'`kp:` 미도달 → 제어 소켓 Escape 로 닫음(판정 외)'),
 'O1':('K5ⓒ대조/ⓐ Orca 탭 줄 끌기',P,'Δ(+100,0) — y 는 창이 화면 높이라 제약'), 'O1b':('원복',P,''),
 'O2':('Orca 머리 x=230 (무효)',F,'Back 버튼(disabled) 위였다 — 빈 곳 아님'), 'O2b':('원복(무효)',F,'이동 0'), 'O3':('Orca 앱 이름',P,'이동 0 · mousedown 앱 이름(corral T5 와 같음)'),
 'O2c':('Orca 머리 빈 곳 x=274',P,'Δ(+100,0)'), 'O2d':('원복',P,''), 'O4':('K5ⓒ Orca 더블클릭',P,'1920×1050 → 1900×1030(이미 확대 상태 → 되돌림)'), 'O4b':('K5ⓒ Orca 원복',P,'1920×1050'),
 'O5':('Orca 위 띠 y=2',P,'이동 0 = corral T2 와 같음'), 'O6':('준비',P,''), 'O7':('Orca 접힘 머리 y=30',P,'이동 0 = corral C1'), 'O7b':('Orca 접힘 머리 y=3',P,'Δ(+100,0)'), 'O7c':('원복',P,''), 'O8':('준비',P,''),
 'N1':('K9ⓒ/K5ⓐ 탭 줄 끌기',P,'Δ(+100,+60)'), 'N1b':('원복',P,''), 'N2':('K9ⓒ/K5ⓐ 머리 끌기',P,'Δ(+100,+60)'), 'N2b':('원복',P,''),
 'N3':('K9ⓒ/K5ⓑ 앱 이름',P,'이동 0 · 앱 이름'), 'N4':('K9ⓒ/K5ⓑ 탭 클릭',P,''), 'N5':('K9ⓒ/K5ⓑ +',P,''), 'N5b':('준비(셸 탭)',P,''),
 'N6':('K9ⓒ/K5ⓑ 순서 바꾸기',P,'tS,tX → tX,tS · 이동 0'), 'N6b':('원복',P,'tS,tX'), 'N7':('K9ⓒ/K5ⓑ 탭 메뉴 트리거',P,''), 'N7b':('K9ⓒ/K5ⓓ 띠 안 항목',P,'「오른쪽 영역」 실행(영역 1→2) · 이동 0'),
 'N7c':('원복(셸 탭 닫기)',P,'영역 1·탭 1'), 'N8':('K9ⓒ/K5ⓑ 토글',P,'접힘 · 캡처 native-collapsed.png'), 'N8b':('K9ⓒ/K5ⓐ 접힘 탭 줄',P,'Δ(+100,+60)'), 'N8c':('원복',P,''), 'N8d':('K9ⓒ 떠 있는 토글',P,'펼침'),
 'N9':('K9ⓒ/K5ⓒ 더블클릭',P,'확대'), 'N9b':('K9ⓒ/K5ⓒ 원복',P,'1180×800 (370,76)'), 'N10':('준비 ⌘,',P,''), 'N10b':('K9ⓒ/K5ⓐ 설정 띠',P,'Δ(+100,+60)'), 'N10c':('원복',P,''), 'N10d':('정리',P,''),
 'N11':('K9ⓓ 레포 추가',P,''), 'N11b':('K9ⓓ 토스트',P,'「1개는 이미 있었다」 (740,712) 416×48 — 오른쪽 24·아래 40'),
}
for f in ['os/k5-corral.jsonl', 'os/k5-orca.jsonl', 'native/r2/k5-native.jsonl']:
    for i, line in enumerate(open(f)):
        r = json.loads(line)
        key = r['label'].split(' ')[0]
        crit, v, note = J[key]
        if r['exit'] != 0 and v == P: v = F
        row(crit, f'`k5-steps.sh` 「{r["label"]}」', 0, r['exit'], f'`{f}` {i+1}행', v + (f' — {note}' if note else ''))
# K6
row('K6ⓑⓒ before', '`os-up.mjs --corral-app /tmp/l527-base/app --no-orca` + `k6-probe.mjs --label before`', 0, 0, '`os/k6/k6-before.json` · `os/k6/before-*.png` · `os/up-2-base/` · `os/cap/corral-base-before.png`', '통과(기록) — rows 39 · xterm 102 ↔ herdr 103')
row('K6ⓑⓒ after', '`os-up.mjs` + `k6-probe.mjs --label after`', 0, 0, '`os/k6/k6-after.json` · `os/k6/after-*.png` · `os/up-3-after/`', '통과 — rows 39→43 · herdr 43=xterm 43 · 드롭존 top 70→36(탭 줄 아래 끝) · MRU·팔레트·대화상자 위치 일관. 호버 카드 전후 모두 안 뜸 → 공백')
# native
row('K9 native-up r1', '`sh app/scripts/l527/native-up.sh /tmp/l527n1 app native/r1`', 0, 7, '`native/r1/`', '실패(설계된 멈춤) — 복구될 에이전트 세션 3개(claude 1·grok 2). 킥오프 사전 승인 `--allow-session-restore` 로 r2')
row('K9 native-up r2', '`sh app/scripts/l527/native-up.sh /tmp/l527n2 app native/r2 --allow-session-restore`', 0, 0, '`native/r2/native-up.stdout` · `precheck.txt` · `ud-manifest-before.json` · `g6-pre.txt`', '통과 — 전제(소유자 없음·corral 0·profile 원본·herdr default stopped) · 백업 1060 파일')
row('K9 복구 프로세스 목록', '`node app/scripts/l527/restored-agents.mjs /tmp/l527n2 native/r2`', 0, 0, '`native/r2/restored-agents.txt`', '통과(기록) — 5개, 입력 없음')
row('K9ⓐⓑ 네이티브 캡처', '`screencapture -l 65014` 펼침·접힘·설정·토스트 + traffic-lights.py', 0, 0, '`native/r2/cap/`', '통과 — 창 = 콘텐츠 1180×800(기본 타이틀바 없음), 신호등 16/39/62·y0 12 (펼침·접힘) = Orca 개발')
row('K9ⓔ native-down', '`sh app/scripts/l527/native-down.sh /tmp/l527n2 native/r2`', 0, 0, '`native/r2/native-down.stdout` · `ud-manifest-after-restore.json` · `herdr-manifest-after-restore.json` · `g6-compare.txt`', '통과 — userData 1061 파일 해시 전=후 · herdr 최상위 6 · provider 11 · codex config · G6 12줄 · herdr default stopped')
row('K9 잔존', '`sh app/scripts/l527/leftover-check.sh /tmp/l527 native/r2`', 0, 0, '`native/r2/leftover-check.txt`', '통과 — 고아 0 · 복구 프로세스 5개 모두 종료 · herdr default 없음 · 이 빌드 Electron 없음')
row('G6(후)', '`node app/scripts/l527/g6-compare.mjs g6-before.txt g6-after.txt`', 0, 1, '`g6-compare.txt`', '실패 — g6-before.txt 가 내 형식(경로·크기·해시)이라 비교기가 못 읽음 → 같은 형식으로 다시')
row('G6(후)', '같은 5개 `shasum -a 256` + 프로세스 → `diff g6-before g6-after`', 0, 0, '`g6-after.txt` · `g6-diff.txt`', '통과 — 5개 해시·크기 전=후, 설치본 Orca pid 25085 그대로, 사용자 corral Electron 없음')
row('고아 최종', '`ps` PPID 1 · 작업 경로 프로세스', 0, 0, '`orphan-final.txt`', '통과 — 우리 프로세스 0 (PPID 1 은 life417-native herdr 44782 — 남의 것, 무접촉)')
out = ['# LIFE-527 명시 실행 목록 (G5)', '',
 '실행 한 번 = 한 행. 실패 회차도 지우지 않는다. 합계는 이 표의 「통과/실패」 칸을 세서만 만든다.',
 '측정 도구가 스스로 적는 `measure-runs.md` 의 행은 여기 한 행씩 옮겼다(원자료 경로 = 그 회차 폴더).',
 'OS 입력(cliclick) 한 단계 = 한 행 — `k5-steps.sh` 가 그 단계마다 jsonl 한 줄(종료코드·창 bounds 전후·렌더러 이벤트)을 남겼고, 여기 그 줄을 1:1 로 옮겼다. 판정 칸은 라벨별로 손으로 정했다(패턴 집계 아님).',
 '「원복」「준비」「정리」 행은 판정 대상이 아닌 단계지만 실행이라 적는다 — 합계에서는 기준 항목 칸으로 거른다.',
 '구현 중 반복 빌드(`build/l527-build-after1~4.log`)와 K6 프로브 디버그 실행(/tmp, 판정에 안 씀)은 판정 회차가 아니라 행으로 적지 않았다. 요약 전(이전 컨텍스트) 단위 시험 실행은 원자료가 없어 적지 않는다 — 최종 판정은 아래 「최종」 행.', '',
 '| 실행 id | 기준 항목 | 명령 | 기대 종료코드 | 실제 종료코드 | 원자료 경로 | 통과/실패 |', '| --- | --- | --- | --- | --- | --- | --- |']
for i, (crit, cmd, want, got, raw, v) in enumerate(rows):
    esc = lambda s: str(s).replace('|', '\\|')
    out.append(f'| R{i+1:03d} | {esc(crit)} | {esc(cmd)} | {want} | {got} | {esc(raw)} | {esc(v)} |')
open('runs.md', 'w').write('\n'.join(out) + '\n')
print(len(rows))
