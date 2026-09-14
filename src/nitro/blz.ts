export interface Arm9Header {
  reserved2: Buffer;
  ARM9ramAddress: number;
  ARM9size: number;
}

// Native port of Xzonn/BlzHelper BLZ.cs (MIT), including overwrite-safe prefix.
// Compression returns an empty Buffer when no smaller representation exists.
export const decompressBLZ = (input: Buffer, maxSize = 0x10000000): Buffer => {
  if (input.length < 8) throw new Error("BLZ footer is truncated");
  const diff = input.readUInt32LE(input.length - 4);
  const packed = input.readUInt32LE(input.length - 8),
    header = packed >>> 24,
    length = packed & 0xffffff;
  const size = input.length + diff,
    prefix = input.length - length;
  if (header < 8 || header > length || length > input.length || size > maxSize)
    throw new Error("Invalid BLZ size or footer");
  const out = Buffer.alloc(size);
  input.copy(out, 0, 0, prefix);
  let src = input.length - header,
    dst = size;
  while (src > prefix) {
    const flags = input[--src];
    for (let bit = 128; bit && src > prefix; bit >>= 1) {
      if (!(flags & bit)) {
        if (dst <= prefix) throw new Error("BLZ output overflow");
        out[--dst] = input[--src];
      } else {
        if (src - 2 < prefix) throw new Error("Truncated BLZ reference");
        const high = input[--src],
          low = input[--src];
        const count = (high >>> 4) + 3,
          offset = (((high & 15) << 8) | low) + 3;
        if (dst - count < prefix || dst - 1 + offset >= size) throw new Error("Invalid BLZ reference");
        for (let j = 0; j < count; j++) {
          --dst;
          out[dst] = out[dst + offset];
        }
      }
    }
  }
  if (dst !== prefix) throw new Error("BLZ decompressed size mismatch");
  return out;
};

export const compressBLZ = (input: Buffer): Buffer => {
  if (input.length > 0xffffff) throw new Error("BLZ input exceeds 24-bit format limit");
  const temp = Buffer.alloc(input.length);
  let src = input.length,
    dst = input.length;
  // Linked candidate lists retain upstream nearest-match tie breaking without
  // scanning every byte of the 4 KiB search window for each literal.
  const heads = new Int32Array(256).fill(-1);
  const next = new Int32Array(input.length);
  let indexedFrom = input.length;
  while (src > 0) {
    if (dst < 1) return Buffer.alloc(0);
    const flagPos = --dst;
    let flags = 0;
    for (let bit = 0; bit < 8; bit++) {
      flags <<= 1;
      if (!src) continue;
      while (indexedFrom > src) {
        const p = --indexedFrom;
        next[p] = heads[input[p]];
        heads[input[p]] = p;
      }
      const maxCount = Math.min(src, 18);
      let best = 0,
        offset = 0;
      for (let p = heads[input[src - 1]]; p >= 0; p = next[p]) {
        const d = p - src + 1;
        if (d > 0x1002) break;
        let n = 0;
        const limit = Math.min(d, maxCount);
        while (n < limit && input[src - 1 - n] === input[src + d - 1 - n]) n++;
        if (n > best) {
          best = n;
          offset = d;
          if (best === maxCount) break;
        }
      }
      if (best < 3) {
        if (dst < 1) return Buffer.alloc(0);
        temp[--dst] = input[--src];
      } else {
        if (dst < 2) return Buffer.alloc(0);
        src -= best;
        dst -= 2;
        temp[dst] = (offset - 3) & 255;
        temp[dst + 1] = ((best - 3) << 4) | ((offset - 3) >>> 8);
        flags |= 1;
      }
    }
    temp[flagPos] = flags;
  }
  let packed = temp.subarray(dst),
    sourcePos = input.length,
    compressedPos = packed.length,
    prefix = 0,
    skip = 0;
  outer: while (sourcePos > 0) {
    const flags = packed[--compressedPos];
    for (let bit = 128; bit && sourcePos > 0; bit >>= 1) {
      if (!(flags & bit)) {
        compressedPos--;
        sourcePos--;
      } else {
        sourcePos -= (packed[compressedPos - 1] >>> 4) + 3;
        compressedPos -= 2;
        if (sourcePos < compressedPos) {
          prefix = sourcePos;
          skip = compressedPos;
          break outer;
        }
      }
    }
  }
  packed = Buffer.concat([input.subarray(0, prefix), packed.subarray(skip)]);
  const aligned = Math.ceil(packed.length / 4) * 4,
    finalSize = aligned + 8;
  if (finalSize >= input.length) return Buffer.alloc(0);
  const out = Buffer.alloc(finalSize, 255);
  packed.copy(out);
  const header = finalSize - packed.length,
    length = packed.length - prefix + header;
  out.writeUInt32LE(((header << 24) | length) >>> 0, finalSize - 8);
  out.writeUInt32LE(input.length - finalSize, finalSize - 4);
  return out;
};

export const decompressArm9 = (data: Buffer, header: Arm9Header): { compressed: boolean; data: Buffer } => {
  if (data.length < 0x18) throw new Error("ARM9 data too short");
  const nitro = data.readUInt32LE(0xc) === 0xdec00621 ? 12 : 0;
  const init = header.reserved2.readUInt32LE(0) & 0x3fff;
  const ptr = init ? data.readUInt32LE(init + 0x14) : header.ARM9ramAddress + header.ARM9size;
  const compressed = ptr > header.ARM9ramAddress && ptr + nitro >= header.ARM9ramAddress + data.length;
  return {
    compressed,
    data: compressed
      ? Buffer.concat([decompressBLZ(data.subarray(0, data.length - nitro)), data.subarray(data.length - nitro)])
      : Buffer.from(data),
  };
};
export const compressArm9 = (data: Buffer, header: Arm9Header, postSize = 0): Buffer => {
  if (data.length < 0x4000) throw new Error("ARM9 secure area is truncated");
  const nitro = data.readUInt32LE(0xc) === 0xdec00621 ? 12 : 0;
  const packed = compressBLZ(data.subarray(0x4000, data.length - nitro));
  if (!packed.length) throw new Error("ARM9 BLZ compression produced no smaller representation");
  const out = Buffer.concat([data.subarray(0, 0x4000), packed, data.subarray(data.length - nitro)]);
  const init = header.reserved2.readUInt32LE(0) & 0x3fff;
  if (init) out.writeUInt32LE(out.length - postSize + header.ARM9ramAddress, init + 0x14);
  return out;
};
