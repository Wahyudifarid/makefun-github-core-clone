// GitHub GraphQL v4: a small parser and executor for exactly the documents gh and
// github-mcp-server send. No schema library; the field lists are the ones the suite
// feature-detects.
import {
  addCommentOnRepo,
  createIssueOnRepo,
  createPullOnRepo,
  mergePullOnRepo,
  pullFilesOf,
  pullMergeable,
} from './rest.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// global ids: opaque base64, stable across reads, never the plain database id or number
// -------------------------------------------------------------------------------------------

export function gid(kind: string, payload: string): string {
  return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64');
}

function parseGid(id: string): { kind: string; payload: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), payload: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return gid('repo', `${repo.owner}/${repo.name}`);
}

function issueGid(repo: Repo, issue: Issue): string {
  return gid('issue', `${repo.owner}/${repo.name}/${issue.number}`);
}

function pullGid(repo: Repo, pull: Pull): string {
  return gid('pr', `${repo.owner}/${repo.name}/${pull.number}`);
}

function commentGid(repo: Repo, issue: Issue, commentId: number): string {
  return gid('comment', `${repo.owner}/${repo.name}/${issue.number}/${commentId}`);
}

function decodeRepoId(store: Store, id: string): Repo | undefined {
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'repo') return undefined;
  const slash = parsed.payload.indexOf('/');
  if (slash < 0) return undefined;
  return store.getRepo(parsed.payload.slice(0, slash), parsed.payload.slice(slash + 1));
}

function decodeIssueId(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'issue') return undefined;
  const parts = parsed.payload.split('/');
  if (parts.length !== 3) return undefined;
  const repo = store.getRepo(parts[0] as string, parts[1] as string);
  if (repo === undefined) return undefined;
  const issue = repo.issues.find((entry) => entry.number === Number(parts[2]));
  return issue === undefined ? undefined : { repo, issue };
}

function decodePullId(store: Store, id: string): { repo: Repo; pull: Pull } | undefined {
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'pr') return undefined;
  const parts = parsed.payload.split('/');
  if (parts.length !== 3) return undefined;
  const repo = store.getRepo(parts[0] as string, parts[1] as string);
  if (repo === undefined) return undefined;
  const pull = repo.pulls.find((entry) => entry.number === Number(parts[2]));
  return pull === undefined ? undefined : { repo, pull };
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selection: SelectionNode[];
}

class ParseError extends Error {}

