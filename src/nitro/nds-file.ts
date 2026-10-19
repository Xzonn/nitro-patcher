// Native TypeScript port of NitroHelper/NDSFile.cs, GPL-3.0.
import { readFile, writeFile } from "#nitro-runtime";

import { Banner } from "./banner";
import { BinaryWriter, DEFAULT_MAX_SIZE, bytes, range } from "./binary";
import { crc16 } from "./crc";
import { encryptSecureArea } from "./crypto";
import { FileAllocationTable, FileNameTable, OverlayTable, encodeName } from "./filesystem";
import type { NitroFile, NitroFolder } from "./filesystem";
import { Header } from "./header";
import { TWL } from "./twl";

export interface RomOptions {
  /** Maximum generated ROM size in bytes. Defaults to 1 GiB. */
  maxOutputSize?: number;
}

export interface RomFileInfo {
  /** ROM-relative path, including data/, overlay/, or a system filename. */
  path: string;
  /** Input ROM identity and position; both are -1 for an added file until the output is reopened. */
  id: number;
  offset: number;
  size: number;
}

const key = (path: string): string => path.replaceAll("\\", "/").toLowerCase();

/** Parsed Nintendo DS ROM. Replacements do not change the input buffer. */
export class NDSFile {
  readonly original: Buffer;
  readonly header: Header;
  readonly banner: Banner;
  readonly fatTable: FileAllocationTable;
  readonly fntTable: FileNameTable;
  readonly overlay9Table: OverlayTable;
  readonly overlay7Table: OverlayTable;
  readonly root: NitroFolder;
  readonly twl: TWL | undefined;
  readonly warnings: string[] = [];
  private readonly paths = new Map<string, { path: string; file: NitroFile }>();
  private readonly maxOutputSize: number;
  private structureChanged = false;

  constructor(input: Uint8Array, options: RomOptions = {}) {
    this.original = bytes(input, "ROM");
    this.maxOutputSize = options.maxOutputSize ?? DEFAULT_MAX_SIZE;
    this.header = new Header(this.original);
    const h = this.header;
    range(this.original, h.ARM9romOffset, h.ARM9size + (h.nitrocode ? 12 : 0), "ARM9");
    range(this.original, h.ARM7romOffset, h.ARM7size, "ARM7");
    this.banner = new Banner(this.original, h.bannerOffset, h.banner_size);
    this.fatTable = new FileAllocationTable(this.original, h.FAToffset, h.FATsize);
    this.fntTable = new FileNameTable(this.fatTable, this.original, h.FNToffset, h.FNTsize);
    this.root = this.fntTable.root;
    this.overlay9Table = new OverlayTable(this.original, h.ARM9overlayOffset, h.ARM9overlaySize, true);
    this.overlay7Table = new OverlayTable(this.original, h.ARM7overlayOffset, h.ARM7overlaySize, false);
    const arm9Overlays = this.overlay9Table.readBasicOverlays(this.fatTable);
    this.root.folders.push({
      name: "overlay",
      id: 0xffff,
      files: [...arm9Overlays, ...this.overlay7Table.readBasicOverlays(this.fatTable)],
      folders: [],
    });
    const system = (name: string, offset: number, size: number): void => {
      range(this.original, offset, size, name);
      this.root.files.push({ name, id: 0xffff, offset, size });
    };
    system("header.bin", 0, h.headerSize);
    system("banner.bin", h.bannerOffset, this.banner.raw.length);
    system("fnt.bin", h.FNToffset, h.FNTsize);
    system("fat.bin", h.FAToffset, h.FATsize);
    system("arm9.bin", h.ARM9romOffset, h.ARM9size + (h.nitrocode ? 12 : 0));
    system("arm7.bin", h.ARM7romOffset, h.ARM7size);
    if (h.ARM9overlaySize) system("overarm9.bin", h.ARM9overlayOffset, h.ARM9overlaySize);
    if (h.ARM7overlaySize) system("overarm7.bin", h.ARM7overlayOffset, h.ARM7overlaySize);
    const visit = (folder: NitroFolder, prefix: string): void => {
      for (const file of folder.files) {
        const path = prefix + file.name;
        if (this.paths.has(key(path))) throw new Error(`Duplicate ROM path: ${path}`);
        this.paths.set(key(path), { path, file });
      }
      for (const child of folder.folders) visit(child, `${prefix + child.name}/`);
    };
    visit(this.root, "");
    if (h.unitCode & 2 && h.twlInternalFlags & 1 && h.tid_high && h.tid_high !== 0xffffffff) {
      // Upstream silently discarded malformed TWL regions. Preserve valid DSi data,
      // and reject malformed data instead of emitting a ROM with missing sections.
      this.twl = new TWL(h, arm9Overlays, this.original);
    }
  }

