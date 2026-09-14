import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createRom } from "./fixtures";
import { NDSFile } from "../src/nitro/nds-file";

const hmacKey = Buffer.from(
  "2106c0deba98ce3fa692e39d46f2ed0176e3cc08562363facad4ecdf9a6278348f6d633cfe22ca9220889723d2cfaec232678dfeca836498acfd3e3787465824",
  "hex",
);
const hmac = (data: Buffer): Buffer => createHmac("sha1", hmacKey).update(data).digest();

const createDsiRom = (): Buffer => {
  const rom = createRom();
  rom[0x12] = 2;
  rom[0x1c] = 1;
  const fields: readonly (readonly [number, number])[] = [
    [0x1c0, 0x10000],
    [0x1cc, 0x400],
    [0x1d0, 0x10400],
    [0x1dc, 0x400],
    [0x1e0, 0x4000],
    [0x1e4, 0x6000],
    [0x1e8, 0x10000],
    [0x1ec, 0x800],
    [0x1f0, 0xa000],
    [0x1f4, 0x280],
    [0x1f8, 0xa400],
    [0x1fc, 20],
    [0x200, 0x400],
    [0x204, 32],
    [0x208, 0x840],
    [0x210, 0x10800],
    [0x234, 0x00030000],
  ];
  for (const [offset, value] of fields) rom.writeUInt32LE(value, offset);
  rom.fill(0x91, 0x10000, 0x10400);
  rom.fill(0x71, 0x10400, 0x10800);
  return rom;
};

test("full DSi ROM serialization preserves payloads and all digest levels repeatedly", () => {
  const rom = new NDSFile(createDsiRom());
  assert.ok(rom.twl);
  const serialized = rom.toBuffer();
  assert.deepEqual(serialized, rom.toBuffer());
  const reread = new NDSFile(serialized),
    h = reread.header;
  assert.ok(reread.twl);
  assert.deepEqual(reread.twl.DSi9Data, Buffer.alloc(0x400, 0x91));
  assert.deepEqual(reread.twl.DSi7Data, Buffer.alloc(0x400, 0x71));
  const block = serialized.subarray(h.block_hashtable_start, h.block_hashtable_start + h.block_hashtable_size);
  assert.deepEqual(h.hmac_digest_master, hmac(block));
  assert.deepEqual(block, hmac(serialized.subarray(h.sector_hashtable_start, h.sector_hashtable_start + 0x280)));
  const ntrFirst = serialized.subarray(h.digest_ntr_start, h.digest_ntr_start + 0x400);
  assert.deepEqual(serialized.subarray(h.sector_hashtable_start, h.sector_hashtable_start + 20), hmac(ntrFirst));
  assert.equal(reread.header.headerCRC, true);
  assert.deepEqual(reread.getFile("data/hello.txt"), rom.getFile("data/hello.txt"));
});

test("growing a file past fixed DSi hash tables rejects serialization", () => {
  const rom = new NDSFile(createDsiRom());
  rom.replaceFile("data/hello.txt", Buffer.alloc(0x10000));
  assert.throws(() => rom.toBuffer(), /overlap/i);
});

test("header replacement changes title and code only, matching original helper", () => {
  const rom = new NDSFile(createRom());
  const replacement = rom.getFile("header.bin");
  replacement.write("REPLACED", 0, "ascii");
  replacement.write("NEW0", 12, "ascii");
  replacement.writeUInt32LE(0x12345678, 0x24);
  rom.replaceFile("header.bin", replacement);
  const reread = new NDSFile(rom.toBuffer());
  assert.equal(reread.header.gameCode, "NEW0");
  assert.equal(reread.header.ARM9entryAddress, rom.header.ARM9entryAddress);
});

test("invalid FNT replacement is rejected before emitting an unreadable ROM", () => {
  const rom = new NDSFile(createRom());
  const replacement = rom.getFile("fnt.bin");
  replacement.writeUInt16LE(0xffff, 4);
  rom.replaceFile("fnt.bin", replacement);
  assert.throws(() => rom.toBuffer(), /FNT|file id/i);
});

