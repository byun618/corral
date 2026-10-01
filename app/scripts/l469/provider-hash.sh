#!/bin/sh
# LIFE-469 — provider 설정 해시(읽기만, 킥오프 격리 2). 시작·끝에 같은 목록을 찍어 대조한다.
for f in "$HOME/.claude/settings.json" "$HOME/.codex/hooks.json" "$HOME/.codex/config.toml" "$HOME/.codex/herdr-agent-state.sh" "$HOME/.grok/config.toml" "$HOME/.grok/trusted_folders.toml" "$HOME"/.claude/hooks/* "$HOME"/.grok/hooks/*; do
  [ -f "$f" ] && echo "$(shasum -a 256 "$f" | cut -d' ' -f1)  ~/${f#$HOME/}"
done
