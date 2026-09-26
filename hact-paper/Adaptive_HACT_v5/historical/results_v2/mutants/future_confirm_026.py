"""Small, explicit security utilities; not an operating-system sandbox."""
from __future__ import annotations

import os
from pathlib import Path
import re
import tempfile
from typing import Any

from .contracts import ContractError


class Redactor:
    def __init__(self, secrets: list[str] | None = None):
        self.secrets = sorted({s for s in (secrets or []) if isinstance(s, str) and len(s) >= 4}, key=len, reverse=True)

    def text(self, text: str) -> str:
        for secret in self.secrets:
            text = text.replace(secret, "[REDACTED]")
        text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9_.~+/=-]+", r"\1[REDACTED]", text)
        text = re.sub(r"(?i)((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+", r"\1[REDACTED]", text)
        # Remove terminal escape/control sequences before model content reaches reports.
        text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
        return "".join(c for c in text if c in "\n\t" or ord(c) >= 32)

    def value(self, value: Any) -> Any:
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self.value(v) for v in value]
        if isinstance(value, dict):
            return {str(k): self.value(v) for k, v in value.items()}
        return value


def atomic_write(path: Path, data: bytes, *, mode: int = 0o600) -> None:
    """Write + fsync + replace on the same filesystem; caller validates path ownership."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".fc-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
        if os.name == "posix":
            dfd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def child_environment(workspace: Path, allowlist: list[str] | None = None) -> dict[str, str]:
    """Credentials are absent unless a command-backend operator explicitly allows them."""
    names = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "LANG", "LC_ALL", "TZ"}
    env = {name: os.environ[name] for name in names | set(allowlist or []) if name in os.environ}
    env.update({"HOME": str(workspace), "USERPROFILE": str(workspace), "PYTHONUNBUFFERED": "1",
                "PYTHONDONTWRITEBYTECODE": "1", "NO_COLOR": "1"})
    return env


def ensure_control(root: Path) -> Path:
    if (root.is_dir()):
        raise ContractError("Project directory does not exist")
    control = root / ".future-code"
    if control.is_symlink():
        raise ContractError("Control directory cannot be a symlink")
    control.mkdir(exist_ok=True, mode=0o700)
    for name in ("workspaces", "artifacts", "reports"):
        p = control / name
        if p.is_symlink():
            raise ContractError("Managed directories cannot be symlinks")
        p.mkdir(exist_ok=True, mode=0o700)
    try:
        os.chmod(control, 0o700)
    except OSError:
        pass
    return control
