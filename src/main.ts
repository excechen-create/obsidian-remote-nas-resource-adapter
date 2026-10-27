import { Plugin, MarkdownView, MarkdownRenderChild, Notice, Platform, apiVersion, SecretComponent, requestUrl } from 'obsidian';
import { DomAdapter } from './dom-adapter';
import { ResourcePool } from './resources';
import { resolveResource,parseWindowsPath } from './paths';
import { fixtureMappings, fixtureOrigin, syntheticLoader } from './fixtures';
import { createTestHttpLoader } from './transport';
import type { Loader } from './transport';
import {createDesktopHttpsTransport,createCertificateHttpsTransport,createLoopbackHttpsTestTransport,type DesktopHttpsTransport} from './desktop-https';
import {AdapterError,errorCode} from './errors';
import {versions} from 'node:process';
import {SessionCredentials} from './session-credentials';
import {nasDefaults,validateNasSettings,serializeNasSettings,type NasSettings} from './nas-settings';
import {NasSettingsTab,type ConnectionInfo} from './nas-settings-tab';
import {ReadOnlyWebDav,discoverMapping,type DavEntry,type DiscoveryResult} from './webdav';
export default class NasPocPlugin extends Plugin {
  private adapter?: DomAdapter;
  private pool?: ResourcePool;
  private viewRoots=new Set<Element>();
  private delayMs=120;
  private enabled=false;
  private loopbackTest=false;
  private secureLoopbackCa?:string;
  private desktopTransport?:DesktopHttpsTransport;
  private probes=new Set<DesktopHttpsTransport>();
  private sessionCredentials=new SessionCredentials();
  private nasSession=new SessionCredentials();
  private nasSettings=nasDefaults();
  private nasMode=false;
  private verifiedNasEndpoint?:string;
  private nasFixtureCa?:string;
  private alive=false;
  private transition=0;
  async onload(): Promise<void> {
    this.alive=true;
    this.register(()=>{this.alive=false;this.transition++;this.stop(true);});
    try{const stored=await this.loadData();if(stored)this.nasSettings=validateNasSettings(stored);}
    catch{new Notice('NAS 设置无效，已使用安全默认值；原配置未被自动覆盖。');}
    if(!this.alive)return;
    this.start();
    this.addSettingTab(new NasSettingsTab(this.app,this));
    this.registerMarkdownPostProcessor((element,context)=>{
      const child=new MarkdownRenderChild(element);context.addChild(child);
      child.register(()=>this.adapter?.sweep());
      queueMicrotask(()=>{if(this.enabled){this.attachViews();this.adapter?.scan(element);}});
    });
    this.registerEvent(this.app.workspace.on('layout-change',()=>this.attachViews()));
    this.registerEvent(this.app.workspace.on('file-open',()=>this.attachViews()));
    this.app.workspace.onLayoutReady(()=>{if(this.enabled)this.attachViews();});
    this.addCommand({id:'restart-synthetic-resources',name:'重新加载当前模式图片',callback:()=>this.restart()});
    this.addCommand({id:'show-local-diagnostics',name:'显示本地诊断',callback:()=>new Notice(JSON.stringify(this.diagnostics()))});
  }
  private start(): void {
    this.enabled=true;
    this.sessionCredentials.set({username:'poc-user',password:'poc-password'});
    this.desktopTransport=undefined;
    if(this.nasMode){
      const settings=validateNasSettings(this.nasSettings,true);
      this.desktopTransport=this.createNasTransport();
      this.pool=new ResourcePool(this.desktopTransport.load);
      this.adapter=new DomAdapter(document,this.pool,source=>resolveResource(source,settings.endpoint,settings.mappings,Platform.resourcePathPrefix));
      return;
    }
    const localHttp=createTestHttpLoader(requestUrl,'http://127.0.0.1:19223',()=>`Basic ${btoa('poc-user:poc-password')}`,1024*1024);
    if(this.secureLoopbackCa)this.desktopTransport=createLoopbackHttpsTestTransport(this.secureLoopbackCa,{
      getCredentials:()=>this.sessionCredentials.get(),maxBytes:1024*1024,timeoutMs:2000
    });
    const loader: Loader=this.secureLoopbackCa?async(url,context)=>{
      fixtureName(url);return this.desktopTransport!.load('https://127.0.0.1:19225/image',context);
    }:this.loopbackTest?async url=>{
      const resource=new URL(url);
      const name=decodeURIComponent(resource.pathname.slice('/fixtures/'.length));
      if(resource.origin!==fixtureOrigin || !resource.pathname.startsWith('/fixtures/') || !['中文 图片.png','second.png'].includes(name))throw new Error('NAS_DISABLED');
      return localHttp(`http://127.0.0.1:19223/image?fixture=${encodeURIComponent(name)}`);
    }:syntheticLoader(()=>this.delayMs);
    this.pool=new ResourcePool(loader);
    this.adapter=new DomAdapter(document,this.pool,source=>resolveResource(source,fixtureOrigin,fixtureMappings,Platform.resourcePathPrefix));
  }
  private attachViews(): void {
    if(!this.enabled || !this.adapter)return;
    const roots=new Set<Element>();
    for(const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      if(leaf.view instanceof MarkdownView){roots.add(leaf.view.containerEl);this.adapter.attach(leaf.view.containerEl);}
    }
    for(const root of this.viewRoots)if(!roots.has(root))this.adapter.detach(root);
    this.viewRoots=roots;this.adapter.refresh();
  }
  private stop(clearNasCredentials=false): void {
    this.enabled=false;this.adapter?.dispose();this.pool?.dispose();this.desktopTransport?.dispose();
    for(const probe of this.probes)probe.dispose();this.probes.clear();this.sessionCredentials.clear();this.viewRoots.clear();
    if(clearNasCredentials)this.nasSession.clear();
  }
  restart(delayMs = this.delayMs): void {
    if(!this.alive)return;
    if(this.pool && (this.pool.stats().inFlight || this.pool.stats().queued)) {
      new Notice('底层请求尚未结束，请稍后重新加载。');return;
    }
    this.transition++;this.stop();this.delayMs=Math.max(0,Math.min(delayMs,10000));this.start();this.attachViews();
  }
  diagnostics(): object {
    return {mode:this.nasMode?'nas-read-only':this.secureLoopbackCa?'https-loopback-test-only':this.loopbackTest?'loopback-test-only':'synthetic-only',nasEnabled:this.nasMode&&this.enabled,apiVersion,resourcePrefix:Platform.resourcePathPrefix,
      nas:{endpoint:this.nasSettings.endpoint,tlsVerified:this.nasTlsVerified(),mappings:this.nasSettings.mappings.length,credentialSource:this.nasSettings.credentialSource,
        certificateTrust:this.nasSettings.certificateTrust?{serverName:this.nasSettings.certificateTrust.serverName,sha256:this.nasSettings.certificateTrust.sha256}:null},
      runtime:{node:versions.node,electron:versions.electron},desktopTransport:this.desktopTransport?.stats(),
      credentialApi:{storage:typeof this.app.secretStorage?.getSecret==='function',component:typeof SecretComponent==='function'},
      enabled:this.enabled,dom:this.adapter?.stats(),resources:this.pool?.stats()};
  }
  getNasSettings():NasSettings{return serializeNasSettings(this.nasSettings);}
  async updateNasSettings(value:NasSettings):Promise<void>{
    if(!this.alive)throw new AdapterError('UNLOADED');
    const next=validateNasSettings(value);
    const credentialsChanged=next.endpoint!==this.nasSettings.endpoint||next.username!==this.nasSettings.username||next.credentialSource!==this.nasSettings.credentialSource||next.passwordSecretId!==this.nasSettings.passwordSecretId||JSON.stringify(next.certificateTrust)!==JSON.stringify(this.nasSettings.certificateTrust);
    if(this.nasMode)await this.replaceResources(false);
    if(!this.alive)throw new AdapterError('UNLOADED');
    if(credentialsChanged){this.nasSession.clear();this.verifiedNasEndpoint=undefined;}
    if(next.endpoint!==this.nasSettings.endpoint)this.nasFixtureCa=undefined;
    this.nasSettings=next;await this.saveData(serializeNasSettings(next));
  }
  private nasConnectionKey():string{return JSON.stringify({endpoint:this.nasSettings.endpoint,certificateTrust:this.nasSettings.certificateTrust});}
  nasTlsVerified():boolean{return this.verifiedNasEndpoint===this.nasConnectionKey();}
  setNasSessionPassword(password:string):void{
    if(!this.alive)throw new AdapterError('UNLOADED');
    if(!this.nasTlsVerified())throw new AdapterError('TLS','必须先通过当前地址的 HTTPS 校验');
    this.nasSession.set({username:this.nasSettings.username,password});
  }
  private nasCredentials(){
    if(!this.alive)return null;
    if(this.nasSettings.credentialSource==='session')return this.nasSession.get();
    const id=this.nasSettings.passwordSecretId;
    if(!id||typeof this.app.secretStorage?.getSecret!=='function')return null;
    const password=this.app.secretStorage.getSecret(id);
    return password===null?null:{username:this.nasSettings.username,password};
  }
  private createNasTransport(anonymous=false):DesktopHttpsTransport{
    const options={getCredentials:()=>anonymous?null:this.nasCredentials()};
    return this.nasFixtureCa&&this.nasSettings.endpoint==='https://127.0.0.1:19225'
      ?createLoopbackHttpsTestTransport(this.nasFixtureCa,options)
      :this.nasSettings.certificateTrust
        ?createCertificateHttpsTransport({...options,origin:this.nasSettings.endpoint},this.nasSettings.certificateTrust)
        :createDesktopHttpsTransport({...options,origin:this.nasSettings.endpoint});
  }
  async probeNas():Promise<ConnectionInfo>{
    if(!this.alive)return {tlsVerified:false,code:'UNLOADED',message:'插件已停用'};
    const connectionKey=this.nasConnectionKey(),endpoint=this.nasSettings.endpoint,transport=this.createNasTransport(true);this.probes.add(transport);
    try{
      const response=await transport.probe(endpoint+'/');
      if(this.alive&&this.nasConnectionKey()===connectionKey)this.verifiedNasEndpoint=connectionKey;
      return {tlsVerified:true,status:response.status,basicAuthOffered:/\bBasic\b/i.test(response.headers['www-authenticate'] ?? ''),message:`HTTPS 校验通过；服务状态 ${response.status}。未发送凭据或读取响应体。`};
    }catch(error){
      if(this.nasConnectionKey()===connectionKey)this.verifiedNasEndpoint=undefined;
      const code=errorCode(error);
      return {tlsVerified:false,code,message:code==='TLS'?'TLS 校验失败：证书链、名称、有效期或指定指纹不符合信任设置。未发送凭据，请核对当前地址与已批准证书。':`连接失败：${code}。未忽略证书校验。`};
    }finally{transport.dispose();this.probes.delete(transport);}
  }
  private requireNasReady():void{
    if(!this.alive)throw new AdapterError('UNLOADED');
    if(!this.nasTlsVerified())throw new AdapterError('TLS','请先验证 HTTPS，证书错误不能忽略');
    if(!this.nasCredentials())throw new AdapterError('AUTH','请在应用内输入本次凭据或明确选择官方秘密');
  }
  async listNasRoot():Promise<DavEntry[]>{
    this.requireNasReady();const transport=this.createNasTransport();this.probes.add(transport);
    try{return await new ReadOnlyWebDav(transport,this.nasSettings.endpoint).list();}
    finally{transport.dispose();this.probes.delete(transport);}
  }
  async discoverNasMapping(index:number):Promise<DiscoveryResult>{
    this.requireNasReady();const mapping=this.nasSettings.mappings[index];if(!mapping)throw new AdapterError('PATH');
    const root=parseWindowsPath(mapping.windowsRoot);
    const samples=this.nasSettings.samplePaths.map(source=>parseWindowsPath(source)).filter(path=>path.drive===root.drive&&path.parts.length>root.parts.length&&root.parts.every((part,i)=>part.toLowerCase()===path.parts[i]?.toLowerCase())).map(path=>path.parts.slice(root.parts.length).join('/'));
    if(!samples.length)throw new AdapterError('UNMAPPED','请提供至少一个属于该 Windows 根目录的样本引用');
    const transport=this.createNasTransport();this.probes.add(transport);
    try{return await discoverMapping(new ReadOnlyWebDav(transport,this.nasSettings.endpoint),mapping.windowsRoot,samples);}
    finally{transport.dispose();this.probes.delete(transport);}
  }
  async enableNasImages():Promise<void>{this.requireNasReady();validateNasSettings(this.nasSettings,true);await this.replaceResources(true);}
  async disableNasImages(clearCredentials=false):Promise<void>{if(clearCredentials)this.nasSession.clear();if(!this.alive)return;await this.replaceResources(false);}
  private async replaceResources(nas:boolean):Promise<void>{
    const generation=++this.transition,old=this.pool;this.stop();
    const end=Date.now()+11000;
    while(old&&(old.stats().inFlight||old.stats().queued)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,25));
    if(!this.alive||generation!==this.transition)throw new AdapterError('UNLOADED');
    if(old&&(old.stats().inFlight||old.stats().queued))throw new AdapterError('BUSY','等待旧请求结束后再切换模式');
    this.nasMode=nas;this.start();this.attachViews();
  }
  /** Lab only: the transport itself refuses a test CA outside the fixed loopback origin. */
  setNasFixtureCa(ca:string|null):void{
    if(this.nasSettings.endpoint!=='https://127.0.0.1:19225')throw new AdapterError('HOST');
    if(ca!==null){const test=createLoopbackHttpsTestTransport(ca,{getCredentials:()=>null});test.dispose();}
    this.nasFixtureCa=ca ?? undefined;this.verifiedNasEndpoint=undefined;
  }
  /** Test-runner only: fixed loopback fixture service, never a configurable NAS endpoint. */
  setLoopbackTestTransport(enabled: boolean): void {
    if(this.pool && (this.pool.stats().inFlight || this.pool.stats().queued))throw new Error('LOCAL_TEST_BUSY');
    this.secureLoopbackCa=undefined;this.loopbackTest=enabled;this.restart();
  }
  setSecureLoopbackTestTransport(ca:string|null):void {
    if(this.pool && (this.pool.stats().inFlight || this.pool.stats().queued))throw new Error('LOCAL_TEST_BUSY');
    if(ca!==null&&(!ca.includes('-----BEGIN CERTIFICATE-----')||ca.length>65536))throw new Error('TLS');
    this.secureLoopbackCa=ca ?? undefined;this.loopbackTest=false;this.restart();
  }
  async probeSecureLoopback(ca:string|null,routes:string[],options:{timeoutMs?:number;maxBytes?:number;cancelAfterMs?:number}={}):Promise<object> {
    const allowed=new Set(['image','auth-fail','forbidden','missing','redirect-same','redirect-cross','redirect-host','redirect-http',
      'declared-large','stream-large','slow','truncated','html','encoded','disconnect']);
    if(routes.length>20||routes.some(route=>!allowed.has(route)))throw new Error('Invalid local test route');
    const config={getCredentials:()=>this.sessionCredentials.get(),timeoutMs:options.timeoutMs ?? 1000,maxBytes:options.maxBytes ?? 1024*1024};
    const transport=ca===null?createDesktopHttpsTransport({...config,origin:'https://127.0.0.1:19225'}):createLoopbackHttpsTestTransport(ca,config);
    this.probes.add(transport);
    const result:Record<string,object>={};
    try{
      for(const route of routes){
        const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
        if(options.cancelAfterMs===0)controller.abort();
        else if(options.cancelAfterMs!==undefined)timer=setTimeout(()=>controller.abort(),options.cancelAfterMs);
        try{const image=await transport.load(`https://127.0.0.1:19225/${route}`,{signal:controller.signal});result[route]={code:'OK',bytes:image.bytes.byteLength,mime:image.mime,transport:transport.stats()};}
        catch(error){result[route]={code:errorCode(error),transport:transport.stats()};}
        finally{clearTimeout(timer);}
      }
      return result;
    }finally{transport.dispose();this.probes.delete(transport);}
  }
  /** Local self-test entry: fixed loopback endpoints, synthetic authorization only, no stored secret access. */
  async probeLoopback(port: number): Promise<object> {
    if(port!==19223)throw new Error('Unsupported local test port');
    const loader=createTestHttpLoader(requestUrl,`http://127.0.0.1:${port}`,()=>`Basic ${btoa('poc-user:poc-password')}`,1024*1024);
    const result: Record<string,string>={};
    for(const name of ['image','auth-fail','missing','same-origin-redirect','cross-origin-redirect']) {
      try{const image=await loader(`http://127.0.0.1:${port}/${name}`);result[name]=`${image.mime}:${image.bytes.byteLength}`;}
      catch(error){result[name]=error instanceof Error?error.message:'ERROR';}
    }
    return result;
  }
}
function fixtureName(url:string):string {
  const resource=new URL(url);const name=decodeURIComponent(resource.pathname.slice('/fixtures/'.length));
  if(resource.origin!==fixtureOrigin||!resource.pathname.startsWith('/fixtures/')||!['中文 图片.png','second.png'].includes(name))throw new Error('NAS_DISABLED');
  return name;
}
