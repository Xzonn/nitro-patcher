export const DEFAULT_MAX_SIZE = 0x40000000;

export const bytes = (value: Uint8Array, name = "input"): Buffer => {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be a Buffer or Uint8Array`);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};

export const range = (buffer: Buffer, offset: number, size: number, name = "binary data"): Buffer => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset + size > buffer.length
  ) {
    throw new RangeError(`Invalid ${name} range: offset=${offset}, size=${size}, available=${buffer.length}`);
  }
  return buffer.subarray(offset, offset + size);
};

export const align = (value: number, alignment = 0x200): number => Math.ceil(value / alignment) * alignment;

/** Seekable, bounded in-memory writer; unwritten gaps have MemoryStream's zero fill. */
export class BinaryWriter {
  readonly maxSize: number;
  buffer: Buffer;
  position: number;
  length: number;
  constructor(initialSize = 65536, maxSize = DEFAULT_MAX_SIZE) {
    if (!Number.isSafeInteger(maxSize) || maxSize < 1 || maxSize > 0xffffffff)
      throw new RangeError("Invalid output size limit");
    this.maxSize = maxSize;
    this.buffer = Buffer.alloc(Math.min(initialSize, maxSize));
    this.position = 0;
    this.length = 0;
  }

  ensure(end: number) {
    if (!Number.isSafeInteger(end) || end < 0 || end > this.maxSize)
      throw new RangeError(`Output exceeds size limit (${this.maxSize} bytes)`);
    if (end <= this.buffer.length) return;
    const next = Buffer.alloc(Math.min(this.maxSize, Math.max(end, this.buffer.length * 2, 1024)));
    this.buffer.copy(next, 0, 0, this.length);
    this.buffer = next;
  }

  write(data: Uint8Array) {
    data = bytes(data);
    if (!Number.isSafeInteger(this.position) || this.position < 0) throw new RangeError("Invalid writer position");
    this.ensure(this.position + data.length);
    bytes(data).copy(this.buffer, this.position);
    this.position += data.length;
    this.length = Math.max(this.length, this.position);
  }

  fillTo(end: number, fill = 0xff) {
    this.ensure(end);
    if (end <= this.position) return;
    this.buffer.fill(fill, this.position, end);
    this.position = end;
    this.length = Math.max(this.length, end);
  }

  pad(alignment: number, fill = 0xff) {
    this.fillTo(align(this.position, alignment), fill);
  }
  toBuffer() {
    return this.buffer.subarray(0, this.length);
  }
}