  static async fromFile(path: string, options: RomOptions = {}): Promise<NDSFile> {
    return new NDSFile(await readFile(path), options);
  }
  get data(): NitroFolder {
    return this.root.folders[0];
  }
  get overlay(): NitroFolder {
    return this.root.folders[1];
  }

  listFiles(): RomFileInfo[] {
    return [...this.paths.values()].map(({ path, file }) => ({
      path,
      id: file.id,
      offset: file.offset,
      size: file.replacement?.length ?? file.size,
    }));
  }
  hasFile(path: string): boolean {
    return this.paths.has(key(path));
  }
  getFile(path: string): Buffer {
    const entry = this.paths.get(key(path));
    if (!entry) throw new Error(`ROM file not found: ${path}`);
    return Buffer.from(this.fileBytes(entry.file));
  }
  /** Replace an existing file. */
  replaceFile(path: string, content: Uint8Array): void {
    const entry = this.paths.get(key(path));
    if (!entry) throw new Error(`ROM file not found: ${path}`);
    entry.file.replacement = Buffer.from(bytes(content));
  }
  /** Add a NitroFS file and any missing parent directories. */
  addFile(path: string, content: Uint8Array): void {
    const components = path.replaceAll("\\", "/").split("/");
    if (
      components[0]?.toLowerCase() !== "data" ||
      components.length < 2 ||
      components.slice(1).some((name) => !name || name === "." || name === ".." || name.includes("\0"))
    )
      throw new Error(`Invalid NitroFS path: ${path}`);
    if (components.length > 258) throw new Error("FNT directory depth exceeds 256");
    if (this.hasFile(path)) throw new Error(`ROM file already exists: ${path}`);
    const replacement = Buffer.from(bytes(content));
    const names: { name: string; nameBytes?: Buffer }[] = components.slice(1).map((name) => ({ name }));
    let existing: NitroFolder | undefined = this.data;
    for (const [index, component] of names.entries()) {
      const normalized = component.name.toLowerCase();
      if (existing?.files.some((file) => file.name.toLowerCase() === normalized))
        throw new Error(`ROM path conflicts with a file: ${path}`);
      const child: NitroFolder | undefined = existing?.folders.find((child) => child.name.toLowerCase() === normalized);
      if (index === names.length - 1 && child) throw new Error(`ROM path conflicts with a directory: ${path}`);
      if (!child) component.nameBytes = encodeName(component.name);
      existing = child;
    }
    let folder = this.data;
    let prefix = "data";
    for (const [index, component] of names.entries()) {
      const normalized = component.name.toLowerCase();
      const child = folder.folders.find((child) => child.name.toLowerCase() === normalized);
      if (index === names.length - 1) {
        const file: NitroFile = { ...component, id: -1, offset: -1, size: replacement.length, replacement };
        folder.files.push(file);
        const outputPath = `${prefix}/${file.name}`;
        this.paths.set(key(outputPath), { path: outputPath, file });
      } else {
        if (child) folder = child;
        else {
          const created: NitroFolder = { ...component, id: -1, files: [], folders: [] };
          folder.folders.push(created);
          folder = created;
        }
        prefix += `/${folder.name}`;
      }
    }
    this.structureChanged = true;
  }
  private fileBytes(file: NitroFile): Buffer {
    return file.replacement ?? range(this.original, file.offset, file.size, file.name);
  }

