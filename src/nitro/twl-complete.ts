import { hmacSha1, readFileSync, verifyRsaSha1 } from "#nitro-runtime";

import { BinaryWriter, align, range } from "./binary";
import { compressArm9, decompressArm9 } from "./blz";
import type { Arm9Header } from "./blz";
import { crc16 } from "./crc";
import { aes128CtrCrypt, encryptSecureArea, modcryptKey } from "./crypto";
import { Header } from "./header";
import { HMAC_SHA1_KEY } from "./twl";

export interface DsiCheck {
  status: "valid" | "invalid" | "not-applicable";
  reason?: string;
}
export interface DsiVerification {
  arm9: DsiCheck;
  arm7: DsiCheck;
  arm9i: DsiCheck;
  arm7i: DsiCheck;
  arm9NoSecure: DsiCheck;
  banner: DsiCheck;
  sectors: DsiCheck;
  blocks: DsiCheck;
  master: DsiCheck;
  signature: DsiCheck;
}

type ProgramName = "arm9" | "arm7" | "arm9i" | "arm7i";
interface Program {
  name: ProgramName;
  start: number;
  length: number;
  data: Buffer;
  original: Buffer;
  replaced: boolean;
}
interface CryptRegion {
  id: 1 | 2;
  program: ProgramName;
  offset: number;
  length: number;
  kind: "whole" | "secure" | "fixed";
}
export interface DsiSection {
  label: string;
  start: number;
  originalSize: number;
  data: Buffer;
  place: (start: number) => void;
}

const hash = (data: Buffer): Buffer => hmacSha1(HMAC_SHA1_KEY, data);
const check = (valid: boolean): DsiCheck => ({ status: valid ? "valid" : "invalid" });
const absent = (reason: string): DsiCheck => ({ status: "not-applicable", reason });
const fields = {
  arm9: ["ARM9romOffset", "ARM9size", "hmac_arm9"],
  arm7: ["ARM7romOffset", "ARM7size", "hmac_arm7"],
  arm9i: ["dsi9_rom_offset", "dsi9_size", "hmac_arm9i"],
  arm7i: ["dsi7_rom_offset", "dsi7_size", "hmac_arm7i"],
} as const;
const digestFields = [
  "digest_ntr_start",
  "digest_ntr_size",
  "digest_twl_start",
  "digest_twl_size",
  "sector_hashtable_start",
  "sector_hashtable_size",
  "block_hashtable_start",
  "block_hashtable_size",
  "digest_sector_size",
  "digest_block_sectorcount",
] as const;

export const noDsiVerification = (): DsiVerification =>
  Object.fromEntries(
    ["arm9", "arm7", "arm9i", "arm7i", "arm9NoSecure", "banner", "sectors", "blocks", "master", "signature"].map(
      (name) => [name, absent("Not a DSi-enhanced cartridge")],
    ),
  ) as unknown as DsiVerification;

/** Complete cartridge processing; legacy TWL serialization stays independent. */
export class CompleteTWL {
  readonly header: Header;
  readonly programs: Map<ProgramName, Program>;
  readonly regions: CryptRegion[];
  readonly hasDigests: boolean;
  readonly Hashtable1Data: Buffer;
  readonly Hashtable2Data: Buffer;
  readonly Header2Data: Buffer[];
  readonly Overlays9Sha1Hmac: Buffer[];
  readonly twlEncrypted: boolean;
  readonly firstDSiHashOffset: number;
  readonly dsiHashSize: number;
  private readonly original: Buffer;
  private readonly limit: number;

