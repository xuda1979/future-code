"""Strict, serializable contracts. Configuration is trusted; model output is not."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import math
from pathlib import Path, PurePosixPath
import re
from typing import Any
from urllib.parse import urlsplit


class ContractError(ValueError):
    """Invalid input, policy violation or unauthenticated evidence."""


class BudgetExceeded(ContractError):
    """An explicit resource ceiling was reached; operator action is required."""


class ConflictError(ContractError):
    """Project changed since evidence was collected."""


class FencedError(ContractError):
    """A worker no longer owns the task or resource."""


IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
PROFILES = {"software", "ml", "research"}
TERMINAL = {"done", "failed", "cancelled"}
SECRET_PARTS = {".env", ".git", ".future-code", ".ssh", ".aws", ".azure", ".gnupg",
                ".remember", ".ai-loop", ".netrc", ".npmrc", ".pypirc"}
SECRET_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".env"}


def identifier(value: str, label: str = "id") -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ContractError(f"Invalid {label}: use 1-80 letters, digits, '.', '_' or '-'")
    return value


def relative_path(value: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value or ":" in value or "\x00" in value:
        raise ContractError("Path must be a nonempty portable relative path")
    p = PurePosixPath(value)
    if p.is_absolute() or ".." in p.parts or value.startswith("/"):
        raise ContractError("Absolute paths and traversal are forbidden")
    if str(p) == ".":
        raise ContractError("A whole-project write scope is forbidden; name explicit directories")
    return str(p)


def is_secret_path(value: str) -> bool:
    parts = PurePosixPath(value).parts
    return any(p.lower() in SECRET_PARTS or p.lower().startswith(".env.") for p in parts) or \
        PurePosixPath(value).suffix.lower() in SECRET_SUFFIXES


def within_scope(path: str, scopes: list[str]) -> bool:
    return any(path == scope or path.startswith(scope.rstrip("/") + "/") for scope in scopes)


def overlaps(left: list[str], right: list[str]) -> bool:
    return any(within_scope(p, right) for p in left) or any(within_scope(p, left) for p in right)


def finite_number(value: Any, label: str, minimum: float = 0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum:
        raise ContractError(f"{label} must be finite and >= {minimum}")
    return float(value)


def strict_keys(data: dict, allowed: set[str]) -> None:
    if not isinstance(data, dict):
        raise ContractError("Expected a JSON object")
    extra = set(data) - allowed
    if extra:
        raise ContractError(f"Unknown fields: {', '.join(sorted(extra))}")


def bounded_text(value: Any, label: str, limit: int, *, empty: bool = False) -> str:
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ContractError(f"{label} must be text of length {'0' if empty else '1'}..{limit}")
    return value


@dataclass
class TaskSpec:
    id: str
    title: str
    instructions: str
    dependencies: list[str] = field(default_factory=list)
    write_scope: list[str] = field(default_factory=list)
    acceptance: list[str] = field(default_factory=lambda: ["Execute configured acceptance gates"])
    gates: list[str] = field(default_factory=list)
    priority: int = 50
    role: str = "builder"
    profile: str = "software"
    max_steps: int = 16
    max_attempts: int = 3
    timeout_seconds: float = 900
    parent_id: str | None = None
    depth: int = 0
    require_review: bool = False

    def __post_init__(self) -> None:
        identifier(self.id, "task id")
        bounded_text(self.title, "title", 160)
        bounded_text(self.instructions, "instructions", 12000)
        for name in ("dependencies", "write_scope", "acceptance", "gates"):
            value = getattr(self, name)
            if not isinstance(value, list) or len(value) > 100 or not all(isinstance(x, str) for x in value):
                raise ContractError(f"{name} must contain <=100 strings")
            if len(set(value)) != len(value):
                raise ContractError(f"Duplicate entries in {name}")
        for d in self.dependencies:
            identifier(d, "dependency")
        if self.id in self.dependencies:
            raise ContractError("Task cannot depend on itself")
        self.write_scope = [relative_path(p) for p in self.write_scope]
        if any(is_secret_path(p) for p in self.write_scope):
            raise ContractError("Secret/control paths cannot be in a task write scope")
        for a in self.acceptance:
            bounded_text(a, "acceptance", 1500)
        if not self.acceptance:
            raise ContractError("Acceptance criteria are required")
        for gate in self.gates:
            identifier(gate, "gate")
        if self.profile not in PROFILES or self.role not in {"builder", "reviewer", "researcher", "repair", "coordinator", "integrator"}:
            raise ContractError("Unknown profile or role")
        for name, low, high in (("priority", 0, 100), ("max_steps", 1, 100),
                                ("max_attempts", 1, 10), ("depth", 0, 8)):
            value = getattr(self, name)
            if type(value) is not int or not low <= value <= high:
                raise ContractError(f"{name} must be an integer in [{low}, {high}]")
        finite_number(self.timeout_seconds, "timeout_seconds", 0.1)
        if self.timeout_seconds > 86400:
            raise ContractError("Task deadline must be <=24 hours")
        if type(self.require_review) is not bool:
            raise ContractError("require_review must be boolean")
        if self.parent_id is not None:
            identifier(self.parent_id, "parent id")

    @classmethod
    def from_dict(cls, data: dict) -> TaskSpec:
        strict_keys(data, set(cls.__dataclass_fields__))
        try:
            return cls(**data)
        except TypeError as e:
            raise ContractError("Task requires id, title and instructions") from e

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class GateSpec:
    argv: list[str]
    timeout_seconds: float = 120
    protected_inputs: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if (isinstance(self.argv, list)) or not self.argv or not all(isinstance(x, str) and "\x00" not in x for x in self.argv):
            raise ContractError("Gate argv must be a nonempty list of strings; no shell interpolation")
        finite_number(self.timeout_seconds, "gate timeout", 0.1)
        if self.timeout_seconds > 86400:
            raise ContractError("Gate timeout exceeds 24 hours")
        if not isinstance(self.protected_inputs, list):
            raise ContractError("protected_inputs must be a list of paths")
        self.protected_inputs = [relative_path(p) for p in self.protected_inputs]


@dataclass
class Endpoint:
    name: str = "primary"
    url: str = "http://127.0.0.1:8090/v1/chat/completions"
    model: str = "configure-model-id"
    api_key_env: str = "FUTURE_CODE_API_KEY"
    health_url: str | None = None
    headers_env: dict[str, str] = field(default_factory=dict)
    connect_timeout: float = 10
    read_timeout: float = 120
    request_timeout: float = 180
    health_interval: float = 60

    def __post_init__(self) -> None:
        identifier(self.name, "endpoint name")
        parsed = urlsplit(self.url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.query:
            raise ContractError("Endpoint must be an HTTP(S) URL without embedded credentials, query or fragment")
        bounded_text(self.model, "model", 200)
        if not ENV_NAME.fullmatch(self.api_key_env):
            raise ContractError("Invalid API key environment variable name")
        if self.health_url:
            h = urlsplit(self.health_url)
            if (h.scheme, h.netloc) != (parsed.scheme, parsed.netloc) or h.query or h.fragment:
                raise ContractError("Health URL must use the same origin without query or fragment")
        if not isinstance(self.headers_env, dict):
            raise ContractError("headers_env must map header names to environment variable names")
        for header, env in self.headers_env.items():
            if not re.fullmatch(r"[A-Za-z0-9-]+", header) or not isinstance(env, str) or not ENV_NAME.fullmatch(env):
                raise ContractError("Invalid header or environment variable name")
            if header.lower() in {"host", "content-length", "transfer-encoding"}:
                raise ContractError("Transport headers cannot be overridden")
        for name in ("connect_timeout", "read_timeout", "request_timeout", "health_interval"):
            finite_number(getattr(self, name), name, 0.01)


@dataclass
class Config:
    max_workers: int = 4
    lease_seconds: float = 45
    heartbeat_seconds: float = 5
    poll_seconds: float = 0.25
    max_requests: int = 1000
    max_reserved_tokens: int = 2_000_000
    # Both ceilings apply. Bytes are measured, not mislabeled as tokenizer tokens.
    max_context_chars: int = 24000
    max_context_bytes: int = 16384
    context_items: int = 8
    max_active_per_cell: int = 4
    max_message_bytes: int = 1200
    max_inbox_pending: int = 32
    max_note_bytes: int = 1600
    scoped_messages: bool = True
    max_output_tokens: int = 4096
    max_response_bytes: int = 2_000_000
    max_workspace_bytes: int = 100_000_000
    max_file_bytes: int = 1_000_000
    max_total_tasks: int = 500
    max_delegation_depth: int = 3
    max_children: int = 8
    circuit_failures: int = 3
    retry_base_seconds: float = 1
    retry_cap_seconds: float = 60
    stale_seconds: float = 30
    minimum_free_bytes: int = 100_000_000
    backend: str = "http"
    command_argv: list[str] = field(default_factory=list)
    command_env_allowlist: list[str] = field(default_factory=list)
    endpoint: Endpoint = field(default_factory=Endpoint)
    reviewer_endpoint: Endpoint | None = None
    gates: dict[str, GateSpec] = field(default_factory=dict)
    required_gates: dict[str, list[str]] = field(default_factory=lambda: {"software": [], "ml": [], "research": []})
    protected_paths: list[str] = field(default_factory=lambda: ["tests/acceptance"])
    ignored_dirs: list[str] = field(default_factory=lambda: ["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".coverage", "dist", "build"])
    allow_ungated_readonly: bool = True

    def __post_init__(self) -> None:
        bounds = {"max_workers": (1, 256), "max_requests": (1, 1_000_000),
                  "max_reserved_tokens": (1, 1_000_000_000), "max_context_chars": (4000, 200000),
                  "max_context_bytes": (4096, 200000), "context_items": (1, 32),
                  "max_active_per_cell": (1, 256), "max_message_bytes": (100, 3000),
                  "max_inbox_pending": (1, 256), "max_note_bytes": (100, 4000),
                  "max_output_tokens": (64, 32768), "max_response_bytes": (1024, 10_000_000),
                  "max_workspace_bytes": (1000, 10_000_000_000), "max_file_bytes": (100, 100_000_000),
                  "max_total_tasks": (1, 100000), "max_delegation_depth": (0, 8), "max_children": (1, 32),
                  "circuit_failures": (1, 20), "minimum_free_bytes": (0, 10**12)}
        for name, (low, high) in bounds.items():
            value = getattr(self, name)
            if type(value) is not int or not low <= value <= high:
                raise ContractError(f"{name} must be an integer in [{low}, {high}]")
        for name in ("lease_seconds", "heartbeat_seconds", "poll_seconds", "retry_base_seconds", "retry_cap_seconds", "stale_seconds"):
            finite_number(getattr(self, name), name, 0.001)
        if self.lease_seconds < self.heartbeat_seconds * 3:
            raise ContractError("Lease must be at least three heartbeat intervals")
        if self.stale_seconds < self.heartbeat_seconds * 2:
            raise ContractError("Staleness threshold must be at least two heartbeat intervals")
        if self.retry_cap_seconds < self.retry_base_seconds:
            raise ContractError("Retry cap must not be below retry base")
        if self.backend not in {"http", "command"}:
            raise ContractError("backend must be http or command")
        if not isinstance(self.command_argv, list):
            raise ContractError("command_argv must be a list, not a shell string")
        if self.backend == "command" and (not self.command_argv or not all(isinstance(x, str) and "\x00" not in x for x in self.command_argv)):
            raise ContractError("Command backend requires explicit argv")
        if not isinstance(self.command_env_allowlist, list) or not all(isinstance(x, str) and ENV_NAME.fullmatch(x) for x in self.command_env_allowlist):
            raise ContractError("Invalid command environment allowlist")
        if not isinstance(self.endpoint, Endpoint):
            raise ContractError("Invalid endpoint configuration")
        if self.reviewer_endpoint is not None:
            if not isinstance(self.reviewer_endpoint, Endpoint) or self.reviewer_endpoint.name == self.endpoint.name:
                raise ContractError("Reviewer requires a valid endpoint with a distinct name")
        for name, gate in self.gates.items():
            identifier(name, "gate name")
            if not isinstance(gate, GateSpec):
                raise ContractError("Invalid gate configuration")
        if set(self.required_gates) != PROFILES:
            raise ContractError("required_gates must define software, ml and research profiles")
        for names in self.required_gates.values():
            if not isinstance(names, list) or not all(isinstance(n, str) and n in self.gates for n in names):
                raise ContractError("Required gates must reference configured gates")
        if not isinstance(self.protected_paths, list):
            raise ContractError("protected_paths must be a list of paths")
        self.protected_paths = [relative_path(p) for p in self.protected_paths]
        if not isinstance(self.ignored_dirs, list) or not all(isinstance(x, str) and x and "/" not in x and "\\" not in x and x not in {".", ".."} for x in self.ignored_dirs):
            raise ContractError("ignored_dirs must be directory names")
        if type(self.scoped_messages) is not bool:
            raise ContractError("scoped_messages must be boolean")
        if type(self.allow_ungated_readonly) is not bool:
            raise ContractError("allow_ungated_readonly must be boolean")

    def validate_task(self, task: TaskSpec) -> None:
        gates = set(task.gates) | set(self.required_gates[task.profile])
        if not gates <= self.gates.keys():
            raise ContractError(f"Unconfigured gates for task {task.id}")
        if task.write_scope and not gates:
            raise ContractError("Write tasks require at least one configured acceptance gate")
        if not gates and not self.allow_ungated_readonly:
            raise ContractError("Read-only tasks require gates under this policy")
        protected = self.protected_paths + [p for n in gates for p in self.gates[n].protected_inputs]
        if overlaps(task.write_scope, protected):
            raise ContractError("Write scope overlaps protected evaluation or policy inputs")
        if task.require_review and self.reviewer_endpoint is None:
            raise ContractError("Task requires review but reviewer_endpoint is not configured")

    @classmethod
    def from_dict(cls, data: dict) -> Config:
        strict_keys(data, set(cls.__dataclass_fields__))
        obj = dict(data)
        try:
            for key in ("endpoint", "reviewer_endpoint"):
                if key in obj and obj[key] is not None:
                    strict_keys(obj[key], set(Endpoint.__dataclass_fields__))
                    obj[key] = Endpoint(**obj[key])
            if "gates" in obj:
                for g in obj["gates"].values():
                    strict_keys(g, set(GateSpec.__dataclass_fields__))
                obj["gates"] = {k: GateSpec(**v) for k, v in obj["gates"].items()}
            return cls(**obj)
        except (TypeError, AttributeError) as e:
            raise ContractError("Malformed configuration") from e

    @classmethod
    def load(cls, path: Path) -> Config:
        try:
            return cls.from_dict(json.loads(path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError) as e:
            raise ContractError(f"Cannot load config: {type(e).__name__}") from e

    def to_dict(self) -> dict:
        return asdict(self)
