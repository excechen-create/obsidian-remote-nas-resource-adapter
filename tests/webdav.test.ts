import {describe,it,expect,vi} from 'vitest';
import {parseMultistatus,ReadOnlyWebDav,discoverMapping,type DavEntry} from '../src/webdav';
import type {DesktopHttpsTransport} from '../src/desktop-https';
import {AdapterError} from '../src/errors';
const origin='https://nas.example:5006';
const row=(href:string,collection=false)=>`<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${collection?'<d:collection/>':''}</d:resourcetype><d:getcontentlength>42</d:getcontentlength><d:getcontenttype>image/png</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const xml=(rows:string)=>`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${rows}</d:multistatus>`;
describe('WebDAV XML and resource boundaries',()=>{
  it.each([0,1] as const)('treats denied propstat inside 207 as incomplete access at depth %s',depth=>{
    const denied=row('/Data/',true).replace('200 OK','403 Forbidden');
    expect(()=>parseMultistatus(xml(denied),origin+'/Data/',depth)).toThrow('AUTH');
  });
  it('parses actual DAV namespaced collections and Chinese encoded file names',()=>{
    const entries=parseMultistatus(xml(row('/Data/',true)+row('/Data/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png')),origin+'/Data/',1);
    expect(entries).toHaveLength(2);expect(entries[0]!.isCollection).toBe(true);
    expect(entries[1]).toMatchObject({displayName:'中文 图片.png',size:42,url:origin+'/Data/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png'});
  });
  it.each(['https://other.example/Data/x.png','//evil.example/x.png','/Other/x.png','/Data/x/y.png','/Data/%2e%2e/x.png','/Data/%252e%252e/x.png','/Data/x%2fy.png','/Data/x%5cy.png','/Data/x.png?q=1'])('rejects unsafe or out-of-depth href %s',href=>{
    expect(()=>parseMultistatus(xml(row(href)),origin+'/Data/',1)).toThrow();
  });
  it('rejects DTD/entity input before parsing and rejects non-DAV documents',()=>{
    expect(()=>parseMultistatus('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///C:/secret">]>'+xml(''),origin+'/',1)).toThrow('Unsafe');
    expect(()=>parseMultistatus('<html>login</html>',origin+'/',1)).toThrow('Invalid');
  });
  it('enforces entry limits and Depth 0 exact identity',()=>{
    expect(()=>parseMultistatus(xml(row('/Data/x.png')),origin+'/Data/',0)).toThrow();
    expect(()=>parseMultistatus(xml(row('/Data/x.png').repeat(2001)),origin+'/Data/',1)).toThrow('TOO_LARGE');
  });
  it('uses only Depth 0/1 for stat/list, without invoking image GET',async()=>{
    const propfind=vi.fn(async(_url:string,depth:number)=>({status:207,headers:{},bytes:new TextEncoder().encode(xml(row('/Data/',true)+(depth?row('/Data/x.png'):''))).buffer}));
    const load=vi.fn();const client=new ReadOnlyWebDav({propfind,load} as unknown as DesktopHttpsTransport,origin);
    expect((await client.list(origin+'/Data/')).length).toBe(2);expect(await client.stat(origin+'/Data/')).toMatchObject({isCollection:true});
    expect(propfind.mock.calls.map(call=>call[1])).toEqual([1,0]);expect(load).not.toHaveBeenCalled();
  });
});
const directory=(path:string):DavEntry=>({url:origin+path,path,displayName:path.split('/').filter(Boolean).at(-1) ?? '/',isCollection:true});
describe('bounded mapping discovery from listed roots, not guessed example paths',()=>{
  it('requires all representative files to exist before returning a candidate',async()=>{
    const client={origin,list:vi.fn(async(url?:string)=>url===origin+'/Data/'?[directory('/Data/')]:[directory('/Data/')]),
      stat:vi.fn(async(url:string)=>url.startsWith(origin+'/Data/Researcher/')?{url,path:new URL(url).pathname,isCollection:false}:null)};
    const result=await discoverMapping(client as unknown as ReadOnlyWebDav,'D:/Sync',['Researcher/experiment/EDS/a.jpg','Researcher/experiment/Cu/b.png']);
    expect(result.candidates).toHaveLength(1);expect(result.candidates[0]!.webdavRoot).toBe('/Data');expect(result.candidates[0]!.evidence).toHaveLength(2);
  });
  it('reports ambiguity instead of automatically choosing a root',async()=>{
    const roots=[directory('/Data/'),directory('/home/')];const client={origin,list:vi.fn(async(url?:string)=>url?[]:roots),
      stat:vi.fn(async(url:string)=>({url,path:new URL(url).pathname,isCollection:false}))};
    const result=await discoverMapping(client as unknown as ReadOnlyWebDav,'D:/Sync',['Researcher/a.jpg']);expect(result.candidates).toHaveLength(2);
  });
  it('never exceeds a finite request budget and marks an incomplete search',async()=>{
    const client={origin,list:vi.fn(async()=>[directory('/Data/')]),stat:vi.fn()};
    const result=await discoverMapping(client as unknown as ReadOnlyWebDav,'D:/Sync',['Researcher/a.jpg'],1);
    expect(result.requests).toBe(1);expect(result.complete).toBe(false);expect(client.stat).not.toHaveBeenCalled();
  });
  it('rejects traversal in representative paths',async()=>{
    const client={origin,list:vi.fn()};await expect(discoverMapping(client as unknown as ReadOnlyWebDav,'D:/Sync',['../x.png'])).rejects.toThrow('PATH');
    expect(client.list).not.toHaveBeenCalled();
  });
  it('marks partial access incomplete, preventing automatic unique-root acceptance',async()=>{
    const client={origin,list:vi.fn(async(url?:string)=>{if(url)throw new AdapterError('AUTH');return [directory('/Data/')];}),stat:vi.fn(async(url:string)=>({url,path:new URL(url).pathname,isCollection:false}))};
    const result=await discoverMapping(client as unknown as ReadOnlyWebDav,'D:/Sync',['Researcher/a.jpg']);
    expect(result.candidates).toHaveLength(1);expect(result.complete).toBe(false);expect(result.issues).toHaveLength(1);
  });
  it('stops discovery on cancellation or network failure instead of issuing more requests',async()=>{
    for(const code of ['ABORTED','NETWORK','TIMEOUT'] as const){
      const client={origin,list:vi.fn(async(url?:string)=>{if(url)throw new AdapterError(code);return [directory('/Data/'),directory('/home/')];}),stat:vi.fn()};
      await expect(discoverMapping(client as unknown as ReadOnlyWebDav,'D:/Sync',['Researcher/a.jpg'])).rejects.toMatchObject({code});expect(client.list).toHaveBeenCalledTimes(2);expect(client.stat).not.toHaveBeenCalled();
    }
  });
});
