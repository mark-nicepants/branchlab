// Mock Tauri IPC for browser-based visual debugging.
// This module shadows src/lib/api.ts when running under `npm run dev:browser`.
// It never touches disk/git; it just returns realistic data so the UI renders.

import { mockEmit } from "./events.mock";
import type {
  Account,
  ChatAttachment,
  ChatSnapshot,
  ConfigFile,
  ConfigOption,
  DiffStat,
  EnvReport,
  FileChange,
  FileContent,
  MergeResult,
  PipelinePhase,
  PrResult,
  PrStatus,
  PrSummary,
  ProjectPrompts,
  ProjectUpdate,
  ProjectView,
  PushResult,
  RemoteInfo,
  ReviewInboxItem,
  ServerInfo,
  SessionPayload,
  SidebarWorkspace,
  Workspace,
} from "./types";

let projects: ProjectView[] = [
  {
    id: "p1",
    name: "branchlab",
    root_path: "/Users/me/code/branchlab",
    default_branch: "main",
    default_model_key: "anthropic/claude-sonnet-4",
    account_id: null,
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
      {
        id: "p1-ws3",
        project_id: "p1",
        kind: "Worktree",
        path: "/Users/me/Library/Application Support/branchlab/worktrees/branchlab-messages-v2",
        branch: "feat/messages-v2",
        name: "Create a new conversation",
        base_branch: "main",
        init_prompt: null,
      },
      {
        id: "p1-ws4",
        project_id: "p1",
        kind: "Worktree",
        path: "/Users/me/Library/Application Support/branchlab/worktrees/branchlab-graphql-cache",
        branch: "spike/graphql-cache",
        name: "Abandoned spike",
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
    account_id: null,
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
    opencode: {
      found: true,
      path: "/usr/local/bin/opencode",
      version: "1.17.4",
    },
    git: { found: true, path: "/usr/bin/git", version: "2.45.0" },
    gh: { found: true, path: "/usr/local/bin/gh", version: "2.86.0" },
  });
}

