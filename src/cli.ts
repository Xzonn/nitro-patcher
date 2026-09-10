#!/usr/bin/env node
import { mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { patchIt } from './nitro-patch-helper';

const help = `nitro-patcher — 原生 Node.js NDS ROM 补丁工具

用法：nitro-patcher [--json] <原始ROM> <补丁ZIP> <输出ROM>

  --json        输出 JSON 状态和 MD5
  -h, --help    显示帮助
  -v, --version 显示版本`;

const sameFile = async (input: string, output: string): Promise<boolean> => {
  if (resolve(input) === resolve(output)) return true;
  const original = await stat(input);
  try {
    const destination = await stat(output);
    return original.dev === destination.dev && original.ino === destination.ino;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return false;
  }
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (values.version) {
    const metadata: unknown = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('version' in metadata) ||
      typeof metadata.version !== 'string'
    )
      throw new Error('Invalid package version metadata');
    console.log(metadata.version);
    return;
  }
  if (positionals.length !== 3) throw new Error(help);
  const [original, patch, output] = positionals;
  if ((await sameFile(original, output)) || (await sameFile(patch, output)))
    throw new Error('输出路径不能覆盖原始 ROM 或补丁包。');
  const result = await patchIt(original, patch);
  const destination = join(await realpath(dirname(resolve(output))), basename(output));
  const temporary = await mkdtemp(join(dirname(destination), '.nitro-patcher-'));
  try {
    const file = join(temporary, 'output.nds');
    await writeFile(file, result.buffer);
    await rename(file, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const { returnValue, inputMd5, outputMd5 } = result;
  if (values.json) console.log(JSON.stringify({ returnValue, inputMd5, outputMd5 }));
  else console.log(`${returnValue}\n\n原始 ROM 的 MD5：${inputMd5}\n生成 ROM 的 MD5：${outputMd5}`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
