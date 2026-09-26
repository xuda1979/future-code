"""Deterministic context admission. Exact measured bytes, never invented tokens.

Hard task contracts are not silently summarized. Optional observations and task
cards are budgeted, with omission counts and stable retrieval tools. A mailbox
cursor only advances for messages actually included in a successful request.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any

from .contracts import Config, ContractError, TaskSpec
from .store import encode
from .coordination import clip_utf8


@dataclass
class ContextPacket:
    messages: list[dict]
    audit: dict
    delivered_through: int = 0


def request_size(messages: list[dict]) -> dict[str, int]:
    text = json.dumps(messages, ensure_ascii=False, allow_nan=False)
    return {'chars': len(text), 'utf8_bytes': len(text.encode('utf-8'))}


def fits(messages: list[dict], config: Config) -> bool:
    size = request_size(messages)
    return size['chars'] <= config.max_context_chars and size['utf8_bytes'] <= config.max_context_bytes


def enforce_bounds(messages: list[dict], config: Config) -> None:
    if (fits(messages, config)):
        raise ContractError('Mandatory task/review context exceeds limit; split the task or reduce its instructions')


def build_context(task: TaskSpec, config: Config, system: str, history: list[dict],
                  dependencies: list[dict], messages: list[dict], *, profile_rules: str = '',
                  coordination: dict | None = None, memory: dict | None = None) -> ContextPacket:
    spec = task.to_dict()
    # Full dependencies live in the database and are selectively unfoldable.
    # No acceptance criterion, write scope or approval gate is removed.
    spec['dependencies'] = sorted(task.dependencies)[:config.context_items]
    packet: dict[str, Any] = {
        'task': spec, 'profile_rules': profile_rules,
        'available_gate_ids': sorted(set(task.gates) | set(config.required_gates[task.profile])),
        'dependency_index': {'total': len(task.dependencies), 'shown_ids': len(spec['dependencies']),
                             'retrieve_more': {'action': 'inspect', 'relation': 'dependencies'}},
        'dependencies': [], 'messages': [],
        'context_policy': {'max_context_chars': config.max_context_chars,
                           'max_context_bytes': config.max_context_bytes,
                           'max_output_tokens': config.max_output_tokens,
                           'token_count': 'UNKNOWN; byte measurements are not tokenizer counts'},
        'omitted': {'dependency_cards': len(task.dependencies), 'messages': len(messages), 'observations': len(history)},
    }
    if coordination:
        packet['coordination'] = coordination
    if memory and memory.get('note'):
        packet['working_note'] = {'revision': memory['revision'], 'note_unverified': memory['note']}
    def render() -> list[dict]:
        return [{'role': 'system', 'content': system}, {'role': 'user', 'content': encode(packet)}]

    enforce_bounds(render(), config)
    # Latest feedback is shown even when the complete observation is enormous.
    # It is labeled as an excerpt rather than silently dropped or presented whole.
    kept_history: list[dict] = []
    if history:
        raw = encode(history[-1])
        for cap in (min(7000, config.max_context_bytes // 2), 1800, 600):
            latest = history[-1] if len(raw.encode()) <= cap else {
                'excerpt_untrusted': clip_utf8(raw, cap), 'truncated': True,
                'next': 'Use fewer read lines or a smaller board/result page; full tool results are retained in attempt artifacts'}
            packet['recent_observations'] = [latest]
            packet['omitted']['observations'] = len(history) - 1
            if fits(render(), config):
                kept_history = [latest]
                break
        if not kept_history:
            del packet['recent_observations']
            packet['omitted']['observations'] = len(history)

    delivered = 0
    # Oldest undelivered first. Break at the first non-fitting message so an
    # acknowledgement cannot skip it; a later request or inbox action can retry.
    for message in messages[:config.context_items]:
        item = {k: message[k] for k in ('seq', 'sender', 'content') if k in message}
        packet['messages'].append(item)
        packet['omitted']['messages'] -= 1
        if not fits(render(), config):
            packet['messages'].pop()
            packet['omitted']['messages'] += 1
            break
        delivered = int(item.get('seq', delivered))
    for dep in dependencies[:config.context_items]:
        packet['dependencies'].append(dep)
        packet['omitted']['dependency_cards'] -= 1
        if not fits(render(), config):
            packet['dependencies'].pop()
            packet['omitted']['dependency_cards'] += 1
            break
    # Preserve recency and chronology; no LLM-generated summaries of summaries.
    if kept_history:
        for obs in reversed(history[:-1][-7:]):
            if len(encode(obs).encode()) > 2500:
                continue
            packet['recent_observations'] = [obs] + kept_history
            packet['omitted']['observations'] -= 1
            if fits(render(), config):
                kept_history = [obs] + kept_history
            else:
                packet['recent_observations'] = kept_history
                packet['omitted']['observations'] += 1
                break
    result = render()
    enforce_bounds(result, config)
    return ContextPacket(result, {**request_size(result), 'omitted': dict(packet['omitted']),
                                 'dependency_total': len(task.dependencies),
                                 'included_dependency_cards': len(packet['dependencies']),
                                 'included_messages': len(packet['messages']),
                                 'included_observations': len(kept_history)}, delivered)
