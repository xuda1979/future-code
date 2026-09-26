"""Trusted standalone Python checker for the generated module microfixture."""
import json
import sys
MODULES=16
INPUTS=(-2,0,5,19)


def definitions():
    result=[]
    for i in range(MODULES):
        result.extend({'kind':'unit','module':i,'x':x} for x in INPUTS)
        result.append({'kind':'integration','module':i,'other':(i+1)%MODULES,'x':3})
    return result


def main():
    payload=json.load(sys.stdin);modules=[]
    for i,text in enumerate(payload['sources']):
        namespace={}
        exec(compile(text,f'mod{i:02d}.py','exec'),namespace)
        modules.append(namespace['transform'])
    gates=definitions();result=[]
    for gate in payload['gates']:
        d=gates[gate];i=d['module'];x=d['x']
        if d['kind']=='unit':actual=modules[i](x);expected=x+i
        else:
            j=d['other'];actual=modules[i](modules[j](x));expected=x+i+j
        result.append({'gate':gate,'actual':actual,'expected':expected,
                       'status':'PASS' if actual==expected else 'FAIL'})
    json.dump(result,sys.stdout,sort_keys=True)

if __name__=='__main__':main()
