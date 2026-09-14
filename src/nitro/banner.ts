// Port of NitroHelper/Banner.cs. Copyright Xzonn and upstream contributors, GPL-3.0.
import { bytes, range } from "./binary";
import { crc16 } from "./crc";

const titles = [
  "japaneseTitle",
  "englishTitle",
  "frenchTitle",
  "germanTitle",
  "italianTitle",
  "spanishTitle",
  "chineseTitle",
  "koreanTitle",
] as const;
export class Banner {
  version: number;
  raw: Buffer;
  bannerCRC: boolean;
  tileData: Buffer;
  palette: Buffer;
  japaneseTitle = "";
  englishTitle = "";
  frenchTitle = "";
  germanTitle = "";
  italianTitle = "";
  spanishTitle = "";
  chineseTitle = "";
  koreanTitle = "";
  constructor(input: Uint8Array, offset = 0, hardSize = 0) {
    const data = bytes(input, "banner");
    this.version = range(data, offset, 2, "banner").readUInt16LE();
    let size = this.getDefSize(hardSize);
    if (this.version >>> 8 === 1) size = hardSize > 0 && hardSize !== 0xffffffff ? Math.min(hardSize, 0x23c0) : 0x23c0;
    this.raw = Buffer.from(range(data, offset, size, "banner"));
    this.bannerCRC = crc16(this.raw.subarray(0x20, 0x840)) === this.raw.readUInt16LE(2);
    this.tileData = Buffer.from(this.raw.subarray(0x20, 0x220));
    this.palette = Buffer.from(this.raw.subarray(0x220, 0x240));
    for (const [i, title] of titles.entries())
      this[title] =
        i < this.titleCount
          ? this.raw
              .subarray(0x240 + i * 0x100, 0x340 + i * 0x100)
              .toString("utf16le")
              .split("\0")[0]
          : "";
  }
  get titleCount() {
    return this.version >= 3 ? 8 : this.version >= 2 ? 7 : 6;
  }
  getDefSize(hardSize = 0) {
    if (this.version === 2) return 0x940;
    if (this.version === 3) return 0xa40;
    if (this.version === 0x103) return hardSize > 0 && hardSize !== 0xffffffff ? hardSize : 0x23c0;
    return 0x840;
  }
  toBuffer() {
    const output = Buffer.from(this.raw);
    output.writeUInt16LE(this.version);
    if (this.tileData.length !== 512 || this.palette.length !== 32) throw new RangeError("Invalid banner icon size");
    this.tileData.copy(output, 0x20);
    this.palette.copy(output, 0x220);
    for (let i = 0; i < this.titleCount; i++) {
      const text = Buffer.from(this[titles[i]], "utf16le");
      if (text.length > 256) throw new RangeError(`Banner ${titles[i]} exceeds 128 UTF-16 code units`);
      output.fill(0, 0x240 + i * 256, 0x340 + i * 256);
      text.copy(output, 0x240 + i * 256);
    }
    output.writeUInt16LE(crc16(output.subarray(0x20, 0x840)), 2);
    if (this.version >= 2) output.writeUInt16LE(crc16(output.subarray(0x20, 0x940)), 4);
    if (this.version >= 3) output.writeUInt16LE(crc16(output.subarray(0x20, 0xa40)), 6);
    if (this.version >>> 8 >= 1) output.writeUInt16LE(crc16(output.subarray(0x1240, 0x23c0)), 8);
    return output;
  }
}
