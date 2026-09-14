import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { BinaryWriter } from "../src/nitro/binary";
import { compressArm9, compressBLZ, decompressArm9, decompressBLZ } from "../src/nitro/blz";
import { HMAC_SHA1_KEY, TWL, type TwlHeader, updateHeaderSignatures } from "../src/nitro/twl";
const hash = (b: Buffer) => createHmac("sha1", HMAC_SHA1_KEY).update(b).digest();
function fixture() {
  const h: TwlHeader = {
    digest_sector_size: 0x400,
    digest_block_sectorcount: 32,
    digest_ntr_start: 0x4000,
    digest_ntr_size: 0x4000,
    digest_twl_start: 0x10000,
    digest_twl_size: 0x800,
    sector_hashtable_start: 0x8000,
    sector_hashtable_size: 0x280,
    block_hashtable_start: 0x8400,
    block_hashtable_size: 20,
    dsi9_rom_offset: 0x10000,
    dsi9_size: 0x400,
    dsi7_rom_offset: 0x10400,
    dsi7_size: 0x400,
    modcrypt1_start: 0,
    modcrypt1_size: 0,
    modcrypt2_start: 0,
    modcrypt2_size: 0,
    total_rom_size: 0x10800,
    trimmedRom: false,
    twlInternalFlags: 0,
    decrypted: false,
    gameTitle: "TEST TITLE12",
    gameCode: "ABCD",
    hmac_arm9: Buffer.alloc(20),
    hmac_arm7: Buffer.alloc(20),
    hmac_digest_master: Buffer.alloc(20),
  };
  const rom = Buffer.alloc(h.total_rom_size, 0x55);
  const w = new BinaryWriter(rom.length);
  w.write(rom);
  w.position = 0x8000;
  return { h, rom, w };
}
test("TWL preserves ARM payloads, rebuilds all three digest levels and final cursor", () => {
  const { h, rom, w } = fixture();
  const twl = new TWL(h, [], rom);
  twl.writeTo(w, h);
  assert.equal(w.position, h.total_rom_size);
  assert.deepEqual(w.buffer.subarray(h.dsi9_rom_offset, h.dsi9_rom_offset + h.dsi9_size), twl.DSi9Data);
  assert.deepEqual(
    w.buffer.subarray(h.sector_hashtable_start, h.sector_hashtable_start + 20),
    hash(rom.subarray(0x4000, 0x4400)),
  );
  assert.deepEqual(
    h.hmac_digest_master,
    hash(w.buffer.subarray(h.block_hashtable_start, h.block_hashtable_start + 20)),
  );
  assert.deepEqual(
    w.buffer.subarray(h.block_hashtable_start, h.block_hashtable_start + 20),
    hash(w.buffer.subarray(h.sector_hashtable_start, h.sector_hashtable_start + 0x280)),
  );
});
test("TWL rejects invalid digest sizes and out-of-range ROM sections", () => {
  const { h, rom } = fixture();
  assert.throws(() => new TWL({ ...h, digest_sector_size: 0 }, [], rom), /sector/);
  assert.throws(() => new TWL({ ...h, dsi9_size: rom.length }, [], rom), /range/);
});
test("BLZ roundtrip compressible and incompressible buffers", () => {
  for (const input of [Buffer.from("ABC".repeat(1000)), Buffer.alloc(8192, 42)])
    assert.deepEqual(decompressBLZ(compressBLZ(input)), input);
  assert.equal(compressBLZ(Buffer.from("abcdef")).length, 0);
  assert.ok(compressBLZ(Buffer.alloc(8192, 42)).length < 8192);
  assert.throws(() => decompressBLZ(Buffer.from("01000008010000ff", "hex")), /BLZ/);
});

test("TWL rejects NTR output colliding with fixed hash tables before mutation", () => {
  const { h, rom, w } = fixture();
  w.position = h.sector_hashtable_start + 1;
  assert.throws(() => new TWL(h, [], rom).writeTo(w, h), /overlaps/);
  assert.deepEqual(w.buffer, rom);
});
test("header signature preserves original by default or writes no$gba SHA1 mask", () => {
  const original = Buffer.alloc(0x1000, 0x77),
    signature = Buffer.alloc(128, 0x88);
  const header = {
    hmac_digest_master: Buffer.alloc(20, 0x66),
    rsa_signature: signature,
  };
  const writer = new BinaryWriter(0x2000);
  writer.write(original);
  writer.position = 0x1000;
  updateHeaderSignatures(writer, header, original, true);
  assert.deepEqual(header.rsa_signature, signature);
  assert.equal(writer.position, 0x1000);
  updateHeaderSignatures(writer, header, original, false);
  assert.equal(header.rsa_signature[0], 0);
  assert.equal(header.rsa_signature[1], 1);
  assert.equal(header.rsa_signature[107], 0);
  const data = Buffer.from(original.subarray(0, 0xe00));
  header.hmac_digest_master.copy(data, 0x328);
  assert.deepEqual(header.rsa_signature.subarray(108), createHash("sha1").update(data).digest());
  assert.deepEqual(writer.buffer.subarray(0xf80, 0x1000), header.rsa_signature);
});

