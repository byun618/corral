import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
// 앱 루트 — 옛 하네스 lib.mjs 의 `app` 과 같은 식(그 lib 은 이 레포에서 빠졌다)
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
// LIFE-430 C4 (LA ③, 구 LIFE-424). 이 스크립트의 출력 경로는 기본값이 LIFE-393 의 **동결 raw** 로
// 풀렸고, 파일명이 고정이라 그 자리를 그대로 덮어썼다. LIFE-409 구현이 이 함정을 두 번(r1·r3) 밟아
// 출고된 작업의 원자료가 지워졌다 — `43ba1fa6` 가 덮었고 r3 리뷰가 잡아 `7cfdd0f8` 로 복원했다.
// 증거가 진실의 원천인 구조에서, 증거를 지우는 쪽이 기본값이었다.
//
// 그래서 출력 경로는 **쓰기 전에** 판정한다. 그리고 r3 에서 판정의 **방향을 뒤집었다**: 거부 목록이
// 아니라 **허용 목록**이다. 거부 목록은 층을 쌓을수록 새 우회가 나왔다 — 3층(r1) → 5층(r2) 뒤에도
// macOS 의 대소문자 별칭(`SPECS/…`)과 `CORRAL_VERIFY_TASK=LIFE-393` 한 줄이 그대로 지나갔다.
// 허용 목록은 반대다: **허용되는 자리를 먼저 적고, 나머지를 전부 거절한다.**
//
//   ① `CORRAL_VERIFY_RAW` 가 없으면 거절한다. 기본 경로는 없다.
//   ② 경로를 `realpath` 로 끝까지 푼다. 심링크 문자열 그대로 보면 판정과 쓰기가 다른 곳을 본다.
//      아직 없는 디렉터리는 가장 가까운 존재하는 조상을 풀고 나머지 이름을 잇는다.
//   ③ **허용 목록.** 다음 둘 중 하나일 때만 지나간다.
//        (ㄱ) 이 스크립트를 돌리는 worktree **자신의 일감 폴더** 아래.
//        (ㄴ) 어느 저장소에도 속하지 않는다고 **증명된** 곳 (`/tmp/…` 등).
//      나머지는 전부 거절이다 — 다른 일감의 폴더, `specs/` 루트, 저장소 루트, 다른 worktree,
//      격리 fixture 저장소까지.
//      (ㄴ)의 **증명**은 둘이 함께 설 때만 성립한다: 조상에 `.git` 이 하나도 없다(파일 시스템 사실)
//      **그리고** git 이 「저장소가 아니다」라고 말했다. r3 은 git 이 답하지 못한 것을 (ㄴ)로 읽었고,
//      `GIT_DIR=<없는 경로>` 한 줄·`GIT_CEILING_DIRECTORIES` 한 줄·실패하는 git 스텁·git 없는 PATH
//      넷 다 그 길로 동결 트리에 **실제 파일을 만들었다** (r3 지적 K). 대답을 못 들은 것은
//      「저장소 밖」이 아니라 **공백**이고, 공백은 허용이 아니다.
//   ④ 허용된 자리 안에서도, 이미 커밋된 파일을 담은 디렉터리는 거절한다. git 이 답하지 못하면
//      통과가 아니라 거절이다 — 답을 못 들은 것은 「추적 없음」이 아니다.
//   ⑤ 쓰려는 파일이 이미 있으면 거절한다. 쓰기는 `'wx'` — 판정과 쓰기 사이의 창을 커널이 닫는다.
//
// **두 가지를 일부러 그렇게 했다.**
//
// 첫째, ③(ㄱ) 의 "아래" 는 **문자열이 아니라 신원**으로 본다. 대상의 존재하는 조상 사슬을 올라가며
// `{dev, ino}` 가 일감 폴더의 것과 같은 자리가 있는지 본다. macOS 의 `SPECS/…` 는 `specs/…` 와
// **같은 inode** 이므로 같은 자리로 판정된다. 문자열을 소문자로 접는 방식은 쓰지 않는다 —
// 대소문자를 구분하는 파일 시스템에서는 서로 **다른** 디렉터리를 하나로 합쳐 버린다.
//
// 둘째, 일감 번호는 **환경변수에서 받지 않는다.** r2 의 `CORRAL_VERIFY_TASK` 는 한 줄로 남의 동결
// 트리를 자기 것이라고 선언하게 해 줬고, 거절 메시지가 그 변수를 복구 방법으로 가르치기까지 했다.
// 번호는 실행하는 worktree 자신에서만 나온다: 브랜치 이름, 없으면 worktree 폴더 이름.
//
// 한계 (r4 리뷰 뒤 실제에 맞게 고쳐 적는다 — 지적 Z3·Z5).
//
//   - **git 이 없으면, `.git` 이 있는 체크아웃과 자기 일감 **밖** 경로에는 아무것도 쓰지 않는다.**
//     (ㄱ)은 ④층(추적 파일 확인)을 통과해야 하고 ④층은 git 의 답을 요구하며, (ㄴ)은 git 의
//     「저장소가 아니다」를 요구한다. **예외가 하나 있다** (r4 Codex R4-L2): 저장소 메타데이터가
//     아예 없는 **자기 일감 코드 사본** — 루트 이름이 `LIFE-NNN-…` 이고 그 안에 자기 specs 폴더가
//     있는 트리 — 은 조상에 `.git` 이 없어 ④층이 아예 서지 않으므로 git 없이도 지나간다.
//     실제 체크아웃의 동결 트리는 `.git` 교차 확인이 막는다(K 회차 전부 거절). "모든 실행에서
//     아무 데도 못 쓴다" 는 **틀린 문장**이었다.
//   - **0 으로 거짓말하는 git** (PATH 앞 스텁)이 있으면 **자기 일감 폴더 안에서는** ④층을 지나간다
//     — 커밋된 파일 위로 쓰는 것을 막지 못한다 (r4 Claude L3). 동결 트리는 ③층의 파일 시스템
//     사실(조상 `.git`)이 막으므로 영향은 자기 일감 폴더에 국한되고, r3 도 같았다(새 퇴행 아님).
//     ⑤층(`'wx'`)이 기존 파일 덮어쓰기는 계속 막는다.
//   - **「저장소가 아니다」는 git 의 메시지 문구로 읽는다** (영어·한국어). 번역 카탈로그가 설치된
//     git 에서 비영어 로케일이면 문구가 달라 `unavailable` → 거절이다. **이 기계에서는 발현하지
//     않는다**: `/usr/bin/git` 은 Apple Git 이고 번역 카탈로그가 없어 7개 로케일에서 전부 영어
//     원문을 낸다(r4 리뷰 `raw/review4/claude/k-locale-probe.txt`). 그래서 정규식의
//     `저장소가 아닙니다` 갈래는 **이 기계에서 도달 불가·미검증**이다. 방향은 안전한 쪽
//     (fail-closed, 정상 경로가 거절될 뿐)이라 마지막 라운드에서 고치지 않았다 — 고치려면
//     판정용 git 환경에 `LC_ALL=C` 를 박고 C4·K 회차를 다시 돌린다.
//   - ③(ㄴ)이 서면 저장소 밖 아무 디렉터리에나 쓴다. 동결 증거는 전부 저장소 안이고, 그 안으로
//     들어오는 모든 경로는 ③(ㄱ)·④·⑤ 를 지난다. (r3 의 "닿지 않는다" 는 git 무응답 경로를 빠뜨린
//     **틀린 문장**이었다 — K 가 그 경로로 실제 파일을 만들었다.)
//   - **일감 번호를 재사용한 worktree 는 그 일감의 동결 트리에 (ㄱ) 권한을 얻는다** (r3 지적 L-j).
//     예: 출고된 LIFE-393 의 후속 작업을 `LIFE-393-<새 슬러그>` 로 따면 `specs/LIFE-393-cli-terminal/`
//     이 그 실행의 「자기 일감 폴더」가 된다. ④층이 *이미 커밋된 파일을 담은* 디렉터리는 막으므로
//     기존 기록은 안전하고, 열리는 것은 **그 트리 안의 새 하위 폴더**다. 막지 않았다 — 「자기 일감
//     폴더」와 「출고된 동결 증거」가 같은 폴더인 상태 자체가 사람이 만든 것이고, 스크립트가 그 둘을
//     가를 사실을 갖고 있지 않기 때문이다. 번호를 재사용하지 않는 것이 규약이고, 재사용해야 하면
//     저장소 밖 디렉터리로 돌린다.
//   - 조상의 `.git` 은 **링크 자체의 존재**로 본다 (r4 지적 Z4). 끊긴 심볼릭 링크 `.git` 은 「저장소
//     밖」이 아니라 **판정할 수 없음**이고, 그래서 거절이다.
//   - 검증·리뷰 worktree 가 detached 이고 폴더 이름에도 일감 번호가 없으면 자기 일감 폴더를 못
//     찾는다. 그때는 저장소 **밖** 디렉터리로 돌린다(③(ㄴ)). 격리 git fixture 도 거절된다 —
//     가드를 시험하려면 저장소가 아닌 임시 디렉터리를 쓴다.
//
// 이 판정은 `CORRAL_BACKEND_BUILD_ROOT` 검사보다 **먼저** 오고, 어떤 파일·임시 디렉터리보다 앞에
// 선다 (아래 `mkdtempSync` 도 쓰기다).
const OUTPUT_NAME='source-reconstruction-final.json'
const repoRoot=path.resolve(app,'..')
/** 기록에 로컬 절대경로를 남기지 않는다 (LIFE-426 누출 규칙). 주어진 루트 밖이면 경로를 말하지 않는다. */
const describe=(target,root=repoRoot)=>{const rel=path.relative(root,target);if(rel.startsWith('..')||path.isAbsolute(rel))return '(이 저장소 밖 경로)';return rel===''?'(저장소 루트)':rel}
const refuse=(why,detail)=>{
 console.error(`verify-backend-source: ${why}`)
 for(const [key,value] of Object.entries(detail))console.error(`  ${key}: ${value}`)
 process.exit(2)
}
/**
 * git 한 번. 결과를 **세 가지로** 나눈다 (r3 지적 K). r3 은 실행 실패와 모든 비0 종료를 `null` 하나로
 * 합쳤고, 그 `null` 을 「어느 저장소에도 속하지 않는 곳」으로 읽었다 — `GIT_DIR=<없는 경로>` 한 줄,
 * `GIT_CEILING_DIRECTORIES` 한 줄, PATH 앞의 실패 스텁, git 없는 PATH 넷 다 그 길로 동결 트리에
 * **실제 파일을 만들었다.**
 *
 *   answered     — git 이 답했다
 *   not-a-repo   — git 이 「여기는 저장소가 아니다」라고 **말했다**
 *   unavailable  — 대답을 못 들었다 (실행 실패·다른 오류). 이것은 「저장소 밖」이 **아니다**
 *
 * 그리고 상속된 `GIT_*` 를 전부 걷어낸다. 판정을 호출자의 환경이 바꾸면 그것은 판정이 아니다.
 */
