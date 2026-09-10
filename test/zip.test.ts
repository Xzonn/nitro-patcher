import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readZip } from '../src/patch/zip';
import { makeZip } from './fixtures';
import { crc32 } from '../src/nitro/crc';

interface EntryOptions {
  name?: Buffer;
  data?: Buffer;
  method?: number;
  descriptor?: boolean;
  signedDescriptor?: boolean;
  flags?: number;
  extra?: Buffer;
}
function oneEntry({
  name = Buffer.from('a.txt'),
  data = Buffer.from('123456789'),
  method = 8,
  descriptor = false,
  signedDescriptor = true,
  flags = 0x800,
  extra = Buffer.alloc(0),
}: EntryOptions = {}): Buffer {
  const compressed = method === 8 ? deflateRawSync(data) : data;
  const checksum = crc32(data);
  flags |= descriptor ? 8 : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  if (!descriptor) {
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
  }
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(extra.length, 28);
  const dd = Buffer.alloc(descriptor ? (signedDescriptor ? 16 : 12) : 0);
  if (descriptor) {
    const o = signedDescriptor ? 4 : 0;
    if (signedDescriptor) dd.writeUInt32LE(0x08074b50);
    dd.writeUInt32LE(checksum, o);
    dd.writeUInt32LE(compressed.length, o + 4);
    dd.writeUInt32LE(data.length, o + 8);
  }
  const payload = Buffer.concat([local, name, extra, compressed, dd]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(extra.length, 30);
  const directory = Buffer.concat([central, name, extra]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(payload.length, 16);
  return Buffer.concat([payload, directory, end]);
}

test('stored archive matches PatchHelper path normalization and duplicate precedence', () => {
  const archive = makeZip([
    ['DIR/', ''],
    ['DIR\\File.BIN', 'first'],
    ['dir/file.bin', 'last'],
    ['空/文件.txt', '数据'],
  ]);
  const entries = readZip(archive);
  assert.deepEqual([...entries.keys()], ['dir/file.bin', '空/文件.txt']);
  assert.equal(entries.get('dir/file.bin')?.toString(), 'last');
  assert.equal(entries.get('空/文件.txt')?.toString(), '数据');
});
test('deflated entries support central-directory sizes and signed/unsigned data descriptors', () => {
  for (const options of [{}, { descriptor: true }, { descriptor: true, signedDescriptor: false }]) {
    assert.equal(readZip(oneEntry(options)).get('a.txt')?.toString(), '123456789');
  }
});
test('CP437 names and CRC-verified Unicode path extras are decoded', () => {
  const name = Buffer.from([0x82, 0x2e, 0x74, 0x78, 0x74]);
  assert.equal(
    readZip(oneEntry({ name, flags: 0 }))
      .get('é.txt')
      ?.toString(),
    '123456789',
  );
  const unicode = Buffer.from('目录/名字.txt');
  const extra = Buffer.alloc(9 + unicode.length);
  extra.writeUInt16LE(0x7075);
  extra.writeUInt16LE(5 + unicode.length, 2);
  extra[4] = 1;
  extra.writeUInt32LE(crc32(name), 5);
  unicode.copy(extra, 9);
  assert.ok(readZip(oneEntry({ name, flags: 0, extra })).has('目录/名字.txt'));
  extra[5] = extra[5]! ^ 1;
  assert.ok(readZip(oneEntry({ name, flags: 0, extra })).has('é.txt'));
});
test('valid empty ZIP and archive comments are supported', () => {
  assert.equal(readZip(makeZip([])).size, 0);
  const zip = oneEntry();
  zip.writeUInt16LE(3, zip.length - 2);
  assert.equal(readZip(Buffer.concat([zip, Buffer.from('end')])).size, 1);
});
test('CRC corruption, truncated ranges, mismatched local headers and invalid UTF-8 fail', () => {
  const zip = oneEntry({ method: 0 });
  zip[35] = zip[35]! ^ 1;
  assert.throws(() => readZip(zip), /CRC/i);
  const valid = oneEntry();
  for (let i = 0; i < valid.length; i++) assert.throws(() => readZip(valid.subarray(0, i)), /ZIP/i);
  const wrongLocal = oneEntry();
  wrongLocal.writeUInt16LE(0, 8);
  assert.throws(() => readZip(wrongLocal), /local|method/i);
  assert.throws(() => readZip(oneEntry({ name: Buffer.from([0xff]) })), /UTF-8/i);
});
test('ZIP bomb budgets use all entries including overwritten names and advertised size bounds inflation', () => {
  assert.throws(
    () =>
      readZip(
        makeZip([
          ['x', 'aaaa'],
          ['x', 'bbbb'],
        ]),
        { maxUncompressedSize: 7 },
      ),
    /limit/i,
  );
  assert.throws(
    () =>
      readZip(
        makeZip([
          ['x', 'a'],
          ['y', 'b'],
        ]),
        { maxEntries: 1 },
      ),
    /limit/i,
  );
  const zip = oneEntry({ data: Buffer.alloc(10000) });
  const cd = zip.readUInt32LE(zip.length - 6);
  zip.writeUInt32LE(1, 22);
  zip.writeUInt32LE(1, cd + 24);
  assert.throws(() => readZip(zip), /inflate|size|length/i);
});
test('encrypted, split, ZIP64 and unsupported compression archives are rejected explicitly', () => {
  assert.throws(() => readZip(oneEntry({ flags: 1 })), /encrypt/i);
  assert.throws(() => readZip(oneEntry({ method: 12 })), /compression/i);
  const split = oneEntry();
  split.writeUInt16LE(1, split.length - 18);
  assert.throws(() => readZip(split), /split|disk/i);
  const zip64 = oneEntry();
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  assert.throws(() => readZip(zip64), /ZIP64/i);
});
