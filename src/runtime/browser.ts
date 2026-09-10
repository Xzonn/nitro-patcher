import { md5, sha1 } from '#browser-hashes';
import { hmac } from '#browser-hmac';
import { ecb } from '#browser-aes';
import { Inflate } from 'fflate';

export const hashDigest = (algorithm: 'md5' | 'sha1', data: Uint8Array): Buffer =>
  Buffer.from((algorithm === 'md5' ? md5 : sha1)(data));
export const hmacSha1 = (key: Uint8Array, data: Uint8Array): Buffer =>
  Buffer.from(hmac(sha1, key, data));
export const createAesBlockCipher =
  (key: Uint8Array): ((block: Uint8Array) => Buffer) =>
  (block) =>
    Buffer.from(ecb(key, { disablePadding: true }).encrypt(block));

/** Bound decompression output even when a ZIP entry lies about its size. */
export const inflateRawSync = (data: Uint8Array, options: { maxOutputLength: number }): Buffer => {
  const output = Buffer.alloc(options.maxOutputLength);
  let length = 0;
  const stream = new Inflate((chunk) => {
    if (chunk.length > output.length - length)
      throw new RangeError('Inflated data exceeds declared size');
    output.set(chunk, length);
    length += chunk.length;
  });
  for (let offset = 0; offset < data.length; offset += 1024) {
    stream.push(data.subarray(offset, offset + 1024), offset + 1024 >= data.length);
  }
  if (!data.length) stream.push(data, true);
  return output.subarray(0, length);
};

// These Node-only methods are not exposed by the browser public API. Keep a
// clear error if a future internal call accidentally crosses that boundary.
const nodeOnly = (): never => {
  throw new Error('Filesystem and RSA APIs are only available in the Node entry');
};
export const readFile = nodeOnly;
export const writeFile = nodeOnly;
export const readFileSync = nodeOnly;
export const verifyRsaSha1 = nodeOnly;
