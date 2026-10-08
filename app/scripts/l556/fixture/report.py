# LIFE-556 fix1 M1 — run the worker_done command the delivered preamble spells, from inside the pane.
# The corral command, task id and dispatch id are read out of the body; nothing is assumed.
import datetime, json, os, re, subprocess, sys
body = open(sys.argv[1], 'rb').read().decode('utf-8', 'replace').replace('\r\n', '\n').replace('\r', '\n')
body = re.sub(r'\x1b\[20[01]~', '', body)
# The provider's own record, as claude writes it, under the isolated HOME: corral confirms a submission
# only by finding the body there (agent.ts countSubmissions). The typed lead line is not part of the body.
LEAD = "The block pasted below is this session's task, delivered by corral. Follow it:"
session = sys.argv[2] if len(sys.argv) > 2 else ''
submitted = body[len(LEAD):] if body.startswith(LEAD) else body
if session:
    cwd = os.path.realpath(os.getcwd())
    folder = os.path.join(os.environ['HOME'], '.claude', 'projects', re.sub(r'[^A-Za-z0-9]', '-', cwd))
    os.makedirs(folder, exist_ok=True)
    row = {'type': 'user', 'origin': {'kind': 'human'}, 'message': {'role': 'user', 'content': submitted.strip(' \t\n')},
           'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')}
    with open(os.path.join(folder, session + '.jsonl'), 'a') as record:
        record.write(json.dumps(row) + '\n')
    print('RECORDED', session)
m = re.search(r'^[ \t]*(?P<cmd>\S.*?) orchestration send \\\n[ \t]+--type worker_done', body, re.M)
ids = re.search(r'--task-id (\S+) --dispatch-id (\S+) --outcome succeeded', body)
if not m or not ids:
    print('PARSE_FAILED'); sys.exit(3)
cmd = m.group('cmd')
# Let worker-start finish confirming its one submission before the attempt settles under it.
import time; time.sleep(float(os.environ.get('L556_FIXTURE_REPORT_DELAY', '6')))
print('CORRAL_CMD ' + cmd)
line = f"{cmd} orchestration send --type worker_done --subject fixture-done --body 'fixture: preamble received in pane, reported from pane' --task-id {ids.group(1)} --dispatch-id {ids.group(2)} --outcome succeeded --json"
done = subprocess.run(['/bin/sh', '-c', line], capture_output=True, text=True, timeout=60)
print('EXIT', done.returncode)
print(done.stdout[-4000:])
print(done.stderr[-2000:])
sys.exit(done.returncode)