  constructor(header: Header, overlays: readonly Buffer[], original: Buffer, limit: number) {
    if (header.unitCode !== 2) throw new Error("Complete DSi processing requires a DSi-enhanced cartridge");
    if (header.tid_high && header.tid_high !== 0x30000)
      throw new Error("DSiWare and non-cartridge titles are unsupported");
    this.header = new Header(header.raw);
    this.header.decrypted = header.decrypted;
    this.header.nitrocode = header.nitrocode;
    this.original = original;
    this.limit = limit;
    this.hasDigests = digestFields.some((name) => header[name] !== 0);
    this.validateDigests(header, original);
    if (header.sector_hashtable_size > limit || header.block_hashtable_size > limit)
      throw new RangeError("DSi digest table exceeds output size limit");
    for (const name of ["dsi9_ram_address", "dsi7_ram_address"] as const)
      if (!header[name] || header[name] === 0xffffffff) throw new Error(`Missing DSi program load address: ${name}`);
    this.Hashtable1Data = Buffer.from(
      range(original, header.sector_hashtable_start, header.sector_hashtable_size, "DSi sector table"),
    );
    this.Hashtable2Data = Buffer.from(
      range(original, header.block_hashtable_start, header.block_hashtable_size, "DSi block table"),
    );
    this.firstDSiHashOffset = this.hasDigests ? (header.digest_ntr_size / header.digest_sector_size) * 20 : 0;
    this.dsiHashSize = this.hasDigests ? (header.digest_twl_size / header.digest_sector_size) * 20 : 0;
    this.programs = new Map(
      Object.entries(fields).map(([name, [offset, size]]) => {
        const start = header[offset];
        const length = header[size];
        if (length && !start) throw new Error(`Missing ${name} ROM offset`);
        if (align(length, 16) > limit) throw new RangeError(`${name} exceeds output size limit`);
        const data = Buffer.from(range(original, start, length ? align(length, 16) : 0, name));
        return [
          name as ProgramName,
          { name: name as ProgramName, start, length, data, original: data, replaced: false },
        ];
      }),
    );
    const ordered = [...this.programs.values()].filter((program) => program.length).sort((a, b) => a.start - b.start);
    for (let index = 1; index < ordered.length; index++)
      if (ordered[index - 1].start + ordered[index - 1].data.length > ordered[index].start)
        throw new Error("DSi program regions overlap");
    this.regions = [];
    for (const id of [1, 2] as const) {
      const start = header[`modcrypt${id}_start`];
      const length = header[`modcrypt${id}_size`];
      if (!start && !length) continue;
      if (!start || !length || length % 16) throw new Error(`Invalid Modcrypt region ${id}`);
      const candidates = ordered.filter(
        (program) => start >= program.start && start + length <= program.start + program.data.length,
      );
      if (candidates.length !== 1)
        throw new Error(`Modcrypt region ${id} conflicts with program ranges: ${start}..${start + length}`);
      const program = candidates[0];
      if (program.name === "arm9" || program.name === "arm7")
        throw new Error(`Modcrypt region ${id} targets ${program.name}; dual-mode cartridge startup is unsupported`);
      const offset = start - program.start;
      this.regions.push({
        id,
        program: program.name,
        offset,
        length,
        kind:
          offset === 0 && length === program.data.length
            ? "whole"
            : offset === 0 && program.name === "arm9i" && length === Math.min(0x4000, program.data.length)
              ? "secure"
              : "fixed",
      });
    }
    this.twlEncrypted = !!(header.twlInternalFlags & 2);
    this.decryptPrograms();
    for (const program of this.programs.values()) program.original = Buffer.from(program.data);
    const boundary = header.twl_region_start * 0x80000;
    const first = Math.min(...ordered.filter((program) => program.name.endsWith("i")).map((program) => program.start));
    const prefixEnd = boundary + 0x3000;
    this.Header2Data =
      boundary &&
      prefixEnd <= original.length &&
      ((Number.isFinite(first) && first >= prefixEnd) ||
        (header.digest_twl_size && header.digest_twl_start >= prefixEnd) ||
        header.total_rom_size >= prefixEnd)
        ? Array.from({ length: 3 }, (_, index) =>
            Buffer.from(range(original, boundary + index * 0x1000, 0x1000, "TWL unreadable region")),
          )
        : [];
    this.Overlays9Sha1Hmac = overlays.map(hash);
  }

