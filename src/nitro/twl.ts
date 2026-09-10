import { hashDigest, hmacSha1, verifyRsaSha1, readFileSync } from '#nitro-runtime';
import type { BinaryWriter } from './binary';
import type { ModcryptHeader } from './crypto';
import type { Arm9Header } from './blz';
import { aes128CtrCrypt, encryptSecureArea, modcryptKey } from './crypto';
import { compressArm9, decompressArm9 } from './blz';

export interface TwlHeader extends ModcryptHeader {
  digest_sector_size: number;
  digest_block_sectorcount: number;
  digest_ntr_start: number;
  digest_ntr_size: number;
  digest_twl_start: number;
  digest_twl_size: number;
  sector_hashtable_start: number;
  sector_hashtable_size: number;
  block_hashtable_start: number;
  block_hashtable_size: number;
  dsi9_rom_offset: number;
  dsi9_size: number;
  dsi7_rom_offset: number;
  dsi7_size: number;
  modcrypt1_start: number;
  modcrypt1_size: number;
  modcrypt2_start: number;
  modcrypt2_size: number;
  total_rom_size: number;
  trimmedRom: boolean;
  decrypted: boolean;
  hmac_arm9: Buffer;
  hmac_arm7: Buffer;
  hmac_digest_master: Buffer;
}

export interface SignedTwlHeader {
  hmac_digest_master: Buffer;
  rsa_signature: Buffer;
}

export interface OverlayRange {
  offset: number;
  size: number;
}

