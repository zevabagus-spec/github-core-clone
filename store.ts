// The forge's store: every repository, object, ref, issue and pull
// request, in memory. One Store per process; every surface (REST, GraphQL,
// MCP, git) reads and writes the same records, so an object created on one
// surface reads back unchanged on the others.
//
// Determinism: no clock, no randomness. Every timestamp the API reports is
// FIXED_TIME, every server-made commit carries FIXED_IDENTITY at
// FIXED_EPOCH, and every counter is a plain sequence in request order.

import {
  buildCommitBytes,
  buildTree,
  deflateObject,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type ParsedCommit,
  type TreeEntry,
} from './gitobj.ts';
import { deriveViewer, type Viewer } from './scenario.ts';

export const FIXED_TIME = '2025-01-01T00:00:00Z';
export const FIXED_EPOCH = 1735689600;
const FORGE_IDENTITY = 'forge <forge@example.invalid>';
const COMMITTER_LINE = `${FORGE_IDENTITY} ${FIXED_EPOCH} +0000`;

export interface LabelRecord {
  id: number;
  name: string;
  color: string;
}

export interface CommentRecord {
  id: number;
  body: string;
  createdSeq: number;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: LabelRecord[];
  comments: CommentRecord[];
  createdSeq: number;
  updatedSeq: number;
  /** Cached serialization of issueJson for this record, or null when the
   * record changed since it was built. Every mutation site clears it
   * (addComment, REST PATCH, GraphQL closeIssue); labels are immutable
   * and the viewer is fixed, so nothing else can stale it. */
  jsonCache: Buffer | null;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** One repository: its objects, refs, labels, issues and pull requests. */
export class RepoState {
  readonly id: number;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = 'main';
  readonly createdSeq: number;

  readonly objects = new Map<string, GitObject>();
  readonly deflateCache = new Map<string, Buffer>();
  readonly refs = new Map<string, string>();
  readonly labels: LabelRecord[] = [];
  readonly labelByName = new Map<string, LabelRecord>();
  readonly issues = new Map<number, IssueRecord>();
  readonly pulls = new Map<number, PullRecord>();
  nextNumber = 1;
  seq = 0;

  // Parse caches. Objects are immutable, so a parsed form never goes stale.
  readonly commitCache = new Map<string, ParsedCommit>();
  readonly treeCache = new Map<string, TreeEntry[]>();
  readonly flatCache = new Map<string, Map<string, FlatEntry>>();

  // Whole-response cache for git smart HTTP (advertisements, ls-refs,
  // fetch replies), keyed by gitproto.ts on the request plus a fingerprint
  // of the refs and the object count. Objects only ever grow and refs are
  // in the key, so a hit is always the current answer. Bounded by
  // gitproto.ts; dropped with the repository.
  readonly gitResponseCache = new Map<string, Buffer>();

  constructor(id: number, name: string, description: string, isPrivate: boolean, createdSeq: number) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdSeq = createdSeq;
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  storeResolved(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) this.objects.set(oid, object);
  }

