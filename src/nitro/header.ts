// Port of NitroHelper/Header.cs. Copyright Xzonn and upstream contributors, GPL-3.0.
import { bytes, range } from './binary';
import { crc16 } from './crc';
import { encryptSecureArea } from './crypto';

export const UnitCode = Object.freeze({ NDS: 0, NDS_DSi: 2, DSi: 3 });

export class Header {
  raw: Buffer;
  trimmedRom: boolean;
  doublePadding: boolean;
  nitrocode: boolean;
  decrypted: boolean;
  headerCRC: boolean;
  logoCRC: boolean;
  secureCRC: boolean;
  dlp_signature: Buffer;
  declare ARM9romOffset: number;
  declare ARM9entryAddress: number;
  declare ARM9ramAddress: number;
  declare ARM9size: number;
  declare ARM7romOffset: number;
  declare ARM7entryAddress: number;
  declare ARM7ramAddress: number;
  declare ARM7size: number;
  declare FNToffset: number;
  declare FNTsize: number;
  declare FAToffset: number;
  declare FATsize: number;
  declare ARM9overlayOffset: number;
  declare ARM9overlaySize: number;
  declare ARM7overlayOffset: number;
  declare ARM7overlaySize: number;
  declare flagsRead: number;
  declare flagsInit: number;
  declare bannerOffset: number;
  declare dsi9_rom_offset: number;
  declare offset_0x1C4: number;
  declare dsi9_ram_address: number;
  declare dsi9_size: number;
  declare dsi7_rom_offset: number;
  declare offset_0x1D4: number;
  declare dsi7_ram_address: number;
  declare dsi7_size: number;
  declare digest_ntr_start: number;
  declare digest_ntr_size: number;
  declare digest_twl_start: number;
  declare digest_twl_size: number;
  declare sector_hashtable_start: number;
  declare sector_hashtable_size: number;
  declare block_hashtable_start: number;
  declare block_hashtable_size: number;
  declare digest_sector_size: number;
  declare digest_block_sectorcount: number;
  declare banner_size: number;
  declare offset_0x20C: number;
  declare total_rom_size: number;
  declare offset_0x214: number;
  declare offset_0x218: number;
  declare offset_0x21C: number;
  declare modcrypt1_start: number;
  declare modcrypt1_size: number;
  declare modcrypt2_start: number;
  declare modcrypt2_size: number;
  declare tid_low: number;
  declare tid_high: number;
  declare public_sav_size: number;
  declare private_sav_size: number;
  declare unitCode: number;
  declare encryptionSeed: number;
  declare twlInternalFlags: number;
  declare permitsFlags: number;
  declare ROMversion: number;
  declare internalFlags: number;
  declare secureCRC16: number;
  declare ROMtimeout: number;
  declare ARM9autoload: number;
  declare ARM7autoload: number;
  declare ROMsize: number;
  declare headerSize: number;
  declare logoCRC16: number;
  declare headerCRC16: number;
  declare debug_romOffset: number;
  declare debug_size: number;
  declare debug_ramAddress: number;
  declare reserved3: number;
  declare mbk9_wramcnt_setting: number;
  declare region_flags: number;
  declare access_control: number;
  declare scfg_ext_mask: number;
  declare gameTitle: string;
  declare gameCode: string;
  declare makerCode: string;
  declare reserved: Buffer;
  declare reserved2: Buffer;
  declare logo: Buffer;
  declare appflags: Buffer;
  declare hmac_arm9: Buffer;
  declare hmac_arm7: Buffer;
  declare hmac_digest_master: Buffer;
  declare hmac_icon_title: Buffer;
  declare hmac_arm9i: Buffer;
  declare hmac_arm7i: Buffer;
  declare hmac_arm9_no_secure: Buffer;
  declare rsa_signature: Buffer;
  declare secureDisable: bigint;