export const HMAC_SHA1_KEY = Buffer.from(
  '2106c0deba98ce3fa692e39d46f2ed0176e3cc08562363facad4ecdf9a6278348f6d633cfe22ca9220889723d2cfaec232678dfeca836498acfd3e3787465824',
  'hex',
);
const hash = (data: Buffer): Buffer => hmacSha1(HMAC_SHA1_KEY, data);
function slice(data: Buffer, start: number, size: number, label: string): Buffer {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(size) ||
    start < 0 ||
    size < 0 ||
    start + size > data.length
  )
    throw new RangeError(`${label} outside data range`);
  return data.subarray(start, start + size);
}
function validate(h: TwlHeader): void {
  for (const field of [
    'digest_ntr_start',
    'digest_ntr_size',
    'digest_twl_start',
    'digest_twl_size',
    'sector_hashtable_start',
    'sector_hashtable_size',
    'block_hashtable_start',
    'block_hashtable_size',
    'dsi9_rom_offset',
    'dsi9_size',
    'dsi7_rom_offset',
    'dsi7_size',
    'modcrypt1_start',
    'modcrypt1_size',
    'modcrypt2_start',
    'modcrypt2_size',
    'total_rom_size',
  ] as const) {
    if (!Number.isSafeInteger(h[field]) || h[field] < 0 || h[field] > 0xffffffff) {
      throw new Error(`Invalid TWL ${field}`);
    }
  }
  const s = h.digest_sector_size;
  if (!Number.isSafeInteger(s) || s <= 0 || s > 0x4000 || 0x4000 % s)
    throw new Error('Invalid TWL digest sector size');
  if (
    !Number.isSafeInteger(h.digest_block_sectorcount) ||
    h.digest_block_sectorcount <= 0 ||
    h.digest_block_sectorcount > 0x100000
  )
    throw new Error('Invalid TWL digest block sector count');
  if (h.digest_ntr_size < 0x4000 || h.digest_ntr_size % s || h.digest_twl_size % s)
    throw new Error('Invalid TWL digest region size');
  const hashes = (h.digest_ntr_size + h.digest_twl_size) / s;
  if (
    hashes * 20 > h.sector_hashtable_size ||
    Math.ceil(h.sector_hashtable_size / (h.digest_block_sectorcount * 20)) * 20 >
      h.block_hashtable_size
  )
    throw new Error('TWL hash tables are too small');
}
export class TWL {
  readonly firstDSiHashOffset: number;
  readonly dsiHashSize: number;
  readonly Hashtable1Data: Buffer;
  readonly Hashtable2Data: Buffer;
  readonly Header2Data: Buffer[] | null;
  readonly Overlays9Sha1Hmac: Buffer[];
  readonly twlEncrypted: boolean;
  DSi9Data: Buffer;
  DSi7Data: Buffer;
  constructor(header: TwlHeader, overlays: readonly OverlayRange[], original: Buffer) {
    validate(header);
    const h = header;
    this.firstDSiHashOffset = (h.digest_ntr_size / h.digest_sector_size) * 20;
    this.dsiHashSize = (h.digest_twl_size / h.digest_sector_size) * 20;
    this.Hashtable1Data = Buffer.from(
      slice(original, h.sector_hashtable_start, h.sector_hashtable_size, 'Sector hash table'),
    );
    this.Hashtable2Data = Buffer.from(
      slice(original, h.block_hashtable_start, h.block_hashtable_size, 'Block hash table'),
    );
    this.DSi9Data = Buffer.from(
      slice(original, h.dsi9_rom_offset, Math.max(h.modcrypt1_size, h.dsi9_size), 'ARM9i'),
    );
    this.DSi7Data = Buffer.from(
      slice(original, h.dsi7_rom_offset, Math.max(h.modcrypt2_size, h.dsi7_size), 'ARM7i'),
    );
    this.Header2Data = h.trimmedRom
      ? null
      : Array.from({ length: 3 }, (_, i) =>
          Buffer.from(
            slice(original, h.digest_twl_start - 0x3000 + 0x1000 * i, 0x1000, 'Secondary header'),
          ),
        );
    this.Overlays9Sha1Hmac = overlays.map((o) =>
      hash(slice(original, o.offset, o.size, 'ARM9 overlay')),
    );
    let encrypted = false;
    const modcryptStart = [
      { start: h.modcrypt1_start, size: h.modcrypt1_size },
      { start: h.modcrypt2_start, size: h.modcrypt2_size },
    ].find(
      ({ start, size }) => size > 0 && start >= h.digest_twl_start && start < 0xffffffff,
    )?.start;
    if (modcryptStart !== undefined) {
      const index = Math.floor((modcryptStart - h.digest_twl_start) / h.digest_sector_size);
      const actual = hash(
        slice(
          original,
          h.digest_twl_start + index * h.digest_sector_size,
          h.digest_sector_size,
          'Modcrypt sector',
        ),
      );
      encrypted = !actual.equals(
        slice(
          this.Hashtable1Data,
          this.firstDSiHashOffset + index * 20,
          20,
          'Modcrypt sector hash',
        ),
      );
    }
    if (encrypted) this.cryptSections(h);
    this.twlEncrypted = !!(h.twlInternalFlags & 2);
  }
  private cryptSections(h: TwlHeader, writer?: BinaryWriter): void {
    const key = modcryptKey(h);
    for (const [id, data, start, counter] of [
      [1, this.DSi9Data, h.dsi9_rom_offset, h.hmac_arm9],
      [2, this.DSi7Data, h.dsi7_rom_offset, h.hmac_arm7],
    ] as const) {
      const size = h[`modcrypt${id}_size`];
      if (!size) continue;
      const off = h[`modcrypt${id}_start`] - start;
      const result = aes128CtrCrypt(
        key,
        slice(counter, 0, 16, 'Modcrypt counter'),
        slice(data, off, size, 'Modcrypt payload'),
      );
      if (writer) {
        writer.position = start + off;
        writer.write(result);
      } else result.copy(data, off);
    }
  }
  importArm9iData(data: Buffer | string, offset = 0, size?: number): void {
    this.DSi9Data = this.importData(data, offset, size);
  }
  importArm7iData(data: Buffer | string, offset = 0, size?: number): void {
    this.DSi7Data = this.importData(data, offset, size);
  }
  private importData(data: Buffer | string, offset: number, size?: number): Buffer {
    if (typeof data === 'string') data = readFileSync(data);
    size ??= data.length - offset;
    const src = slice(data, offset, size, 'DSi import');
    const out = Buffer.alloc(Math.ceil(size / 16) * 16, 255);
    src.copy(out);
    return out;
  }
  updateOverlays9Sha1Hmac(
    arm9Data: Buffer,
    header: Arm9Header,
    overlays: readonly Buffer[],
  ): Buffer {
    if (overlays.length !== this.Overlays9Sha1Hmac.length)
      throw new Error('Changing ARM9 overlay count is unsupported');
    const hashes = overlays.map(hash);
    if (hashes.every((h, i) => h.equals(this.Overlays9Sha1Hmac[i]))) return Buffer.from(arm9Data);
    const init = header.reserved2.readUInt32LE(0) & 0x3fff;
    const hdrptr = arm9Data.readUInt32LE(init + 0x14) - header.ARM9ramAddress;
    const unpacked = decompressArm9(arm9Data, header);
    const end = unpacked.data.readUInt32LE(init + 8) - header.ARM9ramAddress;
    let found = -1;
    for (
      let p = Math.min(end - hashes.length * 20, unpacked.data.length - hashes.length * 20);
      p >= 0;
      p--
    ) {
      if (unpacked.data.subarray(p, p + 20).equals(this.Overlays9Sha1Hmac[0])) {
        found = p;
        break;
      }
    }
    if (found < 0)
      throw new Error('ARM9 overlay hashes changed but original hash table was not found');
    hashes.forEach((h, i) => h.copy(unpacked.data, found + i * 20));
    // Original C# inverted this check and tried to compress uncompressed data.
    // Preserve the original storage format: recompress only a compressed ARM9.
    return unpacked.compressed
      ? compressArm9(unpacked.data, header, arm9Data.length - hdrptr)
      : unpacked.data;
  }
  writeTo(writer: BinaryWriter, h: TwlHeader): Buffer {
    validate(h);
    // Fixed DSi regions cannot be shifted safely without rewriting the header.
    if (writer.position > h.sector_hashtable_start) {
      throw new Error('NTR output overlaps the fixed DSi sector hash table');
    }
    if (
      h.sector_hashtable_start + h.sector_hashtable_size > h.block_hashtable_start ||
      h.block_hashtable_start + h.block_hashtable_size > h.dsi9_rom_offset ||
      h.dsi9_rom_offset + this.DSi9Data.length > h.dsi7_rom_offset ||
      h.dsi7_rom_offset + this.DSi7Data.length > h.total_rom_size
    ) {
      throw new Error('DSi sections overlap or exceed the ROM size');
    }
    const fill = (end: number): void => {
      if (writer.position < end) writer.fillTo(end, 255);
    };
    fill(h.sector_hashtable_start);
    writer.position = h.sector_hashtable_start + h.sector_hashtable_size;
    fill(h.block_hashtable_start);
    writer.position = h.block_hashtable_start + h.block_hashtable_size;
    fill(h.dsi9_rom_offset);
    if (this.Header2Data && !h.trimmedRom) {
      writer.position = h.digest_twl_start - 0x3000;
      this.Header2Data.forEach((b) => writer.write(b));
    }
    writer.position = h.dsi9_rom_offset;
    writer.write(this.DSi9Data);
    fill(h.dsi7_rom_offset);
    writer.position = h.dsi7_rom_offset;
    writer.write(this.DSi7Data);
    fill(h.total_rom_size);
    const finalPosition = writer.position;
    const read = (p: number, n: number): Buffer =>
      slice(writer.buffer.subarray(0, writer.length), p, n, 'TWL output digest');
    let secure: Buffer = Buffer.from(read(h.digest_ntr_start, 0x4000));
    if (h.decrypted) secure = encryptSecureArea(h.gameCode, secure);
    let index = 0;
    const put = (b: Buffer): void => {
      writer.position = h.sector_hashtable_start + index++ * 20;
      writer.write(hash(b));
    };
    for (let p = 0; p < 0x4000; p += h.digest_sector_size)
      put(secure.subarray(p, p + h.digest_sector_size));
    for (
      let p = h.digest_ntr_start + 0x4000;
      p < h.digest_ntr_start + h.digest_ntr_size;
      p += h.digest_sector_size
    )
      put(read(p, h.digest_sector_size));
    for (
      let p = h.digest_twl_start;
      p < h.digest_twl_start + h.digest_twl_size;
      p += h.digest_sector_size
    )
      put(read(p, h.digest_sector_size));
    index = 0;
    for (
      let p = h.sector_hashtable_start;
      p < h.sector_hashtable_start + h.sector_hashtable_size;
      p += h.digest_block_sectorcount * 20
    ) {
      const digest = hash(read(p, h.digest_block_sectorcount * 20));
      writer.position = h.block_hashtable_start + index++ * 20;
      writer.write(digest);
    }
    h.hmac_digest_master = hash(read(h.block_hashtable_start, h.block_hashtable_size));
    if (this.twlEncrypted) this.cryptSections(h, writer);
    writer.position = finalPosition;
    return h.hmac_digest_master;
  }
}

/** Refresh the digest and keep valid RSA signatures; optional no$gba hash mask. */
export const updateHeaderSignatures = (
  writer: BinaryWriter,
  header: SignedTwlHeader,
  originalHeader: Buffer,
  keepOriginal: boolean,
): void => {
  const signedData = Buffer.from(slice(originalHeader, 0, 0xe00, 'Signed header'));
  const digest = slice(header.hmac_digest_master, 0, 20, 'Master digest');
  const signature = slice(header.rsa_signature, 0, 128, 'RSA signature');
  digest.copy(signedData, 0x328);
  const valid = verifyRsaSha1(signedData, signature);
  const position = writer.position;
  writer.position = 0x328;
  writer.write(digest);
  if (!valid) {
    if (!keepOriginal) {
      const mask = Buffer.alloc(128, 0xff);
      mask[0] = 0;
      mask[1] = 1;
      mask[107] = 0;
      hashDigest('sha1', signedData).copy(mask, 108);
      header.rsa_signature = mask;
    }
    writer.position = 0xf80;
    writer.write(header.rsa_signature);
  }
  writer.position = position;
};
