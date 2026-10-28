# 반입 출처 (LIFE-590)

- microsoft/vscode 1.142.0 (959031245eb) — MIT(`notices/VSCODE-LICENSE.txt`).
- `grammars/*.json`: `extensions/{typescript-basics,javascript,json,markdown-basics,css,scss,less,html,yaml,shellscript,python,rust,go,xml,sql,docker,ini,make,diff,java}/syntaxes` 사본(내용 무변경). 상류 문법 저장소·라이선스는 확장별 `notices/<확장>.cgmanifest.json`.
- `languages.json`: 같은 확장 매니페스트의 `contributes.languages`·`contributes.grammars`(tokenTypes·bracket scopes 포함) 에서 생성.
- `language-configuration/<언어>.json`: 같은 확장의 `language-configuration.json`(JSONC → JSON, 내용 무변경).
- `dark-2026.json`: `extensions/theme-defaults/themes/dark_vs.json → dark_plus.json → dark_modern.json → 2026-dark.json` include 체인을 `colorThemeData.ts` 순서로 펼친 TextMate 규칙 + 편집기 색 일부.
- 생성: `app/scripts/vendored-assets/tm-import.mjs`.
