import {createServer} from 'node:https';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function startTlsLab(){
  const tlsDir=path.join(root,'runtime/tls');
  const ca=await readFile(path.join(tlsDir,'test-ca-cert.pem'),'utf8');
  const credentials=async name=>({key:await readFile(path.join(tlsDir,`${name}-key.pem`)),cert:await readFile(path.join(tlsDir,`${name}-cert.pem`))});
  const valid=await credentials('valid-localhost');
  const png=await readFile(path.join(root,'fixtures/synthetic.png'));
  const media=new Map();
  for(const [name,mime] of [['synthetic.jpg','image/jpeg'],['synthetic.webp','image/webp'],['large.png','image/png']]){
    try{media.set('/media/'+name,{bytes:await readFile(path.join(root,'fixtures',name)),mime});}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const sockets=new Set(),timers=new Set();
  const state={events:[],streamChunks:0,imageDelay:0};
  const auth=`Basic ${Buffer.from('poc-user:poc-password').toString('base64')}`;
  function handler(server){return(req,res)=>{
    let decodedPath;try{decodedPath=decodeURIComponent(new URL(req.url,'https://127.0.0.1').pathname);}catch{decodedPath='';}
    const event={server,path:req.url,host:req.headers.host,method:req.method,authorizationPresent:!!req.headers.authorization,closed:false,finished:false};state.events.push(event);
    res.on('close',()=>{event.closed=true;event.finished=res.writableFinished;});
    if(req.method==='PROPFIND'&&['/','/dav/','/dav/中文 图片.png','/dav/second.png'].includes(decodedPath)){
      if(req.headers.authorization!==auth){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Local PoC"'});res.end();return;}
      event.depth=req.headers.depth;let bodyBytes=0;
      req.on('data',chunk=>{bodyBytes+=chunk.length;});
      req.on('end',()=>{
        event.requestBodyBytes=bodyBytes;
        const response=(href,collection)=>`<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${collection?'<d:collection/>':''}</d:resourcetype><d:getcontenttype>${collection?'httpd/unix-directory':'image/png'}</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
        let content='';
        if(decodedPath==='/')content=response('/',true)+(req.headers.depth==='1'?response('/dav/',true):'');
        else if(decodedPath==='/dav/')content=response('/dav/',true)+(req.headers.depth==='1'?response('/dav/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png',false)+response('/dav/second.png',false):'');
        else content=response(decodedPath.split('/').map(encodeURIComponent).join('/'),false);
        const xml=`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${content}</d:multistatus>`;
        res.writeHead(207,{'Content-Type':'application/xml; charset=utf-8'});res.end(xml);
      });return;
    }
    if(req.url==='/'){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Local PoC"'});res.end();return;}
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    if(media.has(decodedPath)&&req.headers.authorization===auth){const value=media.get(decodedPath);res.writeHead(200,{'Content-Type':value.mime});res.end(value.bytes);return;}
    if(req.url==='/redirect-same'){res.writeHead(302,{Location:'/image'});res.end();return;}
    if(req.url==='/redirect-cross'){res.writeHead(302,{Location:'https://127.0.0.1:19226/image'});res.end();return;}
    if(req.url==='/redirect-host'){res.writeHead(302,{Location:'https://localhost:19226/image'});res.end();return;}
    if(req.url==='/redirect-http'){res.writeHead(302,{Location:'http://127.0.0.1:19226/image'});res.end();return;}
    if(req.url==='/auth-fail'){res.writeHead(401);res.end();return;}
    if(req.url==='/forbidden'){res.writeHead(403);res.end();return;}
    if(req.url==='/missing'){res.writeHead(404);res.end();return;}
    if(req.url==='/declared-large'){res.writeHead(200,{'Content-Type':'image/png','Content-Length':8*1024*1024});res.write(png);return;}
    if(req.url==='/stream-large'){
      res.writeHead(200,{'Content-Type':'image/png'});
      const interval=setInterval(()=>{state.streamChunks++;res.write(Buffer.alloc(8192,0));},10);timers.add(interval);
      res.once('close',()=>{clearInterval(interval);timers.delete(interval);});return;
    }
    if(req.url==='/slow'){
      const timer=setTimeout(()=>{timers.delete(timer);res.writeHead(200,{'Content-Type':'image/png'});res.end(png);},1500);timers.add(timer);
      res.once('close',()=>{clearTimeout(timer);timers.delete(timer);});return;
    }
    if(req.url==='/truncated'){res.writeHead(200,{'Content-Type':'image/png','Content-Length':png.length+100});res.end(png);return;}
    if(req.url==='/html'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<html>synthetic login</html>');return;}
    if(req.url==='/encoded'){res.writeHead(200,{'Content-Type':'image/png','Content-Encoding':'gzip'});res.end(png);return;}
    if(req.url==='/disconnect'){req.socket.destroy();return;}
    if((req.url==='/image'||['/dav/中文 图片.png','/dav/second.png'].includes(decodedPath))&&req.headers.authorization===auth){
      const send=()=>{res.writeHead(200,{'Content-Type':'image/png'});res.end(png);};
      if(state.imageDelay){const timer=setTimeout(()=>{timers.delete(timer);send();},state.imageDelay);timers.add(timer);res.once('close',()=>{clearTimeout(timer);timers.delete(timer);});}
      else send();return;
    }
    res.writeHead(403);res.end();
  };}
  const a=createServer(valid,handler('A')),b=createServer(valid,handler('B'));
  for(const server of [a,b]){
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
    server.on('tlsClientError',()=>{});
  }
  const listen=(server,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  try{await Promise.all([listen(a,19225),listen(b,19226)]);}catch(error){for(const s of sockets)s.destroy();a.close();b.close();throw error;}
  return {ca,state,pngBytes:png.length,
    async certificate(name){if(!['valid-localhost','wrong-host','expired'].includes(name))throw new Error('Unknown test cert');a.setSecureContext(await credentials(name));},
    reset(){state.events.length=0;state.streamChunks=0;},
    stats(){return {events:state.events,streamChunks:state.streamChunks,activeSockets:sockets.size};},
    async close(){for(const timer of timers)clearTimeout(timer);for(const socket of sockets)socket.destroy();await Promise.all([a,b].map(server=>new Promise(resolve=>server.close(resolve))));}
  };
}
