import { describe, expect, it, vi } from 'vitest';
import { createTestHttpLoader, realNasLoader } from '../src/transport';
import { checkedImage } from '../src/images';
const png=()=>new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]).buffer;
describe('read-only injected HTTP transport (simulation)',()=>{
  it('passes GET/auth as a header and receives binary, without URL credentials',async()=>{
    const request=vi.fn(async()=>({status:200,headers:{'Content-Type':'image/png'},arrayBuffer:png()}));
    const load=createTestHttpLoader(request,'http://127.0.0.1:19223',()=> 'Basic synthetic-only',1024);
    expect((await load('http://127.0.0.1:19223/image')).mime).toBe('image/png');
    expect(request).toHaveBeenCalledWith({url:'http://127.0.0.1:19223/image',method:'GET',headers:{Authorization:'Basic synthetic-only'},throw:false});
  });
  it.each([[401,'AUTH'],[403,'AUTH'],[404,'NOT_FOUND'],[302,'HTTP'],[500,'HTTP']])('classifies %s',async(status,code)=>{
    const load=createTestHttpLoader(async()=>({status:status as number,headers:{},arrayBuffer:png()}),'http://127.0.0.1:19223',()=>null,1024);
    await expect(load('http://127.0.0.1:19223/a')).rejects.toMatchObject({code});
  });
  it('blocks host, port and credential substitution before request',async()=>{
    const request=vi.fn();const load=createTestHttpLoader(request,'http://127.0.0.1:19223',()=>null,1024);
    for(const url of ['https://nas.example/a','http://localhost:19223/a','http://127.0.0.1:19224/a','http://user:pass@127.0.0.1:19223/a'])
      await expect(load(url)).rejects.toMatchObject({code:'HOST'});
    expect(request).not.toHaveBeenCalled();
  });
  it('masks raw network exceptions which could contain credentials',async()=>{
    const load=createTestHttpLoader(async()=>{throw new Error('Authorization: secret');},'http://127.0.0.1',()=>null,1024);
    await expect(load('http://127.0.0.1/a')).rejects.toThrow('NETWORK');
  });
  it('real NAS codepath is fail closed, regardless of a URL',async()=>{
    await expect(realNasLoader('https://nas.example/a')).rejects.toMatchObject({code:'NAS_DISABLED'});
  });
  it('checks supported signatures, declared MIME and byte limits',()=>{
    expect(checkedImage(png(),'image/png',12).mime).toBe('image/png');
    expect(checkedImage(new Uint8Array([255,216,255,0]).buffer,'image/jpeg',100).mime).toBe('image/jpeg');
    expect(checkedImage(new TextEncoder().encode('RIFF0000WEBP0000').buffer,'image/webp',100).mime).toBe('image/webp');
    expect(()=>checkedImage(new TextEncoder().encode('<html>login</html>').buffer,'image/png',100)).toThrow('IMAGE');
    expect(()=>checkedImage(png(),'image/jpeg',100)).toThrow('IMAGE');
    expect(()=>checkedImage(png(),'image/png',11)).toThrow('TOO_LARGE');
  });
});
