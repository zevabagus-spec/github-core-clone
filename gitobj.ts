// Git's object model and wire framing, implemented on node:crypto and
// node:zlib. No git binary, no dependencies.
//
// Objects: SHA-1 over "<type> <size>\0" + bytes. Trees sort git-style
// (directories compare as name + '/'). Commits and tags are parsed
// leniently: headers up to the first blank line, the rest is the message.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const hash = createHash('sha1');
  // The header is plain ASCII: feed it as a string, no Buffer allocation.
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: { mode: string; name: string }): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// commits and tags

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
}

export function parseCommit(data: Uint8Array): ParsedCommit {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, message };
}

export interface ParsedTag {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly message: string;
}

export function parseTag(data: Uint8Array): ParsedTag {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
  }
  if (!isOid(object)) throw new Error('tag has no valid object header');
  return { object, type, tag, message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8') };
}

/** Build a commit object's bytes with a fixed identity and timestamp. */
export function buildCommitBytes(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  authorLine: string;
  committerLine: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.authorLine}`, `committer ${fields.committerLine}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// pkt-line framing

export const PKT_LINE_MAX = 65520;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const out = Buffer.allocUnsafe(4 + data.length);
  out.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  data.copy(out, 4);
  return out;
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktItem = string | Buffer | 'flush' | 'delim';

export function encodePktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type DecodedPacket =
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' }
  | { kind: 'data'; payload: Buffer };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from `buffer` starting at `start` until `stopAtFlush`
 * consumes a flush packet (receive-pack commands) or the buffer ends.
 * Returns the packets and the offset just past what was consumed, so a
 * caller can treat the remainder as raw bytes (a packfile).
 */
export function decodePktLines(
  buffer: Buffer,
  start: number,
  stopAtFlush: boolean,
): { packets: DecodedPacket[]; nextOffset: number } {
  const packets: DecodedPacket[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, nextOffset: offset };
}

// ---------------------------------------------------------------------------
// packfiles

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readPackSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || written + copySize > targetSize) {
        throw new Error('delta copy is out of range');
      }
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length || written + literal > targetSize) {
        throw new Error('delta insert is out of range');
      }
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolved?: Buffer;
  resolvedType?: GitObjectType;
  oid?: string;
}

/**
 * Read and fully resolve a packfile (version 2 or 3, OFS_DELTA and
 * REF_DELTA included). `resolveBase` supplies objects a thin pack leaves
 * out. The trailer checksum is verified; any structural problem throws.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  const packBody = pack.subarray(0, trailerStart);
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(packBody, offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  // Fast path: a pack with no delta entries resolves inline, one hash per
  // object, without the delta machinery below. The benchmark's pushes and
  // the suite's packs are delta-free; delta packs take the general path.
  let hasDelta = false;
  for (const entry of raw) {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      hasDelta = true;
      break;
    }
  }
  if (!hasDelta) {
    for (const entry of raw) {
      const type = CODE_TYPE[entry.typeCode] as GitObjectType;
      const oid = hashObject(type, entry.data);
      if (!objects.has(oid)) objects.set(oid, { type, data: entry.data });
    }
    return objects;
  }
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/** The pack entry header's byte length for an object of `size`. */
function packHeaderLength(size: number): number {
  let length = 1;
  let remaining = Math.floor(size / 16);
  while (remaining > 0) {
    length += 1;
    remaining = Math.floor(remaining / 128);
  }
  return length;
}

/** Write a pack entry header into `target` at `offset`; returns bytes written. */
function writePackHeader(target: Buffer, offset: number, type: GitObjectType, size: number): number {
  const code = TYPE_CODE[type];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  let written = 0;
  while (remaining > 0) {
    target[offset + written] = first | 0x80;
    written += 1;
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  target[offset + written] = first;
  return written + 1;
}

/**
 * Build a version-2 packfile from plain objects (no deltas). The caller
 * supplies each object's deflated bytes, so a hot cache can skip
 * recompression. Entries are emitted in the given order. The whole pack
 * is assembled in one allocation: header, entries, then the SHA-1 trailer
 * over everything before it.
 */
export function buildPack(items: readonly { type: GitObjectType; size: number; deflated: Buffer }[]): Buffer {
  let bodyLength = 12;
  for (const item of items) bodyLength += packHeaderLength(item.size) + item.deflated.length;
  const pack = Buffer.allocUnsafe(bodyLength + 20);
  pack.write('PACK', 0, 4, 'ascii');
  pack.writeUInt32BE(2, 4);
  pack.writeUInt32BE(items.length, 8);
  let offset = 12;
  for (const item of items) {
    offset += writePackHeader(pack, offset, item.type, item.size);
    item.deflated.copy(pack, offset);
    offset += item.deflated.length;
  }
  createHash('sha1').update(pack.subarray(0, bodyLength)).digest().copy(pack, bodyLength);
  return pack;
}

export function deflateObject(data: Buffer): Buffer {
  // Level 1: a valid zlib stream is all a pack entry needs, and the
  // fastest level compresses the small objects of a fetch far quicker
  // than the default. The pack trailer is computed over the bytes as
  // emitted, so nothing downstream can tell the level.
  return deflateSync(data, { level: 1 });
}
