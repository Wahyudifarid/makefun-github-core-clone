// Model Context Protocol over streamable HTTP: the 2026-07-28 era (server/discover,
// no handshake, no session) with the legacy initialize handshake kept as a fallback.
// One JSON body answers one POST; notifications answer 202 with no body.
import {
  createIssueOnRepo,
  createPullOnRepo,
  issueJson,
  mergePullOnRepo,
  pullJson,
  repoJson,
} from './rest.ts';
import {
  VIEWER_LOGIN,
  type Repo,
  type Store,
} from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

/** The six tools, in a fixed order: two tools/list calls answer byte-identically. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The owner login (the token owner).' }),
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'number', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function lookupRepo(store: Store, owner: unknown, repo: unknown): Repo | undefined {
  if (typeof owner !== 'string' || typeof repo !== 'string') return undefined;
  if (owner !== VIEWER_LOGIN) return undefined;
  return store.getRepo(owner, repo);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) {
    return errorResult(`Unknown tool: ${name}`);
  }
  const missing = def.inputSchema.required.filter((key) => {
    const value = args[key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0) {
    return errorResult(`Missing required argument(s): ${missing.join(', ')}`);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        return errorResult(`Repository already exists: ${repoName}`);
      }
      const repo = store.createRepo(
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return textResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = lookupRepo(store, args.owner, args.repo);
      if (repo === undefined) return errorResult('Repository not found');
      return textResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = lookupRepo(store, args.owner, args.repo);
      if (repo === undefined) return errorResult('Repository not found');
      const created = createIssueOnRepo(
        store,
        repo,
        args.title as string,
        typeof args.body === 'string' ? args.body : '',
        [],
      );
      if ('error' in created) return errorResult(String((created.error.body as Record<string, unknown>).message ?? 'create_issue failed'));
      return textResult(issueJson(repo, created.issue));
    }
    case 'list_issues': {
      const repo = lookupRepo(store, args.owner, args.repo);
      if (repo === undefined) return errorResult('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
      return textResult({ issues: list.map((issue) => issueJson(repo, issue)) });
    }
    case 'create_pull_request': {
      const repo = lookupRepo(store, args.owner, args.repo);
      if (repo === undefined) return errorResult('Repository not found');
      const created = createPullOnRepo(
        store,
        repo,
        args.title as string,
        typeof args.body === 'string' ? args.body : '',
        args.head as string,
        args.base as string,
      );
      if ('error' in created) return errorResult(String((created.error.body as Record<string, unknown>).message ?? 'create_pull_request failed'));
      return textResult(pullJson(repo, created.pull));
    }
    case 'merge_pull_request': {
      const repo = lookupRepo(store, args.owner, args.repo);
      if (repo === undefined) return errorResult('Repository not found');
      const number = args.pull_number as number;
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return errorResult(`Pull request #${number} not found`);
      const merged = mergePullOnRepo(repo, pull);
      if (merged.status !== 200) return errorResult(String((merged.body as Record<string, unknown>).message ?? 'merge failed'));
      return textResult(pullJson(repo, pull));
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

export interface McpReply {
  status: number;
  body: unknown;
}

/** One POST to /mcp. `bodyText` is the raw request body. */
export function handleMcp(store: Store, bodyText: string): McpReply {
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const record = body as Record<string, unknown>;
  const id = record.id ?? null;
  const method = record.method;
  if (typeof method !== 'string') {
    return { status: 400, body: rpcError(id, -32600, 'Invalid Request') };
  }
  // A notification carries no id and wants no answer.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  const params = (record.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover': {
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        }),
      };
    }
    case 'initialize': {
      const offered = params.protocolVersion;
      const negotiated =
        typeof offered === 'string' && SUPPORTED_VERSIONS.includes(offered) ? offered : '2026-07-28';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    }
    case 'tools/list': {
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    }
    case 'tools/call': {
      const toolName = params.name;
      if (typeof toolName !== 'string' || toolName === '') {
        return { status: 200, body: rpcError(id, -32602, 'tools/call requires a tool name') };
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return { status: 200, body: rpcError(id, -32602, 'tools/call arguments must be an object') };
      }
      const known = TOOLS.some((tool) => tool.name === toolName);
      if (!known) {
        return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
      }
      return { status: 200, body: rpcResult(id, callTool(store, toolName, args)) };
    }
    case 'ping': {
      return { status: 200, body: rpcResult(id, {}) };
    }
    default: {
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
    }
  }
}
