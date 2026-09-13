import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRom, makeZip } from '../test/fixtures';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli || !process.env.npm_config_user_agent?.startsWith('pnpm/')) {
  throw new Error('Run this smoke test through pnpm run test:package [package.tgz]');
}
if (process.argv.length > 3) {
  throw new Error('Expected at most one tarball argument');
}

const temporary = await mkdtemp(join(tmpdir(), 'nitro-patcher-package-'));
const runNode = (args: string[], cwd: string): string =>
  execFileSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
const runPnpm = (args: string[], cwd: string): void => {
  // Calling pnpm's JavaScript entrypoint avoids shell/cmd quoting and works on
  // Windows, macOS and Linux, including workspace paths containing spaces.
  process.stdout.write(runNode([pnpmCli, '--dir', cwd, ...args], cwd));
};

try {
  let tarball: string;
  if (process.argv[2]) {
    tarball = resolve(process.argv[2]);
  } else {
    runPnpm(['pack', '--pack-destination', temporary], root);
    const archives = (await readdir(temporary)).filter((name) => name.endsWith('.tgz'));
    assert.equal(archives.length, 1, 'pnpm pack must produce exactly one tarball');
    tarball = join(temporary, archives[0]!);
  }

  await writeFile(
    join(temporary, 'package.json'),
    JSON.stringify({
      name: 'nitro-patcher-consumer-smoke',
      private: true,
      type: 'module',
    }),
  );
  runPnpm(['add', '--ignore-scripts', tarball], temporary);

  await access(
    join(
      temporary,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'nitro-patcher.cmd' : 'nitro-patcher',
    ),
  );
  const help = runNode([pnpmCli, '--dir', temporary, 'exec', 'nitro-patcher', '--help'], temporary);
  assert.match(help, /nitro-patcher/i, 'installed CLI must print its usage');
  await writeFile(join(temporary, 'source.nds'), createRom({ hello: 'before package patch\n' }));
  await writeFile(
    join(temporary, 'patch.zip'),
    makeZip({
      'data/hello.txt': 'after package patch\n',
      'metadata.json': JSON.stringify({
        author: 'Example Team',
        name: 'Package Patch',
        homepage: 'https://example.com',
        version: '1.0.0',
        isBeta: false,
      }),
    }),
  );

  // This file is executed and compiled outside the repository. Its package
  // imports can resolve only the installed tarball, never workspace sources.
  const consumer = `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NDSFile, PatchHelper, patchBuffer, patchIt, readPatchMetadata, readPatchMetadataFile } from 'nitro-patcher';
import { NDSFile as HelperNDSFile } from 'nitro-patcher/nitro-helper';
import { PatchHelper as HelperPatchHelper } from 'nitro-patcher/nitro-patch-helper';

assert.equal(NDSFile, HelperNDSFile);
assert.equal(PatchHelper, HelperPatchHelper);
const source = readFileSync(new URL('./source.nds', import.meta.url));
const archive = readFileSync(new URL('./patch.zip', import.meta.url));
const metadata = readPatchMetadata(archive);
assert.equal(metadata?.name, 'Package Patch');
assert.equal((await readPatchMetadataFile('./patch.zip'))?.isBeta, false);
assert.deepEqual(PatchHelper.readPatchMetadata(archive), metadata);
const original = new NDSFile(source);
assert.equal(original.getFile('data/hello.txt').toString(), 'before package patch\\n');
const result = patchBuffer(source, archive);
const viaClass: ReturnType<typeof patchBuffer> = PatchHelper.patchBuffer(source, archive);
assert.deepEqual(result.buffer, viaClass.buffer);
const output: Buffer = result.buffer;
const reopened = new NDSFile(output);
assert.equal(reopened.getFile('data/hello.txt').toString(), 'after package patch\\n');
assert.deepEqual(reopened.getFile('data/sub/item.bin'), original.getFile('data/sub/item.bin'));
const repacked: Buffer = reopened.toBuffer();
assert.equal(new NDSFile(repacked).getFile('data/hello.txt').toString(), 'after package patch\\n');
const fromFiles: Awaited<ReturnType<typeof patchIt>> = await patchIt('./source.nds', './patch.zip');
assert.deepEqual(fromFiles.buffer, output);
if (false) {
  // @ts-expect-error ROM bytes cannot be a filename string.
  new NDSFile('source.nds');
  // @ts-expect-error Patches must contain bytes, not a number.
  patchBuffer(source, 123);
  // @ts-expect-error Resource budgets must be numeric.
  PatchHelper.patchBuffer(source, archive, { maxOutputSize: 'unlimited' });
  // @ts-expect-error Unknown options must not be silently accepted.
  patchBuffer(source, archive, { inventedOption: true });
  // @ts-expect-error Return values are a literal union, not arbitrary strings.
  result.returnValue = 'UNKNOWN';
  // @ts-expect-error Generated output is a Buffer, not a string.
  const invalidOutput: string = result.buffer;
  void invalidOutput;
}
console.log('Installed package CLI, root/subpath API, patch roundtrip and declarations passed');
`;
  await writeFile(join(temporary, 'consumer.ts'), consumer);
  await writeFile(
    join(temporary, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noEmitOnError: true,
        skipLibCheck: false,
        types: ['node'],
        typeRoots: [join(root, 'node_modules', '@types')],
      },
      files: ['consumer.ts'],
    }),
  );
  process.stdout.write(
    runNode([join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', temporary], temporary),
  );
  process.stdout.write(runNode([join(temporary, 'consumer.js')], temporary));
  // Check the installed browser declaration with no ambient Node types and
  // without skipping declaration checks, independent of the frontend tsconfig.
  await writeFile(
    join(temporary, 'browser-consumer.ts'),
    `
import { patchBuffer, inspectRom, readPatchMetadata, PatchHelper, NitroHelper } from 'nitro-patcher/browser';
export const check = (rom: Uint8Array, patch: Uint8Array): Blob => {
  const result = patchBuffer(rom, patch);
  const bytes: Uint8Array<ArrayBuffer> = result.buffer;
  const state: 'SUCCESS' | 'MD5_MISMATCH' = result.returnValue;
  const count: number = inspectRom(rom).fileCount;
  const code: string = NitroHelper.inspectRom(rom).gameCode;
  const patchName: string | undefined = readPatchMetadata(patch)?.name;
  PatchHelper.patchBuffer(rom, patch, { maxOutputSize: 1024 });
  // @ts-expect-error Browser bytes have no Node Buffer methods.
  result.buffer.readUInt32LE(0);
  // @ts-expect-error Browser input is bytes, not a local filesystem path.
  patchBuffer('rom.nds', patch);
  // @ts-expect-error An unknown result state must be rejected.
  const invalid: typeof state = 'OTHER';
  void invalid; void count; void code; void patchName;
  return new Blob([bytes]);
};
`,
  );
  await writeFile(
    join(temporary, 'tsconfig.browser.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022', 'DOM'],
        types: [],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: false,
        noEmit: true,
      },
      files: ['browser-consumer.ts'],
    }),
  );
  process.stdout.write(
    runNode(
      [
        join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        join(temporary, 'tsconfig.browser.json'),
      ],
      temporary,
    ),
  );
  console.log('Installed browser declarations passed without Node types or skipLibCheck');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
