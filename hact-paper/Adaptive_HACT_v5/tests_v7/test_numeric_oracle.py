"""Independent arithmetic oracle; never calls Layout.cost, coverage or optimizer."""
from itertools import product
import pytest
from ichact.practical import balanced_layout


def independent_price(layout_object, episode):
    order = layout_object["order"]
    model = layout_object["model"]
    total = 0
    waves = [set(w) for w in episode]

    def visit(node):
        nonlocal total
        children = node["children"]
        if not children:
            assert node["lo"] == node["hi"]
            return
        ids = set(order[node["lo"]:node["hi"] + 1])
        price = model["header"] + model["card"] * len(children)
        assert price <= model["cap"]
        total += price
        for wave in waves:
            if ids.intersection(wave):
                total += price
        for child in children:
            visit(child)
    visit(layout_object["tree"])
    return total


@pytest.mark.parametrize("order", [
    (0, 1, 2, 3), (3, 2, 1, 0), (1, 3, 0, 2),
])
@pytest.mark.parametrize("wave", [(), (0,), (0, 2), (0, 1, 2, 3)])
def test_reference_arithmetic_matches_layout_cost(order, wave):
    l = balanced_layout(("a", "b", "c", "d"), order, fanout=2)
    episode = [list(wave)]
    assert independent_price(l.to_dict(), episode) == l.cost(episode)


def test_oracle_detects_tampered_byte_price():
    l = balanced_layout(("a", "b", "c", "d"), fanout=2)
    archive = l.to_dict()
    assert independent_price(archive, [[0, 3]]) == l.cost([[0, 3]])
    archive["model"]["header"] += 1
    assert independent_price(archive, [[0, 3]]) != l.cost([[0, 3]])