class Parser {
  private readonly text: string;
  private pos = 0;
  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos] as string)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipIgnored();
    return this.text.slice(this.pos, this.pos + 3);
  }

  private expect(word: string): void {
    this.skipIgnored();
    if (!this.text.startsWith(word, this.pos)) throw new ParseError(`expected ${JSON.stringify(word)} at ${this.pos}`);
    this.pos += word.length;
  }

  private readName(): string {
    this.skipIgnored();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (match === null) throw new ParseError(`expected a name at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  private readString(): string {
    this.skipIgnored();
    if (this.text[this.pos] !== '"') throw new ParseError(`expected a string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) throw new ParseError('unterminated string');
      const ch = this.text[this.pos] as string;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const next = this.text[this.pos + 1] as string;
        const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (next === 'u') {
          out += String.fromCharCode(parseInt(this.text.slice(this.pos + 2, this.pos + 6), 16));
          this.pos += 6;
        } else if (next in escapes) {
          out += escapes[next] as string;
          this.pos += 2;
        } else {
          throw new ParseError(`bad escape \\${next}`);
        }
        continue;
      }
      out += ch;
      this.pos += 1;
    }
  }

  private readValue(): ValueNode {
    this.skipIgnored();
    const ch = this.text[this.pos] as string;
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      for (;;) {
        this.skipIgnored();
        if (this.text[this.pos] === ']') {
          this.pos += 1;
          return { kind: 'list', values };
        }
        values.push(this.readValue());
      }
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Record<string, ValueNode> = {};
      for (;;) {
        this.skipIgnored();
        if (this.text[this.pos] === '}') {
          this.pos += 1;
          return { kind: 'object', fields };
        }
        const name = this.readName();
        this.expect(':');
        fields[name] = this.readValue();
      }
    }
    const num = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.pos));
    if (num !== null && (num[0].startsWith('-') || /[0-9]/.test(num[0][0] as string))) {
      this.pos += num[0].length;
      if (num[0].includes('.') || /[eE]/.test(num[0])) return { kind: 'float', value: parseFloat(num[0]) };
      return { kind: 'int', value: parseInt(num[0], 10) };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  /** Skip a variable type: Named, [Named], Named!, [Named!]!, ... */
  private skipType(): void {
    this.skipIgnored();
    if (this.text[this.pos] === '[') {
      this.pos += 1;
      this.skipType();
      this.expect(']');
    } else {
      this.readName();
    }
    this.skipIgnored();
    if (this.text[this.pos] === '!') this.pos += 1;
  }

  private readArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.skipIgnored();
    if (this.text[this.pos] !== '(') return args;
    this.pos += 1;
    for (;;) {
      this.skipIgnored();
      if (this.text[this.pos] === ')') {
        this.pos += 1;
        return args;
      }
      const name = this.readName();
      this.expect(':');
      args[name] = this.readValue();
    }
  }

  private readSelection(): SelectionNode[] {
    this.expect('{');
    const nodes: SelectionNode[] = [];
    for (;;) {
      this.skipIgnored();
      if (this.text[this.pos] === '}') {
        this.pos += 1;
        return nodes;
      }
      if (this.text.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipIgnored();
        let typeCondition: string | null = null;
        if (this.text.startsWith('on', this.pos) && /[\s]/.test(this.text[this.pos + 2] ?? '')) {
          this.pos += 2;
          typeCondition = this.readName();
        } else {
          // A fragment spread names a fragment; this executor does not support named fragments.
          const spreadName = this.readName();
          throw new ParseError(`named fragment spread ...${spreadName} is not supported`);
        }
        nodes.push({ kind: 'fragment', typeCondition, selection: this.readSelection() });
        continue;
      }
      const first = this.readName();
      let alias: string | null = null;
      let name = first;
      this.skipIgnored();
      if (this.text[this.pos] === ':') {
        this.pos += 1;
        alias = first;
        name = this.readName();
      }
      const args = this.readArguments();
      this.skipIgnored();
      const selection = this.text[this.pos] === '{' ? this.readSelection() : null;
      nodes.push({ kind: 'field', alias, name, args, selection });
    }
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    for (;;) {
      this.skipIgnored();
      if (this.pos >= this.text.length) break;
      if (this.text[this.pos] === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selection: this.readSelection() });
        continue;
      }
      const keyword = this.readName();
      if (keyword !== 'query' && keyword !== 'mutation') throw new ParseError(`expected query or mutation, got ${keyword}`);
      this.skipIgnored();
      let name: string | null = null;
      if (/[A-Za-z_]/.test(this.text[this.pos] ?? '')) name = this.readName();
      const variables: string[] = [];
      this.skipIgnored();
      if (this.text[this.pos] === '(') {
        this.pos += 1;
        for (;;) {
          this.skipIgnored();
          if (this.text[this.pos] === ')') {
            this.pos += 1;
            break;
          }
          this.expect('$');
          variables.push(this.readName());
          this.expect(':');
          this.skipType();
          this.skipIgnored();
          if (this.text[this.pos] === '=') {
            this.pos += 1;
            this.readValue();
          }
        }
      }
      operations.push({ kind: keyword, name, variables, selection: this.readSelection() });
    }
    return operations;
  }
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

type JsonValue = unknown;

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
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
      return node.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node.fields)) out[key] = valueOf(entry, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(field.args)) out[key] = valueOf(node, ctx.variables);
  return out;
}

