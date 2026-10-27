import {request as httpsRequest} from 'node:https';
import {checkServerIdentity,getCACertificates} from 'node:tls';
import {platform} from 'node:process';
import {Buffer} from 'node:buffer';
import type {ClientRequest,IncomingMessage} from 'node:http';
import type {Socket,LookupFunction} from 'node:net';
import {X509Certificate} from 'node:crypto';
import {validateCertificateTrust,type CertificateTrust} from './certificate-trust';
import {AdapterError} from './errors';
import {checkedImage,type ImageData} from './images';
import {checkedOrigin} from './paths';
import type {Loader,LoadContext} from './transport';

export interface Credentials {username:string;password:string}
export interface DesktopHttpsOptions {
  origin:string;
  getCredentials:()=>Credentials|null;
  maxBytes?:number;
  timeoutMs?:number;
}
export interface DesktopHttpsTransport {
  load:Loader;
  probe(url:string,context?:LoadContext):Promise<ReadOnlyResponse>;
  propfind(url:string,depth:0|1,context?:LoadContext):Promise<ReadOnlyResponse>;
  dispose():void;
  stats():{active:number;started:number;receivedBytes:number;trust:{policy:string;certificates:number|null}};
}
export interface ReadOnlyResponse {status:number;headers:Record<string,string>;bytes:ArrayBuffer}
type RequestSpec={method:'GET'|'PROPFIND';depth?:0|1;headersOnly?:boolean};
type Outcome={response:ReadOnlyResponse}|{error:AdapterError};
const testOrigin='https://127.0.0.1:19225';

