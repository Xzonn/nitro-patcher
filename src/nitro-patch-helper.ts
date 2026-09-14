// Native TypeScript port of NitroPatchHelper/PatchHelper.cs, GPL-3.0.
import { hashDigest, readFile } from '#nitro-runtime';
import { bytes } from './nitro/binary';
import { NDSFile } from './nitro/nds-file';
import { extractZipEntry as extractEntry, readZip } from './patch/zip';
import { decodeXdelta } from './patch/xdelta';

export const PatchReturnValue = Object.freeze({
  SUCCESS: 'SUCCESS',
  MD5_MISMATCH: 'MD5_MISMATCH',
} as const);
export type PatchReturnValue = (typeof PatchReturnValue)[keyof typeof PatchReturnValue];

export interface PatchResult {
  /** Generated ROM bytes. Also returned when the MD5 does not match, as in the original helper. */
  buffer: Buffer;
  returnValue: PatchReturnValue;
  /** MD5 of the original input, before preprocessing. */
  inputMd5: string;
  outputMd5: string;
}

export interface PatchOptions {
  /** Maximum generated ROM/Xdelta target size in bytes, default 1 GiB. */
  maxOutputSize?: number;
  /** Maximum target size of an individual VCDIFF window, default 16 MiB. */
  maxWindowSize?: number;
  /** Maximum total uncompressed ZIP bytes, default 1 GiB. */
  maxUncompressedSize?: number;
  /** Maximum ZIP entry count. */
  maxEntries?: number;
}

export interface PatchMetadata {
  id?: string;
  author?: string;
  name?: string;
  homepage?: string;
  version?: string;
  isBeta?: boolean;
}

export interface PatchReadme {
  format: 'markdown' | 'plaintext';
  content: string;
}

export interface PatchInfo {
  metadata: PatchMetadata | null;
  readme: PatchReadme | null;
}

const md5 = (data: Uint8Array): string => hashDigest('md5', data).toString('hex');
const invalidMetadata = (message: string): null => {
  console.warn(`忽略 metadata.json：${message}`);
  return null;
};
const invalidMetadataField = (field: keyof PatchMetadata, message: string): void => {
  console.warn(`忽略 metadata.json 的 ${field}：${message}`);
};