  private validateDigests(h: Header, original: Buffer): void {
    if (!this.hasDigests) return;
    const s = h.digest_sector_size;
    const b = h.digest_block_sectorcount;
    if (!Number.isSafeInteger(s) || s <= 0 || s > 0x4000 || 0x4000 % s)
      throw new Error("Invalid DSi digest sector size");
    if (!b || b > 0x100000) throw new Error("Invalid DSi digest block sector count");
    if (
      !h.digest_ntr_start ||
      h.digest_ntr_size < 0x4000 ||
      h.digest_ntr_size % s ||
      h.digest_twl_size % s ||
      (h.digest_twl_size && !h.digest_twl_start)
    )
      throw new Error("Incomplete DSi digest regions");
    const count = (h.digest_ntr_size + h.digest_twl_size) / s;
    if (
      !h.sector_hashtable_start ||
      !h.block_hashtable_start ||
      !h.sector_hashtable_size ||
      h.sector_hashtable_size % (b * 20) ||
      h.sector_hashtable_size < count * 20 ||
      h.block_hashtable_size !== h.sector_hashtable_size / b
    )
      throw new Error("Incomplete or invalid DSi digest tables");
    for (const [start, size, label] of [
      [h.digest_ntr_start, h.digest_ntr_size, "NTR digest region"],
      [h.digest_twl_start, h.digest_twl_size, "TWL digest region"],
      [h.sector_hashtable_start, h.sector_hashtable_size, "DSi sector table"],
      [h.block_hashtable_start, h.block_hashtable_size, "DSi block table"],
    ] as const)
      range(original, start, size, label);
    if (
      h.digest_ntr_start + h.digest_ntr_size > h.sector_hashtable_start ||
      h.sector_hashtable_start + h.sector_hashtable_size > h.block_hashtable_start ||
      (h.digest_twl_size && h.block_hashtable_start + h.block_hashtable_size > h.digest_twl_start)
    )
      throw new Error("DSi digest regions overlap");
  }

  private decryptPrograms(): void {
    if (!this.regions.length) return;
    const h = this.header;
    const key = modcryptKey(h);
    const solutions: Buffer[][] = [];
    const programs = [...this.programs.values()];
    for (let mask = 0; mask < 2 ** this.regions.length; mask++) {
      const views = programs.map((program) => Buffer.from(program.data));
      for (let index = this.regions.length - 1; index >= 0; index--) {
        if (!(mask & (1 << index))) continue;
        const region = this.regions[index];
        const data = views[programs.findIndex((program) => program.name === region.program)];
        aes128CtrCrypt(
          key,
          (region.id === 1 ? h.hmac_arm9 : h.hmac_arm7).subarray(0, 16),
          data.subarray(region.offset, region.offset + region.length),
        ).copy(data, region.offset);
      }
      const accepted = [...new Set(this.regions.map((region) => region.program))].every((name) => {
        const index = programs.findIndex((program) => program.name === name);
        const program = programs[index];
        if (hash(views[index].subarray(0, program.length)).equals(h[fields[name][2]])) return true;
        if (!this.hasDigests) return false;
        const relevant = this.regions.filter((region) => region.program === name);
        return relevant.every((region) => {
          const address = program.start + region.offset;
          const base =
            address >= h.digest_twl_start && address < h.digest_twl_start + h.digest_twl_size
              ? h.digest_twl_start
              : h.digest_ntr_start;
          const length = base === h.digest_twl_start ? h.digest_twl_size : h.digest_ntr_size;
          if (address < base || address >= base + length) return false;
          const first = base + Math.floor((address - base) / h.digest_sector_size) * h.digest_sector_size;
          const last = Math.min(base + length, align(address + region.length, h.digest_sector_size));
          for (let sector = first; sector < last; sector += h.digest_sector_size) {
            const bytes = Buffer.from(range(this.original, sector, h.digest_sector_size, "Modcrypt evidence sector"));
            for (const [p, view] of programs.map((program, i) => [program, views[i]] as const)) {
              const start = Math.max(sector, p.start),
                end = Math.min(sector + bytes.length, p.start + view.length);
              if (end > start) view.copy(bytes, start - sector, start - p.start, end - p.start);
            }
            const digest =
              (((base === h.digest_twl_start ? h.digest_ntr_size : 0) + sector - base) / h.digest_sector_size) * 20;
            if (hash(bytes).equals(range(this.Hashtable1Data, digest, 20, "Modcrypt evidence hash"))) return true;
          }
          return false;
        });
      });
      if (accepted && !solutions.some((solution) => solution.every((data, index) => data.equals(views[index]))))
        solutions.push(views);
    }
    if (solutions.length !== 1)
      throw new Error(
        `Cannot determine Modcrypt state for regions ${this.regions.map((region) => region.id).join(", ")}`,
      );
    programs.forEach((program, index) => {
      program.data = solutions[0][index];
    });
  }

