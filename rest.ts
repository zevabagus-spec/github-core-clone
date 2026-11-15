// REST API v3, under /api/v3. Handlers receive a small request context and
// return a JsonResult, or throw an HttpError. The route table lives here;
// app.ts owns auth, the request id and the JSON body parse.
//
// Two shapes matter most. Pagination: list endpoints take per_page/page and
// answer a Link header with an absolute same-origin next URL. Errors: every
// failure is JSON {message}, never HTML.

import {
  buildTreeFromFlat,
  commentJson,
  createCommit,
  diffFlats,
  firstParentWalk,
  issueJson,
  labelJson,
  mergePullRequest,
  pullFiles,
  pullJson,
  repoJson,
  resolveToCommit,
  restMessage,
  FIXED_TIME,
  type CommentRecord,
  type FlatEntry,
  type IssueRecord,
  type LabelRecord,
  type PullRecord,
  type RepoState,
  type Store,
} from './store.ts';
import { conflict, HttpError, notFound, unprocessable, type JsonResult } from './types.ts';
import { isOid } from './gitobj.ts';

export interface RestContext {
  readonly store: Store;
  /** Decoded path segments below /api/v3 (no empty segments). */
  readonly segments: readonly string[];
  readonly query: ReadonlyMap<string, string>;
  readonly host: string;
  readonly method: string;
  readonly body: unknown;
  readonly origin: string;
}

type Handler = (ctx: RestContext, segments: readonly string[]) => JsonResult;

function ok(json: unknown, status = 200, headers?: Record<string, string>): JsonResult {
  return { status, json, headers };
}

function empty(status: number): JsonResult {
  return { status, json: null };
}

function bodyObject(ctx: RestContext): Record<string, unknown> {
  if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return ctx.body as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pageParams(query: ReadonlyMap<string, string>): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const raw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(raw) && raw > 0 ? Math.min(100, raw) : 30;
  return { page, perPage };
}

function paginate<T>(items: readonly T[], ctx: RestContext, rawPath: string): { page: T[]; headers?: Record<string, string> } {
  const { page, perPage } = pageParams(ctx.query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const nextQuery = new URLSearchParams();
    for (const [key, value] of ctx.query) {
      if (key !== 'page' && key !== 'per_page') nextQuery.set(key, value);
    }
    nextQuery.set('page', String(page + 1));
    nextQuery.set('per_page', String(perPage));
    const url = `${ctx.origin}${rawPath}?${nextQuery.toString()}`;
    return { page: slice, headers: { link: `<${url}>; rel="next"` } };
  }
  return { page: slice };
}

/** Resolve /repos/{owner}/{repo} from the leading segments; 404 unless the viewer owns it. */
function resolveRepo(ctx: RestContext, segments: readonly string[]): RepoState {
  const owner = segments[1] as string;
  const name = segments[2] as string;
  const repo = ctx.store.repoFor(owner, name);
  if (repo === undefined) throw notFound('Not Found');
  return repo;
}

function findIssue(repo: RepoState, raw: string): IssueRecord {
  const number = Number(raw);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) throw notFound('Not Found');
  return issue;
}

function findPull(repo: RepoState, raw: string): PullRecord {
  const number = Number(raw);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) throw notFound('Not Found');
  return pull;
}

// ---------------------------------------------------------------------------
// root, meta, user

