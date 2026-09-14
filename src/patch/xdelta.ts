/** Native RFC 3284 VCDIFF decoder with the xdelta3 Adler32/app-header extensions.
 * Supports the same default-table, uncompressed format as PleOps.XdeltaSharp 1.3.0.
 * Secondary compression and custom code tables are explicitly unsupported there too.
 */
const UINT32_MAX = 0xffffffff;
const fail = (message: string): never => {
  throw new Error(`VCDIFF: ${message}`);
};

class Reader {
  pos = 0;
  constructor(
    readonly bytes: Buffer,
    readonly label = "patch",
  ) {}
  get remaining() {
    return this.bytes.length - this.pos;
  }
  byte() {
    if (!this.remaining) fail(`truncated ${this.label}`);
    return this.bytes[this.pos++]!;
  }
  integer(): number {
    let value = 0;
    for (let count = 0; count < 5; count++) {
      const byte = this.byte();
      value = value * 128 + (byte & 127);
      if (value > UINT32_MAX) fail(`integer exceeds 32-bit limit in ${this.label}`);
      if (!(byte & 128)) return value;
    }
    return fail(`invalid variable-length integer in ${this.label}`);
  }
  take(size: number): Buffer {
    if (size > this.remaining) fail(`truncated ${this.label}: requested ${size} bytes, ${this.remaining} remain`);
    const result = this.bytes.subarray(this.pos, this.pos + size);
    this.pos += size;
    return result;
  }
}

// RFC 3284 section 5.6: (operation, size, COPY address mode), up to two per opcode.
interface Operation {
  type: "ADD" | "RUN" | "COPY";
  size: number;
  mode: number;
}
const table: Operation[][] = [];
const op = (type: Operation["type"], size: number, mode = 0): Operation => ({ type, size, mode });
table.push([op("RUN", 0)]);
for (let size = 0; size <= 17; size++) table.push([op("ADD", size)]);
for (let mode = 0; mode <= 8; mode++) {
  table.push([op("COPY", 0, mode)]);
  for (let size = 4; size <= 18; size++) table.push([op("COPY", size, mode)]);
}
for (let mode = 0; mode <= 5; mode++) {
  for (let add = 1; add <= 4; add++) {
    for (let copy = 4; copy <= 6; copy++) table.push([op("ADD", add), op("COPY", copy, mode)]);
  }
}
for (let mode = 6; mode <= 8; mode++) {
  for (let add = 1; add <= 4; add++) table.push([op("ADD", add), op("COPY", 4, mode)]);
}
for (let mode = 0; mode <= 8; mode++) table.push([op("COPY", 4, mode), op("ADD", 1)]);

