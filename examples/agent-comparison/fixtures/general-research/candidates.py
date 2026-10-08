"""Blinded research-evaluation candidate selection. Intentionally defective source."""


def select_candidates(task_ids, proposals, references):
    selected = proposals or references
    return {task_id: selected[task_id] for task_id in task_ids}