function handleRoot(ctx: RestContext): JsonResult {
  return ok(
    { current_user_url: `${ctx.origin}/api/v3/user`, message: 'ok' },
    200,
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function handleMeta(): JsonResult {
  return ok({ installed_version: '1.0.0', verifiable_password_authentication: false });
}

function handleUser(ctx: RestContext): JsonResult {
  const viewer = ctx.store.viewer;
  return ok({
    login: viewer.login,
    id: viewer.id,
    name: viewer.name,
    email: viewer.email,
    type: 'User',
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  });
}

function handleCreateRepo(ctx: RestContext): JsonResult {
  const body = bodyObject(ctx);
  const name = asString(body.name);
  if (name === undefined || name === '') throw unprocessable('name is required');
  const repo = ctx.store.createRepo(name, asString(body.description) ?? '', asBoolean(body.private) ?? false);
  if (repo === null) throw unprocessable('name already exists on this account');
  return ok(repoJson(ctx.store, repo), 201);
}

function handleListRepos(ctx: RestContext): JsonResult {
  const repos = ctx.store.order.map((repo) => repoJson(ctx.store, repo));
  const { page, headers } = paginate(repos, ctx, '/api/v3/user/repos');
  return ok(page, 200, headers);
}

// ---------------------------------------------------------------------------
// repositories

function handleGetRepo(ctx: RestContext, segments: readonly string[]): JsonResult {
  return ok(repoJson(ctx.store, resolveRepo(ctx, segments)));
}

function handlePatchRepo(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const body = bodyObject(ctx);
  const description = asString(body.description);
  if (description !== undefined) repo.description = description;
  const isPrivate = asBoolean(body.private);
  if (isPrivate !== undefined) repo.isPrivate = isPrivate;
  return ok(repoJson(ctx.store, repo));
}

function handleDeleteRepo(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  ctx.store.deleteRepo(repo.name);
  return empty(204);
}

// ---------------------------------------------------------------------------
// git refs

function handleCreateRef(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const body = bodyObject(ctx);
  const ref = asString(body.ref);
  const sha = asString(body.sha);
  if (ref === undefined || sha === undefined || !isOid(sha)) {
    throw unprocessable('ref and sha are required');
  }
  if (repo.refs.has(ref)) throw unprocessable('Reference already exists');
  repo.refs.set(ref, sha);
  return ok({ ref, object: { sha, type: 'commit' }, url: '' }, 201);
}

function handleGetRef(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const remainder = segments.slice(5).join('/');
  const fullRef = `refs/${remainder}`;
  const exact = repo.refs.get(fullRef);
  if (exact !== undefined) return ok({ ref: fullRef, object: { sha: exact, type: 'commit' } });
  const matches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith(`${fullRef}/`))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (matches.length > 0) {
    return ok(matches.map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } })));
  }
  throw notFound('Not Found');
}

// ---------------------------------------------------------------------------
// branches and commits

function handleListBranches(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const branches: Record<string, unknown>[] = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return ok(branches);
}

function handleGetBranch(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const branch = segments.slice(4).join('/');
  const tip = repo.branchTip(branch);
  if (tip === undefined) throw notFound('Not Found');
  return ok({ name: branch, commit: { sha: tip }, protected: false });
}

function handleListCommits(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const ref = ctx.query.get('sha');
  let tip: string | undefined;
  if (ref !== undefined) {
    const resolved = resolveToCommit(repo, ref);
    if (resolved === null) throw notFound('Not Found');
    tip = resolved;
  } else {
    tip = repo.branchTip(repo.defaultBranch);
    if (tip === undefined) return ok([]);
  }
  const commits = firstParentWalk(repo, tip, 100).map((sha) => ({
    sha,
    commit: { message: restMessage(repo, sha), author: { name: 'forge', email: 'forge@example.invalid', date: FIXED_TIME } },
  }));
  return ok(commits);
}

// ---------------------------------------------------------------------------
// contents

/** Resolve a contents ref parameter: branch name, full ref, or oid; null when absent and no tip. */
function contentsCommit(repo: RepoState, ref: string | undefined): string | null {
  if (ref === undefined) {
    const tip = repo.branchTip(repo.defaultBranch);
    return tip === undefined ? null : repo.peel(tip);
  }
  return resolveToCommit(repo, ref);
}

function contentsEntries(
  repo: RepoState,
  flat: ReadonlyMap<string, FlatEntry>,
  prefix: string,
): { type: string; name: string; path: string; sha: string; size?: number }[] {
  const dirPrefix = prefix === '' ? '' : `${prefix}/`;
  const entries: { type: string; name: string; path: string; sha: string; size?: number }[] = [];
  const dirs = new Set<string>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(dirPrefix)) continue;
    const rest = path.slice(dirPrefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const object = repo.getObject(entry.oid);
      entries.push({
        type: 'file',
        name: rest,
        path,
        sha: entry.oid,
        size: object === undefined ? 0 : object.data.length,
      });
    } else {
      dirs.add(rest.slice(0, slash));
    }
  }
  for (const dir of [...dirs].sort()) {
    entries.push({ type: 'dir', name: dir, path: `${dirPrefix}${dir}`, sha: '' });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  // Directory entries carry the subtree oid when the directory can be found.
  return entries;
}