  constructor(input: Uint8Array) {
    const data = bytes(input, 'header');
    range(data, 0, 0x170, 'header');
    const size = data.readUInt32LE(0x84);
    if (size < 0x170 || size > data.length) throw new RangeError(`Invalid header size: ${size}`);
    this.raw = Buffer.from(data.subarray(0, size));
    if (this.unitCode & 2 && size > 0x200) range(this.raw, 0, 0x1000, 'DSi header');
    this.trimmedRom = this.total_rom_size
      ? this.total_rom_size >= data.length
      : data.length !== this.size;
    this.doublePadding =
      (this.ARM9size % 0x400 < 0x200 &&
        this.ARM7romOffset % 0x400 === 0 &&
        this.ARM9overlayOffset % 0x400 === 0) ||
      (this.ARM7size % 0x400 < 0x200 &&
        this.FNToffset % 0x400 === 0 &&
        this.ARM7overlayOffset % 0x400 === 0) ||
      (this.FNTsize % 0x400 < 0x200 && this.FAToffset % 0x400 === 0) ||
      (this.FATsize % 0x400 < 0x200 && this.bannerOffset % 0x400 === 0);
    const nitroOffset = this.ARM9romOffset + this.ARM9size;
    this.nitrocode =
      nitroOffset >= size &&
      nitroOffset + 4 <= data.length &&
      data.readUInt32LE(nitroOffset) === 0xdec00621;
    this.decrypted = data.length >= 0x4008 && data.readBigUInt64LE(0x4000) === 0xe7ffdeffe7ffdeffn;
    this.headerCRC = crc16(this.raw.subarray(0, 0x15e)) === this.headerCRC16;
    this.logoCRC = crc16(this.logo) === this.logoCRC16;
    const secure = data.subarray(0x4000, 0x8000);
    this.secureCRC =
      secure.length > 0 &&
      crc16(this.decrypted ? encryptSecureArea(this.gameCode, secure) : secure) ===
        this.secureCRC16;
    this.dlp_signature = Buffer.alloc(0);
    if (
      this.ROMsize >= size &&
      this.ROMsize + 0x88 <= data.length &&
      data.readUInt32LE(this.ROMsize) === 0x00016361
    ) {
      this.dlp_signature = Buffer.from(data.subarray(this.ROMsize, this.ROMsize + 0x88));
    }
  }

  get size() {
    return 2 ** (17 + this.raw[0x14]);
  }
  set size(value: number) {
    const power = Math.log2(value);
    if (!Number.isInteger(power) || power < 17 || power > 32)
      throw new RangeError('ROM capacity must be a power of two from 128 KiB to 4 GiB');
    this.raw[0x14] = power - 17;
  }
  toBuffer() {
    const data = Buffer.from(this.raw);
    data.writeUInt16LE(crc16(data.subarray(0xc0, 0x15c)), 0x15c);
    data.writeUInt16LE(crc16(data.subarray(0, 0x15e)), 0x15e);
    return data;
  }
  toString() {
    return `NDS header: ${this.gameTitle.replace(/\0+$/, '')} (${this.gameCode})`;
  }
}

