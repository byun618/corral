# LIFE-605 — fixture·출처가 쓰는 엔드포인트가 공식 명세(받아 둔 사본, 커밋 안 함)에 있는지 · 옛 경로가 deprecated 인지.
# 쓰기: python3 -I scripts/l605/spec-paths.py <명세 폴더(platform.json·software.json)>   — 없는 경로가 있거나 옛 경로가 deprecated 가 아니면 exit 1.
import hashlib, json, sys, pathlib
root = pathlib.Path(sys.argv[1])
docs = {name: json.loads((root / f'{name}.json').read_text()) for name in ('platform', 'software')}
for name in docs: print(f"sha256 {name}.json {hashlib.sha256((root / f'{name}.json').read_bytes()).hexdigest()} — {docs[name]['info']['title']} {docs[name]['info']['version']}")
USED = [('platform', 'get', '/rest/api/3/myself'), ('platform', 'get', '/rest/api/3/project/search'), ('platform', 'get', '/rest/api/3/project/{projectIdOrKey}'), ('platform', 'get', '/rest/api/3/project/{projectIdOrKey}/statuses'),
  ('platform', 'get', '/rest/api/3/search/jql'), ('platform', 'get', '/rest/api/3/issue/{issueIdOrKey}'), ('platform', 'put', '/rest/api/3/issue/{issueIdOrKey}'), ('platform', 'post', '/rest/api/3/issue'),
  ('platform', 'get', '/rest/api/3/issue/{issueIdOrKey}/transitions'), ('platform', 'post', '/rest/api/3/issue/{issueIdOrKey}/transitions'), ('platform', 'get', '/rest/api/3/issue/{issueIdOrKey}/changelog'),
  ('platform', 'get', '/rest/api/3/issue/{issueIdOrKey}/comment'), ('platform', 'post', '/rest/api/3/issue/{issueIdOrKey}/comment'), ('platform', 'get', '/rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}'),
  ('platform', 'get', '/rest/api/3/priority/search'), ('platform', 'get', '/rest/api/3/issueLinkType'), ('platform', 'post', '/rest/api/3/issueLink'), ('platform', 'delete', '/rest/api/3/issueLink/{linkId}'),
  ('platform', 'get', '/rest/api/3/issue/{issueIdOrKey}/remotelink'), ('platform', 'post', '/rest/api/3/issue/{issueIdOrKey}/remotelink'), ('platform', 'delete', '/rest/api/3/issue/{issueIdOrKey}/remotelink'),
  ('software', 'get', '/rest/agile/1.0/board'), ('software', 'put', '/rest/agile/1.0/issue/rank')]
LEGACY = [('platform', 'get', '/rest/api/3/search'), ('platform', 'get', '/rest/api/3/issue/createmeta')]
bad = 0
for spec, method, path in USED + LEGACY:
  op = docs[spec]['paths'].get(path, {}).get(method)
  legacy = (spec, method, path) in LEGACY
  if op is None: print(f'MISSING {spec} {method.upper()} {path}'); bad += 1; continue
  deprecated = bool(op.get('deprecated'))
  ok = deprecated if legacy else not deprecated
  bad += 0 if ok else 1
  print(f"{'ok ' if ok else 'BAD'} {spec} {method.upper()} {path}{' (옛 경로 — deprecated)' if legacy else ''} responses={','.join(sorted(op.get('responses', {})))}")
print(f'used={len(USED)} legacy={len(LEGACY)} bad={bad}')
sys.exit(1 if bad else 0)
