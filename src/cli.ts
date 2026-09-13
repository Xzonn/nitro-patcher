#!/usr/bin/env node
import { mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { render } from 'markdansi';
import { patchBuffer, readPatchInfo, type PatchMetadata } from './nitro-patch-helper';

const help = `nitro-patcher — 原生 Node.js NDS ROM 补丁工具

用法：nitro-patcher [--json] [--dry-run] <原始ROM> <补丁ZIP> [输出ROM]

  --json         输出 JSON 状态和 MD5
  --dry-run      完整执行补丁流程，但不写入输出 ROM
  -h, --help     显示帮助
  -v, --version  显示版本`;

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

const safeTerminalText = (value: string): string => {
  const characters: string[] = [];
  for (const character of value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')) {
    const code = character.codePointAt(0)!;
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      continue;
    characters.push(character);
  }
  return characters.join('');
};

const formatMetadata = (metadata: PatchMetadata): string => {
  const labels = {
    author: '作者',
    name: '名称',
    homepage: '主页',
    version: '版本',
  } as const;
  const lines: string[] = [];
  for (const field of ['author', 'name', 'homepage', 'version'] as const) {
    const value = metadata[field];
    if (value === undefined) continue;
    const suffix = field === 'version' && metadata.isBeta ? '（测试版）' : '';
    lines.push(`- ${labels[field]}：${safeTerminalText(value).replaceAll('\n', ' ')}${suffix}`);
  }
  return lines.join('\n');
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
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
  const dryRun = values['dry-run'] ?? false;
  if (
    (!dryRun && positionals.length !== 3) ||
    (dryRun && (positionals.length < 2 || positionals.length > 3))
  )
    throw new Error(help);
  const [original, patch, output] = positionals;
  if (!dryRun) {
    if (!output) throw new Error(help);
    if ((await sameFile(original, output)) || (await sameFile(patch, output)))
      throw new Error('输出路径不能覆盖原始 ROM 或补丁包。');
  }
  const [originalBytes, patchBytes] = await Promise.all([readFile(original), readFile(patch)]);
  const info = readPatchInfo(patchBytes);
  const result = patchBuffer(originalBytes, patchBytes);
  if (!dryRun) {
    if (!output) throw new Error(help);
    const destination = join(await realpath(dirname(resolve(output))), basename(output));
    const temporary = await mkdtemp(join(dirname(destination), '.nitro-patcher-'));
    try {
      const file = join(temporary, 'output.nds');
      await writeFile(file, result.buffer);
      await rename(file, destination);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const { returnValue, inputMd5, outputMd5 } = result;
  if (values.json) {
    console.log(
      JSON.stringify({
        returnValue,
        inputMd5,
        outputMd5,
        ...info,
        ...(dryRun && { dryRun: true }),
      }),
    );
    return;
  }

  const sections: string[] = [];
  if (info.metadata) {
    const metadata = formatMetadata(info.metadata);
    if (metadata) sections.push(`补丁元数据：\n\n${metadata}`);
  }
  if (info.readme) {
    const content = safeTerminalText(info.readme.content);
    const rendered =
      info.readme.format === 'markdown'
        ? render(content, {
            width: process.stdout.columns ?? 80,
            color: Boolean(process.stdout.isTTY),
            hyperlinks: false,
          })
        : content;
    sections.push(`补丁说明：\n\n${rendered.trimEnd()}`);
  }
  if (dryRun) sections.push('试运行完成，未写入输出 ROM。');
  sections.push(`${returnValue}\n\n原始 ROM 的 MD5：${inputMd5}\n生成 ROM 的 MD5：${outputMd5}`);
  console.log(sections.join('\n\n'));
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
