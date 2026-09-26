"""Opt-in adapter for an installed CLI with plain-text prompt input.

Flag compatibility with any particular unavailable Future Code executable is UNKNOWN.
The operator supplies its exact argv. Run untrusted CLIs inside an OS/container sandbox.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

from .contracts import ContractError, ENV_NAME
from .process import run_process
from .security import Redactor
from .worker import parse_action


def prompt_from_messages(messages: object) -> str:
    if not isinstance(messages, list) or not messages or len(messages) > 100:
        raise ContractError("Bridge input must be a bounded, nonempty messages array")
    parts = ["Return one JSON action as instructed below; no surrounding commentary."]
    for message in messages:
        if not isinstance(message, dict) or set(message) != {"role", "content"}:
            raise ContractError("Each bridge message must contain role and content only")
        if message["role"] not in {"system", "user", "assistant"} or not isinstance(message["content"], str):
            raise ContractError("Invalid bridge message")
        parts.append(f"[{message['role']}]\n{message['content']}")
    result = "\n\n".join(parts)
    if len(result.encode()) > 200_000:
        raise ContractError("Bridge prompt exceeds byte limit")
    return result


async def translate(args: argparse.Namespace, messages: object) -> str:
    prompt = prompt_from_messages(messages)
    command = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
    if not command:
        raise ContractError("Supply the installed CLI command after --")
    if args.prompt_mode == "argument":
        command = command + [prompt]
    result = await run_process(command, Path.cwd(), timeout=args.timeout,
                               input_text=prompt if args.prompt_mode == "stdin" else None,
                               allow_env=args.forward_env, max_output=2_000_000)
    if result.returncode or result.timed_out or result.output_truncated:
        raise ContractError("Installed CLI failed, timed out or exceeded output limit; inspect its isolated environment")
    try:
        candidate = json.loads(result.stdout)
        if isinstance(candidate, dict) and "result" in candidate and "action" not in candidate:
            candidate = json.loads(candidate["result"])
        text = json.dumps(candidate)
    except (ValueError, TypeError, KeyError) as error:
        raise ContractError("Installed CLI did not return JSON or a JSON result envelope") from error
    parse_action(text)
    return text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt-mode", choices=["stdin", "argument"], default="stdin")
    parser.add_argument("--forward-env", action="append", default=[])
    parser.add_argument("--timeout", type=float, default=150)
    parser.add_argument("argv", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    redactor = Redactor([os.environ.get(key, "") for key in args.forward_env])
    try:
        if not 0.1 <= args.timeout <= 86400 or not all(ENV_NAME.fullmatch(key) for key in args.forward_env):
            raise ContractError("Invalid timeout or environment allowlist")
        raw = sys.stdin.read(200_001)
        if len(raw.encode()) > 200_000:
            raise ContractError("Bridge input exceeds byte limit")
        print(asyncio.run(translate(args, json.loads(raw))))
        return 0
    except (ContractError, ValueError, OSError) as error:
        print(json.dumps({"state": "ERROR", "detail": redactor.text(str(error))}), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
