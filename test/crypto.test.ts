import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { aes128CtrCrypt, modcryptKey, encryptSecureArea } from '../src/nitro/crypto';
test('DSi AES reverses key, counter and mask (NIST AES block vector)', () => {
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex').reverse();
  const counter = Buffer.from('00112233445566778899aabbccddeeff', 'hex').reverse();
  assert.equal(
    aes128CtrCrypt(key, counter, Buffer.alloc(16)).toString('hex'),
    Buffer.from('69c4e0d86a7b0430d8cdb78070b4c55a', 'hex').reverse().toString('hex'),
  );
  const input = Buffer.from('a long message crossing multiple AES blocks with a partial tail');
  assert.deepEqual(aes128CtrCrypt(key, counter, aes128CtrCrypt(key, counter, input)), input);
  assert.throws(() => aes128CtrCrypt(Buffer.alloc(15), counter, input), /16/);
});
test('debug modcrypt key consists of title and game code', () =>
  assert.equal(
    modcryptKey({
      twlInternalFlags: 4,
      gameTitle: 'TEST TITLE12',
      gameCode: 'ABCD',
    }).toString(),
    'TEST TITLE12ABCD',
  ));
test('secure encryption preserves bytes after 0x800 and never mutates input', () => {
  const input = Buffer.alloc(0x4000, 0x5a);
  const output = encryptSecureArea('ABCD', input);
  assert.deepEqual(output.subarray(0x800), input.subarray(0x800));
  assert.notDeepEqual(output.subarray(0, 0x800), input.subarray(0, 0x800));
  assert.equal(input[0], 0x5a);
  assert.deepEqual(output, encryptSecureArea('ABCD', input));
  assert.throws(() => encryptSecureArea('ABC', input));
  assert.throws(() => encryptSecureArea('ABCD', Buffer.alloc(16)));
});

test('secure-area bytes match pinned ndstool C++ reference', () => {
  // devkitPro/ndstool a0ae6b5b7604e89dc94a2db01a97efcec41fc9fc,
  // compiled encryption.cpp; synthetic ABCD secure area filled with 0x5a.
  const output = encryptSecureArea('ABCD', Buffer.alloc(0x4000, 0x5a));
  assert.equal(
    createHash('sha256').update(output).digest('hex'),
    '40188fe170aced0e2d2ccc1928b07c3fe42f22f2ec00a7537381248b03444431',
  );
});
