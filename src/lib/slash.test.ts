import { describe, expect, it } from "vitest";
import type { CommandOption } from "./types";
import {
  expandTemplate,
  filterCommands,
  isSlashTyping,
  parseSlash,
} from "./slash";

const cmd = (over: Partial<CommandOption> = {}): CommandOption => ({
  name: "review",
  template: "Review: $ARGUMENTS",
  ...over,
});

describe("parseSlash", () => {
  it("returns null when text does not start with a slash", () => {
    expect(parseSlash("hello /world")).toBeNull();
    expect(parseSlash("")).toBeNull();
  });

  it("treats a bare slash as command name = ''", () => {
    expect(parseSlash("/")).toEqual({ name: "", args: "" });
  });

  it("splits on the first whitespace", () => {
    expect(parseSlash("/review pr-123 some text")).toEqual({
      name: "review",
      args: "pr-123 some text",
    });
  });

  it("returns empty args when there is no space", () => {
    expect(parseSlash("/init")).toEqual({ name: "init", args: "" });
  });
});

describe("expandTemplate", () => {
  it("substitutes every occurrence of $ARGUMENTS", () => {
    expect(expandTemplate("a $ARGUMENTS b $ARGUMENTS c", "X")).toBe(
      "a X b X c",
    );
  });

  it("appends args after a blank line when the template has no placeholder", () => {
    expect(expandTemplate("Do the thing.", "with these inputs")).toBe(
      "Do the thing.\n\nwith these inputs",
    );
  });

  it("leaves the template untouched when both placeholder and args are absent", () => {
    expect(expandTemplate("Just a prompt.", "")).toBe("Just a prompt.");
  });

  it("does not interpret regex metacharacters in the args value", () => {
    expect(expandTemplate("X=$ARGUMENTS", "$& and $1")).toBe("X=$& and $1");
  });
});

describe("isSlashTyping", () => {
  it("is true while only a command name is being typed", () => {
    expect(isSlashTyping("/")).toBe(true);
    expect(isSlashTyping("/rev")).toBe(true);
  });

  it("is false once whitespace appears (user is in argument mode)", () => {
    expect(isSlashTyping("/review ")).toBe(false);
    expect(isSlashTyping("/review pr-123")).toBe(false);
  });

  it("is false for non-slash input", () => {
    expect(isSlashTyping("hello")).toBe(false);
  });
});

describe("filterCommands", () => {
  const all: CommandOption[] = [
    cmd({ name: "review" }),
    cmd({ name: "init" }),
    cmd({ name: "customize-opencode", source: "skill" }),
    cmd({ name: "release", source: "command" }),
  ];

  it("matches case-insensitive prefix", () => {
    expect(filterCommands(all, "re").map((c) => c.name)).toEqual([
      "release",
      "review",
    ]);
    expect(filterCommands(all, "RE").map((c) => c.name)).toEqual([
      "release",
      "review",
    ]);
  });

  it("returns everything when query is empty", () => {
    expect(filterCommands(all, "").length).toBe(all.length);
  });

  it("ranks user-defined commands before skills", () => {
    const names = filterCommands(all, "").map((c) => c.name);
    expect(names.indexOf("customize-opencode")).toBeGreaterThan(
      names.indexOf("review"),
    );
  });
});
