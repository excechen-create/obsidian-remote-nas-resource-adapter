import {describe,it,expect} from 'vitest';
import {nasDefaults,validateNasSettings,serializeNasSettings} from '../src/nas-settings';
describe('NAS configuration without persisted passwords or automatic activation',()=>{
  it('preserves only approved non-secret fields',()=>{
    const input={...nasDefaults(),password:'PRIVATE-MARKER',token:'PRIVATE-MARKER',nasEnabled:true};
    const value=serializeNasSettings(input);expect(JSON.stringify(value)).not.toContain('PRIVATE-MARKER');expect(value).not.toHaveProperty('nasEnabled');
  });
  it('allows saving an unconfirmed mapping, but refuses enabling it',()=>{
    expect(serializeNasSettings(nasDefaults()).mappings[0]!.webdavRoot).toBe('');
    expect(()=>validateNasSettings(nasDefaults(),true)).toThrow('WebDAV root');
  });
  it('normalizes origin and validates all explicit mappings',()=>{
    const value=validateNasSettings({...nasDefaults(),mappings:[{windowsRoot:'D:/Sync',webdavRoot:'/Data'}]},true);
    expect(value.endpoint).toBe('https://nas.example.invalid:5006');
  });
  it('deduplicates equivalent sample references before reporting mapping evidence counts',()=>{
    const value=validateNasSettings({...nasDefaults(),samplePaths:['D:/Sync/a.png','file:///d:%5CSync%5Ca.png']});
    expect(value.samplePaths).toEqual(['D:/Sync/a.png']);
  });
  it('rejects duplicated or unsafe roots and embedded URL credentials',()=>{
    expect(()=>validateNasSettings({...nasDefaults(),endpoint:'https://u:p@nas.example'})).toThrow();
    expect(()=>validateNasSettings({...nasDefaults(),mappings:[{windowsRoot:'D:/Sync',webdavRoot:'/Data'},{windowsRoot:'d:\\SYNC',webdavRoot:'/Other'}]})).toThrow('Duplicate');
    expect(()=>validateNasSettings({...nasDefaults(),mappings:[{windowsRoot:'D:/Sync',webdavRoot:'/../Data'}]})).toThrow();
  });
});
