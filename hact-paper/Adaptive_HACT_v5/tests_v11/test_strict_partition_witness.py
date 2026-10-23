"""Exact complete-epoch partition witness and affine-price boundary checks."""
from fractions import Fraction as F
from itertools import combinations
import json
import math

import pytest

from experiments_v11.strict_partition_witness import (
    RESULT, build_report, exact_subset_dp, family_formulas, hit_mean, literal_trees,
    moments, orbit_certificate, validate, witness,
)


def test_all_check_obligations_complete_once_in_each_of_three_waves():
    families,laws = witness()
    assert {k:len(v) for k,v in families.items()}=={'B':12,'C':24,'D':12}
    assert len(laws['P'])==13 and len(laws['Q'])==37
    for law in laws.values():
        assert sum(law.values())==1
        for partition in law:
            assert len(partition)==3
            assert sum(block.bit_count() for block in partition)==6
            assert partition[0] | partition[1] | partition[2]==63
            assert not any(a & b for a,b in combinations(partition,2))


def test_exact_same_wave_pairwise_moments_despite_distinct_full_wave_counts():
    _,laws = witness()
    p,q = moments(laws['P']),moments(laws['Q'])
    assert p==q
    assert all(p[i][i]==1 for i in range(6))
    assert p[0][1]==F(11,12)
    assert p[0][4]==F(1,32)
    assert p[4][5]==0
    assert hit_mean(laws['P'],15)==F(9,8)
    assert hit_mean(laws['Q'],15)==F(6,5)
    # Choosing a uniform random wave divides every count by the same q=3.
    assert p[0][0]/3==F(1,3) and p[0][4]/3==F(1,96)


@pytest.mark.parametrize('h,s,fanout',[(512,320,6),(512,320,8),(512,320,32),
                                      (3,2,6),(8,5,8),(82,50,6)])
def test_exact_all_subset_solver_confirms_price_family(h,s,fanout):
    _,laws = witness()
    formulas = family_formulas(h,s)
    p = exact_subset_dp(laws['P'],h,s,fanout)
    q = exact_subset_dp(laws['Q'],h,s,fanout)
    assert p['cost']==formulas['P_group_cost']
    assert q['cost']==formulas['flat_cost']
    assert p['optimal_tree_count_unordered']==q['optimal_tree_count_unordered']==1
    assert p['tree']!=q['tree']


def test_default_minimax_costs_and_gaps_are_exact():
    formulas = family_formulas()
    assert formulas['flat_cost']=='9728'
    assert formulas['P_group_cost']=='9696'
    assert formulas['Q_group_cost']=='49152/5'
    assert formulas['P_regret_flat']=='32'
    assert formulas['Q_regret_group']=='512/5'
    assert formulas['deterministic_minimax_regret']=='32'
    assert formulas['randomized_minimax_regret']=='512/21'
    assert formulas['optimal_group_probability']=='5/21'
    assert F(formulas['minimum_nonroot_contraction_gain'])>F(formulas['P_regret_flat'])


@pytest.mark.parametrize('h,s,tied_law',[(16,11,'Q'),(28,17,'P')])
def test_open_price_interval_is_necessary_for_disjoint_optima(h,s,tied_law):
    with pytest.raises(ValueError):
        family_formulas(h,s)
    _,laws = witness()
    results = {name:exact_subset_dp(law,h,s,6) for name,law in laws.items()}
    assert results[tied_law]['optimal_tree_count_unordered']==2
    assert results['P' if tied_law=='Q' else 'Q']['optimal_tree_count_unordered']==1


def test_all_eleven_orbits_certify_all_fifty_six_two_internal_node_trees():
    _,laws = witness()
    rows = orbit_certificate(laws)
    assert len(rows)==11 and sum(r['multiplicity'] for r in rows)==56
    expected = {(0,2):('3','3'),(1,1):('95/32','95/32'),
                (2,0):('25/12','25/12'),(1,2):('63/16','63/16'),
                (2,1):('97/32','121/40'),(3,0):('17/8','43/20'),
                (2,2):('191/48','119/30'),(3,1):('49/16','491/160'),
                (4,0):('17/8','11/5'),(3,2):('4','319/80'),
                (4,1):('49/16','31/10')}
    for row in rows:
        a,b = row['G_leaves'],row['O_leaves']
        assert row['multiplicity']==math.comb(4,a)*math.comb(2,b)
        assert tuple(row['laws'][k]['one_plus_expected_waves_hit'] for k in ('P','Q'))==expected[(a,b)]
        if (a,b)!=(4,0):
            assert all(F(margin)>0 for law in row['laws'].values()
                       for margin in law['normalized_margin_over_flat_at_ratio_endpoints'])


def test_literal_enumeration_and_contraction_reduction_cover_every_topology():
    trees = literal_trees(tuple(range(6)))
    assert len(trees)==len(set(trees))==2752
    def count(node):
        return 0 if isinstance(node,int) else 1+sum(count(child) for child in node)
    def nonroot_small(node):
        if isinstance(node,int):
            return False
        return any((not isinstance(child,int) and (len(child) in (2,3) or nonroot_small(child)))
                   for child in node)
    assert sum(count(tree)==1 for tree in trees)==1
    assert sum(count(tree)==2 for tree in trees)==56
    assert all(nonroot_small(tree) for tree in trees if count(tree)>=3)


def test_missing_or_repeated_completions_and_bad_probability_are_rejected():
    with pytest.raises(ValueError):
        validate({(15,16,16):F(1)})
    with pytest.raises(ValueError):
        validate({(7,8,16):F(1)})
    with pytest.raises(ValueError):
        validate({(15,16,32):F(1,2)})


def test_committed_certificate_matches_both_independent_all_tree_paths():
    assert json.loads(RESULT.read_text())==json.loads(json.dumps(build_report()))


def test_actual_fullwave_refiner_uses_the_complete_strict_epochs():
    # Exercise the actual optional compiler, with its output priced by the
    # independent all-topology reference rather than its own score helper.
    from ichact.fullwave import refine_fullwave
    from ichact.practical import balanced_layout
    _,laws = witness()
    incumbent = balanced_layout(tuple(f'g{i}' for i in range(6)))
    outputs = {}
    for name,law in laws.items():
        denominator = math.lcm(*(p.denominator for p in law.values()))
        training = []
        for partition,p in law.items():
            epoch = [[i for i in range(6) if block & (1<<i)] for block in partition]
            training.extend([epoch]*int(p*denominator))
        refined,receipt = refine_fullwave(incumbent,training,max_subtree_leaves=6)
        def literal(node):
            return node.lo if node.leaf else tuple(literal(child) for child in node.children)
        result = literal(refined.tree)
        from experiments_v11.strict_partition_witness import literal_cost
        assert str(literal_cost(result,law))==exact_subset_dp(law)['cost']
        assert receipt['training_total_after']<=receipt['training_total_before']
        outputs[name] = refined.uid
    assert outputs['P']!=outputs['Q']
