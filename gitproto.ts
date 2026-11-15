// Git smart HTTP: the two services' advertisements, upload-pack v2 and
// v0, and receive-pack v0. The transport is pkt-line framing over HTTP;
// the object model lives in gitobj.ts and the store in store.ts.
//
// This is the surface real git clients speak, so the framing rules are
// followed exactly: v2 advertisements carry no "# service" preamble, v0
// advertisements do; sideband band 1 carries the packfile in fetch
// replies and the report stream in receive-pack replies; receive-pack
// unpacks before it evaluates any ref update.

import {
  buildPack,
  decodePktLines,
  encodePktLines,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  readPack,
  ZERO_OID,
  type GitObject,
  type PktItem,
} from './gitobj.ts';
import {
  ancestorSet,
  isAncestor,
  FIXED_TIME,
  type RepoState,
  type Store,
} from './store.ts';
import { HttpError, type BinResult } from './types.ts';

const AGENT = 'agent=forge/1.0';

/** The protocol-v2 capability advertisement never varies: build it once. */
const V2_ADVERTISEMENT = encodePktLines([
  'version 2\n',
  'fetch=shallow filter\n',
  'ls-refs=unborn\n',
  'object-format=sha1\n',
  `${AGENT}\n`,
  'flush',
]);

/** Cap on a repository's cached git responses; oldest evicted first. */
const GIT_RESPONSE_CACHE_MAX = 256;

/**
 * A fingerprint of everything a git response can depend on: every ref and
 * its tip, plus the object count. Objects are never removed and refs are
 * listed in full, so two states with the same fingerprint answer every git
 * request identically; any mutation that could change an answer changes
 * the fingerprint (a ref move, or a new object growing the count).
 */
function gitFingerprint(repo: RepoState): string {
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let fp = '';
  for (const [ref, oid] of refs) fp += `${ref}=${oid},`;
  return `${fp}#${repo.objects.size}`;
}

function gitCacheGet(repo: RepoState, key: string): Buffer | undefined {
  return repo.gitResponseCache.get(key);
}

function gitCacheSet(repo: RepoState, key: string, body: Buffer): void {
  const cache = repo.gitResponseCache;
  if (!cache.has(key) && cache.size >= GIT_RESPONSE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, body);
}

function result(contentType: string, body: Buffer): BinResult {
  return { status: 200, contentType, body };
}

function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

function notFoundGit(message = 'Not Found'): HttpError {
  return new HttpError(404, message);
}

/** Resolve a git remote path: the repo must belong to the viewer. */
function resolveGitRepo(store: Store, owner: string, repoName: string): RepoState {
  const repo = store.repoFor(owner, repoName);
  if (repo === undefined) throw notFoundGit('repository not found');
  return repo;
}

function refLines(repo: RepoState): { ref: string; oid: string; peeled?: string }[] {
  const lines: { ref: string; oid: string; peeled?: string }[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of refs) {
    const entry: { ref: string; oid: string; peeled?: string } = { ref, oid };
    const object = repo.getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = repo.peel(oid);
      if (peeled !== oid) entry.peeled = peeled;
    }
    lines.push(entry);
  }
  return lines;
}

function defaultBranchRef(repo: RepoState): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------
// info/refs

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string | undefined,
  gitProtocol: string | undefined,
): BinResult {
  const repo = resolveGitRepo(store, owner, repoName);
  if (service === 'git-upload-pack') return advertiseUploadPack(repo, gitProtocol);
  if (service === 'git-receive-pack') return advertiseReceivePack(repo);
  throw badRequest('unknown service');
}

