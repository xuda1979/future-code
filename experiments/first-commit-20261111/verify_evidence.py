"""Independent recomputation from saved requests, files and event streams.

Does not import the experiment producer or its result-aggregation helpers.
"""
from pathlib import Path
import copy
import hashlib
import json
import statistics

HERE = Path(__file__).resolve().parent

def digest(value):
    return hashlib.sha256(value).hexdigest()

def view_check(directory, result, inputs):
    messages = json.loads((directory / 'request-view.json').read_text())
    # JSON.stringify uses compact UTF8 serialization, preserving literal Unicode.
    actual_bytes = len(json.dumps(messages, separators=(',', ':'), ensure_ascii=False).encode())
    assert actual_bytes == result['requestBytes'], (directory.name, actual_bytes, result['requestBytes'])
    blocks = {b['tool_use_id']: b for m in messages if m['type'] == 'user'
              for b in m['message']['content'] if b['type'] == 'tool_result'}
    assert len(blocks) == len(inputs)
    for i, raw in enumerate(inputs):
        block = blocks[f'result-{i}']
        receipt = directory / 'session/tool-results' / f'result-{i}.txt'
        if receipt.exists():
            assert receipt.read_bytes() == raw.encode(), (directory.name, i, 'receipt corruption')
            assert str(receipt.name) in block['content'], (directory.name, i, 'missing reference')
        else:
            assert block['content'] == (raw or '(Bash completed with no output)'), (directory.name, i, 'inline corruption')
    return actual_bytes

review = HERE / 'review-results-v2'
review_samples = json.loads((review / 'samples.json').read_text())
full_inputs = json.loads((review / 'input.json').read_text())
small_inputs = json.loads((review / 'small-input.json').read_text())
bytes_by_label = {'baseline': [], 'candidate': []}
for s in review_samples:
    directory = review / f"{s['scenario']}-{s['repetition']}-{s['label']}"
    assert s['exitCode'] == 0
    count = view_check(directory, s['result'], small_inputs if s['scenario'] == 'small' else full_inputs)
    if s['scenario'] == 'architecture-review': bytes_by_label[s['label']].append(count)
b, c = (statistics.median(bytes_by_label[label]) for label in ['baseline', 'candidate'])
assert b > c and len(bytes_by_label['baseline']) == len(bytes_by_label['candidate']) == 4

main = HERE / 'results'
samples = json.loads((main / 'samples.json').read_text())
dataset = json.loads((HERE / 'data/HumanEval.json').read_text())
provenance = json.loads((HERE / 'data/provenance.json').read_text())
assert digest((HERE / 'data/HumanEval.json').read_bytes()) == provenance['extractedSha256']
expected_programs = {p['task_id']: digest((p['prompt'] + p['canonical_solution'] + '\n' + p['test'] + f"\ncheck({p['entry_point']})\n").encode()) for p in dataset}
faults = ['stream-throw-before-result','stream-throw-after-effect','empty-stream-after-effect','context-modifier-throw','schema-preflight-throw']
executor_accepted = {label: {f: 0 for f in ['healthy','ordinary-error-result'] + faults} for label in ['baseline','candidate']}
human = []
for s in samples:
    directory = main / s['directory']
    event_file = directory / 'events.jsonl'
    events = [json.loads(line) for line in event_file.read_text().splitlines()] if event_file.exists() else []
    results = [e for e in events if e['kind'] == 'result']
    if s['mode'] == 'executor':
        artifact = directory / 'artifact.txt'
        expected = b'unchanged-evidence\n' if s['scenario'] in ['stream-throw-before-result','schema-preflight-throw'] else b'verified-effect\n'
        actual = artifact.read_bytes() if artifact.exists() else None
        paired = {r['tool_use_id']: r for r in results}
        followup = paired.get('followup', {})
        op = paired.get('operation', {})
        accepted = bool(op and followup.get('content', '').encode() == expected and not followup.get('is_error')
            and actual == expected and (s['scenario'] == 'healthy' or op.get('is_error')))
        assert accepted == bool(s['result'] and s['result']['accepted']), (directory.name, 'contract mismatch')
        executor_accepted[s['label']][s['scenario']] += accepted
    if s['mode'] == 'humaneval':
        passed = [e for e in events if e['kind'] == 'test-pass']
        for e in passed: assert e['programSha256'] == expected_programs[e['id']]
        assert len({e['id'] for e in passed}) == len(passed)
        fault_root = s['scenario'] == 'stream-throw-after-result' and s['label'] == 'baseline'
        assert len(passed) == (33 if fault_root else 164)
        assert len(results) == (32 if fault_root else 164)
        assert s['exitCode'] == (1 if fault_root else 0)
        explicit_errors = sum(bool(r.get('is_error')) for r in results)
        assert explicit_errors == (1 if s['scenario'] == 'stream-throw-after-result' and s['label'] == 'candidate' else 0)
        human.append({'scenario':s['scenario'],'label':s['label'],'passed':len(passed),'receipts':len(results),'errors':explicit_errors})
for label in ['baseline','candidate']:
    for scenario in ['healthy','ordinary-error-result'] + faults:
        assert executor_accepted[label][scenario] == (4 if label == 'candidate' or scenario not in faults else 0)
assert len(human) == 16

# Non-vacuous tamper controls: neither altered counts nor altered evidence may pass.
example = next(s for s in review_samples if s['scenario'] == 'architecture-review' and s['label'] == 'candidate')
directory = review / f"architecture-review-{example['repetition']}-candidate"
corrupt = copy.deepcopy(example['result']); corrupt['requestBytes'] += 1
rejected_count_tamper = rejected_receipt_tamper = False
try: view_check(directory, corrupt, full_inputs)
except AssertionError: rejected_count_tamper = True
wrong_input = list(full_inputs); wrong_input[0] += 'corrupted evidence'
try: view_check(directory, example['result'], wrong_input)
except AssertionError: rejected_receipt_tamper = True
assert rejected_count_tamper and rejected_receipt_tamper

out = {'status':'PASS', 'requestBytes':{'baseline':b,'candidate':c},
    'byteReductionPercent':100*(b-c)/b,'executorAccepted':executor_accepted,
    'HumanEvalReplaysChecked':len(human),'tamperControls':{'alteredByteCountRejected':rejected_count_tamper,'alteredReceiptRejected':rejected_receipt_tamper},
    'limits':'Validates persisted component experiments, not live model or complete CLI performance.'}
(HERE / 'independent-recomputation.json').write_text(json.dumps(out,indent=2) + '\n')
print(json.dumps(out,indent=2))
