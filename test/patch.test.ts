import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createRom, literalXdelta, makeZip } from "./fixtures";

test("reads and validates patch metadata field by field", async () => {
  const { readPatchMetadata } = await import("../src/nitro-patch-helper");
  const expected = {
    id: "example-patch",
    author: "Example Team",
    name: "Example Translation",
    homepage: "https://example.com/patch",
    version: "1.2.3",
    isBeta: true,
  };

  assert.deepEqual(readPatchMetadata(makeZip({ "MeTaDaTa.JsOn": JSON.stringify(expected) })), expected);
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...arguments_) => warnings.push(arguments_);
  try {
    assert.equal(readPatchMetadata(makeZip({ "md5.txt": "0".repeat(32) })), null);
    assert.equal(warnings.length, 0);
    assert.equal(readPatchMetadata(makeZip({ "metadata.json": "{" })), null);
    assert.deepEqual(readPatchMetadata(makeZip({ "metadata.json": JSON.stringify({ ...expected, id: undefined }) })), {
      author: expected.author,
      name: expected.name,
      homepage: expected.homepage,
      version: expected.version,
      isBeta: expected.isBeta,
    });
    assert.equal(warnings.length, 1);
    assert.deepEqual(readPatchMetadata(makeZip({ "metadata.json": JSON.stringify({ ...expected, isBeta: "yes" }) })), {
      id: expected.id,
      author: expected.author,
      name: expected.name,
      homepage: expected.homepage,
      version: expected.version,
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
  assert.match(String(warnings[0]?.[0]), /metadata\.json/);
  assert.match(String(warnings[1]?.[0]), /isBeta/);
});

test("reads a root patch README with Markdown preferred over plain text", async () => {
  const { readPatchInfo, readPatchReadme } = await import("../src/nitro-patch-helper");
  const markdown = "# Patch instructions\n\nApply carefully.";
  const archive = makeZip({
    "README.txt": "Plain instructions",
    "ReadMe.Md": markdown,
  });
  assert.deepEqual(readPatchReadme(archive), { format: "markdown", content: markdown });
  assert.deepEqual(readPatchInfo(archive), {
    metadata: null,
    readme: { format: "markdown", content: markdown },
  });
  assert.deepEqual(readPatchReadme(makeZip({ "README.txt": "Plain instructions" })), {
    format: "plaintext",
    content: "Plain instructions",
  });
  assert.equal(readPatchReadme(makeZip({})), null);
});

test("extracts one ZIP entry with normalized case-insensitive paths", async () => {
  const { extractZipEntry } = await import("../src/nitro-patch-helper");
  const archive = makeZip({ "Patches\\Example.xzp": "patch bytes" });
  assert.equal(extractZipEntry(archive, "patches/example.xzp").toString(), "patch bytes");
  assert.throws(() => extractZipEntry(archive, "missing.xzp"), /not found/);
  assert.throws(() => extractZipEntry(archive, ""), /non-empty/);
});

test("invalid UTF-8 README is warned about and falls back to README.txt", async () => {
  const { readPatchReadme } = await import("../src/nitro-patch-helper");
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...arguments_) => warnings.push(arguments_);
  try {
    assert.deepEqual(
      readPatchReadme(makeZip({ "README.md": Buffer.from([0xff]), "README.txt": "Fallback instructions" })),
      { format: "plaintext", content: "Fallback instructions" },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0]), /README\.md/);
});

test("patch helper replaces case-insensitive paths, ignores extra files and returns original/output MD5", async () => {
  const { patchBuffer } = await import("../src/nitro-patch-helper");
  const { NDSFile } = await import("../src/nitro-helper");
  const input = createRom();
  const digest = createHash("md5").update(input).digest("hex");
  const result = patchBuffer(
    input,
    makeZip({
      "DATA/HELLO.TXT": "patched",
      "data/new.txt": "ignored",
      "md5.txt": `# comment\n${digest.toUpperCase()}\n`,
    }),
  );
  assert.equal(result.returnValue, "SUCCESS");
  assert.equal(result.inputMd5, digest);
  assert.equal(result.outputMd5, createHash("md5").update(result.buffer).digest("hex"));
  const output = new NDSFile(result.buffer);
  assert.equal(output.getFile("data/hello.txt").toString(), "patched");
  assert.equal(output.hasFile("data/new.txt"), false);
});

