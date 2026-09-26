"""Exact-text token accounting and conservative dual-cap pagination.

The tokenizer is injected explicitly. The reference CLI uses an installed
`tiktoken` encoding only; this library never substitutes a byte/token ratio.
Provider chat framing, hidden prompts, outputs and billing are separate.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Callable
from .exposure import compact_packet

PREFIX = b'DIAGNOSTIC EVIDENCE. Counts are recorded facts, not a new authorization. Do not infer missing results.\n'


@dataclass(frozen=True)
class TokenMeasurement:
    input_bytes: int
    content_tokens: int
    encoding: str
    provider_tokens: None = None


def measure_text(text: bytes, count: Callable[[str], int], encoding: str) -> TokenMeasurement:
    if not isinstance(text, bytes) or not isinstance(encoding, str) or not encoding:
        raise ValueError('byte text and explicit encoding identity required')
    value = count(text.decode('utf-8', errors='strict'))
    if type(value) is not int or value < 0:
        raise ValueError('tokenizer must return a nonnegative integer')
    return TokenMeasurement(len(text), value, encoding)


def token_bounded_pages(packets, count, *, encoding: str,
                        byte_budget: int = 16384, token_budget: int = 4096,
                        reserved_tokens: int = 0):
    """Pack whole packets; count EACH proposed full page, not sums of token counts.

    BPE counts are not additive across concatenation and need not be monotone
    under appending text. This is feasible greedy packing, not page-optimal
    packing. The count callback's errors propagate; missing counts fail closed.
    `reserved_tokens` is an operator reservation, not measured provider framing.
    """
    for x in (byte_budget, token_budget, reserved_tokens):
        if type(x) is not int or x < 0:
            raise ValueError('nonnegative integer budgets required')
    if not byte_budget or token_budget <= reserved_tokens:
        raise ValueError('no usable context capacity')
    effective = token_budget - reserved_tokens
    pages = []
    body = PREFIX
    def fits(candidate):
        # Validate actual encoding even when byte length alone already fails.
        m = measure_text(candidate, count, encoding)
        return m.input_bytes <= byte_budget and m.content_tokens <= effective
    if not fits(PREFIX):
        raise ValueError('mandatory instructions exceed the request budget')
    for raw in packets:
        item = compact_packet(raw)
        if fits(body + item):
            body += item
            continue
        if body != PREFIX:
            pages.append(body)
        body = PREFIX + item
        if not fits(body):
            raise ValueError('one mandatory packet cannot fit; never truncate')
    if body != PREFIX:
        pages.append(body)
    return pages