function classify(error:unknown):AdapterError {
  const code=(error as {code?:string})?.code ?? '';
  return new AdapterError(/CERT|TLS|SELF_SIGNED|ISSUER|VERIFY_LEAF/.test(code)?'TLS':'NETWORK');
}
function createTransport(options:DesktopHttpsOptions,testCa?:string,explicitTrust?:CertificateTrust):DesktopHttpsTransport {
  const origin=checkedOrigin(options.origin);
  const certificateTrust=explicitTrust?validateCertificateTrust(explicitTrust,origin):undefined;
  if(testCa!==undefined && origin!==testOrigin)throw new AdapterError('HOST');
  let ca:string|string[]|undefined=testCa;
  let trust={policy:testCa!==undefined?'test-loopback-ca':'node-default',certificates:testCa!==undefined?1:null as number|null};
  if(certificateTrust){ca=certificateTrust.certificatePem;trust={policy:'explicit-leaf-endpoint',certificates:1};}
  // Honor the existing Windows trust store per connection; never set global CA defaults or install roots.
  if(!certificateTrust&&testCa===undefined&&platform==='win32'&&typeof getCACertificates==='function'){
    try{ca=[...new Set([...getCACertificates('default'),...getCACertificates('system')])];trust={policy:'windows-and-node',certificates:ca.length};}
    catch{throw new AdapterError('TLS','Windows certificate roots unavailable');}
  }
  const maxBytes=options.maxBytes ?? 20*1024*1024,timeoutMs=options.timeoutMs ?? 20000;
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>20*1024*1024||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60000)
    throw new AdapterError('PATH','Invalid transport limits');
  let disposed=false,started=0,receivedBytes=0;
  const lookup:LookupFunction|undefined=certificateTrust?(hostname,_options,callback)=>{
    if(hostname!==certificateTrust.serverName){callback(new AdapterError('HOST'),'',4);return;}
    callback(null,certificateTrust.address,4);
  }:undefined;
  const active=new Map<ClientRequest,(error:AdapterError)=>void>();
  const read=async (url:string,spec:RequestSpec,context:LoadContext={}):Promise<ReadOnlyResponse>=>{
    if(disposed)throw new AdapterError('UNLOADED');
    if(context.signal?.aborted)throw new AdapterError('ABORTED');
    let target:URL;
    try{target=new URL(url);}catch{throw new AdapterError('HOST');}
    if(target.origin!==origin||target.username||target.password||target.hash||target.search||target.href!==url)throw new AdapterError('HOST');
    // The HTTPS authority and native certificate name agree; only this
    // connection resolves the approved identity to the approved physical IP.
    const tlsTarget=new URL(target.href);
    if(certificateTrust)tlsTarget.hostname=certificateTrust.serverName;
    let authorization:string|undefined;
    if(!spec.headersOnly){
      let credentials:Credentials|null;
      try{credentials=options.getCredentials();}catch{throw new AdapterError('AUTH');}
      if(!credentials||typeof credentials.username!=='string'||typeof credentials.password!=='string'||
        /[:\x00-\x1f\x7f]/.test(credentials.username)||credentials.username.length>1024||credentials.password.length>4096)
        throw new AdapterError('AUTH');
      authorization=`Basic ${Buffer.from(`${credentials.username}:${credentials.password}`,'utf8').toString('base64')}`;
    }
    const limit=spec.method==='PROPFIND'?Math.min(maxBytes,1024*1024):maxBytes;
    const body=spec.method==='PROPFIND'?'<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getetag/><d:getlastmodified/></d:prop></d:propfind>':undefined;
    return new Promise<ReadOnlyResponse>((resolve,reject)=>{
      let request:ClientRequest|undefined,response:IncomingMessage|undefined,socket:Socket|undefined;
      let outcome:Outcome|undefined,done=false,bytes=0;
      let chunks:Buffer[]=[];
      let timer:ReturnType<typeof setTimeout>|undefined;
      const settle=()=>{
        if(done)return;done=true;clearTimeout(timer);context.signal?.removeEventListener('abort',abort);
        if(request)active.delete(request);chunks=[];
        if(outcome&&'response'in outcome)resolve(outcome.response);else reject(outcome&&'error'in outcome?outcome.error:new AdapterError('NETWORK'));
      };
      const stop=(error:AdapterError)=>{
        outcome??={error};chunks=[];
        response?.destroy();request?.destroy();
        if(!request)settle();
      };
      const abort=()=>stop(new AdapterError('ABORTED'));
      try{
        request=httpsRequest(tlsTarget,{
          method:spec.method,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2',
          checkServerIdentity:(name,cert)=>{
            const error=checkServerIdentity(name,cert);if(error)return error;
            if(certificateTrust&&new X509Certificate(cert.raw).fingerprint256.replaceAll(':','')!==certificateTrust.sha256)
              return new AdapterError('TLS','Peer certificate fingerprint changed');
            return undefined;
          },
          ...(certificateTrust?{allowPartialTrustChain:true,lookup,autoSelectFamily:false}:{}),
          maxHeaderSize:16*1024,...(ca!==undefined?{ca}:{}),
          headers:{Host:target.host,...(authorization?{Authorization:authorization}:{}),Accept:spec.method==='PROPFIND'?'application/xml':'image/png, image/jpeg, image/webp',
            'Accept-Encoding':'identity',Connection:'close',...(body?{Depth:String(spec.depth),'Content-Type':'application/xml; charset=utf-8','Content-Length':String(Buffer.byteLength(body))}:{})}
        },incoming=>{
          response=incoming;
          incoming.on('error',error=>stop(classify(error)));
          incoming.on('aborted',()=>stop(new AdapterError('NETWORK')));
          const status=incoming.statusCode ?? 0;
          // Never follow even a same-origin redirect. No second request and no forwarded credentials.
          if(status>=300&&status<400){stop(new AdapterError('REDIRECT'));return;}
          const headers:Record<string,string>={};
          for(const name of ['content-type','content-length','www-authenticate','dav']){const value=incoming.headers[name];if(typeof value==='string')headers[name]=value;}
          if(spec.headersOnly){outcome={response:{status,headers,bytes:new ArrayBuffer(0)}};request!.destroy();return;}
          if(status===401||status===403){stop(new AdapterError('AUTH'));return;}
          if(status===404){stop(new AdapterError('NOT_FOUND'));return;}
          if(status!==(spec.method==='PROPFIND'?207:200)){stop(new AdapterError('HTTP'));return;}
          const encoding=incoming.headers['content-encoding'];
          if(encoding&&encoding!=='identity'){stop(new AdapterError('IMAGE'));return;}
          const length=incoming.headers['content-length'];
          if(length!==undefined&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>limit)){
            stop(new AdapterError('TOO_LARGE'));return;
          }
          incoming.on('data',(chunk:Buffer)=>{
            if(outcome)return;receivedBytes+=chunk.byteLength;bytes+=chunk.byteLength;
            if(bytes>limit){stop(new AdapterError('TOO_LARGE'));return;}
            chunks.push(chunk);
          });
          incoming.on('end',()=>{
            if(outcome)return;
            try{
              const buffer=Buffer.concat(chunks,bytes);chunks=[];
              outcome={response:{status,headers,bytes:Uint8Array.from(buffer).buffer}};
            }catch(error){outcome={error:error instanceof AdapterError?error:new AdapterError('IMAGE')};}
            // Promise/queue slot settles only after the owned socket really closes.
            request!.destroy();
          });
        });
        started++;active.set(request,stop);
        request.on('socket',value=>{socket=value;value.once('close',settle);});
        request.on('close',()=>{if(!socket)settle();});
        request.on('error',error=>stop(classify(error)));
        request.on('upgrade',(_res,upgraded)=>{upgraded.destroy();stop(new AdapterError('HTTP'));});
        timer=setTimeout(()=>stop(new AdapterError('TIMEOUT')),timeoutMs);
        context.signal?.addEventListener('abort',abort,{once:true});
        if(context.signal?.aborted)abort();else request.end(body);
      }catch(error){outcome={error:classify(error)};if(request)request.destroy();else settle();}
    });
  };
  const load:Loader=async(url,context)=>{const value=await read(url,{method:'GET'},context);return checkedImage(value.bytes,value.headers['content-type'] ?? '',maxBytes);};
  return {load,probe:(url,context)=>read(url,{method:'GET',headersOnly:true},context),
    propfind:(url,depth,context)=>{if(depth!==0&&depth!==1)return Promise.reject(new AdapterError('PATH'));return read(url,{method:'PROPFIND',depth},context);},
    dispose:()=>{if(disposed)return;disposed=true;for(const stop of active.values())stop(new AdapterError('UNLOADED'));},
    stats:()=>({active:active.size,started,receivedBytes,trust})};
}

/** Production candidate: no CA override, no TLS bypass and no automatic redirects. Still gated by the plugin. */
export function createDesktopHttpsTransport(options:DesktopHttpsOptions):DesktopHttpsTransport {return createTransport(options);}
/** Explicit public trust anchor; separate opt-in factory, no system trust mutation. */
export function createCertificateHttpsTransport(options:DesktopHttpsOptions,trust:CertificateTrust):DesktopHttpsTransport {
  return createTransport(options,undefined,trust);
}
/** Isolated test CA is accepted ONLY for the fixed loopback origin. Does not modify any global trust store. */
export function createLoopbackHttpsTestTransport(ca:string,options:Omit<DesktopHttpsOptions,'origin'>):DesktopHttpsTransport {
  if(typeof ca!=='string'||ca.length>65536||!ca.includes('-----BEGIN CERTIFICATE-----'))throw new AdapterError('TLS');
  return createTransport({...options,origin:testOrigin},ca);
}