test("MD5 mismatch preserves existing output behavior; malformed list fails", async () => {
  const { patchBuffer } = await import("../src/nitro-patch-helper");
  const input = createRom();
  const result = patchBuffer(input, makeZip({ "md5.txt": "0".repeat(32) }));
  assert.equal(result.returnValue, "MD5_MISMATCH");
  assert.ok(result.buffer.length);
  assert.throws(() => patchBuffer(input, makeZip({ "md5.txt": "bad checksum" })), /md5.txt/);
});

test("Xdelta overrides direct replacement and preprocessing uses original MD5", async () => {
  const { patchBuffer } = await import("../src/nitro-patch-helper");
  const { NDSFile } = await import("../src/nitro-helper");
  const vint = (value: number): number[] => {
    const out = [value & 127];
    while ((value = Math.floor(value / 128))) out.unshift((value & 127) | 128);
    return out;
  };
  const literal = (target: Buffer): Buffer => {
    const inst = Buffer.from([1, ...vint(target.length)]);
    const delta = Buffer.concat([
      Buffer.from([...vint(target.length), 0, ...vint(target.length), ...vint(inst.length), 0]),
      target,
      inst,
    ]);
    return Buffer.concat([Buffer.from([0xd6, 0xc3, 0xc4, 0, 0, 0, ...vint(delta.length)]), delta]);
  };
  const input = createRom(),
    preprocessed = createRom({ item: "preprocessed" });
  const md5 = createHash("md5").update(input).digest("hex");
  const result = patchBuffer(
    input,
    makeZip({
      [`preprocessing/${md5}.xdelta`]: literal(preprocessed),
      "data/hello.txt": "direct",
      "xdelta/data/hello.txt": literal(Buffer.from("delta")),
      "md5.txt": md5,
    }),
  );
  const rom = new NDSFile(result.buffer);
  assert.equal(result.returnValue, "SUCCESS");
  assert.equal(rom.getFile("data/hello.txt").toString(), "delta");
  assert.equal(rom.getFile("data/sub/item.bin").toString(), "preprocessed");
});

test("output allocation and ZIP expansion limits apply across the patch pipeline", async () => {
  const { patchBuffer } = await import("../src/nitro-patch-helper");
  assert.throws(
    () =>
      patchBuffer(createRom(), makeZip({ "data/hello.txt": "too much" }), {
        maxUncompressedSize: 1,
      }),
    /limit|size/i,
  );
  assert.throws(() => patchBuffer(createRom(), makeZip({}), { maxOutputSize: 1024 }), /limit/i);
});

test("XZP format versions are validated before ROM parsing and preprocessing", async () => {
  const { patchBuffer, readPatchMetadata, readPatchInfo } = await import("../src/nitro-patch-helper");
  const input = createRom();
  const digest = createHash("md5").update(input).digest("hex");
  for (const formatVersion of [0, -1, 1.5, null, true, "2", Number.MAX_SAFE_INTEGER + 1, 3]) {
    const archive = makeZip({
      "metadata.json": JSON.stringify({ formatVersion }),
      [`preprocessing/${digest}.xdelta`]: "invalid delta",
    });
    const error = formatVersion === 3 ? /Unsupported XZP format version/ : /formatVersion/;
    assert.throws(() => patchBuffer(input, archive), error);
    assert.throws(() => patchBuffer(Buffer.alloc(0), archive), error);
    assert.throws(() => readPatchMetadata(archive), error);
    assert.throws(() => readPatchInfo(archive), error);
  }
  for (const formatVersion of [1, 2])
    assert.deepEqual(readPatchMetadata(makeZip({ "metadata.json": JSON.stringify({ formatVersion }) })), {
      formatVersion,
    });
});

test("missing or damaged metadata uses format 1 and content-only format 2 preserves legacy bytes", async () => {
  const { patchBuffer } = await import("../src/nitro-patch-helper");
  const input = createRom({ overlay: true });
  const entries = { "data/hello.txt": "changed", "data/new.bin": "ignored" };
  const legacy = patchBuffer(input, makeZip(entries)).buffer;
  for (const metadata of ["{}", '{"formatVersion":1}', "{", Buffer.from([0xff]), "null", "[]", "2"])
    assert.deepEqual(patchBuffer(input, makeZip({ ...entries, "metadata.json": metadata })).buffer, legacy);
  const contents = { "data/hello.txt": "changed" };
  assert.deepEqual(
    patchBuffer(input, makeZip({ ...contents, "metadata.json": '{"formatVersion":2}' })).buffer,
    patchBuffer(input, makeZip(contents)).buffer,
  );
});

