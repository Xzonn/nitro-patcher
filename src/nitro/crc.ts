// CRCs used by the Nintendo DS header and banner (NitroHelper, GPL-3.0).
const table16 = new Uint16Array(256);
const table32 = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let a = i,
    b = i;
  for (let bit = 0; bit < 8; bit++) {
    a = (a >>> 1) ^ (a & 1 ? 0xa001 : 0);
    b = (b >>> 1) ^ (b & 1 ? 0xedb88320 : 0);
  }
  table16[i] = a;
  table32[i] = b;
}
export const crc16 = (data: Uint8Array, initial = 0xffff) => {
  let crc = initial;
  for (const byte of data) crc = (crc >>> 8) ^ table16[(crc ^ byte) & 0xff];
  return crc;
};
export const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ table32[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
};
