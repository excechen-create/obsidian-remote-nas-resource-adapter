import {AdapterError} from './errors';
import type {DesktopHttpsTransport} from './desktop-https';
import {checkedOrigin,parseWindowsPath} from './paths';
export interface DavEntry {url:string;path:string;displayName:string;isCollection:boolean;size?:number;contentType?:string}
const dav='DAV:';
function elements(node:Element|Document,name:string):Element[]{return Array.from(node.getElementsByTagNameNS(dav,name));}
function hrefPath(href:string,origin:string,requestUrl:string):{url:URL;parts:string[]} {
  if(href.length>8192||/[\x00-\x1f\x7f]/.test(href))throw new AdapterError('PATH');
  let parsed:URL;try{parsed=new URL(href,requestUrl);}catch{throw new AdapterError('PATH');}
  if(parsed.origin!==origin||parsed.username||parsed.password||parsed.search||parsed.hash)throw new AdapterError('HOST');
  // Inspect raw href before URL can normalize dot segments away.
  let decoded:string;try{decoded=decodeURIComponent(href);}catch{throw new AdapterError('PATH');}
  if(/%[0-9a-f]{2}|[\\\x00-\x1f\x7f]/i.test(decoded)||decoded.split('/').some(p=>p==='..'||p==='.')||/%(?:2f|5c)/i.test(href))throw new AdapterError('PATH');
  let path:string;try{path=decodeURIComponent(parsed.pathname);}catch{throw new AdapterError('PATH');}
  return {url:parsed,parts:path.split('/').filter(Boolean)};
}
export function parseMultistatus(xml:string,requestUrl:string,depth:0|1):DavEntry[] {
  if(xml.length>1024*1024||/<!DOCTYPE|<!ENTITY/i.test(xml))throw new AdapterError('PATH','Unsafe WebDAV XML');
  const origin=new URL(requestUrl).origin;
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.querySelector('parsererror')||doc.documentElement.namespaceURI!==dav||doc.documentElement.localName!=='multistatus')throw new AdapterError('HTTP','Invalid WebDAV response');
  const rows=elements(doc,'response');if(rows.length>2000)throw new AdapterError('TOO_LARGE');
  const parent=decodeURIComponent(new URL(requestUrl).pathname).split('/').filter(Boolean);
  const found=new Map<string,DavEntry>();
  for(const row of rows){
    const href=elements(row,'href')[0]?.textContent;if(!href)throw new AdapterError('PATH');
    const parsed=hrefPath(href,origin,requestUrl);
    if(parsed.parts.length<parent.length||parsed.parts.length>parent.length+depth||!parent.every((part,i)=>part===parsed.parts[i]))throw new AdapterError('PATH','Response escapes requested directory/depth');
    const success=elements(row,'propstat').filter(stat=>/\s200(?:\s|$)/.test(elements(stat,'status')[0]?.textContent ?? ''));
    if(!success.length){
      // A 207 can contain a denied resource/property status. Treat that as
      // incomplete access, never as evidence that a competing root is absent.
      const statuses=elements(row,'status').map(status=>status.textContent ?? '');
      if(statuses.some(status=>/\s(?:401|403)(?:\s|$)/.test(status)))throw new AdapterError('AUTH');
      continue;
    }
    const props=success.flatMap(stat=>elements(stat,'prop'));
    const collection=props.some(prop=>elements(prop,'collection').length>0);
    const path=`/${parsed.parts.map(encodeURIComponent).join('/')}${collection&&parsed.parts.length?'/':''}`;
    const url=origin+path;
    const sizeText=props.flatMap(prop=>elements(prop,'getcontentlength'))[0]?.textContent ?? '';
    const size=/^\d+$/.test(sizeText)&&Number.isSafeInteger(Number(sizeText))?Number(sizeText):undefined;
    const contentType=props.flatMap(prop=>elements(prop,'getcontenttype'))[0]?.textContent ?? undefined;
    const entry={url,path,displayName:parsed.parts.at(-1) ?? '/',isCollection:collection,size,contentType};
    if(found.has(url)&&found.get(url)!.isCollection!==collection)throw new AdapterError('PATH');
    found.set(url,entry);
  }
  return [...found.values()];
}
export class ReadOnlyWebDav {
  readonly origin:string;
  constructor(private transport:DesktopHttpsTransport,origin:string){this.origin=checkedOrigin(origin);}
  async list(url=this.origin+'/'):Promise<DavEntry[]> {
    const response=await this.transport.propfind(url,1);
    return parseMultistatus(new TextDecoder('utf-8',{fatal:true}).decode(response.bytes),url,1);
  }
  async stat(url:string):Promise<DavEntry|null> {
    try{const response=await this.transport.propfind(url,0);return parseMultistatus(new TextDecoder('utf-8',{fatal:true}).decode(response.bytes),url,0)[0] ?? null;}
    catch(error){if(error instanceof AdapterError&&error.code==='NOT_FOUND')return null;throw error;}
  }
}
export interface MappingCandidate {windowsRoot:string;webdavRoot:string;evidence:string[]}
export interface DiscoveryResult {requests:number;candidates:MappingCandidate[];complete:boolean;issues:string[]}
/** Bounded metadata search. Candidates come from actual listed shares/Drive folders; never assume a root. */
export async function discoverMapping(client:ReadOnlyWebDav,windowsRoot:string,relativeFiles:readonly string[],budget=16):Promise<DiscoveryResult> {
  parseWindowsPath(windowsRoot);
  if(!relativeFiles.length||relativeFiles.length>4||!Number.isInteger(budget)||budget<1||budget>32)throw new AdapterError('PATH');
  const suffixes=relativeFiles.map(file=>{
    if(/^[\\/]|[\x00-\x1f\x7f]/.test(file))throw new AdapterError('PATH');
    const parts=file.split(/[\\/]+/);if(parts.some(part=>!part||part==='.'||part==='..'||/%[0-9a-f]{2}|[?#]/i.test(part)))throw new AdapterError('PATH');
    return parts.map(encodeURIComponent).join('/');
  });
  const result:DiscoveryResult={requests:0,candidates:[],complete:true,issues:[]};
  const request=async<T>(work:()=>Promise<T>):Promise<T>=>{if(result.requests>=budget){result.complete=false;throw new AdapterError('BUSY','Discovery request budget reached');}result.requests++;return work();};
  const roots=(await request(()=>client.list())).filter(entry=>entry.isCollection&&entry.url!==client.origin+'/');
  const candidates=new Map(roots.map(root=>[root.url,root]));
  for(const root of roots){
    try{for(const entry of await request(()=>client.list(root.url)))if(entry.isCollection&&/^(?:Drive|SynologyDrive)$/i.test(entry.displayName))candidates.set(entry.url,entry);}
    catch(error){
      if(error instanceof AdapterError&&error.code==='BUSY')break;
      if(!(error instanceof AdapterError)||['UNLOADED','ABORTED','TIMEOUT','NETWORK','TLS','HTTP'].includes(error.code))throw error;
      result.complete=false;result.issues.push('A listed share could not be inspected');
    }
  }
  for(const root of candidates.values()){
    const evidence:string[]=[];
    try{
      for(const suffix of suffixes){const entry=await request(()=>client.stat(`${root.url.replace(/\/$/,'')}/${suffix}`));if(!entry||entry.isCollection)break;evidence.push(entry.path);}
      if(evidence.length===suffixes.length)result.candidates.push({windowsRoot,webdavRoot:decodeURIComponent(root.path).replace(/\/$/,''),evidence});
    }catch(error){
      if(error instanceof AdapterError&&error.code==='BUSY')break;
      if(!(error instanceof AdapterError)||['UNLOADED','ABORTED','TIMEOUT','NETWORK','TLS','HTTP'].includes(error.code))throw error;
      result.complete=false;result.issues.push('A candidate could not be verified');
    }
  }
  return result;
}
