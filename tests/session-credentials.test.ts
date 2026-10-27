import {describe,it,expect} from 'vitest';
import {SessionCredentials} from '../src/session-credentials';
describe('session-only credential boundary',()=>{
  it('starts empty and clears credentials',()=>{
    const s=new SessionCredentials();expect(s.get()).toBeNull();s.set({username:'test',password:'artificial'});
    expect(s.get()?.username).toBe('test');s.clear();expect(s.get()).toBeNull();
  });
  it('neither serializes nor exposes an enumerable credential field',()=>{
    const s=new SessionCredentials();s.set({username:'test',password:'public-marker'});
    expect(JSON.stringify(s)).toBe('{}');expect(Object.keys(s)).toHaveLength(0);
  });
  it('input and output objects cannot mutate owned credentials',()=>{
    const s=new SessionCredentials(),input={username:'test',password:'public-marker'};s.set(input);input.password='changed';
    const output=s.get()!;output.password='also-changed';expect(s.get()?.password).toBe('public-marker');
  });
  it('a retained provider returns nothing after owner clears',()=>{
    const s=new SessionCredentials();s.set({username:'test',password:'artificial'});const provider=()=>s.get();s.clear();expect(provider()).toBeNull();
  });
  it('rejects malformed and unbounded credential inputs',()=>{
    const s=new SessionCredentials();expect(()=>s.set({username:'test',password:'x'.repeat(4097)})).toThrow('AUTH');
    expect(()=>s.set(null as never)).toThrow('AUTH');expect(s.get()).toBeNull();
  });
});
