// The forge's whole state: one in-memory store, no disk, no clock. Every id and
// timestamp the forge emits is a counter or a fixed constant, so two runs on the
// same requests leave identical bytes.
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './git.ts';

/** The login the bearer token names. The suite's scenario seed is a fixed constant, so the
 * viewer is the same login in every trial (wire.ts buildScenario, users[0]). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

/** The fixed timestamp every forge-created commit carries (2023-11-14T22:13:20Z). */
export const FORGE_TIMESTAMP = 1700000000;
/** The fixed identity on forge-created commits. */
export const FORGE_AUTHOR = 'Forge <forge@make.fun>';
/** A fixed ISO date for created_at / merged_at style fields. */
export const FORGE_DATE = '2025-01-01T00:00:00Z';

export const DEFAULT_BRANCH = 'main';

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeBaseSha: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  createdSeq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextGlobalId = 100000;
  nextSeq = 1;
  requestSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      createdSeq: this.nextSeq,
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** The viewer's repositories in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }
}

// -------------------------------------------------------------------------------------------
// object graph reads
// -------------------------------------------------------------------------------------------

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function storeObject(repo: Repo, object: GitObject): string {
  const oid = hashObject(object.type, object.data);
  repo.objects.set(oid, object);
  return oid;
}

export function getCommit(repo: Repo, oid: string): { tree: string; parents: string[]; author: string; committer: string; message: string } | undefined {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return undefined;
  return parseCommit(object.data);
}

/** The commit a ref names, or undefined when the ref is unborn or the object is missing. */
export function refCommit(repo: Repo, ref: string): string | undefined {
  const oid = repo.refs.get(ref);
  if (oid === undefined || oid === ZERO_OID) return undefined;
  return repo.objects.has(oid) ? oid : undefined;
}

/** Resolve a ref name, a branch name or a raw oid to a commit oid. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : undefined;
  if (ref.startsWith('refs/')) return refCommit(repo, ref);
  return refCommit(repo, `refs/heads/${ref}`);
}

/** Walk commits from `tip`, newest first (parents after their child), each commit once. */
export function walkCommits(repo: Repo, tip: string, limit = 100000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    out.push(oid);
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  return out;
}

/** Every commit reachable from `tip`, with its distance from the tip. */
export function ancestorDepths(repo: Repo, tip: string): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: Array<[string, number]> = [[tip, 0]];
  while (queue.length > 0) {
    const [oid, depth] = queue.shift() as [string, number];
    const known = depths.get(oid);
    if (known !== undefined && known <= depth) continue;
    depths.set(oid, depth);
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) queue.push([parent, depth + 1]);
  }
  return depths;
}

/** Whether `ancestor` is reachable from `descendant` (or equal to it). A targeted walk
 * from the descendant that stops the moment the ancestor is found: a push's
 * fast-forward check is one step on a linear history, not a walk of the whole graph. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  if (ancestor === ZERO_OID) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (commit === undefined) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the common ancestor nearest to both. */
