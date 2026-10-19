import { zipSync } from "fflate";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, createHash, createPublicKey, publicDecrypt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

import { encryptSecureArea } from "../src/nitro/crypto";
import { Header } from "../src/nitro/header";
import { NDSFile } from "../src/nitro/nds-file";
import type { DsiVerification } from "../src/nitro/twl-complete";
import { patchBuffer } from "../src/nitro-patch-helper";
import { literalXdelta } from "../test/fixtures";

interface Manifest {
  outputDirectory: string;
  browserExecutable: string;
  referenceCommand: string[];
  roms: { path: string; md5: string; gameCode: string; translatedPath?: string }[];
  compatibility: { rom: string; patch: string; outputMd5: string }[];
}
const manifestPath = process.env.NITRO_DSI_MANIFEST;
if (!manifestPath) throw new Error("Set NITRO_DSI_MANIFEST to the external real-ROM manifest");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
assert.equal(manifest.roms.length, 4);
assert.equal(manifest.compatibility.length, 37);
assert.ok(manifest.referenceCommand.length);
await mkdir(manifest.outputDirectory, { recursive: true });
const digest = (bytes: Uint8Array, algorithm = "sha256"): string => createHash(algorithm).update(bytes).digest("hex");
const metadata = Buffer.from('{"formatVersion":2}');
const archive = (files: Record<string, Uint8Array> = {}): Buffer =>
  Buffer.from(zipSync({ "metadata.json": metadata, ...files }));
