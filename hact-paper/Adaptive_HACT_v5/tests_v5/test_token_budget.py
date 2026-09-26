import pytest
from ichact.token_budget import measure_text,token_bounded_pages,PREFIX
from ichact.exposure import diagnostic_pages, split_packets, compact_packet
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

@pytest.fixture
def packets():
    path=ROOT/'results/v3/fresh_checkers/networkx/networkx_confirm_000-fixed8/certificate_packets.bin'
    return split_packets(path.read_bytes())[:8]

def byte_oracle(s):return len(s.encode('utf8'))  # instrumentation fixture, NOT BPE

def test_measurement_names_encoding_and_not_provider():
    r=measure_text('a\u4e2d'.encode(),lambda s:len(s),'TEST-codepoints-not-a-model')
    assert (r.input_bytes,r.content_tokens,r.provider_tokens)==(4,2,None)

def test_dual_cap_matches_reference_when_one_cap_inactive(packets):
    a=token_bounded_pages(packets,byte_oracle,encoding='TEST-byte-oracle',token_budget=10**6)
    assert a==diagnostic_pages(packets)

def test_whole_packets_preserved_and_caps(packets):
    a=token_bounded_pages(packets,byte_oracle,encoding='TEST-byte-oracle',token_budget=4096,reserved_tokens=100)
    assert all(len(x)<=3996 for x in a)
    assert b''.join(x[len(PREFIX):] for x in a)==b''.join(compact_packet(p) for p in packets)

def test_rejects_single_oversize_packet(packets):
    with pytest.raises(ValueError):token_bounded_pages(packets,byte_oracle,encoding='TEST',token_budget=100)

def test_empty_input_has_no_pages():
    assert token_bounded_pages([],byte_oracle,encoding='TEST')==[]

@pytest.mark.parametrize('count',[lambda _:None,lambda _:True,lambda _:-1,lambda _:1.5])
def test_invalid_or_missing_counts_fail_closed(count):
    with pytest.raises(ValueError):measure_text(b'x',count,'TEST')

def test_errors_propagate():
    def missing(_):raise RuntimeError('vocabulary unavailable')
    with pytest.raises(RuntimeError):token_bounded_pages([],missing,encoding='TEST')

def test_count_entire_candidate_not_sum(packets):
    seen=[]
    def nonadditive(s):
        seen.append(s)
        return 1 if len(s)>500 else 200
    pages=token_bounded_pages(packets,nonadditive,encoding='TEST-nonadditive',token_budget=201)
    assert pages and seen[-1]==pages[-1].decode()

@pytest.mark.parametrize('params',[{'token_budget':1,'reserved_tokens':1},{'token_budget':True},{'byte_budget':0},{'reserved_tokens':-1}])
def test_bad_budgets(params):
    with pytest.raises(ValueError):token_bounded_pages([],byte_oracle,encoding='TEST',**params)
