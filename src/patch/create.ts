import { init, xd3_encode_memory, xd3_smatch_cfg } from "@xzonn/xdelta3-wasm";
import { zipSync } from "fflate";

import { hashDigest } from "#nitro-runtime";

import { decodeXdelta } from "./xdelta";
import { bytes } from "../nitro/binary";
import { crc16 } from "../nitro/crc";
import { decryptSecureArea, encryptSecureArea } from "../nitro/crypto";
import type { NitroFolder } from "../nitro/filesystem";
import { Header } from "../nitro/header";
import { NDSFile } from "../nitro/nds-file";
import { patchBuffer } from "../nitro-patch-helper";
import type { PatchMetadata, PatchOptions } from "../nitro-patch-helper";

export interface CreatePatchOptions extends PatchOptions {
  metadata?: Omit<PatchMetadata, "formatVersion">;
  readme?: string;
}

export interface CreatePatchResult {
  buffer: Uint8Array<ArrayBuffer>;
  changedFiles: number;
  warnings: string[];
}

const normalizePath = (path: string): string => path.replaceAll("\\", "/").toLowerCase();
const listFiles = (rom: NDSFile) => new Map(rom.listFiles().map((file) => [normalizePath(file.path), file]));
const listDirectories = (folder: NitroFolder, prefix = "data"): string[] =>
  [prefix, ...folder.folders.flatMap((child) => listDirectories(child, `${prefix}/${child.name}`))].sort();