  /** Rebuild offsets, allocation table, CRCs and ROM padding. Safe to call repeatedly. */
  toBuffer(): Buffer {
    const fntReplacement = this.root.files.find((file) => file.name === "fnt.bin")?.replacement;
    if (this.structureChanged && fntReplacement) throw new Error("Adding files conflicts with an fnt.bin replacement");
    if (fntReplacement) {
      const replacementTree = new FileNameTable(this.fatTable, fntReplacement, 0, fntReplacement.length);
      const collect = (folder: NitroFolder): number[] =>
        [...folder.files.map((file) => file.id), ...folder.folders.flatMap(collect)].sort((a, b) => a - b);
      if (collect(replacementTree.root).join(",") !== collect(this.data).join(","))
        throw new Error("Replacement FNT must preserve existing file IDs");
    }
    const layout = this.structureChanged ? this.fntTable.serialize(this.fatTable, this.overlay.files) : undefined;
    const overlayFiles = new Map(this.overlay.files.map((file) => [file.id, file]));
    const h = new Header(this.header.toBuffer());
    h.nitrocode = this.header.nitrocode;
    h.decrypted = this.header.decrypted;
    h.trimmedRom = this.header.trimmedRom;
    h.dlp_signature = this.header.dlp_signature;
    const writer = new BinaryWriter(65536, this.maxOutputSize);
    const system = (name: string): NitroFile => {
      const file = this.root.files.find((file) => file.name === name);
      if (!file) throw new Error(`Missing ROM system file: ${name}`);
      return file;
    };
    const replacedHeader = system("header.bin").replacement;
    if (replacedHeader) {
      const replacement = new Header(replacedHeader);
      h.gameTitle = replacement.gameTitle;
      h.gameCode = replacement.gameCode;
    }
    const placements = new Map<number, { start: number; end: number }>();
    const write = (file: NitroFile, padding = true): void => {
      const id = layout ? (file.id >= 0 ? layout.sourceIds.get(file.id) : layout.ids.get(file)) : file.id;
      if (layout && id !== undefined && placements.has(id)) return;
      if (layout && file.id >= 0) file = overlayFiles.get(file.id) ?? file;
      const start = writer.position;
      writer.write(this.fileBytes(file));
      if (id !== undefined && id !== 0xffff) placements.set(id, { start, end: writer.position });
      if (padding) writer.pad(0x200);
    };
    const overlayIds = new Set<number>();
    const writeOverlays = (arm9: boolean): void => {
      const originalTable = arm9 ? this.overlay9Table : this.overlay7Table;
      const name = arm9 ? "overarm9.bin" : "overarm7.bin";
      const entry = this.root.files.find((file) => file.name === name);
      if (!entry) return;
      const raw = entry.replacement ?? originalTable.toBuffer();
      const table = new OverlayTable(raw, 0, raw.length, arm9);
      const files = this.overlay.files
        .filter((file) => file.name.startsWith(arm9 ? "overlay_" : "overlay7_"))
        .sort((a, b) => a.id - b.id);
      for (const file of files) {
        const item = table.entries.find((item) => item.fileId === file.id);
        if (!item) throw new Error(`Replacement overlay table is missing file id ${file.id}`);
        const size = this.fileBytes(layout ? overlayFiles.get(file.id)! : file).length;
        for (const matching of layout ? table.entries.filter((item) => item.fileId === file.id) : [item]) {
          if ((matching.reserved >>> 24) & 1 || (!arm9 && matching.reserved > 0))
            matching.reserved = ((matching.reserved & 0xff000000) | (size & 0xffffff)) >>> 0;
        }
        overlayIds.add(file.id);
      }
      if (table.entries.length !== files.length) throw new Error("Changing overlay file count is unsupported");
      if (layout) for (const item of table.entries) item.fileId = layout.sourceIds.get(item.fileId)!;
      const encoded = table.toBuffer();
      if (arm9) {
        h.ARM9overlayOffset = writer.position;
        h.ARM9overlaySize = encoded.length;
      } else {
        h.ARM7overlayOffset = writer.position;
        h.ARM7overlaySize = encoded.length;
      }
      writer.write(encoded);
      writer.pad(0x200);
      for (const file of files) write(file);
    };
    writer.position = h.headerSize;
    h.ARM9romOffset = writer.position;
    const arm9 = system("arm9.bin");
    const arm9Bytes = this.fileBytes(arm9);
    if (arm9.replacement) {
      h.nitrocode = arm9Bytes.length >= 12 && arm9Bytes.readUInt32LE(arm9Bytes.length - 12) === 0xdec00621;
    }
    h.ARM9size = arm9Bytes.length - (h.nitrocode ? 12 : 0);
    write(arm9);
    h.ARM9overlayOffset = 0;
    writeOverlays(true);
    h.ARM7romOffset = writer.position;
    h.ARM7size = this.fileBytes(system("arm7.bin")).length;
    write(system("arm7.bin"));
    h.ARM7overlayOffset = 0;
    writeOverlays(false);
    h.FNToffset = writer.position;
    const fnt = layout?.fnt ?? this.fileBytes(system("fnt.bin"));
    h.FNTsize = fnt.length;
    writer.write(fnt);
    writer.pad(0x200);
    h.FAToffset = writer.position;
    h.FATsize = (layout?.files.length ?? this.fatTable.entries.length) * 8;
    writer.write(Buffer.alloc(h.FATsize));
    writer.pad(0x200);
    h.bannerOffset = writer.position;
    const bannerFile = system("banner.bin");
    const banner = bannerFile.replacement
      ? new Banner(bannerFile.replacement, 0, bannerFile.replacement.length)
      : this.banner;
    const bannerBytes = banner.toBuffer();
    // NTR has no banner_size field; DSi stores its actual banner length.
    if (h.unitCode & 2 && h.headerSize > 0x200) h.banner_size = bannerBytes.length;
    writer.write(bannerBytes);
    writer.pad(0x200);
    if (layout) {
      for (const [index, file] of layout.files.entries()) write(file, index < layout.files.length - 1);
    } else
      for (const [index, id] of this.fatTable.sortedIDs.entries()) {
        if (overlayIds.has(id)) continue;
        const file = FileNameTable.findFile(id, this.root);
        if (file) write(file, index < this.fatTable.sortedIDs.length - 1);
        else {
          // Games can address FAT entries directly without a NitroFS filename.
          // Keep their payload and allocation instead of silently zeroing the entry.
          const entry = this.fatTable.entries[id];
          if (entry.size > 0) {
            write({ ...entry, name: `FAT entry ${id}` }, index < this.fatTable.sortedIDs.length - 1);
          }
        }
      }
    const logicalEnd = writer.position;
    const fat = Buffer.alloc(h.FATsize);
    for (const [id, location] of placements) {
      fat.writeUInt32LE(location.start, id * 8);
      fat.writeUInt32LE(location.end, id * 8 + 4);
    }
    writer.position = h.FAToffset;
    writer.write(fat);
    writer.position = logicalEnd;
    // An ARM9 replacement can add or remove the decrypted secure-area marker.
    // Both TWL hashing and the header CRC must use the bytes being serialized.
    h.decrypted = writer.length >= 0x4008 && writer.buffer.readBigUInt64LE(0x4000) === 0xe7ffdeffe7ffdeffn;
    if (this.twl) this.twl.writeTo(writer, h);
    h.ROMsize = writer.position;
    h.size = 2 ** Math.ceil(Math.log2(Math.max(h.ROMsize + h.dlp_signature.length, 0x20000)));
    const secure = writer.toBuffer().subarray(0x4000, 0x8000);
    h.secureCRC16 = crc16(h.decrypted ? encryptSecureArea(h.gameCode, secure) : secure);
    writer.position = 0;
    writer.write(h.toBuffer());
    writer.position = h.ROMsize;
    writer.write(h.dlp_signature);
    writer.fillTo(h.size);
    return writer.toBuffer();
  }
  async saveAs(path: string): Promise<void> {
    await writeFile(path, this.toBuffer());
  }
}
