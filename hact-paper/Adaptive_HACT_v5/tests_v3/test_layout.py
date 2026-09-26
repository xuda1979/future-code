import itertools
import numpy as np
import pytest
from ichact.layout import Layout,fit_layout,fit_catalogue,cluster_order,spectral_order,jaccard_affinity,select_validation
from ichact.frontier import frontier_bytes
from hact.tree import compact_balanced,CostModel


def test_full_cost_equals_independent_remap():
    rng=np.random.default_rng(4);registry=tuple(f'g{i}' for i in range(32))
    order=tuple(map(int,rng.permutation(32)));tree=compact_balanced(32,8)
    layout=Layout(registry,order,tree);inverse={g:i for i,g in enumerate(order)}
    waves=[list(map(int,rng.choice(32,size=5,replace=False))) for _ in range(4)]
    assert layout.cost(waves)==frontier_bytes(tree,[[inverse[i] for i in w] for w in waves])
    assert Layout.from_dict(layout.to_dict())==layout

@pytest.mark.parametrize('bad',[(0,0),(True,1),(0,2),(0,),('0',1)])
def test_invalid_permutation(bad):
    with pytest.raises(ValueError):Layout(('a','b'),bad,compact_balanced(2,8))

@pytest.mark.parametrize('algorithm',[cluster_order,spectral_order])
def test_disconnected_affinity_and_unobserved(algorithm):
    waves=[[[0,3]],[[1,4]],[[0,3]],[[1,4]]]
    a=jaccard_affinity(waves,6);order=algorithm(a)
    assert set(order)==set(range(6))
    assert abs(order.index(0)-order.index(3))==1
    assert abs(order.index(1)-order.index(4))==1
    assert algorithm(np.zeros((6,6)))==tuple(range(6))
    assert algorithm(a)==order

def test_degenerate_eigenvalues_deterministic():
    a=np.ones((5,5))-np.eye(5)
    assert spectral_order(a)==cluster_order(a)

@pytest.mark.parametrize('a',[np.ones((2,3)),np.array([[0,1],[0,0]]),np.array([[0,np.nan],[np.nan,0]])])
def test_invalid_affinity(a):
    with pytest.raises(ValueError):spectral_order(a)


def test_pairwise_information_loss_parity():
    even=[[],[0,1],[0,2],[1,2]];odd=[[0],[1],[2],[0,1,2]]
    a=jaccard_affinity([[x] for x in even],4);b=jaccard_affinity([[x] for x in odd],4)
    assert np.allclose(a,b)
    assert sum(bool(set(x)&{0,1,2}) for x in even)/4==.75
    assert sum(bool(set(x)&{0,1,2}) for x in odd)/4==1


def test_catalogue_selection_on_independent_holdout():
    reg=tuple(f'g{i}' for i in range(16))
    training=[[[i,i+4,i+8,i+12]] for i in range(4)]*4
    validation=[[[i,i+4,i+8,i+12]] for i in range(4)]
    cat=fit_catalogue(reg,training)
    choice,scores=select_validation(cat,validation)
    assert scores[choice]<=scores['original']
    assert set(cat)=={'original','spectral','cluster'}


def test_exact_best_of_orders_small():
    episodes=[[[0,2]],[[1,3]],[[0,2]]];registry=('a','b','c','d')
    best=min(sum(fit_layout(registry,episodes,p).cost(x) for x in episodes) for p in itertools.permutations(range(4)))
    cat=fit_catalogue(registry,episodes)
    assert min(sum(x.cost(ep) for ep in episodes) for x in cat.values())>=best
