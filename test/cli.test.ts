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
  assert.match(help.stdout, /--dry-run/);
  assert.equal(run(['--version']).status, 0);
  assert.equal(run([]).status, 1);
  assert.equal(run(['--bad-option']).status, 1);
});

test('CLI creates a patched ROM, displays package information and keeps JSON machine-readable', async () => {
  const { NDSFile } = await import('../src/nitro-helper');
  const folder = await mkdtemp(join(tmpdir(), 'nitro-cli-'));
  try {
    const original = join(folder, 'original.nds'),
      patch = join(folder, 'patch.zip'),
      output = join(folder, 'output.nds'),
      humanOutput = join(folder, 'human-output.nds'),
      dryRunOutput = join(folder, 'dry-run-output.nds');
    await writeFile(original, createRom());
    await writeFile(
      patch,
      makeZip({
        'data/hello.txt': 'CLI works',
        'md5.txt': '0'.repeat(32),
        'metadata.json': JSON.stringify({
          id: 'cli-patch',
          name: 'CLI Patch',
          version: '1.0.0',
          isBeta: true,
        }),
        'README.md': '# Instructions\n\nUse **carefully**.\u001b]52;c;unsafe\u0007',
      }),
    );
    const result = run(['--json', original, patch, output]);
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(result.stdout) as {
      returnValue: unknown;
      outputMd5: string;
      metadata: unknown;
      readme: unknown;
    };
    assert.equal(metadata.returnValue, 'MD5_MISMATCH');
    assert.deepEqual(metadata.metadata, {
      id: 'cli-patch',
      name: 'CLI Patch',
      version: '1.0.0',
      isBeta: true,
    });
    assert.deepEqual(metadata.readme, {
      format: 'markdown',
      content: '# Instructions\n\nUse **carefully**.\u001b]52;c;unsafe\u0007',
    });
    const human = run([original, patch, humanOutput]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /补丁元数据/);
    assert.match(human.stdout, /CLI Patch/);
    assert.match(human.stdout, /版本：1\.0\.0（测试版）/);
    assert.doesNotMatch(human.stdout, /ID：|测试版：|cli-patch/);
    assert.match(human.stdout, /补丁说明：/);
    assert.match(human.stdout, /Instructions/);
    assert.match(human.stdout, /Use carefully/);
    assert.equal(human.stdout.includes('\u001b'), false);
    assert.equal(human.stdout.includes('\u0007'), false);
    await writeFile(dryRunOutput, 'unchanged');
    const dryRun = run(['--dry-run', '--json', original, patch, dryRunOutput]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryRunResult = JSON.parse(dryRun.stdout) as { dryRun?: boolean; outputMd5?: string };
    assert.equal(dryRunResult.dryRun, true);
    assert.equal(dryRunResult.outputMd5, metadata.outputMd5);
    assert.equal(await readFile(dryRunOutput, 'utf8'), 'unchanged');
    const dryRunWithoutOutput = run(['--dry-run', original, patch]);
    assert.equal(dryRunWithoutOutput.status, 0, dryRunWithoutOutput.stderr);
    assert.match(dryRunWithoutOutput.stdout, /未写入输出 ROM/);
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
    assert.equal(run(['--dry-run', original]).status, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
