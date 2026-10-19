import assert from "node:assert/strict";
import test from "node:test";

import { createRom } from "./fixtures";

test("NDSFile reads nested filesystem and repacks growing and shrinking replacements", async () => {
  const { NDSFile } = await import("../src/nitro/nds-file");
  const input = createRom({ hello: "hello original", item: "nested data" });
  const rom = new NDSFile(input);
  assert.equal(rom.getFile("data/hello.txt").toString(), "hello original");
  assert.equal(rom.getFile("data/sub/item.bin").toString(), "nested data");
  rom.replaceFile("data/hello.txt", Buffer.alloc(1500, 0x61));
  rom.replaceFile("data/sub/item.bin", Buffer.from("x"));
  const output = rom.toBuffer();
  const reread = new NDSFile(output);
  assert.deepEqual(reread.getFile("data/hello.txt"), Buffer.alloc(1500, 0x61));
  assert.equal(reread.getFile("data/sub/item.bin").toString(), "x");
  assert.equal(reread.header.headerCRC, true);
  assert.equal(reread.header.secureCRC, true);
  assert.equal(reread.banner.bannerCRC, true);
  assert.deepEqual(rom.toBuffer(), output, "serialization is repeatable");
  assert.throws(() => rom.replaceFile("data/new.txt", Buffer.alloc(0)), /not found/i);
});

test("overlays retain identity and data after repacking", async () => {
  const { NDSFile } = await import("../src/nitro/nds-file");
  const rom = new NDSFile(createRom({ overlay: Buffer.from("overlay old") }));
  const overlay = rom.listFiles().find((f) => f.path.startsWith("overlay/"));
  assert.ok(overlay);
  rom.replaceFile(overlay.path, Buffer.alloc(1025, 0x66));
  const output = new NDSFile(rom.toBuffer());
  assert.deepEqual(output.getFile(overlay.path), Buffer.alloc(1025, 0x66));
});

test("malformed ROM offsets and recursive directory trees are rejected", async () => {
  const { NDSFile } = await import("../src/nitro/nds-file");
  const invalid = createRom();
  invalid.writeUInt32LE(0xfffffff0, 0x48);
  assert.throws(() => new NDSFile(invalid), /FAT|range/i);
  const recursive = createRom();
  const fnt = recursive.readUInt32LE(0x40);
  const start = fnt + recursive.readUInt32LE(fnt);
  let p = start;
  while (recursive[p] && recursive[p] < 0x80) p += recursive[p] + 1;
  assert.ok(recursive[p] > 0x80);
  recursive.writeUInt16LE(0xf000, p + 1 + (recursive[p] & 0x7f));
  assert.throws(() => new NDSFile(recursive), /directory|cycle/i);
});

test("addFile supports queries, existing directories, repeated output and subsequent additions", async () => {
  const { NDSFile } = await import("../src/nitro/nds-file");
  const input = createRom();
  const saved = Buffer.from(input);
  const rom = new NDSFile(input);
  rom.addFile("DATA/sub/Extra.bin", Buffer.from("extra"));
  rom.addFile("data/New/Deep/Empty.bin", Buffer.alloc(0));
  rom.addFile("data/A.txt", Buffer.from("a"));
  assert.equal(rom.hasFile("data/SUB/EXTRA.BIN"), true);
  assert.equal(rom.getFile("data/sub/Extra.bin").toString(), "extra");
  assert.deepEqual(
    rom.listFiles().find(({ path }) => path === "data/A.txt"),
    { path: "data/A.txt", id: -1, offset: -1, size: 1 },
  );
  rom.replaceFile("data/A.txt", Buffer.from("updated"));
  const output = rom.toBuffer();
  assert.deepEqual(output, rom.toBuffer());
  assert.deepEqual(input, saved);
  const reopened = new NDSFile(output);
  assert.equal(reopened.getFile("data/A.txt").toString(), "updated");
  assert.equal(reopened.getFile("data/New/Deep/Empty.bin").length, 0);
  assert.equal(reopened.data.files[0].id, 0);
  assert.equal(reopened.data.files[1].id, 1);
  assert.equal(rom.data.files.find((file) => file.name === "hello.txt")?.id, 0);
  rom.addFile("data/New/Deep/Next.bin", Buffer.from("next"));
  assert.equal(new NDSFile(rom.toBuffer()).getFile("data/New/Deep/Next.bin").toString(), "next");
  reopened.addFile("data/New/Deep/Existing.bin", Buffer.from("existing"));
  assert.equal(new NDSFile(reopened.toBuffer()).getFile("data/New/Deep/Existing.bin").toString(), "existing");
});

test("addFile validates path components and encoded length before changing the tree", async () => {
  const { NDSFile } = await import("../src/nitro/nds-file");
  const rom = new NDSFile(createRom());
  const baseline = rom.toBuffer();
  for (const path of [
    "arm9.bin",
    "/data/a",
    "C:/data/a",
    "data/a/../b",
    "data/a/./b",
    "data/a//b",
    "data/a/",
    "data/\0",
    "data/hello.txt",
    "data/hello.txt/child",
    "data/sub",
    "data/new/😀",
    `data/${"あ".repeat(64)}`,
  ])
    assert.throws(() => rom.addFile(path, Buffer.alloc(0)), /path|exists|Shift_JIS|bytes/i);
  assert.deepEqual(rom.toBuffer(), baseline);
  assert.equal(
    rom.data.folders.some((folder) => folder.name === "new"),
    false,
  );
  rom.addFile(`data/${"a".repeat(127)}`, Buffer.alloc(0));
  assert.equal(new NDSFile(rom.toBuffer()).getFile(`data/${"a".repeat(127)}`).length, 0);
});
