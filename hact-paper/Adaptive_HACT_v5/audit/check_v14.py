"""Audit retained v14 evidence without importing the optimizer or its study."""
from fractions import Fraction
from pathlib import Path
import hashlib,json

ROOT=Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def literal_cost(layout, executed, width=8):
    ids, order, model = layout['registry'],layout['order'],layout['model']
    waves=[set(executed[i:i+width]) for i in range(0,len(executed),width)]
    def visit(node):
        if not node['children']:
            return {ids[order[node['lo']]]},0
        members,cost=set(),0
        for child in node['children']:
            inside,below=visit(child)
            require(not members&inside,'overlapping literal tree')
            members |= inside
            cost += below
        price=model['header']+model['card']*len(node['children'])
        require(2<=len(node['children']) and price<=model['cap'],'invalid arity')
        return members,cost+price*(1+sum(bool(members&wave) for wave in waves))
    covered,cost=visit(layout['tree'])
    require(covered==set(ids),'incomplete literal coverage')
    return cost


def verify(data, root=ROOT):
    require(data['schema']=='hact-v14-exchangeable-baseline-1','wrong study schema')
    rows=data['exhaustive']['cases']
    expected={(n,w,b) for n in range(2,7) for w in range(1,n+1) for b in range(2,n+1)}
    require(len(rows)==len(expected)==70 and {(r['n'],r['width'],r['fanout']) for r in rows}==expected,'missing analytical cases')
    require(sum(r['literal_trees_checked'] for r in rows)==data['exhaustive']['global_tree_comparisons']==74245,'tree-comparison count changed')
    for row in rows:
        require(Fraction(row['exact_optimum'])>0,'invalid exact optimum')
        if row['width']==row['n']:
            # One wave: each node pays exactly two packets. Edge counting
            # minimizes number of internals I=ceil((n-1)/(b-1)).
            n,b=row['n'],row['fanout'];internal=(n-2+b-1)//(b-1)
            expected_cost=2*(internal*(512+320)+320*(n-1))
            require(Fraction(row['exact_optimum'])==expected_cost,'one-wave closed-form boundary mismatch')
    public=data['public']
    require(len(public)==6 and {r['project'] for r in public}=={'click','jinja','packaging','pluggy','attrs','exceptiongroup'},'public cohort changed')
    by_policy={'items':[],'files':[]};table=[]
    for row in public:
        if row['project']=='packaging':
            require(row['status']=='UNKNOWN','resource exclusion silently promoted');continue
        require(row['status']=='PASS' and row['compile_seconds']>=0,'invalid fitted project')
        n=row['n'];layout=row['layout']
        require(len(layout['registry'])==n and sorted(layout['order'])==list(range(n)),'layout registry/order mismatch')
        require(len(row['original_runs'])==5 and len(row['dispatch_shifts'])==6,'missing retained runs')
        for item in row['original_runs']:
            path=root/f"results/v11/public_checks_normalized/{row['project']}/run_{item['run']}/pytest_evidence.json"
            raw=path.read_bytes();evidence=json.loads(raw)
            require(hashlib.sha256(raw).hexdigest()==item['input_sha256'],'original input binding failed')
            require(literal_cost(layout,evidence['executed'])==item['exchangeable'],'original literal packet cost differs')
        for item in row['dispatch_shifts']:
            raw=(root/item['input']).read_bytes();evidence=json.loads(raw)
            require(hashlib.sha256(raw).hexdigest()==item['input_sha256'],'shift input binding failed')
            require(literal_cost(layout,evidence['executed'])==item['exchangeable'],'shift literal packet cost differs')
            by_policy[item['policy']].append(item)
        gains={}
        for policy in by_policy:
            items=[x for x in row['dispatch_shifts'] if x['policy']==policy]
            gains[policy]=100*sum(Fraction(x['fullwave32']-x['exchangeable']) for x in items)/sum(x['fullwave32'] for x in items)
        table.append({'project':row['project'],'n':n,'items_percent_vs_fullwave32':str(gains['items']),
                      'files_percent_vs_fullwave32':str(gains['files']),
                      'original_penalty_percent_vs_fullwave32':str(Fraction(100*(row['original_runs'][3]['exchangeable']-row['original_runs'][3]['fullwave32']),row['original_runs'][3]['fullwave32']))})
    for policy,items in by_policy.items():
        require(len(items)==15,'missing policy runs')
        require(all((x['exchangeable']<x['fullwave32']) if policy=='items' else
                    (x['exchangeable']>x['fullwave32']) for x in items),'reported policy boundary no longer holds')
    for name,digest in data['inputs'].items():
        require(hashlib.sha256((root/name).read_bytes()).hexdigest()==digest,'source/protocol binding mismatch')
    return {'status':'PASS','analytical_cases':70,'global_tree_comparisons':74245,'admitted_original_runs':25,
            'admitted_shift_runs':30,'items_wins_vs_fullwave32':15,'files_losses_vs_fullwave32':15,'table':table,
            'scope':'independent literal scoring/arithmetic of retained data; analytical global-optimum replay is a separate check'}


if __name__=='__main__':
    print(json.dumps(verify(json.loads((ROOT/'results/v14/exchangeable.json').read_text())),indent=2))
