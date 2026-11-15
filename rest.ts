// GitHub REST v3, served from the one store. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors carry a string message.
import {
  FORGE_DATE,
  VIEWER_ID,
  VIEWER_LOGIN,
  buildTreeFromFiles,
  commitFiles,
  diffTrees,
  getCommit,
  lineDiff,
  makeCommit,
  mergeBase,
  refCommit,
  resolveRef,
  storeObject,
  threeWayMerge,
  updateTreePath,
  walkCommits,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

function err(status: number, message: string): RestReply {
  return { status, body: { message } };
}

// -------------------------------------------------------------------------------------------
// shapes
// -------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    created_at: FORGE_DATE,
    updated_at: FORGE_DATE,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

/** "Name <email> 1700000000 +0000" -> the GitHub API's {name, email, date} shape. */
function identityJson(raw: string): { name: string; email: string; date: string } {
  const match = /^([^<]*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(raw.trim());
  if (match === null) return { name: 'Forge', email: 'forge@make.fun', date: FORGE_DATE };
  return {
    name: (match[1] as string).trim(),
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FORGE_DATE,
    updated_at: FORGE_DATE,
    comments: issue.comments.length,
  };
}

function pullHeadSha(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
}

function pullBaseSha(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.headRef,
      sha: pullHeadSha(repo, pull),
      label: `${VIEWER_LOGIN}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: pullBaseSha(repo, pull),
      label: `${VIEWER_LOGIN}:${pull.baseRef}`,
    },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: FORGE_DATE,
    updated_at: FORGE_DATE,
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FORGE_DATE,
    updated_at: FORGE_DATE,
  };
}

/** A page of items, with a Link header naming the next page when there is one. */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  basePath: string,
): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const url = new URL(basePath, 'http://entry');
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(pageNum + 1));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { page, link };
}

function withLink(reply: RestReply, link: string | null): RestReply {
  if (link === null) return reply;
  return { ...reply, headers: { ...(reply.headers ?? {}), link } };
}

// -------------------------------------------------------------------------------------------
// shared helpers
// -------------------------------------------------------------------------------------------

/** The repository a route names, or the 404 it answers (a foreign owner is 404, never 403). */
function lookupRepo(store: Store, owner: string, name: string): { repo: Repo } | { error: RestReply } {
  if (owner !== VIEWER_LOGIN) return { error: err(404, 'Not Found') };
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { error: err(404, 'Not Found') };
  return { repo };
}

function bodyString(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function bodyBoolean(body: unknown, field: string): boolean | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'boolean' ? value : undefined;
}

/** The blob bytes a base64 contents body carries, or null when it is not base64. */
function decodeContent(body: unknown): Buffer | null {
  const content = bodyString(body, 'content');
  if (content === undefined) return null;
  const clean = content.replace(/[\r\n\t ]+/g, '');
  if (clean === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  return Buffer.from(clean, 'base64');
}

// -------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------

/** Commit a file change on a branch; creates the branch from the default tip when missing. */
function commitFileChange(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const ref = `refs/heads/${branch}`;
  let tip = refCommit(repo, ref);
  if (tip === undefined && branch !== repo.defaultBranch) {
    tip = refCommit(repo, `refs/heads/${repo.defaultBranch}`);
    if (tip !== undefined) repo.refs.set(ref, tip);
  }
  const baseTree = tip === undefined ? null : getCommit(repo, tip)?.tree ?? null;
  let blobSha: string | null = null;
  if (content !== null) blobSha = storeObject(repo, { type: 'blob', data: content });
  const parts = path.split('/').filter((part) => part !== '');
  const tree = updateTreePath(repo, baseTree, parts, blobSha);
  const commitSha = makeCommit(repo, tree, tip === undefined ? [] : [tip], message);
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}

/** The blob at a path on a branch tip (or at a commit), with its sha. */
function fileAt(
  repo: Repo,
  ref: string | undefined,
  path: string,
): { blobOid: string; data: Buffer } | undefined {
  const commitOid = ref === undefined ? refCommit(repo, `refs/heads/${repo.defaultBranch}`) : resolveRef(repo, ref);
  if (commitOid === undefined) return undefined;
  const files = commitFiles(repo, commitOid);
  const entry = files.get(path);
  if (entry === undefined) return undefined;
  const object = repo.objects.get(entry.oid);
  if (object === undefined || object.type !== 'blob') return undefined;
  return { blobOid: entry.oid, data: object.data };
}

/** The immediate children of a directory on a branch tip, as contents entries. */
function dirAt(
  repo: Repo,
  ref: string | undefined,
  dir: string,
): Array<{ type: string; name: string; path: string; sha: string; size: number }> | undefined {
  const commitOid = ref === undefined ? refCommit(repo, `refs/heads/${repo.defaultBranch}`) : resolveRef(repo, ref);
  if (commitOid === undefined) return undefined;
  const files = commitFiles(repo, commitOid);
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { type: string; sha: string; size: number }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const object = repo.objects.get(entry.oid);
      children.set(rest, { type: 'file', sha: entry.oid, size: object?.data.length ?? 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!children.has(name)) children.set(name, { type: 'dir', sha: '', size: 0 });
    }
  }
  const out = [...children.entries()].map(([name, child]) => ({
    type: child.type,
    name,
    path: prefix + name,
    sha: child.sha,
    size: child.size,
  }));
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// -------------------------------------------------------------------------------------------
// pull-request merging
// -------------------------------------------------------------------------------------------

/** The 3-way merge of a pull request; answers the merged tree or its conflicts. */
function mergePullRequest(
  repo: Repo,
  pull: Pull,
): { tree: Map<string, { oid: string; mode: string }>; conflicts: string[] } {
  const baseFiles = commitFiles(repo, pull.mergeBaseSha === '' ? undefined : pull.mergeBaseSha);
  const headTip = pullHeadSha(repo, pull);
  const baseTip = pullBaseSha(repo, pull);
  const oursFiles = commitFiles(repo, baseTip === '' ? undefined : baseTip);
  const theirsFiles = commitFiles(repo, headTip === '' ? undefined : headTip);
  return threeWayMerge(baseFiles, oursFiles, theirsFiles);
}

/** Whether a pull request would merge cleanly right now. */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = pullHeadSha(repo, pull);
  const baseTip = pullBaseSha(repo, pull);
  if (headTip === '' || baseTip === '') return 'UNKNOWN';
  if (headTip === baseTip) return 'MERGEABLE';
  const { conflicts } = mergePullRequest(repo, pull);
  return conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
}

// -------------------------------------------------------------------------------------------
// the router
// -------------------------------------------------------------------------------------------

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
): RestReply {
  // GET /api/v3/ and /api/v3/meta are public; everything else needs the token (checked by the router).
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0' });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' });
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (segments.length !== 2) return err(404, 'Not Found');
    if (method === 'GET') {
      const repos = store.viewerRepos();
      const { page, link } = paginate(repos, query, `${origin}/api/v3/user/repos`);
      return withLink(ok(200, page.map(repoJson)), link);
    }
    if (method === 'POST') {
      const name = bodyString(body, 'name');
      if (name === undefined || name === '') return err(422, 'name is required');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, 'Repository already exists');
      const repo = store.createRepo(
        name,
        bodyBoolean(body, 'private') ?? false,
        bodyString(body, 'description') ?? '',
      );
      return ok(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(segments[1] as string);
    const name = decodeURIComponent(segments[2] as string);
    const rest = segments.slice(3);
    const found = lookupRepo(store, owner, name);
    if ('error' in found) return found.error;
    const repo = found.repo;
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(repo));
      if (method === 'PATCH') {
        const description = bodyString(body, 'description');
        if (description !== undefined) repo.description = description;
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? '' }, protected: false }));
        return ok(200, branches);
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(rest[1] as string);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return err(404, 'Branch not found');
        return ok(200, { name: branch, commit: { sha }, protected: false });
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const shaParam = query.get('sha');
        const tip = shaParam !== null ? resolveRef(repo, shaParam) : refCommit(repo, `refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return ok(200, []);
        const commits = walkCommits(repo, tip).map((oid) => {
          const commit = getCommit(repo, oid);
          return {
            sha: oid,
            commit: {
              message: commit?.message ?? '',
              author: commit === undefined ? { name: 'Forge', email: 'forge@make.fun', date: FORGE_DATE } : identityJson(commit.author),
              committer: commit === undefined ? { name: 'Forge', email: 'forge@make.fun', date: FORGE_DATE } : identityJson(commit.committer),
            },
            parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
          };
        });
        return ok(200, commits);
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = bodyString(body, 'ref');
        const sha = bodyString(body, 'sha');
        if (ref === undefined || sha === undefined) return err(422, 'ref and sha are required');
        if (!ref.startsWith('refs/heads/')) return err(422, 'only branch refs can be created here');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (getCommit(repo, sha) === undefined) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return ok(201, { ref, object: { sha, type: 'commit' } });
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).map((part) => decodeURIComponent(part)).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return err(404, 'Not Found');
        return ok(200, { ref, object: { sha, type: 'commit' } });
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
      if (method === 'PUT') {
        const message = bodyString(body, 'message') ?? `Update ${path}`;
        const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
        const content = decodeContent(body);
        if (content === null) return err(400, 'content is not valid base64');
        const existing = fileAt(repo, branch, path);
        const givenSha = bodyString(body, 'sha');
        if (existing !== undefined) {
          if (givenSha === undefined) return err(422, 'sha was not supplied');
          if (givenSha.toLowerCase() !== existing.blobOid.toLowerCase()) return err(409, 'sha does not match the current file');
          const { commitSha, blobSha } = commitFileChange(store, repo, branch, path, content, message);
          return ok(200, { content: { sha: blobSha, encoding: 'base64' }, commit: { sha: commitSha } });
        }
        const { commitSha, blobSha } = commitFileChange(store, repo, branch, path, content, message);
        return ok(201, { content: { sha: blobSha, encoding: 'base64' }, commit: { sha: commitSha } });
      }
      if (method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        const file = fileAt(repo, ref, path);
        if (file !== undefined) {
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: file.data.length,
            name: path.split('/').pop() ?? path,
            path,
            content: file.data.toString('base64'),
            sha: file.blobOid,
          });
        }
        const dir = dirAt(repo, ref, path);
        if (dir === undefined || dir.length === 0) return err(404, 'Not Found');
        return ok(200, dir);
      }
      if (method === 'DELETE') {
        const message = bodyString(body, 'message') ?? `Delete ${path}`;
        const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
        const existing = fileAt(repo, branch, path);
        if (existing === undefined) return err(404, 'Not Found');
        const givenSha = bodyString(body, 'sha');
        if (givenSha !== undefined && givenSha.toLowerCase() !== existing.blobOid.toLowerCase()) {
          return err(409, 'sha does not match the current file');
        }
        const { commitSha } = commitFileChange(store, repo, branch, path, null, message);
        return ok(200, { commit: { sha: commitSha } });
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const labelName = bodyString(body, 'name');
        const color = bodyString(body, 'color') ?? 'ededed';
        if (labelName === undefined || labelName === '') return err(422, 'name is required');
        const existing = repo.labels.get(labelName);
        if (existing !== undefined) return ok(200, { name: labelName, color: existing.color });
        repo.labels.set(labelName, { name: labelName, color });
        return ok(201, { name: labelName, color });
      }
      if (method === 'GET' && rest.length === 1) {
        return ok(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = bodyString(body, 'title');
          if (title === undefined || title === '') return err(422, 'title is required');
          const labelsRaw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).labels : undefined;
          const labelNames: string[] = Array.isArray(labelsRaw) ? labelsRaw.filter((item): item is string => typeof item === 'string') : [];
          const created = createIssueOnRepo(store, repo, title, bodyString(body, 'body') ?? '', labelNames);
          if ('error' in created) return created.error;
          return ok(201, issueJson(repo, created.issue));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const direction = query.get('direction') ?? 'desc';
          let list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
          list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          const { page, link } = paginate(list, query, `${origin}/api/v3/repos/${owner}/${name}/issues`);
          return withLink(ok(200, page.map((issue) => issueJson(repo, issue))), link);
        }
        return err(404, 'Not Found');
      }
      const number = parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const issue = repo.issues.find((entry) => entry.number === number);
      if (rest.length === 2) {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          const state = bodyString(body, 'state');
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = bodyString(body, 'title');
          if (title !== undefined) issue.title = title;
          const bodyText = bodyString(body, 'body');
          if (bodyText !== undefined) issue.body = bodyText;
          return ok(200, issueJson(repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest[2] === 'comments') {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'POST') {
          const text = bodyString(body, 'body');
          if (text === undefined) return err(422, 'body is required');
          const comment = { id: repo.nextComment, body: text };
          repo.nextComment += 1;
          issue.comments.push(comment);
          return ok(201, commentJson(comment));
        }
        if (method === 'GET') {
          return ok(200, issue.comments.map(commentJson));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = bodyString(body, 'title');
          const head = bodyString(body, 'head');
          const base = bodyString(body, 'base');
          if (title === undefined || head === undefined || base === undefined) {
            return err(422, 'title, head and base are required');
          }
          const created = createPullOnRepo(store, repo, title, bodyString(body, 'body') ?? '', head, base);
          if ('error' in created) return created.error;
          return ok(201, pullJson(repo, created.pull));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const list = repo.pulls.filter((pull) =>
            state === 'all' ? true : state === 'closed' ? pull.state === 'closed' : pull.state === 'open',
          );
          const { page, link } = paginate(list, query, `${origin}/api/v3/repos/${owner}/${name}/pulls`);
          return withLink(ok(200, page.map((pull) => pullJson(repo, pull))), link);
        }
        return err(404, 'Not Found');
      }
      const number = parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (rest.length === 2) {
        if (pull === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, pullJson(repo, pull));
        return err(404, 'Not Found');
      }
      if (rest[2] === 'files' && rest.length === 3) {
        if (pull === undefined) return err(404, 'Not Found');
        if (method !== 'GET') return err(404, 'Not Found');
        return ok(200, pullFilesOf(repo, pull));
      }
      if (rest[2] === 'merge' && rest.length === 3) {
        if (pull === undefined) return err(404, 'Not Found');
        if (method !== 'PUT') return err(404, 'Not Found');
        return mergePullOnRepo(repo, pull);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

/** The files of a pull request, from its merge-base tree to its head tree. */
export function pullFilesOf(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseFiles = commitFiles(repo, pull.mergeBaseSha === '' ? undefined : pull.mergeBaseSha);
  const headTip = pullHeadSha(repo, pull);
  const headFiles = commitFiles(repo, headTip === '' ? undefined : headTip);
  return diffTrees(baseFiles, headFiles)
    .filter((change) => change.status !== 'removed')
    .map((change) => {
      const { additions, deletions } = lineDiff(repo, change.oldOid, change.newOid);
      return { filename: change.path, status: change.status, additions, deletions, changes: additions + deletions };
    });
}

// -------------------------------------------------------------------------------------------
// shared operations (used by the REST routes above and by GraphQL / MCP)
// -------------------------------------------------------------------------------------------

/** Create an issue; answers an error reply when a label is unknown. */
export function createIssueOnRepo(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labels: readonly string[],
): { issue: Issue } | { error: RestReply } {
  for (const labelName of labels) {
    if (!repo.labels.has(labelName)) return { error: err(422, `Label does not exist: ${labelName}`) };
  }
  const issue: Issue = {
    id: store.nextGlobalId,
    number: repo.nextIssue,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: store.nextSeq,
  };
  store.nextGlobalId += 1;
  store.nextSeq += 1;
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return { issue };
}

/** Create a pull request; answers an error reply when a branch is missing or duplicated. */
export function createPullOnRepo(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): { pull: Pull } | { error: RestReply } {
  const headTip = refCommit(repo, `refs/heads/${head}`);
  const baseTip = refCommit(repo, `refs/heads/${base}`);
  if (headTip === undefined) return { error: err(422, 'Head branch does not exist') };
  if (baseTip === undefined) return { error: err(422, 'Base branch does not exist') };
  const duplicate = repo.pulls.find(
    (entry) => entry.state === 'open' && entry.headRef === head && entry.baseRef === base,
  );
  if (duplicate !== undefined) return { error: err(422, 'A pull request already exists for these branches') };
  const baseSha = mergeBase(repo, headTip, baseTip) ?? baseTip;
  const pull: Pull = {
    id: store.nextGlobalId,
    number: repo.nextPull,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    mergeBaseSha: baseSha,
    createdSeq: store.nextSeq,
  };
  store.nextGlobalId += 1;
  store.nextSeq += 1;
  repo.nextPull += 1;
  repo.pulls.push(pull);
  return { pull };
}

/** Squash-merge a pull request onto its base branch. */
export function mergePullOnRepo(repo: Repo, pull: Pull): RestReply {
  if (pull.merged) return err(405, 'Pull request already merged');
  if (pull.state !== 'open') return err(405, 'Pull request is closed');
  const { tree, conflicts } = mergePullRequest(repo, pull);
  if (conflicts.length > 0) return err(405, `Merge conflict in ${conflicts[0] as string}`);
  const baseTip = pullBaseSha(repo, pull);
  const treeOid = buildTreeFromFiles(repo, tree);
  const mergeSha = makeCommit(repo, treeOid, baseTip === '' ? [] : [baseTip], pull.title);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = FORGE_DATE;
  pull.mergeCommitSha = mergeSha;
  return ok(200, { sha: mergeSha, merged: true, message: pull.title });
}

/** Add a comment to an issue. */
export function addCommentOnRepo(repo: Repo, issue: Issue, body: string): { id: number; body: string } {
  const comment = { id: repo.nextComment, body };
  repo.nextComment += 1;
  issue.comments.push(comment);
  return comment;
}

export { pullHeadSha, pullBaseSha, issueJson, pullJson };