/** A resolved node: its type name and the record its fields read from. */
interface NodeValue {
  __typename: string;
  record: Record<string, unknown>;
}

function isNode(value: unknown): value is NodeValue {
  return typeof value === 'object' && value !== null && '__typename' in value && 'record' in value;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'labels', 'comments'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'mergeCommit'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'];
const USER_FIELDS = ['id', 'login', 'name', 'email'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

function typeInfo(name: string): { fields: string[]; enumValues: string[] } | null {
  switch (name) {
    case 'Issue':
      return { fields: ISSUE_FIELDS, enumValues: [] };
    case 'PullRequest':
      return { fields: PULL_REQUEST_FIELDS, enumValues: [] };
    case 'Repository':
      return { fields: REPOSITORY_FIELDS, enumValues: [] };
    case 'User':
      return { fields: USER_FIELDS, enumValues: [] };
    case 'SearchType':
      return { fields: [], enumValues: SEARCH_TYPE_VALUES };
    case 'IssueState':
      return { fields: [], enumValues: ['OPEN', 'CLOSED'] };
    case 'PullRequestState':
      return { fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] };
    case 'MergeableState':
      return { fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] };
    case 'RepositoryPermission':
      return { fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] };
    case 'IssueOrderField':
      return { fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] };
    case 'OrderDirection':
      return { fields: [], enumValues: ['ASC', 'DESC'] };
    case 'PullRequestMergeMethod':
      return { fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] };
    default:
      return null;
  }
}

function userNode(): NodeValue {
  return { __typename: 'User', record: { login: VIEWER_LOGIN, id: String(VIEWER_ID), name: 'ada iversen', email: 'adaiversen@example.invalid' } };
}

function repoNode(repo: Repo): NodeValue {
  return { __typename: 'Repository', record: { __repo: repo } };
}

function issueNode(repo: Repo, issue: Issue): NodeValue {
  return { __typename: 'Issue', record: { __repo: repo, __issue: issue } };
}

