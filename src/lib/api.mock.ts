// Mock Tauri IPC for browser-based visual debugging.
// This module shadows src/lib/api.ts when running under `npm run dev:browser`.
// It never touches disk/git; it just returns realistic data so the UI renders.

import type {
  ConfigFile,
  DiffStat,
  EnvReport,
  FileChange,
  FileContent,
  MergeResult,
  PrResult,
  ProjectPrompts,
  ProjectUpdate,
  ProjectView,
  PushResult,
  RemoteInfo,
  ServerInfo,
  Workspace,
} from "./types";

let projects: ProjectView[] = [
  {
    id: "p1",
    name: "branchlab",
    root_path: "/Users/me/code/branchlab",
    default_branch: "main",
    default_model_key: "anthropic/claude-sonnet-4",
    prompts: {
      init_workspace: "Set up the workspace.",
      commit: "Commit changes.",
      merge: "Merge branch.",
      push: "Push branch.",
      create_pr: "Create PR.",
    },
    workspaces: [
      {
        id: "p1-base",
        project_id: "p1",
        kind: "Base",
        path: "/Users/me/code/branchlab",
        branch: "main",
        name: null,
        base_branch: null,
        init_prompt: null,
      },
      {
        id: "p1-ws1",
        project_id: "p1",
        kind: "Worktree",
        path: "/Users/me/Library/Application Support/branchlab/worktrees/branchlab-bubbly-cheetah",
        branch: "bubbly-cheetah",
        name: "Continuing from previous prompt and making it way too long to fit",
        base_branch: "main",
        init_prompt: null,
      },
      {
        id: "p1-ws2",
        project_id: "p1",
        kind: "Worktree",
        path: "/Users/me/Library/Application Support/branchlab/worktrees/branchlab-nimble-otter",
        branch: "nimble-otter",
        name: "Fix project settings popup modal regression",
        base_branch: "main",
        init_prompt: null,
      },
    ],
  },
  {
    id: "p2",
    name: "super-long-project-name-that-should-definitely-be-truncated-in-the-sidebar",
    root_path: "/Users/me/code/super-long-project-name",
    default_branch: "main",
    default_model_key: null,
    prompts: {
      init_workspace: null,
      commit: null,
      merge: null,
      push: null,
      create_pr: null,
    },
    workspaces: [
      {
        id: "p2-base",
        project_id: "p2",
        kind: "Base",
        path: "/Users/me/code/super-long-project-name",
        branch: "main",
        name: "This base workspace name is also extremely long and should truncate cleanly without pushing buttons away",
        base_branch: null,
        init_prompt: null,
      },
    ],
  },
];

export function probeEnvironment(): Promise<EnvReport> {
  return Promise.resolve({
    opencode: { found: true, path: "/usr/local/bin/opencode", version: "1.17.4" },
    git: { found: true, path: "/usr/bin/git", version: "2.45.0" },
  });
}

export function addProject(path: string): Promise<ProjectView> {
  const p: ProjectView = {
    id: `p${Date.now()}`,
    name: path.split("/").pop() ?? path,
    root_path: path,
    default_branch: "main",
    default_model_key: null,
    prompts: {
      init_workspace: null,
      commit: null,
      merge: null,
      push: null,
      create_pr: null,
    },
    workspaces: [
      {
        id: `p${Date.now()}-base`,
        project_id: `p${Date.now()}`,
        kind: "Base",
        path,
        branch: "main",
        name: null,
        base_branch: null,
        init_prompt: null,
      },
    ],
  };
  projects = [...projects, p];
  return Promise.resolve(p);
}

export function listProjects(): Promise<ProjectView[]> {
  return Promise.resolve(projects);
}

export function removeProject(projectId: string): Promise<void> {
  projects = projects.filter((p) => p.id !== projectId);
  return Promise.resolve();
}

export function startServer(workspaceId: string): Promise<ServerInfo> {
  return Promise.resolve({ workspace_id: workspaceId, base_url: "http://127.0.0.1:9999", port: 9999 });
}

export function stopServer(): Promise<void> {
  return Promise.resolve();
}

export function serverStatus(): Promise<ServerInfo | null> {
  return Promise.resolve(null);
}

export function listBranches(): Promise<string[]> {
  return Promise.resolve(["main", "develop", "feature/xyz"]);
}

export function createWorkspace(
  projectId: string,
  base?: string,
  initPrompt?: string,
): Promise<Workspace> {
  const project = projects.find((p) => p.id === projectId);
  const branch = `feature-${Date.now()}`;
  const ws: Workspace = {
    id: `${projectId}-${branch}`,
    project_id: projectId,
    kind: "Worktree",
    path: `/mock/${branch}`,
    branch,
    name: null,
    base_branch: base ?? project?.default_branch ?? "main",
    init_prompt: initPrompt ?? null,
  };
  if (project) {
    project.workspaces.push(ws);
  }
  return Promise.resolve(ws);
}