export function addProject(path: string): Promise<ProjectView> {
  const p: ProjectView = {
    id: `p${Date.now()}`,
    name: path.split("/").pop() ?? path,
    root_path: path,
    default_branch: "main",
    default_model_key: null,
    account_id: null,
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

// ── GitHub accounts + review inbox (browser harness) ──

let mockAccounts: Account[] = [
  {
    id: "github.com/octocat",
    host: "github.com",
    login: "octocat",
    name: "The Octocat",
    avatarUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
    orgs: ["octocat", "acme"],
    active: true,
    status: null,
  },
  {
    id: "github.acme.com/m.mooibroek",
    host: "github.acme.com",
    login: "m.mooibroek",
    name: "Mark Mooibroek",
    avatarUrl: null,
    orgs: ["m.mooibroek", "sdbgroep"],
    active: true,
    status: null,
  },
];

const mockReviewInbox: ReviewInboxItem[] = [
  {
    id: "acme/web#128",
    accountId: "github.com/octocat",
    repo: "acme/web",
    number: 128,
    title: "Add rate limiting to the public API",
    url: "https://github.com/acme/web/pull/128",
    author: "alice",
    authorAvatar: "https://avatars.githubusercontent.com/u/1?v=4",
    reason: "review_requested",
    headRef: "feat/rate-limit",
    rollup: "pending",
    isDraft: false,
    updatedAt: "2026-07-03T09:12:00Z",
    projectId: "p1",
  },
  {
    id: "acme/web#131",
    accountId: "github.com/octocat",
    repo: "acme/web",
    number: 131,
    title: "Fix flaky auth integration test",
    url: "https://github.com/acme/web/pull/131",
    author: "bob",
    authorAvatar: null,
    reason: "assigned",
    headRef: "fix/flaky-auth",
    rollup: "failure",
    isDraft: false,
    updatedAt: "2026-07-02T16:40:00Z",
    projectId: null,
  },
  {
    id: "sdbgroep/portal#57",
    accountId: "github.acme.com/m.mooibroek",
    repo: "sdbgroep/portal",
    number: 57,
    title: "Migrate settings screen to new design system",
    url: "https://github.acme.com/sdbgroep/portal/pull/57",
    author: "carol",
    authorAvatar: null,
    reason: "review_requested",
    headRef: "design/settings",
    rollup: "success",
    isDraft: true,
    updatedAt: "2026-07-01T11:05:00Z",
    projectId: null,
  },
];

export function listAccounts(): Promise<Account[]> {
  return Promise.resolve(mockAccounts);
}

export function removeAccount(accountId: string): Promise<void> {
  mockAccounts = mockAccounts.filter((a) => a.id !== accountId);
  mockEmit("github:accounts", { accounts: mockAccounts });
  return Promise.resolve();
}

export function resyncGitHub(): Promise<void> {
  mockEmit("github:accounts", { accounts: mockAccounts });
  mockEmit("github:review_inbox", {
    items: mockReviewInbox,
    refreshedAt: Date.now(),
    error: null,
  });
  return Promise.resolve();
}

export function reviewInbox(): Promise<ReviewInboxItem[]> {
  return Promise.resolve(mockReviewInbox);
}

export function githubDetectAccount(
  _projectId: string,
): Promise<Account | null> {
  return Promise.resolve(mockAccounts[0] ?? null);
}

export function createWorkspaceFromPr(
  projectId: string,
  prNumber: number,
): Promise<Workspace> {
  const project = projects.find((p) => p.id === projectId);
  const branch = `pr-${prNumber}`;
  const ws: Workspace = {
    id: `${projectId}-${branch}`,
    project_id: projectId,
    kind: "Worktree",
    path: `/mock/${branch}`,
    branch,
    name: `PR #${prNumber}`,
    base_branch: project?.default_branch ?? "main",
    init_prompt: null,
    pr_number: prNumber,
    pr_url: `https://github.com/acme/web/pull/${prNumber}`,
  };
  if (project) project.workspaces.push(ws);
  return Promise.resolve(ws);
}

export function listProjectPrs(_projectId: string): Promise<PrSummary[]> {
  return Promise.resolve([
    {
      number: 140,
      title: "Add dark-mode toggle to settings",
      url: "https://github.com/acme/web/pull/140",
      author: "octocat",
      authorAvatar: "https://avatars.githubusercontent.com/u/583231?v=4",
      repo: "acme/web",
      headRef: "feat/dark-mode",
      baseRef: "main",
      isFork: false,
      isDraft: false,
      updatedAt: "2026-07-03T08:00:00Z",
      bucket: "mine",
    },
    {
      number: 128,
      title: "Add rate limiting to the public API",
      url: "https://github.com/acme/web/pull/128",
      author: "alice",
      authorAvatar: null,
      repo: "acme/web",
      headRef: "feat/rate-limit",
      baseRef: "main",
      isFork: false,
      isDraft: false,
      updatedAt: "2026-07-03T09:12:00Z",
      bucket: "review_requested",
    },
    {
      number: 131,
      title: "Fix flaky auth integration test",
      url: "https://github.com/acme/web/pull/131",
      author: "bob",
      authorAvatar: null,
      repo: "acme/web",
      headRef: "fix/flaky-auth",
      baseRef: "main",
      isFork: true,
      isDraft: false,
      updatedAt: "2026-07-02T16:40:00Z",
      bucket: "assigned",
    },
  ]);
}

export function refreshReviewInbox(): Promise<void> {
  mockEmit("github:review_inbox", {
    items: mockReviewInbox,
    refreshedAt: Date.now(),
    error: null,
  });
  return Promise.resolve();
}

let loginSeq = 0;

export function beginAccountLogin(host?: string): Promise<string> {
  loginSeq += 1;
  const loginId = `login-${loginSeq}`;
  const h = host ?? "github.com";
  const newAccount: Account = {
    id: `${h}/new-user`,
    host: h,
    login: "new-user",
    name: "Newly Added User",
    avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4",
    orgs: ["new-user"],
    active: true,
    status: null,
  };
  // Script the backend-driven device flow so the dialog renders every step.
  const step = (
    ms: number,
    phase: string,
    extra: Record<string, unknown> = {},
  ) =>
    setTimeout(() => {
      mockEmit("github:login", {
        loginId,
        phase,
        code: null,
        url: null,
        account: null,
        error: null,
        ...extra,
      });
    }, ms);
  step(200, "starting");
  step(600, "awaitingCode", {
    code: "WXYZ-1234",
    url: `https://${h}/login/device`,
  });
  step(2200, "polling");
  step(3600, "success", { account: newAccount });
  setTimeout(() => {
    if (!mockAccounts.some((a) => a.id === newAccount.id)) {
      mockAccounts = [...mockAccounts, newAccount];
    }
    mockEmit("github:accounts", { accounts: mockAccounts });
  }, 3600);
  return Promise.resolve(loginId);
}

export function cancelAccountLogin(_loginId: string): Promise<void> {
  return Promise.resolve();
}

export function addAccountWithToken(
  token: string,
  host?: string,
): Promise<Account> {
  const h = host ?? "github.com";
  const acct: Account = {
    id: `${h}/token-user`,
    host: h,
    login: "token-user",
    name: "Token User",
    avatarUrl: null,
    orgs: ["token-user"],
    active: true,
    status: null,
  };
  void token;
  if (!mockAccounts.some((a) => a.id === acct.id)) {
    mockAccounts = [...mockAccounts, acct];
  }
  mockEmit("github:accounts", { accounts: mockAccounts });
  return Promise.resolve(acct);
}

export function startServer(workspaceId: string): Promise<ServerInfo> {
  return Promise.resolve({
    workspace_id: workspaceId,
    base_url: "http://127.0.0.1:9999",
    port: 9999,
  });
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

export function updateProject(
  projectId: string,
  update: ProjectUpdate,
): Promise<ProjectView> {
  const p = projects.find((x) => x.id === projectId);
  if (!p) return Promise.reject(new Error("unknown project"));
  if (update.name) p.name = update.name;
  if (update.default_branch) p.default_branch = update.default_branch;
  if (update.default_model_key !== undefined)
    p.default_model_key = update.default_model_key;
  if (update.prompts) p.prompts = update.prompts;
  return Promise.resolve(p);
}

export function getProjectPrompts(projectId: string): Promise<ProjectPrompts> {
  const p = projects.find((x) => x.id === projectId);
  return Promise.resolve(
    p?.prompts ?? {
      init_workspace: null,
      commit: null,
      merge: null,
      push: null,
      create_pr: null,
    },
  );
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

export function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<void> {
  for (const p of projects) {
    const w = p.workspaces.find((x) => x.id === workspaceId);
    if (w) w.name = name;
  }
  return Promise.resolve();
}

const diffStats: Record<string, DiffStat> = {
  "p1-ws1": { files: 3, insertions: 42, deletions: 7 },
  "p1-ws2": { files: 2, insertions: 21, deletions: 4 },
  "p1-ws4": { files: 1, insertions: 3, deletions: 1 },
  "p2-base": { files: 12, insertions: 120, deletions: 45 },
};

export function workspaceDiffStat(workspaceId: string): Promise<DiffStat> {
  return Promise.resolve(
    diffStats[workspaceId] ?? { files: 0, insertions: 0, deletions: 0 },
  );
}

export function workspaceChanges(): Promise<FileChange[]> {
  return Promise.resolve([
    { path: "src/App.tsx", status: "modified", insertions: 10, deletions: 2 },
    {
      path: "src/components/Sidebar.tsx",
      status: "modified",
      insertions: 20,
      deletions: 5,
    },
  ]);
}

// Realistic unified diffs so the changes panel renders hunks, line numbers,
// and the inline review-comment flow in the browser harness.
const MOCK_DIFFS: Record<string, string> = {
  "src/App.tsx": `diff --git a/src/App.tsx b/src/App.tsx
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -42,11 +42,17 @@ export function App() {
   const [settingsOpen, setSettingsOpen] = useState(false);

   useEffect(() => {
-    const onKey = (e: KeyboardEvent) => e.key === "k" && openPalette();
+    const onKey = (e: KeyboardEvent) => {
+      if (e.key === "Escape" && settingsOpen) {
+        setSettingsOpen(false);
+        return;
+      }
+      if (e.key === "k" && e.metaKey) openPalette();
+    };
     window.addEventListener("keydown", onKey);
     return () => window.removeEventListener("keydown", onKey);
-  }, []);
+  }, [settingsOpen]);

   return (
     <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
`,
  "src/components/Sidebar.tsx": `diff --git a/src/components/Sidebar.tsx b/src/components/Sidebar.tsx
--- a/src/components/Sidebar.tsx
+++ b/src/components/Sidebar.tsx
@@ -18,9 +18,14 @@ export function Sidebar({ sessions }: SidebarProps) {
   const grouped = groupByProject(sessions);

+  // Sessions waiting on the user sort above everything else.
+  const ordered = grouped.sort(
+    (a, b) => Number(b.needsAttention) - Number(a.needsAttention),
+  );
+
   return (
     <nav aria-label="Sessions">
-      {grouped.map((group) => (
+      {ordered.map((group) => (
         <SessionGroup key={group.id} group={group} />
       ))}
     </nav>
`,
};

export function workspaceFileDiff(
  _workspaceId: string,
  path: string,
): Promise<string> {
  return Promise.resolve(MOCK_DIFFS[path] ?? MOCK_DIFFS["src/App.tsx"]);
}

export function discardFile(): Promise<void> {
  return Promise.resolve();
}

export function workspaceFiles(): Promise<string[]> {
  return Promise.resolve(["src/App.tsx", "src/components/Sidebar.tsx"]);
}

export function readFile(): Promise<FileContent> {
  return Promise.resolve({
    path: "mock",
    content: "mock content",
    binary: false,
    truncated: false,
    size: 12,
  });
}

export function commitWorkspace(): Promise<string> {
  return Promise.resolve("abc1234");
}

export function mergeWorkspace(): Promise<MergeResult> {
  return Promise.resolve({
    branch: "feature",
    base: "main",
    summary: "merged",
  });
}

export function pushWorkspace(): Promise<PushResult> {
  return Promise.resolve({ branch: "feature", remote: "origin", output: "ok" });
}

export function createWorkspacePr(): Promise<PrResult> {
  return Promise.resolve({
    branch: "feature",
    base: "main",
    url: "https://github.com/test/pr/1",
  });
}

export function listRemotes(): Promise<RemoteInfo[]> {
  return Promise.resolve([
    { name: "origin", url: "git@github.com:test/repo.git" },
  ]);
}

// ── Backend orchestration mocks: drive the event bus so the browser harness
//    renders git badges, changes, and the PR bar without a Rust backend. ──

// ── Chat mocks: a scripted streaming turn so the browser harness renders the
//    transcript, streaming, collapse, and config selectors without a backend. ──

const MOCK_CONFIG: ConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    description: null,
    category: "mode",
    currentValue: "build",
    choices: [
      { value: "build", name: "build", description: null, group: null },
      { value: "plan", name: "plan", description: null, group: null },
    ],
  },
  {
    id: "model",
    name: "Model",
    description: null,
    category: "model",
    currentValue: "anthropic/claude-opus-4-8",
    choices: [
      {
        value: "anthropic/claude-opus-4-8",
        name: "Anthropic/Claude Opus 4.8",
        description: null,
        group: null,
      },
      {
        value: "anthropic/claude-sonnet-5",
        name: "Anthropic/Claude Sonnet 5",
        description: null,
        group: null,
      },
      {
        value: "opencode/big-pickle",
        name: "OpenCode Zen/Big Pickle",
        description: null,
        group: null,
      },
    ],
  },
  // opencode advertises a dynamic `effort` option (category thoughtLevel) once
  // a variant-capable model is selected; the composer renders it generically.
  {
    id: "effort",
    name: "Effort",
    description: "Available effort levels for this model",
    category: "thoughtLevel",
    currentValue: "medium",
    choices: [
      { value: "low", name: "Low", description: null, group: null },
      { value: "medium", name: "Medium", description: null, group: null },
      { value: "high", name: "High", description: null, group: null },
      { value: "xhigh", name: "Xhigh", description: null, group: null },
      { value: "max", name: "Max", description: null, group: null },
    ],
  },
];

let mockSeq = 100;
const nextSeq = () => ++mockSeq;

export function chatOpen(workspaceId: string): Promise<ChatSnapshot> {
  // Seed config so the selectors render immediately.
  setTimeout(
    () => mockEmit("chat:config", { workspaceId, options: MOCK_CONFIG }),
    30,
  );
  return Promise.resolve({
    conversationId: `conv-${workspaceId}`,
    entries: [],
    headSeq: 0,
    hasMore: false,
    config: MOCK_CONFIG,
    commands: [
      { name: "caveman", description: "Ultra-compressed communication" },
      { name: "compress", description: "Compress memory files" },
    ],
  });
}

export function chatHistory(): Promise<ChatSnapshot> {
  return Promise.resolve({
    conversationId: "",
    entries: [],
    headSeq: 0,
    hasMore: false,
    config: [],
    commands: [],
  });
}

export function chatSend(args: {
  workspaceId: string;
  display: string;
  sent: string;
  attachments?: ChatAttachment[];
}): Promise<void> {
  const ws = args.workspaceId;
  const userSeq = nextSeq();
  const turnSeq = nextSeq();
  const now = Date.now();

  mockEmit("chat:entry", {
    workspaceId: ws,
    entry: {
      type: "user",
      seq: userSeq,
      entryId: `u-${userSeq}`,
      display: args.display,
      sent: args.sent,
      attachments: args.attachments ?? [],
      model: null,
      variant: null,
      agent: null,
      origin: "user",
      createdAt: now,
    },
  });
  mockEmit("chat:entry", {
    workspaceId: ws,
    entry: {
      type: "assistant",
      seq: turnSeq,
      entryId: `a-${turnSeq}`,
      engineSessionId: 1,
      status: "queued",
      origin: "user",
      blocks: [],
      summary: {
        collapsed: false,
        stepCount: 0,
        filesEdited: [],
        commandsRun: 0,
        headline: "",
      },
      usage: null,
      startedAt: now,
      endedAt: null,
    },
  });

  const block = (block: unknown) =>
    mockEmit("chat:block", {
      workspaceId: ws,
      entrySeq: turnSeq,
      block,
      textAppend: null,
    });
  // Stream a reasoning step, a tool call, then the answer.
  setTimeout(
    () =>
      block({
        type: "reasoning",
        blockId: "r1",
        text: "Thinking about the request…",
      }),
    150,
  );
  setTimeout(
    () =>
      block({
        type: "tool",
        blockId: "t1",
        callId: "c1",
        name: "edit",
        title: "Edit file",
        status: "completed",
        input: { file: "src/app.ts" },
        output: null,
        diff: {
          path: "src/app.ts",
          oldText: "const x = 1;\n",
          newText: "const x = 2;\n",
          unified: null,
        },
        error: null,
      }),
    500,
  );
  setTimeout(
    () =>
      block({
        type: "text",
        blockId: "m1",
        text: "Done — I updated `src/app.ts`.",
      }),
    900,
  );
  setTimeout(
    () =>
      mockEmit("chat:context", { workspaceId: ws, used: 12000, max: 200000 }),
    950,
  );
  setTimeout(
    () =>
      mockEmit("chat:turn", {
        workspaceId: ws,
        entrySeq: turnSeq,
        status: "completed",
        summary: {
          collapsed: true,
          stepCount: 2,
          filesEdited: ["src/app.ts"],
          commandsRun: 0,
          headline: "Edited 1 file",
        },
        usage: null,
      }),
    1100,
  );
  return Promise.resolve();
}

export function chatGenerateTitle(
  _workspaceId: string,
  text: string,
): Promise<string | null> {
  return Promise.resolve(text.split(/\s+/).slice(0, 5).join(" ") || null);
}
export function chatAbort(): Promise<void> {
  return Promise.resolve();
}
export function chatSetConfig(): Promise<void> {
  return Promise.resolve();
}
export function chatAnswerPermission(): Promise<void> {
  return Promise.resolve();
}
export function chatNewSession(): Promise<void> {
  return Promise.resolve();
}

export function workspaceTools(): Promise<{
  mcp: { name: string; status: string; error?: string }[];
  lsp: { id: string; status?: string }[];
}> {
  return Promise.resolve({
    mcp: [
      { name: "playwright", status: "connected" },
      { name: "figma", status: "failed", error: "auth required" },
    ],
    lsp: [{ id: "typescript", status: "running" }],
  });
}
export function mcpConnect(): Promise<void> {
  return Promise.resolve();
}
export function mcpDisconnect(): Promise<void> {
  return Promise.resolve();
}

export function setAutofixMode(): Promise<void> {
  return Promise.resolve();
}

export function requestGitRefresh(): Promise<void> {
  return Promise.resolve();
}

export function setActiveWorkspace(workspaceId: string | null): Promise<void> {
  if (!workspaceId) return Promise.resolve();
  // The active workspace also gets the full changes list…
  void workspaceChanges().then((changes) =>
    mockEmit("workspace:git", {
      workspaceId,
      diffStat: diffStats[workspaceId] ?? {
        files: 2,
        insertions: 30,
        deletions: 7,
      },
      changes,
    }),
  );
  // …and, for a worktree, its PR pipeline (so the bar renders on open).
  const ws = projects
    .flatMap((p) => p.workspaces)
    .find((w) => w.id === workspaceId);
  if (ws?.kind === "Worktree") {
    void workspacePrStatus().then((status) =>
      mockEmit("workspace:pr", {
        workspaceId,
        status,
        phase: "failing",
        attempts: 0,
        mode: ws.autofix_mode ?? "off",
        error: null,
      }),
    );
  }
  return Promise.resolve();
}

export function getSidebarSnapshot(): Promise<SidebarWorkspace[]> {
  // One of each sidebar state, so the two-row list can be reviewed in the
  // browser harness: working+PR-pending, awaiting-input+failing PR,
  // merged PR (idle), closed PR + failed turn, finished-unseen (base).
  const session: Record<string, Partial<SessionPayload>> = {
    "p1-ws1": { activity: "working" },
    "p1-ws2": { awaitingInput: true, needsAttention: true },
    "p1-ws4": { error: "engine closed" },
    "p2-base": { needsAttention: true },
  };
  const pr: Record<string, { status: PrStatus; phase: PipelinePhase }> = {
    "p1-ws1": { status: mockPr(712, "OPEN", "pending"), phase: "running" },
    "p1-ws2": { status: mockFailingPr(), phase: "failing" },
    "p1-ws3": { status: mockPr(666, "MERGED", "none"), phase: "idle" },
    "p1-ws4": { status: mockPr(91, "CLOSED", "none"), phase: "idle" },
  };
  const out: SidebarWorkspace[] = [];
  for (const p of projects) {
    for (const w of p.workspaces) {
      const st = session[w.id] ?? {};
      out.push({
        workspaceId: w.id,
        diffStat: diffStats[w.id] ?? { files: 0, insertions: 0, deletions: 0 },
        session: {
          workspaceId: w.id,
          activity: st.activity ?? "idle",
          awaitingInput: st.awaitingInput ?? false,
          needsAttention: st.needsAttention ?? false,
          error: st.error ?? null,
        },
        pr: {
          workspaceId: w.id,
          status: pr[w.id]?.status ?? null,
          phase: pr[w.id]?.phase ?? "idle",
          attempts: 0,
          mode: "off",
          error: null,
        },
      });
    }
  }
  return Promise.resolve(out);
}

export function refreshPrStatus(): Promise<void> {
  return Promise.resolve();
}

/** The failing PR (with checks) used by the pipeline bar demo. */
function mockFailingPr(): PrStatus {
  return {
    number: 42,
    url: "https://github.com/test/repo/pull/42",
    state: "OPEN",
    head_branch: "feature",
    head_sha: "abc1234",
    rollup: "failure",
    checks: [
      {
        name: "lint",
        bucket: "success",
        state: "SUCCESS",
        url: null,
        workflow: "CI",
      },
      {
        name: "test",
        bucket: "failure",
        state: "FAILURE",
        url: null,
        workflow: "CI",
      },
      {
        name: "build",
        bucket: "pending",
        state: "IN_PROGRESS",
        url: null,
        workflow: "CI",
      },
    ],
  };
}

/** A minimal PrStatus for the sidebar mock states. */
function mockPr(
  number: number,
  state: string,
  rollup: PrStatus["rollup"],
): PrStatus {
  return {
    number,
    url: `https://github.com/test/repo/pull/${number}`,
    state,
    head_branch: "feature",
    head_sha: `sha-${number}`,
    rollup,
    checks:
      rollup === "pending"
        ? [
            {
              name: "build",
              bucket: "pending",
              state: "IN_PROGRESS",
              url: null,
              workflow: "CI",
            },
          ]
        : [],
  };
}

export function workspacePrStatus(): Promise<PrStatus | null> {
  // A failing pipeline so the pipeline bar and Off/Auto/Super control are
  // visible in the browser harness. Stable head_sha so the autofix loop only
  // triggers once (the mocked opencode server doesn't actually push).
  return Promise.resolve({
    number: 42,
    url: "https://github.com/test/repo/pull/42",
    state: "OPEN",
    head_branch: "feature",
    head_sha: "abc1234",
    rollup: "failure",
    checks: [
      {
        name: "lint",
        bucket: "success",
        state: "SUCCESS",
        url: "https://github.com/test/repo/actions/1",
        workflow: "CI",
      },
      {
        name: "test",
        bucket: "failure",
        state: "FAILURE",
        url: "https://github.com/test/repo/actions/2",
        workflow: "CI",
      },
      {
        name: "build",
        bucket: "success",
        state: "SUCCESS",
        url: "https://github.com/test/repo/actions/3",
        workflow: "CI",
      },
    ],
  });
}

export function readConfig(): Promise<ConfigFile> {
  return Promise.resolve({
    path: "/mock/opencode.json",
    content: "{}",
    exists: true,
  });
}

export function writeConfig(): Promise<string> {
  return Promise.resolve("/mock/opencode.json");
}

let mockDefaultModel: string | null = "anthropic/claude-sonnet-4";

export function getDefaultModel(): Promise<string | null> {
  return Promise.resolve(mockDefaultModel);
}

export function setDefaultModel(model: string): Promise<void> {
  mockDefaultModel = model || null;
  return Promise.resolve();
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

export function logPath(): Promise<string | null> {
  return Promise.resolve("/tmp/branchlab.log");
}