function handleGetContents(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const path = segments.slice(4).join('/');
  const commitOid = contentsCommit(repo, ctx.query.get('ref'));
  if (commitOid === null) throw notFound('Not Found');
  const commit = repo.parseCommit(commitOid);
  if (commit === null) throw notFound('Not Found');
  const flat = repo.flattenTree(commit.tree);
  const direct = flat.get(path);
  if (direct !== undefined) {
    const object = repo.getObject(direct.oid);
    const data = object === undefined ? Buffer.alloc(0) : object.data;
    return ok({
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      sha: direct.oid,
      size: data.length,
      name: path.split('/').pop() ?? '',
      path,
    });
  }
  const listing = contentsEntries(repo, flat, path);
  if (listing.length === 0) throw notFound('Not Found');
  return ok(listing);
}

function writeContents(
  ctx: RestContext,
  segments: readonly string[],
  kind: 'put' | 'delete',
): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const path = segments.slice(4).join('/');
  const body = bodyObject(ctx);
  const message = asString(body.message) ?? '';
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const givenSha = asString(body.sha);
  const tip = repo.branchTip(branch);

  let flat: Map<string, FlatEntry>;
  let parents: string[] = [];
  if (tip !== undefined) {
    const commit = repo.parseCommit(repo.peel(tip));
    if (commit === null) throw notFound('Not Found');
    flat = new Map(repo.flattenTree(commit.tree));
    parents = [tip];
  } else {
    // Missing branch starts from the default branch's tip, or an empty root.
    const defaultTip = repo.branchTip(repo.defaultBranch);
    if (defaultTip !== undefined) {
      const commit = repo.parseCommit(repo.peel(defaultTip));
      if (commit === null) throw notFound('Not Found');
      flat = new Map(repo.flattenTree(commit.tree));
      parents = [defaultTip];
    } else {
      flat = new Map();
    }
  }

  const existing = flat.get(path);
  let blobSha: string | undefined;
  if (kind === 'put') {
    const content = asString(body.content);
    if (content === undefined) throw unprocessable('content is required');
    const bytes = Buffer.from(content, 'base64');
    if (existing !== undefined) {
      if (givenSha === undefined) throw unprocessable('sha is required to update an existing file');
      if (givenSha !== existing.oid) throw conflict('sha does not match the current blob');
    }
    blobSha = repo.putObject('blob', bytes);
    flat.set(path, { oid: blobSha, mode: '100644' });
  } else {
    if (existing === undefined) throw notFound('Not Found');
    if (givenSha !== undefined && givenSha !== existing.oid) throw conflict('sha does not match the current blob');
    flat.delete(path);
  }

  const treeOid = buildTreeFromFlat(repo, flat);
  const sha = createCommit(repo, treeOid, parents, message);
  repo.refs.set(`refs/heads/${branch}`, sha);
  const status = kind === 'put' ? (existing === undefined ? 201 : 200) : 200;
  const result: Record<string, unknown> = { commit: { sha, message } };
  if (kind === 'put') {
    result.content = { sha: blobSha, encoding: 'base64', name: path.split('/').pop() ?? '', path, size: 0 };
  }
  return ok(result, status);
}

// ---------------------------------------------------------------------------
// labels and issues

function handleCreateLabel(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const body = bodyObject(ctx);
  const name = asString(body.name);
  if (name === undefined || name === '') throw unprocessable('name is required');
  if (repo.labelByName.has(name)) throw unprocessable('label already exists');
  const label: LabelRecord = {
    id: ctx.store.nextLabelId,
    name,
    color: asString(body.color) ?? 'ededed',
  };
  ctx.store.nextLabelId += 1;
  repo.labels.push(label);
  repo.labelByName.set(name, label);
  return ok(labelJson(label), 201);
}

function handleListLabels(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  return ok(repo.labels.map(labelJson));
}

function labelNamesFromBody(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string') {
      names.push((item as Record<string, unknown>).name as string);
    }
  }
  return names;
}

function handleCreateIssue(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const body = bodyObject(ctx);
  const title = asString(body.title);
  if (title === undefined || title === '') throw unprocessable('title is required');
  const issue = ctx.store.createIssue(repo, title, asString(body.body) ?? '', labelNamesFromBody(body));
  if (issue === null) throw unprocessable('unknown label');
  return ok(issueJson(ctx.store, repo, issue), 201);
}

function handleListIssues(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  const key = (issue: IssueRecord): number => (sort === 'updated' ? issue.updatedSeq : issue.createdSeq);
  issues.sort((a, b) => {
    const diff = key(a) - key(b);
    if (diff !== 0) return direction === 'asc' ? diff : -diff;
    return direction === 'asc' ? a.number - b.number : b.number - a.number;
  });
  const serialized = issues.map((issue) => issueJson(ctx.store, repo, issue));
  const rawPath = `/api/v3/repos/${segments[1]}/${segments[2]}/issues`;
  const { page, headers } = paginate(serialized, ctx, rawPath);
  return ok(page, 200, headers);
}

