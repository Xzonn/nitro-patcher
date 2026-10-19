import { NDSFile } from "./nitro/nds-file";
import {
  extractZipEntry as extractEntry,
  patchBuffer as patch,
  readPatchInfo as readInfo,
  readPatchMetadata as readMetadata,
  readPatchReadme as readReadme,
} from "./nitro-patch-helper";

export interface PatchMetadata {
  formatVersion?: number;
  id?: string;
  author?: string;
  name?: string;
  homepage?: string;
  version?: string;
  isBeta?: boolean;
}
export interface PatchReadme {
  format: "markdown" | "plaintext";
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
export interface DsiCheck {
  status: "valid" | "invalid" | "not-applicable";
  reason?: string;
}
export interface DsiVerification {
  arm9: DsiCheck;
  arm7: DsiCheck;
  arm9i: DsiCheck;
  arm7i: DsiCheck;
  arm9NoSecure: DsiCheck;
  banner: DsiCheck;
  sectors: DsiCheck;
  blocks: DsiCheck;
  master: DsiCheck;
  signature: DsiCheck;
}
export interface BrowserPatchResult {
  buffer: Uint8Array<ArrayBuffer>;
  returnValue: "SUCCESS" | "MD5_MISMATCH";
  inputMd5: string;
  outputMd5: string;
  dsi?: DsiVerification;
}
export interface RomInfo {
  gameTitle: string;
  gameCode: string;
  size: number;
  fileCount: number;
  checksums: { header: boolean; logo: boolean; secureArea: boolean; banner: boolean };
  dsi?: DsiVerification;
}
/** Parse ROM metadata entirely in memory. No filesystem or Node types required. */
export const inspectRom = (bytes: Uint8Array, options: { dsiMode?: "legacy" | "complete" } = {}): RomInfo => {
  const rom = new NDSFile(bytes, options);
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
    ...(options.dsiMode === "complete" && { dsi: rom.verifyDsi() }),
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
    ...(result.dsi && { dsi: result.dsi }),
  };
};
/** Read and validate metadata.json from a patch package entirely in memory. */
export const readPatchMetadata = (archive: Uint8Array, options: BrowserPatchOptions = {}): PatchMetadata | null =>
  readMetadata(archive, options);
/** Read a root README.md or README.txt from a patch package entirely in memory. */
export const readPatchReadme = (archive: Uint8Array, options: BrowserPatchOptions = {}): PatchReadme | null =>
  readReadme(archive, options);
/** Read metadata and README content while parsing the patch package only once. */
export const readPatchInfo = (archive: Uint8Array, options: BrowserPatchOptions = {}): PatchInfo =>
  readInfo(archive, options);
/** Extract one file from a ZIP archive entirely in memory. */
export const extractZipEntry = (
  archive: Uint8Array,
  entryName: string,
  options: BrowserPatchOptions = {},
): Uint8Array<ArrayBuffer> => new Uint8Array(extractEntry(archive, entryName, options));

export const PatchHelper = Object.freeze({
  extractZipEntry,
  patchBuffer,
  readPatchInfo,
  readPatchMetadata,
  readPatchReadme,
});
export const NitroHelper = Object.freeze({ inspectRom });
