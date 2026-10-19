// Native TypeScript port of NitroHelper/NDSFile.cs, GPL-3.0.
import { readFile, writeFile } from "#nitro-runtime";

import { Banner } from "./banner";
import { BinaryWriter, DEFAULT_MAX_SIZE, bytes, range } from "./binary";
import { crc16 } from "./crc";
import { decryptSecureArea, encryptSecureArea } from "./crypto";
import { FileAllocationTable, FileNameTable, OverlayTable, encodeName } from "./filesystem";
import type { NitroFile, NitroFolder } from "./filesystem";
import { Header } from "./header";
import { TWL } from "./twl";
import { noDsiVerification } from "./twl-complete";
import type { DsiSection, DsiVerification } from "./twl-complete";

export interface RomOptions {
  /** Maximum generated ROM size in bytes. Defaults to 1 GiB. */
  maxOutputSize?: number;
  /** Complete DSi cartridge handling is opt-in for direct API calls. */
  dsiMode?: "legacy" | "complete";
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
    if (!Number.isSafeInteger(this.maxOutputSize) || this.maxOutputSize < 1 || this.maxOutputSize > 0xffffffff)
      throw new RangeError("Invalid output size limit");
    this.header = new Header(this.original);
    const h = this.header;
    if (options.dsiMode === "complete" && h.unitCode === 3)
      throw new Error("DSi-exclusive cartridges and DSiWare are unsupported");
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
    if (options.dsiMode === "complete" && h.unitCode & 2) {
      const regions: { start: number; size: number; name: string; payload?: boolean }[] = [
        ...this.root.files.map((file) => ({ start: file.offset, size: file.size, name: file.name })),
        ...this.fatTable.entries.map((file) => ({
          start: file.offset,
          size: file.size,
          name: `FAT ${file.id}`,
          payload: true,
        })),
        { start: h.dsi9_rom_offset, size: h.dsi9_size, name: "ARM9i" },
        { start: h.dsi7_rom_offset, size: h.dsi7_size, name: "ARM7i" },
        { start: h.sector_hashtable_start, size: h.sector_hashtable_size, name: "DSi sector table" },
        { start: h.block_hashtable_start, size: h.block_hashtable_size, name: "DSi block table" },
      ]
        .filter((region) => region.size)
        .sort((a, b) => a.start - b.start);
      let systemEnd: (typeof regions)[number] | undefined;
      let payloadEnd: (typeof regions)[number] | undefined;
      for (const region of regions) {
        range(this.original, region.start, region.size, region.name);
        for (const previous of [systemEnd, region.payload ? undefined : payloadEnd])
          if (previous && previous.start + previous.size > region.start)
            throw new Error(`DSi ROM regions overlap: ${previous.name} and ${region.name}`);
        if (region.payload) {
          if (!payloadEnd || region.start + region.size > payloadEnd.start + payloadEnd.size) payloadEnd = region;
        } else systemEnd = region;
      }
      this.twl = new TWL(
        h,
        this.overlay9Table.entries
          .filter((entry) => entry.reserved & 0x2000000)
          .map((entry) => {
            const file = this.fatTable.entries[entry.fileId];
            return { offset: file.offset, size: file.size };
          }),
        this.original,
        { dsiMode: "complete", maxOutputSize: this.maxOutputSize },
      );
      for (const [name, offset, size] of [
        ["arm9i.bin", h.dsi9_rom_offset, h.dsi9_size],
        ["arm7i.bin", h.dsi7_rom_offset, h.dsi7_size],
      ] as const) {
        const file: NitroFile = { name, id: 0xffff, offset, size };
        this.root.files.push(file);
        this.paths.set(name, { path: name, file });
      }
    } else if (h.unitCode & 2 && h.twlInternalFlags & 1 && h.tid_high && h.tid_high !== 0xffffffff) {
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
      size:
        this.twl?.complete && (path === "arm9i.bin" || path === "arm7i.bin")
          ? this.twl.complete.getProgram(path === "arm9i.bin" ? "arm9i" : "arm7i").length
          : (file.replacement?.length ?? file.size),
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
    if (this.twl?.complete && content.byteLength > this.maxOutputSize)
      throw new RangeError("Replacement exceeds output size limit");
    if (this.twl?.complete && (key(path) === "arm9i.bin" || key(path) === "arm7i.bin")) {
      this.twl.complete.setProgram(key(path) === "arm9i.bin" ? "arm9i" : "arm7i", bytes(content));
      return;
    }
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
    if (this.twl?.complete && (file.name === "arm9i.bin" || file.name === "arm7i.bin"))
      return this.twl.complete.getProgram(file.name === "arm9i.bin" ? "arm9i" : "arm7i");
    return file.replacement ?? range(this.original, file.offset, file.size, file.name);
  }

