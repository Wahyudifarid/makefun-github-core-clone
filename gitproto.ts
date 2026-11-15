// Git smart HTTP: info/refs (v0 and v2), upload-pack (v2 and v0) and receive-pack (v0).
// The request bodies are read whole by the router; this module only frames bytes.
import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './git.ts';
import {
  VIEWER_LOGIN,
  getCommit,
  isAncestor,
  walkCommits,
  type Repo,
  type Store,
} from './store.ts';

const AGENT = 'forge/1.0';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Every ref the server advertises, HEAD first, then branches, then tags. */
function advertisedRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const headOid = repo.refs.get(headRefName(repo));
  out.push({
    oid: headOid ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: headRefName(repo),
    unborn: headOid === undefined ? true : undefined,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!name.startsWith('refs/heads/') && !name.startsWith('refs/tags/')) continue;
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        line.peeled = parseTag(object.data).object;
      }
    }
    out.push(line);
  }
  return out;
}

function isEmptyRepo(repo: Repo): boolean {
  return repo.refs.size === 0;
}

// -------------------------------------------------------------------------------------------
// info/refs
// -------------------------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k shallow multi_ack thin-pack ofs-delta symref=HEAD:${headRefName(repo)} agent=${AGENT}`
      : `report-status side-band-64k delete-refs agent=${AGENT}`;
  const parts: Buffer[] = [];
  parts.push(encodePktLines([`# service=${service}\n`, 'flush']));
  if (isEmptyRepo(repo)) {
    parts.push(encodePktLines([`${ZERO_OID} capabilities^{}\0${caps}\n`, 'flush']));
    return Buffer.concat(parts);
  }
  const refs = advertisedRefs(repo);
  const lines: string[] = [];
  refs.forEach((ref, index) => {
    if (index === 0) lines.push(`${ref.oid} ${ref.name}\0${caps}\n`);
    else lines.push(`${ref.oid} ${ref.name}\n`);
    if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
  });
  lines.push('flush');
  parts.push(encodePktLines(lines));
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  name: string,
  service: string,
  gitProtocol: string | undefined,
): { status: number; contentType: string; body: Buffer } {
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, name) : undefined;
  if (repo === undefined) return { status: 404, contentType: 'text/plain', body: Buffer.from('Not Found', 'utf8') };
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 404, contentType: 'text/plain', body: Buffer.from('Not Found', 'utf8') };
  }
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(repo, service),
  };
}

// -------------------------------------------------------------------------------------------
// fetch planning
// -------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch must send: the wants' closure at the requested depth, minus
 * everything the client's haves already hold. A have that is one of the client's
 * shallow boundaries is held alone; any other have is held with its whole closure.
 */