function adler32(bytes: Uint8Array): number {
  let a = 1,
    b = 0;
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(start + 5552, bytes.length);
    for (let i = start; i < end; i++) {
      a += bytes[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return (b * 65536 + a) >>> 0;
}

function asBuffer(value: Uint8Array, name: string): Buffer {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be a Buffer or Uint8Array`);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
function limit(value: number | undefined, fallback: number, name: string): number {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX)
    throw new RangeError(`${name} must be an integer between 0 and ${UINT32_MAX}`);
  return value;
}

/**
 * @param {Buffer|Uint8Array} source Original bytes.
 * @param {Buffer|Uint8Array} patch VCDIFF bytes.
 * @param {{maxOutputSize?: number, maxWindowSize?: number}} [options]
 * @returns {Buffer} Decoded target, only returned after all windows/checksums validate.
 */
export interface XdeltaOptions {
  maxOutputSize?: number;
  maxWindowSize?: number;
}

export const decodeXdelta = (source: Uint8Array, patch: Uint8Array, options: XdeltaOptions = {}): Buffer => {
  const sourceBytes = asBuffer(source, "source");
  const reader = new Reader(asBuffer(patch, "patch"));
  const maxOutput = limit(options.maxOutputSize, 1024 * 1024 * 1024, "maxOutputSize");
  const maxWindow = limit(options.maxWindowSize, 16 * 1024 * 1024, "maxWindowSize");
  if (!reader.take(3).equals(Buffer.from([0xd6, 0xc3, 0xc4]))) fail("invalid file signature");
  if (reader.byte() !== 0) fail("unsupported version (expected 0)");
  const header = reader.byte();
  if (header & ~7) fail("unrecognized header indicator bits");
  if (header & 1) fail("secondary compression is unsupported; recreate the patch using xdelta3 -S none");
  if (header & 2) fail("custom code table is unsupported");
  if (header & 4) reader.take(reader.integer());
  const windows: Buffer[] = [];
  let total = 0;

  while (reader.remaining) {
    const indicator = reader.byte();
    if (indicator & ~7 || (indicator & 3) === 3)
      fail("invalid window indicator: source and target are mutually exclusive");
    let dictionary: Buffer = Buffer.alloc(0);
    if (indicator & 3) {
      const length = reader.integer();
      const offset = reader.integer();
      const available = indicator & 1 ? sourceBytes.length : total;
      if (offset > available || length > available - offset)
        fail("source segment exceeds available source/target bounds");
      if (indicator & 1) dictionary = sourceBytes.subarray(offset, offset + length);
      else {
        dictionary = Buffer.allocUnsafe(length);
        let base = 0;
        for (const previous of windows) {
          const start = Math.max(offset, base),
            end = Math.min(offset + length, base + previous.length);
          if (end > start) previous.copy(dictionary, start - offset, start - base, end - base);
          base += previous.length;
          if (base >= offset + length) break;
        }
      }
    }
    const deltaLength = reader.integer();
    const delta = new Reader(reader.take(deltaLength), "delta window");
    const targetLength = delta.integer();
    if (targetLength > maxWindow) fail(`window size ${targetLength} exceeds maximum limit ${maxWindow}`);
    if (targetLength > maxOutput - total) fail(`output size exceeds maximum limit ${maxOutput}`);
    if (dictionary.length + targetLength > UINT32_MAX) fail("window address space exceeds 32-bit limit");
    const compressed = delta.byte();
    if (compressed & ~7) fail("unrecognized delta indicator bits");
    if (compressed) fail("secondary compression in delta sections is unsupported");
    const dataLength = delta.integer(),
      instructionLength = delta.integer(),
      addressLength = delta.integer();
    const checksum = indicator & 4 ? delta.take(4).readUInt32BE() : null;
    const data = new Reader(delta.take(dataLength), "data section");
    const instructions = new Reader(delta.take(instructionLength), "instruction section");
    const addresses = new Reader(delta.take(addressLength), "address section");
    if (delta.remaining) fail("delta encoding length does not match section lengths");
    const target = Buffer.allocUnsafe(targetLength);
    const near = new Uint32Array(4),
      same = new Uint32Array(768);
    let nearIndex = 0,
      position = 0;
    while (instructions.remaining) {
      const operations = table[instructions.byte()]!;
      for (const { type, size: fixedSize, mode } of operations) {
        const size = fixedSize || instructions.integer();
        if (size > targetLength - position) fail(`${type} size exceeds target window length`);
        if (type === "ADD") {
          data.take(size).copy(target, position);
        } else if (type === "RUN") {
          target.fill(data.byte(), position, position + size);
        } else {
          const here = dictionary.length + position;
          let address;
          if (mode === 0) address = addresses.integer();
          else if (mode === 1) address = here - addresses.integer();
          else if (mode < 6) address = near[mode - 2]! + addresses.integer();
          else address = same[(mode - 6) * 256 + addresses.byte()]!;
          if (address < 0 || address >= here) fail(`COPY address ${address} is outside decoded address space ${here}`);
          near[nearIndex] = address;
          nearIndex = (nearIndex + 1) % near.length;
          same[address % same.length] = address;
          let copied = 0;
          if (address < dictionary.length) {
            copied = Math.min(size, dictionary.length - address);
            dictionary.copy(target, position, address, address + copied);
          }
          // Copy only already available bytes per iteration. Doubling handles overlap
          // (including a copy crossing from dictionary to current target) efficiently.
          const from = Math.max(0, address - dictionary.length);
          while (copied < size) {
            const count = Math.min(size - copied, position + copied - from);
            if (count <= 0) fail("COPY references unavailable target bytes");
            target.copy(target, position + copied, from, from + count);
            copied += count;
          }
        }
        position += size;
      }
    }
    if (position !== targetLength) fail(`target window length mismatch: decoded ${position}, expected ${targetLength}`);
    if (data.remaining || addresses.remaining) fail("unused bytes in data/address section");
    if (checksum !== null && adler32(target) !== checksum) fail("Adler32 checksum mismatch");
    windows.push(target);
    total += targetLength;
  }
  return Buffer.concat(windows, total);
};
