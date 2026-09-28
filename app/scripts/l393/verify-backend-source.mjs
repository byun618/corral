import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
import {app} from './lib.mjs'
// LIFE-430 C4 (LA ③, 구 LIFE-424). 이 스크립트의 출력 경로는 기본값이 LIFE-393 의 **동결 raw** 로
// 풀렸고, 파일명이 고정이라 그 자리를 그대로 덮어썼다. LIFE-409 구현이 이 함정을 두 번(r1·r3) 밟아
// 출고된 작업의 원자료가 지워졌다 — `43ba1fa6` 가 덮었고 r3 리뷰가 잡아 `7cfdd0f8` 로 복원했다.
// 증거가 진실의 원천인 구조에서, 증거를 지우는 쪽이 기본값이었다.
//
// 그래서 출력 경로는 **쓰기 전에** 세 층으로 판정한다. 필수 인자 한 층만으로는 부족하다: 그것은
// "아무것도 안 주면" 만 막고, 동결 경로를 **명시해서** 주는 세 번째 사고는 그대로 통과시킨다.
//
//   ① `CORRAL_VERIFY_RAW` 가 없으면 거절한다. 기본 경로는 없앴다.
//   ② 그 디렉터리가 git 추적 파일을 하나라도 담고 있으면 거절한다 — 그것은 누군가 커밋한 원자료
//      트리이고, 이 스크립트가 그 안에 무언가를 만들 이유가 없다. (쓰려는 파일 자신이 추적 중인
//      경우도 여기에 걸린다 — 동결 raw 의 `source-reconstruction-final.json` 이 정확히 그 경우다.)
//   ③ 쓰려는 파일이 이미 있으면 거절한다. 추적되지 않는 앞선 회차의 기록도 덮지 않는다.
//
// 그리고 실제 쓰기는 `'wx'` 로 한다 — 판정과 쓰기 사이의 창을 커널이 닫는다.
//
// 한계 두 가지. ②는 `git ls-files` 에 묻는다. 대상이 이 저장소 밖이거나 git 이 답하지 않으면
// "추적 안 됨" 으로 읽고 ①·③·`'wx'` 만 남는다 — 그 경우 거절 메시지가 `git: 답 없음` 을 말한다.
// 그리고 ②·③ 은 *새* 디렉터리를 요구하므로, 같은 관문을 다시 돌리려면 회차마다 새 하위 폴더를
// 준다. 그것이 옆에 쓰고 덮지 않는다는 규칙(LIFE-410 N12=C18)과 같은 말이다.
//
// 이 판정은 `CORRAL_BACKEND_BUILD_ROOT` 검사보다 **먼저** 오고, 어떤 파일·임시 디렉터리보다 앞에
// 선다 (아래 `mkdtempSync` 도 쓰기다).
const OUTPUT_NAME='source-reconstruction-final.json'
const repoRoot=path.resolve(app,'..')
/** 기록에 로컬 절대경로를 남기지 않는다 (LIFE-426 누출 규칙). 저장소 밖이면 경로를 말하지 않는다. */
const describe=target=>{const rel=path.relative(repoRoot,target);return rel.startsWith('..')||path.isAbsolute(rel)?'(이 저장소 밖 경로)':rel}
const refuse=(why,detail)=>{
 console.error(`verify-backend-source: ${why}`)
 for(const [key,value] of Object.entries(detail))console.error(`  ${key}: ${value}`)
 process.exit(2)
}
const rawEnv=process.env.CORRAL_VERIFY_RAW
if(rawEnv===undefined||rawEnv.trim()==='')refuse(
 'CORRAL_VERIFY_RAW 가 필요하다. 기본 출력 경로는 없앴다 — 이 실행이 기록을 쓸 디렉터리를 직접 지정한다.',
 {예시:'CORRAL_VERIFY_RAW="$PWD/specs/LIFE-NNN-<슬러그>/raw/worker/<owner>/backend/<회차>" node app/scripts/l393/verify-backend-source.mjs',
  이유:'예전 기본값은 specs/LIFE-393-cli-terminal/raw/codex 로 풀렸고 이 스크립트는 거기 고정 파일명을 덮어썼다 (LIFE-430 C4)'})
const raw=path.resolve(rawEnv)
const target=path.join(raw,OUTPUT_NAME)
/** 그 디렉터리가 담은 git 추적 파일. git 이 답하지 못하면 `answered: false` 로 돌려준다. */
const trackedUnder=dir=>{
 const result=spawnSync('git',['-C',repoRoot,'ls-files','--',dir],{encoding:'utf8'})
 if(result.error!==undefined||result.status!==0)return {answered:false,files:[]}
 return {answered:true,files:result.stdout.split('\n').filter(line=>line.length>0)}
}
const committed=trackedUnder(raw)
if(committed.files.length>0)refuse(
 'CORRAL_VERIFY_RAW 가 이미 커밋된 원자료를 담은 디렉터리를 가리킨다. 출고된 작업의 동결 증거 위에는 쓰지 않는다.',
 {디렉터리:describe(raw),추적중인_파일수:committed.files.length,
  첫_파일:committed.files[0],
  복구:'이 실행 회차만의 새 디렉터리를 준다 — 기존 기록 옆에 쓰고, 그 위에 쓰지 않는다'})
if(fs.existsSync(target))refuse(
 '쓰려는 파일이 이미 있다. 앞선 회차의 기록을 덮지 않는다.',
 {파일:describe(target),git:committed.answered?'추적 안 됨':'답 없음 (이 저장소 밖이거나 git 이 없다)',
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