function pullNode(repo: Repo, pull: Pull): NodeValue {
  return { __typename: 'PullRequest', record: { __repo: repo, __pull: pull } };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeCursor(number: number): string {
  return Buffer.from(`issue-cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('issue-cursor:')) return null;
    const n = parseInt(text.slice('issue-cursor:'.length), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
  const statesRaw = args.states;
  const states: string[] | null = Array.isArray(statesRaw) ? statesRaw.map((entry) => String(entry)) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  let list = repo.issues.filter((issue) => {
    if (states === null) return true;
    return states.includes(issueState(issue));
  });
  // CREATED_AT (and every other order field the suite sends) orders by creation.
  list = [...list].sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  if (after !== null) {
    const index = list.findIndex((issue) => issue.number === after);
    if (index >= 0) list = list.slice(index + 1);
  }
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
  return {
    __typename: 'IssueConnection',
    record: {
      __nodes: page.map((issue) => issueNode(repo, issue)),
      __pageInfo: { hasNextPage, endCursor },
    },
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
  const first = typeof args.first === 'number' ? args.first : 100;
  const page = repo.pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    record: { __nodes: page.map((pull) => pullNode(repo, pull)) },
  };
}

/** Resolve one field of a node; null when the field is unknown (the caller records the error). */
function resolveField(node: NodeValue, field: FieldNode, ctx: ExecContext): unknown {
  const args = argsOf(field, ctx);
  const record = node.record;
  switch (node.__typename) {
    case 'Query': {
      switch (field.name) {
        case 'viewer':
          return userNode();
        case 'repository': {
          const owner = args.owner;
          const name = args.name;
          if (typeof owner !== 'string' || typeof name !== 'string') return null;
          if (owner !== VIEWER_LOGIN) return null;
          const repo = ctx.store.getRepo(owner, name);
          return repo === undefined ? null : repoNode(repo);
        }
        case 'node': {
          const id = args.id;
          if (typeof id !== 'string') return null;
          const parsed = parseGid(id);
          if (parsed === null) return null;
          if (parsed.kind === 'repo') {
            const repo = decodeRepoId(ctx.store, id);
            return repo === undefined ? null : repoNode(repo);
          }
          if (parsed.kind === 'issue') {
            const found = decodeIssueId(ctx.store, id);
            return found === undefined ? null : issueNode(found.repo, found.issue);
          }
          if (parsed.kind === 'pr') {
            const found = decodePullId(ctx.store, id);
            return found === undefined ? null : pullNode(found.repo, found.pull);
          }
          return null;
        }
        case '__type': {
          const name = args.name;
          if (typeof name !== 'string') return null;
          const info = typeInfo(name);
          if (info === null) return null;
          return { __typename: '__Type', record: { __typeName: name, __fields: info.fields, __enumValues: info.enumValues } };
        }
        default:
          return undefined;
      }
    }
    case 'Repository': {
      const repo = record.__repo as Repo;
      switch (field.name) {
        case 'id':
          return repoGid(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userNode();
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) return null;
          return { __typename: 'Ref', record: { name: repo.defaultBranch } };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'private':
          return repo.isPrivate;
        case 'issue': {
          const number = args.number;
          if (typeof number !== 'number') return null;
          const issue = repo.issues.find((entry) => entry.number === number);
          return issue === undefined ? null : issueNode(repo, issue);
        }
        case 'issues':
          return issuesConnection(repo, args);
        case 'pullRequests':
          return pullsConnection(repo, args);
        case 'pullRequest': {
          const number = args.number;
          if (typeof number !== 'number') return null;
          const pull = repo.pulls.find((entry) => entry.number === number);
          return pull === undefined ? null : pullNode(repo, pull);
        }
        default:
          return undefined;
      }
    }
    case 'Issue': {
      const issue = record.__issue as Issue;
      const repo = record.__repo as Repo;
      switch (field.name) {
        case 'id':
          return issueGid(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      const pull = record.__pull as Pull;
      const repo = record.__repo as Repo;
      switch (field.name) {
        case 'id':
          return pullGid(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return pullMergeable(repo, pull);
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const files = pullFilesOf(repo, pull).slice(0, first);
          return {
            __typename: 'PullRequestChangedFileConnection',
            record: { __nodes: files.map((file) => ({ __typename: 'PullRequestChangedFile', record: { path: file.filename } })) },
          };
        }
        default:
          return undefined;
      }
    }
    case 'User': {
      switch (field.name) {
        case 'login':
          return VIEWER_LOGIN;
        case 'id':
          return String(VIEWER_ID);
        case 'name':
          return 'ada iversen';
        case 'email':
          return 'adaiversen@example.invalid';
        default:
          return undefined;
      }
    }
    case 'Ref': {
      if (field.name === 'name') return record.name;
      return undefined;
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return record.__nodes;
      if (field.name === 'pageInfo') {
        return { __typename: 'PageInfo', record: record.__pageInfo as Record<string, unknown> };
      }
      return undefined;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return record.__nodes;
      return undefined;
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return record.__nodes;
      return undefined;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return record.path;
      return undefined;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return record.hasNextPage;
      if (field.name === 'endCursor') return record.endCursor;
      return undefined;
    }
    case '__Type': {
      if (field.name === 'name') return record.__typeName;
      if (field.name === 'fields') {
        return (record.__fields as string[]).map((name) => ({ __typename: '__Field', record: { name } }));
      }
      if (field.name === 'enumValues') {
        return (record.__enumValues as string[]).map((name) => ({ __typename: '__EnumValue', record: { name } }));
      }
      return undefined;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return record.name;
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Execute a selection set against a node value, collecting unknown fields as errors. */
function executeSelection(
  node: NodeValue,
  selection: SelectionNode[] | null,
  ctx: ExecContext,
): Record<string, unknown> | null {
  if (selection === null) return null;
  const out: Record<string, unknown> = {};
  for (const item of selection) {
    if (item.kind === 'fragment') {
      if (item.typeCondition !== null && item.typeCondition !== node.__typename) continue;
      const sub = executeSelection(node, item.selection, ctx);
      if (sub !== null) Object.assign(out, sub);
      continue;
    }
    const key = item.alias ?? item.name;
    const value = resolveField(node, item, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${item.name}" on type "${node.__typename}".` });
      out[key] = null;
      continue;
    }
    out[key] = executeValue(value, item.selection, ctx);
  }
  return out;
}