  verifyDsi(): DsiVerification {
    if (this.twl?.complete) return this.twl.complete.verify();
    if (this.header.unitCode & 2)
      return new NDSFile(this.original, { dsiMode: "complete", maxOutputSize: this.maxOutputSize }).verifyDsi();
    return noDsiVerification();
  }

  /** Rebuild offsets, allocation table, CRCs and ROM padding. Safe to call repeatedly. */
  toBuffer(): Buffer {
    if (
      this.twl?.complete &&
      !this.structureChanged &&
      this.twl.complete.unchanged() &&
      this.header.raw.equals(this.original.subarray(0, this.header.raw.length)) &&
      this.banner
        .toBuffer()
        .equals(new Banner(this.original, this.header.bannerOffset, this.header.banner_size).toBuffer()) &&
      [...this.paths.values()].every(
        ({ file }) =>
          !file.replacement || file.replacement.equals(range(this.original, file.offset, file.size, file.name)),
      )
    ) {
      if (this.original.length > this.maxOutputSize) throw new RangeError("Output exceeds size limit");
      return Buffer.from(this.original);
    }
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
    if (this.twl?.complete) return this.serializeDsi(layout);
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

  private serializeDsi(layout: ReturnType<FileNameTable["serialize"]> | undefined): Buffer {
    const twl = this.twl!.complete!;
    const h = new Header(this.header.raw);
    h.nitrocode = this.header.nitrocode;
    const system = (name: string): NitroFile => this.paths.get(name)!.file;
    const replacement = system("header.bin").replacement;
    if (replacement) {
      const source = new Header(replacement);
      if (
        source.unitCode !== 2 ||
        source.tid_high !== h.tid_high ||
        source.tid_low !== h.tid_low ||
        (h.dsi9_size && !source.dsi9_size) ||
        (h.dsi7_size && !source.dsi7_size)
      )
        throw new Error("Replacement header changes or clears the DSi cartridge identity or programs");
      // Preserve semantic and unknown header bytes; physical fields are assigned below.
      source.raw.copy(h.raw);
      for (const [start, end] of [
        [0x20, 0x40],
        [0x40, 0x60],
        [0x68, 0x6e],
        [0x80, 0x88],
        [0x90, 0x94],
        [0x1c0, 0x1c4],
        [0x1cc, 0x1d4],
        [0x1dc, 0x214],
        [0x220, 0x230],
        [0x300, 0x378],
        [0x3a0, 0x3b4],
        [0xf80, 0x1000],
      ])
        this.header.raw.copy(h.raw, start, start, end);
      h.ARM9entryAddress = source.ARM9entryAddress;
      h.ARM9ramAddress = source.ARM9ramAddress;
      h.ARM7entryAddress = source.ARM7entryAddress;
      h.ARM7ramAddress = source.ARM7ramAddress;
      h.dsi7_ram_address = source.dsi7_ram_address;
      h.headerSize = this.header.headerSize;
    }
    const sections: DsiSection[] = [];
    const add = (label: string, file: NitroFile, data: Buffer, place: (start: number) => void): void => {
      sections.push({ label, start: file.offset, originalSize: file.size, data, place });
    };
    const arm9File = system("arm9.bin");
    let arm9 = this.fileBytes(arm9File);
    if (arm9File.replacement) h.nitrocode = arm9.length >= 12 && arm9.readUInt32LE(arm9.length - 12) === 0xdec00621;
    if (h.gameCode !== twl.header.gameCode && arm9.readBigUInt64LE(0) !== 0xe7ffdeffe7ffdeffn)
      arm9 = encryptSecureArea(h.gameCode, decryptSecureArea(twl.header.gameCode, arm9));
    const signedOverlays = this.overlay9Table.entries.filter((entry) => entry.reserved & 0x2000000);
    arm9 = twl.updateOverlays9Sha1Hmac(
      arm9,
      h,
      signedOverlays.map((entry) => this.fileBytes(this.overlay.files.find((file) => file.id === entry.fileId)!)),
    );
    h.ARM9size = arm9.length - (h.nitrocode ? 12 : 0);
    h.decrypted = arm9.length >= 8 && arm9.readBigUInt64LE(0) === 0xe7ffdeffe7ffdeffn;
    const plainArm9 = h.decrypted ? Buffer.from(arm9) : decryptSecureArea(h.gameCode, arm9);
    plainArm9.writeUInt16LE(crc16(range(plainArm9, 0x10, 0x7f0, "ARM9 secure-area CRC")), 0xe);
    arm9 = h.decrypted ? plainArm9 : encryptSecureArea(h.gameCode, plainArm9);
    add("ARM9", arm9File, arm9, (start) => {
      h.ARM9romOffset = start;
    });
    const written = new Set<number>();
    const fileList =
      layout?.files ??
      this.fatTable.entries.map(
        (entry) => FileNameTable.findFile(entry.id, this.root) ?? { ...entry, name: `FAT entry ${entry.id}` },
      );
    const fat = Buffer.alloc(fileList.length * 8);
    const addPayload = (file: NitroFile): void => {
      const id = layout ? (file.id >= 0 ? layout.sourceIds.get(file.id)! : layout.ids.get(file)!) : file.id;
      if (written.has(id)) return;
      written.add(id);
      const overlay = this.overlay.files.find((overlay) => overlay.id === file.id);
      if (overlay) file = overlay;
      const data = this.fileBytes(file);
      add(file.name, file, data, (start) => {
        fat.writeUInt32LE(start, id * 8);
        fat.writeUInt32LE(start + data.length, id * 8 + 4);
      });
    };
    const overlays = (arm9: boolean): void => {
      const name = arm9 ? "overarm9.bin" : "overarm7.bin";
      if (!this.hasFile(name)) return;
      const source = arm9 ? this.overlay9Table : this.overlay7Table;
      const file = system(name);
      const data = file.replacement ?? source.toBuffer();
      const table = new OverlayTable(data, 0, data.length, arm9);
      if (table.entries.length !== source.entries.length) throw new Error("Changing overlay file count is unsupported");
      for (const entry of table.entries) {
        const original = source.entries.find((item) => item.overlayId === entry.overlayId);
        if (original?.fileId !== entry.fileId) throw new Error("Replacement overlay table changes its file references");
        const payload = this.overlay.files.find((item) => item.id === entry.fileId)!;
        const size = this.fileBytes(payload).length;
        if ((entry.reserved >>> 24) & 1 || (!arm9 && entry.reserved > 0))
          entry.reserved = ((entry.reserved & 0xff000000) | size) >>> 0;
        if (layout) entry.fileId = layout.sourceIds.get(entry.fileId)!;
      }
      add(name, file, table.toBuffer(), (start) => {
        if (arm9) {
          h.ARM9overlayOffset = start;
          h.ARM9overlaySize = data.length;
        } else {
          h.ARM7overlayOffset = start;
          h.ARM7overlaySize = data.length;
        }
      });
      for (const entry of source.entries) addPayload(this.overlay.files.find((file) => file.id === entry.fileId)!);
    };
    overlays(true);
    const arm7 = system("arm7.bin");
    h.ARM7size = this.fileBytes(arm7).length;
    add("ARM7", arm7, this.fileBytes(arm7), (start) => {
      h.ARM7romOffset = start;
    });
    overlays(false);
    const fnt = layout?.fnt ?? this.fileBytes(system("fnt.bin"));
    h.FNTsize = fnt.length;
    add("FNT", system("fnt.bin"), fnt, (start) => {
      h.FNToffset = start;
    });
    h.FATsize = fat.length;
    add("FAT", system("fat.bin"), fat, (start) => {
      h.FAToffset = start;
    });
    const bannerFile = system("banner.bin");
    const banner = bannerFile.replacement
      ? new Banner(bannerFile.replacement, 0, bannerFile.replacement.length)
      : this.banner;
    const bannerBytes = banner.toBuffer();
    h.banner_size = bannerBytes.length;
    add("Banner", bannerFile, bannerBytes, (start) => {
      h.bannerOffset = start;
    });
    for (const file of fileList) addPayload(file);
    return twl.serialize(h, sections, !!layout);
  }
}
