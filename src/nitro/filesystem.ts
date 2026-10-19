// Based on NitroHelper FNT/FAT/OverlayTable, GPL-3.0.
import iconv from "iconv-lite";

import { BinaryWriter, bytes, range } from "./binary";

/** Original IDs/offsets describe the input ROM; newly added files use -1 until serialized and reopened. */
export interface NitroFile {
  name: string;
  nameBytes?: Buffer;
  id: number;
  offset: number;
  size: number;
  replacement?: Buffer;
}

export interface NitroFolder {
  name: string;
  nameBytes?: Buffer;
  id: number;
  files: NitroFile[];
  folders: NitroFolder[];
}

export const encodeName = (name: string): Buffer => {
  const encoded = iconv.encode(name, "shift_jis");
  if (new TextDecoder("shift_jis").decode(encoded) !== name)
    throw new Error(`FNT name cannot be represented in Shift_JIS: ${name}`);
  if (!encoded.length || encoded.length > 127) throw new Error("FNT name must contain 1 to 127 encoded bytes");
  return encoded;
};

export interface FileSystemLayout {
  fnt: Buffer;
  files: NitroFile[];
  ids: Map<NitroFile, number>;
  sourceIds: Map<number, number>;
}

export interface FatEntry {
  id: number;
  offset: number;
  size: number;
}

export class FileAllocationTable {
  readonly entries: FatEntry[];
  readonly sortedIDs: number[];

  constructor(input: Uint8Array, offset: number, size: number) {
    const data = bytes(input);
    const table = range(data, offset, size, "FAT");
    if (size % 8 || size / 8 > 65535) throw new Error("Invalid FAT entry count");
    this.entries = [];
    for (let p = 0; p < size; p += 8) {
      const start = table.readUInt32LE(p),
        end = table.readUInt32LE(p + 4);
      range(data, start, end - start, `FAT entry ${p / 8}`);
      this.entries.push({ id: p / 8, offset: start, size: end - start });
    }
    this.sortedIDs = [...this.entries].sort((a, b) => a.offset - b.offset || a.id - b.id).map((entry) => entry.id);
  }
}

export class FileNameTable {
  readonly root: NitroFolder;

  constructor(fat: FileAllocationTable, input: Uint8Array, offset: number, size: number) {
    const table = range(bytes(input), offset, size, "FNT");
    range(table, 0, 8, "FNT root directory");
    const count = table.readUInt16LE(6);
    if (count < 1 || count > 4096) throw new Error("Invalid FNT directory count");
    range(table, 0, count * 8, "FNT directory table");
    const decoder = new TextDecoder("shift_jis");
    const visited = new Set<number>();
    const fileIds = new Set<number>();
    const parse = (index: number, name: string, depth: number): NitroFolder => {
      if (depth > 256 || index >= count || visited.has(index)) throw new Error("Invalid FNT directory tree or cycle");
      visited.add(index);
      let cursor = table.readUInt32LE(index * 8);
      let fileId = table.readUInt16LE(index * 8 + 4);
      if (cursor < count * 8) throw new Error("FNT directory names overlap directory table");
      const folder: NitroFolder = {
        name,
        id: index === 0 ? 0xffff : 0xf000 + index,
        files: [],
        folders: [],
      };
      const names = new Set<string>();
      while (true) {
        const tag = range(table, cursor++, 1, "FNT name")[0];
        if (!tag) break;
        const length = tag & 0x7f;
        if (!length) throw new Error("Empty FNT directory name");
        const nameBytes = Buffer.from(range(table, cursor, length, "FNT filename"));
        const filename = decoder.decode(nameBytes);
        cursor += length;
        if (
          filename.includes("/") ||
          filename.includes("\\") ||
          filename.includes("\0") ||
          filename === "." ||
          filename === ".."
        )
          throw new Error("Invalid FNT path component");
        const normalized = filename.toLowerCase();
        if (names.has(normalized)) throw new Error(`Duplicate FNT path: ${filename}`);
        names.add(normalized);
        if (tag & 0x80) {
          const id = range(table, cursor, 2, "FNT directory id").readUInt16LE();
          cursor += 2;
          if (id < 0xf000) throw new Error("Invalid FNT directory id");
          const child = parse(id & 0xfff, filename, depth + 1);
          child.nameBytes = nameBytes;
          folder.folders.push(child);
        } else {
          const entry = fat.entries[fileId++];
          if (!entry) throw new Error("FNT file id is outside FAT");
          if (fileIds.has(entry.id)) throw new Error(`Duplicate FNT file id: ${entry.id}`);
          fileIds.add(entry.id);
          folder.files.push({ name: filename, nameBytes, ...entry });
        }
      }
      return folder;
    };
    this.root = { name: "root", id: 0xffff, files: [], folders: [parse(0, "data", 0)] };
  }

