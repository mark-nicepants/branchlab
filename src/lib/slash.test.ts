import { describe, expect, it } from "vitest";
import type { CommandOption } from "./types";
import { filterCommands, isSlashTyping } from "./slash";

const cmd = (over: Partial<CommandOption> = {}): CommandOption => ({
  name: "review",
  ...over,
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