const GIT_ENV=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('GIT_')))
const git=(cwd,args)=>{
 const result=spawnSync('git',['-C',cwd,...args],{encoding:'utf8',maxBuffer:256*1024*1024,env:GIT_ENV})
 if(result.error!==undefined)return {kind:'unavailable',detail:`git 을 실행하지 못했다 (${result.error.code ?? 'spawn 실패'})`}
 if(result.status===0)return {kind:'answered',out:result.stdout}
 const said=String(result.stderr??'').trim()
 if(/not a git repository|저장소가 아닙니다/i.test(said))return {kind:'not-a-repo',detail:said.slice(0,120)}
 return {kind:'unavailable',detail:`git 이 ${result.status} 로 끝났다: ${said.slice(0,120)}`}
}
/** git 에 묻지 않고 파일 시스템 사실로 본다: 조상에 `.git` 이 있는가 (worktree 는 파일, 본체는 디렉터리). */
// 조상에 `.git` 이 있는가. **링크 자체의 존재**로 본다 (`lstat`) — `existsSync` 는 링크를 따라가므로
// **끊긴 심볼릭 링크** `.git` 을 「없다」로 답했고, 그러면 저장소 메타데이터가 상한 트리가 「저장소
// 밖」으로 읽혀 (ㄴ)이 열렸다 (r4 지적 Z4). 상한 링크는 「밖」이 아니라 **판정할 수 없음**이다.
const repoMarkerAbove=target=>{
 let current=target
 for(;;){
  try{fs.lstatSync(path.join(current,'.git'));return current}catch{/* 이 자리에는 없다 */}
  const parent=path.dirname(current)
  if(parent===current)return null
  current=parent
 }
}
/** 경로의 신원. 문자열이 달라도 같은 디렉터리면 같은 값이다 (macOS 의 `SPECS`/`specs` 별칭). */
const identity=target=>{try{const info=fs.statSync(target);return `${info.dev}:${info.ino}`}catch{return null}}
/** 대상의 조상 사슬에 그 신원이 있는가. 아직 없는 경로는 존재하는 조상까지 올라가며 본다. */
const under=(target,rootIdentity)=>{
 if(rootIdentity===null)return false
 let current=target
 for(;;){
  if(identity(current)===rootIdentity)return true
  const parent=path.dirname(current)
  if(parent===current)return false
  current=parent
 }
}
const TASK=/^LIFE-(\d+)\b/
// ① 이 실행이 쓸 디렉터리를 직접 지정한다. 기본 출력 경로는 없다.
const rawEnv=process.env.CORRAL_VERIFY_RAW
if(rawEnv===undefined||rawEnv.trim()==='')refuse(
 'CORRAL_VERIFY_RAW 가 필요하다. 기본 출력 경로는 없앴다 — 이 실행이 기록을 쓸 디렉터리를 직접 지정한다.',
 {예시:'CORRAL_VERIFY_RAW="$(mktemp -d)" node app/scripts/backend-source/verify-backend-source.mjs — 어느 저장소에도 속하지 않는 이 회차만의 새 디렉터리',
  이유:'예전 기본값은 specs/LIFE-393-cli-terminal/raw/codex 로 풀렸고 이 스크립트는 거기 고정 파일명을 덮어썼다 (LIFE-430 C4)'})