test("format 2 adds full files and empty-source deltas with deterministic names and priority", async () => {
  const { patchBuffer } = await import("../src/nitro-patch-helper");
  const { NDSFile } = await import("../src/nitro-helper");
  const additions = [
    ["metadata.json", '{"formatVersion":2}'],
    ["data/SUB/Extra.bin", "extra"],
    ["data/New/Empty.bin", ""],
    ["data/new/Other.bin", "other"],
    ["data/Delta.txt", "direct"],
    ["xdelta/data/DELTA.txt", Buffer.from("d6c3c40000000b050005010048656c6c6f06", "hex")],
    ["data/日本語/名前.bin", "Japanese"],
    ["unused/extra.bin", "ignored"],
    ["data/EmptyDirectory/", ""],
  ] as const;
  const input = createRom();
  const result = patchBuffer(input, makeZip(additions));
  assert.deepEqual(result.buffer, patchBuffer(input, makeZip([...additions].reverse())).buffer);
  const rom = new NDSFile(result.buffer);
  assert.equal(rom.getFile("data/sub/extra.bin").toString(), "extra");
  assert.equal(rom.getFile("data/new/empty.bin").length, 0);
  assert.equal(rom.getFile("data/new/other.bin").toString(), "other");
  assert.equal(rom.getFile("data/delta.txt").toString(), "Hello");
  assert.equal(rom.getFile("data/日本語/名前.bin").toString(), "Japanese");
  const paths = rom.listFiles().map((entry) => entry.path);
  assert.ok(paths.includes("data/DELTA.txt"));
  assert.ok(paths.includes("data/sub/Extra.bin"));
  assert.ok(paths.includes("data/New/Other.bin"));
  assert.equal(
    rom.data.folders.some((folder) => folder.name === "EmptyDirectory"),
    false,
  );
  assert.deepEqual(rom.getFile("data/hello.txt"), new NDSFile(input).getFile("data/hello.txt"));
});

test("format 2 rejects missing delta sources, invalid paths and FNT conflicts", async () => {
  const { patchBuffer } = await import("../src/nitro-patch-helper");
  const { NDSFile } = await import("../src/nitro-helper");
  const input = createRom();
  const metadata = { "metadata.json": '{"formatVersion":2}' };
  for (const path of ["data/../file", "data//file", "data/hello.txt/file", "data/sub", "data/😀.bin"])
    assert.throws(() => patchBuffer(input, makeZip({ ...metadata, [path]: "new" })), /path|Shift_JIS/i);
  const sourceCopy = Buffer.from([0xd6, 0xc3, 0xc4, 0, 0, 1, 1, 0, 8, 1, 0, 0, 2, 1, 19, 1, 0]);
  assert.throws(() => patchBuffer(input, makeZip({ ...metadata, "xdelta/data/new.bin": sourceCopy })), /source|range/i);
  const fnt = new NDSFile(input).getFile("fnt.bin");
  for (const path of ["fnt.bin", "xdelta/fnt.bin"])
    assert.throws(
      () =>
        patchBuffer(
          input,
          makeZip({
            ...metadata,
            [path]: path.startsWith("xdelta/") ? literalXdelta(fnt) : fnt,
            "data/new.bin": "new",
          }),
        ),
      /conflict/i,
    );
  const output = patchBuffer(input, makeZip({ ...metadata, "fnt.bin": fnt })).buffer;
  assert.deepEqual(new NDSFile(output).getFile("fnt.bin"), fnt);
});

test("format 2 determines additions after preprocessing and uses the final duplicate spelling", async () => {
  const { patchBuffer } = await import("../src/nitro-patch-helper");
  const { NDSFile } = await import("../src/nitro-helper");
  const input = createRom();
  const prepared = new NDSFile(input);
  prepared.addFile("data/Prepared.bin", Buffer.from("before"));
  const digest = createHash("md5").update(input).digest("hex");
  const result = patchBuffer(
    input,
    makeZip([
      ["metadata.json", '{"formatVersion":2}'],
      [`preprocessing/${digest}.xdelta`, literalXdelta(prepared.toBuffer())],
      ["data/PREPARED.bin", "replaced"],
      ["data/New.BIN", "first"],
      ["data/NEW.bin", "last"],
    ]),
  );
  const rom = new NDSFile(result.buffer);
  assert.equal(rom.getFile("data/prepared.bin").toString(), "replaced");
  assert.equal(rom.getFile("data/new.bin").toString(), "last");
  assert.ok(rom.listFiles().some(({ path }) => path === "data/NEW.bin"));
  assert.ok(rom.listFiles().some(({ path }) => path === "data/Prepared.bin"));
});