export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const depthsA = ancestorDepths(repo, a);
  if (depthsA.has(b)) return b;
  const depthsB = ancestorDepths(repo, b);
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, depthB] of depthsB) {
    const depthA = depthsA.get(oid);
    if (depthA === undefined) continue;
    const score = depthA + depthB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** Flatten a tree into path -> {oid, mode}, recursively. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** The tree of a commit, flattened; an empty map for an unborn ref. */
export function commitFiles(repo: Repo, commitOid: string | undefined): Map<string, { oid: string; mode: string }> {
  if (commitOid === undefined) return new Map();
  const commit = getCommit(repo, commitOid);
  if (commit === undefined) return new Map();
  return flattenTree(repo, commit.tree);
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The file changes between two flattened trees. */
export function diffTrees(
  oldFiles: Map<string, { oid: string; mode: string }>,
  newFiles: Map<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const path of paths) {
    const oldEntry = oldFiles.get(path);
    const newEntry = newFiles.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** A line-count diff between two blobs, as added/removed line counts. */
export function lineDiff(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const readLines = (oid: string | null): string[] => {
    if (oid === null) return [];
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'blob') return [];
    const text = object.data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = readLines(oldOid);
  const newLines = readLines(newOid);
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

export interface MergeOutcome {
  tree: Map<string, { oid: string; mode: string }>;
  conflicts: string[];
}

/**
 * A three-way merge of flattened trees: base, ours (the branch being merged into),
 * theirs (the head). A path changed on both sides to different bytes conflicts.
 */
export function threeWayMerge(
  base: Map<string, { oid: string; mode: string }>,
  ours: Map<string, { oid: string; mode: string }>,
  theirs: Map<string, { oid: string; mode: string }>,
): MergeOutcome {
  const tree = new Map(ours);
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const baseEntry = base.get(path);
    const oursEntry = ours.get(path);
    const theirsEntry = theirs.get(path);
    const baseOid = baseEntry?.oid ?? null;
    const oursOid = oursEntry?.oid ?? null;
    const theirsOid = theirsEntry?.oid ?? null;
    const oursChanged = oursOid !== baseOid;
    const theirsChanged = theirsOid !== baseOid;
    if (!theirsChanged) continue;
    if (!oursChanged) {
      if (theirsEntry === undefined) tree.delete(path);
      else tree.set(path, theirsEntry);
      continue;
    }
    if (oursOid === theirsOid) continue;
    conflicts.push(path);
  }
  conflicts.sort();
  return { tree, conflicts };
}

// -------------------------------------------------------------------------------------------
// tree construction
// -------------------------------------------------------------------------------------------

/**
 * Build the tree that results from setting `path` to `blobOid` (or removing it when null)
 * on top of `baseTreeOid` (null for an empty tree). Intermediate trees are stored.
 */
export function updateTreePath(
  repo: Repo,
  baseTreeOid: string | null,
  parts: readonly string[],
  blobOid: string | null,
): string {
  if (parts.length === 0) return baseTreeOid ?? storeObject(repo, { type: 'tree', data: buildTree([]) });
  const [head, ...rest] = parts as [string, ...string[]];
  let entries: TreeEntry[] = [];
  if (baseTreeOid !== null) {
    const object = repo.objects.get(baseTreeOid);
    if (object !== undefined && object.type === 'tree') entries = parseTree(object.data);
  }
  const existing = entries.find((entry) => entry.name === head);
  if (rest.length === 0) {
    // Leaf: set or remove the file.
    entries = entries.filter((entry) => entry.name !== head);
    if (blobOid !== null) entries.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const childTree = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
    const nextTree = updateTreePath(repo, childTree, rest, blobOid);
    const nextObject = repo.objects.get(nextTree);
    const nextEntries = nextObject !== undefined && nextObject.type === 'tree' ? parseTree(nextObject.data) : [];
    entries = entries.filter((entry) => entry.name !== head);
    if (nextEntries.length > 0) entries.push({ mode: '40000', name: head, oid: nextTree });
  }
  return storeObject(repo, { type: 'tree', data: buildTree(entries) });
}

/** Build a tree object from a flattened file map, storing every intermediate tree. */
export function buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const byDir = new Map<string, TreeEntry[]>();
  const ensure = (dir: string): TreeEntry[] => {
    let list = byDir.get(dir);
    if (list === undefined) {
      list = [];
      byDir.set(dir, list);
    }
    return list;
  };
  for (const [path, entry] of files) {
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    ensure(dir).push({ mode: entry.mode, name, oid: entry.oid });
  }
  const buildDir = (dir: string): string => {
    const entries: TreeEntry[] = [...(byDir.get(dir) ?? [])];
    // Subdirectories of this dir become tree entries.
    for (const key of byDir.keys()) {
      if (key === dir) continue;
      const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
      if (parent !== dir) continue;
      const name = key.slice(dir === '' ? 0 : dir.length + 1);
      if (name.includes('/')) continue;
      entries.push({ mode: '40000', name, oid: buildDir(key) });
    }
    return storeObject(repo, { type: 'tree', data: buildTree(entries) });
  };
  return buildDir('');
}

/** Create a commit object on a repo and store it. */
export function makeCommit(
  repo: Repo,
  tree: string,
  parents: readonly string[],
  message: string,
): string {
  const data = buildCommit({
    tree,
    parents,
    message,
    author: FORGE_AUTHOR,
    committer: FORGE_AUTHOR,
    timestamp: FORGE_TIMESTAMP,
  });
  return storeObject(repo, { type: 'commit', data });
}