function field(
  name: string,
  offset: number,
  length: number,
  type: 'buffer' | 'string' | 'number' = 'buffer',
  dsi = false,
) {
  Object.defineProperty(Header.prototype, name, {
    enumerable: true,
    get(this: Header) {
      if (dsi && (!(this.unitCode & 2) || this.raw.length <= 0x200))
        return type === 'buffer' ? Buffer.alloc(length) : 0;
      const data = range(this.raw, offset, length, `header ${name}`);
      if (type === 'string') return data.toString('latin1');
      if (type === 'buffer') return data;
      return length === 8 ? data.readBigUInt64LE() : data.readUIntLE(0, length);
    },
    set(this: Header, value: string | number | bigint | Uint8Array) {
      const target = range(this.raw, offset, length, `header ${name}`);
      if (type === 'string') {
        if (typeof value !== 'string' || Buffer.byteLength(value, 'latin1') > length)
          throw new TypeError(`Invalid ${name}`);
        target.fill(0);
        target.write(value, 'latin1');
      } else if (type === 'buffer') {
        if (!(value instanceof Uint8Array)) throw new TypeError(`Invalid ${name}`);
        const source = bytes(value, name);
        if (source.length !== length) throw new RangeError(`${name} must contain ${length} bytes`);
        source.copy(target);
      } else if (length === 8) {
        if (typeof value !== 'bigint') throw new TypeError(`Invalid ${name}`);
        target.writeBigUInt64LE(value);
      } else {
        if (typeof value !== 'number') throw new TypeError(`Invalid ${name}`);
        target.writeUIntLE(value, 0, length);
      }
    },
  });
}
field('gameTitle', 0, 12, 'string');
field('gameCode', 12, 4, 'string');
field('makerCode', 16, 2, 'string');
for (const [name, offset] of Object.entries({
  unitCode: 0x12,
  encryptionSeed: 0x13,
  twlInternalFlags: 0x1c,
  permitsFlags: 0x1d,
  ROMversion: 0x1e,
  internalFlags: 0x1f,
}))
  field(name, offset, 1, 'number');
field('reserved', 0x15, 7);
const ntr32 =
  'ARM9romOffset ARM9entryAddress ARM9ramAddress ARM9size ARM7romOffset ARM7entryAddress ARM7ramAddress ARM7size FNToffset FNTsize FAToffset FATsize ARM9overlayOffset ARM9overlaySize ARM7overlayOffset ARM7overlaySize flagsRead flagsInit bannerOffset'.split(
    ' ',
  );
ntr32.forEach((name, i) => field(name, 0x20 + i * 4, 4, 'number'));
field('secureCRC16', 0x6c, 2, 'number');
field('ROMtimeout', 0x6e, 2, 'number');
field('ARM9autoload', 0x70, 4, 'number');
field('ARM7autoload', 0x74, 4, 'number');
field('secureDisable', 0x78, 8, 'number');
field('ROMsize', 0x80, 4, 'number');
field('headerSize', 0x84, 4, 'number');
field('reserved2', 0x88, 56);
field('logo', 0xc0, 156);
field('logoCRC16', 0x15c, 2, 'number');
field('headerCRC16', 0x15e, 2, 'number');
'debug_romOffset debug_size debug_ramAddress reserved3'
  .split(' ')
  .forEach((name, i) => field(name, 0x160 + i * 4, 4, 'number'));
field('appflags', 0x1bc, 4, 'buffer', true);
'mbk9_wramcnt_setting region_flags access_control scfg_ext_mask'
  .split(' ')
  .forEach((name, i) => field(name, 0x1ac + i * 4, 4, 'number', true));
const twl32 =
  'dsi9_rom_offset offset_0x1C4 dsi9_ram_address dsi9_size dsi7_rom_offset offset_0x1D4 dsi7_ram_address dsi7_size digest_ntr_start digest_ntr_size digest_twl_start digest_twl_size sector_hashtable_start sector_hashtable_size block_hashtable_start block_hashtable_size digest_sector_size digest_block_sectorcount banner_size offset_0x20C total_rom_size offset_0x214 offset_0x218 offset_0x21C modcrypt1_start modcrypt1_size modcrypt2_start modcrypt2_size tid_low tid_high public_sav_size private_sav_size'.split(
    ' ',
  );
twl32.forEach((name, i) => field(name, 0x1c0 + i * 4, 4, 'number', true));
'hmac_arm9 hmac_arm7 hmac_digest_master hmac_icon_title hmac_arm9i hmac_arm7i'
  .split(' ')
  .forEach((name, i) => field(name, 0x300 + i * 20, 20, 'buffer', true));
field('hmac_arm9_no_secure', 0x3a0, 20, 'buffer', true);
field('rsa_signature', 0xf80, 0x80, 'buffer', true);
