"""Bounded subprocess execution: no shell, bounded output and process-group shutdown."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import os
from pathlib import Path
import signal
import time

from .contracts import ContractError
from .security import child_environment


@dataclass
class ProcessResult:
    returncode: int
    stdout: str
    stderr: str
    duration_seconds: float
    timed_out: bool = False
    output_truncated: bool = False


async def _stop(proc: asyncio.subprocess.Process) -> None:
    # Kill the POSIX process group even if the leader already exited: a child can hold a pipe open.
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGTERM)
        elif proc.returncode is None:
            proc.terminate()
    except ProcessLookupError:
        pass
    try:
        await asyncio.wait_for(proc.wait(), timeout=1)
    except asyncio.TimeoutError:
        pass
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        elif proc.returncode is None:
            proc.kill()
    except ProcessLookupError:
        pass
    await proc.wait()


async def run_process(argv: list[str], cwd: Path, *, timeout: float, input_text: str | None = None,
                      allow_env: list[str] | None = None, max_output: int = 100000) -> ProcessResult:
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and "\x00" not in a for a in argv):
        raise ContractError("argv must be a nonempty list of strings")
    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        *argv, cwd=cwd, env=child_environment(cwd, allow_env),
        stdin=asyncio.subprocess.PIPE if input_text is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        start_new_session=(os.name == "posix"))
    buffers = [bytearray(), bytearray()]
    truncated = False

    async def drain(stream: asyncio.StreamReader, buffer: bytearray) -> None:
        nonlocal truncated
        while chunk := await stream.read(16384):
            remaining = max(0, max_output - len(buffer))
            buffer.extend(chunk[:remaining])
            if len(chunk) > remaining:
                truncated = True

    async def write_input() -> None:
        if input_text is not None and proc.stdin is not None:
            try:
                proc.stdin.write(input_text.encode("utf-8"))
                await proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                proc.stdin.close()

    readers = [asyncio.create_task(drain(proc.stdout, buffers[0])),
               asyncio.create_task(drain(proc.stderr, buffers[1])), asyncio.create_task(write_input())]
    timed_out = False
    try:
        async with asyncio.timeout(timeout):
            await proc.wait()
            await asyncio.gather(*readers)
    except TimeoutError:
        timed_out = True
        await _stop(proc)
    except BaseException:
        await _stop(proc)
        raise
    finally:
        for reader in readers:
            if not reader.done():
                reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)
    return ProcessResult(proc.returncode if proc.returncode is not None else -1,
                         buffers[0].decode("utf-8", errors="replace"), buffers[1].decode("utf-8", errors="replace"),
                         time.monotonic() - started, timed_out, truncated)