function handleGetIssue(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  return ok(issueJson(ctx.store, repo, findIssue(repo, segments[4] as string)));
}

function handlePatchIssue(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const issue = findIssue(repo, segments[4] as string);
  const body = bodyObject(ctx);
  const title = asString(body.title);
  if (title !== undefined) issue.title = title;
  const bodyText = asString(body.body);
  if (bodyText !== undefined) issue.body = bodyText;
  const state = asString(body.state);
  if (state === 'open' || state === 'closed') issue.state = state;
  if (body.labels !== undefined) {
    const names = labelNamesFromBody(body);
    const labels: LabelRecord[] = [];
    for (const name of names) {
      const label = repo.labelByName.get(name);
      if (label === undefined) throw unprocessable('unknown label');
      labels.push(label);
    }
    issue.labels = labels;
  }
  issue.updatedSeq = repo.nextSeq();
  return ok(issueJson(ctx.store, repo, issue));
}

function handleCreateComment(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const issue = findIssue(repo, segments[4] as string);
  const body = bodyObject(ctx);
  const text = asString(body.body);
  if (text === undefined) throw unprocessable('body is required');
  const comment = ctx.store.addComment(repo, issue, text);
  return ok(commentJson(ctx.store, comment), 201);
}

function handleListComments(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const issue = findIssue(repo, segments[4] as string);
  const sorted = [...issue.comments].sort((a, b) => a.createdSeq - b.createdSeq);
  return ok(sorted.map((comment) => commentJson(ctx.store, comment)));
}

// ---------------------------------------------------------------------------
// pull requests

function handleCreatePull(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const body = bodyObject(ctx);
  const title = asString(body.title);
  const head = asString(body.head);
  const base = asString(body.base);
  if (title === undefined || title === '' || head === undefined || base === undefined) {
    throw unprocessable('title, head, and base are required');
  }
  const headRef = head.includes(':') ? (head.split(':').pop() as string) : head;
  const pull = ctx.store.createPull(repo, title, asString(body.body) ?? '', headRef, base);
  if (pull === null) throw unprocessable('head or base branch does not exist');
  return ok(pullJson(ctx.store, repo, pull), 201);
}

function handleListPulls(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => a.number - b.number);
  return ok(pulls.map((pull) => pullJson(ctx.store, repo, pull)));
}

function handleGetPull(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  return ok(pullJson(ctx.store, repo, findPull(repo, segments[4] as string)));
}

function handlePullFiles(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const pull = findPull(repo, segments[4] as string);
  return ok(
    pullFiles(repo, pull).map((diff) => ({
      filename: diff.filename,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.changes,
    })),
  );
}

function handleMergePull(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const pull = findPull(repo, segments[4] as string);
  bodyObject(ctx);
  const outcome = mergePullRequest(repo, pull);
  if (!outcome.ok) {
    if (outcome.reason === 'conflict') throw new HttpError(405, 'Pull request cannot be merged: merge conflict');
    throw new HttpError(405, 'Pull request cannot be merged');
  }
  return ok({ sha: outcome.sha, merged: true, message: `${pull.title} (#${pull.number})` });
}

function handleGetCommitsForPull(ctx: RestContext, segments: readonly string[]): JsonResult {
  const repo = resolveRepo(ctx, segments);
  const pull = findPull(repo, segments[4] as string);
  const headTip = repo.branchTip(pull.headRef) ?? pull.headSha;
  const commits = firstParentWalk(repo, headTip, 100).map((sha) => ({
    sha,
    commit: { message: restMessage(repo, sha) },
  }));
  return ok(commits);
}

// ---------------------------------------------------------------------------
// diff helper re-exported for tests: unused here, kept to avoid dead imports.

export function restDiff(repo: RepoState, before: Map<string, FlatEntry>, after: Map<string, FlatEntry>) {
  return diffFlats(repo, before, after);
}

export type { CommentRecord };

// ---------------------------------------------------------------------------
// router

