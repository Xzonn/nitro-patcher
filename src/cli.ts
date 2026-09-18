#!/usr/bin/env node
import { render } from "markdansi";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { NDSFile } from "./nitro/nds-file";
import { type PatchMetadata, patchBuffer, readPatchInfo } from "./nitro-patch-helper";

const help = `nitro-patcher — NDS ROM 补丁工具

用法：
  nitro-patcher [--json] [--dry-run] <原始ROM> <补丁ZIP> [输出ROM]
  nitro-patcher patch [--json] [--dry-run] --input <原始ROM> --patch <补丁ZIP> [--output <输出ROM>]
  nitro-patcher extract [--json] --input <ROM> --output <目录>
  nitro-patcher inspect [--json] --input <ROM>

  --json         结果输出为 JSON 格式
  --dry-run      完整执行补丁流程，但不写入输出 ROM
  -i, --input    输入 ROM 路径
  -p, --patch    补丁 ZIP 路径
  -o, --output   输出 ROM 或提取目录；试运行时可省略
  -h, --help     显示帮助
  -v, --version  显示版本`;

interface CommandOptions {
  json: boolean;
  dryRun: boolean;
  input: string | undefined;
  patch: string | undefined;
  output: string | undefined;
}

const sameFile = async (input: string, output: string): Promise<boolean> => {
  if (resolve(input) === resolve(output)) return true;
  const original = await stat(input);
  try {
    const destination = await stat(output);
    return original.dev === destination.dev && original.ino === destination.ino;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return false;
  }
};

const safeTerminalText = (value: string): string => {
  const characters: string[] = [];
  for (const character of value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")) {
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
  return characters.join("");
};

const formatMetadata = (metadata: PatchMetadata): string => {
  const labels = {
    author: "作者",
    name: "名称",
    homepage: "主页",
    version: "版本",
  } as const;
  const lines: string[] = [];
  for (const field of ["author", "name", "homepage", "version"] as const) {
    const value = metadata[field];
    if (value === undefined) continue;
    const suffix = field === "version" && metadata.isBeta ? "（测试版）" : "";
    lines.push(`- ${labels[field]}：${safeTerminalText(value).replaceAll("\n", " ")}${suffix}`);
  }
  return lines.join("\n");
};

const extractRom = async (options: CommandOptions): Promise<void> => {
  if (!options.input || !options.output || options.patch !== undefined || options.dryRun) throw new Error(help);
  const destination = join(await realpath(dirname(resolve(options.output))), basename(resolve(options.output)));
  const rom = new NDSFile(await readFile(options.input));
  const files = rom.listFiles();
  await mkdir(destination, { recursive: true });
  for (const { path } of files) {
    const output = resolve(destination, path);
    if (!output.startsWith(`${destination}${sep}`)) throw new Error(`ROM 文件路径超出输出目录：${path}`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, rom.getFile(path));
  }

  if (options.json) {
    console.log(
      JSON.stringify({
        output: destination,
        fileCount: files.length,
        files: files.map(({ path }) => path),
      }),
    );
  } else {
    console.log(`已提取 ${files.length} 个文件到：${destination}`);
  }
};

const inspectRom = async (options: CommandOptions): Promise<void> => {
  if (!options.input || options.patch !== undefined || options.output !== undefined || options.dryRun)
    throw new Error(help);
  const input = await readFile(options.input);
  const rom = new NDSFile(input);
  const info = {
    gameTitle: rom.header.gameTitle.replace(/\0+$/, ""),
    gameCode: rom.header.gameCode,
    size: input.length,
    fileCount: rom.listFiles().length,
    checksums: {
      header: rom.header.headerCRC,
      logo: rom.header.logoCRC,
      secureArea: rom.header.secureCRC,
      banner: rom.banner.bannerCRC,
    },
  };
  if (options.json) {
    console.log(JSON.stringify(info));
    return;
  }
  console.log(`ROM 信息：

标题：${safeTerminalText(info.gameTitle).replaceAll("\n", " ")}
游戏代码：${safeTerminalText(info.gameCode).replaceAll("\n", " ")}
大小：${info.size} 字节
文件数量：${info.fileCount}
校验：
- Header：${info.checksums.header ? "通过" : "失败"}
- Logo：${info.checksums.logo ? "通过" : "失败"}
- Secure Area：${info.checksums.secureArea ? "通过" : "失败"}
- Banner：${info.checksums.banner ? "通过" : "失败"}`);
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      input: { type: "string", short: "i" },
      patch: { type: "string", short: "p" },
      output: { type: "string", short: "o" },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (values.version) {
    const metadata: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    if (!metadata || typeof metadata !== "object" || !("version" in metadata) || typeof metadata.version !== "string")
      throw new Error("Invalid package version metadata");
    console.log(metadata.version);
    return;
  }
  const options: CommandOptions = {
    json: values.json ?? false,
    dryRun: values["dry-run"] ?? false,
    input: values.input,
    patch: values.patch,
    output: values.output,
  };
  const command = positionals.length === 1 ? positionals[0] : undefined;
  if (positionals.length !== 0 && positionals.length !== 1 && positionals.length !== 3) throw new Error(help);
  if (command !== undefined && command !== "patch" && command !== "extract" && command !== "inspect")
    throw new Error(help);
  if (command === "extract") {
    await extractRom(options);
    return;
  }
  if (command === "inspect") {
    await inspectRom(options);
    return;
  }

  const dryRun = options.dryRun;
  const usesLegacyPaths = positionals.length === 3;
  if (usesLegacyPaths && (values.input !== undefined || values.patch !== undefined || values.output !== undefined))
    throw new Error(help);
  if (!usesLegacyPaths && (!values.input || !values.patch || (!dryRun && !values.output))) throw new Error(help);
  const [original, patch, output] = usesLegacyPaths ? positionals : [values.input, values.patch, values.output];
  if (!original || !patch) throw new Error(help);
  if (!dryRun) {
    if (!output) throw new Error(help);
    if ((await sameFile(original, output)) || (await sameFile(patch, output)))
      throw new Error("输出路径不能覆盖原始 ROM 或补丁包。");
  }
  const [originalBytes, patchBytes] = await Promise.all([readFile(original), readFile(patch)]);
  const info = readPatchInfo(patchBytes);
  const result = patchBuffer(originalBytes, patchBytes);
  if (!dryRun) {
    if (!output) throw new Error(help);
    const destination = join(await realpath(dirname(resolve(output))), basename(output));
    const temporary = await mkdtemp(join(dirname(destination), ".nitro-patcher-"));
    try {
      const file = join(temporary, "output.nds");
      await writeFile(file, result.buffer);
      await rename(file, destination);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const { returnValue, inputMd5, outputMd5 } = result;
  if (options.json) {
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
    if (metadata) sections.push(`补丁信息：\n\n${metadata}`);
  }
  if (info.readme) {
    const content = safeTerminalText(info.readme.content);
    const rendered =
      info.readme.format === "markdown"
        ? render(content, {
            width: process.stdout.columns ?? 80,
            color: Boolean(process.stdout.isTTY),
            hyperlinks: false,
          })
        : content;
    sections.push(`补丁说明：\n\n${rendered.trim()}`);
  }
  if (dryRun) sections.push("试运行完成，未写入输出 ROM。");
  sections.push(`${returnValue}\n\n原始 ROM 的 MD5：${inputMd5}\n生成 ROM 的 MD5：${outputMd5}`);
  console.log(sections.join("\n\n"));
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
