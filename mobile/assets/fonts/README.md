# 글꼴 (LIFE-580 J7 · 579 R9)

| 파일 | 글꼴 | 라이선스 | 출처 |
| --- | --- | --- | --- |
| `Geist_400Regular.ttf` · `Geist_500Medium.ttf` · `Geist_600SemiBold.ttf` | Geist (UI) | SIL OFL 1.1 — `Geist-OFL.txt`(데스크톱 번들 `app/src/renderer/src/assets/fonts/Geist-OFL.txt` 그대로) | `@expo-google-fonts/geist@0.4.2` 의 정적 TTF |
| `JetBrainsMono_400Regular.ttf` · `JetBrainsMono_500Medium.ttf` | JetBrains Mono (mono) | SIL OFL 1.1 — `JetBrainsMono-OFL.txt` | `@expo-google-fonts/jetbrains-mono@0.4.1` 의 정적 TTF |

- 데스크톱은 가변 woff2(`Geist-Variable.woff2`)를 쓴다. Android RN 은 woff2 를 읽지 못하고 가변 축 굵기 선택도 믿을 수 없어 **같은 글꼴의 정적 TTF** 를 굵기별로 둔다.
- `app.config.ts` 의 `expo-font` 플러그인이 빌드 때 APK 에 넣는다 — 앱이 글꼴을 내려받지 않는다. Android 에서 글꼴 이름은 파일 이름(`Geist_500Medium`).
- 한글은 글꼴에 없어 시스템 폴백(Noto Sans KR/CJK)으로 떨어진다(579 §3).