/** Node types whose fields resolve through resolvePayloadField, not resolveField. */
const PAYLOAD_TYPES = new Set([
  'CreateIssuePayload',
  'CloseIssuePayload',
  'CreatePullRequestPayload',
  'MergePullRequestPayload',
  'AddCommentPayload',
  'IssueCommentEdge',
  'IssueComment',
]);

function executeValue(value: unknown, selection: SelectionNode[] | null, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => executeValue(entry, selection, ctx));
  if (isNode(value)) {
    if (selection === null) return {};
    if (PAYLOAD_TYPES.has(value.__typename)) return executePayloadSelection(value, selection, ctx);
    return executeSelection(value, selection, ctx);
  }
  return value;
}

// -------------------------------------------------------------------------------------------
// mutations
// -------------------------------------------------------------------------------------------

function resolveMutation(field: FieldNode, ctx: ExecContext): unknown {
  const args = argsOf(field, ctx);
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repositoryId = input.repositoryId;
      if (typeof repositoryId !== 'string') return { __typename: 'CreateIssuePayload', record: { __issue: null } };
      const repo = decodeRepoId(ctx.store, repositoryId);
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the given id.' });
        return null;
      }
      const title = input.title;
      if (typeof title !== 'string' || title === '') {
        ctx.errors.push({ message: 'createIssue requires a title.' });
        return null;
      }
      const created = createIssueOnRepo(ctx.store, repo, title, typeof input.body === 'string' ? input.body : '', []);
      if ('error' in created) {
        ctx.errors.push({ message: String((created.error.body as Record<string, unknown>).message ?? 'createIssue failed') });
        return null;
      }
      return { __typename: 'CreateIssuePayload', record: { __repo: repo, __issue: created.issue } };
    }
    case 'closeIssue': {
      const issueId = input.issueId;
      if (typeof issueId !== 'string') return null;
      const found = decodeIssueId(ctx.store, issueId);
      if (found === undefined) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the given id.' });
        return null;
      }
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', record: { __repo: found.repo, __issue: found.issue } };
    }
    case 'createPullRequest': {
      const repositoryId = input.repositoryId;
      if (typeof repositoryId !== 'string') return null;
      const repo = decodeRepoId(ctx.store, repositoryId);
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the given id.' });
        return null;
      }
      const title = input.title;
      const head = input.headRefName;
      const base = input.baseRefName;
      if (typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') {
        ctx.errors.push({ message: 'createPullRequest requires a title, headRefName and baseRefName.' });
        return null;
      }
      const created = createPullOnRepo(ctx.store, repo, title, '', head, base);
      if ('error' in created) {
        ctx.errors.push({ message: String((created.error.body as Record<string, unknown>).message ?? 'createPullRequest failed') });
        return null;
      }
      return { __typename: 'CreatePullRequestPayload', record: { __repo: repo, __pull: created.pull } };
    }
    case 'mergePullRequest': {
      const pullRequestId = input.pullRequestId;
      if (typeof pullRequestId !== 'string') return null;
      const found = decodePullId(ctx.store, pullRequestId);
      if (found === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the given id.' });
        return null;
      }
      const merged = mergePullOnRepo(found.repo, found.pull);
      if (merged.status !== 200) {
        ctx.errors.push({ message: String((merged.body as Record<string, unknown>).message ?? 'mergePullRequest failed') });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', record: { __repo: found.repo, __pull: found.pull } };
    }
    case 'addComment': {
      const subjectId = input.subjectId;
      const body = input.body;
      if (typeof subjectId !== 'string' || typeof body !== 'string') return null;
      const found = decodeIssueId(ctx.store, subjectId);
      if (found === undefined) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the given id.' });
        return null;
      }
      const comment = addCommentOnRepo(found.repo, found.issue, body);
      return {
        __typename: 'AddCommentPayload',
        record: {
          __commentEdge: {
            __typename: 'IssueCommentEdge',
            record: {
              __node: {
                __typename: 'IssueComment',
                record: { id: commentGid(found.repo, found.issue, comment.id), body: comment.body },
              },
            },
          },
        },
      };
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      return null;
  }
}

