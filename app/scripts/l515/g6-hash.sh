#!/bin/sh
# LIFE-515 G6 — 사용자 설정 해시(읽기만). 시작·끝에 같은 목록을 찍어 대조한다(전 = 후).
# 범위(q1 코디 답 조건 1): ~/.orca/keybindings.json · ~/.claude/settings.json·hooks/* · ~/.codex/config.toml · ~/.grok/config.toml·trusted_folders.toml·hooks/* ·
# 사용자 corral settings.json(네이티브 원복 = 백업 바이트 복원)·keybindings.json(없음 유지). grok 런타임 파일은 grok-runtime.sh 가 따로 찍는다(대조 아님 — 목록).
UD="$HOME/Library/Application Support/corral"
for f in "$HOME/.orca/keybindings.json" "$HOME/.claude/settings.json" "$HOME"/.claude/hooks/* "$HOME/.codex/config.toml" "$HOME/.grok/config.toml" "$HOME/.grok/trusted_folders.toml" "$HOME"/.grok/hooks/* "$UD/settings.json" "$UD/keybindings.json"; do
  if [ -f "$f" ]; then echo "$(shasum -a 256 "$f" | cut -d' ' -f1)  $(wc -c <"$f" | tr -d ' ')B  ~/${f#$HOME/}"; fi
done
[ -f "$UD/keybindings.json" ] || echo "absent  ~/Library/Application Support/corral/keybindings.json"
