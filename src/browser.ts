import { NDSFile } from './nitro/nds-file';
import {
  patchBuffer as patch,
  readPatchInfo as readInfo,
  readPatchMetadata as readMetadata,
  readPatchReadme as readReadme,
} from './nitro-patch-helper';

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

export interface BrowserPatchOptions {
  maxOutputSize?: number;
  maxWindowSize?: number;
  maxUncompressedSize?: number;
  maxEntries?: number;
}
export interface BrowserPatchResult {
  buffer: Uint8Array<ArrayBuffer>;
  returnValue: 'SUCCESS' | 'MD5_MISMATCH';
  inputMd5: string;
  outputMd5: string;
}
export interface RomInfo {
  gameTitle: string;
  gameCode: string;
  size: number;
  fileCount: number;
  checksums: { header: boolean; logo: boolean; secureArea: boolean; banner: boolean };
}
/** Parse ROM metadata entirely in memory. No filesystem or Node types required. */
export const inspectRom = (bytes: Uint8Array): RomInfo => {
  const rom = new NDSFile(bytes);
  return {
    gameTitle: rom.header.gameTitle,
    gameCode: rom.header.gameCode,
    size: bytes.byteLength,
    fileCount: rom.listFiles().length,
    checksums: {
      header: rom.header.headerCRC,
      logo: rom.header.logoCRC,
      secureArea: rom.header.secureCRC,
      banner: rom.banner.bannerCRC,
    },
  };
};
/** Synchronous CPU work; call in a Web Worker for responsive browser UIs. */
export const patchBuffer = (
  original: Uint8Array,
  archive: Uint8Array,
  options: BrowserPatchOptions = {},
): BrowserPatchResult => {
  const result = patch(original, archive, options);
  // Return a plain transferable typed array, never a Node Buffer in public types.
  const buffer = new Uint8Array(
    result.buffer.buffer as ArrayBuffer,
    result.buffer.byteOffset,
    result.buffer.byteLength,
  );
  return {
    buffer,
    returnValue: result.returnValue,
    inputMd5: result.inputMd5,
    outputMd5: result.outputMd5,
  };
};
/** Read and validate metadata.json from a patch package entirely in memory. */
export const readPatchMetadata = (
  archive: Uint8Array,
  options: BrowserPatchOptions = {},
): PatchMetadata | null => readMetadata(archive, options);
/** Read a root README.md or README.txt from a patch package entirely in memory. */
export const readPatchReadme = (
  archive: Uint8Array,
  options: BrowserPatchOptions = {},
): PatchReadme | null => readReadme(archive, options);
/** Read metadata and README content while parsing the patch package only once. */
export const readPatchInfo = (archive: Uint8Array, options: BrowserPatchOptions = {}): PatchInfo =>
  readInfo(archive, options);

export const PatchHelper = Object.freeze({
  patchBuffer,
  readPatchInfo,
  readPatchMetadata,
  readPatchReadme,
});
export const NitroHelper = Object.freeze({ inspectRom });
