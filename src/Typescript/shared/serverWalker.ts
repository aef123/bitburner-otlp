import { NS } from "../../../NetScriptDefinitions";

/**
 * Shared network-navigation helpers so scripts don't each re-implement the
 * server-walking algorithm. The network is a tree rooted at `home`; the only
 * primitive the game gives is `ns.scan(host)` (immediate neighbors), so every
 * helper here is a breadth-first walk from a root using a visited-set.
 *
 * Pick whichever shape fits the caller:
 *   - listServers(ns)            -> flat string[] of every reachable host
 *   - mapServers(ns)             -> ServerNode[] with parent/depth/path info
 *   - walkServers(ns, visit)     -> run a lambda on each node (can prune)
 *   - findPath(ns, target)       -> hostnames from home to target, inclusive
 */

/** A server reached during a walk, with the route back to the root. */
export interface ServerNode {
  /** This server's hostname. */
  hostname: string;
  /** The host we reached this one from (null for the root). */
  parent: string | null;
  /** Hops from the root (root = 0). */
  depth: number;
  /** Full path from root to this host, inclusive of both ends. */
  path: string[];
}

/**
 * Breadth-first walk of the whole network from `root` (default "home"), calling
 * `visit` once per server. Return `false` from `visit` to stop descending past
 * that node (its children are skipped); return anything else to keep walking.
 */
export function walkServers(ns: NS, visit: (node: ServerNode) => boolean | void, root = "home"): void {
  const seen = new Set<string>([root]);
  const queue: ServerNode[] = [{ hostname: root, parent: null, depth: 0, path: [root] }];
  while (queue.length > 0) {
    const node = queue.shift() as ServerNode;
    if (visit(node) === false) continue;
    for (const next of ns.scan(node.hostname)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ hostname: next, parent: node.hostname, depth: node.depth + 1, path: [...node.path, next] });
    }
  }
}

/** Flat list of every server reachable from `root` (default "home"), including the root. */
export function listServers(ns: NS, root = "home"): string[] {
  const out: string[] = [];
  walkServers(ns, (node) => void out.push(node.hostname), root);
  return out;
}

/** Every server as a ServerNode (parent/depth/path), reachable from `root`. */
export function mapServers(ns: NS, root = "home"): ServerNode[] {
  const out: ServerNode[] = [];
  walkServers(ns, (node) => void out.push(node), root);
  return out;
}

/** Path of hostnames from `root` to `target` (inclusive), or null if unreachable. */
export function findPath(ns: NS, target: string, root = "home"): string[] | null {
  let result: string[] | null = null;
  walkServers(ns, (node) => {
    if (node.hostname === target) {
      result = node.path;
      return false;
    }
  }, root);
  return result;
}