function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  shallowBoundaries: string[],
): FetchPlan {
  // Expand wanted tags to their target commits; the tag objects themselves travel too.
  const tagObjects: GitObject[] = [];
  const roots: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.push(object);
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') roots.push(target);
    } else if (object.type === 'commit') {
      roots.push(want);
    }
  }
  // Traverse from the roots, honouring the depth limit; boundary commits stop the walk.
  const distances = new Map<string, number>();
  const boundary = new Set<string>();
  const queue: Array<[string, number]> = roots.map((root) => [root, 0] as [string, number]);
  while (queue.length > 0) {
    const [oid, distance] = queue.shift() as [string, number];
    const known = distances.get(oid);
    if (known !== undefined && known <= distance) continue;
    distances.set(oid, distance);
    if (depth !== undefined && distance >= depth) {
      boundary.add(oid);
      continue;
    }
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) queue.push([parent, distance + 1]);
  }
  // What the client already holds: every object reachable from a have (the commit,
  // its whole tree closure, and — unless it is a shallow boundary — its ancestors).
  const held = new Set<string>();
  const closedCommits = new Set<string>();
  const shallowSet = new Set(shallowBoundaries);
  const holdTree = (treeOid: string): void => {
    if (held.has(treeOid)) return;
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    held.add(treeOid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') holdTree(entry.oid);
      else held.add(entry.oid);
    }
  };
  const holdCommit = (oid: string, wholeClosure: boolean): void => {
    const commit = getCommit(repo, oid);
    if (commit === undefined) return;
    held.add(oid);
    holdTree(commit.tree);
    if (!wholeClosure) return;
    if (closedCommits.has(oid)) return;
    closedCommits.add(oid);
    for (const parent of commit.parents) holdCommit(parent, true);
  };
  for (const have of haves) {
    holdCommit(have, !shallowSet.has(have));
  }
  // The commits to send, and every tree and blob their trees reference: a blob is
  // collected per commit, not per path, so older versions a parent tree still
  // references travel with it. Commits at or beyond the depth limit are boundaries:
  // named in shallow-info, never sent.
  const sendCommits: string[] = [];
  for (const oid of distances.keys()) {
    if (boundary.has(oid)) continue;
    if (!held.has(oid)) sendCommits.push(oid);
  }
  const sendSet = new Set(sendCommits);
  const sendObjects = new Map<string, GitObject>();
  const collectTree = (treeOid: string): void => {
    if (held.has(treeOid)) return;
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return;
    if (sendObjects.has(treeOid)) return;
    sendObjects.set(treeOid, object);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') {
        collectTree(entry.oid);
      } else if (!held.has(entry.oid)) {
        const blob = repo.objects.get(entry.oid);
        if (blob !== undefined) sendObjects.set(entry.oid, blob);
      }
    }
  };
  for (const oid of sendCommits) {
    const object = repo.objects.get(oid);
    if (object !== undefined) sendObjects.set(oid, object);
    const commit = getCommit(repo, oid);
    if (commit !== undefined) collectTree(commit.tree);
  }
  for (const tag of tagObjects) {
    if (!held.has(hashObject(tag.type, tag.data))) {
      sendObjects.set(hashObject(tag.type, tag.data), tag);
    }
  }
  // Order the pack: commits first (traversal order), then trees, then blobs, then tags.
  const ordered: GitObject[] = [];
  const byType = (type: string): GitObject[] => {
    const list: GitObject[] = [];
    for (const [, object] of sendObjects) {
      if (object.type === type) list.push(object);
    }
    return list;
  };
  const commitsInOrder: GitObject[] = [];
  for (const oid of distances.keys()) {
    const object = sendObjects.get(oid);
    if (object !== undefined && object.type === 'commit') commitsInOrder.push(object);
  }
  ordered.push(...commitsInOrder);
  ordered.push(...byType('tree'));
  ordered.push(...byType('blob'));
  ordered.push(...byType('tag'));
  // Shallow boundaries of this fetch: a sent commit is shallow when a parent of it
  // will not be on the client afterwards — neither sent now nor already held.
  const shallow: string[] = [];
  for (const oid of sendCommits) {
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    if (commit.parents.some((parent) => !held.has(parent) && !sendSet.has(parent))) {
      shallow.push(oid);
    }
  }
  // Unshallow: an old boundary whose parents are all on the client now, sent or held.
  const unshallow: string[] = [];
  for (const old of shallowBoundaries) {
    if (!distances.has(old)) continue;
    if (boundary.has(old)) continue;
    const commit = getCommit(repo, old);
    if (commit === undefined) continue;
    if (commit.parents.every((parent) => held.has(parent) || sendSet.has(parent))) {
      unshallow.push(old);
    }
  }
  return { objects: ordered, shallow, unshallow };
}

/** A sideband packet: band byte 1 (pack data) ahead of up to 65515 data bytes. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const slice = pack.subarray(at, Math.min(pack.length, at + CHUNK));
    out.push(encodePktLines([Buffer.concat([Buffer.from([1]), slice])]));
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// pack cache
// -------------------------------------------------------------------------------------------

/**
 * A fetch's pack is a pure function of the objects it reads, and objects are
 * content-addressed and immutable: the same (repo, wants, haves, depth, shallow)
 * always builds the same pack. Cache the built pack bytes so a repeated fetch —
 * fifty identical shallow clones, say — pays the build once. Bounded and FIFO:
 * a fresh entry evicts the oldest when the cache is full.
 */
