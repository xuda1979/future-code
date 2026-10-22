"""Historical-source eligibility must not depend on observed test failures."""
from experiments_v11.public_regressions import pytest_filename


def test_only_actual_pytest_filenames_are_eligible():
    assert pytest_filename("tests/test_bug.py")
    assert pytest_filename("testing/test_api.py")
    assert not pytest_filename("tests/check_types.py")
    assert not pytest_filename("src/test_bug.py")
    assert not pytest_filename("tests/test_bug.txt")
