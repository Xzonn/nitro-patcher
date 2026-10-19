import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createRom, makeZip } from "./fixtures";

const run = (args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), ...args], {
    encoding: "utf8",
  });

test("CLI help/version work without a ROM; invalid arguments fail", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /nitro-patcher/);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, /-i, --input/);
  assert.match(help.stdout, /-p, --patch/);
  assert.match(help.stdout, /-o, --output/);
  assert.match(help.stdout, /patch/);
  assert.match(help.stdout, /extract/);
  assert.match(help.stdout, /inspect/);
  assert.equal(run(["--version"]).status, 0);
  assert.equal(run([]).status, 1);
  assert.equal(run(["--bad-option"]).status, 1);
});

test("CLI creates a patched ROM, displays package information and keeps JSON machine-readable", async () => {
  const { NDSFile } = await import("../src/nitro-helper");
  const folder = await mkdtemp(join(tmpdir(), "nitro-cli-"));
  try {
    const original = join(folder, "original.nds"),
      patch = join(folder, "patch.zip"),
      output = join(folder, "output.nds"),
      humanOutput = join(folder, "human-output.nds"),
      namedOutput = join(folder, "named-output.nds"),
      commandOutput = join(folder, "command-output.nds"),
      dryRunOutput = join(folder, "dry-run-output.nds");
    await writeFile(original, createRom());
    await writeFile(
      patch,
      makeZip({
        "data/hello.txt": "CLI works",
        "md5.txt": "0".repeat(32),
        "metadata.json": JSON.stringify({
          id: "cli-patch",
          name: "CLI Patch",
          version: "1.0.0",
          isBeta: true,
        }),
        "README.md": "# Instructions\n\nUse **carefully**.\u001b]52;c;unsafe\u0007",
      }),
    );
    const result = run(["--json", original, patch, output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const metadata = JSON.parse(result.stdout) as {
      returnValue: unknown;
      outputMd5: string;
      metadata: unknown;
      readme: unknown;
    };
    assert.equal(metadata.returnValue, "MD5_MISMATCH");
    assert.deepEqual(metadata.metadata, {
      id: "cli-patch",
      name: "CLI Patch",
      version: "1.0.0",
      isBeta: true,
    });
    assert.deepEqual(metadata.readme, {
      format: "markdown",
      content: "# Instructions\n\nUse **carefully**.\u001b]52;c;unsafe\u0007",
    });
    const human = run([original, patch, humanOutput]);
    assert.equal(human.status, 0, human.stderr);
    assert.equal(human.stderr, "");
    assert.match(human.stdout, /补丁信息/);
    assert.match(human.stdout, /CLI Patch/);
    assert.match(human.stdout, /版本：1\.0\.0（测试版）/);
    assert.doesNotMatch(human.stdout, /ID：|测试版：|cli-patch/);
    assert.match(human.stdout, /补丁说明：/);
    assert.match(human.stdout, /Instructions/);
    assert.match(human.stdout, /Use carefully/);
    assert.equal(human.stdout.includes("\u001b"), false);
    assert.equal(human.stdout.includes("\u0007"), false);
    const named = run(["--json", "--input", original, "--patch", patch, "--output", namedOutput]);
    assert.equal(named.status, 0, named.stderr);
    assert.equal(new NDSFile(await readFile(namedOutput)).getFile("data/hello.txt").toString(), "CLI works");
    const command = run(["patch", "--json", "--input", original, "--patch", patch, "--output", commandOutput]);
    assert.equal(command.status, 0, command.stderr);
    assert.equal(new NDSFile(await readFile(commandOutput)).getFile("data/hello.txt").toString(), "CLI works");
    await writeFile(dryRunOutput, "unchanged");
    const dryRun = run(["--dry-run", "--json", "--input", original, "--patch", patch, "--output", dryRunOutput]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryRunResult = JSON.parse(dryRun.stdout) as { dryRun?: boolean; outputMd5?: string };
    assert.equal(dryRunResult.dryRun, true);
    assert.equal(dryRunResult.outputMd5, metadata.outputMd5);
    assert.equal(await readFile(dryRunOutput, "utf8"), "unchanged");
    const dryRunWithoutOutput = run(["--dry-run", "-i", original, "-p", patch]);
    assert.equal(dryRunWithoutOutput.status, 0, dryRunWithoutOutput.stderr);
    assert.match(dryRunWithoutOutput.stdout, /未写入输出 ROM/);
    assert.equal(new NDSFile(await readFile(output)).getFile("data/hello.txt").toString(), "CLI works");
    await writeFile(patch, Buffer.from("bad ZIP"));
    const failed = run([original, patch, output]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /ZIP/);
    assert.equal(new NDSFile(await readFile(output)).getFile("data/hello.txt").toString(), "CLI works");
    assert.equal(run([original, patch, original]).status, 1);
    assert.equal(run(["--dry-run", original]).status, 1);
    assert.equal(run(["--input", original, "--patch", patch]).status, 1);
    assert.equal(run(["--input", original, patch, output]).status, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("CLI extracts the named ROM tree and inspects ROM metadata", async () => {
  const { NDSFile } = await import("../src/nitro-helper");
  const folder = await mkdtemp(join(tmpdir(), "nitro-cli-rom-"));
  try {
    const inputBytes = createRom({ overlay: Buffer.from("named overlay") });
    const input = join(folder, "game.nds");
    const output = join(folder, "extracted");
    const jsonOutput = join(folder, "extracted-json");
    await writeFile(input, inputBytes);

    const extracted = run(["extract", "--input", input, "--output", output]);
    assert.equal(extracted.status, 0, extracted.stderr);
    assert.equal(extracted.stderr, "");
    assert.match(extracted.stdout, /已提取/);

    const rom = new NDSFile(inputBytes);
    const files = rom.listFiles();
    assert.ok(files.some(({ path }) => path === "header.bin"));
    assert.ok(files.some(({ path }) => path === "arm9.bin"));
    assert.ok(files.some(({ path }) => path === "data/sub/item.bin"));
    assert.ok(files.some(({ path }) => path === "overlay/overlay_0000.bin"));
    await Promise.all(
      files.map(async ({ path }) => assert.deepEqual(await readFile(join(output, path)), rom.getFile(path), path)),
    );

    await writeFile(join(output, "keep.txt"), "keep me");
    await writeFile(join(output, "data/hello.txt"), "stale");
    const existing = run(["extract", "--input", input, "--output", output]);
    assert.equal(existing.status, 0, existing.stderr);
    assert.equal(existing.stderr, "");
    assert.equal(await readFile(join(output, "keep.txt"), "utf8"), "keep me");
    assert.deepEqual(await readFile(join(output, "data/hello.txt")), rom.getFile("data/hello.txt"));

    const extractedJson = run(["extract", "--json", "--input", input, "--output", jsonOutput]);
    assert.equal(extractedJson.status, 0, extractedJson.stderr);
    const extraction = JSON.parse(extractedJson.stdout) as {
      output: string;
      fileCount: number;
      files: string[];
    };
    assert.equal(await realpath(extraction.output), await realpath(jsonOutput));
    assert.equal(extraction.fileCount, files.length);
    assert.deepEqual(
      extraction.files,
      files.map(({ path }) => path),
    );

    const inspected = run(["inspect", "--json", "--input", input]);
    assert.equal(inspected.status, 0, inspected.stderr);
    const info = JSON.parse(inspected.stdout) as {
      gameTitle: string;
      gameCode: string;
      size: number;
      fileCount: number;
      checksums: Record<string, boolean>;
    };
    assert.equal(info.gameTitle, "SYNTHETICROM");
    assert.equal(info.gameCode, "TST0");
    assert.equal(info.size, inputBytes.length);
    assert.equal(info.fileCount, files.length);
    assert.deepEqual(Object.keys(info.checksums), ["header", "logo", "secureArea", "banner"]);

    const human = run(["inspect", "--input", input]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /SYNTHETICROM/);
    assert.match(human.stdout, /TST0/);
    assert.match(human.stdout, /文件数量/);
    assert.match(human.stdout, /校验/);

    assert.equal(run(["extract", input]).status, 1);
    assert.equal(run(["extract", "--input", input, "--output", join(folder, "bad"), "--patch", "bad.zip"]).status, 1);
    assert.equal(run(["inspect", "--input", input, "--output", join(folder, "bad")]).status, 1);
    assert.equal(run(["unknown", "--input", input]).status, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("CLI applies format 2 and rejects unknown formats before writing output", async () => {
  const { NDSFile } = await import("../src/nitro-helper");
  const folder = await mkdtemp(join(tmpdir(), "nitro-cli-format-"));
  try {
    const original = join(folder, "original.nds");
    const patch = join(folder, "patch.xzp");
    const output = join(folder, "output.nds");
    await writeFile(original, createRom());
    await writeFile(patch, makeZip({ "metadata.json": '{"formatVersion":2}', "data/日本語/New.bin": "added" }));
    const result = run(["--json", original, patch, output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(new NDSFile(await readFile(output)).getFile("data/日本語/New.bin").toString(), "added");
    const metadata = JSON.parse(result.stdout) as { outputMd5: string; metadata: { formatVersion: number } };
    assert.equal(metadata.metadata.formatVersion, 2);
    const dryRun = run(["--json", "--dry-run", "-i", original, "-p", patch]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal((JSON.parse(dryRun.stdout) as { outputMd5: string }).outputMd5, metadata.outputMd5);
    await writeFile(patch, makeZip({ "metadata.json": '{"formatVersion":3}' }));
    const previous = await readFile(output);
    const failed = run([original, patch, output]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Unsupported XZP/);
    assert.deepEqual(await readFile(output), previous);
    const missing = join(folder, "missing.nds");
    assert.equal(run([original, patch, missing]).status, 1);
    await assert.rejects(readFile(missing), { code: "ENOENT" });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
