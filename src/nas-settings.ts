import {checkedOrigin,parseWindowsPath,resolveResource,type Mapping} from './paths';
import {AdapterError} from './errors';
import {validateCertificateTrust,type CertificateTrust} from './certificate-trust';
export interface NasSettings {
  endpoint:string;username:string;mappings:Mapping[];samplePaths:string[];credentialSource:'session'|'secret';passwordSecretId:string;
  certificateTrust?:CertificateTrust;
}
export const nasDefaults=():NasSettings=>({endpoint:'https://nas.example.invalid:5006',username:'user',
  mappings:[{windowsRoot:'C:\\SynologyDrive',webdavRoot:''}],samplePaths:[],credentialSource:'session',passwordSecretId:''});
/** Whitelist serialization: unknown fields (including any password) never reach data.json. */
export function validateNasSettings(value:unknown,requireMappings=false):NasSettings {
  if(!value||typeof value!=='object')throw new AdapterError('PATH','Invalid settings');
  const data=value as Record<string,unknown>;
  if(typeof data.endpoint!=='string'||typeof data.username!=='string'||!data.username||data.username.length>1024||/[:\x00-\x1f\x7f]/.test(data.username))throw new AdapterError('PATH');
  const endpoint=checkedOrigin(data.endpoint);
  if(!Array.isArray(data.mappings)||data.mappings.length>32)throw new AdapterError('PATH');
  const mappings:Mapping[]=data.mappings.map((row:unknown)=>{
    if(!row||typeof row!=='object')throw new AdapterError('PATH');const m=row as Record<string,unknown>;
    if(typeof m.windowsRoot!=='string'||typeof m.webdavRoot!=='string'||m.windowsRoot.length>4096||m.webdavRoot.length>4096)throw new AdapterError('PATH');
    parseWindowsPath(m.windowsRoot);
    if(m.webdavRoot)resolveResource(`${m.windowsRoot.replace(/[\\/]+$/,'')}/__nas_check__.png`,endpoint,[{windowsRoot:m.windowsRoot,webdavRoot:m.webdavRoot}]);
    else if(requireMappings)throw new AdapterError('UNMAPPED','WebDAV root has not been confirmed');
    return {windowsRoot:m.windowsRoot,webdavRoot:m.webdavRoot};
  });
  const keys=mappings.map(m=>{const p=parseWindowsPath(m.windowsRoot);return `${p.drive}/${p.parts.join('/').toLowerCase()}`;});
  if(new Set(keys).size!==keys.length)throw new AdapterError('PATH','Duplicate Windows roots');
  if(requireMappings&&!mappings.length)throw new AdapterError('UNMAPPED');
  const credentialSource=data.credentialSource==='secret'?'secret':'session';
  const samplePaths=data.samplePaths===undefined?[]:data.samplePaths;
  if(!Array.isArray(samplePaths)||samplePaths.length>4||samplePaths.some(item=>typeof item!=='string'||item.length>8192))throw new AdapterError('PATH');
  const uniqueSamples=new Map<string,string>();
  for(const item of samplePaths){const path=parseWindowsPath(item);const key=`${path.drive}/${path.parts.join('/').toLowerCase()}`;if(!uniqueSamples.has(key))uniqueSamples.set(key,item);}
  const passwordSecretId=typeof data.passwordSecretId==='string'?data.passwordSecretId:'';
  if(passwordSecretId&&!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(passwordSecretId))throw new AdapterError('PATH');
  const certificateTrust=data.certificateTrust===undefined?undefined:validateCertificateTrust(data.certificateTrust,endpoint);
  return {endpoint,username:data.username,mappings,samplePaths:[...uniqueSamples.values()],credentialSource,passwordSecretId,
    ...(certificateTrust?{certificateTrust}:{})};
}
export function serializeNasSettings(settings:NasSettings):NasSettings {return validateNasSettings(settings);}
