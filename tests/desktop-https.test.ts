// @vitest-environment node
import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {access,readFile} from 'node:fs/promises';
import {X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createDesktopHttpsTransport,createCertificateHttpsTransport,createLoopbackHttpsTestTransport,type DesktopHttpsTransport} from '../src/desktop-https';
import {validateCertificateTrust} from '../src/certificate-trust';
import {nasDefaults,validateNasSettings} from '../src/nas-settings';
import {ResourcePool} from '../src/resources';
import {startTlsLab,type TlsLab} from '../scripts/tls-test-server.mjs';
const origin='https://127.0.0.1:19225';
const credentials=()=>({username:'poc-user',password:'poc-password'});
let lab:TlsLab;
const transports:DesktopHttpsTransport[]=[];
const make=(options={})=>{const t=createLoopbackHttpsTestTransport(lab.ca,{getCredentials:credentials,timeoutMs:1000,...options});transports.push(t);return t;};
const leafTrust=async(name='valid-localhost')=>{
  const certificatePem=await readFile(`runtime/tls/${name}-cert.pem`,'utf8');
  return {address:'127.0.0.1',port:19225,serverName:'localhost',sha256:new X509Certificate(certificatePem).fingerprint256.replaceAll(':',''),certificatePem};
};
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
beforeAll(async()=>{
  try{await access('runtime/tls/valid-localhost-cert.pem');}catch{execFileSync(process.execPath,['scripts/generate-tls-fixtures.mjs'],{cwd:process.cwd()});}
  lab=await startTlsLab();
},20000);
beforeEach(async()=>{await lab.certificate('valid-localhost');lab.reset();});
afterAll(async()=>{for(const t of transports)t.dispose();await lab?.close();});
describe('real loopback HTTPS sockets, certificate verification and bounded reads',()=>{
  it('scoped public leaf trust maps only its TLS identity to its fixed address and loads binary',async()=>{
    const trust=await leafTrust(),t=createCertificateHttpsTransport({origin,getCredentials:credentials},trust);transports.push(t);
    const result=await t.load(origin+'/image');expect(result.bytes.byteLength).toBe(lab.pngBytes);
    expect(t.stats().trust.policy).toBe('explicit-leaf-endpoint');expect(t.stats().active).toBe(0);
    expect(lab.state.events).toHaveLength(1);expect(lab.state.events[0]!.authorizationPresent).toBe(true);
    expect(lab.state.events[0]).toHaveProperty('host','127.0.0.1:19225');
  });
  it('scoped anonymous probe never reads credentials, and rejects logical-host and port escape',async()=>{
    const provider=vi.fn(()=>null),t=createCertificateHttpsTransport({origin,getCredentials:provider},await leafTrust());transports.push(t);
    expect((await t.probe(origin+'/')).status).toBe(401);expect(provider).not.toHaveBeenCalled();
    await expect(t.probe('https://localhost:19225/')).rejects.toMatchObject({code:'HOST'});
    await expect(t.probe('https://127.0.0.1:19226/')).rejects.toMatchObject({code:'HOST'});
    expect(lab.state.events).toHaveLength(1);expect(lab.state.events[0]!.authorizationPresent).toBe(false);
  });
  it('scoped trust refuses replacement certificates and redirects without forwarding credentials',async()=>{
    const t=createCertificateHttpsTransport({origin,getCredentials:credentials},await leafTrust());transports.push(t);
    await expect(t.load(origin+'/redirect-cross')).rejects.toMatchObject({code:'REDIRECT'});
    expect(lab.state.events).toHaveLength(1);expect(lab.state.events[0]!.server).toBe('A');
    lab.reset();await lab.certificate('wrong-host');await expect(t.load(origin+'/image')).rejects.toMatchObject({code:'TLS'});
    expect(lab.state.events).toHaveLength(0);expect(t.stats().active).toBe(0);
  });
  it('native expiry validation remains active even for the explicitly trusted leaf',async()=>{
    await lab.certificate('expired');const t=createCertificateHttpsTransport({origin,getCredentials:credentials},await leafTrust('expired'));transports.push(t);
    await expect(t.load(origin+'/image')).rejects.toMatchObject({code:'TLS'});expect(lab.state.events).toHaveLength(0);
  });
  it('rejects mismatched endpoint, name, fingerprint, private keys and extra certificates before network',async()=>{
    const trust=await leafTrust();
    for(const change of [{address:'127.0.0.2'},{port:19226},{serverName:'wrong.invalid'},{sha256:'0'.repeat(64)},
      {certificatePem:trust.certificatePem+trust.certificatePem},{certificatePem:'-----BEGIN PRIVATE KEY-----\nPUBLIC-TEST\n-----END PRIVATE KEY-----'},
      {serverName:'https://localhost'},{serverName:'*.localhost'}])expect(()=>validateCertificateTrust({...trust,...change},origin)).toThrow();
    const ca=lab.ca;expect(()=>validateCertificateTrust({...trust,certificatePem:ca,sha256:new X509Certificate(ca).fingerprint256.replaceAll(':','')},origin)).toThrow();
    expect(lab.state.events).toHaveLength(0);
  });
  it('persists only public trust fields and rejects stale trust when the endpoint changes',async()=>{
    const trust=await leafTrust();const cfg=validateNasSettings({...nasDefaults(),endpoint:origin,certificateTrust:{...trust,password:'MUST-NOT-PERSIST'}});
    expect(cfg.certificateTrust).toEqual(trust);expect(JSON.stringify(cfg)).not.toContain('MUST-NOT-PERSIST');
    expect(()=>validateNasSettings({...cfg,endpoint:'https://127.0.0.1:19226'})).toThrow();
  });
  it('unauthenticated preflight verifies TLS without reading credentials or buffering the body',async()=>{
    const provider=vi.fn(()=>null),t=make({getCredentials:provider});const result=await t.probe(`${origin}/auth-fail`);
    expect(result.status).toBe(401);expect(result.bytes.byteLength).toBe(0);expect(provider).not.toHaveBeenCalled();
    expect(lab.state.events).toMatchObject([{authorizationPresent:false,method:'GET'}]);expect(t.stats().active).toBe(0);
  });
  it('PROPFIND uses only finite depth and a fixed read-only XML body',async()=>{
    const t=make();const response=await t.propfind(`${origin}/dav/`,1);
    expect(response.status).toBe(207);expect(new TextDecoder().decode(response.bytes)).toContain('multistatus');
    expect(lab.state.events).toMatchObject([{method:'PROPFIND',depth:'1',authorizationPresent:true}]);
    expect(lab.state.events[0]!.requestBodyBytes).toBeGreaterThan(0);expect(t.stats().active).toBe(0);
  });
  it('rejects Depth infinity or invalid depth before opening any request',async()=>{
    const t=make();await expect(t.propfind(`${origin}/dav/`,'infinity' as never)).rejects.toThrow('PATH');
    await expect(t.propfind(`${origin}/dav/`,2 as never)).rejects.toThrow('PATH');expect(t.stats().started).toBe(0);
  });
  it('validates the test CA and hostname, sends only authenticated GET, returns image bytes',async()=>{
    const t=make();const result=await t.load(`${origin}/image`);
    expect(result.mime).toBe('image/png');expect(result.bytes.byteLength).toBe(lab.pngBytes);
    expect(lab.state.events).toMatchObject([{server:'A',method:'GET',authorizationPresent:true}]);
    expect(t.stats()).toMatchObject({active:0,started:1});
  });
  it('default trust rejects the private test CA before any authenticated HTTP request',async()=>{
    const t=createDesktopHttpsTransport({origin,getCredentials:credentials});transports.push(t);
    await expect(t.load(`${origin}/image`)).rejects.toMatchObject({code:'TLS'});
    expect(lab.state.events).toHaveLength(0);expect(t.stats().active).toBe(0);
  });
  it('ignores attempted TLS bypass/CA overrides in the production factory',async()=>{
    const t=createDesktopHttpsTransport({origin,getCredentials:credentials,rejectUnauthorized:false,ca:lab.ca} as never);transports.push(t);
    await expect(t.load(`${origin}/image`)).rejects.toMatchObject({code:'TLS'});expect(lab.state.events).toHaveLength(0);
  });
  it.each(['wrong-host','expired'] as const)('rejects %s certificate even when issuer is trusted',async name=>{
    await lab.certificate(name);const t=make();await expect(t.load(`${origin}/image`)).rejects.toMatchObject({code:'TLS'});
    expect(lab.state.events).toHaveLength(0);expect(t.stats().active).toBe(0);
  });
  it.each(['redirect-same','redirect-cross','redirect-host','redirect-http'])('blocks %s without a follow-up request',async route=>{
    const t=make();await expect(t.load(`${origin}/${route}`)).rejects.toMatchObject({code:'REDIRECT'});
    expect(lab.state.events).toHaveLength(1);expect(lab.state.events[0]!.path).toBe(`/${route}`);
    expect(t.stats()).toMatchObject({active:0,started:1});
  });
  it.each([['auth-fail','AUTH'],['forbidden','AUTH'],['missing','NOT_FOUND'],['html','IMAGE'],['encoded','IMAGE'],['truncated','NETWORK'],['disconnect','NETWORK']])('classifies %s and closes owned socket',async(route,code)=>{
    const t=make();await expect(t.load(`${origin}/${route}`)).rejects.toMatchObject({code});expect(t.stats().active).toBe(0);
  });
  it('rejects an oversized Content-Length without reading the body to completion',async()=>{
    const t=make({maxBytes:16384});await expect(t.load(`${origin}/declared-large`)).rejects.toMatchObject({code:'TOO_LARGE'});
    expect(t.stats().receivedBytes).toBe(0);expect(t.stats().active).toBe(0);
  });
  it('destroys a chunked stream once bytes exceed the cap',async()=>{
    const t=make({maxBytes:16384});await expect(t.load(`${origin}/stream-large`)).rejects.toMatchObject({code:'TOO_LARGE'});
    expect(t.stats().receivedBytes).toBeGreaterThan(16384);expect(t.stats().receivedBytes).toBeLessThanOrEqual(32768);
    expect(lab.state.streamChunks).toBeLessThan(10);expect(t.stats().active).toBe(0);
  });
  it('deadline destroys the socket rather than only rejecting the UI promise',async()=>{
    const t=make({timeoutMs:80});await expect(t.load(`${origin}/slow`)).rejects.toMatchObject({code:'TIMEOUT'});
    expect(t.stats().active).toBe(0);expect(t.stats().receivedBytes).toBe(0);
  });
  it('AbortSignal closes an active socket; pre-aborted signal never opens a request',async()=>{
    const t=make();const c=new AbortController();const result=t.load(`${origin}/slow`,{signal:c.signal});
    const failure=expect(result).rejects.toMatchObject({code:'ABORTED'});setTimeout(()=>c.abort(),50);await failure;
    expect(t.stats().active).toBe(0);const started=t.stats().started;
    await expect(t.load(`${origin}/image`,{signal:c.signal})).rejects.toMatchObject({code:'ABORTED'});expect(t.stats().started).toBe(started);
  });
  it('transport disposal aborts owned requests and prevents future loads',async()=>{
    const t=make();const result=t.load(`${origin}/slow`);const failure=expect(result).rejects.toMatchObject({code:'UNLOADED'});
    setTimeout(()=>t.dispose(),30);await failure;expect(t.stats().active).toBe(0);
    await expect(t.load(`${origin}/image`)).rejects.toMatchObject({code:'UNLOADED'});
  });
  it('pool unload cancels the socket and only then frees its physical queue slot',async()=>{
    const t=make();const pool=new ResourcePool(t.load);const lease=pool.acquire('slow',`${origin}/slow`);
    await flush();expect(pool.stats().inFlight).toBe(1);pool.dispose();
    await expect(lease.result).rejects.toMatchObject({code:'UNLOADED'});
    await vi.waitFor(()=>expect(t.stats().active).toBe(0));await flush();expect(pool.stats().inFlight).toBe(0);lease.release();
  });
  it('rejects origin/credential/query changes before reading credentials or opening sockets',async()=>{
    const provider=vi.fn(credentials);const t=make({getCredentials:provider});
    for(const url of ['http://127.0.0.1:19225/image','https://127.0.0.1:19226/image','https://localhost:19225/image',`${origin}/image?q=x`,`${origin}/image#x`,'https://u:p@127.0.0.1:19225/image'])
      await expect(t.load(url)).rejects.toMatchObject({code:'HOST'});
    expect(provider).not.toHaveBeenCalled();expect(t.stats().started).toBe(0);
  });
  it('masks exceptions from the credential provider',async()=>{
    const t=make({getCredentials:()=>{throw new Error('private-value-do-not-print');}});
    await expect(t.load(`${origin}/image`)).rejects.toThrow('AUTH');expect(t.stats().started).toBe(0);
  });
  it('refuses a missing credential or username containing a colon',async()=>{
    for(const getCredentials of [()=>null,()=>({username:'bad:name',password:'test'})]){
      const t=make({getCredentials});await expect(t.load(`${origin}/image`)).rejects.toThrow('AUTH');expect(t.stats().started).toBe(0);
    }
  });
});
