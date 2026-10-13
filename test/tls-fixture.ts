import './bootstrap.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Disposable test credentials, never a real account key or trust-store change.
export function tlsFixture(root: string) {
  const der = (tag: number, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    let length: Buffer;
    if (body.length < 128) length = Buffer.from([body.length]);
    else {
      const bytes: number[] = [];
      for (let n = body.length; n; n = Math.floor(n / 256)) bytes.unshift(n & 255);
      length = Buffer.from([128 + bytes.length, ...bytes]);
    }
    return Buffer.concat([Buffer.from([tag]), length, body]);
  };
  const sequence = (...parts: Buffer[]) => der(0x30, ...parts),
    octets = (bytes: Buffer) => der(4, bytes);
  const oid = (hex: string) => der(6, Buffer.from(hex, 'hex'));
  const algorithm = sequence(oid('2a864886f70d01010b'), der(5));
  const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('localhost')))));
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const extensions = der(
    0xa3,
    sequence(
      sequence(
        oid('551d13'),
        der(1, Buffer.from([255])),
        octets(sequence(der(1, Buffer.from([255])))),
      ),
      sequence(
        oid('551d11'),
        octets(
          sequence(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1]))),
        ),
      ),
    ),
  );
  const tbs = sequence(
    der(0xa0, der(2, Buffer.from([2]))),
    der(2, Buffer.from([1])),
    algorithm,
    name,
    sequence(der(0x17, Buffer.from('260101000000Z')), der(0x17, Buffer.from('360101000000Z'))),
    name,
    keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
    extensions,
  );
  const cert = sequence(
    tbs,
    algorithm,
    der(3, Buffer.from([0]), crypto.sign('sha256', tbs, keys.privateKey)),
  );
  const pem =
    '-----BEGIN CERTIFICATE-----\n' +
    cert
      .toString('base64')
      .match(/.{1,64}/g)!
      .join('\n') +
    '\n-----END CERTIFICATE-----\n';
  const decoded = new crypto.X509Certificate(pem);
  if (decoded.checkIP('127.0.0.1') !== '127.0.0.1' || !decoded.verify(decoded.publicKey))
    throw Error('Invalid synthetic TLS certificate');
  const dir = path.join(root, 'fixture-tls');
  fs.mkdirSync(dir, { mode: 0o700 });
  const keyFile = path.join(dir, 'key.pem'),
    certFile = path.join(dir, 'cert.pem');
  fs.writeFileSync(keyFile, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o600,
  });
  fs.writeFileSync(certFile, pem, { mode: 0o600 });
  return { keyFile, certFile };
}