  get DSi9Data(): Buffer {
    return this.getProgram("arm9i");
  }
  set DSi9Data(data: Buffer) {
    this.setProgram("arm9i", data);
  }
  get DSi7Data(): Buffer {
    return this.getProgram("arm7i");
  }
  set DSi7Data(data: Buffer) {
    this.setProgram("arm7i", data);
  }
  getProgram(name: ProgramName): Buffer {
    const program = this.programs.get(name)!;
    return program.data.subarray(0, program.length);
  }
  setProgram(name: ProgramName, data: Buffer): void {
    if (align(data.length, 16) > this.limit) throw new RangeError(`${name} exceeds output size limit`);
    const program = this.programs.get(name)!;
    const stored = Buffer.alloc(align(data.length, 16), 255);
    if (program.length === data.length) program.data.copy(stored);
    data.copy(stored);
    program.data = stored;
    program.length = data.length;
    program.replaced = true;
  }
  importArm9iData(data: Buffer | string, offset = 0, size?: number): void {
    const input = typeof data === "string" ? readFileSync(data) : data;
    this.setProgram("arm9i", range(input, offset, size ?? input.length - offset, "ARM9i import"));
  }
  importArm7iData(data: Buffer | string, offset = 0, size?: number): void {
    const input = typeof data === "string" ? readFileSync(data) : data;
    this.setProgram("arm7i", range(input, offset, size ?? input.length - offset, "ARM7i import"));
  }
  unchanged(): boolean {
    return [...this.programs.values()].every(
      (program) =>
        !(program.replaced && !program.length) &&
        program.length === this.header[fields[program.name][1]] &&
        program.data.equals(program.original),
    );
  }

  updateOverlays9Sha1Hmac(arm9: Buffer, h: Arm9Header, overlays: readonly Buffer[]): Buffer {
    if (overlays.length !== this.Overlays9Sha1Hmac.length)
      throw new Error("Changing signed ARM9 overlay count is unsupported");
    const hashes = overlays.map(hash);
    if (hashes.every((value, index) => value.equals(this.Overlays9Sha1Hmac[index]))) return arm9;
    const unpacked = decompressArm9(arm9, h, this.limit);
    const oldSequence = Buffer.concat(this.Overlays9Sha1Hmac);
    const newSequence = Buffer.concat(hashes);
    const matches: { position: number; current: boolean }[] = [];
    for (const [sequence, current] of [
      [oldSequence, false],
      [newSequence, true],
    ] as const)
      for (
        let position = unpacked.data.indexOf(sequence, 0x4000);
        position >= 0;
        position = unpacked.data.indexOf(sequence, position + 1)
      )
        matches.push({ position, current });
    if (matches.length !== 1) throw new Error("ARM9 overlay HMAC table cannot be uniquely located");
    if (matches[0].current) return arm9;
    newSequence.copy(unpacked.data, matches[0].position);
    if (!unpacked.compressed) return unpacked.data;
    const init = h.reserved2.readUInt32LE(0) & 0x3fff;
    const end = init ? arm9.readUInt32LE(init + 0x14) - h.ARM9ramAddress : arm9.length;
    return compressArm9(unpacked.data, h, arm9.length - end);
  }