test("duplicate FNT file IDs are rejected instead of ignoring a replacement", () => {
  const source = createRom();
  const fnt = source.readUInt32LE(0x40);
  source.writeUInt16LE(0, fnt + 12);
  assert.throws(() => new NDSFile(source), /duplicate|file id/i);
});

test("extended banner extraction returns the complete replaceable system file", () => {
  const banner = Buffer.alloc(0xa40);
  banner.writeUInt16LE(3);
  const rom = new NDSFile(createRom({ banner }));
  assert.equal(rom.getFile("banner.bin").length, 0xa40);
  rom.replaceFile("banner.bin", rom.getFile("banner.bin"));
  const reread = new NDSFile(rom.toBuffer());
  assert.equal(reread.banner.version, 3);
  assert.deepEqual(reread.getFile("data/hello.txt"), rom.getFile("data/hello.txt"));
});

for (const [version, size] of [
  [2, 0x940],
  [3, 0xa40],
  [0x103, 0x23c0],
] as const) {
  test(`banner version ${version.toString(16)} growth places NitroFS files after actual banner`, () => {
    const rom = new NDSFile(createRom());
    const replacement = Buffer.alloc(size);
    replacement.writeUInt16LE(version);
    rom.replaceFile("banner.bin", replacement);
    const serialized = rom.toBuffer();
    const reread = new NDSFile(serialized);
    assert.equal(reread.banner.version, version);
    assert.equal(reread.banner.raw.length, size);
    const firstData = reread.listFiles().find((file) => file.path === "data/hello.txt");
    assert.ok(firstData);
    assert.ok(firstData.offset >= reread.header.bannerOffset + size);
    assert.deepEqual(reread.getFile("data/hello.txt"), rom.getFile("data/hello.txt"));
    assert.deepEqual(reread.getFile("data/sub/item.bin"), rom.getFile("data/sub/item.bin"));
  });
}

test("DSi static banner can grow to animated banner using replacement size", () => {
  const input = createDsiRom();
  // Keep sufficient room for the larger NTR banner before fixed DSi regions.
  const fields: readonly (readonly [number, number])[] = [
    [0x1c0, 0x18000],
    [0x1d0, 0x18400],
    [0x1e4, 0xa000],
    [0x1e8, 0x18000],
    [0x1f0, 0xe000],
    [0x1f4, 0x500],
    [0x1f8, 0xe800],
    [0x204, 64],
    [0x210, 0x18800],
  ];
  for (const [offset, value] of fields) input.writeUInt32LE(value, offset);
  const rom = new NDSFile(input);
  const replacement = Buffer.alloc(0x23c0);
  replacement.writeUInt16LE(0x103);
  replacement.fill(0x5a, 0x1240);
  rom.replaceFile("banner.bin", replacement);
  const output = rom.toBuffer();
  const reread = new NDSFile(output);
  assert.equal(reread.header.banner_size, 0x23c0);
  assert.equal(reread.banner.version, 0x103);
  assert.equal(reread.banner.raw.length, 0x23c0);
  assert.deepEqual(reread.banner.raw.subarray(0x1240), replacement.subarray(0x1240));
  assert.deepEqual(reread.getFile("data/hello.txt"), rom.getFile("data/hello.txt"));
  assert.deepEqual(output, rom.toBuffer());
});

test("replacement FNT with duplicate paths rejects before emitting unreadable ROM", () => {
  const rom = new NDSFile(createRom());
  // One directory, valid file IDs 0 and 1, but both filenames are "a".
  const replacement = Buffer.from([8, 0, 0, 0, 0, 0, 1, 0, 1, 97, 1, 97, 0]);
  rom.replaceFile("fnt.bin", replacement);
  assert.throws(() => rom.toBuffer(), /duplicate|FNT/i);
});
