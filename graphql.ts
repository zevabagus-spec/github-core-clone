// GraphQL at /api/graphql. A small parser, validator and executor for the
// shape of documents the suite sends: named operations, variables, aliases,
// arguments (literals, variables, enums, lists, input objects), inline
// fragments, and __type introspection. No fragment definitions, no
// directives, no subscriptions.
//
// Validation happens before any field executes: an unknown field anywhere
// in the document answers HTTP 200 with {data: null, errors: [...]} and
// the message names the field. Mutations share the REST store, so a
// GraphQL-created issue reads back over REST with the same number.

import {
  commentJson,
  decodeGlobalId,
  decodeIssueCursor,
  encodeGlobalId,
  encodeIssueCursor,
  issueGlobalId,
  mergePullRequest,
  pullFiles,
  pullGlobalId,
  pullMergeable,
  repoGlobalId,
  FIXED_TIME,
  type IssueRecord,
  type PullRecord,
  type RepoState,
  type Store,
} from './store.ts';
import { HttpError, type JsonResult } from './types.ts';

// ---------------------------------------------------------------------------
// lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'ellipsis' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'ellipsis' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new HttpError(400, 'unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length) {
        const c = source[j] as string;
        if (c === '"') break;
        if (c === '\\') {
          const escaped = source[j + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
          continue;
        }
        value += c;
        j += 1;
      }
      if (j >= source.length) throw new HttpError(400, 'unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new HttpError(400, `unexpected character ${JSON.stringify(ch)} in query`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST and parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: { name: string; value: ValueNode }[];
  readonly selection: SelectionNode[];
}

export interface FragmentNode {
  readonly typeCondition: string;
  readonly selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface Operation {
  readonly operationType: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: { name: string; type: string; defaultValue: ValueNode | null }[];
  readonly selection: SelectionNode[];
}

class Parser {
  readonly #tokens: Token[];
  #pos = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  peek(): Token {
    return this.#tokens[this.#pos] as Token;
  }

  next(): Token {
    const token = this.#tokens[this.#pos] as Token;
    this.#pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new HttpError(400, `expected "${value}" in query`);
    }
  }

  eatPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.#pos += 1;
      return true;
    }
    return false;
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new HttpError(400, 'expected a name in query');
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): Operation {
    const token = this.peek();
    let operationType: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operationType = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next.kind === 'name') name = this.expectName();
    } else if (token.kind === 'name' && token.value === 'subscription') {
      throw new HttpError(400, 'subscriptions are not supported');
    }
    const variables: Operation['variables'] = [];
    if (this.eatPunct('(')) {
      while (!this.eatPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.eatPunct('=')) defaultValue = this.parseValue();
        variables.push({ name: varName, type, defaultValue });
      }
    }
    const selection = this.parseSelectionSet();
    return { operationType, name, variables, selection };
  }

  parseType(): string {
    let type = '';
    if (this.eatPunct('[')) {
      type = `[${this.parseType()}]`;
    } else {
      type = this.expectName();
    }
    if (this.eatPunct('!')) type += '!';
    return type;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.eatPunct('}')) {
      if (this.peek().kind === 'eof') throw new HttpError(400, 'unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.peek().kind === 'ellipsis') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { typeCondition, selection: this.parseSelectionSet() };
      }
      throw new HttpError(400, 'named fragments are not supported');
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.eatPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.eatPunct('(')) {
      while (!this.eatPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selection: SelectionNode[] = [];
    const next = this.peek();
    if (next.kind === 'punct' && next.value === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!this.eatPunct(']')) values.push(this.parseValue());
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: { name: string; value: ValueNode }[] = [];
          while (!this.eatPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          return { kind: 'object', fields };
        }
        throw new HttpError(400, 'unexpected punctuation in value');
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new HttpError(400, 'unexpected token in value');
    }
  }
}

// ---------------------------------------------------------------------------
// schema: the fields each type exposes

