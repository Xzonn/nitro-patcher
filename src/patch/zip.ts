import { inflateRawSync } from '#nitro-runtime';
import { crc32 } from '../nitro/crc';

/** Resource limits apply to every central-directory entry, including duplicates. */
export interface ZipOptions {
  maxUncompressedSize?: number;
  maxEntries?: number;
}

const fail = (message: string): never => {
  throw new Error(`ZIP: ${message}`);
};
const utf8 = new TextDecoder('utf-8', { fatal: true });
// IBM code page 437, byte values 0x80..0xff. ASCII bytes retain their literal values.
const cp437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return fail('invalid UTF-8 filename');
  }
}
function boundOption(value: number | undefined, fallback: number, label: string): number {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a non-negative safe integer`);
  return value;
}
function checkRange(bytes: Buffer, offset: number, length: number, end = bytes.length): void {
  if (offset < 0 || offset > end || length > end - offset)
    fail(`truncated or out-of-bounds record at ${offset} (length ${length})`);
}
function extras(bytes: Buffer): Map<number, Buffer> {
  const fields = new Map<number, Buffer>();
  let offset = 0;
  while (offset < bytes.length) {
    checkRange(bytes, offset, 4);
    const id = bytes.readUInt16LE(offset),
      length = bytes.readUInt16LE(offset + 2);
    offset += 4;
    checkRange(bytes, offset, length);
    if (id === 1) fail('ZIP64 archives are unsupported');
    fields.set(id, bytes.subarray(offset, offset + length));
    offset += length;
  }
  return fields;
}
function filename(raw: Buffer, flags: number, fields: Map<number, Buffer>): string {
  if (flags & 0x800) return decodeUtf8(raw);
  const unicode = fields.get(0x7075);
  if (unicode && unicode.length >= 5 && unicode[0] === 1 && unicode.readUInt32LE(1) === crc32(raw))
    return decodeUtf8(unicode.subarray(5));
  let result = '';
  for (const byte of raw) result += byte < 128 ? String.fromCharCode(byte) : cp437[byte - 128]!;
  return result;
}

/**
 * Read stored/deflated, single-disk ZIPs entirely in memory. Central-directory
 * sizes support streamed entries with data descriptors. Paths match PatchHelper:
 * backslashes become slashes, names are lowercase, and the final duplicate wins.
 * ZIP64, encryption, split archives and other compression methods fail explicitly.
 * Format reference: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */
export const readZip = (input: Uint8Array, options: ZipOptions = {}): Map<string, Buffer> => {
  if (!(input instanceof Uint8Array))
    throw new TypeError('ZIP input must be a Buffer or Uint8Array');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const maxSize = boundOption(
    options.maxUncompressedSize,
    1024 * 1024 * 1024,
    'maxUncompressedSize',
  );
  const maxEntries = boundOption(options.maxEntries, 100000, 'maxEntries');
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail('end of central directory not found or truncated');
  const disk = bytes.readUInt16LE(eocd + 4),
    centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8),
    count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12),
    centralOffset = bytes.readUInt32LE(eocd + 16);
  if (
    count === 0xffff ||
    diskEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === 0x07064b50)
  )
    fail('ZIP64 archives are unsupported');
  if (disk || centralDisk || diskEntries !== count)
    fail('split or multiple-disk archives are unsupported');
  if (count > maxEntries) fail(`entry count exceeds limit ${maxEntries}`);
  checkRange(bytes, centralOffset, centralSize, eocd);
  if (centralOffset + centralSize !== eocd) fail('central directory size/offset mismatch');
  if (count > Math.floor(centralSize / 46)) fail('entry count exceeds central directory size');
  const result = new Map<string, Buffer>();
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = centralOffset,
    totalSize = 0;
  for (let index = 0; index < count; index++) {
    checkRange(bytes, offset, 46, eocd);
    if (bytes.readUInt32LE(offset) !== 0x02014b50) fail('invalid central directory signature');
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16),
      compressedSize = bytes.readUInt32LE(offset + 20),
      size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28),
      extraLength = bytes.readUInt16LE(offset + 30),
      commentLength = bytes.readUInt16LE(offset + 32);
    const startDisk = bytes.readUInt16LE(offset + 34),
      localOffset = bytes.readUInt32LE(offset + 42);
    if (
      size === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      startDisk === 0xffff
    )
      fail('ZIP64 entry is unsupported');
    if (startDisk) fail('split or multiple-disk entry is unsupported');
    if (flags & 0x2041) fail('encrypted entries are unsupported');
    if (flags & ~0x80e) fail('unsupported general purpose flags');
    if (method !== 0 && method !== 8) fail(`unsupported compression method ${method}`);
    if (size > maxSize - totalSize) fail(`uncompressed size exceeds limit ${maxSize}`);
    totalSize += size;
    checkRange(bytes, offset + 46, nameLength + extraLength + commentLength, eocd);
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const fields = extras(
      bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength),
    );
    const name = filename(rawName, flags, fields).replaceAll('\\', '/').toLowerCase();
    offset += 46 + nameLength + extraLength + commentLength;

    checkRange(bytes, localOffset, 30, centralOffset);
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) fail('invalid local header signature');
    if (
      bytes.readUInt16LE(localOffset + 6) !== flags ||
      bytes.readUInt16LE(localOffset + 8) !== method
    )
      fail('local header flags/compression method mismatch');
    const localNameLength = bytes.readUInt16LE(localOffset + 26),
      localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    checkRange(bytes, localOffset + 30, localNameLength + localExtraLength, centralOffset);
    if (!rawName.equals(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)))
      fail('local filename differs from central directory');
    extras(bytes.subarray(localOffset + 30 + localNameLength, dataOffset));
    if (
      !(flags & 8) &&
      (bytes.readUInt32LE(localOffset + 14) !== checksum ||
        bytes.readUInt32LE(localOffset + 18) !== compressedSize ||
        bytes.readUInt32LE(localOffset + 22) !== size)
    )
      fail('local header CRC/size mismatch');
    checkRange(bytes, dataOffset, compressedSize, centralOffset);
    let dataEnd = dataOffset + compressedSize;
    if (flags & 8) {
      // A descriptor may omit its signature. Use the CRC and both sizes to
      // disambiguate the rare case of an unsigned CRC equal to the signature.
      checkRange(bytes, dataEnd, 12, centralOffset);
      const matches = (at: number): boolean =>
        at + 12 <= centralOffset &&
        bytes.readUInt32LE(at) === checksum &&
        bytes.readUInt32LE(at + 4) === compressedSize &&
        bytes.readUInt32LE(at + 8) === size;
      if (matches(dataEnd)) dataEnd += 12;
      else if (bytes.readUInt32LE(dataEnd) === 0x08074b50 && matches(dataEnd + 4)) dataEnd += 16;
      else fail('data descriptor CRC/size mismatch');
    }
    ranges.push({ start: localOffset, end: dataEnd });
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    let data: Buffer;
    if (method === 0) {
      if (compressedSize !== size) fail('stored entry compressed/uncompressed size mismatch');
      data = Buffer.from(compressed);
    } else {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) });
      } catch (error) {
        return fail(
          `cannot inflate entry ${JSON.stringify(name)} within declared size: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (data.length !== size) fail(`uncompressed size mismatch for ${JSON.stringify(name)}`);
    if (crc32(data) !== checksum) fail(`CRC32 mismatch for ${JSON.stringify(name)}`);
    if (name && !name.endsWith('/')) result.set(name, data);
  }
  if (offset !== eocd) fail('central directory entry count/length mismatch');
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i]!.start < ranges[i - 1]!.end) fail('overlapping local entry ranges');
  return result;
};

/** Extract one file using the same normalized, case-insensitive paths as readZip. */
export const extractZipEntry = (
  input: Uint8Array,
  entryName: string,
  options: ZipOptions = {},
): Buffer => {
  if (typeof entryName !== 'string' || !entryName)
    throw new TypeError('ZIP entry name must be a non-empty string');
  const normalized = entryName.replaceAll('\\', '/').toLowerCase();
  if (normalized.endsWith('/')) fail(`entry ${JSON.stringify(entryName)} is a directory`);
  const entry = readZip(input, options).get(normalized);
  if (entry === undefined) return fail(`entry ${JSON.stringify(entryName)} not found`);
  return entry;
};