function resolvePayloadField(node: NodeValue, field: FieldNode, ctx: ExecContext): unknown {
  const record = node.record;
  switch (node.__typename) {
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name !== 'issue') return undefined;
      const issue = record.__issue as Issue | null;
      if (issue === null) return null;
      return issueNode(record.__repo as Repo, issue);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name !== 'pullRequest') return undefined;
      const pull = record.__pull as Pull | null;
      if (pull === null) return null;
      return pullNode(record.__repo as Repo, pull);
    }
    case 'AddCommentPayload': {
      if (field.name !== 'commentEdge') return undefined;
      return record.__commentEdge as NodeValue;
    }
    case 'IssueCommentEdge': {
      if (field.name !== 'node') return undefined;
      return record.__node as NodeValue;
    }
    case 'IssueComment': {
      if (field.name === 'id') return record.id;
      if (field.name === 'body') return record.body;
      return undefined;
    }
    default:
      return undefined;
  }
}

function executePayloadSelection(
  node: NodeValue,
  selection: SelectionNode[] | null,
  ctx: ExecContext,
): Record<string, unknown> | null {
  if (selection === null) return null;
  const out: Record<string, unknown> = {};
  for (const item of selection) {
    if (item.kind === 'fragment') {
      if (item.typeCondition !== null && item.typeCondition !== node.__typename) continue;
      const sub = executePayloadSelection(node, item.selection, ctx);
      if (sub !== null) Object.assign(out, sub);
      continue;
    }
    const key = item.alias ?? item.name;
    const value = resolvePayloadField(node, item, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${item.name}" on type "${node.__typename}".` });
      out[key] = null;
      continue;
    }
    out[key] = executeValue(value, item.selection, ctx);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export interface GraphQLResult {
  data: unknown;
  errors?: Array<{ message: string }>;
}

function executeOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>): GraphQLResult {
  const ctx: ExecContext = { store, variables, errors: [] };
  const data: Record<string, unknown> = {};
  if (operation.kind === 'mutation') {
    for (const item of operation.selection) {
      if (item.kind === 'fragment') continue;
      const key = item.alias ?? item.name;
      const payload = resolveMutation(item, ctx);
      if (payload === null) {
        data[key] = null;
        continue;
      }
      if (!isNode(payload)) {
        data[key] = payload;
        continue;
      }
      data[key] = executePayloadSelection(payload, item.selection, ctx);
    }
  } else {
    const root: NodeValue = { __typename: 'Query', record: {} };
    const out = executeSelection(root, operation.selection, ctx);
    Object.assign(data, out ?? {});
  }
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  const runOne = (entry: unknown): GraphQLResult => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Expected a GraphQL operation object.' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'The query field must be a string.' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let operations: OperationNode[];
    try {
      operations = new Parser(query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'The document holds no operation.' }] };
    }
    let operation: OperationNode | undefined;
    if (operationName !== null) operation = operations.find((entry) => entry.name === operationName);
    else operation = operations[0];
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
    return executeOperation(store, operation, variables);
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}
