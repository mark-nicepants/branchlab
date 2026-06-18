// Build a folder/file tree from a flat list of slash-separated paths.

export interface TreeNode {
  name: string;
  /** Path from the root, slash-joined, no leading slash. */
  path: string;
  isFile: boolean;
  children: TreeNode[];
}

/** Folders first, then files; alphabetical within. */
function sortTree(node: TreeNode) {
  node.children.sort((a, b) => (a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1));
  node.children.forEach(sortTree);
}

export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isFile: false, children: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join("/"), isFile, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  sortTree(root);
  return root.children;
}