const records: { gameCode: string; name: string; path: string; sha256: string; dsi: DsiVerification }[] = [];
const expectedMd5 = [
  "0d4425cdd33437fa360eeade3ae4f292",
  "d95b0f3172e2f658a2ecbce0fec105bb",
  "ecc64d4b1d9d9d161d55ecb23db6fa64",
  "fc61fd45eb0684ba715e40351c6d1e5e",
];
assert.deepEqual(manifest.roms.map((rom) => rom.md5).sort(), [...expectedMd5].sort());
const publicKey = createPublicKey({
  key: {
    kty: "RSA",
    n: Buffer.from(
      "956F790DF08BB85A76AAEFA27FE874758BED9EDF9E9A670CD818BEB9B2885203B3FA11AEAA186513B5D6BB85A384D0D0EFB366CBC6051AAA86827AB74311F59C9BFC6C7079D5F17BD0819F522056738C721F40CF2361932590A3C5DC94CFD17A8CBC954A918AA858F4D804BAF7D3C1C4D7B8F077012FA170260B2C049056F3A5",
      "hex",
    ).toString("base64url"),
    e: "AQAB",
  },
  format: "jwk",
});
const validData = (result: DsiVerification, signature: "valid" | "invalid"): void => {
  for (const [name, entry] of Object.entries(result))
    if (entry.status !== "not-applicable") assert.equal(entry.status, name === "signature" ? signature : "valid", name);
};
let browserInput: Buffer = Buffer.alloc(0);
let browserPatch: Buffer = Buffer.alloc(0);
const browserSource = await readFile("dist/browser.js");
const worker = `import { patchBuffer } from '/browser.js';
const [rom, patch] = await Promise.all(['/rom', '/patch'].map(async url => new Uint8Array(await (await fetch(url)).arrayBuffer())));
const result = patchBuffer(rom, patch);
const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', result.buffer))].map(value => value.toString(16).padStart(2, '0')).join('');
postMessage({ sha256, dsi: result.dsi });`;
const server = createServer((request, response) => {
  const resources: Record<string, Uint8Array | string> = {
    "/": "<!doctype html><title>DSi verification</title>",
    "/browser.js": browserSource,
    "/worker.js": worker,
    "/rom": browserInput,
    "/patch": browserPatch,
  };
  response.setHeader(
    "Content-Type",
    request.url === "/"
      ? "text/html"
      : request.url?.endsWith(".js")
        ? "application/javascript"
        : "application/octet-stream",
  );
  response.end(resources[request.url ?? "/"]);
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address === "object");
const browser = await chromium.launch({ executablePath: manifest.browserExecutable, headless: true });
const cli = (args: string[]): string =>
  execFileSync(process.execPath, [resolve("dist/cli.js"), ...args], { encoding: "utf8", windowsHide: true });
try {
  for (const entry of manifest.roms) {
    const input = await readFile(entry.path);
    assert.equal(digest(input, "md5"), entry.md5);
    const original = new NDSFile(input, { dsiMode: "complete" });
    assert.equal(original.header.gameCode, entry.gameCode);
    validData(original.verifyDsi(), "valid");
    assert.ok(original.toBuffer().equals(input));
    const decodedSignature = publicDecrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
      original.header.rsa_signature,
    );
    assert.ok(decodedSignature.equals(createHash("sha1").update(input.subarray(0, 0xe00)).digest()));
    const file = original.listFiles().find((file) => file.path.startsWith("data/") && file.size > 16)!;
    const changed = original.getFile(file.path);
    changed[0] ^= 1;
    const arm9 = original.getFile("arm9.bin");
    arm9[0x1000] ^= 1;
    const arm7 = original.getFile("arm7.bin");
    arm7[arm7.length - 1] ^= 1;
    const arm9i = original.getFile("arm9i.bin");
    arm9i[arm9i.length - 1] ^= 1;
    const arm7i = original.getFile("arm7i.bin");
    arm7i[arm7i.length - 1] ^= 1;
    const banner = original.getFile("banner.bin");
    banner[0x20] ^= 1;
    const semanticHeader = new Header(original.getFile("header.bin"));
    semanticHeader.gameTitle = "DSI TEST";
    semanticHeader.ARM9entryAddress += 4;
    const codeHeader = new Header(original.getFile("header.bin"));
    codeHeader.gameCode = `${entry.gameCode.slice(0, 3)}X`;
    const scenarios: [string, Record<string, Uint8Array>][] = [
      ["unchanged", {}],
      ["file-replace", { [file.path]: changed }],
      ["file-shrink", { [file.path]: changed.subarray(0, 7) }],
      ["file-grow", { [file.path]: Buffer.concat([changed, Buffer.alloc(0x100000, 0x35)]) }],
      ["file-add", { "data/DSi/new.bin": Buffer.from("DSi addition") }],
      [
        "combined",
        {
          "data/DSi/new.bin": Buffer.from("DSi addition"),
          "arm9.bin": arm9,
          "arm7.bin": arm7,
          "arm9i.bin": Buffer.concat([arm9i, Buffer.alloc(0x123, 0x42)]),
          "arm7i.bin": arm7i.subarray(0, arm7i.length - 17),
        },
      ],
      ["arm9", { "arm9.bin": arm9 }],
      ["arm7", { "arm7.bin": arm7 }],
      ["arm9i-grow", { "arm9i.bin": Buffer.concat([arm9i, Buffer.alloc(0x123, 0x42)]) }],
      ["arm7i-shrink", { "arm7i.bin": arm7i.subarray(0, arm7i.length - 17) }],
      ["arm9i-empty", { "arm9i.bin": Buffer.alloc(0) }],
      ["arm7i-empty", { "arm7i.bin": Buffer.alloc(0) }],
      ["both-empty", { "arm9i.bin": Buffer.alloc(0), "arm7i.bin": Buffer.alloc(0) }],
      ["arm9i-delta", { "arm9i.bin": Buffer.from("ignored"), "xdelta/arm9i.bin": literalXdelta(arm9i) }],
      ["banner", { "banner.bin": banner }],
      ["header-semantic", { "header.bin": semanticHeader.toBuffer() }],
      ["header-code", { "header.bin": codeHeader.toBuffer() }],
    ];
    if (entry.translatedPath) {
      const translated = new NDSFile(await readFile(entry.translatedPath));
      const files: Record<string, Uint8Array> = {};
      for (const { path } of translated.listFiles()) {
        if (
          !path.startsWith("data/") &&
          !path.startsWith("overlay/") &&
          !["arm9.bin", "arm7.bin", "banner.bin"].includes(path)
        )
          continue;
        const content = translated.getFile(path);
        if (!original.hasFile(path) || !original.getFile(path).equals(content)) files[path] = content;
      }
      scenarios.push(["translated", files]);
    }
    const signedOverlay = original.overlay9Table.entries.find((overlay) => overlay.reserved & 0x2000000);
    if (signedOverlay) {
      const path = `overlay/overlay_${String(signedOverlay.overlayId).padStart(4, "0")}.bin`;
      const data = original.getFile(path);
      data[0] ^= 1;
      scenarios.push(["overlay", { [path]: data }]);
    }
    let workerExpected: ReturnType<typeof patchBuffer> | undefined;
    for (const [name, files] of scenarios) {
      const patch = archive(files);
      const result = patchBuffer(input, patch);
      assert.ok(result.dsi);
      validData(result.dsi, name === "unchanged" ? "valid" : "invalid");
      const reopened = new NDSFile(result.buffer, { dsiMode: "complete" });
      if (name === "header-semantic") {
        assert.equal(reopened.header.ARM9entryAddress, semanticHeader.ARM9entryAddress);
        assert.equal(reopened.header.gameTitle.replace(/\0+$/, ""), "DSI TEST");
      }
      assert.ok(reopened.toBuffer().equals(result.buffer));
      if (name === "both-empty") {
        reopened.addFile("data/DSi/empty-programs.bin", Buffer.from("DSi empty programs"));
        validData(new NDSFile(reopened.toBuffer(), { dsiMode: "complete" }).verifyDsi(), "invalid");
      }
      assert.ok(
        reopened
          .getFile("arm9i.bin")
          .equals(files["xdelta/arm9i.bin"] ? arm9i : (files["arm9i.bin"] ?? original.getFile("arm9i.bin"))),
      );
      assert.ok(reopened.getFile("arm7i.bin").equals(files["arm7i.bin"] ?? original.getFile("arm7i.bin")));
      const path = join(manifest.outputDirectory, `${entry.gameCode}-${name}.nds`);
      await writeFile(path, result.buffer);
      if (name === "translated")
        await writeFile(join(manifest.outputDirectory, `${entry.gameCode}-DSi-translation.xzp`), patch);
      records.push({ gameCode: entry.gameCode, name, path, sha256: digest(result.buffer), dsi: result.dsi });
      if (name === "combined") {
        workerExpected = result;
        browserPatch = patch;
      }
      console.log(`${entry.gameCode}: ${name}`);
    }
    const limited = new NDSFile(input, { dsiMode: "complete", maxOutputSize: input.length - 1 });
    assert.throws(() => limited.toBuffer(), /size limit/);
    const key1Input = Buffer.from(input);
    encryptSecureArea(original.header.gameCode, original.getFile("arm9.bin")).copy(
      key1Input,
      original.header.ARM9romOffset,
    );
    const key1Result = patchBuffer(key1Input, archive({ "header.bin": codeHeader.toBuffer() }));
    assert.ok(key1Result.dsi);
    validData(key1Result.dsi, "invalid");
    const key1Path = join(manifest.outputDirectory, `${entry.gameCode}-key1-code.nds`);
    await writeFile(key1Path, key1Result.buffer);
    records.push({
      gameCode: entry.gameCode,
      name: "key1-code",
      path: key1Path,
      sha256: digest(key1Result.buffer),
      dsi: key1Result.dsi,
    });
    const trimmed = input.subarray(0, original.header.total_rom_size);
    assert.ok(new NDSFile(trimmed, { dsiMode: "complete" }).toBuffer().equals(trimmed));
    const damaged = Buffer.from(input);
    damaged.writeUInt32LE(input.length, 0x1d0);
    assert.throws(() => new NDSFile(damaged, { dsiMode: "complete" }), /range/);
    damaged.set(input.subarray(0, 0x1000), 0);
    damaged.writeUInt32LE(0, 0x200);
    assert.throws(() => new NDSFile(damaged, { dsiMode: "complete" }), /sector size/);
    damaged.set(input.subarray(0, 0x1000), 0);
    damaged.writeUInt32LE(0, 0x1f8);
    assert.throws(() => new NDSFile(damaged, { dsiMode: "complete" }), /DSi block table/);
    const noDigest = Buffer.from(input);
    original.getFile("arm9i.bin").copy(noDigest, original.header.dsi9_rom_offset);
    original.getFile("arm7i.bin").copy(noDigest, original.header.dsi7_rom_offset);
    noDigest.fill(0, 0x1e0, 0x208);
    noDigest.fill(0, 0x220, 0x230);
    noDigest[0x1c] &= ~2;
    noDigest.writeUInt32LE(0, 0x210);
    const omitted = new NDSFile(noDigest, { dsiMode: "complete" });
    assert.equal(omitted.verifyDsi().sectors.status, "not-applicable");
    omitted.replaceFile(file.path, changed);
    assert.equal(new NDSFile(omitted.toBuffer(), { dsiMode: "complete" }).verifyDsi().sectors.status, "not-applicable");
    const patchPath = join(manifest.outputDirectory, `${entry.gameCode}-combined.xzp`);
    await writeFile(patchPath, browserPatch);
    const dryRun = JSON.parse(cli(["patch", "--input", entry.path, "--patch", patchPath, "--json", "--dry-run"])) as {
      outputMd5: string;
    };
    assert.equal(dryRun.outputMd5, workerExpected!.outputMd5);
    const outputPath = join(manifest.outputDirectory, `${entry.gameCode}-cli.nds`);
    cli(["patch", "--input", entry.path, "--patch", patchPath, "--output", outputPath, "--json"]);
    assert.equal(digest(await readFile(outputPath)), digest(workerExpected!.buffer));
    const inspected = JSON.parse(cli(["inspect", "--input", outputPath, "--json", "--dsi-mode", "complete"])) as {
      dsi: DsiVerification;
    };
    assert.deepEqual(inspected.dsi, workerExpected!.dsi);
    const directory = join(manifest.outputDirectory, `${entry.gameCode}-extract`);
    cli(["extract", "--input", outputPath, "--output", directory, "--dsi-mode", "complete", "--json"]);
    assert.ok((await readFile(join(directory, "arm9i.bin"))).equals(Buffer.concat([arm9i, Buffer.alloc(0x123, 0x42)])));
    browserInput = input;
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const actual = await page.evaluate(
      () =>
        new Promise<{ sha256: string; dsi: DsiVerification }>((done, fail) => {
          const worker = new Worker("/worker.js", { type: "module" });
          worker.onmessage = (event: MessageEvent<{ sha256: string; dsi: DsiVerification }>) => {
            done(event.data);
            worker.terminate();
          };
          worker.onerror = (event) => {
            fail(new Error(event.message));
            worker.terminate();
          };
        }),
    );
    assert.equal(actual.sha256, digest(workerExpected!.buffer));
    assert.deepEqual(actual.dsi, workerExpected!.dsi);
    await page.close();
    assert.equal(digest(await readFile(entry.path), "md5"), entry.md5);
  }
  for (const entry of manifest.compatibility) {
    const result = patchBuffer(await readFile(entry.rom), await readFile(entry.patch));
    assert.equal(result.outputMd5, entry.outputMd5, entry.patch);
    console.log(`Compatible: ${entry.patch}`);
  }
  const report = join(manifest.outputDirectory, "results.json");
  await writeFile(report, JSON.stringify(records, null, 2));
  execFileSync(manifest.referenceCommand[0]!, [...manifest.referenceCommand.slice(1), report], {
    stdio: "inherit",
    windowsHide: true,
  });
} finally {
  await browser.close();
  await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
}
