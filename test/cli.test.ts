import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRom, makeZip } from './fixtures';

const run = (args: string[]) =>
  spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args],
    { encoding: 'utf8' },
  );

test('CLI help/version work without a ROM; invalid arguments fail', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /nitro-patcher/);
  assert.equal(run(['--version']).status, 0);
  assert.equal(run([]).status, 1);
  assert.equal(run(['--bad-option']).status, 1);
});

test('CLI creates real patched ROM, emits JSON metadata and handles failures without partial output', async () => {
  const { NDSFile } = await import('../src/nitro-helper');
  const folder = await mkdtemp(join(tmpdir(), 'nitro-cli-'));
  try {
    const original = join(folder, 'original.nds'),
      patch = join(folder, 'patch.zip'),
      output = join(folder, 'output.nds');
    await writeFile(original, createRom());
    await writeFile(patch, makeZip({ 'data/hello.txt': 'CLI works', 'md5.txt': '0'.repeat(32) }));
    const result = run(['--json', original, patch, output]);
    assert.equal(result.status, 0, result.stderr);
    const metadata: unknown = JSON.parse(result.stdout);
    assert.ok(metadata && typeof metadata === 'object' && 'returnValue' in metadata);
    assert.equal(metadata.returnValue, 'MD5_MISMATCH');
    assert.equal(
      new NDSFile(await readFile(output)).getFile('data/hello.txt').toString(),
      'CLI works',
    );
    await writeFile(patch, Buffer.from('bad ZIP'));
    const failed = run([original, patch, output]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /ZIP/);
    assert.equal(
      new NDSFile(await readFile(output)).getFile('data/hello.txt').toString(),
      'CLI works',
    );
    assert.equal(run([original, patch, original]).status, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
