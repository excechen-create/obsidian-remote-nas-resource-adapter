import { describe, expect, it } from 'vitest';
import { resolveResource, parseWindowsPath } from '../src/paths';
const root = [{ windowsRoot: 'D:\\work\\Data\\SynologyDrive', webdavRoot: '/verified-root' }];
const resolve = (source: string, mappings = root) => resolveResource(source,'https://nas.example:5006',mappings);
describe('Windows paths and WebDAV boundary', () => {
  it('applies the user-confirmed Data root without duplicating SynologyDrive or Data',()=>{
    const mapped=resolveResource('file:///D:%5Cwork%5CData%5CSynologyDrive%5CResearcher%5Cexperiment%5Ctest%20image.png',
      'https://192.0.2.10:5006',[{windowsRoot:'D:\\work\\Data\\SynologyDrive',webdavRoot:'/Data'}]);
    expect(mapped.url).toBe('https://192.0.2.10:5006/Data/Researcher/experiment/test%20image.png');
  });
  it('handles the actual encoded-backslash syntax, Chinese and spaces once', () => {
    const result = resolve('file:///D:%5Cwork%5CData%5CSynologyDrive%5CResearcher%5Cexperiment%5C中文%20图片.png');
    expect(result.url).toBe('https://nas.example:5006/verified-root/Researcher/experiment/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png');
  });
  it('normalizes Windows drive/case and separators without changing suffix case', () => {
    expect(resolve('d:/WORK/Data/SynologyDrive/./images//Photo.JPG').url).toContain('/images/Photo.JPG');
  });
  it('encodes literal reserved URL characters in raw Windows paths', () => {
    expect(resolve('D:\\work\\Data\\SynologyDrive\\中文 #100%.png').url).toContain('%20%23100%25.png');
  });
  it('supports file localhost and observed app resource prefix explicitly', () => {
    expect(resolve('file://localhost/D:/work/Data/SynologyDrive/a.webp').extension).toBe('webp');
    expect(resolveResource('app://local/D:/work/Data/SynologyDrive/a.png','https://nas.example',root,'app://local/').url).toContain('/a.png');
    expect(() => resolveResource('app://other/D:/work/Data/SynologyDrive/a.png','https://nas.example',root,'app://local/')).toThrow();
  });
  it('uses segment boundaries rather than naive string prefix matching', () => {
    expect(() => resolve('D:\\work\\Data\\SynologyDrive-evil\\a.png')).toThrow('UNMAPPED');
    expect(() => resolve('E:\\work\\Data\\SynologyDrive\\a.png')).toThrow('UNMAPPED');
  });
  it('uses the longest matching root; rejects duplicates', () => {
    const nested = [...root,{ windowsRoot: 'D:/work/Data/SynologyDrive/Researcher',webdavRoot:'/other' }];
    expect(resolve('D:/work/Data/SynologyDrive/Researcher/x.png',nested).url).toContain('/other/x.png');
    expect(() => resolve('D:/work/Data/SynologyDrive/a.png',[...root,...root])).toThrow('Ambiguous');
  });
  it.each([
    'file:///D:/work/Data/SynologyDrive/../secret.png',
    'file:///D:/work/Data/SynologyDrive/%2e%2e/secret.png',
    'file:///D:/work/Data/SynologyDrive/x%5c..%5csecret.png',
    'file:///D:/work/Data/SynologyDrive/x%2f..%2fsecret.png',
    'file:///D:/work/Data/SynologyDrive/%252e%252e/secret.png',
    'file:///D:/work/Data/SynologyDrive/x%255csecret.png',
    'file:///D:/work/Data/SynologyDrive/a%00.png',
    'file:///D:/work/Data/SynologyDrive/a%ZZ.png',
    'file:///D:/work/Data/SynologyDrive/a.png?redirect=https://evil.example',
    'file://evil.example/D:/work/Data/SynologyDrive/a.png',
    '\\\\server\\share\\a.png', '\\\\?\\D:\\work\\Data\\SynologyDrive\\a.png',
    'D:/work/Data/SynologyDrive/CON.png','D:/work/Data/SynologyDrive/a.png:stream',
    'D:/work/Data/SynologyDrive/dir. /a.png','D:/work/Data/SynologyDrive/a%2e.png',
    'https://evil.example/a.png','group:LabData/Researcher/a.png'
  ])('rejects unsafe or ambiguous source: %s', source => expect(() => resolve(source)).toThrow());
  it.each(['http://nas.example','https://user:pass@nas.example','https://nas.example/path','https://nas.example/#x'])('rejects unsafe endpoint %s', endpoint => {
    expect(() => resolveResource('D:/work/Data/SynologyDrive/a.png',endpoint,root)).toThrow();
  });
  it.each(['//evil.example/share','/../secret','/%252e%252e','https://evil.example','/root?x=1','/root\\escape'])('rejects remote root %s', webdavRoot => {
    expect(() => resolve('D:/work/Data/SynologyDrive/a.png',[{...root[0]!,webdavRoot}])).toThrow();
  });
  it('does not reinterpret double encoding or file fragments as filenames', () => {
    expect(() => parseWindowsPath('file:///D:/x%2520y.png')).toThrow();
    expect(() => parseWindowsPath('file:///D:/x.png#other')).toThrow();
  });
});
