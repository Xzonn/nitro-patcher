import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { PatchHelper } from "../src/nitro-patch-helper";
import { type ZipEntries, createRom, makeZip } from "../test/fixtures";

const execFileAsync = promisify(execFile);
const reference = process.env.NITROPATCHER_REFERENCE;
if (!reference) {
  throw new Error("NITROPATCHER_REFERENCE must name the executable original NitroPatcherCli launcher");
}

function vint(value: number): number[] {
  const output = [value % 128];
  while ((value = Math.floor(value / 128))) output.unshift((value % 128) | 128);
  return output;
}

function literalXdelta(target: Uint8Array): Buffer {
  const data = Buffer.from(target);
  const instruction = Buffer.from([1, ...vint(data.length)]);
  const body = Buffer.from([
    ...vint(data.length),
    0,
    ...vint(data.length),
    ...vint(instruction.length),
    0,
    ...data,
    ...instruction,
  ]);
  return Buffer.from([0xd6, 0xc3, 0xc4, 0, 0, 0, ...vint(body.length), ...body]);
}

interface Case {
  name: string;
  rom: Buffer;
  entries: ZipEntries;
}

// A 0x18000-byte ARM9 keeps the original C# repacker's logical output at the
// standard 128 KiB minimum. Its capacity calculation underflows the header
// exponent for smaller synthetic ROMs; those remain useful in native tests.
const baseRom = createRom({ arm9: Buffer.alloc(0x18000) });
const baseMd5 = createHash("md5").update(baseRom).digest("hex");
const changedBanner = Buffer.from(baseRom.subarray(baseRom.readUInt32LE(0x68), baseRom.readUInt32LE(0x68) + 0x840));
changedBanner.write("R\0e\0f\0e\0r\0e\0n\0c\0e\0", 0x240, "binary");

const cases: Case[] = [
  { name: "baseline repack", rom: baseRom, entries: {} },
  {
    name: "ordinary NitroFS replacements",
    rom: baseRom,
    entries: { "data/hello.txt": "changed\n", "DATA/SUB/ITEM.BIN": Buffer.from([9, 8, 7]) },
  },
  {
    name: "large NitroFS growth",
    rom: baseRom,
    entries: { "data/hello.txt": Buffer.alloc(0x18000, 0x67) },
  },
  {
    name: "NitroFS shrink to empty",
    rom: baseRom,
    entries: { "data/sub/item.bin": Buffer.alloc(0) },
  },
  {
    name: "system ARM9 and banner",
    rom: baseRom,
    entries: { "arm9.bin": Buffer.alloc(0x1a000, 0x19), "banner.bin": changedBanner },
  },
  {
    name: "sourceless Xdelta replacement",
    rom: baseRom,
    entries: { "xdelta/data/hello.txt": literalXdelta(Buffer.from("xdelta replacement\n")) },
  },
  {
    name: "ARM9 overlay replacement",
    rom: createRom({ arm9: Buffer.alloc(0x18000), overlay: true }),
    entries: { "overlay/overlay_0000.bin": Buffer.alloc(0x921, 0x4f) },
  },
  {
    name: "DSi-capable extended header repack",
    rom: createRom({ arm9: Buffer.alloc(0x18000), dsi: true }),
    entries: {},
  },
  {
    name: "Nitrocode trailer repack",
    rom: createRom({ arm9: Buffer.alloc(0x18000), nitrocode: true }),
    entries: {},
  },
  {
    name: "MD5 mismatch still emits output",
    rom: baseRom,
    entries: {
      "md5.txt": "00000000000000000000000000000000\n",
      "data/hello.txt": "mismatch output\n",
    },
  },
  {
    name: "preprocessing preserves original input MD5 then replaces a file",
    rom: baseRom,
    entries: {
      [`preprocessing/${baseMd5}.xdelta`]: literalXdelta(
        createRom({ arm9: Buffer.alloc(0x18000), hello: "preprocessed\n" }),
      ),
      "data/sub/item.bin": Buffer.from([0xaa, 0xbb, 0xcc]),
    },
  },
  {
    name: "Xdelta takes precedence over direct replacement",
    rom: baseRom,
    entries: {
      "data/hello.txt": "direct replacement loses\n",
      "xdelta/data/hello.txt": literalXdelta(Buffer.from("xdelta replacement wins\n")),
    },
  },
];

const directory = await mkdtemp(join(tmpdir(), "nitro-patcher-reference-run-"));
try {
  for (const [index, testCase] of cases.entries()) {
    const romPath = join(directory, `${index}.nds`);
    const patchPath = join(directory, `${index}.zip`);
    const outputPath = join(directory, `${index}.reference.nds`);
    const zip = makeZip(testCase.entries);
    await Promise.all([writeFile(romPath, testCase.rom), writeFile(patchPath, zip)]);
    const execution = await execFileAsync(reference, [romPath, patchPath, outputPath], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const stdout: string = execution.stdout;
    const stderr: string = execution.stderr;
    assert.equal(stderr, "", `${testCase.name}: original CLI wrote to stderr`);
    const status = /^(SUCCESS|MD5_MISMATCH)$/m.exec(stdout)?.[1];
    const md5s: string[] = [...stdout.matchAll(/[0-9a-f]{32}/gi)].map((match) => match[0]!.toLowerCase());
    assert.ok(status, `${testCase.name}: could not parse original CLI status from ${JSON.stringify(stdout)}`);
    assert.equal(md5s.length, 2, `${testCase.name}: could not parse original CLI MD5s`);

    const [referenceBuffer, actual] = await Promise.all([
      readFile(outputPath),
      PatchHelper.patchBuffer(testCase.rom, zip),
    ]);
    assert.equal(actual.returnValue, status, `${testCase.name}: return value`);
    assert.equal(actual.inputMd5, md5s[0], `${testCase.name}: input MD5`);
    assert.equal(actual.outputMd5, md5s[1], `${testCase.name}: output MD5`);
    assert.deepEqual(actual.buffer, referenceBuffer, `${testCase.name}: output bytes`);
    console.log(`PASS ${testCase.name}: ${actual.outputMd5}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