let quickChatSeq = 0;

export function createQuickChat(): Promise<Workspace> {
  quickChatSeq += 1;
  const id = `quick-${quickChatSeq}`;
  return Promise.resolve({
    id,
    project_id: "__quick__",
    kind: "QuickChat",
    path: `/mock/scratch/${id}`,
    branch: null,
    name: `Quick chat ${quickChatSeq}`,
    base_branch: null,
    init_prompt: null,
  });
}

export function updateProject(projectId: string, update: ProjectUpdate): Promise<ProjectView> {
  const p = projects.find((x) => x.id === projectId);
  if (!p) return Promise.reject(new Error("unknown project"));
  if (update.name) p.name = update.name;
  if (update.default_branch) p.default_branch = update.default_branch;
  if (update.default_model_key !== undefined) p.default_model_key = update.default_model_key;
  if (update.prompts) p.prompts = update.prompts;
  return Promise.resolve(p);
}

export function getProjectPrompts(projectId: string): Promise<ProjectPrompts> {
  const p = projects.find((x) => x.id === projectId);
  return Promise.resolve(p?.prompts ?? { init_workspace: null, commit: null, merge: null, push: null, create_pr: null });
}

export function removeWorkspace(workspaceId: string): Promise<void> {
  for (const p of projects) {
    p.workspaces = p.workspaces.filter((w) => w.id !== workspaceId);
  }
  return Promise.resolve();
}

export function listWorkspaces(): Promise<Workspace[]> {
  return Promise.resolve(projects.flatMap((p) => p.workspaces));
}

export function renameWorkspace(workspaceId: string, name: string): Promise<void> {
  for (const p of projects) {
    const w = p.workspaces.find((x) => x.id === workspaceId);
    if (w) w.name = name;
  }
  return Promise.resolve();
}

const diffStats: Record<string, DiffStat> = {
  "p1-ws1": { files: 3, insertions: 42, deletions: 7 },
  "p1-ws2": { files: 0, insertions: 0, deletions: 0 },
  "p2-base": { files: 12, insertions: 120, deletions: 45 },
};

export function workspaceDiffStat(workspaceId: string): Promise<DiffStat> {
  return Promise.resolve(diffStats[workspaceId] ?? { files: 0, insertions: 0, deletions: 0 });
}

export function workspaceChanges(): Promise<FileChange[]> {
  return Promise.resolve([
    { path: "src/App.tsx", status: "modified", insertions: 10, deletions: 2 },
    { path: "src/components/Sidebar.tsx", status: "modified", insertions: 20, deletions: 5 },
  ]);
}

export function workspaceFileDiff(): Promise<string> {
  return Promise.resolve("mock diff");
}

export function discardFile(): Promise<void> {
  return Promise.resolve();
}

export function workspaceFiles(): Promise<string[]> {
  return Promise.resolve(["src/App.tsx", "src/components/Sidebar.tsx"]);
}

export function readFile(): Promise<FileContent> {
  return Promise.resolve({ path: "mock", content: "mock content", binary: false, truncated: false, size: 12 });
}

export function commitWorkspace(): Promise<string> {
  return Promise.resolve("abc1234");
}

export function mergeWorkspace(): Promise<MergeResult> {
  return Promise.resolve({ branch: "feature", base: "main", summary: "merged" });
}

export function pushWorkspace(): Promise<PushResult> {
  return Promise.resolve({ branch: "feature", remote: "origin", output: "ok" });
}

export function createWorkspacePr(): Promise<PrResult> {
  return Promise.resolve({ branch: "feature", base: "main", url: "https://github.com/test/pr/1" });
}

export function listRemotes(): Promise<RemoteInfo[]> {
  return Promise.resolve([{ name: "origin", url: "git@github.com:test/repo.git" }]);
}

export function readConfig(): Promise<ConfigFile> {
  return Promise.resolve({ path: "/mock/opencode.json", content: "{}", exists: true });
}

export function writeConfig(): Promise<string> {
  return Promise.resolve("/mock/opencode.json");
}

export function restartServer(workspaceId: string): Promise<ServerInfo> {
  return startServer(workspaceId);
}

export function listServers(): Promise<ServerInfo[]> {
  return Promise.resolve([]);
}

export function touchServer(): Promise<void> {
  return Promise.resolve();
}

export function openDevtools(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("open devtools");
  return Promise.resolve();
}

export function openExternal(path: string, app?: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("open external", path, app);
  return Promise.resolve();
}
