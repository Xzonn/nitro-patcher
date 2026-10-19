import { zipSync } from "fflate";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { OverlayTable } from "../src/nitro/filesystem";
import { NDSFile } from "../src/nitro/nds-file";
import { patchBuffer } from "../src/nitro-patch-helper";

const manifestPath = process.env.NITRO_OVERLAY_MANIFEST;
if (!manifestPath) throw new Error("Set NITRO_OVERLAY_MANIFEST to the external real-ROM manifest");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
  rom: string;
  overlayRom: string;
  dsiRom: string;
};
const input = await readFile(manifest.rom);
const source = new NDSFile(input);
const translated = new NDSFile(await readFile(manifest.overlayRom));
const payload = translated.getFile("overlay/overlay_0344.bin");
const metadata = translated.overlay9Table.entries.find((entry) => entry.overlayId === 344)!;
assert.ok(metadata);
assert.equal(source.header.unitCode, 0);
assert.equal(source.overlay7Table.entries.length, 0);
const firstId = Math.max(...source.overlay9Table.entries.map((entry) => entry.overlayId)) + 3;
const path = (arm9: boolean, id: number): string =>
  `overlay/overlay${arm9 ? "" : "7"}_${String(id).padStart(4, "0")}.bin`;
const additions = [
  { arm9: true, id: firstId + 2 },
  { arm9: false, id: 5 },
  { arm9: true, id: firstId },
  { arm9: false, id: 2 },
];
const rom = new NDSFile(input);
for (const { arm9, id } of additions) {
  const content = Buffer.from(payload);
  rom.addOverlay(arm9, { ...metadata, overlayId: id, reserved: 0 }, content);
  content.fill(0);
  assert.ok(rom.getFile(path(arm9, id)).equals(payload));
}
rom.addFile("data/overlay-check/program.bin", payload);
const output = rom.toBuffer();
assert.ok(rom.toBuffer().equals(output));
const reopened = new NDSFile(output);
assert.equal(reopened.overlay9Table.entries.length, source.overlay9Table.entries.length + 2);
assert.equal(reopened.overlay7Table.entries.length, 2);
assert.equal(reopened.header.ARM9overlaySize, source.header.ARM9overlaySize + 64);
assert.equal(reopened.header.ARM7overlaySize, 64);
assert.equal(reopened.fatTable.entries.length, source.fatTable.entries.length + 5);
for (const { arm9, id } of additions) {
  const table = arm9 ? reopened.overlay9Table : reopened.overlay7Table;
  const entry = table.entries.find((item) => item.overlayId === id)!;
  const file = reopened.listFiles().find((item) => item.path === path(arm9, id))!;
  assert.equal(entry.fileId, file.id);
  assert.deepEqual(entry, { ...metadata, overlayId: id, reserved: 0, fileId: file.id });
  assert.ok(reopened.getFile(file.path).equals(payload));
}
assert.ok(reopened.getFile("data/overlay-check/program.bin").equals(payload));
for (const file of source.listFiles().filter((item) => /^(data|overlay)\//.test(item.path)))
  assert.ok(reopened.getFile(file.path).equals(source.getFile(file.path)), file.path);
for (const name of ["arm9.bin", "arm7.bin", "banner.bin"])
  assert.ok(reopened.getFile(name).equals(source.getFile(name)), name);
assert.throws(() => rom.addOverlay(true, { ...metadata, overlayId: firstId }, payload), /already exists/);
assert.throws(() => rom.addOverlay(true, { ...metadata, overlayId: -1 }, payload), /overlay ID/);

const tables = new Map<boolean, OverlayTable>();
for (const arm9 of [true, false]) {
  const original = arm9 ? source.overlay9Table : source.overlay7Table;
  const raw = original.toBuffer();
  const table = new OverlayTable(raw, 0, raw.length, arm9);
  for (const { arm9: target, id } of additions)
    if (target === arm9) table.entries.push({ ...metadata, overlayId: id, reserved: 0, fileId: 0 });
  // Supplied table IDs belong to the translated ROM and must be reassigned.
  for (const entry of table.entries) entry.fileId += 1;
  tables.set(arm9, table);
}
const members: Record<string, Uint8Array> = {
  "overarm9.bin": tables.get(true)!.toBuffer(),
  "overarm7.bin": tables.get(false)!.toBuffer(),
};
for (const { arm9, id } of additions) members[path(arm9, id)] = payload;
const archive = (files: Record<string, Uint8Array>, version = 2): Buffer =>
  Buffer.from(zipSync({ "metadata.json": Buffer.from(JSON.stringify({ formatVersion: version })), ...files }));
const applied = new NDSFile(patchBuffer(input, archive(members)).buffer);
for (const { arm9, id } of additions) assert.ok(applied.getFile(path(arm9, id)).equals(payload));
assert.equal(applied.overlay7Table.entries.length, 2);
const legacy = new NDSFile(patchBuffer(input, archive({ [path(true, firstId)]: payload }, 1)).buffer);
assert.equal(legacy.hasFile(path(true, firstId)), false);
assert.throws(() => patchBuffer(input, archive({ [path(true, firstId)]: payload })), /missing its table entry/);
assert.throws(() => patchBuffer(input, archive({ [path(false, 2)]: payload })), /requires overarm7/);
assert.throws(() => patchBuffer(input, archive({ "overlay/unrecognised.bin": payload })), /Invalid overlay path/);
assert.throws(() => patchBuffer(input, archive({ "overarm9.bin": members["overarm9.bin"] })), /no payload/);
const duplicate = new NDSFile(input);
const duplicateTable = source.overlay9Table.toBuffer();
duplicate.replaceFile("overarm9.bin", Buffer.concat([duplicateTable, duplicateTable.subarray(0, 32)]));
assert.throws(() => duplicate.toBuffer(), /Duplicate overlay ID/);
const removed = new NDSFile(input);
removed.replaceFile("overarm9.bin", duplicateTable.subarray(32));
assert.throws(() => removed.toBuffer(), /Removing overlays/);
const missing = new NDSFile(input);
missing.replaceFile("overarm7.bin", tables.get(false)!.toBuffer());
assert.throws(() => missing.toBuffer(), /no payload/);
const limited = new NDSFile(input, { maxOutputSize: payload.length - 1 });
assert.throws(() => limited.addOverlay(true, { ...metadata, overlayId: firstId }, payload), /size limit/);
const compressed = source.overlay9Table.entries.find((entry) => entry.reserved & 0x1000000)!;
assert.ok(compressed);
const compressedPayload = source.getFile(path(true, compressed.overlayId));
const compressedRom = new NDSFile(input);
compressedRom.addOverlay(true, { ...compressed, overlayId: firstId, reserved: 0x1000001 }, compressedPayload);
const compressedOutput = new NDSFile(compressedRom.toBuffer());
assert.equal(compressedOutput.overlay9Table.entries.at(-1)!.reserved, 0x1000000 | compressedPayload.length);
assert.ok(compressedOutput.getFile(path(true, firstId)).equals(compressedPayload));
const dsiInput = await readFile(manifest.dsiRom);
const dsi = new NDSFile(dsiInput, { dsiMode: "complete" });
dsi.addOverlay(true, { ...metadata, overlayId: 400 }, payload);
assert.throws(() => dsi.toBuffer(), /requires an ARM9 replacement/);
const unsigned = new NDSFile(dsiInput, { dsiMode: "complete" });
unsigned.addOverlay(true, { ...metadata, overlayId: 400, reserved: 0 }, payload);
unsigned.addOverlay(false, { ...metadata, overlayId: 3, reserved: 0 }, payload);
const unsignedOutput = new NDSFile(unsigned.toBuffer(), { dsiMode: "complete" });
assert.ok(unsignedOutput.getFile(path(true, 400)).equals(payload));
assert.ok(unsignedOutput.getFile(path(false, 3)).equals(payload));
for (const [name, value] of Object.entries(unsignedOutput.verifyDsi()))
  assert.equal(value.status, name === "signature" ? "invalid" : "valid", name);
console.log(
  "Real-ROM overlay checks passed: ARM9, ARM7, first table, multiple additions, FAT/FNT, metadata and errors",
);
