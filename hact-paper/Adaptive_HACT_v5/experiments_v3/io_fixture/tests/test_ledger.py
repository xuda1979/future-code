import sqlite3
import pytest
from ledger import apply


@pytest.mark.parametrize('delta', [-100,-10,-1,0,1,10,100,999])
def test_idempotent(tmp_path, delta):
    path=tmp_path/'ledger.db'
    assert apply(path,'one','alice',delta)==delta
    assert apply(path,'one','alice',delta)==delta
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT COUNT(*) FROM entries').fetchone()[0]==1


@pytest.mark.parametrize('delta',[1,2,3,4])
def test_conflict_rolls_back(tmp_path,delta):
    path=tmp_path/'ledger.db'
    apply(path,'one','alice',delta)
    with pytest.raises(ValueError): apply(path,'one','bob',delta+1)
    assert apply(path,'two','alice',2)==delta+2
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT COUNT(*) FROM entries').fetchone()[0]==2


@pytest.mark.parametrize('bad',[None,True,'2',1.5])
def test_validation_without_write(tmp_path,bad):
    path=tmp_path/'ledger.db'
    with pytest.raises(ValueError):apply(path,'one','alice',bad)
    assert not path.exists()