const getUnnamedFiles = (rom: NDSFile): Buffer[] => {
  const namedIds = new Set(
    rom
      .listFiles()
      .filter((file) => /^(data|overlay)\//i.test(file.path))
      .map((file) => file.id),
  );
  return rom.fatTable.entries
    .filter((entry) => !namedIds.has(entry.id))
    .map((entry) => rom.original.subarray(entry.offset, entry.offset + entry.size));
};

// Repacking assigns physical locations, capacities and derived checksums.
const normalizeHeader = (rom: NDSFile): Buffer => {
  const header = new Header(rom.getFile("header.bin"));
  header.size = 0x20000;
  for (const field of [
    "ARM9romOffset",
    "ARM9size",
    "ARM7romOffset",
    "ARM7size",
    "FNToffset",
    "FNTsize",
    "FAToffset",
    "FATsize",
    "ARM9overlayOffset",
    "ARM9overlaySize",
    "ARM7overlayOffset",
    "ARM7overlaySize",
    "bannerOffset",
    "secureCRC16",
    "ROMsize",
    "logoCRC16",
    "headerCRC16",
  ] as const)
    header[field] = 0;
  if (header.unitCode === 2) {
    for (const field of [
      "ntr_region_end",
      "twl_region_start",
      "dsi9_rom_offset",
      "dsi7_rom_offset",
      "digest_ntr_start",
      "digest_ntr_size",
      "digest_twl_start",
      "digest_twl_size",
      "sector_hashtable_start",
      "sector_hashtable_size",
      "block_hashtable_start",
      "block_hashtable_size",
      "total_rom_size",
      "modcrypt1_start",
      "modcrypt1_size",
      "modcrypt2_start",
      "modcrypt2_size",
    ] as const)
      header[field] = 0;
    for (const field of [
      "hmac_arm9",
      "hmac_arm7",
      "hmac_digest_master",
      "hmac_icon_title",
      "hmac_arm9i",
      "hmac_arm7i",
      "hmac_arm9_no_secure",
      "rsa_signature",
    ] as const)
      header[field] = Buffer.alloc(header[field].length);
  }
  return header.raw;
};

const compareContent = (actual: Buffer, expected: Buffer, path: string, warnings: string[]): void => {
  if (!actual.equals(expected)) warnings.push(`重建内容与修改后的 ROM 不同：${path}`);
};

const errorMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

const parseRom = (input: Buffer, label: string, warnings: string[]): NDSFile => {
  try {
    const rom = new NDSFile(input, { dsiMode: "complete" });
    rom.listFiles();
    return rom;
  } catch (reason) {
    try {
      const rom = new NDSFile(input);
      rom.listFiles();
      warnings.push(`${label} 使用常规模式解析：${errorMessage(reason)}`);
      return rom;
    } catch (error) {
      throw new Error(`无法解析${label}：${errorMessage(error)}`, { cause: error });
    }
  }
};

const createDelta = async (before: Buffer, after: Buffer): Promise<Buffer> => {
  await init();
  const windowSize = 64 * 1024;
  const maxSize = after.length * 2 + Math.ceil(after.length / windowSize) * 64 + 1024;
  const result = xd3_encode_memory(after, before, maxSize, xd3_smatch_cfg.DEFAULT, windowSize);
  if (result.ret !== 0) throw new Error(`Cannot encode VCDIFF: ${result.str}`);
  return Buffer.from(result.output);
};

const verifyContent = (actual: NDSFile, expected: NDSFile, arm9: Buffer, warnings: string[]): void => {
  const actualFiles = listFiles(actual);
  const expectedFiles = listFiles(expected);
  if ([...actualFiles.keys()].sort().join("\n") !== [...expectedFiles.keys()].sort().join("\n"))
    warnings.push("重建 ROM 的文件路径集合与修改后的 ROM 不同。");
  const actualDirectories = new Set(listDirectories(actual.data));
  const expectedDirectories = new Set(listDirectories(expected.data));
  for (const path of expectedDirectories)
    if (!actualDirectories.has(path)) {
      if ([...expectedFiles.keys()].some((name) => name.startsWith(normalizePath(`${path}/`))))
        warnings.push(`重建 ROM 缺少目录：${path}`);
      else warnings.push(`新增空目录已忽略：${path}`);
    }
  for (const path of actualDirectories)
    if (!expectedDirectories.has(path)) {
      if ([...actualFiles.keys()].some((name) => name.startsWith(normalizePath(`${path}/`))))
        warnings.push(`重建 ROM 保留了原始目录：${path}`);
      else warnings.push(`已保留原始 ROM 的空目录：${path}`);
    }
  for (const [path, file] of expectedFiles) {
    if (["header.bin", "fnt.bin", "fat.bin", "banner.bin", "overarm9.bin", "overarm7.bin"].includes(path)) continue;
    if (!actualFiles.has(path)) continue;
    let content = path === "arm9.bin" ? Buffer.from(arm9) : expected.getFile(file.path);
    if (path === "arm9.bin" && expected.header.unitCode === 2) {
      const plain = expected.header.decrypted ? content : decryptSecureArea(expected.header.gameCode, content);
      plain.writeUInt16LE(crc16(plain.subarray(0x10, 0x800)), 0xe);
      content = expected.header.decrypted ? plain : encryptSecureArea(expected.header.gameCode, plain);
    }
    compareContent(actual.getFile(file.path), content, file.path, warnings);
  }
  compareContent(actual.banner.toBuffer(), expected.banner.toBuffer(), "banner.bin", warnings);
  compareContent(normalizeHeader(actual), normalizeHeader(expected), "header.bin", warnings);
  compareContent(actual.header.dlp_signature, expected.header.dlp_signature, "Download Play 签名", warnings);
  for (const [left, right] of [
    [actual.overlay9Table, expected.overlay9Table],
    [actual.overlay7Table, expected.overlay7Table],
  ]) {
    if (left.entries.length !== right.entries.length) warnings.push("重建 ROM 的覆盖模块数量与修改后的 ROM 不同。");
    for (const entry of right.entries) {
      const other = left.entries.find((item) => item.overlayId === entry.overlayId);
      if (!other) {
        warnings.push(`重建 ROM 缺少覆盖模块：${entry.overlayId}`);
        continue;
      }
      for (const field of [
        "ramAddress",
        "ramSize",
        "bssSize",
        "staticInitialiserStartAddress",
        "staticInitialiserEndAddress",
        "reserved",
      ] as const)
        if (other[field] !== entry[field])
          warnings.push(`重建覆盖模块 ${entry.overlayId} 的 ${field} 与修改后的 ROM 不同。`);
    }
  }
  const actualUnnamed = getUnnamedFiles(actual);
  const expectedUnnamed = getUnnamedFiles(expected);
  if (actualUnnamed.length !== expectedUnnamed.length)
    warnings.push("重建 ROM 的未命名 FAT 项数量与修改后的 ROM 不同。");
  actualUnnamed.forEach((content, index) => {
    if (expectedUnnamed[index]) compareContent(content, expectedUnnamed[index], `未命名 FAT 项 ${index}`, warnings);
  });
  if (actual.header.unitCode === 2)
    for (const [name, check] of Object.entries(actual.verifyDsi()))
      if (check.status === "invalid") warnings.push(`重建 ROM 的 DSi 校验结果为 invalid：${name}`);
};

const verifyPatch = (
  input: Buffer,
  archive: Uint8Array,
  target: NDSFile,
  arm9: Buffer,
  options: PatchOptions,
  warnings: string[],
): boolean => {
  let output: Buffer;
  try {
    output = patchBuffer(input, archive, options).buffer;
  } catch (reason) {
    warnings.push(`补丁应用检查未完成：${errorMessage(reason)}`);
    return false;
  }
  try {
    verifyContent(parseRom(output, "重建 ROM", warnings), target, arm9, warnings);
  } catch (reason) {
    warnings.push(`补丁数据核对未完成：${errorMessage(reason)}`);
  }
  return true;
};

/** Create an XZP; differences and application checks are returned as warnings. */
export const createPatch = async (
  original: Uint8Array,
  modified: Uint8Array,
  options: CreatePatchOptions = {},
): Promise<CreatePatchResult> => {
  const input = bytes(original, "original ROM");
  const targetBytes = bytes(modified, "modified ROM");
  const warnings: string[] = [];
  const source = parseRom(input, "原始 ROM", warnings);
  const target = parseRom(targetBytes, "修改后的 ROM", warnings);
  let preprocessing = false;
  if (source.header.gameCode !== target.header.gameCode)
    warnings.push(`两个 ROM 的游戏代码不同：${source.header.gameCode} / ${target.header.gameCode}`);
  if (source.header.unitCode !== target.header.unitCode)
    warnings.push(`两个 ROM 的 unitCode 不同：${source.header.unitCode} / ${target.header.unitCode}`);
  if (source.header.ROMversion !== target.header.ROMversion)
    warnings.push(`两个 ROM 的修订版本不同：${source.header.ROMversion} / ${target.header.ROMversion}`);
  if (source.header.gameCode !== target.header.gameCode || source.header.unitCode !== target.header.unitCode)
    preprocessing = true;
  const sourceFiles = listFiles(source);
  const targetFiles = listFiles(target);
  const headerChanged = !normalizeHeader(source).equals(normalizeHeader(target));
  const sourceArm9 = source.getFile("arm9.bin");
  const targetArm9 = target.getFile("arm9.bin");
  const sourcePostData = sourceArm9.subarray(source.header.ARM9size);
  const targetPostData = targetArm9.subarray(target.header.ARM9size);
  if (!sourcePostData.equals(targetPostData)) warnings.push("两个 ROM 的 ARM9 尾部记录不同。");
  for (const [label, rom, entries] of [
    ["原始 ROM", source, sourceFiles],
    ["修改后的 ROM", target, targetFiles],
  ] as const) {
    const file = entries.get("arm9.bin")!;
    const end = file.offset + file.size;
    if (rom.header.nitrocode && rom.original.subarray(end, end + 4).equals(Buffer.from("2106c0de", "hex")))
      warnings.push(`${label} 的 ARM9 含有额外尾部记录。`);
  }
  const targetProgram = targetArm9.subarray(0, target.header.ARM9size);
  const arm9 =
    sourcePostData.length && targetProgram.subarray(-sourcePostData.length).equals(sourcePostData)
      ? targetProgram
      : Buffer.concat([targetProgram, sourcePostData]);
  const removed = [...sourceFiles.keys()].filter((path) => !targetFiles.has(path));
  if (removed.length) {
    warnings.push(`修改后的 ROM 缺少原始 ROM 中的 ${removed.length} 个文件。`);
    preprocessing = true;
  }
  const sourceUnnamed = getUnnamedFiles(source);
  const targetUnnamed = getUnnamedFiles(target);
  if (
    sourceUnnamed.length !== targetUnnamed.length ||
    sourceUnnamed.some((content, index) => !content.equals(targetUnnamed[index] ?? Buffer.alloc(0)))
  ) {
    warnings.push("两个 ROM 的未命名 FAT 数据不同。");
    preprocessing = true;
  }
  const entries: Record<string, Uint8Array> = {};
  let changedFiles = 0;
  for (const [path, file] of targetFiles) {
    if (path === "fnt.bin" || path === "fat.bin") continue;
    if (path === "header.bin" && !headerChanged) continue;
    const before = sourceFiles.has(path) ? source.getFile(file.path) : Buffer.alloc(0);
    const after = path === "arm9.bin" ? arm9 : target.getFile(file.path);
    if (sourceFiles.has(path) && before.equals(after)) continue;
    if (!sourceFiles.has(path) && !/^(data|overlay)\//.test(path) && !/^overarm[97]\.bin$/.test(path))
      warnings.push(`新增系统文件：${file.path}`);
    try {
      const delta = await createDelta(before, after);
      if (decodeXdelta(before, delta, options).equals(after)) entries[`xdelta/${file.path}`] = delta;
      else {
        warnings.push(`文件差分解码内容不同，已保存完整替换内容：${file.path}`);
        entries[file.path] = after;
      }
    } catch (reason) {
      warnings.push(`文件差分检查未完成，已保存完整替换内容：${file.path}：${errorMessage(reason)}`);
      entries[file.path] = after;
    }
    changedFiles++;
  }
  const metadata: PatchMetadata = { ...options.metadata, formatVersion: 2 };
  const inputMd5 = hashDigest("md5", input).toString("hex");
  entries["metadata.json"] = Buffer.from(JSON.stringify(metadata, null, 2));
  entries["md5.txt"] = Buffer.from(inputMd5);
  entries["readme.md"] = Buffer.from(options.readme ?? "");
  let archive = zipSync(entries, { level: 9 });
  if (!preprocessing) preprocessing = !verifyPatch(input, archive, target, arm9, options, warnings);
  if (preprocessing) {
    try {
      const delta = await createDelta(input, targetBytes);
      const formatVersion = target.header.unitCode & 2 && !target.twl?.complete ? 1 : 2;
      archive = zipSync(
        {
          [`preprocessing/${inputMd5}.xdelta`]: delta,
          "metadata.json": Buffer.from(JSON.stringify({ ...metadata, formatVersion }, null, 2)),
          "md5.txt": entries["md5.txt"],
          "readme.md": entries["readme.md"],
        },
        { level: 9 },
      );
      changedFiles = 1;
      warnings.push("补丁使用整份 ROM 的预处理差分保存修改。");
      verifyPatch(input, archive, target, targetArm9, options, warnings);
    } catch (reason) {
      warnings.push(`预处理差分生成未完成，已保留按文件补丁包：${errorMessage(reason)}`);
    }
  }
  return { buffer: new Uint8Array(archive), changedFiles, warnings };
};