  private view(data: Buffer, h: Header, start: number, length: number, programs = this.programs): Buffer {
    const output = Buffer.from(range(data, start, length, "DSi digest input"));
    for (const program of programs.values()) {
      const [offset, size] = fields[program.name];
      const address = h[offset];
      const limit = program.name === "arm9" ? h[size] : align(h[size], 16);
      const from = Math.max(start, address),
        to = Math.min(start + length, address + limit);
      if (to <= from) continue;
      let source = program.data;
      if (program.name === "arm9" && h.decrypted) source = encryptSecureArea(h.gameCode, source, true);
      source.copy(output, from - start, from - address, to - address);
    }
    return output;
  }

  verify(data = this.original, h = this.header): DsiVerification {
    const programCheck = (name: ProgramName): DsiCheck => {
      const program = this.programs.get(name)!;
      if (!program.length) return absent("Program has zero logical length");
      const input = name === "arm9" && h.decrypted ? encryptSecureArea(h.gameCode, program.data, true) : program.data;
      return check(hash(input.subarray(0, program.length)).equals(h[fields[name][2]]));
    };
    const result: DsiVerification = {
      arm9: programCheck("arm9"),
      arm7: programCheck("arm7"),
      arm9i: programCheck("arm9i"),
      arm7i: programCheck("arm7i"),
      arm9NoSecure:
        h.ARM9size >= 0x4000
          ? check(hash(this.getProgram("arm9").subarray(0x4000)).equals(h.hmac_arm9_no_secure))
          : absent("ARM9 has no complete secure area"),
      banner: check(hash(range(data, h.bannerOffset, h.banner_size, "DSi banner")).equals(h.hmac_icon_title)),
      sectors: absent("Digest tables omitted"),
      blocks: absent("Digest tables omitted"),
      master: absent("Digest tables omitted"),
      signature: h.rsa_signature.every((value) => value === 0)
        ? absent("Signature omitted")
        : check(verifyRsaSha1(range(data, 0, 0xe00, "Signed DSi header"), h.rsa_signature)),
    };
    if (this.hasDigests) {
      let valid = true,
        index = 0;
      for (const [start, size] of [
        [h.digest_ntr_start, h.digest_ntr_size],
        [h.digest_twl_start, h.digest_twl_size],
      ])
        for (let position = start; position < start + size; position += h.digest_sector_size)
          valid =
            hash(this.view(data, h, position, h.digest_sector_size)).equals(
              range(data, h.sector_hashtable_start + index++ * 20, 20, "DSi sector digest"),
            ) && valid;
      result.sectors = check(valid);
      valid = true;
      for (let offset = 0; offset < h.sector_hashtable_size; offset += h.digest_block_sectorcount * 20)
        valid =
          hash(
            range(data, h.sector_hashtable_start + offset, h.digest_block_sectorcount * 20, "DSi sector block"),
          ).equals(
            range(data, h.block_hashtable_start + offset / h.digest_block_sectorcount, 20, "DSi block digest"),
          ) && valid;
      result.blocks = check(valid);
      result.master = check(
        hash(range(data, h.block_hashtable_start, h.block_hashtable_size, "DSi master input")).equals(
          h.hmac_digest_master,
        ),
      );
    }
    return result;
  }

