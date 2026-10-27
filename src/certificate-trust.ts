import {X509Certificate} from 'node:crypto';
import {isIP} from 'node:net';
import {AdapterError} from './errors';
import {checkedOrigin} from './paths';
/** An explicit public leaf anchor bound to one physical endpoint and TLS identity. */
export interface CertificateTrust {
  address:string;port:number;serverName:string;sha256:string;certificatePem:string;
}
export function validateCertificateTrust(value:unknown,endpoint:string):CertificateTrust {
  if(!value||typeof value!=='object')throw new AdapterError('TLS','Invalid certificate trust');
  const input=value as Record<string,unknown>,origin=new URL(checkedOrigin(endpoint));
  if(typeof input.address!=='string'||isIP(input.address)!==4||origin.hostname!==input.address||
    !Number.isInteger(input.port)||input.port!==Number(origin.port||443))throw new AdapterError('HOST','Certificate trust endpoint mismatch');
  if(typeof input.serverName!=='string'||isIP(input.serverName)!==0||input.serverName.length>253||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(input.serverName)||input.serverName.split('.').some(part=>!part||part.length>63||part.startsWith('-')||part.endsWith('-')))
    throw new AdapterError('TLS','Invalid certificate identity');
  if(typeof input.sha256!=='string'||!/^[A-Fa-f0-9]{64}$/.test(input.sha256)||typeof input.certificatePem!=='string'||input.certificatePem.length>65536)
    throw new AdapterError('TLS','Invalid certificate fingerprint');
  const pem=input.certificatePem.trim();
  if(!/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----$/.test(pem))
    throw new AdapterError('TLS','Only one public certificate is accepted');
  let cert:X509Certificate;
  try{cert=new X509Certificate(pem);}catch{throw new AdapterError('TLS','Invalid public certificate');}
  const sha256=input.sha256.toUpperCase(),serverName=input.serverName.toLowerCase();
  if(cert.fingerprint256.replaceAll(':','')!==sha256||cert.ca||!cert.checkHost(serverName,{subject:'never'}))
    throw new AdapterError('TLS','Certificate does not match approved fingerprint or identity');
  return {address:input.address,port:input.port as number,serverName,sha256,certificatePem:pem};
}
