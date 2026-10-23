"""A strict complete-epoch pairwise-information separation, independently checked.

Every epoch partitions all six checks into exactly three nonempty completion
waves and charges one full initial construction. The witness applies to every
fanout >=6 and every positive S with 16/11 < H/S < 28/17. The all-topology
subset DP, literal hierarchy enumeration and affine orbit certificate below
import no HACT compiler, scoring helper, or exploratory search implementation.
"""
from __future__ import annotations
import argparse
from collections import Counter
from fractions import Fraction
from functools import lru_cache
from itertools import combinations, product
import json
from pathlib import Path

N, FULL, GROUP = 6, 63, 15
RESULT = Path(__file__).resolve().parents[1] / 'results/v11/strict_partition_witness.json'


@lru_cache(maxsize=None)
def set_partitions(mask):
    """Bit-subset construction, independently of the discovery LP's RGS."""
    if not mask:
        return ((),)
    first, rest = mask & -mask, mask ^ (mask & -mask)
    result, subset = [], rest
    while True:
        for tail in set_partitions(rest ^ subset):
            result.append((first | subset, *tail))
        if subset == 0:
            return tuple(result)
        subset = (subset-1) & rest


def _type(partition):
    return tuple(sorted(((block & GROUP).bit_count(), (block & (FULL ^ GROUP)).bit_count())
                        for block in partition))


def witness():
    source = tuple(p for p in set_partitions(FULL) if len(p)==3)
    types = {'B':tuple(sorted(((2,1),(2,0),(0,1)))),
             'C':tuple(sorted(((2,1),(1,1),(1,0)))),
             'D':tuple(sorted(((2,0),(1,1),(1,1))))}
    families = {name:tuple(p for p in source if _type(p)==kind) for name,kind in types.items()}
    if len(source)!=90 or {k:len(v) for k,v in families.items()}!={'B':12,'C':24,'D':12}:
        raise AssertionError('partition family enumeration differs')
    a = (GROUP, 16, 32)
    p = {a:Fraction(7,8), **{partition:Fraction(1,96) for partition in families['B']}}
    q = {a:Fraction(9,10), **{partition:Fraction(1,480) for partition in families['C']},
         **{partition:Fraction(1,240) for partition in families['D']}}
    for distribution in (p,q):
        validate(distribution)
    return families, {'P':p,'Q':q}


def validate(distribution):
    if sum(distribution.values())!=1 or any(value<0 for value in distribution.values()):
        raise ValueError('probabilities must be nonnegative and sum to one')
    for partition in distribution:
        if len(partition)!=3 or any(type(block) is not int or block<=0 or block>FULL for block in partition):
            raise ValueError('exactly three nonempty valid completion waves required')
        union = 0
        for block in partition:
            if union & block:
                raise ValueError('a check completed in two waves')
            union |= block
        if union!=FULL:
            raise ValueError('epoch omitted a declared check')


def moments(distribution):
    validate(distribution)
    return tuple(tuple(sum(probability * any(block & (1<<i) and block & (1<<j)
                                            for block in partition)
                           for partition,probability in distribution.items())
                       for j in range(N)) for i in range(N))


def hit_mean(distribution, mask):
    return sum(probability * sum(bool(block & mask) for block in partition)
               for partition,probability in distribution.items())


def exact_subset_dp(distribution, header=512, slot=320, fanout=8):
    validate(distribution)
    h,s = Fraction(header),Fraction(slot)
    if h<0 or s<=0 or type(fanout) is not int or fanout<2:
        raise ValueError('invalid exact packet contract')
    solved, partitions_considered = {},0
    for mask in sorted(range(1,FULL+1),key=lambda x:(x.bit_count(),x)):
        if mask.bit_count()==1:
            solved[mask] = (Fraction(0),1,mask.bit_length()-1,())
            continue
        weight = 1+hit_mean(distribution,mask)
        best,ways,tree,roots = None,0,None,[]
        for children in set_partitions(mask):
            if not 2<=len(children)<=fanout:
                continue
            partitions_considered += 1
            cost = (h+s*len(children))*weight + sum(solved[c][0] for c in children)
            count = 1
            for child in children:
                count *= solved[child][1]
            if best is None or cost<best:
                best,ways,tree,roots = cost,count,tuple(solved[c][2] for c in children),[children]
            elif cost==best:
                ways += count
                roots.append(children)
        solved[mask] = best,ways,tree,tuple(roots)
    value,count,tree,roots = solved[FULL]
    return {'cost':str(value),'optimal_tree_count_unordered':count,'tree':tree,
            'optimal_root_partitions':roots,'subsets_solved':len(solved),
            'partitions_across_subproblems':partitions_considered}