// ② 심링크를 끝까지 푼다. 아직 없는 디렉터리는 가장 가까운 존재하는 조상을 풀고 나머지를 잇는다.
const resolved=(()=>{
 let current=path.resolve(rawEnv)
 const tail=[]
 for(;;){
  let named=true
  try{fs.lstatSync(current)}catch{named=false}
  if(named){
   let real
   try{real=fs.realpathSync(current)}catch{refuse(
    'CORRAL_VERIFY_RAW 가 풀리지 않는 심볼릭 링크를 지난다.',
    {경로:describe(current),복구:'실재하는 디렉터리를 준다'})}
   return {path:path.join(real,...tail),anchor:fs.statSync(real).isDirectory()?real:path.dirname(real)}
  }
  const parent=path.dirname(current)
  if(parent===current)return {path:current,anchor:current}
  tail.unshift(path.basename(current))
  current=parent
 }
})()
const raw=resolved.path
const target=path.join(raw,OUTPUT_NAME)
// ③ 허용 목록. 이 worktree 자신의 일감 폴더이거나, 어느 저장소에도 속하지 않는 곳.
const mine=(()=>{
 const asked=git(repoRoot,['symbolic-ref','--short','HEAD'])
 const branch=asked.kind==='answered'?asked.out.trim():null
 if(branch!==null&&TASK.test(branch))return {task:TASK.exec(branch)[1],from:`브랜치 ${branch}`}
 const folder=path.basename(repoRoot)
 if(TASK.test(folder))return {task:TASK.exec(folder)[1],from:`worktree 폴더 ${folder}`}
 return {task:null,from:branch===null?'detached HEAD 이고 worktree 폴더 이름에도 일감 번호가 없다':`브랜치 ${branch} 에 일감 번호가 없다`}
})()
const home=(()=>{
 if(mine.task===null)return {identity:null,why:`이 실행의 일감을 알 수 없다 (${mine.from})`}
 const specs=path.join(repoRoot,'specs')
 let named=[]
 try{named=fs.readdirSync(specs).filter(name=>new RegExp(`^LIFE-${mine.task}-`).test(name))}catch{
  return {identity:null,why:'이 worktree 에 specs/ 가 없다'}}
 if(named.length!==1)return {identity:null,why:`specs/ 에서 LIFE-${mine.task}-… 폴더를 하나로 정하지 못했다 (${named.length}개)`}
 const folder=path.join(specs,named[0])
 return {identity:identity(fs.realpathSync(folder)),path:folder,why:null}
})()
const allowed=under(raw,home.identity)
if(!allowed){
 // **거절이 기본이다** (r3 지적 K). 지나가려면 「어느 저장소에도 속하지 않는다」가 **증명**돼야 하고,
 // 증명은 둘이 함께 설 때만 성립한다: 조상에 `.git` 이 하나도 없다(파일 시스템 사실) **그리고**
 // git 이 「저장소가 아니다」라고 말했다. 대답을 못 들은 것은 증명이 아니라 공백이다.
 const marker=repoMarkerAbove(resolved.anchor)
 const asked=git(resolved.anchor,['rev-parse','--show-toplevel'])
 const inside=asked.kind==='answered'?asked.out.trim():null
 if(!(marker===null&&asked.kind==='not-a-repo'))refuse(
  'CORRAL_VERIFY_RAW 가 허용되지 않은 자리를 가리킨다. 이 스크립트는 **이 worktree 자신의 일감 폴더** 아래이거나, **어느 저장소에도 속하지 않는다고 증명된** 곳에만 쓴다.',
  {디렉터리:describe(raw,inside??repoRoot),
   대상이_속한_저장소:inside===null?'git 이 확인해 주지 않았다':(inside===repoRoot?'이 worktree':'다른 저장소 또는 다른 worktree'),
   파일_시스템_사실:marker===null?'조상에 .git 없음':`조상에 .git 이 있다 (${describe(marker,inside??repoRoot)})`,
   git_의_답:asked.kind==='answered'?'저장소 안이라고 답했다':asked.detail,
   이_실행의_일감:mine.task===null?`알 수 없음 — ${mine.from}`:`LIFE-${mine.task} (${mine.from})`,
   허용되는_자리:home.identity===null?`정하지 못했다 — ${home.why}`:describe(home.path),
   복구:'이 일감 폴더 아래 이 회차만의 새 디렉터리를 주거나, git 이 답하는 상태에서 저장소 밖 디렉터리를 준다'})
}
// ④ 허용된 자리 안에도 이미 커밋된 원자료가 있다. 그 위에는 쓰지 않는다.
const top=git(resolved.anchor,['rev-parse','--show-toplevel'])
const inRepo=top.kind==='answered'?top.out.trim():null
if(inRepo!==null||repoMarkerAbove(resolved.anchor)!==null){
 if(inRepo===null)refuse(
  '조상에 `.git` 이 있는데 git 이 그 저장소를 확인해 주지 않았다. 답을 못 들은 것을 「저장소 밖」으로도 「추적 없음」으로도 읽지 않는다.',
  {디렉터리:describe(raw),git_의_답:top.detail,복구:'git 이 답하는 상태에서 다시 돌린다'})
 const listed=git(inRepo,['ls-files','--',raw])
 if(listed.kind!=='answered')refuse(
  'git 이 이 디렉터리의 추적 파일을 답하지 못했다. 답을 못 들은 것을 「추적 없음」으로 읽지 않는다.',
  {디렉터리:describe(raw,inRepo),git_의_답:listed.detail,복구:'git 이 답하는 상태에서 다시 돌리거나, 저장소 밖 디렉터리를 준다'})
 const committed=listed.out.split('\n').filter(line=>line.length>0)
 if(committed.length>0)refuse(
  'CORRAL_VERIFY_RAW 가 이미 커밋된 원자료를 담은 디렉터리를 가리킨다. 기존 기록 위에는 쓰지 않는다.',
  {디렉터리:describe(raw,inRepo),추적중인_파일수:committed.length,첫_파일:committed[0],
   복구:'이 실행 회차만의 새 디렉터리를 준다 — 기존 기록 옆에 쓰고, 그 위에 쓰지 않는다'})
}
// ⑤ 쓰려는 파일이 이미 있으면 거절한다.
if(fs.existsSync(target))refuse(
 '쓰려는 파일이 이미 있다. 앞선 회차의 기록을 덮지 않는다.',
 {파일:describe(target,inRepo??repoRoot),git:inRepo===null?'답 없음 (이 저장소 밖이거나 git 이 없다)':'추적 안 됨',
  복구:'이 실행 회차만의 새 디렉터리를 준다'})