test("encrypted TWL hashes plaintext, encrypts at modcrypt offset and decrypts on read", () => {
  const { h, rom, w } = fixture();
  h.twlInternalFlags = 6;
  h.modcrypt1_start = h.dsi9_rom_offset + 16;
  h.modcrypt1_size = 32;
  const twl = new TWL({ ...h, modcrypt1_start: 0, modcrypt1_size: 0 }, [], rom);
  const plaintext = Buffer.from(twl.DSi9Data);
  twl.writeTo(w, h);
  assert.deepEqual(w.buffer.subarray(h.dsi9_rom_offset, h.dsi9_rom_offset + 16), plaintext.subarray(0, 16));
  assert.notDeepEqual(w.buffer.subarray(h.modcrypt1_start, h.modcrypt1_start + 32), plaintext.subarray(16, 48));
  const reread = new TWL(h, [], w.buffer);
  assert.deepEqual(reread.DSi9Data, plaintext);
  assert.deepEqual(reread.Hashtable1Data.subarray(16 * 20, 17 * 20), hash(plaintext));
  reread.importArm7iData(Buffer.from([1, 2, 3]));
  assert.equal(reread.DSi7Data.length, 16);
  assert.deepEqual(reread.DSi7Data, Buffer.from([1, 2, 3, ...Array(13).fill(255)]));
});

test("TWL with only modcrypt2 preserves plaintext and encrypted output across saves", () => {
  const { h, rom, w } = fixture();
  h.twlInternalFlags = 6;
  const twl = new TWL(h, [], rom);
  h.modcrypt2_start = h.dsi7_rom_offset;
  h.modcrypt2_size = h.dsi7_size;
  const plaintext = Buffer.from(twl.DSi7Data);
  twl.writeTo(w, h);
  const encrypted = Buffer.from(w.toBuffer());
  assert.notDeepEqual(encrypted.subarray(h.dsi7_rom_offset, h.dsi7_rom_offset + h.dsi7_size), plaintext);
  const reread = new TWL(h, [], encrypted);
  assert.deepEqual(reread.DSi7Data, plaintext);
  const second = new BinaryWriter(encrypted.length);
  second.write(encrypted);
  second.position = h.sector_hashtable_start;
  reread.writeTo(second, h);
  assert.deepEqual(second.toBuffer(), encrypted);
  assert.equal(h.twlInternalFlags & 2, 2);
});

test("overlay HMAC updates preserve uncompressed ARM9 storage", () => {
  const { h, rom } = fixture();
  const oldOverlay = rom.subarray(0x5000, 0x5100),
    replacement = Buffer.alloc(0x100, 0xaa);
  const twl = new TWL(h, [{ offset: 0x5000, size: 0x100 }], rom);
  const header = {
    reserved2: Buffer.from([0x20, 0, 0, 0]),
    ARM9ramAddress: 0x02000000,
    ARM9size: 0x8000,
  };
  const arm9 = Buffer.alloc(0x8000);
  arm9.writeUInt32LE(header.ARM9ramAddress + 0x100, 0x34);
  arm9.writeUInt32LE(header.ARM9ramAddress + 0x7000, 0x28);
  hash(oldOverlay).copy(arm9, 0x6500);
  const updated = twl.updateOverlays9Sha1Hmac(arm9, header, [replacement]);
  assert.equal(updated.length, arm9.length);
  assert.deepEqual(updated.subarray(0x6500, 0x6514), hash(replacement));
  assert.deepEqual(arm9.subarray(0x6500, 0x6514), hash(oldOverlay));
});

test("ARM9 BLZ preserves secure prefix and decompresses executable body", () => {
  const header = {
    reserved2: Buffer.from([0x20, 0, 0, 0]),
    ARM9ramAddress: 0x02000000,
    ARM9size: 0x8000,
  };
  const original = Buffer.alloc(header.ARM9size, 0x5a);
  const packed = compressArm9(original, header);
  assert.ok(packed.length < original.length);
  const restored = decompressArm9(packed, header);
  assert.equal(restored.compressed, true);
  assert.deepEqual(restored.data.subarray(0x4000), original.subarray(0x4000));
  assert.deepEqual(restored.data.subarray(0, 0x34), original.subarray(0, 0x34));
  assert.throws(() => decompressBLZ(Buffer.alloc(8)), /BLZ/);
});
