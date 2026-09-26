import sqlite3
import pytest
from service import ingest


@pytest.mark.parametrize('n',range(1,9))
def test_end_to_end_commit(endpoint,tmp_path,n):
    path=tmp_path/'ledger.db'
    assert ingest(path,endpoint+f'/{n}')==n
    assert ingest(path,endpoint+f'/{n}')==n
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT COUNT(*) FROM entries').fetchone()[0]==1