const work=process.env.CORRAL_BACKEND_BUILD_ROOT
assert(work,'Set CORRAL_BACKEND_BUILD_ROOT')
const source=JSON.parse(fs.readFileSync(path.join(app,'backend/source.json')))
const hash=buffer=>createHash('sha256').update(buffer).digest('hex')
assert.equal(hash(fs.readFileSync(path.join(work,'herdr.tar.gz'))),source.archiveSHA256)
const root=fs.mkdtempSync('/tmp/l393-' + (process.env.CORRAL_VERIFY_OWNER ?? 'codex') + '-source-'),extracted=path.join(root,'herdr-0.9.0')
const unpack=spawnSync('tar',['-xzf',path.join(work,'herdr.tar.gz'),'-C',root]);assert.equal(unpack.status,0)
const files=new Set()
for(const name of source.patches){
 const patch=fs.readFileSync(path.join(app,'backend',name));assert.equal(hash(patch),source.patchSHA256[name])
 const applied=spawnSync('patch',['-p1'],{cwd:extracted,input:patch});assert.equal(applied.status,0,applied.stdout.toString()+applied.stderr.toString())
 for(const line of patch.toString().split('\n'))if(line.startsWith('+++ b/'))files.add(line.slice(6))
}
const records=[]
for(const file of files){const expected=fs.readFileSync(path.join(extracted,file)),actual=fs.readFileSync(path.join(work,'herdr-0.9.0',file));assert.deepEqual(actual,expected,file);records.push({file,sha256:hash(actual),matchesReconstruction:true})}
fs.mkdirSync(raw,{recursive:true});fs.writeFileSync(target,JSON.stringify({source,records},null,2)+'\n',{flag:'wx'});console.log(`${records.length} patched files match pinned archive + committed patches`)