const ROUTES: { method: string; match: (segments: readonly string[]) => boolean; handler: Handler }[] = [
  { method: 'GET', match: (s) => s.length === 0, handler: handleRoot },
  { method: 'GET', match: (s) => s.length === 1 && s[0] === 'meta', handler: handleMeta },
  { method: 'GET', match: (s) => s.length === 1 && s[0] === 'user', handler: handleUser },
  { method: 'POST', match: (s) => s.length === 2 && s[0] === 'user' && s[1] === 'repos', handler: handleCreateRepo },
  { method: 'GET', match: (s) => s.length === 2 && s[0] === 'user' && s[1] === 'repos', handler: handleListRepos },
  { method: 'GET', match: (s) => s.length === 3 && s[0] === 'repos', handler: handleGetRepo },
  { method: 'PATCH', match: (s) => s.length === 3 && s[0] === 'repos', handler: handlePatchRepo },
  { method: 'DELETE', match: (s) => s.length === 3 && s[0] === 'repos', handler: handleDeleteRepo },
  { method: 'POST', match: (s) => s.length === 5 && s[0] === 'repos' && s[3] === 'git' && s[4] === 'refs', handler: handleCreateRef },
  {
    method: 'GET',
    match: (s) => s.length >= 6 && s[0] === 'repos' && s[3] === 'git' && s[4] === 'refs',
    handler: handleGetRef,
  },
  { method: 'GET', match: (s) => s.length === 4 && s[0] === 'repos' && s[3] === 'branches', handler: handleListBranches },
  {
    method: 'GET',
    match: (s) => s.length >= 5 && s[0] === 'repos' && s[3] === 'branches',
    handler: handleGetBranch,
  },
  { method: 'GET', match: (s) => s.length === 4 && s[0] === 'repos' && s[3] === 'commits', handler: handleListCommits },
  {
    method: 'GET',
    match: (s) => s.length >= 4 && s[0] === 'repos' && s[3] === 'contents',
    handler: handleGetContents,
  },
  {
    method: 'PUT',
    match: (s) => s.length >= 5 && s[0] === 'repos' && s[3] === 'contents',
    handler: (ctx) => writeContents(ctx, ctx.segments, 'put'),
  },
  {
    method: 'DELETE',
    match: (s) => s.length >= 5 && s[0] === 'repos' && s[3] === 'contents',
    handler: (ctx) => writeContents(ctx, ctx.segments, 'delete'),
  },
  { method: 'POST', match: (s) => s.length === 4 && s[0] === 'repos' && s[3] === 'labels', handler: handleCreateLabel },
  { method: 'GET', match: (s) => s.length === 4 && s[0] === 'repos' && s[3] === 'labels', handler: handleListLabels },
  { method: 'POST', match: (s) => s.length === 4 && s[0] === 'repos' && s[3] === 'issues', handler: handleCreateIssue },
  { method: 'GET', match: (s) => s.length === 4 && s[0] === 'repos' && s[3] === 'issues', handler: handleListIssues },
  { method: 'GET', match: (s) => s.length === 5 && s[0] === 'repos' && s[3] === 'issues', handler: handleGetIssue },
  { method: 'PATCH', match: (s) => s.length === 5 && s[0] === 'repos' && s[3] === 'issues', handler: handlePatchIssue },
  {
    method: 'POST',
    match: (s) => s.length === 6 && s[0] === 'repos' && s[3] === 'issues' && s[5] === 'comments',
    handler: handleCreateComment,
  },
  {
    method: 'GET',
    match: (s) => s.length === 6 && s[0] === 'repos' && s[3] === 'issues' && s[5] === 'comments',
    handler: handleListComments,
  },
  { method: 'POST', match: (s) => s.length === 4 && s[0] === 'repos' && s[3] === 'pulls', handler: handleCreatePull },
  { method: 'GET', match: (s) => s.length === 4 && s[0] === 'repos' && s[3] === 'pulls', handler: handleListPulls },
  { method: 'GET', match: (s) => s.length === 5 && s[0] === 'repos' && s[3] === 'pulls', handler: handleGetPull },
  {
    method: 'GET',
    match: (s) => s.length === 6 && s[0] === 'repos' && s[3] === 'pulls' && s[5] === 'files',
    handler: handlePullFiles,
  },
  {
    method: 'GET',
    match: (s) => s.length === 6 && s[0] === 'repos' && s[3] === 'pulls' && s[5] === 'commits',
    handler: handleGetCommitsForPull,
  },
  {
    method: 'PUT',
    match: (s) => s.length === 6 && s[0] === 'repos' && s[3] === 'pulls' && s[5] === 'merge',
    handler: handleMergePull,
  },
];

export function handleRest(ctx: RestContext): JsonResult {
  for (const route of ROUTES) {
    if (route.method === ctx.method && route.match(ctx.segments)) return route.handler(ctx, ctx.segments);
  }
  throw notFound('Not Found');
}