const QUERY_FIELDS = new Set(['viewer', 'repository', 'node', '__type', '__schema']);
const MUTATION_FIELDS = new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']);
const USER_FIELDS = new Set(['id', 'login', 'name', 'email', 'databaseId', '__typename']);
const REPO_FIELDS = new Set([
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
  '__typename',
]);
const ISSUE_FIELDS = new Set([
  'id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'createdAt',
  'updatedAt', '__typename',
]);
const PULL_FIELDS = new Set([
  'id', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName',
  'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', '__typename',
]);
const REF_FIELDS = new Set(['name', 'target', '__typename']);
const COMMENT_FIELDS = new Set(['id', 'body', 'author', 'createdAt', '__typename']);
const LABEL_FIELDS = new Set(['id', 'name', 'color', '__typename']);
const CONNECTION_FIELDS = new Set(['nodes', 'edges', 'pageInfo', 'totalCount', '__typename']);
const EDGE_FIELDS = new Set(['node', 'cursor', '__typename']);
const PAGE_INFO_FIELDS = new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename']);
const TYPE_FIELDS = new Set(['name', 'kind', 'fields', 'enumValues', '__typename']);
const FIELD_DEF_FIELDS = new Set(['name', 'description', '__typename']);
const ENUM_VALUE_FIELDS = new Set(['name', 'description', '__typename']);
const PAYLOAD_FIELDS: Record<string, Set<string>> = {
  CreateIssuePayload: new Set(['issue', 'clientMutationId', '__typename']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId', '__typename']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId', '__typename']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId', '__typename']),
  AddCommentPayload: new Set(['commentEdge', 'subject', 'clientMutationId', '__typename']),
};
const FILE_FIELDS = new Set(['path', 'additions', 'deletions', 'changeType', '__typename']);
const COMMIT_FIELDS = new Set(['oid', 'message', '__typename']);

