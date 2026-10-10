# LIFE-581 R5-A1 — 에뮬레이터 실 RN 제스처 재현용 사본(리뷰어 r5 `setup-native.py` 방식). 작업 폴더 mobile/ 를 /tmp/l581g-r5/m 으로 복사하고(node_modules 는 링크),
# app/ 를 합성 fixture 하나로 바꾼다 — 서버·인증·사용자 기록 없음. Conversation.tsx 는 --conv 로 받은 파일에 로그만 덧붙인 것(동작 무변경).
#   python3 scripts/l581/r5a1-setup.py --conv <Conversation.tsx> --kind fix|r5   (r5 = 리뷰어 계측본을 그대로 — 이미 로그가 있다)
import argparse, json, shutil, sys
from pathlib import Path

p = argparse.ArgumentParser(); p.add_argument('--conv', required=True); p.add_argument('--kind', choices=['fix', 'r5'], required=True); a = p.parse_args()
here = Path(__file__).resolve()
src = here.parents[3] / 'mobile'
root = Path('/tmp/l581g-r5'); dst = root / 'm'
if dst.exists(): shutil.rmtree(dst)
shutil.copytree(src, dst, ignore=shutil.ignore_patterns('node_modules', '.expo', 'android', 'ios', 'test'))
(dst / 'node_modules').symlink_to(src / 'node_modules', target_is_directory=True)
shutil.rmtree(dst / 'app'); (dst / 'app').mkdir()
(dst / 'app/_layout.tsx').write_text("import '../global.css'; import { Stack } from 'expo-router'; export default function Layout(){return <Stack screenOptions={{headerShown:false}}/>}\n")
shutil.copyfile(here.parent / 'r5a1-fixture.tsx', dst / 'app/index.tsx')
(dst / 'index.js').write_text("import 'expo-router/entry'\n")
pkg = json.loads((dst / 'package.json').read_text()); pkg['main'] = './index.js'; (dst / 'package.json').write_text(json.dumps(pkg, indent=2))
(dst / 'metro.config.js').write_text("const {getDefaultConfig}=require('expo/metro-config');const {withNativeWind}=require('nativewind/metro');const c=getDefaultConfig(__dirname);c.watchFolders=[" + repr(str(src)) + "];module.exports=withNativeWind(c,{input:'./global.css'});\n")
code = Path(a.conv).read_text()
if a.kind == 'fix':
    def put(old, new, count=1):
        global code
        if code.count(old) != count: sys.exit(f'계측 자리 못 찾음: {old!r} ({code.count(old)})')
        code = code.replace(old, new)
    put("      const isAway = lastY.current > NEAR_BOTTOM\n", "      console.log('R5_SCROLL', lastY.current, 'tail', tailRev)\n      const isAway = lastY.current > NEAR_BOTTOM\n")
    put("    if (!pending.current || gesture.current !== 'none' || !followingRef.current) return\n", "    console.log('R5_SIZE', 'pending', pending.current, 'gesture', gesture.current, 'following', followingRef.current)\n    if (!pending.current || gesture.current !== 'none' || !followingRef.current) return\n")
    put("    list.current?.scrollToOffset({ offset: 0, animated: false })\n  }, [])\n", "    console.log('R5_FOLLOW', 'size')\n    list.current?.scrollToOffset({ offset: 0, animated: false })\n  }, [])\n")
    put("    gesture.current = 'none'\n    if (!pending.current) return\n", "    console.log('R5_SETTLE', 'pending', pending.current, 'y', lastY.current)\n    gesture.current = 'none'\n    if (!pending.current) return\n")
    put("      setAwayFrom(null)\n      list.current?.scrollToOffset({ offset: 0, animated: true })\n", "      console.log('R5_FOLLOW', 'settle')\n      setAwayFrom(null)\n      list.current?.scrollToOffset({ offset: 0, animated: true })\n")
    put("    clearRelease()\n    gesture.current = 'drag'\n", "    console.log('R5_DRAG_BEGIN')\n    clearRelease()\n    gesture.current = 'drag'\n")
    put("      gesture.current = 'release'\n", "      console.log('R5_DRAG_END', lastY.current)\n      gesture.current = 'release'\n")
    put("    clearRelease()\n    if (gesture.current !== 'drag') gesture.current = 'momentum'\n", "    console.log('R5_MOMENTUM_BEGIN')\n    clearRelease()\n    if (gesture.current !== 'drag') gesture.current = 'momentum'\n")
    put("      if (gesture.current === 'momentum') settle()\n", "      console.log('R5_MOMENTUM_END', lastY.current)\n      if (gesture.current === 'momentum') settle()\n")
(dst / 'src/ui/Conversation.tsx').write_text(code)
shutil.copyfile(dst / 'src/ui/Conversation.tsx', root / f'Conversation-{a.kind}-instrumented.tsx')
print(dst)
