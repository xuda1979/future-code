"""Frozen source/test scopes: selected upstream suites, not entire projects."""
SCOPES = {
 'networkx': {'package':'networkx','pythonpath':'.',
  'tests':['networkx/algorithms/components/tests','networkx/algorithms/traversal/tests','networkx/algorithms/shortest_paths/tests/test_unweighted.py','networkx/algorithms/shortest_paths/tests/test_generic.py'],
  'sources':['networkx/algorithms/components/connected.py','networkx/algorithms/components/strongly_connected.py','networkx/algorithms/components/weakly_connected.py','networkx/algorithms/traversal/breadth_first_search.py','networkx/algorithms/traversal/depth_first_search.py','networkx/algorithms/shortest_paths/unweighted.py']},
 'toolz': {'package':'toolz','pythonpath':'.',
  'tests':['toolz/tests/test_itertoolz.py','toolz/tests/test_functoolz.py','toolz/tests/test_dicttoolz.py','toolz/tests/test_recipes.py','toolz/tests/test_curried.py','toolz/tests/test_utils.py'],
  'sources':['toolz/itertoolz.py','toolz/functoolz.py','toolz/dicttoolz.py','toolz/recipes.py','toolz/utils.py']},
 'future': {'package':'future_code','pythonpath':'src','tests':['tests/test_contracts.py','tests/test_store.py','tests/test_contract_first.py','tests/test_coordination.py','tests/test_coordination_edges.py','tests/test_hierarchy_contract.py'],
  'sources':['src/future_code/contracts.py','src/future_code/context.py','src/future_code/coordination.py','src/future_code/security.py','src/future_code/reporting.py','src/future_code/store.py']}}
