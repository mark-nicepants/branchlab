import { describe, expect, it } from "vitest";
import { buildTree } from "./tree";

describe("buildTree", () => {
  it("groups files into folders by path segment", () => {
    const tree = buildTree(["src/App.tsx", "src/lib/diff.ts", "src/lib/tree.ts"]);
    expect(tree).toHaveLength(1);
    const [src] = tree;
    expect(src.name).toBe("src");
    expect(src.isFile).toBe(false);
    expect(src.children.map((c) => c.name)).toEqual(["lib", "App.tsx"]);
  });

  it("sorts folders before files, alphabetical within each", () => {
    const tree = buildTree(["b/file.ts", "a.ts", "c.ts", "a/file.ts"]);
    expect(tree.map((n) => `${n.name}${n.isFile ? "" : "/"}`)).toEqual([
      "a/",
      "b/",
      "a.ts",
      "c.ts",
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("assigns a full slash-joined path to each node", () => {
    const [src] = buildTree(["src/lib/diff.ts"]);
    expect(src.path).toBe("src");
    expect(src.children[0].path).toBe("src/lib");
    expect(src.children[0].children[0].path).toBe("src/lib/diff.ts");
  });
});