const readMetadata = (files: Map<string, Buffer>): PatchMetadata | null => {
  const file = files.get('metadata.json');
  if (!file) return null;

  let metadata: unknown;
  try {
    metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file));
  } catch (error) {
    return invalidMetadata(
      `格式错误，可能是因为补丁包已损坏：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return invalidMetadata('根节点必须是对象。');

  const value = metadata as Record<string, unknown>;
  const result: PatchMetadata = {};
  for (const field of ['id', 'author', 'name', 'homepage', 'version'] as const) {
    const fieldValue = value[field];
    if (fieldValue === undefined) continue;
    if (typeof fieldValue === 'string') result[field] = fieldValue;
    else invalidMetadataField(field, '必须是字符串。');
  }
  if (value.isBeta === undefined) return result;
  if (typeof value.isBeta === 'boolean') result.isBeta = value.isBeta;
  else invalidMetadataField('isBeta', '必须是布尔值。');

  return result;
};

const readReadme = (files: Map<string, Buffer>): PatchReadme | null => {
  for (const [filename, format] of [
    ['README.md', 'markdown'],
    ['README.txt', 'plaintext'],
  ] as const) {
    const file = files.get(filename.toLowerCase());
    if (!file) continue;
    try {
      return {
        format,
        content: new TextDecoder('utf-8', { fatal: true }).decode(file),
      };
    } catch (error) {
      console.warn(
        `忽略 ${filename}：不是有效的 UTF-8 文本：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return null;
};

/** Read and validate metadata.json from a NitroPatcher ZIP package. */
export const readPatchMetadata = (
  patch: Uint8Array,
  options: PatchOptions = {},
): PatchMetadata | null => readMetadata(readZip(patch, options));

/** Read a root README.md or README.txt from a NitroPatcher ZIP package. */
export const readPatchReadme = (
  patch: Uint8Array,
  options: PatchOptions = {},
): PatchReadme | null => readReadme(readZip(patch, options));

/** Read metadata and README content while parsing the patch package only once. */
export const readPatchInfo = (patch: Uint8Array, options: PatchOptions = {}): PatchInfo => {
  const files = readZip(patch, options);
  return { metadata: readMetadata(files), readme: readReadme(files) };
};

/** Extract one file from a ZIP archive entirely in memory. */
export const extractZipEntry = (
  archive: Uint8Array,
  entryName: string,
  options: PatchOptions = {},
): Buffer => extractEntry(archive, entryName, options);

/** Read metadata.json from a NitroPatcher ZIP package on disk. */
export const readPatchMetadataFile = async (
  patchPath: string,
  options: PatchOptions = {},
): Promise<PatchMetadata | null> => readPatchMetadata(await readFile(patchPath), options);

/** Read a patch README from disk. */
export const readPatchReadmeFile = async (
  patchPath: string,
  options: PatchOptions = {},
): Promise<PatchReadme | null> => readPatchReadme(await readFile(patchPath), options);

/** Read patch metadata and README content from disk. */
export const readPatchInfoFile = async (
  patchPath: string,
  options: PatchOptions = {},
): Promise<PatchInfo> => readPatchInfo(await readFile(patchPath), options);

/** Apply an existing NitroPatcher ZIP package entirely in memory. */
export const patchBuffer = (
  original: Uint8Array,
  patch: Uint8Array,
  options: PatchOptions = {},
): PatchResult => {
  const input = bytes(original, 'original ROM');
  const patches = readZip(patch, options);
  const inputMd5 = md5(input);
  const preprocessing = patches.get(`preprocessing/${inputMd5}.xdelta`);
  const rom = new NDSFile(
    preprocessing ? decodeXdelta(input, preprocessing, options) : input,
    options,
  );
  let matched = true;
  const md5File = patches.get('md5.txt');
  if (md5File) {
    matched = false;
    for (const line of md5File.toString('utf8').split('\n')) {
      const expected = line.trim();
      if (!expected || expected.startsWith('#')) continue;
      // Keep the original format contract: exactly 32 characters, case-insensitive comparison.
      if (expected.length !== 32) throw new Error('md5.txt 格式错误，可能是因为补丁包已损坏。');
      if (expected.toLowerCase() === inputMd5) {
        matched = true;
        break;
      }
    }
  }
  for (const { path } of rom.listFiles()) {
    const normalized = path.replaceAll('\\', '/').toLowerCase();
    const delta = patches.get(`xdelta/${normalized}`);
    const replacement = delta
      ? decodeXdelta(rom.getFile(path), delta, options)
      : patches.get(normalized);
    if (replacement) rom.replaceFile(path, replacement);
  }
  const buffer = rom.toBuffer();
  return {
    buffer,
    returnValue: matched ? PatchReturnValue.SUCCESS : PatchReturnValue.MD5_MISMATCH,
    inputMd5,
    outputMd5: md5(buffer),
  };
};

/** Read input files and apply the patch. Does not write an output file. */
export const patchIt = async (
  originalPath: string,
  patchPath: string,
  options: PatchOptions = {},
): Promise<PatchResult> => {
  const [original, patch] = await Promise.all([readFile(originalPath), readFile(patchPath)]);
  return patchBuffer(original, patch, options);
};

/** Namespaced counterpart of the original C# helper, sharing the same typed functions. */
export const PatchHelper = Object.freeze({
  extractZipEntry,
  patchBuffer,
  patchIt,
  readPatchInfo,
  readPatchInfoFile,
  readPatchMetadata,
  readPatchMetadataFile,
  readPatchReadme,
  readPatchReadmeFile,
});
export { decodeXdelta } from './patch/xdelta';
export type { XdeltaOptions } from './patch/xdelta';
