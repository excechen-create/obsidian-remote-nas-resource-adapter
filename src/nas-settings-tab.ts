import {App,Modal,Notice,PluginSettingTab,SecretComponent,Setting,type Plugin} from 'obsidian';
import {AdapterError,errorCode} from './errors';
import type {NasSettings} from './nas-settings';
import type {DavEntry,DiscoveryResult} from './webdav';
export interface ConnectionInfo {tlsVerified:boolean;status?:number;basicAuthOffered?:boolean;message:string;code?:string}
export interface NasPluginApi {
  getNasSettings():NasSettings;
  updateNasSettings(value:NasSettings):Promise<void>;
  probeNas():Promise<ConnectionInfo>;
  nasTlsVerified():boolean;
  setNasSessionPassword(password:string):void;
  listNasRoot():Promise<DavEntry[]>;
  discoverNasMapping(index:number):Promise<DiscoveryResult>;
  enableNasImages():Promise<void>;
  disableNasImages(clearCredentials?:boolean):Promise<void>;
}
function message(error:unknown):string {return error instanceof AdapterError?`${error.code}：${error.message}`:`操作失败：${errorCode(error)}`;}
class SessionPasswordModal extends Modal {
  constructor(app:App,private api:NasPluginApi,private done:()=>void){super(app);}
  onOpen():void {
    this.titleEl.setText('输入本次会话密码');
    const settings=this.api.getNasSettings();this.contentEl.createEl('p',{text:`${settings.username} · ${settings.endpoint}。仅保存在本次插件会话内，停用后清空。`});
    let input:HTMLInputElement;
    new Setting(this.contentEl).setName('密码').addText(text=>{input=text.inputEl;input.type='password';input.autocomplete='off';input.spellcheck=false;});
    new Setting(this.contentEl).addButton(button=>button.setButtonText('保存到本次会话').setCta().onClick(()=>{
      try{this.api.setNasSessionPassword(input!.value);input!.value='';this.close();this.done();}
      catch(error){new Notice(message(error));}
    }));
  }
  onClose():void {for(const input of this.contentEl.querySelectorAll('input'))input.value='';this.contentEl.empty();}
}
export class NasSettingsTab extends PluginSettingTab {
  private draft:NasSettings;
  private busy=false;
  private status?:HTMLElement;
  constructor(app:App,private api:NasPluginApi & Plugin){super(app,api);this.draft=api.getNasSettings();}
  private async run(work:()=>Promise<void>):Promise<void> {
    if(this.busy)return;this.busy=true;
    try{await work();}catch(error){this.status?.setText(message(error));}finally{this.busy=false;}
  }
  private async save():Promise<void>{await this.api.updateNasSettings(this.draft);this.draft=this.api.getNasSettings();}
  display():void {
    this.containerEl.empty();
    this.containerEl.createEl('h2',{text:'Remote NAS Resource Adapter · Windows'});
    this.containerEl.createEl('p',{text:'默认是人工样本模式。配置、验证 HTTPS 和核对映射后，才会启用 NAS 图片；只使用 GET 和有限 PROPFIND。'});
    new Setting(this.containerEl).setName('WebDAV HTTPS 地址').setDesc('仅填写服务器及端口，目录在映射中单独填写。').addText(text=>text.setValue(this.draft.endpoint).setPlaceholder('https://服务器:5006').onChange(value=>{this.draft.endpoint=value.trim();}));
    const trust=this.draft.certificateTrust;
    new Setting(this.containerEl).setName('HTTPS 证书信任').setDesc(trust
      ?`已明确指定证书：${trust.serverName} → ${trust.address}:${trust.port}。证书更换、过期或名称不符时停止连接。`
      :'使用现有系统与 Node 信任根。未指定额外证书。');
    if(trust){
      new Setting(this.containerEl).setName('已批准的 SHA-256 指纹').addTextArea(text=>{text.setValue(trust.sha256);text.inputEl.readOnly=true;text.inputEl.rows=2;});
      new Setting(this.containerEl).addButton(button=>button.setButtonText('移除专用信任并停止 NAS').onClick(()=>void this.run(async()=>{
        delete this.draft.certificateTrust;await this.save();this.display();this.status?.setText('已恢复系统信任，请重新验证 HTTPS。');
      })));
    }
    new Setting(this.containerEl).setName('账号').addText(text=>text.setValue(this.draft.username).onChange(value=>{this.draft.username=value.trim();}));
    new Setting(this.containerEl).setName('凭据保存方式').addDropdown(drop=>drop.addOption('session','仅本次会话（默认）').addOption('secret','Obsidian 官方秘密').setValue(this.draft.credentialSource).onChange(value=>{
      this.draft.credentialSource=value==='secret'?'secret':'session';this.display();
    }));
    if(this.draft.credentialSource==='secret'){
      new Setting(this.containerEl).setName('秘密引用').setDesc('插件只保存秘密名称，不保存密码。确认该设备的官方存储安全边界后使用。').addComponent(element=>new SecretComponent(this.app,element).setValue(this.draft.passwordSecretId).onChange(value=>{this.draft.passwordSecretId=value ?? '';}));
    }
    this.containerEl.createEl('h3',{text:'路径映射'});
    this.draft.mappings.forEach((mapping,index)=>{
      new Setting(this.containerEl).setName(`Windows 根目录 ${index+1}`).addText(text=>text.setValue(mapping.windowsRoot).onChange(value=>{mapping.windowsRoot=value;}));
      new Setting(this.containerEl).setName('对应 WebDAV 目录').setDesc('必须是已核对的服务器目录，不根据本地文件夹名猜测。').addText(text=>text.setValue(mapping.webdavRoot).setPlaceholder('尚待核对').onChange(value=>{mapping.webdavRoot=value;}))
        .addButton(button=>button.setButtonText('移除此映射').onClick(()=>{this.draft.mappings.splice(index,1);this.display();}))
        .addButton(button=>button.setButtonText('核对候选').onClick(()=>void this.run(async()=>{
          await this.save();const result=await this.api.discoverNasMapping(index);
          if(result.complete&&result.candidates.length===1){this.draft.mappings[index]!.webdavRoot=result.candidates[0]!.webdavRoot;await this.save();this.display();this.status?.setText(`找到唯一候选：${result.candidates[0]!.webdavRoot}。已用 ${result.candidates[0]!.evidence.length} 个样本确认文件存在；图片字节与本地原图一致性未验证。`);}
          else this.status?.setText(`候选：${result.candidates.map(candidate=>candidate.webdavRoot).join('、')||'无'}；${result.complete?'请核对后填写，不自动选择。':'部分目录未能核对或已达到次数限制，未自动选择。'}`);
        })));
    });
    new Setting(this.containerEl).addButton(button=>button.setButtonText('添加映射').onClick(()=>{this.draft.mappings.push({windowsRoot:'',webdavRoot:''});this.display();}));
    new Setting(this.containerEl).setName('用于核对的现有图片路径').setDesc('每行一个 Windows 路径或 file:/// 引用，最多四个。只核对有限元数据，不扫描或复制整个数据目录。')
      .addTextArea(text=>{text.inputEl.rows=3;text.setValue(this.draft.samplePaths.join('\n')).onChange(value=>{this.draft.samplePaths=value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);});});
    this.status=this.containerEl.createEl('p',{cls:'nas-connection-status',text:'尚未连接。证书错误不会被忽略，密码不会写入插件 data.json。'});
    new Setting(this.containerEl).addButton(button=>button.setButtonText('保存并验证 HTTPS').setCta().onClick(()=>void this.run(async()=>{
      await this.save();const result=await this.api.probeNas();this.display();this.status?.setText(result.message);
    })));
    new Setting(this.containerEl).addButton(button=>button.setButtonText('输入本次凭据').setDisabled(!this.api.nasTlsVerified()||this.draft.credentialSource!=='session').onClick(()=>void this.run(async()=>{
      await this.save();if(!this.api.nasTlsVerified())throw new AdapterError('TLS','请先验证当前 HTTPS 地址');
      new SessionPasswordModal(this.app,this.api,()=>this.status?.setText('凭据仅保存在本次会话。可读取根目录或核对映射。')).open();
    }))).addButton(button=>button.setButtonText('读取根目录').setDisabled(!this.api.nasTlsVerified()).onClick(()=>void this.run(async()=>{
      await this.save();const entries=await this.api.listNasRoot();this.status?.setText(`根目录：${entries.filter(e=>e.isCollection&&e.displayName!=='/').map(e=>e.displayName).join('、')||'无可读目录'}。未读取图片内容。`);
    })));
    new Setting(this.containerEl).addButton(button=>button.setButtonText('启用 NAS 图片').setDisabled(!this.api.nasTlsVerified()||!this.draft.mappings.length||this.draft.mappings.some(m=>!m.webdavRoot)).onClick(()=>void this.run(async()=>{await this.save();await this.api.enableNasImages();this.status?.setText('NAS 图片模式已启用，仅按当前笔记需要读取图片。');})))
      .addButton(button=>button.setButtonText('停止 NAS 并清空会话凭据').onClick(()=>{
        // Stopping must remain available while a metadata operation is busy.
        void this.api.disableNasImages(true).then(()=>{this.display();this.status?.setText('NAS 模式已停止，会话凭据已清空。');}).catch(error=>this.status?.setText(message(error)));
      }));
  }
}
