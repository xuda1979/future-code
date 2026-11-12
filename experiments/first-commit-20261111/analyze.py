"""Recompute descriptive results from persisted arm records; no model claims."""
from pathlib import Path
import json
import statistics

ROOT = Path(__file__).resolve().parent
samples = json.loads((ROOT / 'results/samples.json').read_text())
review = json.loads((ROOT / 'review-results-v2/samples.json').read_text())

def median(values):
    return statistics.median(values)

def group(mode, scenario, label):
    return [s for s in samples if (s['mode'], s['scenario'], s['label']) == (mode, scenario, label)]

contexts = {}
for scenario in ['small', 'architecture-review']:
    contexts[scenario] = {}
    for label in ['baseline', 'candidate']:
        rows = [s for s in review if s['scenario'] == scenario and s['label'] == label]
        assert len(rows) == 4 and all(s['exitCode'] == 0 for s in rows)
        assert all(s['result']['fullReadbackIdentical'] and s['result']['originalsUnchanged'] and s['result']['replayIdentical'] for s in rows)
        contexts[scenario][label] = {'repetitions': len(rows),
            'requestBytes': median(s['result']['requestBytes'] for s in rows),
            'localProcessingMedianMs': median(s['result']['elapsedMs'] for s in rows),
            'freshBatchOffloads': rows[0]['result']['replacedCount']}
    b, c = (contexts[scenario][a]['requestBytes'] for a in ['baseline', 'candidate'])
    contexts[scenario]['requestByteReductionPercent'] = 100 * (b-c) / b

executors = {}
for scenario in sorted({s['scenario'] for s in samples if s['mode'] == 'executor'}):
    executors[scenario] = {}
    for label in ['baseline', 'candidate']:
        rows = group('executor', scenario, label)
        executors[scenario][label] = {'repetitions': len(rows),
            'accepted': sum(bool(s['result'] and s['result']['accepted']) for s in rows),
            'successfulExits': sum(s['exitCode'] == 0 for s in rows),
            'safeFollowupCompleted': sum(bool(s['result'] and s['result']['followupCompleted']) for s in rows),
            'exactOnceArtifact': sum(bool(s['result'] and s['result']['exactOnceArtifact']) for s in rows),
            'medianCompleteProcessMs': median(s['processWallMs'] for s in rows)}

public = {}
for scenario in ['healthy', 'stream-throw-after-result']:
    public[scenario] = {}
    for label in ['baseline', 'candidate']:
        rows = group('humaneval', scenario, label)
        public[scenario][label] = {'repetitions': len(rows),
            'officialTestPassExecutionsPerRepetition': [s['eventCounts']['testPasses'] for s in rows],
            'pairedResultsPerRepetition': [s['eventCounts']['pairedResults'] for s in rows],
            'successfulExits': sum(s['exitCode'] == 0 for s in rows),
            'explicitErrorResultsPerCompletedRepetition': [s['result']['explicitErrors'] for s in rows if s['result']],
            'medianFullReplayMs': median(s['result']['elapsedMs'] for s in rows) if all(s['result'] for s in rows) else None}

summary = {'status': 'SCOPED_RUNTIME_IMPROVEMENTS_DEMONSTRATED',
    'wholeAgentProductivity': 'UNKNOWN', 'baseline': 'b1f9d186085562947adf682f4c7f65652886ecad',
    'candidate': 'ac3789210d0d58d30f1f9b141ca6d842297f7f94',
    'formalArms': len(samples) + len(review), 'supersededPilotArms': 17,
    'liveModelCalls': 0, 'billingTokens': None, 'dollars': None, 'generationPassAt1': None,
    'context': contexts, 'executor': executors, 'HumanEvalCanonicalReplay': public,
    'methodCaveats': [
        'Production components loaded from unchanged pinned sources through identical peripheral adapters; full terminal CLI not executed.',
        'Actual Bash per-tool30000 character persistence applied to BOTH context arms before batch enforcement.',
        'Known-correct HumanEval canonical solutions supplied. Official tests measure execution/recovery only; no generation score.',
        'Five intentionally selected fault mechanisms, each repeated four times; repetitions are not independent natural tasks.',
        'Original Node test command outputs use Node24 default spec reporter, although the initial protocol called these TAP; raw output is retained unchanged.',
        'The32K target is aggregate eligible tool-result characters, not a hard cap on serialized JSON bytes.',
        'First-commit optional aggregate persistence already exists. This context gain is due to enabled defaults and a smaller target.',
        'No universal wall-time, token-cost, research-quality, or Claude comparison follows from these measurements.']}
(ROOT / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'formalArms': summary['formalArms'], 'contextReductionPercent': contexts['architecture-review']['requestByteReductionPercent'],
    'wholeAgentProductivity': summary['wholeAgentProductivity']}, indent=2))
