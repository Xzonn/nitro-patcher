const ALIGNMENT = 0x200;

export type FixtureBytes = Buffer | Uint8Array | string;

export interface RomOptions {
  arm9?: FixtureBytes;
  arm7?: FixtureBytes;
  banner?: FixtureBytes;
  hello?: FixtureBytes;
  item?: FixtureBytes;
  overlay?: boolean | FixtureBytes;
  /** Emit the 12-byte Nitrocode trailer which is stored after, but excluded from, ARM9 size. */
  nitrocode?: boolean;
  /** Emit a DSi-capable extended header without TWL-exclusive content. */
  dsi?: boolean;
}

export type ZipEntries =
  | Readonly<Record<string, FixtureBytes>>
  | ReadonlyMap<string, FixtureBytes>
  | Iterable<readonly [string, FixtureBytes]>;

function bytes(value: FixtureBytes | undefined, fallback: FixtureBytes): Buffer {
  if (value === undefined) return Buffer.from(fallback);
  return Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value);
}

function align(value: number, alignment = ALIGNMENT): number {
  return Math.ceil(value / alignment) * alignment;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function fntBuffer(firstFileId: number): Buffer {
  const rootNames = Buffer.concat([
    Buffer.from([9]),
    Buffer.from('hello.txt', 'ascii'),
    Buffer.from([0x83]),
    Buffer.from('sub', 'ascii'),
    Buffer.from([0x01, 0xf0, 0]),
  ]);
  const subNames = Buffer.concat([
    Buffer.from([8]),
    Buffer.from('item.bin', 'ascii'),
    Buffer.from([0]),
  ]);
  const mains = Buffer.alloc(16);
  mains.writeUInt32LE(16, 0);
  mains.writeUInt16LE(firstFileId, 4);
  mains.writeUInt16LE(2, 6);
  mains.writeUInt32LE(16 + rootNames.length, 8);
  mains.writeUInt16LE(firstFileId + 1, 12);
  mains.writeUInt16LE(0xf000, 14);
  return Buffer.concat([mains, rootNames, subNames]);
}

function overlayTable(fileId: number, size: number): Buffer {
  const table = Buffer.alloc(0x20);
  table.writeUInt32LE(0, 0);
  table.writeUInt32LE(0x02040000, 4);
  table.writeUInt32LE(size, 8);
  table.writeUInt32LE(fileId, 24);
  return table;
}

/** Create a deterministic, synthetic Nintendo DS ROM containing two NitroFS files. */
export const createRom = (options: RomOptions = {}): Buffer => {
  const arm9 = bytes(options.arm9, Buffer.alloc(0x4000));
  if (arm9.length < 0x4000) throw new RangeError('arm9 must be at least 0x4000 bytes');
  const arm7 = bytes(options.arm7, Buffer.alloc(0x180, 0xa7));
  const bannerInput = bytes(options.banner, Buffer.alloc(0x840));
  const banner = Buffer.alloc(Math.max(0x840, bannerInput.length));
  bannerInput.copy(banner);
  const hello = bytes(options.hello, 'hello from a synthetic ROM\n');
  const item = bytes(options.item, Buffer.from([0x10, 0x20, 0x30, 0x40]));
  const overlay =
    options.overlay === false || options.overlay === undefined
      ? null
      : bytes(options.overlay === true ? undefined : options.overlay, Buffer.alloc(0x60, 0x9a));
  const fnt = fntBuffer(overlay ? 1 : 0);
  const nitrocode = options.nitrocode ? Buffer.alloc(12) : Buffer.alloc(0);
  if (options.nitrocode) nitrocode.writeUInt32LE(0xdec00621, 0);
  const storedArm9 = Buffer.concat([arm9, nitrocode]);

  const headerSize = 0x4000;
  const arm9Offset = headerSize;
  let cursor = align(arm9Offset + storedArm9.length);
  const overlayTableOffset = overlay ? cursor : 0;
  if (overlay) cursor = align(cursor + 0x20);
  const overlayOffset = overlay ? cursor : 0;
  if (overlay) cursor = align(cursor + overlay.length);
  const arm7Offset = cursor;
  cursor = align(cursor + arm7.length);
  const fntOffset = cursor;
  cursor = align(cursor + fnt.length);
  const fatOffset = cursor;
  const fileCount = overlay ? 3 : 2;
  cursor = align(cursor + fileCount * 8);
  const bannerOffset = cursor;
  cursor = align(cursor + banner.length);
  const helloOffset = cursor;
  cursor = align(cursor + hello.length);
  const itemOffset = cursor;
  cursor = itemOffset + item.length;
  const logicalSize = cursor;
  const capacity = 2 ** Math.ceil(Math.log2(Math.max(logicalSize, 0x20000)));
  const rom = Buffer.alloc(capacity, 0xff);

  rom.fill(0, 0, headerSize);

  rom.write('SYNTHETICROM', 0, 12, 'ascii');
  rom.write('TST0', 12, 4, 'ascii');
  rom.write('ZZ', 16, 2, 'ascii');
  rom[18] = options.dsi ? 2 : 0;
  rom[20] = Math.log2(capacity) - 17;
  rom.writeUInt32LE(arm9Offset, 0x20);
  rom.writeUInt32LE(0x02000000, 0x24);
  rom.writeUInt32LE(0x02000000, 0x28);
  rom.writeUInt32LE(arm9.length, 0x2c);
  rom.writeUInt32LE(arm7Offset, 0x30);
  rom.writeUInt32LE(0x02380000, 0x34);
  rom.writeUInt32LE(0x02380000, 0x38);
  rom.writeUInt32LE(arm7.length, 0x3c);
  rom.writeUInt32LE(fntOffset, 0x40);
  rom.writeUInt32LE(fnt.length, 0x44);
  rom.writeUInt32LE(fatOffset, 0x48);
  rom.writeUInt32LE(fileCount * 8, 0x4c);
  rom.writeUInt32LE(overlayTableOffset, 0x50);
  rom.writeUInt32LE(overlay ? 0x20 : 0, 0x54);
  rom.writeUInt32LE(bannerOffset, 0x68);
  rom.writeUInt32LE(logicalSize, 0x80);
  rom.writeUInt32LE(headerSize, 0x84);

  storedArm9.copy(rom, arm9Offset);
  arm7.copy(rom, arm7Offset);
  fnt.copy(rom, fntOffset);
  banner.copy(rom, bannerOffset);
  hello.copy(rom, helloOffset);
  item.copy(rom, itemOffset);
  if (overlay) {
    overlayTable(0, overlay.length).copy(rom, overlayTableOffset);
    overlay.copy(rom, overlayOffset);
  }

  const fatEntries = overlay
    ? [
        [overlayOffset, overlayOffset + overlay.length],
        [helloOffset, helloOffset + hello.length],
        [itemOffset, itemOffset + item.length],
      ]
    : [
        [helloOffset, helloOffset + hello.length],
        [itemOffset, itemOffset + item.length],
      ];
  fatEntries.forEach(([start, end], index) => {
    rom.writeUInt32LE(start, fatOffset + index * 8);
    rom.writeUInt32LE(end, fatOffset + index * 8 + 4);
  });
  return rom;
};

/** Build a dependency-free ZIP with stored (uncompressed) entries. */
export const makeZip = (entries: ZipEntries): Buffer => {
  const normalized =
    entries instanceof Map
      ? [...entries]
      : Symbol.iterator in Object(entries)
        ? [...(entries as Iterable<readonly [string, FixtureBytes]>)]
        : Object.entries(entries as Readonly<Record<string, FixtureBytes>>);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [rawName, rawData] of normalized) {
    const name = Buffer.from(String(rawName).replaceAll('\\', '/'));
    const data = bytes(rawData, Buffer.alloc(0));
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(normalized.length, 8);
  end.writeUInt16LE(normalized.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
};