  serialize(fat: FileAllocationTable, overlays: NitroFile[]): FileSystemLayout {
    const directories: { folder: NitroFolder; parent: number; firstId: number }[] = [];
    const named: NitroFile[] = [];
    const sort = <T extends NitroFile | NitroFolder>(items: T[]): T[] =>
      [...items].sort((a, b) => Buffer.compare(a.nameBytes ?? encodeName(a.name), b.nameBytes ?? encodeName(b.name)));
    const visit = (folder: NitroFolder, parent: number): void => {
      const index = directories.length;
      directories.push({ folder, parent, firstId: named.length });
      if (directories.length > 4096) throw new Error("FNT directory count exceeds 4096");
      named.push(...sort(folder.files));
      for (const child of sort(folder.folders)) visit(child, 0xf000 + index);
    };
    visit(this.root.folders[0], 0xf000);
    const namedIds = new Set(named.filter((file) => file.id >= 0).map((file) => file.id));
    const overlayIds = new Set(overlays.map((file) => file.id));
    const unnamed = fat.entries.filter((entry) => !namedIds.has(entry.id));
    const files: NitroFile[] = [
      ...unnamed.filter((entry) => overlayIds.has(entry.id)),
      ...unnamed.filter((entry) => !overlayIds.has(entry.id)),
    ].map((entry) => ({ ...entry, name: `FAT entry ${entry.id}` }));
    const firstNamed = files.length;
    files.push(...named);
    if (files.length > 0xf000) throw new Error("Filesystem file IDs exceed 0xEFFF");
    const ids = new Map(files.map((file, id) => [file, id]));
    const sourceIds = new Map(files.filter((file) => file.id >= 0).map((file) => [file.id, ids.get(file)!]));
    const directoryIds = new Map(directories.map(({ folder }, index) => [folder, 0xf000 + index]));
    const writer = new BinaryWriter();
    writer.write(Buffer.alloc(directories.length * 8));
    for (const [index, { folder, parent, firstId }] of directories.entries()) {
      const record = Buffer.alloc(8);
      record.writeUInt32LE(writer.position);
      record.writeUInt16LE(firstNamed + firstId, 4);
      record.writeUInt16LE(index === 0 ? directories.length : parent, 6);
      record.copy(writer.buffer, index * 8);
      for (const file of sort(folder.files)) {
        const name = file.nameBytes ?? encodeName(file.name);
        writer.write(Buffer.from([name.length]));
        writer.write(name);
      }
      for (const child of sort(folder.folders)) {
        const name = child.nameBytes ?? encodeName(child.name);
        writer.write(Buffer.from([0x80 | name.length]));
        writer.write(name);
        const id = Buffer.alloc(2);
        id.writeUInt16LE(directoryIds.get(child)!);
        writer.write(id);
      }
      writer.write(Buffer.from([0]));
    }
    return { fnt: writer.toBuffer(), files, ids, sourceIds };
  }

  static findFile(id: number, folder: NitroFolder): NitroFile | undefined {
    for (const file of folder.files) if (file.id === id) return file;
    for (const subfolder of folder.folders) {
      const file = FileNameTable.findFile(id, subfolder);
      if (file) return file;
    }
    return undefined;
  }
}

export interface OverlayItem {
  overlayId: number;
  ramAddress: number;
  ramSize: number;
  bssSize: number;
  staticInitialiserStartAddress: number;
  staticInitialiserEndAddress: number;
  fileId: number;
  reserved: number;
}

const overlayFields = [
  "overlayId",
  "ramAddress",
  "ramSize",
  "bssSize",
  "staticInitialiserStartAddress",
  "staticInitialiserEndAddress",
  "fileId",
  "reserved",
] as const;

export class OverlayTable {
  readonly entries: OverlayItem[] = [];
  constructor(
    input: Uint8Array,
    offset: number,
    size: number,
    readonly isArm9: boolean,
  ) {
    if (!size) return;
    const table = range(bytes(input), offset, size, "overlay table");
    if (size % 32) throw new Error("Invalid overlay table size");
    for (let p = 0; p < size; p += 32) {
      if (table.readUInt32LE(p) === 0xffffffff) break;
      this.entries.push({
        overlayId: table.readUInt32LE(p),
        ramAddress: table.readUInt32LE(p + 4),
        ramSize: table.readUInt32LE(p + 8),
        bssSize: table.readUInt32LE(p + 12),
        staticInitialiserStartAddress: table.readUInt32LE(p + 16),
        staticInitialiserEndAddress: table.readUInt32LE(p + 20),
        fileId: table.readUInt32LE(p + 24),
        reserved: table.readUInt32LE(p + 28),
      });
    }
  }
  readBasicOverlays(fat: FileAllocationTable): NitroFile[] {
    return this.entries.map((item) => {
      const file = fat.entries[item.fileId];
      if (!file) throw new Error("Overlay file id is outside FAT");
      return {
        ...file,
        name: `overlay${this.isArm9 ? "" : "7"}_${String(item.overlayId).padStart(4, "0")}.bin`,
      };
    });
  }
  toBuffer(): Buffer {
    const data = Buffer.alloc(this.entries.length * 32);
    this.entries.forEach((entry, i) =>
      overlayFields.forEach((field, j) => data.writeUInt32LE(entry[field], i * 32 + j * 4)),
    );
    return data;
  }
}