  deflated(oid: string): Buffer | undefined {
    let cached = this.deflateCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined) return undefined;
    cached = deflateObject(object.data);
    this.deflateCache.set(oid, cached);
    return cached;
  }

  parseCommit(oid: string): ParsedCommit | null {
    const cached = this.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    try {
      const parsed = parseCommit(object.data);
      this.commitCache.set(oid, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  parseTree(oid: string): TreeEntry[] | null {
    const cached = this.treeCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return null;
    try {
      const parsed = parseTree(object.data);
      this.treeCache.set(oid, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  /** The full path -> blob map of a tree, cached per tree oid. */
  flattenTree(treeOid: string): Map<string, FlatEntry> {
    const cached = this.flatCache.get(treeOid);
    if (cached !== undefined) return cached;
    const out = new Map<string, FlatEntry>();
    const walk = (oid: string, prefix: string): void => {
      const entries = this.parseTree(oid);
      if (entries === null) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    this.flatCache.set(treeOid, out);
    return out;
  }

  /** Follow annotated tags to the first non-tag object (or the oid itself). */
  peel(oid: string): string {
    let current = oid;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(current)) return current;
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tag') return current;
      try {
        current = parseTag(object.data).object;
      } catch {
        return current;
      }
    }
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }
}

export class Store {
  readonly viewer: Viewer;
  readonly repos = new Map<string, RepoState>();
  readonly order: RepoState[] = [];
  nextRepoId = 1;
  nextRecordId = 1;
  nextCommentId = 1;
  nextLabelId = 1;
  repoSeq = 0;

  constructor() {
    this.viewer = deriveViewer();
  }

  createRepo(name: string, description: string, isPrivate: boolean): RepoState | null {
    if (this.repos.has(name)) return null;
    this.repoSeq += 1;
    const repo = new RepoState(this.nextRepoId, name, description, isPrivate, this.repoSeq);
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    this.order.push(repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    const repo = this.repos.get(name);
    if (repo === undefined) return false;
    this.repos.delete(name);
    const index = this.order.indexOf(repo);
    if (index >= 0) this.order.splice(index, 1);
    return true;
  }

  getRepo(name: string): RepoState | undefined {
    return this.repos.get(name);
  }

  /** Resolve a repo by owner + name: only the viewer's own repos exist. */
  repoFor(owner: string, name: string): RepoState | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.repos.get(name);
  }

  // ------------------------------------------------------------------ issues

  createIssue(repo: RepoState, title: string, body: string, labelNames: readonly string[]): IssueRecord | null {
    const labels: LabelRecord[] = [];
    for (const name of labelNames) {
      const label = repo.labelByName.get(name);
      if (label === undefined) return null;
      labels.push(label);
    }
    const seq = repo.nextSeq();
    const issue: IssueRecord = {
      id: this.nextRecordId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
      jsonCache: null,
    };
    this.nextRecordId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: RepoState, issue: IssueRecord, body: string): CommentRecord {
    const comment: CommentRecord = { id: this.nextCommentId, body, createdSeq: repo.nextSeq() };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    issue.updatedSeq = repo.nextSeq();
    issue.jsonCache = null;
    return comment;
  }

  // -------------------------------------------------------------------- pulls

  createPull(
    repo: RepoState,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): PullRecord | null {
    const headSha = repo.branchTip(headRef);
    const baseSha = repo.branchTip(baseRef);
    if (headSha === undefined || baseSha === undefined) return null;
    const seq = repo.nextSeq();
    const pull: PullRecord = {
      id: this.nextRecordId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: seq,
      updatedSeq: seq,
    };
    this.nextRecordId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }
}

// ---------------------------------------------------------------------------
// git helpers over a repository

/** Resolve a ref-ish to a commit oid: a branch name, a full ref, or a 40-hex oid. */
export function resolveToCommit(repo: RepoState, ref: string): string | null {
  if (isOid(ref)) {
    const peeled = repo.peel(ref);
    return repo.parseCommit(peeled) !== null ? peeled : null;
  }
  const direct = repo.refs.get(ref);
  if (direct !== undefined) {
    const peeled = repo.peel(direct);
    return repo.parseCommit(peeled) !== null ? peeled : null;
  }
  const tip = repo.branchTip(ref);
  if (tip !== undefined) {
    const peeled = repo.peel(tip);
    return repo.parseCommit(peeled) !== null ? peeled : null;
  }
  return null;
}

/** Every commit reachable from `tip`, following all parents. */
export function ancestorSet(repo: RepoState, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = repo.parseCommit(oid);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

export function isAncestor(repo: RepoState, maybeAncestor: string, tip: string): boolean {
  if (maybeAncestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === maybeAncestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = repo.parseCommit(oid);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return false;
}

/** The merge-base of two tips: the first commit on a BFS from `a` that `b` reaches. */
export function mergeBase(repo: RepoState, a: string, b: string): string | null {
  const bAncestors = ancestorSet(repo, b);
  const seen = new Set<string>();
  const queue: string[] = [a];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (bAncestors.has(oid)) return oid;
    const commit = repo.parseCommit(oid);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

/** First-parent walk from a tip, newest first, capped. */
export function firstParentWalk(repo: RepoState, tip: string, cap: number): string[] {
  const out: string[] = [];
  let current: string | null = tip;
  const seen = new Set<string>();
  while (current !== null && out.length < cap && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    const commit = repo.parseCommit(current);
    current = commit !== null && commit.parents.length > 0 ? (commit.parents[0] as string) : null;
  }
  return out;
}

/** Build (and store) the tree objects for a flat path map; returns the root tree oid. */
export function buildTreeFromFlat(repo: RepoState, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return repo.putObject('tree', buildTree(entries));
  };
  return build(root);
}

/** Create and store a commit with the forge's fixed identity and timestamp. */
export function createCommit(repo: RepoState, tree: string, parents: readonly string[], message: string): string {
  const stored = message.endsWith('\n') ? message : `${message}\n`;
  const data = buildCommitBytes({
    tree,
    parents,
    message: stored,
    authorLine: COMMITTER_LINE,
    committerLine: COMMITTER_LINE,
  });
  return repo.putObject('commit', data);
}

/** A commit's message as the REST API reports it: one trailing newline stripped. */
export function restMessage(repo: RepoState, oid: string): string {
  const commit = repo.parseCommit(oid);
  if (commit === null) return '';
  const message = commit.message;
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

// ---------------------------------------------------------------------------
// diffs and merges

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiffCounts(aText: string, bText: string): { additions: number; deletions: number } {
  const aCounts = new Map<string, number>();
  for (const line of splitLines(aText)) aCounts.set(line, (aCounts.get(line) ?? 0) + 1);
  const bCounts = new Map<string, number>();
  for (const line of splitLines(bText)) bCounts.set(line, (bCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of bCounts) {
    const before = aCounts.get(line) ?? 0;
    if (count > before) additions += count - before;
  }
  for (const [line, count] of aCounts) {
    const after = bCounts.get(line) ?? 0;
    if (count > after) deletions += count - after;
  }
  return { additions, deletions };
}

function blobText(repo: RepoState, oid: string): string {
  const object = repo.getObject(oid);
  return object === undefined ? '' : object.data.toString('utf8');
}

/** Diff two flat trees: every path whose blob differs, with line counts. */
export function diffFlats(
  repo: RepoState,
  before: ReadonlyMap<string, FlatEntry>,
  after: ReadonlyMap<string, FlatEntry>,
): FileDiff[] {
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const a = before.get(path);
    const b = after.get(path);
    if (a !== undefined && b !== undefined && a.oid === b.oid) continue;
    if (a === undefined && b !== undefined) {
      const counts = lineDiffCounts('', blobText(repo, b.oid));
      out.push({ filename: path, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
    } else if (a !== undefined && b === undefined) {
      const counts = lineDiffCounts(blobText(repo, a.oid), '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
    } else if (a !== undefined && b !== undefined) {
      const counts = lineDiffCounts(blobText(repo, a.oid), blobText(repo, b.oid));
      out.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
  }
  return out;
}

/**
 * Three-way path-level merge. Returns the merged flat tree, or null when a
 * path changed on both sides to different results (a conflict).
 */
export function threeWayMerge(
  base: ReadonlyMap<string, FlatEntry>,
  head: ReadonlyMap<string, FlatEntry>,
  tip: ReadonlyMap<string, FlatEntry>,
): Map<string, FlatEntry> | null {
  const merged = new Map<string, FlatEntry>(tip);
  const paths = new Set<string>([...base.keys(), ...head.keys(), ...tip.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const t = tip.get(path);
    const headChanged = (h?.oid ?? null) !== (b?.oid ?? null);
    const tipChanged = (t?.oid ?? null) !== (b?.oid ?? null);
    if (headChanged && tipChanged && (h?.oid ?? null) !== (t?.oid ?? null)) return null;
    if (headChanged) {
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
    }
  }
  return merged;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'closed' | 'missing-branch' };

/**
 * Squash-merge an open pull request onto its base branch: one commit whose
 * single parent is the base tip and whose tree is the three-way merge.
 * The pull request is closed and marked merged. At most one merge per pull.
 */
export function mergePullRequest(repo: RepoState, pull: PullRecord): MergeOutcome {
  if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'closed' };
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  const headCommit = repo.parseCommit(repo.peel(headTip));
  const baseCommit = repo.parseCommit(repo.peel(baseTip));
  if (headCommit === null || baseCommit === null) return { ok: false, reason: 'missing-branch' };
  const baseOid = mergeBase(repo, baseTip, headTip);
  const baseFlat = baseOid === null ? new Map<string, FlatEntry>() : repo.flattenTree((repo.parseCommit(baseOid)?.tree ?? ''));
  const headFlat = repo.flattenTree(headCommit.tree);
  const tipFlat = repo.flattenTree(baseCommit.tree);
  const merged = threeWayMerge(baseFlat, headFlat, tipFlat);
  if (merged === null) return { ok: false, reason: 'conflict' };
  const treeOid = buildTreeFromFlat(repo, merged);
  const parents = repo.branchTip(pull.baseRef) !== undefined ? [baseTip] : [];
  const sha = createCommit(repo, treeOid, parents, `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TIME;
  pull.mergeCommitSha = sha;
  pull.updatedSeq = repo.nextSeq();
  return { ok: true, sha };
}

/** Whether an open pull request would merge cleanly (GraphQL `mergeable`). */
export function pullMergeable(repo: RepoState, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open' || pull.merged) return 'UNKNOWN';
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  const headCommit = repo.parseCommit(repo.peel(headTip));
  const baseCommit = repo.parseCommit(repo.peel(baseTip));
  if (headCommit === null || baseCommit === null) return 'UNKNOWN';
  const baseOid = mergeBase(repo, baseTip, headTip);
  const baseFlat = baseOid === null ? new Map<string, FlatEntry>() : repo.flattenTree((repo.parseCommit(baseOid)?.tree ?? ''));
  const merged = threeWayMerge(baseFlat, repo.flattenTree(headCommit.tree), repo.flattenTree(baseCommit.tree));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** The changed files of a pull request: merge-base tree vs head tree. */
export function pullFiles(repo: RepoState, pull: PullRecord): FileDiff[] {
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseTip = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  const headCommit = repo.parseCommit(repo.peel(headTip));
  if (headCommit === null) return [];
  const baseOid = mergeBase(repo, baseTip, headTip);
  const baseFlat = baseOid === null ? new Map<string, FlatEntry>() : repo.flattenTree((repo.parseCommit(baseOid)?.tree ?? ''));
  return diffFlats(repo, baseFlat, repo.flattenTree(headCommit.tree));
}

// ---------------------------------------------------------------------------
// global ids and cursors (GraphQL Relay ids, opaque and stable)

export function encodeGlobalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const segments = text.split(':');
    if (segments.length < 2) return null;
    const kind = segments[0] as string;
    if (kind === '') return null;
    // Reject ids that do not round-trip (garbage base64 decodes to garbage).
    if (Buffer.from(text, 'utf8').toString('base64') !== id) return null;
    return { kind, parts: segments.slice(1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: RepoState): string {
  return encodeGlobalId('Repository', repo.id);
}

export function issueGlobalId(repo: RepoState, issue: IssueRecord): string {
  return encodeGlobalId('Issue', repo.id, issue.number);
}

export function pullGlobalId(repo: RepoState, pull: PullRecord): string {
  return encodeGlobalId('PullRequest', repo.id, pull.number);
}

export function commentGlobalId(repo: RepoState, comment: CommentRecord): string {
  return encodeGlobalId('IssueComment', repo.id, comment.id);
}

export function encodeIssueCursor(number: number): string {
  return Buffer.from(`issue-cursor:${number}`, 'utf8').toString('base64');
}

export function decodeIssueCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue-cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// REST serializers (shared by REST, GraphQL cross-checks and MCP)

export function repoJson(store: Store, repo: RepoState): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${store.viewer.login}/${repo.name}`,
    owner: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    default_branch: repo.defaultBranch,
    has_issues: true,
  };
}

export function labelJson(label: LabelRecord): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: '' };
}

export function issueJson(store: Store, repo: RepoState, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    labels: issue.labels.map(labelJson),
    comments: issue.comments.length,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: issue.state === 'closed' ? FIXED_TIME : null,
  };
}

/** The exact bytes issueJson serializes to, cached on the record. The
 * read workload fetches one issue thousands of times unchanged, so the
 * second and later reads send these bytes without rebuilding the object
 * or stringifying it again. Mutation sites clear the cache. */
export function issueJsonBuffer(store: Store, repo: RepoState, issue: IssueRecord): Buffer {
  const cached = issue.jsonCache;
  if (cached !== null) return cached;
  const built = Buffer.from(JSON.stringify(issueJson(store, repo, issue)), 'utf8');
  issue.jsonCache = built;
  return built;
}

export function commentJson(store: Store, comment: CommentRecord): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

export function pullJson(store: Store, repo: RepoState, pull: PullRecord): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${store.viewer.login}:${pull.headRef}`,
      user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
      repo: { id: repo.id, name: repo.name, full_name: `${store.viewer.login}/${repo.name}` },
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${store.viewer.login}:${pull.baseRef}`,
      user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
      repo: { id: repo.id, name: repo.name, full_name: `${store.viewer.login}/${repo.name}` },
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: pull.state === 'closed' ? FIXED_TIME : null,
  };
}
