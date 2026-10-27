import { mkdir, writeFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tlsDir = resolve(projectRoot, 'runtime', 'tls');
const reportPath = resolve(projectRoot, 'reports', 'tls-fixture-info.json');
const dayMs = 24 * 60 * 60 * 1000;
const now = Date.now();
const date = (offsetDays) => new Date(now + offsetDays * dayMs);

const keyOptions = {
  keyType: 'rsa',
  keySize: 2048,
  algorithm: 'sha256',
};

await mkdir(tlsDir, { recursive: true });

const ca = await selfsigned.generate(
  [{ name: 'commonName', value: 'Obsidian NAS PoC Test CA' }],
  {
    ...keyOptions,
    notBeforeDate: date(-1),
    notAfterDate: date(365),
    extensions: [
      { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  },
);

const caFiles = {
  cert: 'test-ca-cert.pem',
  key: 'test-ca-key.pem',
};
await writeFile(resolve(tlsDir, caFiles.cert), ca.cert, 'utf8');
await writeFile(resolve(tlsDir, caFiles.key), ca.private, 'utf8');

const fixtures = [
  {
    id: 'valid-localhost',
    commonName: 'localhost',
    sans: [
      { type: 7, ip: '127.0.0.1' },
      { type: 2, value: 'localhost' },
    ],
    notBeforeDays: -1,
    notAfterDays: 30,
  },
  {
    id: 'wrong-host',
    commonName: 'wrong.invalid',
    sans: [{ type: 2, value: 'wrong.invalid' }],
    notBeforeDays: -1,
    notAfterDays: 30,
  },
  {
    id: 'expired',
    commonName: 'localhost',
    sans: [
      { type: 7, ip: '127.0.0.1' },
      { type: 2, value: 'localhost' },
    ],
    notBeforeDays: -30,
    notAfterDays: -1,
  },
];

const certificates = [];
for (const fixture of fixtures) {
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: fixture.commonName }],
    {
      ...keyOptions,
      ca: { key: ca.private, cert: ca.cert },
      notBeforeDate: date(fixture.notBeforeDays),
      notAfterDate: date(fixture.notAfterDays),
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: fixture.sans },
      ],
    },
  );

  const certificate = new X509Certificate(pems.cert);
  const certFile = `${fixture.id}-cert.pem`;
  const keyFile = `${fixture.id}-key.pem`;
  await writeFile(resolve(tlsDir, certFile), pems.cert, 'utf8');
  await writeFile(resolve(tlsDir, keyFile), pems.private, 'utf8');
  certificates.push({
    id: fixture.id,
    certificateFile: certFile,
    privateKeyFile: keyFile,
    commonName: fixture.commonName,
    subjectAltNames: fixture.sans.map((san) =>
      san.type === 7 ? `IP:${san.ip}` : `DNS:${san.value}`,
    ),
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    fingerprint256: certificate.fingerprint256,
  });
}

const caCertificate = new X509Certificate(ca.cert);
const report = {
  generatedAt: new Date(now).toISOString(),
  algorithm: 'RSA-2048 / SHA-256',
  certificateAuthority: {
    certificateFile: caFiles.cert,
    fingerprint256: caCertificate.fingerprint256,
    validFrom: caCertificate.validFrom,
    validTo: caCertificate.validTo,
  },
  fixtures: certificates,
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`Generated ${certificates.length} server certificate fixtures in runtime/tls/`);
console.log(`Metadata: ${reportPath}`);