function advertiseUploadPack(repo: RepoState, gitProtocol: string | undefined): BinResult {
  const isV2 = gitProtocol !== undefined && gitProtocol.split(' ').includes('version=2');
  if (isV2) {
    return result('application/x-git-upload-pack-advertisement', V2_ADVERTISEMENT);
  }
  const key = `ad-up0|${gitFingerprint(repo)}`;
  const cached = gitCacheGet(repo, key);
  if (cached !== undefined) return result('application/x-git-upload-pack-advertisement', cached);
  const caps = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow ${AGENT} symref=HEAD:${defaultBranchRef(repo)}`;
  const items: PktItem[] = ['# service=git-upload-pack\n', 'flush'];
  const refs = refLines(repo);
  const headTip = repo.branchTip(repo.defaultBranch);
  if (headTip !== undefined) {
    items.push(`${headTip} HEAD\0${caps}\n`);
  }
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    let first = headTip === undefined;
    for (const line of refs) {
      const suffix = first ? `\0${caps}` : '';
      first = false;
      items.push(`${line.oid} ${line.ref}${suffix}\n`);
      if (line.peeled !== undefined) items.push(`${line.peeled} ${line.ref}^{}\n`);
    }
  }
  items.push('flush');
  const body = encodePktLines(items);
  gitCacheSet(repo, key, body);
  return result('application/x-git-upload-pack-advertisement', body);
}

function advertiseReceivePack(repo: RepoState): BinResult {
  const key = `ad-rp|${gitFingerprint(repo)}`;
  const cached = gitCacheGet(repo, key);
  if (cached !== undefined) return result('application/x-git-receive-pack-advertisement', cached);
  const caps = `report-status side-band-64k delete-refs ofs-delta ${AGENT} symref=HEAD:${defaultBranchRef(repo)}`;
  const items: PktItem[] = ['# service=git-receive-pack\n', 'flush'];
  const refs = refLines(repo);
  const headTip = repo.branchTip(repo.defaultBranch);
  if (headTip !== undefined) {
    items.push(`${headTip} HEAD\0${caps}\n`);
  }
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    let first = headTip === undefined;
    for (const line of refs) {
      const suffix = first ? `\0${caps}` : '';
      first = false;
      items.push(`${line.oid} ${line.ref}${suffix}\n`);
      if (line.peeled !== undefined) items.push(`${line.peeled} ${line.ref}^{}\n`);
    }
  }
  items.push('flush');
  const body = encodePktLines(items);
  gitCacheSet(repo, key, body);
  return result('application/x-git-receive-pack-advertisement', body);
}

// ---------------------------------------------------------------------------
// sideband

/** Chunk bytes into sideband band-1 packets (≤65515 data bytes each). */
function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const maxChunk = 65515;
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxChunk));
    const packet = Buffer.allocUnsafe(4 + 1 + chunk.length);
    packet.write((chunk.length + 5).toString(16).padStart(4, '0'), 0, 4, 'ascii');
    packet[4] = band;
    chunk.copy(packet, 5);
    packets.push(packet);
  }
  if (data.length === 0) {
    const packet = Buffer.allocUnsafe(5);
    packet.write('0005', 0, 4, 'ascii');
    packet[4] = band;
    packets.push(packet);
  }
  return packets;
}

function sidebandFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

// ---------------------------------------------------------------------------
// fetch object selection

interface FetchPlan {
  /** Oids to put in the pack, in deterministic order. */
  send: string[];
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

function commitClosure(repo: RepoState, tips: readonly string[], stopAt: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (stopAt.has(oid)) continue;
    const commit = repo.parseCommit(oid);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

function treeClosure(repo: RepoState, treeOid: string, out: Set<string>): void {
  if (out.has(treeOid)) return;
  out.add(treeOid);
  const entries = repo.parseTree(treeOid);
  if (entries === null) return;
  for (const entry of entries) {
    if (entry.mode === '40000') treeClosure(repo, entry.oid, out);
    else out.add(entry.oid);
  }
}

/**
 * The set of objects a fetch must send: the depth-limited closure of the
 * wants, minus the closure of the haves (which stops at client-declared
 * shallow boundaries), with shallow/unshallow lines computed from the
 * boundaries of the two sets.
 */
function planFetch(
  repo: RepoState,
  wants: readonly string[],
  haves: readonly string[],
  shallowLines: readonly string[],
  depth: number | null,
): FetchPlan {
  const boundary = new Set(shallowLines);
  const haveClosure = commitClosure(repo, haves, boundary);
  for (const oid of haves) {
    const peeled = repo.peel(oid);
    if (peeled !== oid) {
      for (const extra of commitClosure(repo, [peeled], boundary)) haveClosure.add(extra);
    }
  }
  // Everything the client already holds: the have commits plus each
  // commit's full tree closure (the walk stopped at declared shallow
  // boundaries, whose own trees the client holds but whose parents it
  // does not). Re-sending any of these fails incremental-fetch checks.
  const haveObjects = new Set<string>(haves);
  for (const oid of haveClosure) {
    haveObjects.add(oid);
    const commit = repo.parseCommit(oid);
    if (commit !== null) treeClosure(repo, commit.tree, haveObjects);
  }

  // Depth-limited walk from the wants. A wanted tag contributes itself and
  // its peel target's closure.
  const wantCommits = new Set<string>();
  const extraObjects = new Set<string>();
  const depthOf = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = [];
  let queueIndex = 0;
  for (const want of wants) {
    const object = repo.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      extraObjects.add(want);
      const target = repo.peel(want);
      if (target !== want) queue.push({ oid: target, depth: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 1 });
    } else {
      extraObjects.add(want);
    }
  }
  while (queueIndex < queue.length) {
    const { oid, depth: at } = queue[queueIndex] as { oid: string; depth: number };
    queueIndex += 1;
    if (wantCommits.has(oid)) continue;
    if (depth !== null && at > depth) continue;
    if (repo.parseCommit(oid) === null) continue;
    wantCommits.add(oid);
    depthOf.set(oid, at);
    if (depth === null || at < depth) {
      const commit = repo.parseCommit(oid) as ReturnType<typeof parseCommit>;
      for (const parent of commit.parents) queue.push({ oid: parent, depth: at + 1 });
    }
  }

  const send = new Set<string>(extraObjects);
  for (const oid of wantCommits) {
    if (haveClosure.has(oid)) continue;
    send.add(oid);
    const commit = repo.parseCommit(oid);
    if (commit !== null) treeClosure(repo, commit.tree, send);
  }
  for (const oid of haveObjects) send.delete(oid);

  const shallow: string[] = [];
  for (const oid of send) {
    if (!wantCommits.has(oid) || haveClosure.has(oid)) continue;
    const commit = repo.parseCommit(oid);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      const parentKnown = repo.getObject(parent) !== undefined;
      if (parentKnown && !send.has(parent) && !haveClosure.has(parent)) {
        shallow.push(oid);
        break;
      }
    }
  }
  shallow.sort();

  const unshallow: string[] = [];
  for (const oid of boundary) {
    const commit = repo.parseCommit(oid);
    if (commit === null) continue;
    const parentsIncluded = commit.parents.every((parent) => send.has(parent) || haveClosure.has(parent));
    if (parentsIncluded && commit.parents.length > 0) unshallow.push(oid);
  }
  unshallow.sort();

  let ack: string | null = null;
  // The wanted closure is walked once here, not once per have.
  const wantAncestors = haves.length > 0 && wants.length > 0 ? ancestorSet(repo, wants[0] as string) : null;
  for (const have of haves) {
    if (wantCommits.has(have) || haveClosure.has(have) && wantCommits.size > 0) {
      // The first have that lies in the wanted closure is acknowledged.
      if ((wantAncestors !== null && wantAncestors.has(have)) || wantCommits.has(have)) {
        ack = have;
        break;
      }
    }
  }
  if (ack === null && haves.length > 0) {
    // Fall back: any have reachable from a want counts as common.
    for (const have of haves) {
      for (const want of wants) {
        if (isAncestor(repo, have, repo.peel(want))) {
          ack = have;
          break;
        }
      }
      if (ack !== null) break;
    }
  }

  return { send: [...send].sort(), shallow, unshallow, ack };
}

function buildFetchPack(repo: RepoState, oids: readonly string[]): Buffer {
  const items: { type: GitObject['type']; size: number; deflated: Buffer }[] = [];
  for (const oid of oids) {
    const object = repo.getObject(oid);
    if (object === undefined) continue;
    const deflated = repo.deflated(oid);
    if (deflated === undefined) continue;
    items.push({ type: object.type, size: object.data.length, deflated });
  }
  return buildPack(items);
}

// ---------------------------------------------------------------------------
// upload-pack

export function handleUploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | undefined,
): BinResult {
  const repo = resolveGitRepo(store, owner, repoName);
  const isV2 = gitProtocol !== undefined && gitProtocol.split(' ').includes('version=2');
  const { packets } = decodePktLines(body, 0, false);
  if (isV2) return handleUploadPackV2(repo, packets);
  return handleUploadPackV0(repo, packets);
}

interface V2Request {
  command: string;
  args: string[];
}

function parseV2Request(packets: ReturnType<typeof decodePktLines>['packets']): V2Request {
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
      continue;
    }
    args.push(text);
  }
  return { command, args };
}

function handleUploadPackV2(
  repo: RepoState,
  packets: ReturnType<typeof decodePktLines>['packets'],
): BinResult {
  const { command, args } = parseV2Request(packets);
  if (command === 'ls-refs') return lsRefsV2(repo, args);
  if (command === 'fetch') return fetchV2(repo, args);
  throw badRequest(`unknown upload-pack command ${JSON.stringify(command)}`);
}

function lsRefsV2(repo: RepoState, args: readonly string[]): BinResult {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg.startsWith('ref-prefix=')) prefixes.push(arg.slice('ref-prefix='.length));
  }
  const key = `lsrefs|${gitFingerprint(repo)}|${peel ? 1 : 0}${symrefs ? 1 : 0}${unborn ? 1 : 0}|${prefixes.join(',')}`;
  const cached = gitCacheGet(repo, key);
  if (cached !== undefined) return result('application/x-git-upload-pack-result', cached);
  const matchPrefix = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const items: PktItem[] = [];
  const headTip = repo.branchTip(repo.defaultBranch);
  const headName = 'HEAD';
  if (headTip !== undefined) {
    if (matchPrefix(headName)) {
      let line = `${headTip} ${headName}`;
      if (symrefs) line += ` symref-target:${defaultBranchRef(repo)}`;
      items.push(`${line}\n`);
    }
  } else if (unborn && matchPrefix(headName)) {
    let line = `unborn ${headName}`;
    if (symrefs) line += ` symref-target:${defaultBranchRef(repo)}`;
    items.push(`${line}\n`);
  }
  for (const line of refLines(repo)) {
    if (!matchPrefix(line.ref)) continue;
    let text = `${line.oid} ${line.ref}`;
    if (peel && line.peeled !== undefined) text += ` peeled:${line.peeled}`;
    items.push(`${text}\n`);
  }
  items.push('flush');
  const body = encodePktLines(items);
  gitCacheSet(repo, key, body);
  return result('application/x-git-upload-pack-result', body);
}

function fetchV2(repo: RepoState, args: readonly string[]): BinResult {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowLines: string[] = [];
  let depth: number | null = null;
  let hasDone = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowLines.push(arg.slice(8).trim());
    else if (arg === 'done') hasDone = true;
    else if (arg.startsWith('deepen ')) {
      const parsed = Number.parseInt(arg.slice(7), 10);
      if (Number.isFinite(parsed) && parsed > 0) depth = depth === null ? parsed : Math.min(depth, parsed);
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not:
    // accepted, no effect on the reply shape.
  }
  // The request order of wants/haves is kept in the key: it decides which
  // have is acknowledged, so two requests that differ only in order are
  // different cache entries.
  const key = `fetch2|${gitFingerprint(repo)}|${wants.join(',')}|${haves.join(',')}|${shallowLines.join(',')}|${depth ?? ''}|${hasDone ? 1 : 0}`;
  const cached = gitCacheGet(repo, key);
  if (cached !== undefined) return result('application/x-git-upload-pack-result', cached);
  const plan = planFetch(repo, wants, haves, shallowLines, depth);

  // Protocol-v2 fetch grammar:
  //   output = acknowledgments flush-pkt
  //          | [acknowledgments delim-pkt] [shallow-info delim-pkt]
  //            packfile flush-pkt
  // When the client sent "done" the acknowledgments section is omitted.
  // When it did not, the section is sent: ACK + "ready" followed by a
  // delim means the packfile follows in this same response; NAK followed
  // by a flush means no packfile (the client negotiates further).
  const shallowApplies =
    depth !== null || shallowLines.length > 0 || plan.shallow.length > 0 || plan.unshallow.length > 0;

  let body: Buffer;
  if (!hasDone && plan.ack === null) {
    const ackItems: PktItem[] = ['acknowledgments\n', 'NAK\n', 'flush'];
    body = encodePktLines(ackItems);
  } else {
    const pack = buildFetchPack(repo, plan.send);
    const sections: Buffer[] = [];
    if (!hasDone) {
      const ackItems: PktItem[] = ['acknowledgments\n', `ACK ${plan.ack as string}\n`, 'ready\n', 'delim'];
      sections.push(encodePktLines(ackItems));
    }
    if (shallowApplies) {
      const shallowItems: PktItem[] = ['shallow-info\n'];
      for (const oid of plan.shallow) shallowItems.push(`shallow ${oid}\n`);
      for (const oid of plan.unshallow) shallowItems.push(`unshallow ${oid}\n`);
      shallowItems.push('delim');
      sections.push(encodePktLines(shallowItems));
    }
    sections.push(encodePktLines(['packfile\n']));
    sections.push(Buffer.concat(sidebandPackets(1, pack)));
    sections.push(sidebandFlush());
    body = Buffer.concat(sections);
  }
  gitCacheSet(repo, key, body);
  return result('application/x-git-upload-pack-result', body);
}

function handleUploadPackV0(
  repo: RepoState,
  packets: ReturnType<typeof decodePktLines>['packets'],
): BinResult {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowLines: string[] = [];
  let depth: number | null = null;
  let seenFlush = false;
  let firstWant = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenFlush) {
      if (text.startsWith('want ')) {
        // The first want line carries capabilities after the oid,
        // space-separated (and NUL-separated forms are tolerated too):
        // only the first token is the wanted object id.
        const rest = text.slice(5);
        const oid = rest.split(/[\0 ]/, 1)[0] as string;
        wants.push(oid.trim());
        firstWant = false;
      } else if (text.startsWith('shallow ')) {
        shallowLines.push(text.slice(8).trim());
      } else if (text.startsWith('deepen ')) {
        const parsed = Number.parseInt(text.slice(7), 10);
        if (Number.isFinite(parsed) && parsed > 0) depth = depth === null ? parsed : Math.min(depth, parsed);
      }
      void firstWant;
    } else {
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      // "done" ends the have list; nothing to do.
    }
  }
  const key = `fetch0|${gitFingerprint(repo)}|${wants.join(',')}|${haves.join(',')}|${shallowLines.join(',')}|${depth ?? ''}`;
  const cached = gitCacheGet(repo, key);
  if (cached !== undefined) return result('application/x-git-upload-pack-result', cached);
  const plan = planFetch(repo, wants, haves, shallowLines, depth);
  const pack = buildFetchPack(repo, plan.send);

  const parts: Buffer[] = [];
  const prefix: PktItem[] = [];
  for (const oid of plan.shallow) prefix.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) prefix.push(`unshallow ${oid}\n`);
  if (plan.ack !== null) prefix.push(`ACK ${plan.ack}\n`);
  else prefix.push('NAK\n');
  parts.push(encodePktLines(prefix));
  parts.push(Buffer.concat(sidebandPackets(1, pack)));
  parts.push(sidebandFlush());
  const body = Buffer.concat(parts);
  gitCacheSet(repo, key, body);
  return result('application/x-git-upload-pack-result', body);
}

// ---------------------------------------------------------------------------
// receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): BinResult {
  const repo = resolveGitRepo(store, owner, repoName);
  let decoded: ReturnType<typeof decodePktLines>;
  try {
    decoded = decodePktLines(body, 0, true);
  } catch (err) {
    throw badRequest(`malformed pkt-line request: ${(err as Error).message}`);
  }
  const commands: RefCommand[] = [];
  let wantsSideband = false;
  let first = true;
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        const caps = text.slice(nul + 1);
        if (caps.split(' ').includes('side-band-64k')) wantsSideband = true;
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length < 3) throw badRequest('malformed receive-pack command');
    const [oldOid, newOid, ...refParts] = parts as [string, string, ...string[]];
    commands.push({ oldOid, newOid, ref: refParts.join(' ') });
  }
  const packBytes = body.subarray(decoded.nextOffset);

  // Unpack before evaluating any ref: refused updates still store objects.
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.getObject(oid));
      for (const [oid, object] of objects) repo.storeResolved(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackError = (err as Error).message;
    }
  } else if (commands.some((cmd) => cmd.newOid !== ZERO_OID)) {
    // An update with no pack bytes at all cannot bring its objects.
    // (A 32-byte empty pack is the normal "nothing new" case and is fine.)
    unpackOk = false;
    unpackError = 'missing packfile';
  }

  const report: string[] = [];
  if (unpackOk) {
    report.push('unpack ok\n');
    for (const cmd of commands) report.push(evaluateCommand(repo, cmd));
  } else {
    report.push(`unpack ${unpackError === '' ? 'failed' : unpackError}\n`);
    for (const cmd of commands) report.push(`ng ${cmd.ref} unpacker error\n`);
  }
  report.push('flush');

  let payload: Buffer;
  if (wantsSideband) {
    const stream = encodePktLines(report.map((line) => (line === 'flush' ? 'flush' : line) as PktItem));
    payload = Buffer.concat([...sidebandPackets(1, stream), sidebandFlush()]);
  } else {
    payload = encodePktLines(report.map((line) => (line === 'flush' ? 'flush' : line) as PktItem));
  }
  return result('application/x-git-receive-pack-result', payload);
}

function evaluateCommand(repo: RepoState, cmd: RefCommand): string {
  const current = repo.refs.get(cmd.ref);
  const ok = `ok ${cmd.ref}\n`;
  const ng = (reason: string): string => `ng ${cmd.ref} ${reason}\n`;
  if (!isOid(cmd.oldOid) || !isOid(cmd.newOid)) return ng('invalid object id');

  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return ng('remote ref does not exist');
    if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) return ng('stale info');
    repo.refs.delete(cmd.ref);
    return ok;
  }

  const object = repo.getObject(cmd.newOid);
  if (object === undefined) return ng('object not found');

  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return ng('already exists');
    repo.refs.set(cmd.ref, cmd.newOid);
    return ok;
  }

  // Update.
  if (current === undefined) return ng('remote ref does not exist');
  if (cmd.oldOid !== current) return ng('stale info');
  if (cmd.newOid === current) return ok;
  if (cmd.ref.startsWith('refs/tags/')) return ng('non-fast-forward');
  const newPeeled = repo.peel(cmd.newOid);
  const currentPeeled = repo.peel(current);
  const newCommit = repo.parseCommit(newPeeled);
  const currentCommit = repo.parseCommit(currentPeeled);
  if (newCommit === null || currentCommit === null) {
    // Non-commit ref updates (e.g. notes) must be exact; treat as fast-forward
    // only when the new object descends from the current one, which cannot
    // be shown for non-commits.
    return ng('non-fast-forward');
  }
  if (!isAncestor(repo, currentPeeled, newPeeled)) return ng('non-fast-forward');
  repo.refs.set(cmd.ref, cmd.newOid);
  return ok;
}

// Keep the unused imports honest for strict builds.
export function _gitprotoDiagnostics(): { fixedTime: string; hashExample: string } {
  return { fixedTime: FIXED_TIME, hashExample: hashObject('blob', Buffer.from('')) };
}

export type { GitObject };
export { parseCommit, parseTag };
