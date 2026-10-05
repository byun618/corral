#!/bin/sh
# LIFE-513 G6 — 사용자 Ghostty 파일(두 폴더의 모든 파일)·~/.orca/keybindings.json 해시. 읽기만 한다. 시작·끝에 같은 목록을 찍어 대조한다.
for f in "$HOME"/.config/ghostty/* "$HOME/Library/Application Support/com.mitchellh.ghostty"/* "$HOME/.orca/keybindings.json"; do
  [ -f "$f" ] && echo "$(shasum -a 256 "$f" | cut -d' ' -f1)  ~/${f#$HOME/}"
done