@lru_cache(maxsize=None)
def literal_trees(labels):
    """All literal trees using a separate restricted-growth-string enumeration."""
    if len(labels)==1:
        return (labels[0],)
    groups, output = [[labels[0]]],[]
    def visit(position):
        if position==len(labels):
            if len(groups)>=2:
                output.extend(tuple(children) for children in product(
                    *(literal_trees(tuple(group)) for group in groups)))
            return
        value = labels[position]
        for group in groups:
            group.append(value)
            visit(position+1)
            group.pop()
        groups.append([value]); visit(position+1); groups.pop()
    visit(1)
    return tuple(output)


def literal_cost(tree, distribution, header=512, slot=320):
    """Set-based direct traversal, separate from the DP and bitmask pricing."""
    events = [(tuple(frozenset(i for i in range(N) if block & (1<<i)) for block in partition),p)
              for partition,p in distribution.items()]
    h,s = Fraction(header),Fraction(slot)
    def visit(node):
        if isinstance(node,int):
            return {node},Fraction(0)
        coverage,cost = set(),Fraction(0)
        for child in node:
            members,value = visit(child)
            if coverage & members:
                raise ValueError('repeated literal leaf')
            coverage.update(members); cost += value
        weight = 1+sum(p*sum(bool(coverage & block) for block in partition) for partition,p in events)
        return coverage,cost+(h+s*len(node))*weight
    covered,cost = visit(tree)
    if covered!=set(range(N)):
        raise ValueError('incomplete literal tree')
    return cost


def orbit_certificate(distributions):
    """All 56 two-node trees grouped into 11 exchangeability classes."""
    rows = []
    for g in range(5):
        for o in range(3):
            size = g+o
            if not 2<=size<=5:
                continue
            masks = [mask for mask in range(1,FULL) if (mask & GROUP).bit_count()==g
                     and (mask & (FULL ^ GROUP)).bit_count()==o]
            row = {'G_leaves':g,'O_leaves':o,'multiplicity':len(masks),'laws':{}}
            for name,distribution in distributions.items():
                weights = {1+hit_mean(distribution,mask) for mask in masks}
                if len(weights)!=1:
                    raise AssertionError('exchangeability orbit is not constant')
                weight = weights.pop()
                # 4*c(7-size) at the always-hit root, plus weight*c(size).
                hcoef,scoef = 4+weight,4*(7-size)+size*weight
                margins = [(hcoef-4)*r+scoef-24 for r in (Fraction(16,11),Fraction(28,17))]
                if (g,o)!=(4,0) and not all(x>0 for x in margins):
                    raise AssertionError('another orbit may beat flat inside price interval')
                row['laws'][name] = {'one_plus_expected_waves_hit':str(weight),
                    'header_coefficient':str(hcoef),'slot_coefficient':str(scoef),
                    'cost_at_512_320':str(512*hcoef+320*scoef),
                    'normalized_margin_over_flat_at_ratio_endpoints':[str(x) for x in margins]}
            rows.append(row)
    if len(rows)!=11 or sum(r['multiplicity'] for r in rows)!=56:
        raise AssertionError('two-node candidate set incomplete')
    return rows


def family_formulas(header=512,slot=320):
    h,s = Fraction(header),Fraction(slot)
    if s<=0 or not Fraction(16,11)<h/s<Fraction(28,17):
        raise ValueError('require S>0 and 16/11 < H/S < 28/17')
    a,b = (28*s-17*h)/8,(11*h-16*s)/5
    flat = 4*h+24*s
    return {'flat_cost':str(flat),'P_group_cost':str(Fraction(49,8)*h+Fraction(41,2)*s),
            'Q_group_cost':str(Fraction(31,5)*h+Fraction(104,5)*s),
            'P_regret_flat':str(a),'Q_regret_group':str(b),
            'deterministic_minimax_regret':str(min(a,b)),
            'randomized_minimax_regret':str(a*b/(a+b)),
            'optimal_group_probability':str(a/(a+b)),
            'minimum_nonroot_contraction_gain':str(2*(h-s)),
            'three_or_more_internal_margin_over_flat_P':str(2*(h-s)-a)}


