import assert from "node:assert/strict";
import test from "node:test";

test("CRC algorithms match standard check vectors", async () => {
  const { crc16, crc32 } = await import("../src/nitro/crc");
  assert.equal(crc16(Buffer.from("123456789")), 0x4b37);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("writer preserves sparse zero gaps and FF alignment, enforces allocation limit", async () => {
  const { BinaryWriter } = await import("../src/nitro/binary");
  const writer = new BinaryWriter(8, 32);
  writer.position = 3;
  writer.write(Buffer.from([1, 2]));
  writer.pad(8);
  assert.deepEqual(writer.toBuffer(), Buffer.from([0, 0, 0, 1, 2, 255, 255, 255]));
  writer.position = 32;
  assert.throws(() => writer.write(Buffer.of(1)), /limit/i);
});

test("header keeps unknown bytes, exposes fields and recalculates checksums", async () => {
  const { Header } = await import("../src/nitro/header");
  const { crc16 } = await import("../src/nitro/crc");
  const input = Buffer.alloc(0x4000);
  input.write("TEST GAME");
  input.write("ABCD", 12);
  input.writeUInt32LE(0x4000, 0x84);
  input[0x250] = 0x67;
  const header = new Header(input);
  header.ARM9size = 0x1234;
  const output = header.toBuffer();
  assert.equal(header.gameCode, "ABCD");
  assert.equal(output[0x250], 0x67);
  assert.equal(output.readUInt32LE(0x2c), 0x1234);
  assert.equal(output.readUInt16LE(0x15e), crc16(output.subarray(0, 0x15e)));
  assert.throws(() => new Header(Buffer.alloc(20)), /header/i);
});

test("banner rewrites multilingual titles and all version CRCs", async () => {
  const { Banner } = await import("../src/nitro/banner");
  const { crc16 } = await import("../src/nitro/crc");
  const input = Buffer.alloc(0x23c0);
  input.writeUInt16LE(0x103);
  const banner = new Banner(input);
  banner.chineseTitle = "测试\n标题";
  banner.englishTitle = "Test";
  const output = banner.toBuffer();
  assert.equal(new Banner(output).chineseTitle, "测试\n标题");
  assert.equal(output.readUInt16LE(2), crc16(output.subarray(0x20, 0x840)));
  assert.equal(output.readUInt16LE(8), crc16(output.subarray(0x1240, 0x23c0)));
});
