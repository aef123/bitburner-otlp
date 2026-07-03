/**
 * Breadth-first walk of the whole network from `root` (default "home"), calling
 * `visit` once per server. Return `false` from `visit` to stop descending past
 * that node (its children are skipped); return anything else to keep walking.
 */
export function walkServers(ns, visit, root = "home") {
    const seen = new Set([root]);
    const queue = [{ hostname: root, parent: null, depth: 0, path: [root] }];
    while (queue.length > 0) {
        const node = queue.shift();
        if (visit(node) === false)
            continue;
        for (const next of ns.scan(node.hostname)) {
            if (seen.has(next))
                continue;
            seen.add(next);
            queue.push({ hostname: next, parent: node.hostname, depth: node.depth + 1, path: [...node.path, next] });
        }
    }
}
/** Flat list of every server reachable from `root` (default "home"), including the root. */
export function listServers(ns, root = "home") {
    const out = [];
    walkServers(ns, (node) => void out.push(node.hostname), root);
    return out;
}
/** Every server as a ServerNode (parent/depth/path), reachable from `root`. */
export function mapServers(ns, root = "home") {
    const out = [];
    walkServers(ns, (node) => void out.push(node), root);
    return out;
}
/** Path of hostnames from `root` to `target` (inclusive), or null if unreachable. */
export function findPath(ns, target, root = "home") {
    let result = null;
    walkServers(ns, (node) => {
        if (node.hostname === target) {
            result = node.path;
            return false;
        }
    }, root);
    return result;
}