def build_report():
    families,distributions = witness()
    p,q = distributions['P'],distributions['Q']
    m = moments(p)
    if m!=moments(q):
        raise AssertionError('pairwise information differs')
    for i,j in combinations(range(N),2):
        expected = Fraction(11,12) if i<4 and j<4 else Fraction(0) if i>=4 else Fraction(1,32)
        if m[i][j]!=expected:
            raise AssertionError('claimed pairwise moment differs')
    reference = {name:exact_subset_dp(distribution) for name,distribution in distributions.items()}
    trees = literal_trees(tuple(range(N)))
    if len(trees)!=2752 or len(set(trees))!=2752:
        raise AssertionError('literal all-topology enumeration incomplete/duplicated')
    literal = {}
    for name,distribution in distributions.items():
        values = [literal_cost(tree,distribution) for tree in trees]
        minimum = min(values)
        winners = [tree for tree,value in zip(trees,values) if value==minimum]
        if str(minimum)!=reference[name]['cost'] or len(winners)!=reference[name]['optimal_tree_count_unordered']:
            raise AssertionError('independent literal enumeration disagrees with subset DP')
        literal[name] = {'minimum':str(minimum),'optimal_tree_count_unordered':len(winners),
                         'optimal_trees':winners,'second_distinct_cost':str(min(v for v in values if v>minimum))}
    expected = family_formulas()
    if reference['P']['cost']!=expected['P_group_cost'] or reference['Q']['cost']!=expected['flat_cost']:
        raise AssertionError('strict witness optimum differs')
    if not all(record['optimal_tree_count_unordered']==1 for record in reference.values()):
        raise AssertionError('strict witness optima are not unique')
    if literal['P']['optimal_trees']==literal['Q']['optimal_trees']:
        raise AssertionError('strict global optimum sets not disjoint')
    return {'schema':'hact-v11-strict-partition-separation-1','status':'PASS',
            'kind':'constructed strict-epoch analytical witness, not observed software improvement',
            'complete_checks_per_epoch':N,'nonempty_disjoint_waves_per_epoch':3,
            'cold_builds_per_epoch':1,'maximum_arity_for_default_reference':8,
            'price_family':'S>0, 16/11 < H/S < 28/17, any integer maximum arity b>=6',
            'partition_family_sizes':{name:len(parts) for name,parts in families.items()},
            'support':{name:[{'partition':[[i for i in range(N) if block & (1<<i)] for block in partition],
                              'probability':str(weight)} for partition,weight in distribution.items()]
                       for name,distribution in distributions.items()},
            'same_wave_pair_probabilities_per_epoch':[[str(x) for x in row] for row in m],
            'uniform_random_wave_pair_probabilities':[[str(x/3) for x in row] for row in m],
            'group_expected_waves_hit':{name:str(hit_mean(distribution,GROUP))
                                        for name,distribution in distributions.items()},
            'default_price_formulas':expected,'all_topology_subset_reference':reference,
            'independent_literal_tree_enumeration':{'trees_considered':len(trees),'results':literal},
            'two_node_affine_orbit_certificate':orbit_certificate(distributions),
            'proof_reduction':[
                'Every complete three-wave partition gives node weight in [2,4], including one cold build.',
                'Contracting nonroot arity2 or3 reduces cost by at least2H or2(H-S).',
                'Any six-leaf tree with at least3 internal nodes has a nonroot arity2 or3 node by sum(d-1)=5.',
                'Contractions stay feasible because b>=6, so every optimum is flat or one of56 two-node group trees.',
                'The11 affine orbit classes certify that only flat and theG4 group can be nondominated throughout the open price interval.',
                'All larger trees are dominated by flat since2(H-S) exceeds a=(28S-17H)/8 throughout that interval.'
            ]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write',action='store_true')
    args = parser.parse_args()
    report = build_report()
    encoded = json.dumps(report,indent=2,sort_keys=True)+'\n'
    if args.write:
        RESULT.parent.mkdir(parents=True,exist_ok=True)
        RESULT.write_text(encoded)
    elif not RESULT.exists() or RESULT.read_text()!=encoded:
        raise SystemExit('strict partition witness differs; inspect before --write')
    print(json.dumps({'status':'PASS','strict_optima':{k:v['cost'] for k,v in report['all_topology_subset_reference'].items()},
                      'literal_trees':report['independent_literal_tree_enumeration']['trees_considered'],
                      'randomized_minimax_regret':report['default_price_formulas']['randomized_minimax_regret']}))


if __name__=='__main__':
    main()
