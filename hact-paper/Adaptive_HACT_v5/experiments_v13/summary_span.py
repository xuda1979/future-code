"""Exact finite-dimensional scoring-interface check, not a workload trial."""
from fractions import Fraction
from itertools import combinations
import json

from experiments_v11.strict_partition_witness import set_partitions
from experiments_v13.adoption_study import layouts, episode, literal_score


def rank(rows):
    matrix = [[Fraction(x) for x in row] for row in rows]
    found = 0
    for column in range(len(matrix[0])):
        pivot = next((r for r in range(found, len(matrix)) if matrix[r][column]), None)
        if pivot is None:
            continue
        matrix[found], matrix[pivot] = matrix[pivot], matrix[found]
        factor = matrix[found][column]
        matrix[found] = [x/factor for x in matrix[found]]
        for r in range(found+1, len(matrix)):
            factor = matrix[r][column]
            if factor:
                matrix[r] = [x-factor*y for x, y in zip(matrix[r], matrix[found])]
        found += 1
    return found


def check():
    base, candidate = (x.to_dict() for x in layouts())
    features, augmented, paired = [], [], []
    partitions = [p for p in set_partitions(63) if len(p) == 3]
    for partition in partitions:
        row = [1] + [int(any(block & (1 << i) and block & (1 << j) for block in partition))
                     for i, j in combinations(range(6), 2)]
        saving = literal_score(base, episode(partition)) - literal_score(candidate, episode(partition))
        features.append(row)
        augmented.append(row + [saving])
        paired.append([1, saving])
    plain, extra, sufficient = rank(features), rank(augmented), rank(paired)
    if extra != plain+1 or sufficient != 2:
        raise AssertionError('exact scoring feature-span claim failed')
    return {'status': 'PASS', 'support_epochs': len(partitions),
            'pairwise_feature_columns_including_constant': 16,
            'pairwise_feature_rank': plain, 'rank_with_paired_score': extra,
            'constant_plus_score_rank': sufficient,
            'minimal_expectation_features_for_this_single_paired_score': 1,
            'scope': 'exact population score identification; not an optimizer-recovery or finite-sample equivalence claim'}


if __name__ == '__main__':
    print(json.dumps(check(), indent=2))
