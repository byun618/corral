# LIFE-527 fix1 F5 — runs.md 정정(손으로 정한 내용을 적용만 한다). 원 생성기 make-runs.py 는 R001~R174 를 만들었고 fix1 부터 이 파일로 덧붙인다.
#   ① 이전 컨텍스트 단위 시험 미기재 회차 → 미확정 행 복원(원자료 「없음」 — 명령·기준은 세션 기록에서 아는 만큼)
#   ② R028 → R038 인용(별도 실행 아님 — 합계에서 뺀다) ③ R116 라벨 정정 ④ fix1 회차 덧붙임(fix1-rows.tsv)
# 실행: python3 app/scripts/l527/runs-fix1.py specs/LIFE-527-titlebar/raw/claude/runs.md specs/LIFE-527-titlebar/raw/claude/fix1/fix1-rows.tsv
import sys, re
path, extra = sys.argv[1], sys.argv[2]
lines = open(path).read().split('\n')
NOTE_OLD = '요약 전(이전 컨텍스트) 단위 시험 실행은 원자료가 없어 적지 않는다 — 최종 판정은 아래 「최종」 행.'
NOTE_NEW = ('요약 전(이전 컨텍스트) 단위 시험·typecheck·lint 실행은 원자료가 없다 — fix1 F5 에서 지우지 않고 `미확정` 행(R175~R193, 원자료 「없음」)으로 되살렸다. '
            '그 행이 걸린 기준 항목의 **총 회차는 미확정**이다. 최종 판정은 원자료가 있는 「최종」 행. '
            '「인용」 행은 다른 행의 실행을 가리키는 것이라 실행이 아니다 — 합계에서 뺀다. R175 부터는 `runs-fix1.py` 가 덧붙였다.')
U = '미확정 — 원자료 없음(세션 기록에만 출력이 남았다)'
restored = [
  ('K8ⓐ typecheck(구현 중)', '`npm run typecheck` (13:57 — SidebarIcons 중복 선언 오류)', 0, '미확정', '없음', U),
  ('K8ⓐ typecheck(구현 중) · K8ⓒ lint(변경 파일)', '`npm run typecheck` · `npx eslint App.tsx SidebarHead.tsx Toaster.tsx useWindowChrome.ts window-chrome.ts` (13:57 — 단언 2건)', 0, '미확정', '없음', U),
  ('K8ⓐ typecheck(구현 중) · K8ⓒ lint', '`npm run typecheck` · `npx eslint .` (13:58 — 405 문제)', 0, '미확정', '없음', U),
  ('K8ⓑ vitest(구현 중)', '`npx vitest run App.null-binding · App.settings · App.confirm-settings · window-chrome 외 5 파일` (13:58)', 0, '미확정', '없음', U),
  ('K8ⓑ node --test(구현 중)', '`node --test diff.test.mjs` (13:59:31 — 실패 출력)', 0, '미확정', '없음', U),
  ('K8ⓑ node --test(구현 중)', '`node --test diff.test.mjs | grep` (13:59:34)', 0, '미확정', '없음', U),
  ('K8ⓑ node --test(구현 중)', '`node --test diff.test.mjs | grep` (13:59:50 — 출력 없음)', 0, '미확정', '없음', U),
  ('K8ⓑ node --test(구현 중)', '`node --test diff.test.mjs` (13:59:53)', 0, '미확정', '없음', U),
  ('K4ⓐ ② pane 사라짐(구현 중)', '`npx vitest run App.confirm-settings.test.mjs` (14:18:43)', 0, '미확정', '없음', U),
  ('K4ⓐ ② pane 사라짐(구현 중)', '`npx vitest run App.confirm-settings.test.mjs` (14:18:47 — 새 시험 1 실패 출력)', 0, '미확정', '없음', U),
  ('K4ⓐ ② pane 사라짐(구현 중)', '`npx vitest run App.confirm-settings.test.mjs` (14:18:56)', 0, '미확정', '없음', U),
  ('K8ⓒ lint(구현 중, 변경 파일)', '`npx eslint scripts/l527 App.confirm-settings.test.mjs App.tsx SidebarHead.tsx Toaster.tsx …` (14:23:50)', 0, '미확정', '없음', U),
  ('K8ⓑ node --test(구현 중)', '`node --test scripts/gui-diff/diff.test.mjs` (14:25:18 — sidebar.json 대체 선택자 뒤)', 0, '미확정', '없음', U),
  ('K1ⓒ 신호등 수식(구현 중)', '`npx vitest run src/shared/window-chrome.test.ts` (14:43 — floor 전환 뒤)', 0, '미확정', '없음', U),
  ('K2ⓑ 단축키(구현 중)', '`npx vitest run App.null-binding.test.mjs` (15:10:27)', 0, '미확정', '없음', U),
  ('K2ⓑ 단축키(구현 중)', '`npx vitest run App.null-binding.test.mjs > build/k2b-shortcut-test.log` (15:10:47 — 그 로그는 R042 회차가 덮어썼다)', 0, '미확정', '없음', U),
  ('K8ⓒ lint(구현 중, 변경 파일)', '`npx eslint App.null-binding.test.mjs` (15:10:47 — no-undef 4)', 0, '미확정', '없음', U),
  ('K8ⓒ lint(구현 중, 변경 파일)', '`npx eslint App.null-binding.test.mjs` (15:11:02)', 0, '미확정', '없음', U),
  ('K1ⓒ 신호등 수식 · F1(fix1 구현 중)', '`npx vitest run src/main/window-zoom.test.ts src/shared/window-chrome.test.ts` · `npm run typecheck` (fix1 00:41)', 0, '미확정', '없음', U),
]
out = []
last_id = 0
for line in lines:
    if NOTE_OLD in line:
        line = line.replace(NOTE_OLD, NOTE_NEW)
    if line.startswith('| R028 |'):
        line = ('| R028 | K4ⓐ ② pane 사라짐 | 인용 — R038(최종 vitest) 이 돌린 `App.confirm-settings.test.mjs` 의 K4ⓐ ② 시험 | 0 | 0 | '
                '`build/k8-vitest-final.log`(R038) | 인용 — 별도 실행 아님(R038 의 일부, 합계에서 뺀다). 단위 시험 — 실제 발생 아님, 보류 사유 RESULT |')
    if line.startswith('| R116 |'):
        line = line.replace('| K5ⓒ대조/ⓐ Orca 탭 줄 끌기 |', '| K5ⓐ대조 Orca 탭 줄 끌기(O1) |')
    m = re.match(r'\| R(\d{3}) \|', line)
    if m: last_id = max(last_id, int(m.group(1)))
    out.append(line)
while out and out[-1] == '': out.pop()
esc = lambda s: str(s).replace('|', '\\|')
rows = list(restored)
for raw in open(extra).read().split('\n'):
    if raw.strip() == '' or raw.startswith('#'): continue
    rows.append(tuple(raw.split('\t')))
assert last_id == 174, last_id
for i, (crit, cmd, want, got, rawp, v) in enumerate(rows):
    out.append(f'| R{last_id + 1 + i:03d} | {esc(crit)} | {esc(cmd)} | {want} | {got} | {esc(rawp)} | {esc(v)} |')
open(path, 'w').write('\n'.join(out) + '\n')
print('rows', last_id + len(rows))
