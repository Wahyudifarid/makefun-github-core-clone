// Git object model, packfiles and pkt-lines, implemented from the wire format
// alone. No git binary, no dependency beyond node:crypto and node:zlib.
import { createHash } from 'node:crypto';
import { deflateSync, Inflate } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of `<type> <size>\0<data>`. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function makeObject(type: ObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** One pkt-line framing a payload (the 4-byte hex length covers itself). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Decode every complete pkt-line in `buf` starting at `start`; also answers the offset just past them. */
export function decodePktLines(buf: Buffer, start = 0): { packets: Pkt[]; nextOffset: number } {
  const packets: Pkt[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const head = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, nextOffset: offset };
}

/** Encode a list of lines (strings become pkt-lines, 'flush'/'delim'/'end' their control packets). */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim' | 'end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else if (line === 'end') parts.push(pktEnd());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// trees and commits
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.toString('ascii', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries compare by name, directories as if the name ended with '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object from entries (sorted git-style). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object. The timestamp is a fixed constant: forge commits are deterministic. */
export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author} ${info.timestamp} +0000`);
  lines.push(`committer ${info.committer} ${info.timestamp} +0000`);
  lines.push('');
  lines.push(info.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(info: {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
  timestamp: number;
}): Buffer {
  const lines = [
    `object ${info.object}`,
    `type ${info.type}`,
    `tag ${info.tag}`,
    `tagger ${info.tagger} ${info.timestamp} +0000`,
    '',
    info.message,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Inflate one zlib stream starting at `offset`; answers the data and how many bytes it consumed. */
function inflateOne(buf: Buffer, offset: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inf = new Inflate();
    const chunks: Buffer[] = [];
    inf.on('data', (chunk: Buffer) => chunks.push(chunk));
    inf.on('error', reject);
    inf.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: inf.bytesWritten }));
    inf.write(buf.subarray(offset));
    inf.end();
  });
}

/** Read a git delta's variable-length integer. */
function readDeltaVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    const byte = buf[at];
    at += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: at };
}

/** Apply a git delta to its base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readDeltaVarint(delta, 0);
  const dst = readDeltaVarint(delta, src.next);
  if (src.value !== base.length) throw new Error('delta source size does not match the base object');
  const out: Buffer[] = [];
  let at = dst.next;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          offset |= delta[at] << (bit * 8);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          size |= delta[at] << (bit * 8);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
    } else {
      throw new Error('delta stream holds a zero opcode');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dst.value) throw new Error('delta result size does not match its header');
  return result;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile (version 2 or 3): plain objects plus OFS_DELTA and REF_DELTA entries.
 * `resolveBase` answers objects the pack itself does not hold (a thin pack's haves).
 */
export async function readPack(
  buf: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Promise<PackReadResult> {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  // The trailer is the SHA-1 of everything before it.
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const expect = sha1Hex(buf.subarray(0, buf.length - 20));
  if (trailer !== expect) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    // Varint header: low 4 bits of the first byte are the size's low bits, bits 4-6 the type.
    let byte = buf[offset];
    offset += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let object: GitObject;
    if (typeId === 6) {
      // OFS_DELTA: a negative offset varint names the base, earlier in this pack.
      byte = buf[offset];
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const base = byOffset.get(entryOffset - baseOffset);
      if (base === undefined) throw new Error('ofs-delta names a base outside this pack');
      const inflated = await inflateOne(buf, offset);
      if (inflated.data.length !== size) throw new Error('ofs-delta size mismatch');
      offset += inflated.consumed;
      object = { type: base.type, data: applyDelta(base.data, inflated.data) };
      deltaCount += 1;
    } else if (typeId === 7) {
      // REF_DELTA: 20 bytes name the base object.
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) throw new Error(`ref-delta names an unknown base ${baseOid}`);
      const inflated = await inflateOne(buf, offset);
      if (inflated.data.length !== size) throw new Error('ref-delta size mismatch');
      offset += inflated.consumed;
      object = { type: base.type, data: applyDelta(base.data, inflated.data) };
      deltaCount += 1;
    } else {
      const type = PACK_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const inflated = await inflateOne(buf, offset);
      if (inflated.data.length !== size) throw new Error(`pack object size mismatch (type ${type})`);
      offset += inflated.consumed;
      object = { type, data: inflated.data };
    }
    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(entryOffset, object);
  }
  return { objects, deltaCount };
}

/** Write a packfile of plain (undeltified) objects, version 2, with a SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeId = PACK_TYPE_IDS[object.type];
    const size = object.data.length;
    // Varint header: first byte holds the type and the size's low 4 bits.
    const head: number[] = [];
    let remaining = size >> 4;
    let first = (typeId << 4) | (size & 0x0f);
    if (remaining > 0) first |= 0x80;
    head.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      head.push(byte);
    }
    parts.push(Buffer.from(head));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/** Verify a packfile's trailer checksum without parsing it. */
export function verifyPackChecksum(buf: Buffer): boolean {
  if (buf.length < 32) return false;
  return buf.subarray(buf.length - 20).toString('hex') === sha1Hex(buf.subarray(0, buf.length - 20));
}
