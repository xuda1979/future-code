#!/usr/bin/env python3
"""Terminal lifecycle only. tmux owns the PTY; Foundry owns task acceptance.

One private tmux server per invocation preserves the invoking environment without
copying credentials into command lines or serializing environment variables.
Attach/status never restart a command or infer objective completion from exit 0.
"""
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import uuid

SELF = str(Path(__file__).resolve())
SESSION_NAME = 'future-code'
TERMINAL = {'EXITED', 'FAILED', 'STOPPED', 'UNKNOWN'}
LOG_LIMIT = 4 * 1024 * 1024


def root():
    path = Path(os.environ.get('FUTURE_CODE_SESSION_DIR',
                               str(Path.home() / '.future-code' / 'terminal'))).absolute()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise ValueError(f'session directory must be owned by this user with mode 700: {path}')
    return path


def session_path(session_id):
    if not re.fullmatch(r'[0-9a-f]{16}', session_id):
        raise ValueError('invalid session ID; use --sessions to list IDs')
    path = root() / session_id
    if not path.is_dir() or path.is_symlink():
        raise ValueError(f'unknown session: {session_id}')
    return path


def write_json(path, data):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(data, stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def tmux(path, *args, check=True):
    result = subprocess.run(['tmux', '-L', f'future-code-{os.getuid()}-{path.name}',
                             '-f', '/dev/null', *args],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
    if check and result.returncode:
        raise ValueError(f'tmux: {result.stderr.strip() or "command failed"}')
    return result


def status(path):
    data = json.loads((path / 'status.json').read_text())
    if data['state'] not in TERMINAL:
        live = tmux(path, 'has-session', '-t', SESSION_NAME, check=False)
        if live.returncode:
            # The child may have committed its exit receipt while has-session
            # was in flight. Prefer that receipt over a stale RUNNING snapshot.
            data = json.loads((path / 'status.json').read_text())
            if data['state'] in TERMINAL:
                return data
            # A lost PTY/server cannot tell us whether detached external effects
            # completed. Leave reconciliation to the existing durable runtime.
            data = {**data, 'state': 'UNKNOWN', 'exitCode': None,
                    'error': 'terminal server unavailable; inspect saved task state before resuming'}
    return data


def log_writer(path):
    log = path / 'output.log'
    stream = log.open('ab', buffering=0)
    try:
        while True:
            chunk = os.read(0, 65536)
            if not chunk:
                return
            if stream.tell() + len(chunk) > LOG_LIMIT:
                stream.close()
                log.replace(path / 'output.previous.log')
                stream = log.open('ab', buffering=0)
            stream.write(chunk)
    finally:
        stream.close()


def worker(path):
    request = path / 'launch.json'
    try:
        argv = json.loads(request.read_text())
        request.unlink()
        # Start logging before the application produces its first output.
        tmux(path, 'set-option', '-s', 'exit-unattached', 'off')
        tmux(path, 'set-option', '-t', SESSION_NAME, 'destroy-unattached', 'off')
        tmux(path, 'pipe-pane', '-o', '-t', SESSION_NAME,
             'exec ' + shlex.join([sys.executable, SELF, '_log', str(path)]))
        # The monitor must survive terminal Ctrl-C while the child handles it.
        signal.signal(signal.SIGINT, lambda *_: None)
        env = {**os.environ, 'FUTURE_CODE_SESSION_CHILD': '1',
               'FUTURE_CODE_TERMINAL_SESSION': path.name}
        proc = subprocess.Popen(argv, env=env)
        signal.signal(signal.SIGTERM, lambda *_: proc.send_signal(signal.SIGTERM))
        data = json.loads((path / 'status.json').read_text())
        write_json(path / 'status.json', {**data, 'state': 'RUNNING'})
        code = proc.wait()
        code = code if code >= 0 else 128 - code
        write_json(path / 'status.json', {**data, 'state': 'EXITED',
                   'exitCode': code, 'finishedAt': time.time()})
        return code
    except Exception as error:
        data = json.loads((path / 'status.json').read_text())
        write_json(path / 'status.json', {**data, 'state': 'FAILED',
                   'error': str(error), 'exitCode': 1, 'finishedAt': time.time()})
        print(f'future-code: session failed: {error}', file=sys.stderr)
        return 1
    finally:
        request.unlink(missing_ok=True)


def attach(path):
    data = status(path)
    if data['state'] in TERMINAL:
        print(json.dumps(data, indent=2))
        return data.get('exitCode') if data.get('exitCode') is not None else 1
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise ValueError('--attach requires an interactive terminal; use --session-log for output')
    # Only this client belongs to the SSH/browser terminal. Losing it leaves the
    # server, application and provider proxy alive in their independent session.
    result = subprocess.run(['tmux', '-L', f'future-code-{os.getuid()}-{path.name}',
                             'attach-session', '-t', SESSION_NAME])
    data = status(path)
    return data['exitCode'] if data.get('exitCode') is not None else result.returncode


def main(args):
    os.umask(0o077)
    if args and args[0] in ('_worker', '_log'):
        return worker(Path(args[1])) if args[0] == '_worker' else log_writer(Path(args[1]))
    if not shutil.which('tmux'):
        raise ValueError('persistent sessions require tmux; install tmux or use --foreground explicitly')
    launcher, args = args[0], args[1:]
    if not args:
        raise ValueError('missing session command')
    command, rest = args[0], args[1:]
    if command == '--sessions':
        if rest:
            raise ValueError('--sessions takes no arguments')
        for path in sorted(root().iterdir()):
            if re.fullmatch(r'[0-9a-f]{16}', path.name) and not path.is_symlink() and (path / 'status.json').exists():
                print(json.dumps(status(path)))
        return 0
    if command in ('--attach', '--session-status', '--session-log', '--stop-session'):
        if len(rest) != 1:
            raise ValueError(f'{command} requires exactly one session ID')
        path = session_path(rest[0])
        if command == '--attach':
            return attach(path)
        if command == '--session-status':
            print(json.dumps(status(path), indent=2))
        elif command == '--session-log':
            for name in ('output.previous.log', 'output.log'):
                if (path / name).exists():
                    sys.stdout.buffer.write((path / name).read_bytes())
        else:
            data = status(path)
            if data['state'] in TERMINAL:
                raise ValueError(f'session is already {data["state"]}; no process was signalled')
            tmux(path, 'kill-session', '-t', SESSION_NAME)
            write_json(path / 'status.json', {**data, 'state': 'STOPPED',
                       'exitCode': None, 'finishedAt': time.time()})
        return 0
    if command not in ('--persist', '--detach'):
        raise ValueError(f'unknown session command: {command}')
    if command == '--persist' and not (sys.stdin.isatty() and sys.stdout.isatty()):
        raise ValueError('--persist requires a terminal; use --detach for headless work')
    # Explicit `-- COMMAND ...` also protects a Foundry/Swarm supervisor or any
    # other command without interpreting its arguments through another shell.
    argv = rest[1:] if rest[:1] == ['--'] else ['bash', launcher, *rest]
    if not argv:
        raise ValueError('missing command after --')
    path = root() / uuid.uuid4().hex[:16]
    path.mkdir(mode=0o700)
    write_json(path / 'status.json', {'id': path.name, 'state': 'STARTING',
               'cwd': os.getcwd(), 'createdAt': time.time(), 'exitCode': None})
    write_json(path / 'launch.json', argv)
    size = shutil.get_terminal_size((120, 40))
    try:
        tmux(path, 'new-session', '-d', '-s', SESSION_NAME, '-c', os.getcwd(),
             '-x', str(size.columns), '-y', str(size.lines), '--',
             sys.executable, SELF, '_worker', str(path))
    except Exception as error:
        uncertain = isinstance(error, subprocess.TimeoutExpired)
        if not uncertain:
            (path / 'launch.json').unlink(missing_ok=True)
        data = json.loads((path / 'status.json').read_text())
        if data['state'] == 'STARTING':
            write_json(path / 'status.json', {**data,
                       'state': 'UNKNOWN' if uncertain else 'FAILED',
                       'error': str(error), 'exitCode': None})
        raise
    print(f'future-code: persistent session {path.name}; reconnect with future-code --attach {path.name}',
          file=sys.stderr, flush=True)
    if command == '--detach':
        print(path.name)
        return 0
    return attach(path)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f'future-code: {error}', file=sys.stderr)
        sys.exit(2)
