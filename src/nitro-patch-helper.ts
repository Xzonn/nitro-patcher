// Native TypeScript port of NitroPatchHelper/PatchHelper.cs, GPL-3.0.
import { hashDigest, readFile } from '#nitro-runtime';
import { bytes } from './nitro/binary';
import { NDSFile } from './nitro/nds-file';
import { readZip } from './patch/zip';
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

const md5 = (data: Uint8Array): string => hashDigest('md5', data).toString('hex');

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
export const PatchHelper = Object.freeze({ patchBuffer, patchIt });
export { decodeXdelta } from './patch/xdelta';
export type { XdeltaOptions } from './patch/xdelta';