const PACK_CACHE_MAX = 32;
const packCache = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>();

function packCacheKey(repo: Repo, args: FetchArgs): string {
  return JSON.stringify([
    repo.id,
    [...args.wants].sort(),
    [...args.haves].sort(),
    args.depth ?? null,
    [...args.shallow].sort(),
  ]);
}

function fetchPack(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = packCacheKey(repo, args);
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const plan = planFetch(repo, args.wants, args.haves, args.depth, args.shallow);
  const entry = { pack: writePack(plan.objects), shallow: plan.shallow, unshallow: plan.unshallow };
  if (packCache.size >= PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value as string | undefined;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, entry);
  return entry;
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  depth: number | undefined;
  shallow: string[];
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], depth: undefined, shallow: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  return args;
}

/** Haves that are ancestors of (reachable from, or equal to) any want: the shared history. */
function commonHaves(repo: Repo, wants: string[], haves: string[]): string[] {
  const ancestors = new Set<string>();
  for (const want of wants) {
    for (const oid of walkCommits(repo, want)) ancestors.add(oid);
  }
  return haves.filter((have) => ancestors.has(have));
}

function v2FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const missing = args.wants.filter((want) => !repo.objects.has(want));
  const parts: Buffer[] = [];
  if (missing.length > 0) {
    // The wanted object is not ours: a band-3 error inside the packfile section.
    // The acknowledgments section only appears when the client sent haves, because
    // a plain clone expects the first section to be the packfile.
    const error = `not our ref ${missing[0]}\n`;
    const lines: Array<string | Buffer> = [];
    if (args.haves.length > 0) lines.push('acknowledgments\n', 'NAK\n', 'delim');
    lines.push('packfile\n', Buffer.concat([Buffer.from([3]), Buffer.from(error, 'utf8')]));
    parts.push(encodePktLines(lines));
    parts.push(encodePktLines(['flush']));
    return Buffer.concat(parts);
  }
  const { pack, shallow, unshallow } = fetchPack(repo, args);
  if (args.haves.length > 0) {
    // Negotiation: ACK every have we share, then tell the client we are ready.
    const common = commonHaves(repo, args.wants, args.haves);
    const lines: string[] = ['acknowledgments\n'];
    if (common.length > 0) {
      for (const oid of common) lines.push(`ACK ${oid}\n`);
    } else {
      lines.push('NAK\n');
    }
    lines.push('ready\n', 'delim');
    parts.push(encodePktLines(lines));
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    const lines: string[] = ['shallow-info\n'];
    for (const oid of shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  // The packfile section is always present, even when it carries an empty pack.
  parts.push(encodePktLines(['packfile\n']));
  parts.push(Buffer.concat(sidebandPackets(pack)));
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const missing = args.wants.filter((want) => !repo.objects.has(want));
  const parts: Buffer[] = [];
  if (missing.length > 0) {
    parts.push(encodePktLines([`ERR not our ref ${missing[0]}\n`, 'flush']));
    return Buffer.concat(parts);
  }
  const { pack, shallow, unshallow } = fetchPack(repo, args);
  // v0 has no section headers: NAK/ACK lines, then shallow lines, then the pack.
  const lines: string[] = [];
  const common = args.haves.length > 0 ? commonHaves(repo, args.wants, args.haves) : [];
  if (common.length > 0) {
    for (const oid of common) lines.push(`ACK ${oid}\n`);
  } else {
    lines.push('NAK\n');
  }
  for (const oid of shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
  parts.push(encodePktLines(lines));
  parts.push(Buffer.concat(sidebandPackets(pack)));
  parts.push(encodePktLines(['flush']));
  return Buffer.concat(parts);
}

function v2LsRefsResponse(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of args) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice(11));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  for (const ref of advertisedRefs(repo)) {
    if (!keep(ref.name)) continue;
    if (ref.unborn === true) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

export function handleUploadPack(
  store: Store,
  owner: string,
  name: string,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, name) : undefined;
  if (repo === undefined) return { status: 404, contentType: 'text/plain', body: Buffer.from('Not Found', 'utf8') };
  const { packets } = decodePktLines(body);
  const dataLines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
  if (dataLines.length === 0) {
    return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.from('not a pkt-line stream', 'utf8') };
  }
  const first = dataLines[0] as string;
  if (first.startsWith('command=ls-refs')) {
    const delimAt = packets.findIndex((packet) => packet.kind === 'delim');
    const args = (delimAt < 0 ? packets.slice(1) : packets.slice(delimAt + 1))
      .filter((packet) => packet.kind === 'data')
      .map((packet) => packet.payload.toString('utf8'));
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2LsRefsResponse(repo, args) };
  }
  if (first.startsWith('command=fetch')) {
    const delimAt = packets.findIndex((packet) => packet.kind === 'delim');
    const args = (delimAt < 0 ? packets.slice(1) : packets.slice(delimAt + 1))
      .filter((packet) => packet.kind === 'data')
      .map((packet) => packet.payload.toString('utf8'));
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2FetchResponse(repo, parseFetchArgs(args)) };
  }
  // Protocol v0: want lines, shallow/deepen, flush, have lines, done, flush.
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0FetchResponse(repo, parseFetchArgs(dataLines)) };
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export async function handleReceivePack(
  store: Store,
  owner: string,
  name: string,
  body: Buffer,
): Promise<{ status: number; contentType: string; body: Buffer }> {
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, name) : undefined;
  if (repo === undefined) return { status: 404, contentType: 'text/plain', body: Buffer.from('Not Found', 'utf8') };
  const { packets, nextOffset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) continue;
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/x-git-receive-pack-result', body: Buffer.from('no push commands', 'utf8') };
  }
  // The pack follows the command list's flush; a delete-only push carries none.
  const packBytes = body.subarray(nextOffset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    if (!verifyPackChecksum(packBytes)) {
      unpackOk = false;
      unpackDetail = 'pack checksum mismatch';
    } else {
      try {
        const read = await readPack(packBytes);
        for (const [oid, object] of read.objects) repo.objects.set(oid, object);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack error';
      }
    }
  }
  // Evaluate every command against the pre-push refs, then apply the accepted ones.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    let ok = unpackOk;
    let reason = '';
    if (unpackOk) {
      const current = repo.refs.get(command.ref);
      if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
        ok = false;
        reason = 'invalid old and new';
      } else if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          ok = false;
          reason = 'remote ref does not exist';
        } else if (current !== command.oldOid) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          ok = false;
          reason = 'already exists';
        } else if (!repo.objects.has(command.newOid)) {
          ok = false;
          reason = 'unable to resolve new object';
        }
      } else {
        if (current === undefined) {
          ok = false;
          reason = 'remote ref does not exist';
        } else if (current !== command.oldOid) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!repo.objects.has(command.newOid)) {
          ok = false;
          reason = 'unable to resolve new object';
        } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
      }
    } else {
      reason = unpackDetail;
    }
    results.push({ ref: command.ref, ok, reason });
  }
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index] as PushCommand;
    const result = results[index] as { ref: string; ok: boolean; reason: string };
    if (!result.ok) continue;
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
  }
  // The report-status stream, pkt-lined inside sideband band 1 and terminated by its
  // own flush pkt-line inside the band, exactly as receive-pack does.
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const inner = encodePktLines([...reportLines, 'flush']);
  const outer: Buffer[] = [encodePktLines([Buffer.concat([Buffer.from([1]), inner])]), encodePktLines(['flush'])];
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(outer) };
}