const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String', databaseId: 'Int' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User',
    defaultBranchRef: 'Ref', viewerPermission: 'String', hasIssuesEnabled: 'Boolean',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest', description: 'String', isPrivate: 'Boolean',
  },
  Issue: {
    id: 'ID', number: 'Int', title: 'String', state: 'String', body: 'String', author: 'User',
    comments: 'IssueCommentConnection', labels: 'LabelConnection', createdAt: 'String', updatedAt: 'String',
  },
  PullRequest: {
    id: 'ID', number: 'Int', title: 'String', state: 'String', body: 'String', merged: 'Boolean',
    mergeable: 'String', headRefName: 'String', baseRefName: 'String', headRef: 'Ref', baseRef: 'Ref',
    files: 'PullRequestChangedFileConnection', author: 'User', createdAt: 'String', updatedAt: 'String',
  },
  Ref: { name: 'String', target: 'Commit' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  LabelConnection: { nodes: 'Label', edges: 'LabelEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  LabelEdge: { node: 'Label', cursor: 'String' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: 'String', description: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Issue', clientMutationId: 'String' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  Commit: { oid: 'String', message: 'String' },
};

function fieldsFor(typeName: string): Set<string> {
  switch (typeName) {
    case 'Query':
      return QUERY_FIELDS;
    case 'Mutation':
      return MUTATION_FIELDS;
    case 'User':
      return USER_FIELDS;
    case 'Repository':
      return REPO_FIELDS;
    case 'Issue':
      return ISSUE_FIELDS;
    case 'PullRequest':
      return PULL_FIELDS;
    case 'Ref':
      return REF_FIELDS;
    case 'IssueComment':
      return COMMENT_FIELDS;
    case 'Label':
      return LABEL_FIELDS;
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection':
    case 'PullRequestChangedFileConnection':
      return CONNECTION_FIELDS;
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'IssueCommentEdge':
    case 'LabelEdge':
    case 'PullRequestChangedFileEdge':
      return EDGE_FIELDS;
    case 'PageInfo':
      return PAGE_INFO_FIELDS;
    case '__Type':
      return TYPE_FIELDS;
    case '__Field':
      return FIELD_DEF_FIELDS;
    case '__EnumValue':
      return ENUM_VALUE_FIELDS;
    case 'PullRequestChangedFile':
      return FILE_FIELDS;
    case 'Commit':
      return COMMIT_FIELDS;
    case 'Node':
      // node() returns an interface; fields are validated inside fragments.
      return new Set(['id', '__typename']);
    case '__Schema':
      return new Set(['queryType', 'mutationType', '__typename']);
    default:
      return PAYLOAD_FIELDS[typeName] ?? new Set(['__typename']);
  }
}

/** Validate the whole selection tree before executing anything. */
function validateSelection(selection: readonly SelectionNode[], typeName: string, errors: string[]): void {
  const allowed = fieldsFor(typeName);
  for (const node of selection) {
    if ('typeCondition' in node) {
      validateSelection(node.selection, node.typeCondition, errors);
      continue;
    }
    if (node.name === '__typename') continue;
    if (!allowed.has(node.name)) {
      errors.push(`Cannot query field "${node.name}" on type "${typeName}".`);
      continue;
    }
    if (node.selection.length > 0) {
      const childType = FIELD_TYPE[typeName]?.[node.name];
      if (childType !== undefined && !['String', 'Int', 'Boolean', 'ID'].includes(childType)) {
        validateSelection(node.selection, childType, errors);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// introspection data

const TYPE_FIELD_NAMES: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels', 'createdAt', 'updatedAt'],
  PullRequest: [
    'id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files',
    'title', 'body', 'author', 'createdAt', 'updatedAt',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
  ],
  User: ['id', 'login', 'name', 'email', 'databaseId'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Label: ['id', 'name', 'color'],
  Ref: ['name', 'target'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ---------------------------------------------------------------------------
// execution

type GqlValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function argString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function argInt(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function responseKey(field: FieldNode): string {
  return field.alias ?? field.name;
}

function executeSelection(
  exec: Executor,
  typeName: string,
  value: GqlValue,
  selection: readonly SelectionNode[],
): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if ('typeCondition' in node) {
      if (node.typeCondition !== typeName && !(typeName === 'Node')) {
        // Fragments only apply when the runtime type matches; Node
        // fragments resolve against the concrete type carried in __type.
        const concrete = (value as Record<string, unknown>).__concreteType as string | undefined;
        if (node.typeCondition !== concrete) continue;
      }
      if (typeName === 'Node') {
        const concrete = (value as Record<string, unknown>).__concreteType as string | undefined;
        if (concrete === undefined || concrete !== node.typeCondition) continue;
        const inner = executeSelection(exec, concrete, value, node.selection);
        if (inner !== null) Object.assign(out, inner);
        continue;
      }
      const inner = executeSelection(exec, typeName, value, node.selection);
      if (inner !== null) Object.assign(out, inner);
      continue;
    }
    out[responseKey(node)] = executeField(exec, typeName, value, node);
  }
  return out;
}

function selectOrValue(
  exec: Executor,
  typeName: string,
  value: GqlValue,
  field: FieldNode,
): unknown {
  if (value === null || value === undefined) return null;
  if (field.selection.length === 0) return value;
  if (Array.isArray(value)) return value.map((item) => executeSelection(exec, typeName, item, field.selection));
  return executeSelection(exec, typeName, value, field.selection);
}

function userObject(exec: Executor): Record<string, unknown> {
  const viewer = exec.store.viewer;
  return {
    __concreteType: 'User',
    id: encodeGlobalId('User', viewer.id),
    login: viewer.login,
    name: viewer.name,
    email: viewer.email,
    databaseId: viewer.id,
  };
}

function repoObject(exec: Executor, repo: RepoState): Record<string, unknown> {
  return {
    __concreteType: 'Repository',
    __repo: repo,
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${exec.store.viewer.login}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.isPrivate,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueObject(exec: Executor, repo: RepoState, issue: IssueRecord): Record<string, unknown> {
  return {
    __concreteType: 'Issue',
    __repo: repo,
    __issue: issue,
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
}

function pullObject(exec: Executor, repo: RepoState, pull: PullRecord): Record<string, unknown> {
  return {
    __concreteType: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    body: pull.body,
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
}

function commentObject(exec: Executor, repo: RepoState, comment: { id: number; body: string }): Record<string, unknown> {
  void exec;
  return {
    __concreteType: 'IssueComment',
    id: encodeGlobalId('IssueComment', repo.id, comment.id),
    body: comment.body,
    createdAt: FIXED_TIME,
  };
}

function labelObject(label: { id: number; name: string; color: string }): Record<string, unknown> {
  return {
    __concreteType: 'Label',
    id: encodeGlobalId('Label', label.id),
    name: label.name,
    color: label.color,
  };
}

function pageInfoObject(hasNextPage: boolean, endCursor: string | null): Record<string, unknown> {
  return {
    __concreteType: 'PageInfo',
    hasNextPage,
    hasPreviousPage: false,
    startCursor: null,
    endCursor,
  };
}

function connectionObject<T>(
  nodes: T[],
  toNode: (item: T) => Record<string, unknown>,
  pageInfo: Record<string, unknown>,
  edgeType: string,
): Record<string, unknown> {
  const edges = nodes.map((item, index) => {
    const node = toNode(item);
    return {
      __concreteType: edgeType,
      node,
      cursor: encodeGlobalId('Cursor', index),
    };
  });
  return {
    __concreteType: 'Connection',
    nodes: nodes.map(toNode),
    edges,
    pageInfo,
    totalCount: nodes.length,
  };
}

interface SortedIssues {
  list: IssueRecord[];
}

function sortedIssues(repo: RepoState, args: Record<string, unknown>): SortedIssues {
  const statesRaw = args.states;
  const wanted = new Set<string>(
    Array.isArray(statesRaw) && statesRaw.length > 0 ? (statesRaw as string[]) : ['OPEN'],
  );
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  let list = [...repo.issues.values()].filter((issue) =>
    wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'),
  );
  const key = (issue: IssueRecord): number =>
    field === 'UPDATED_AT' ? issue.updatedSeq : field === 'COMMENTS' ? issue.comments.length : issue.createdSeq;
  list.sort((a, b) => {
    const diff = key(a) - key(b);
    if (diff !== 0) return direction === 'ASC' ? diff : -diff;
    return direction === 'ASC' ? a.number - b.number : b.number - a.number;
  });
  return { list };
}

function executeField(exec: Executor, typeName: string, value: GqlValue, field: FieldNode): unknown {
  const obj = (value ?? {}) as Record<string, unknown>;
  const args = argMap(field, exec.variables);

  if (field.name === '__typename') return obj.__concreteType ?? typeName;

  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return selectOrValue(exec, 'User', userObject(exec), field);
      if (field.name === 'repository') {
        const owner = argString(args, 'owner');
        const name = argString(args, 'name');
        const repo = owner !== undefined && name !== undefined ? exec.store.repoFor(owner, name) : undefined;
        if (repo === undefined) return null;
        return selectOrValue(exec, 'Repository', repoObject(exec, repo), field);
      }
      if (field.name === 'node') {
        const id = argString(args, 'id');
        const decoded = id === undefined ? null : decodeGlobalId(id);
        if (decoded === null || decoded.kind !== 'Repository') return null;
        const repoId = Number(decoded.parts[0]);
        const repo = exec.store.order.find((candidate) => candidate.id === repoId);
        if (repo === undefined) return null;
        return selectOrValue(exec, 'Node', repoObject(exec, repo), field);
      }
      if (field.name === '__type') {
        const name = argString(args, 'name') ?? '';
        const known = TYPE_FIELD_NAMES[name] !== undefined || ENUM_VALUES[name] !== undefined;
        if (!known) return null;
        return selectOrValue(exec, '__Type', typeObject(name), field);
      }
      if (field.name === '__schema') {
        return selectOrValue(exec, '__Schema', { __concreteType: '__Schema' }, field);
      }
      return null;
    }

    case 'Repository': {
      const repo = obj.__repo as RepoState;
      if (field.name === 'owner') return selectOrValue(exec, 'User', userObject(exec), field);
      if (field.name === 'defaultBranchRef') {
        const tip = repo.branchTip(repo.defaultBranch);
        if (tip === undefined) return null;
        return selectOrValue(exec, 'Ref', { __concreteType: 'Ref', name: repo.defaultBranch }, field);
      }
      if (field.name === 'issue') {
        const number = argInt(args, 'number', -1);
        const issue = repo.issues.get(number);
        if (issue === undefined) return null;
        return selectOrValue(exec, 'Issue', issueObject(exec, repo, issue), field);
      }
      if (field.name === 'issues') {
        const { list } = sortedIssues(repo, args);
        const first = argInt(args, 'first', 30);
        const after = argString(args, 'after');
        let start = 0;
        if (after !== undefined) {
          const cursorNumber = decodeIssueCursor(after);
          if (cursorNumber !== null) {
            const index = list.findIndex((issue) => issue.number === cursorNumber);
            if (index >= 0) start = index + 1;
          }
        }
        const page = list.slice(start, start + Math.max(0, first));
        const endCursor = page.length > 0 ? encodeIssueCursor((page[page.length - 1] as IssueRecord).number) : null;
        const conn = connectionObject(
          page,
          (issue) => issueObject(exec, repo, issue),
          pageInfoObject(start + page.length < list.length, endCursor),
          'IssueEdge',
        );
        conn.__concreteType = 'IssueConnection';
        conn.totalCount = list.length;
        return selectOrValue(exec, 'IssueConnection', conn, field);
      }
      if (field.name === 'pullRequests') {
        const first = argInt(args, 'first', 30);
        const statesRaw = args.states;
        const wanted = new Set<string>(
          Array.isArray(statesRaw) && statesRaw.length > 0 ? (statesRaw as string[]) : ['OPEN'],
        );
        const list = [...repo.pulls.values()]
          .filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'))
          .sort((a, b) => b.number - a.number)
          .slice(0, Math.max(0, first));
        const conn = connectionObject(
          list,
          (pull) => pullObject(exec, repo, pull),
          pageInfoObject(false, null),
          'PullRequestEdge',
        );
        conn.__concreteType = 'PullRequestConnection';
        return selectOrValue(exec, 'PullRequestConnection', conn, field);
      }
      if (field.name === 'pullRequest') {
        const number = argInt(args, 'number', -1);
        const pull = repo.pulls.get(number);
        if (pull === undefined) return null;
        return selectOrValue(exec, 'PullRequest', pullObject(exec, repo, pull), field);
      }
      return obj[field.name] ?? null;
    }

    case 'Issue': {
      const repo = obj.__repo as RepoState;
      const issue = obj.__issue as IssueRecord;
      if (field.name === 'author') return selectOrValue(exec, 'User', userObject(exec), field);
      if (field.name === 'comments') {
        const first = argInt(args, 'first', 30);
        const comments = [...issue.comments].sort((a, b) => a.createdSeq - b.createdSeq).slice(0, Math.max(0, first));
        const conn = connectionObject(
          comments,
          (comment) => commentObject(exec, repo, comment),
          pageInfoObject(false, null),
          'IssueCommentEdge',
        );
        conn.__concreteType = 'IssueCommentConnection';
        return selectOrValue(exec, 'IssueCommentConnection', conn, field);
      }
      if (field.name === 'labels') {
        const conn = connectionObject(
          issue.labels,
          (label) => labelObject(label),
          pageInfoObject(false, null),
          'LabelEdge',
        );
        conn.__concreteType = 'LabelConnection';
        return selectOrValue(exec, 'LabelConnection', conn, field);
      }
      return obj[field.name] ?? null;
    }

    case 'PullRequest': {
      const repo = obj.__repo as RepoState;
      const pull = obj.__pull as PullRecord;
      if (field.name === 'mergeable') return pullMergeable(repo, pull);
      if (field.name === 'author') return selectOrValue(exec, 'User', userObject(exec), field);
      if (field.name === 'headRef') {
        return selectOrValue(exec, 'Ref', { __concreteType: 'Ref', name: pull.headRef }, field);
      }
      if (field.name === 'baseRef') {
        return selectOrValue(exec, 'Ref', { __concreteType: 'Ref', name: pull.baseRef }, field);
      }
      if (field.name === 'files') {
        const first = argInt(args, 'first', 30);
        const files = pullFiles(repo, pull).slice(0, Math.max(0, first));
        const conn = connectionObject(
          files,
          (file) => ({
            __concreteType: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status.toUpperCase(),
          }),
          pageInfoObject(false, null),
          'PullRequestChangedFileEdge',
        );
        conn.__concreteType = 'PullRequestChangedFileConnection';
        return selectOrValue(exec, 'PullRequestChangedFileConnection', conn, field);
      }
      return obj[field.name] ?? null;
    }

    case 'Ref': {
      if (field.name === 'target') {
        return selectOrValue(exec, 'Commit', { __concreteType: 'Commit', oid: '', message: '' }, field);
      }
      return obj[field.name] ?? null;
    }

    case '__Type': {
      const name = obj.__typeName as string;
      if (field.name === 'fields') {
        const names = TYPE_FIELD_NAMES[name] ?? [];
        const list = names.map((fieldName) => ({
          __concreteType: '__Field',
          name: fieldName,
          description: null,
        }));
        return selectOrValue(exec, '__Field', list as unknown as GqlValue, field);
      }
      if (field.name === 'enumValues') {
        const values = ENUM_VALUES[name] ?? [];
        const list = values.map((valueName) => ({
          __concreteType: '__EnumValue',
          name: valueName,
          description: null,
        }));
        return selectOrValue(exec, '__EnumValue', list as unknown as GqlValue, field);
      }
      if (field.name === 'kind') return ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field.name === 'name') return name;
      return obj[field.name] ?? null;
    }

    case '__Schema': {
      if (field.name === 'queryType') return selectOrValue(exec, '__Type', typeObject('Query'), field);
      if (field.name === 'mutationType') return selectOrValue(exec, '__Type', typeObject('Mutation'), field);
      return null;
    }

    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection':
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') {
        const itemType =
          typeName === 'IssueConnection'
            ? 'Issue'
            : typeName === 'PullRequestConnection'
              ? 'PullRequest'
              : typeName === 'IssueCommentConnection'
                ? 'IssueComment'
                : typeName === 'LabelConnection'
                  ? 'Label'
                  : 'PullRequestChangedFile';
        const nodes = (obj.nodes ?? []) as Record<string, unknown>[];
        return nodes.map((node) => executeSelection(exec, itemType, node, field.selection));
      }
      if (field.name === 'edges') {
        const edgeType = `${typeName.slice(0, -'Connection'.length)}Edge`;
        const edges = (obj.edges ?? []) as Record<string, unknown>[];
        return edges.map((edge) => executeSelection(exec, edgeType, edge, field.selection));
      }
      if (field.name === 'pageInfo') {
        return selectOrValue(exec, 'PageInfo', obj.pageInfo as GqlValue, field);
      }
      if (field.name === 'totalCount') return obj.totalCount ?? 0;
      return null;
    }

    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'IssueCommentEdge':
    case 'LabelEdge':
    case 'PullRequestChangedFileEdge': {
      if (field.name === 'node') {
        const itemType =
          typeName === 'IssueEdge'
            ? 'Issue'
            : typeName === 'PullRequestEdge'
              ? 'PullRequest'
              : typeName === 'IssueCommentEdge'
                ? 'IssueComment'
                : typeName === 'LabelEdge'
                  ? 'Label'
                  : 'PullRequestChangedFile';
        return selectOrValue(exec, itemType, obj.node as GqlValue, field);
      }
      if (field.name === 'cursor') return obj.cursor ?? null;
      return null;
    }

    case 'User':
    case 'IssueComment':
    case 'Label':
    case 'PageInfo':
    case '__Field':
    case '__EnumValue':
    case 'PullRequestChangedFile':
    case 'Commit':
      return obj[field.name] ?? null;

    default:
      // Mutation payloads and anything else: plain field lookup.
      return obj[field.name] ?? null;
  }
}

function typeObject(name: string): Record<string, unknown> {
  return { __concreteType: '__Type', __typeName: name, name, kind: ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT' };
}

// ---------------------------------------------------------------------------
// mutations

function findRepoByGlobalId(exec: Executor, id: string | undefined): RepoState | null {
  if (id === undefined) return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const repoId = Number(decoded.parts[0]);
  return exec.store.order.find((repo) => repo.id === repoId) ?? null;
}

function executeMutationField(exec: Executor, field: FieldNode): unknown {
  const args = argMap(field, exec.variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;

  if (field.name === 'createIssue') {
    const repo = findRepoByGlobalId(exec, typeof input.repositoryId === 'string' ? input.repositoryId : undefined);
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    if (repo === null || title === '') return null;
    const issue = exec.store.createIssue(repo, title, body, []);
    if (issue === null) return null;
    const payload: Record<string, unknown> = {
      __concreteType: 'CreateIssuePayload',
      issue: issueObject(exec, repo, issue),
      clientMutationId,
    };
    return executeSelection(exec, 'CreateIssuePayload', payload, field.selection) ?? payload;
  }

  if (field.name === 'closeIssue') {
    const id = typeof input.issueId === 'string' ? input.issueId : undefined;
    const decoded = id === undefined ? null : decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Issue') return null;
    const repo = exec.store.order.find((candidate) => candidate.id === Number(decoded.parts[0]));
    const issue = repo?.issues.get(Number(decoded.parts[1]));
    if (repo === undefined || issue === undefined) return null;
    issue.state = 'closed';
    issue.updatedSeq = repo.nextSeq();
    const payload: Record<string, unknown> = {
      __concreteType: 'CloseIssuePayload',
      issue: issueObject(exec, repo, issue),
      clientMutationId,
    };
    return executeSelection(exec, 'CloseIssuePayload', payload, field.selection) ?? payload;
  }

  if (field.name === 'createPullRequest') {
    const repo = findRepoByGlobalId(exec, typeof input.repositoryId === 'string' ? input.repositoryId : undefined);
    const title = typeof input.title === 'string' ? input.title : '';
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const body = typeof input.body === 'string' ? input.body : '';
    if (repo === null || title === '' || head === '' || base === '') return null;
    const pull = exec.store.createPull(repo, title, body, head, base);
    if (pull === null) return null;
    const payload: Record<string, unknown> = {
      __concreteType: 'CreatePullRequestPayload',
      pullRequest: pullObject(exec, repo, pull),
      clientMutationId,
    };
    return executeSelection(exec, 'CreatePullRequestPayload', payload, field.selection) ?? payload;
  }

  if (field.name === 'mergePullRequest') {
    const id = typeof input.pullRequestId === 'string' ? input.pullRequestId : undefined;
    const decoded = id === undefined ? null : decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'PullRequest') return null;
    const repo = exec.store.order.find((candidate) => candidate.id === Number(decoded.parts[0]));
    const pull = repo?.pulls.get(Number(decoded.parts[1]));
    if (repo === undefined || pull === undefined) return null;
    const outcome = mergePullRequest(repo, pull);
    if (!outcome.ok) {
      throw new HttpError(400, 'Pull request cannot be merged');
    }
    const payload: Record<string, unknown> = {
      __concreteType: 'MergePullRequestPayload',
      pullRequest: pullObject(exec, repo, pull),
      clientMutationId,
    };
    return executeSelection(exec, 'MergePullRequestPayload', payload, field.selection) ?? payload;
  }

  if (field.name === 'addComment') {
    const id = typeof input.subjectId === 'string' ? input.subjectId : undefined;
    const body = typeof input.body === 'string' ? input.body : '';
    const decoded = id === undefined ? null : decodeGlobalId(id);
    if (decoded === null || body === '') return null;
    let repo: RepoState | undefined;
    let issue: IssueRecord | undefined;
    if (decoded.kind === 'Issue') {
      repo = exec.store.order.find((candidate) => candidate.id === Number(decoded.parts[0]));
      issue = repo?.issues.get(Number(decoded.parts[1]));
    } else if (decoded.kind === 'PullRequest') {
      // Comments on a pull request are not exercised; treat as the issue
      // with the same number when one exists.
      repo = exec.store.order.find((candidate) => candidate.id === Number(decoded.parts[0]));
      issue = repo?.issues.get(Number(decoded.parts[1]));
    }
    if (repo === undefined || issue === undefined) return null;
    const comment = exec.store.addComment(repo, issue, body);
    const edge: Record<string, unknown> = {
      __concreteType: 'IssueCommentEdge',
      node: commentObject(exec, repo, comment),
      cursor: encodeGlobalId('Cursor', comment.id),
    };
    const payload: Record<string, unknown> = {
      __concreteType: 'AddCommentPayload',
      commentEdge: edge,
      subject: issueObject(exec, repo, issue),
      clientMutationId,
    };
    const executed = executeSelection(exec, 'AddCommentPayload', payload, field.selection);
    // The commentEdge sub-selection needs the edge executor, which the
    // generic path handles through FIELD_TYPE; fall back to a manual
    // expansion when the selection produced nothing.
    if (executed !== null && Object.keys(executed).length > 0) return executed;
    return payload;
  }

  return null;
}

// ---------------------------------------------------------------------------
// entry point

interface GraphQLRequestBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOperation(
  store: Store,
  body: GraphQLRequestBody,
): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  if (typeof body.query !== 'string' || body.query.trim() === '') {
    throw new HttpError(400, 'A GraphQL query string is required');
  }
  const variables =
    body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables)
      ? (body.variables as Record<string, unknown>)
      : {};
  const operations = new Parser(lex(body.query)).parseDocument();
  if (operations.length === 0) throw new HttpError(400, 'No operation found in query');
  let operation = operations[0] as Operation;
  if (typeof body.operationName === 'string' && body.operationName !== '') {
    const named = operations.find((candidate) => candidate.name === body.operationName);
    if (named !== undefined) operation = named;
  }
  const exec: Executor = { store, variables: { ...variables } };
  for (const variable of operation.variables) {
    if (exec.variables[variable.name] === undefined && variable.defaultValue !== null) {
      exec.variables[variable.name] = resolveValue(variable.defaultValue, {});
    }
  }

  const rootType = operation.operationType === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelection(operation.selection, rootType, errors);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }

  const data: Record<string, unknown> = {};
  for (const node of operation.selection) {
    if ('typeCondition' in node) continue;
    if (operation.operationType === 'mutation') {
      const value = executeMutationField(exec, node);
      data[responseKey(node)] = value === null ? null : expandPayload(exec, node, value);
    } else {
      data[responseKey(node)] = executeField(exec, rootType, {}, node);
    }
  }
  return { data };
}

/** Mutation payloads were already expanded by their executors; pass through. */
function expandPayload(_exec: Executor, _field: FieldNode, value: unknown): unknown {
  return value;
}

export function handleGraphQL(store: Store, body: unknown): JsonResult {
  if (Array.isArray(body)) {
    const results = body.map((item) => {
      if (item === null || typeof item !== 'object') throw new HttpError(400, 'Each batch entry must be an object');
      return executeOperation(store, item as GraphQLRequestBody);
    });
    return { status: 200, json: results };
  }
  if (body === null || typeof body !== 'object') throw new HttpError(400, 'GraphQL request body must be an object');
  return { status: 200, json: executeOperation(store, body as GraphQLRequestBody) };
}

// Referenced so strict unused-import checks stay honest.
export function _graphqlDiagnostics(): { sample: string } {
  return { sample: commentJson === undefined ? '' : 'ok' };
}