  serialize(h: Header, sections: DsiSection[], forceLayout: boolean): Buffer {
    const originalHeader = this.header;
    const dsiPrograms = [this.programs.get("arm9i")!, this.programs.get("arm7i")!];
    const originalEnd = Math.max(
      originalHeader.ROMsize,
      originalHeader.total_rom_size,
      originalHeader.dsi9_rom_offset + align(originalHeader.dsi9_size, 16),
      originalHeader.dsi7_rom_offset + align(originalHeader.dsi7_size, 16),
      originalHeader.digest_twl_start + originalHeader.digest_twl_size,
    );
    const ntrLimit = this.hasDigests
      ? originalHeader.digest_ntr_start + originalHeader.digest_ntr_size
      : originalHeader.twl_region_start * 0x80000 ||
        Math.min(...dsiPrograms.filter((program) => program.length).map((program) => program.start));
    const ordered = sections
      .filter((section) => section.originalSize || section.data.length)
      .sort((a, b) => a.start - b.start);
    let preserve =
      !forceLayout &&
      ordered.every((section, index) => {
        const next = ordered[index + 1]?.start ?? ntrLimit;
        if (
          section.start < h.headerSize ||
          section.start + section.originalSize > next ||
          section.start + section.data.length > next
        )
          return false;
        const extra = this.original.subarray(section.start + section.originalSize, section.start + section.data.length);
        return extra.every((value) => value === 0) || extra.every((value) => value === 255);
      });
    const originalDsi = [...dsiPrograms]
      .filter((program) => originalHeader[fields[program.name][1]])
      .sort((a, b) => a.start - b.start);
    for (const [index, program] of originalDsi.entries()) {
      const next = originalDsi[index + 1]?.start ?? originalEnd;
      if (program.start + program.data.length > next) preserve = false;
      const extra = this.original.subarray(
        program.start + align(originalHeader[fields[program.name][1]], 16),
        program.start + program.data.length,
      );
      if (!(extra.every((value) => value === 0) || extra.every((value) => value === 255))) preserve = false;
    }
    if (dsiPrograms.some((program) => program.length && !originalHeader[fields[program.name][1]])) preserve = false;
    let ntrEnd: number;
    let end: number;
    let boundary = originalHeader.twl_region_start * 0x80000;
    if (preserve) {
      for (const section of sections) section.place(section.start);
      ntrEnd = originalHeader.ROMsize;
      end = originalEnd;
    } else {
      this.checkMovableTwl(boundary, originalDsi, originalEnd);
      let position = Math.max(h.headerSize, 0x4000);
      for (const section of sections) {
        section.start = position;
        section.place(position);
        position = align(position + section.data.length, 0x200);
      }
      const ntrDataEnd = position;
      if (this.hasDigests) {
        const s = h.digest_sector_size;
        h.digest_ntr_start = h.ARM9romOffset;
        h.digest_ntr_size = align(ntrDataEnd - h.digest_ntr_start, s);
        h.sector_hashtable_start = align(h.digest_ntr_start + h.digest_ntr_size, 0x200);
      }
      let twlLength = 0;
      for (const program of dsiPrograms) if (program.length) twlLength = align(twlLength, 0x400) + program.data.length;
      if (this.hasDigests) {
        h.digest_twl_size = twlLength ? align(twlLength, h.digest_sector_size) : 0;
        const count = (h.digest_ntr_size + h.digest_twl_size) / h.digest_sector_size;
        h.sector_hashtable_size = align(count * 20, h.digest_block_sectorcount * 20);
        h.block_hashtable_start = align(h.sector_hashtable_start + h.sector_hashtable_size, 0x200);
        h.block_hashtable_size = h.sector_hashtable_size / h.digest_block_sectorcount;
        ntrEnd = h.block_hashtable_start + h.block_hashtable_size;
      } else ntrEnd = ntrDataEnd;
      const originalBoundary = originalHeader.twl_region_start * 0x80000;
      const boundaryAlignment = originalBoundary ? Math.max(0x80000, originalBoundary & -originalBoundary) : 0x80000;
      boundary = align(ntrEnd, boundaryAlignment);
      position = boundary + 0x3000;
      let first = 0;
      for (const program of dsiPrograms) {
        const [offset] = fields[program.name];
        if (!program.length) {
          h[offset] = 0;
          continue;
        }
        position = align(position, 0x400);
        h[offset] = position;
        first ||= position;
        position += program.data.length;
      }
      if (this.hasDigests) h.digest_twl_start = first;
      end = this.hasDigests && first ? first + h.digest_twl_size : position;
    }
    h.size = Math.max(originalHeader.size, 2 ** Math.ceil(Math.log2(Math.max(end, 0x20000))));
    if (h.size > this.limit) throw new RangeError("Output exceeds size limit");
    const writer = new BinaryWriter(h.size, this.limit);
    writer.fillTo(h.size);
    if (preserve) this.original.copy(writer.buffer);
    else {
      range(this.original, 0, Math.max(h.headerSize, 0x4000), "DSi original header area").copy(writer.buffer);
      if (this.hasDigests) {
        const originalGap = this.original.subarray(
          originalHeader.sector_hashtable_start + originalHeader.sector_hashtable_size,
          originalHeader.block_hashtable_start,
        );
        if (originalGap.length && originalGap.every((value) => value === 0))
          writer.buffer.fill(0, h.sector_hashtable_start + h.sector_hashtable_size, h.block_hashtable_start);
      }
    }
    // FAT contents depend on the final placement of every file.
    for (const section of sections) {
      writer.position = section.start;
      writer.write(section.data);
      if (preserve && section.data.length < section.originalSize) {
        writer.fillTo(section.start + section.originalSize);
      }
    }
    for (const program of dsiPrograms) {
      const [offset, size, mac] = fields[program.name];
      h[size] = program.length;
      if (!program.length && program.replaced) {
        h[offset] = 0;
        h[mac] = Buffer.alloc(20);
        if (preserve && originalHeader[size]) {
          writer.position = originalHeader[offset];
          writer.fillTo(originalHeader[offset] + align(originalHeader[size], 16));
        }
      }
      if (program.length) {
        writer.position = h[offset];
        writer.write(program.data);
        const oldSize = originalHeader[size];
        if (preserve && align(oldSize, 16) > program.data.length) writer.fillTo(h[offset] + align(oldSize, 16));
      }
    }
    const outputPrograms = new Map([...this.programs].map(([name, program]) => [name, { ...program }]));
    for (const name of ["arm9", "arm7"] as const) {
      const program = outputPrograms.get(name)!;
      const [offset, size] = fields[name];
      program.data = Buffer.from(range(writer.buffer, h[offset], h[size], name));
      program.length = h[size];
    }
    for (const program of outputPrograms.values()) {
      if (!program.length) continue;
      const data =
        program.name === "arm9" && h.decrypted ? encryptSecureArea(h.gameCode, program.data, true) : program.data;
      h[fields[program.name][2]] = hash(data.subarray(0, program.length));
    }
    h.hmac_arm9_no_secure = hash(outputPrograms.get("arm9")!.data.subarray(0x4000));
    h.hmac_icon_title = hash(range(writer.buffer, h.bannerOffset, h.banner_size, "DSi output banner"));
    if (this.hasDigests) {
      range(writer.buffer, h.sector_hashtable_start, h.sector_hashtable_size, "DSi output sector table").fill(0);
      range(writer.buffer, h.block_hashtable_start, h.block_hashtable_size, "DSi output block table").fill(0);
      let index = 0;
      for (const [start, size] of [
        [h.digest_ntr_start, h.digest_ntr_size],
        [h.digest_twl_start, h.digest_twl_size],
      ])
        for (let position = start; position < start + size; position += h.digest_sector_size)
          hash(this.view(writer.buffer, h, position, h.digest_sector_size, outputPrograms)).copy(
            writer.buffer,
            h.sector_hashtable_start + index++ * 20,
          );
      for (let offset = 0; offset < h.sector_hashtable_size; offset += h.digest_block_sectorcount * 20)
        hash(
          range(
            writer.buffer,
            h.sector_hashtable_start + offset,
            h.digest_block_sectorcount * 20,
            "DSi output sector block",
          ),
        ).copy(writer.buffer, h.block_hashtable_start + offset / h.digest_block_sectorcount);
      h.hmac_digest_master = hash(
        range(writer.buffer, h.block_hashtable_start, h.block_hashtable_size, "DSi output master input"),
      );
    }
    const key = this.regions.length ? modcryptKey(h) : Buffer.alloc(0);
    for (const region of this.regions) {
      const program = this.programs.get(region.program)!;
      const size = !program.length
        ? 0
        : region.kind === "whole"
          ? program.data.length
          : region.kind === "secure"
            ? Math.min(0x4000, program.data.length)
            : region.length;
      if (size && region.offset + size > program.data.length)
        throw new Error(`Modcrypt region ${region.id} exceeds ${program.name} after replacement`);
      const start = size ? h[fields[program.name][0]] + region.offset : 0;
      h[`modcrypt${region.id}_start`] = start;
      h[`modcrypt${region.id}_size`] = size;
      if (size && h.twlInternalFlags & 2) {
        const input = range(writer.buffer, start, size, `Output Modcrypt region ${region.id}`);
        aes128CtrCrypt(key, (region.id === 1 ? h.hmac_arm9 : h.hmac_arm7).subarray(0, 16), input).copy(
          writer.buffer,
          start,
        );
      }
    }
    h.ROMsize = ntrEnd;
    h.total_rom_size = end;
    h.ntr_region_end = boundary / 0x80000;
    h.twl_region_start = boundary / 0x80000;
    h.size = Math.max(originalHeader.size, 2 ** Math.ceil(Math.log2(Math.max(end, 0x20000))));
    const secure = range(writer.buffer, h.ARM9romOffset, 0x4000, "DSi secure area");
    h.secureCRC16 = crc16(h.decrypted ? encryptSecureArea(h.gameCode, secure, true) : secure);
    h.rsa_signature = originalHeader.rsa_signature;
    writer.position = 0;
    writer.write(h.toBuffer());
    const originalMirror = range(this.original, 0x8000, 0x1000, "Original cartridge mirror");
    for (let start = 0x1000; start < 0x4000; start += 0x1000)
      if (range(this.original, start, 0x1000, "NTR unreadable region").equals(originalMirror))
        range(writer.buffer, 0x8000, 0x1000, "Updated cartridge mirror").copy(writer.buffer, start);
    if (this.Header2Data.length) {
      for (const [index, data] of this.Header2Data.entries()) {
        writer.position = boundary + index * 0x1000;
        writer.write(
          data.equals(originalMirror) ? range(writer.buffer, 0x8000, 0x1000, "Updated cartridge mirror") : data,
        );
      }
    }
    return writer.toBuffer();
  }

  private checkMovableTwl(boundary: number, programs: Program[], end: number): void {
    let position = boundary + this.Header2Data.length * 0x1000;
    for (const program of programs) {
      if (program.start < position) throw new Error("TWL input regions overlap");
      const gap = range(this.original, position, program.start - position, "TWL preserved bytes");
      const padding = gap;
      if (padding.length && !(padding.every((value) => value === 0) || padding.every((value) => value === 255)))
        throw new Error("TWL contains unrecognized bytes whose relocation is unsupported");
      position = program.start + align(this.header[fields[program.name][1]], 16);
    }
    const tail = range(this.original, position, end - position, "TWL preserved tail");
    if (tail.length && !(tail.every((value) => value === 0) || tail.every((value) => value === 255)))
      throw new Error("TWL contains unrecognized trailing data whose relocation is unsupported");
  }
}
