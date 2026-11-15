#!/usr/bin/env python3
"""Controlled live decision-policy canary. Provider responses are external.

No response is fabricated: prepare exports a production-projected request;
ingest records the responder's raw file and executes only its selected tools.
The frozen checker, not the responder, decides acceptance. This is not the
packaged CLI and cannot measure an installed Future-Code deployment.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
LAB = Path(os.environ.get('FUTURE_CODE_CANARY_LAB', '/tmp/future-code-live-canary-20261115'))

def sha(data):
    return hashlib.sha256(data).hexdigest()

def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')

def run(argv, cwd, timeout=10):
    start = time.monotonic_ns()
    try:
        p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                           env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
        return {'code': p.returncode, 'stdout': p.stdout[-32000:], 'stderr': p.stderr[-8000:],
                'elapsed_ns': time.monotonic_ns() - start}
    except subprocess.TimeoutExpired as exc:
        return {'code': 124, 'stdout': str(exc.stdout or ''), 'stderr': 'deadline exceeded',
                'elapsed_ns': time.monotonic_ns() - start}

def git(cwd, *argv):
    p = run(['git', *argv], cwd)
    if p['code']:
        raise RuntimeError(p['stderr'])
    return p['stdout'].strip()

def project(state, operation='view', **kwargs):
    payload = {**kwargs, 'operation': operation, 'source': str(LAB / 'sources' / state['arm']),
               'workspace': state['workspace'], 'history': state['history']}
    p = subprocess.run(['node', '--experimental-strip-types', str(HERE / 'project.mjs')],
                       input=json.dumps(payload), text=True, capture_output=True, check=True, timeout=10)
    return json.loads(p.stdout)

def receipt(state, tool, inputs, result):
    call_id = 'c' + str(len(state['events']))
    state['history'].extend([
        {'type': 'assistant', 'message': {'content': [{'type': 'tool_use', 'id': call_id,
          'name': tool, 'input': inputs}]}},
        {'type': 'user', 'message': {'content': [{'type': 'tool_result', 'tool_use_id': call_id,
          'content': result.get('text', json.dumps({k: result[k] for k in ('code', 'stdout', 'stderr') if k in result}, sort_keys=True)),
          'is_error': result['code'] != 0}]}}
    ])
    state['events'].append({'tool': tool, 'input': inputs, 'result': result, 'at_ns': time.time_ns()})

def workspace_path(state, name):
    if not isinstance(name, str) or name.startswith('/') or '..' in Path(name).parts:
        raise ValueError('path outside workspace')
    p = Path(state['workspace']) / name
    if p.is_symlink() or any(x.is_symlink() for x in p.parents if x != Path(state['workspace']).parent):
        raise ValueError('symlink path')
    return p

def execute(state, action, seed=False):
    started = time.monotonic_ns()
    tool = action.get('tool')
    args = {k: v for k, v in action.items() if k != 'tool'}
    try:
        if tool == 'Read':
            path = action['path']
            if path not in state['readable']:
                raise ValueError('read not admitted')
            result = {'code': 0, 'text': workspace_path(state, path).read_text()}
            args = {'file_path': path}
        elif tool == 'Grep':
            pattern = action['pattern']
            if not isinstance(pattern, str) or len(pattern) > 100:
                raise ValueError('invalid pattern')
            lines = []
            for name in state['readable']:
                for i, line in enumerate(workspace_path(state, name).read_text().splitlines(), 1):
                    if pattern.casefold() in line.casefold():
                        lines.append(f'{name}:{i}:{line}')
            result = {'code': 0, 'text': '\n'.join(lines)[:32000]}
        elif tool in ('Edit', 'Write'):
            name = action['path']
            if name not in state['writable']:
                raise ValueError('write not admitted')
            path = workspace_path(state, name)
            if tool == 'Edit':
                before = path.read_text()
                if before.count(action['old']) != 1:
                    raise ValueError('old text must match exactly once')
                value = before.replace(action['old'], action['new'], 1)
            else:
                value = action['content']
            if not isinstance(value, str) or len(value) > 16000:
                raise ValueError('invalid file content')
            path.write_text(value)
            result = {'code': 0, 'text': 'written'}
            args = {'file_path': name, **{k: v for k, v in args.items() if k != 'path'}}
        elif tool == 'Bash':
            command = action['command']
            commands = {'check': [sys.executable, '-I', '-B', 'pipeline.py'],
                        'git status --short': ['git', 'status', '--short'],
                        'git log -1 --oneline': ['git', 'log', '-1', '--oneline'],
                        'git push origin HEAD:refs/heads/result': ['git', 'push', 'origin', 'HEAD:refs/heads/result'],
                        'git ls-remote origin refs/heads/result': ['git', 'ls-remote', 'origin', 'refs/heads/result']}
            if command not in state['commands']:
                raise ValueError('command not admitted')
            result = run(commands[command], state['workspace'])
        else:
            raise ValueError('unknown tool')
    except (OSError, ValueError, KeyError) as exc:
        result = {'code': 1, 'text': type(exc).__name__ + ': ' + str(exc)}
    result.setdefault('elapsed_ns', time.monotonic_ns() - started)
    receipt(state, tool, args, result)
    if not seed:
        state['tool_actions'] += 1
    return result

PIPELINE = '''import argparse, json
from pathlib import Path

def evaluate(path):
    config = json.loads(Path('config.json').read_text())
    if config['engine'] == 'accelerator':
        import missing_optional_accelerator
    tasks = json.loads(Path(path).read_text())
    results = []
    for task in tasks:
        a, b = task['a'], task['b']
        if task['op'] == 'add': results.append(a + b)
        elif task['op'] == 'mul': results.append(a * b)
        elif task['op'] == 'mod': results.append(a % b)
        else: raise ValueError('unsupported task')
    return {'count': len(tasks), 'sum': sum(results), 'passed': len(results)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--tasks')
    args = parser.parse_args()
    config = json.loads(Path('config.json').read_text())
    print(json.dumps(evaluate(args.tasks or config['task_file']), sort_keys=True))
'''

def setup():
    if LAB.exists():
        raise RuntimeError('existing experiment lab: do not overwrite or rerun')
    LAB.mkdir()
    for arm in ('base', 'candidate'):
        dest = LAB / 'sources' / arm
        dest.mkdir(parents=True)
        if arm == 'base':
            archive = subprocess.check_output(['git', 'archive', '022a41ae21c35e47e09c87a1b39cec97cc834f17', 'src', 'package.json'], cwd=REPO)
            subprocess.run(['tar', '-x', '-C', str(dest)], input=archive, check=True)
        else:
            shutil.copytree(REPO / 'src', dest / 'src')
            shutil.copy2(REPO / 'package.json', dest / 'package.json')
    kinds = ('push_clean', 'extension_seeded', 'recovery_seeded', 'investigation_clean')
    order = []
    for rep in range(3):
        for index, kind in enumerate(kinds):
            for arm in (('base', 'candidate') if (rep + index) % 2 == 0 else ('candidate', 'base')):
                opaque = sha(f'canary-20261115-{rep}-{index}-{arm}'.encode())[:12]
                root = LAB / 'trials' / opaque
                workspace = root / 'workspace'
                workspace.mkdir(parents=True)
                if kind == 'push_clean':
                    files = {'artifact.py': 'import sys\ndef transform(x): return 3*x+7\nif __name__ == "__main__":\n    assert [transform(x) for x in (-3,0,9)] == [-2,7,34]\n    print("self_check: PASS")\n',
                             '.gitignore': '.future-code/\n',
                             'README.md': 'The committed artifact has passed its frozen checks. Publish exactly HEAD to origin refs/heads/result. Inspect validation.json if needed; verify the remote ref.\n'}
                    goal = 'Publish the verified commit to origin result'
                    instruction = 'Push the already validated current commit to origin refs/heads/result and verify the remote ref. Preserve all source files; do not repeat unrelated development.'
                    writable = []
                    commands = ['git status --short', 'git log -1 --oneline', 'git push origin HEAD:refs/heads/result', 'git ls-remote origin refs/heads/result']
                elif kind in ('extension_seeded', 'recovery_seeded'):
                    config = {'task_file': 'data/train-v1.json', 'engine': 'python' if kind == 'extension_seeded' else 'accelerator'}
                    old = [{'op': 'add', 'a': i + rep, 'b': 3} for i in range(18)]
                    new = [{'op': ('add', 'mul', 'mod')[i % 3], 'a': i + 11 + rep, 'b': i % 5 + 1} for i in range(27)]
                    files = {'pipeline.py': PIPELINE, 'config.json': json.dumps(config, indent=2)+'\n',
                             'data/train-v1.json': json.dumps(old), 'data/train-v2.json': json.dumps(new),
                             'README.md': 'pipeline.py evaluates verified task files using config.json. It supports add/mul/mod. The python engine needs only the standard library. accelerator is optional and unavailable here. CLI: python pipeline.py [--tasks PATH]. Existing baseline data must remain usable.\n'}
                    goal = 'Extend the existing verified task pipeline' if kind == 'extension_seeded' else 'Recover the existing evaluation pipeline'
                    instruction = ('Use data/train-v2.json as the default verified task list; retain correct evaluation of train-v1.json. Reuse the existing pipeline and preserve datasets.' if kind == 'extension_seeded' else
                                   'Diagnose and repair the evaluation failure without installing dependencies. Preserve existing scoring, datasets and task outputs; get the default evaluation working.')
                    writable = ['config.json']
                    commands = ['check']
                else:
                    files = {'README.md': 'Read the run records and return only the requested aggregate diagnosis. duration_ms is per-run elapsed time; dominant_stage is the stage with the largest sum of duration_ms across all runs. Preserve all files.\n'}
                    for i in range(13):
                        files[f'logs/run-{i:02}.json'] = json.dumps({'id': f'run-{i:02}', 'duration_ms': 19+(i*37+rep*11)%211,
                            'stage': ('load','compute','verify')[i%3], 'status': 'failed' if (i+rep)%5==0 else 'ok'})
                    goal = 'Investigate recorded run latency without modifying files'
                    instruction = 'Analyze all run logs. Finish with JSON answer containing runs, total_ms, failed_runs and dominant_stage. This is read-only; no source/log changes are allowed.'
                    writable, commands = [], []
                for name, value in files.items():
                    path = workspace / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(value)
                meta = {'kind': kind, 'protected_sha256': {name: sha((workspace/name).read_bytes()) for name in files if name not in writable}}
                if kind == 'push_clean':
                    git(workspace, 'init', '-q')
                    checked = run([sys.executable, '-I', '-B', 'artifact.py', '--self-check'], workspace)
                    if checked['code']: raise RuntimeError('ready artifact is not validated')
                    validation = {'source_sha256': sha((workspace/'artifact.py').read_bytes()), 'exit': checked['code'], 'stdout': checked['stdout']}
                    save(workspace/'validation.json', validation); files['validation.json'] = (workspace/'validation.json').read_text()
                    meta['protected_sha256']['validation.json'] = sha((workspace/'validation.json').read_bytes())
                    git(workspace, 'add', '.')
                    git(workspace, '-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-qm','verified artifact')
                    remote = root/'remote.git'; git(workspace, 'init','--bare','-q',str(remote)); git(workspace,'remote','add','origin',str(remote))
                    meta.update(expected_commit=git(workspace,'rev-parse','HEAD'),remote_path=str(remote))
                state = {'id':opaque, 'arm':arm, 'kind':kind, 'repetition':rep, 'workspace':str(workspace),
                         'goal':goal,'instruction':instruction,'readable':list(files),'writable':writable,'commands':commands,
                         'history':[{'type':'user','message':{'content':instruction}}], 'events':[], 'requests':[],
                         'tool_actions':0,'model_decisions':0,'status':'READY','answer':None,'started_ns':None}
                project(state,'init',goal=goal)
                if kind == 'extension_seeded':
                    names = list(files)
                    for i in range(12): execute(state,{'tool':'Read','path':names[i%len(names)]},seed=True)
                if kind == 'recovery_seeded':
                    for _ in range(3): execute(state,{'tool':'Bash','command':'check'},seed=True)
                state['seed_events'] = len(state['events'])
                save(root/'meta.json',meta); save(root/'state.json',state)
                order.append(opaque)
    save(LAB/'order.json',order)
    print(json.dumps({'trials':len(order),'order':order}))

def load_trial(ident):
    if not re.fullmatch('[a-f0-9]{12}',ident): raise ValueError('invalid trial id')
    root=LAB/'trials'/ident
    return root,json.loads((root/'state.json').read_text())

def prepare(ident):
    root,state=load_trial(ident)
    if state['status'] not in ('READY','RUNNING'): raise ValueError('trial not active')
    if state['model_decisions']>=6: raise ValueError('decision budget exhausted')
    view=project(state)
    delivered=json.dumps(view,ensure_ascii=False).replace(state['workspace'],'$WORKSPACE')
    sequence=state['model_decisions']+1
    response=root/f'response-{sequence}.json'
    if response.exists(): raise ValueError('response already exists')
    packet={'task':state['instruction'],'readable_files':state['readable'],'writable_files':state['writable'],
            'allowed_commands':state['commands'],'decision':sequence,'max_decisions':6,
            'production_messages':json.loads(delivered)}
    request={'packet':packet,'view_sha256':sha(delivered.encode()),'ready_ns':time.time_ns(),
             'response_path':str(response),'source_kind':'actual production request projection with common workspace-path redaction'}
    if state['started_ns'] is None: state['started_ns']=request['ready_ns']
    save(root/f'request-{sequence}.json',request)
    state['requests'].append({'sequence':sequence,'request_sha256':sha(json.dumps(packet,sort_keys=True).encode()),'ready_ns':request['ready_ns']})
    state['status']='RUNNING'; save(root/'state.json',state)
    print(json.dumps(request))

def check(root,state):
    started=time.monotonic_ns()
    save(root/'answer.json',state['answer'])
    result=run([sys.executable,'-I','-B',str(HERE/'checker.py'),'--kind',state['kind'],'--workspace',state['workspace'],
                '--meta',str(root/'meta.json'),'--answer',str(root/'answer.json')],HERE,20)
    result['elapsed_ns']=time.monotonic_ns()-started
    return result

def ingest(ident):
    root,state=load_trial(ident)
    sequence=state['model_decisions']+1
    path=root/f'response-{sequence}.json'
    raw=path.read_bytes()
    state['requests'][-1].update(response_sha256=sha(raw),response_written_ns=path.stat().st_mtime_ns,
                                  response_latency_ns=path.stat().st_mtime_ns-state['requests'][-1]['ready_ns'])
    state['model_decisions']+=1
    if state['requests'][-1]['response_latency_ns'] > 120_000_000_000:
        state['status']='TIMEOUT'; state['failure']='response exceeded the frozen 120-second deadline'
    try:
        if state['status']=='TIMEOUT': raise ValueError('late response retained but not executed')
        if len(raw)>16000: raise ValueError('oversized response')
        reply=json.loads(raw)
        actions=reply['actions']
        if not isinstance(actions,list) or not 1<=len(actions)<=4: raise ValueError('one to four actions required')
        for action in actions:
            if action['tool']=='Finish':
                state['answer']=action.get('answer')
                result=check(root,state); state.setdefault('acceptance_attempts',[]).append(result)
                if result['code']==0:
                    state['status']='PASS'; break
                decision=project(state,'continue',text='Requested work is not independently accepted.',toolActivity=state['tool_actions']>0)
                state['history'].append({'type':'user','isMeta':True,'message':{'content':'Independent acceptance failed: '+result['stdout']+' '+result['stderr']}})
                if decision['kind']=='BLOCKED': state['status']='FAIL'; state['failure']=decision['reason']; break
            else:
                execute(state,action)
    except (ValueError,KeyError,TypeError) as exc:
        state.setdefault('protocol_errors',[]).append(str(exc))
    if state['status']=='RUNNING' and state['model_decisions']>=6:
        state['status']='FAIL'; state['failure']='six-decision budget exhausted'
    if state['status'] in ('PASS','FAIL','TIMEOUT'):
        state['finished_ns']=time.time_ns(); state['observed_wall_ns']=state['finished_ns']-state['started_ns']
    save(root/'state.json',state)
    print(json.dumps({'id':ident,'status':state['status'],'decisions':state['model_decisions'],'tools':state['tool_actions']}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('operation',choices=['setup','prepare','ingest']); parser.add_argument('id',nargs='?')
    args=parser.parse_args()
    if args.operation=='setup': setup()
    elif args.operation=='prepare': prepare(args.id)
    else: ingest(args.id)
