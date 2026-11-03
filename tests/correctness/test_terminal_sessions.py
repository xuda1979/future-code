"""Real tmux/PTY integration tests. No LLM credentials or network required."""
import importlib.util
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import termios
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ROOT / 'future-code.sh'
SESSIONS = ROOT / 'src' / 'terminal' / 'sessions.py'


def terminal_unavailable():
    if os.name != 'posix' or not shutil.which('tmux'):
        return 'requires tmux on POSIX'
    try:
        with socket.socket(socket.AF_UNIX):
            return ''
    except OSError as error:
        return f'runner blocks Unix sockets required by tmux: {error}'


UNAVAILABLE = terminal_unavailable()
if UNAVAILABLE and os.environ.get('FUTURE_CODE_REQUIRE_TERMINAL_TESTS') == '1':
    raise RuntimeError(UNAVAILABLE)


@unittest.skipIf(UNAVAILABLE, UNAVAILABLE)
class TerminalSessions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='future-terminal-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.env = {**os.environ, 'FUTURE_CODE_SESSION_DIR': str(self.path / 'sessions'),
                    'TERM': 'xterm-256color'}
        self.env.pop('TMUX', None)
        self.env.pop('STY', None)
        self.env.pop('FUTURE_CODE_SESSION_CHILD', None)
        self.env.pop('FUTURE_CODE_PERSIST', None)
        self.env.pop('FUTURE_CODE_CONFIG_FILE', None)
        self.env.pop('FUTURE_CODE_BIN', None)
        self.addCleanup(self.stop_all)

    def call(self, *args, check=True):
        result = subprocess.run(['bash', str(LAUNCHER), *args], env=self.env,
                                text=True, capture_output=True, timeout=15)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def stop_all(self):
        for path in (self.path / 'sessions').glob('*'):
            subprocess.run(['tmux', '-L', f'future-code-{os.getuid()}-{path.name}', 'kill-server'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)

    def wait_for(self, predicate, message='condition not reached'):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.03)
        self.fail(message)

    def status(self, session_id):
        return json.loads(self.call('--session-status', session_id).stdout)

    def test_detached_exit_receipt_argv_and_environment_are_preserved_without_replay(self):
        record = self.path / 'record.json'
        self.env['TERMINAL_FIXTURE_SECRET'] = 'private-runtime-token'
        special = 'spaces; $(touch NEVER_CREATE_THIS) `echo no` \' " 日本語'
        code = ("import json,os,sys\nfrom pathlib import Path\n"
                f"p=Path({str(record)!r})\n"
                "p.write_text(json.dumps([sys.argv[1:],os.environ['TERMINAL_FIXTURE_SECRET']]))\n"
                "print('offline output', flush=True)\nsys.exit(37)\n")
        result = self.call('--detach', '--', sys.executable, '-c', code, special)
        session_id = result.stdout.strip()
        self.assertRegex(session_id, r'^[0-9a-f]{16}$')
        final = self.wait_for(lambda: (state if (state := self.status(session_id))['state'] == 'EXITED' else None))
        self.assertEqual(final['exitCode'], 37)
        self.assertEqual(json.loads(record.read_text()), [[special], 'private-runtime-token'])
        self.wait_for(lambda: 'offline output' in self.call('--session-log', session_id).stdout)
        self.assertFalse((self.path / 'sessions' / session_id / 'launch.json').exists())
        self.assertNotIn('private-runtime-token', json.dumps(final))
        self.assertFalse((ROOT / 'NEVER_CREATE_THIS').exists())
        self.assertEqual(self.call('--attach', session_id, check=False).returncode, 37)
        self.assertEqual(json.loads(record.read_text()), [[special], 'private-runtime-token'])
        self.assertIn(session_id, self.call('--sessions').stdout)

    def pty_start(self, *args):
        master, slave = pty.openpty()
        def own_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        proc = subprocess.Popen(['bash', str(LAUNCHER), *args], env=self.env,
                                stdin=slave, stdout=slave, stderr=slave, preexec_fn=own_terminal)
        os.close(slave)
        self.addCleanup(self.close_client, proc, master)
        return proc, master

    @staticmethod
    def close_client(proc, master):
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)
        try:
            os.close(master)
        except OSError:
            pass

    def read_until(self, master, pattern):
        output = b''
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try:
                    output += os.read(master, 65536)
                except OSError:
                    break
                match = re.search(pattern, output)
                if match:
                    return match
        self.fail(f'PTY output missing {pattern!r}: {output[-3000:]!r}')

    def test_browser_terminal_disconnect_survives_and_reattaches_same_process(self):
        record = self.path / 'pid'
        config = self.path / 'model.env'
        # Use the real OpenAI proxy and a fixture binary. No upstream API call.
        config.write_text('FUTURE_CODE_API_KEY=offline\nFUTURE_CODE_MODEL=offline\n'
                          'FUTURE_CODE_BASE_URL=http://127.0.0.1:1\n')
        binary = self.path / 'fixture-binary'
        binary.write_text(f'#!{sys.executable}\nimport os,time\nfrom pathlib import Path\n'
                          f'Path({str(record)!r}).write_text(str(os.getpid()))\n'
                          "print('READY-FOR-DISCONNECT',flush=True)\n"
                          'while True: time.sleep(.05)\n')
        binary.chmod(0o700)
        self.env.update(FUTURE_CODE_CONFIG_FILE=str(config), FUTURE_CODE_BIN=str(binary),
                        TMPDIR=str(self.path))
        proc, master = self.pty_start()  # Automatic protection, no SSH_* needed.
        self.read_until(master, b'READY-FOR-DISCONNECT')
        session_id = next((self.path / 'sessions').iterdir()).name
        pid = int(record.read_text())
        proc.send_signal(signal.SIGHUP)  # Simulate losing the browser/SSH client.
        proc.wait(timeout=5)
        os.close(master)
        time.sleep(.15)
        os.kill(pid, 0)
        self.assertEqual(self.status(session_id)['state'], 'RUNNING')
        log = self.call('--session-log', session_id).stdout
        endpoint = re.search(r'proxy ready on (http://127\.0\.0\.1:\d+)', log)
        self.assertIsNotNone(endpoint, log)
        import urllib.request
        with urllib.request.urlopen(endpoint.group(1) + '/health', timeout=2) as response:
            self.assertEqual(response.status, 200)
        other, other_master = self.pty_start('--attach', session_id)
        self.read_until(other_master, b'READY-FOR-DISCONNECT')
        self.assertEqual(int(record.read_text()), pid, 'attach must not execute a second invocation')
        self.call('--stop-session', session_id)
        other.wait(timeout=5)
        self.assertEqual(self.status(session_id)['state'], 'STOPPED')
        self.wait_for(lambda: not Path(f'/proc/{pid}').exists(), 'application survived explicit stop')
        import urllib.error
        def proxy_stopped():
            try:
                urllib.request.urlopen(endpoint.group(1) + '/health', timeout=.2).close()
                return False
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                return True
        self.wait_for(proxy_stopped, 'proxy survived explicit stop')

    def test_lost_server_is_unknown_and_status_never_restarts_command(self):
        result = self.call('--detach', '--', sys.executable, '-c', 'import time; time.sleep(60)')
        session_id = result.stdout.strip()
        self.wait_for(lambda: self.status(session_id)['state'] == 'RUNNING')
        subprocess.run(['tmux', '-L', f'future-code-{os.getuid()}-{session_id}', 'kill-server'], check=True)
        state = self.status(session_id)
        self.assertEqual(state['state'], 'UNKNOWN')
        self.assertIsNone(state['exitCode'])
        self.assertEqual(self.call('--attach', session_id, check=False).returncode, 1)

    def test_invalid_ids_are_rejected_and_registry_files_are_private(self):
        result = self.call('--session-status', '../../outside', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('invalid session ID', result.stderr)
        session_id = self.call('--detach', '--', sys.executable, '-c', 'pass').stdout.strip()
        self.wait_for(lambda: self.status(session_id)['state'] == 'EXITED')
        for path in [self.path / 'sessions', self.path / 'sessions' / session_id,
                     self.path / 'sessions' / session_id / 'status.json']:
            self.assertEqual(path.stat().st_mode & 0o077, 0, str(path))

    def test_missing_command_and_unsafe_registry_fail_without_execution(self):
        self.assertIn('missing command', self.call('--detach', '--', check=False).stderr)
        base = self.path / 'sessions'
        base.mkdir(mode=0o755)
        self.assertIn('mode 700', self.call('--detach', '--', sys.executable, '-c', 'pass', check=False).stderr)


class TerminalLogBounds(unittest.TestCase):
    def test_log_rotation_bounds_disk_without_dropping_latest_output(self):
        spec = importlib.util.spec_from_file_location('terminal_sessions', SESSIONS)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            source = path / 'input'
            source.write_bytes(b'a' * (module.LOG_LIMIT * 3) + b'LATEST-OUTPUT')
            with source.open('rb') as stream:
                subprocess.run([sys.executable, str(SESSIONS), '_log', str(path)],
                               stdin=stream, check=True, timeout=10)
            self.assertLessEqual((path / 'output.log').stat().st_size, module.LOG_LIMIT)
            self.assertLessEqual((path / 'output.previous.log').stat().st_size, module.LOG_LIMIT)
            self.assertTrue((path / 'output.log').read_bytes().endswith(b'LATEST-OUTPUT'))


if __name__ == '__main__':
    unittest.main()
