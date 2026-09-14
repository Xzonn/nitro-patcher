// Based on NitroHelper FNT/FAT/OverlayTable, GPL-3.0.
import { bytes, range } from "./binary";

/** A file in the original ROM, optionally replaced with new bytes. */
export interface NitroFile {
  name: string;
  id: number;
  offset: number;
  size: number;
  replacement?: Buffer;
}

export interface NitroFolder {
  name: string;
  id: number;
  files: NitroFile[];
  folders: NitroFolder[];
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
        const filename = decoder.decode(range(table, cursor, length, "FNT filename"));
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
          folder.folders.push(parse(id & 0xfff, filename, depth + 1));
        } else {
          const entry = fat.entries[fileId++];
          if (!entry) throw new Error("FNT file id is outside FAT");
          if (fileIds.has(entry.id)) throw new Error(`Duplicate FNT file id: ${entry.id}`);
          fileIds.add(entry.id);
          folder.files.push({ name: filename, ...entry });
        }
      }
      return folder;
    };
    this.root = { name: "root", id: 0xffff, files: [], folders: [parse(0, "data", 0)] };
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
