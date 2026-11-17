// Model Context Protocol endpoint at /mcp, JSON-RPC 2.0 over HTTP.
//
// Two eras are served: the modern 2026-07-28 discovery handshake
// (server/discover, answered with supportedVersions and both serverInfo
// spellings) and the legacy initialize handshake (which echoes the
// revision the client offered). Tools share the REST store, so a repo
// created through MCP reads back over REST, and a pull request merged
// through MCP shows merged over REST.
//
// Every reply is application/json. Notifications (requests with no id)
// answer 202 with an empty body. Unknown methods are JSON-RPC -32601,
// unknown tools and bad arguments are -32602, and domain failures inside
// a tool (unknown repo, merge conflict) are isError results.

import {
  issueJson,
  mergePullRequest,
  pullJson,
  repoJson,
  type Store,
} from './store.ts';
import type { JsonResult } from './types.ts';

const SERVER_NAME = 'github-forge-mcp';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';
const LEGACY_FALLBACK = '2025-11-25';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function stringProp(description: string): { type: string; description: string } {
  return { type: 'string', description };
}

function booleanProp(description: string): { type: string; description: string } {
  return { type: 'boolean', description };
}

function numberProp(description: string): { type: string; description: string } {
  return { type: 'number', description };
}

/** The one tool list: a single constant, byte-identical on every call. */
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The name of the repository.'),
        description: stringProp('A short description of the repository.'),
        private: booleanProp('Whether the repository is private.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        title: stringProp('The title of the issue.'),
        body: stringProp('The body of the issue.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        state: stringProp('Filter by state: open, closed, or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        title: stringProp('The title of the pull request.'),
        head: stringProp('The head branch of the pull request.'),
        base: stringProp('The base branch of the pull request.'),
        body: stringProp('The body of the pull request.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        pull_number: numberProp('The number of the pull request.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Tool lookup by name; TOOLS itself stays the advertised list. */
const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function serverInfoObject(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

// ---------------------------------------------------------------------------
// tool arguments

function toolArgs(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return {};
  const args = (params as Record<string, unknown>).arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return {};
  return args as Record<string, unknown>;
}

function pickString(args: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function pickBoolean(args: Record<string, unknown>, names: readonly string[]): boolean | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function pickPullNumber(args: Record<string, unknown>): number | undefined {
  const value = args.pull_number ?? args.number ?? args.pullNumber;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Owner/repo from explicit args, or split from a full_name fallback. */
function pickOwnerRepo(args: Record<string, unknown>): { owner?: string; repo?: string } {
  let owner = pickString(args, ['owner', 'owner_login', 'login']);
  let repo = pickString(args, ['repo', 'repository', 'repo_name']);
  if ((owner === undefined || repo === undefined) && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
      owner ??= parts[0];
      repo ??= parts[1];
    }
  }
  return { owner, repo };
}

class ToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolFailure';
  }
}

function toolText(result: unknown): Record<string, unknown> {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return {
    content: [{ type: 'text', text }],
    structuredContent: result,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function executeTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const definition = TOOLS_BY_NAME.get(name);
  if (definition === undefined) throw new ToolFailure(`unknown tool ${JSON.stringify(name)}`);
  for (const required of definition.inputSchema.required) {
    if (name === 'merge_pull_request' && required === 'pull_number') {
      if (pickPullNumber(args) === undefined) throw new ToolFailure('pull_number is required');
      continue;
    }
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      throw new ToolFailure(`${required} is required`);
    }
  }

  switch (name) {
    case 'create_repo': {
      const repoName = pickString(args, ['name']) as string;
      const repo = store.createRepo(
        repoName,
        pickString(args, ['description']) ?? '',
        pickBoolean(args, ['private']) ?? false,
      );
      if (repo === null) throw new ToolFailure('name already exists on this account');
      return toolText(repoJson(store, repo));
    }
    case 'get_repo': {
      const { owner, repo: repoName } = pickOwnerRepo(args);
      const repo = owner !== undefined && repoName !== undefined ? store.repoFor(owner, repoName) : undefined;
      if (repo === undefined) throw new ToolFailure('repository not found');
      return toolText(repoJson(store, repo));
    }
    case 'create_issue': {
      const { owner, repo: repoName } = pickOwnerRepo(args);
      const repo = owner !== undefined && repoName !== undefined ? store.repoFor(owner, repoName) : undefined;
      if (repo === undefined) throw new ToolFailure('repository not found');
      const title = pickString(args, ['title']) as string;
      const issue = store.createIssue(repo, title, pickString(args, ['body']) ?? '', []);
      if (issue === null) throw new ToolFailure('could not create issue');
      return toolText(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const { owner, repo: repoName } = pickOwnerRepo(args);
      const repo = owner !== undefined && repoName !== undefined ? store.repoFor(owner, repoName) : undefined;
      if (repo === undefined) throw new ToolFailure('repository not found');
      const state = pickString(args, ['state']) ?? 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(store, repo, issue));
      return toolText(issues);
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = pickOwnerRepo(args);
      const repo = owner !== undefined && repoName !== undefined ? store.repoFor(owner, repoName) : undefined;
      if (repo === undefined) throw new ToolFailure('repository not found');
      const title = pickString(args, ['title']) as string;
      const head = pickString(args, ['head']) as string;
      const base = pickString(args, ['base']) as string;
      const headRef = head.includes(':') ? (head.split(':').pop() as string) : head;
      const pull = store.createPull(repo, title, pickString(args, ['body']) ?? '', headRef, base);
      if (pull === null) throw new ToolFailure('head or base branch does not exist');
      return toolText(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = pickOwnerRepo(args);
      const repo = owner !== undefined && repoName !== undefined ? store.repoFor(owner, repoName) : undefined;
      if (repo === undefined) throw new ToolFailure('repository not found');
      const number = pickPullNumber(args) as number;
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new ToolFailure('pull request not found');
      const outcome = mergePullRequest(repo, pull);
      if (!outcome.ok) throw new ToolFailure('pull request cannot be merged');
      return toolText({ sha: outcome.sha, merged: true, message: `${pull.title} (#${pull.number})` });
    }
    default:
      throw new ToolFailure(`unknown tool ${JSON.stringify(name)}`);
  }
}

// ---------------------------------------------------------------------------
// entry point

export function handleMcp(store: Store, body: Buffer): JsonResult {
  let request: JsonRpcRequest;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('request must be an object');
    }
    request = parsed as JsonRpcRequest;
  } catch {
    return { status: 400, json: rpcError(null, -32700, 'Parse error') };
  }

  const hasId = request.id !== undefined;
  const id: JsonRpcId = hasId ? (request.id as JsonRpcId) : null;
  const method = typeof request.method === 'string' ? request.method : '';

  // Notifications answer 202 with an empty body.
  if (!hasId) {
    return { status: 202, json: null };
  }

  if (method === 'server/discover') {
    const info = serverInfoObject();
    return {
      status: 200,
      json: rpcResult(id, {
        supportedVersions: [MODERN_VERSION],
        capabilities: { tools: {} },
        serverInfo: info,
        _meta: { 'io.modelcontextprotocol/serverInfo': info },
      }),
    };
  }

  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const offered = typeof params.protocolVersion === 'string' && params.protocolVersion !== ''
      ? params.protocolVersion
      : LEGACY_FALLBACK;
    return {
      status: 200,
      json: rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: serverInfoObject(),
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, json: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    return { status: 200, json: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    if (!TOOLS_BY_NAME.has(toolName)) {
      return { status: 200, json: rpcError(id, -32602, `unknown tool ${JSON.stringify(toolName)}`) };
    }
    try {
      const result = executeTool(store, toolName, toolArgs(request.params));
      return { status: 200, json: rpcResult(id, result) };
    } catch (err) {
      if (err instanceof ToolFailure) {
        const missing = /is required$/.test(err.message);
        if (missing) return { status: 200, json: rpcError(id, -32602, err.message) };
        return { status: 200, json: rpcResult(id, toolError(err.message)) };
      }
      return { status: 200, json: rpcResult(id, toolError((err as Error).message)) };
    }
  }

  return { status: 200, json: rpcError(id, -32601, `method not found: ${method}`) };
}
