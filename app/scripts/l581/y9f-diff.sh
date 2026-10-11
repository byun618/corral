# Y9ⓕ — 기준 f65c1428e(feature/LIFE-564-mobile, 이 작업 분기점) → HEAD. HTTP 길·바인딩·Origin·업그레이드 줄 변경 0 이어야 한다.
P='listen|127\.0\.0\.1|localhost|host|[Oo]rigin|createServer|http\.|https|upgrade|handleUpgrade|verifyClient|writeHead|statusCode|req\.url|pathname|/ws'
echo "## 바뀐 파일(app/src/main/mobile)"; git diff --stat f65c1428e..HEAD -- app/src/main/mobile/
for f in app/src/main/mobile/server.ts app/src/main/mobile/service.ts app/src/main/mobile/protocol.ts; do
  n=$(git diff -U0 f65c1428e..HEAD -- $f | grep -E '^[-+][^-+]' | grep -Ec "$P")
  echo "$f 위험 패턴 변경 줄: $n"; git diff -U0 f65c1428e..HEAD -- $f | grep -E '^[-+][^-+]' | grep -E "$P" | cut -c1-160
done
# 양성 대조 — 같은 패턴이 server.ts 본문에는 있다(grep 이 실제로 잡는다)
echo "양성 대조 server.ts 본문 일치 줄: $(grep -Ec "$P" app/src/main/mobile/server.ts)"
t=$(for f in app/src/main/mobile/server.ts app/src/main/mobile/service.ts app/src/main/mobile/protocol.ts; do git diff -U0 f65c1428e..HEAD -- $f | grep -E '^[-+][^-+]' | grep -Ec "$P"; done | paste -sd+ - | bc)
echo "합계 $t"; [ "$t" = 0 ]
