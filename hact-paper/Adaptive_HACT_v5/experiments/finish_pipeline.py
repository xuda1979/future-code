"""Serialize measurement phases to avoid competing experiment processes."""
import os,sys,time,subprocess
from experiments.runner import ROOT

def run(module,log):
    with (ROOT/'results'/log).open('w') as out:
        r=subprocess.run([sys.executable,'-m',module],cwd=ROOT,stdout=out,stderr=subprocess.STDOUT,env=dict(os.environ,PYTHONPATH=str(ROOT)))
    if r.returncode:raise RuntimeError(module+' failed; see '+log)

def main():
    deadline=time.monotonic()+1200
    while not (ROOT/'results/timing_summary_raw.json').exists():
        if time.monotonic()>deadline:raise TimeoutError('pilot timing failed to finish')
        time.sleep(3)
    with (ROOT/'results/confirmation_console.log').open('w') as out:
        r=subprocess.run([sys.executable,'-m','experiments.confirmation','run'],cwd=ROOT,stdout=out,stderr=subprocess.STDOUT)
    if r.returncode:raise RuntimeError('confirmation oracle failed')
    run('experiments.evaluate_frozen','frozen_evaluation_console.log')
    run('experiments.confirmation_timing','confirmation_timing_console.log')
    print('Measurement pipeline complete',flush=True)
if __name__=='__main__':main()
