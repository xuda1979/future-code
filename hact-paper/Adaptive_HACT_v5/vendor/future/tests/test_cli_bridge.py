import argparse
import io
import json
import sys
import pytest
from future_code.cli_bridge import main, prompt_from_messages, translate
from future_code.contracts import ContractError

FINISH = {"action": "finish", "summary": "CLI fixture only", "uncertainties": ["Real installed binary untested"]}


@pytest.mark.parametrize("mode", ["stdin", "argument"])
async def test_real_cli_subprocess_bridge(mode, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    code = "import sys,json; prompt=" + ("sys.stdin.read()" if mode == "stdin" else "sys.argv[-1]") + "; assert '[system]' in prompt; assert '[user]' in prompt; print(json.dumps({'result':" + repr(json.dumps(FINISH)) + "}))"
    args = argparse.Namespace(argv=["--", sys.executable, "-c", code], prompt_mode=mode, timeout=3, forward_env=[])
    result = await translate(args, [{"role": "system", "content": "Return one JSON action"}, {"role": "user", "content": "Do it"}])
    assert json.loads(result) == FINISH


@pytest.mark.parametrize("bad", [None, {}, [], [{"role": "tool", "content": "bad"}], [{"role": "user", "content": 2}], [{"role": "user", "content": "x", "extra": 1}]])
def test_invalid_bridge_protocol(bad):
    with pytest.raises(ContractError):
        prompt_from_messages(bad)


def test_bridge_entrypoint(monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps([{"role": "user", "content": "x"}])))
    assert main(["--", sys.executable, "-c", "import sys,json; sys.stdin.read(); print(" + repr(json.dumps(FINISH)) + ")"]) == 0
    assert json.loads(capsys.readouterr().out) == FINISH
    monkeypatch.setattr(sys, "stdin", io.StringIO("invalid"))
    assert main(["--", "unused-cli"]) == 2
    assert json.loads(capsys.readouterr().err)["state"] == "ERROR"


@pytest.mark.parametrize("code", ["raise SystemExit(1)", "print('not json')", "print('{}')", "import time; time.sleep(3)"])
async def test_cli_failure_cannot_claim_success(code):
    args = argparse.Namespace(argv=[sys.executable, "-c", code], prompt_mode="stdin", timeout=0.1, forward_env=[])
    with pytest.raises(ContractError):
        await translate(args, [{"role": "user", "content": "test"}])
