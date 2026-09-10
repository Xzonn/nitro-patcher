import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { hashDigest, hmacSha1, createAesBlockCipher, inflateRawSync } from '../src/runtime/browser';

test('browser MD5, SHA1 and HMAC match native Node across block boundaries', () => {
  for (const size of [0, 1, 63, 64, 65, 1024, 65537]) {
    const data = Buffer.alloc(size, 0xa5),
      key = Buffer.from('test key');
    for (const algorithm of ['md5', 'sha1'] as const)
      assert.deepEqual(hashDigest(algorithm, data), createHash(algorithm).update(data).digest());
    assert.deepEqual(hmacSha1(key, data), createHmac('sha1', key).update(data).digest());
  }
});
test('browser AES block cipher matches the NIST known answer', () => {
  const encrypt = createAesBlockCipher(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'));
  const block = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  assert.equal(encrypt(block).toString('hex'), '69c4e0d86a7b0430d8cdb78070b4c55a');
  assert.equal(encrypt(block).toString('hex'), '69c4e0d86a7b0430d8cdb78070b4c55a');
});
test('browser inflation handles empty data and enforces output bounds', () => {
  for (const size of [0, 1, 32768, 131073]) {
    const data = Buffer.alloc(size, 0x42),
      compressed = deflateRawSync(data);
    assert.deepEqual(inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) }), data);
    if (size > 1)
      assert.throws(() => inflateRawSync(compressed, { maxOutputLength: size - 1 }), /exceeds/);
  }
  assert.throws(() => inflateRawSync(Buffer.from([0xff]), { maxOutputLength: 1 }));
});
