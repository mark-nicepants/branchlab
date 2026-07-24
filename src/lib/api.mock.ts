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
  GeneratedTitle,
  PipelinePhase,
  PrResult,
  PrStatus,
  PrSummary,
  ProjectUpdate,
  ProjectView,
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

// A single mock account: an AI-generated face (thispersondoesnotexist.com),
// inlined as a data URI so the harness needs no network.
const MOCK_AVATAR =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAkGBwgHBgkIBwgKCgkLDRYPDQwMDRsUFRAWIB0iIiAdHx8kKDQsJCYxJx8fLT0tMTU3Ojo6Iys/RD84QzQ5Ojf/2wBDAQoKCg0MDRoPDxo3JR8lNzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzf/wAARCACAAIADASIAAhEBAxEB/8QAGwAAAwEBAQEBAAAAAAAAAAAABAUGAwcCAQD/xAA3EAACAQMCBAQFAgUEAwEAAAABAgMABBEFIRIxQVEGEyJhFHGBkaEyQgcjscHwFVJi0UNTcvH/xAAYAQEBAQEBAAAAAAAAAAAAAAACAwEEAP/EAB4RAAMBAQEAAwEBAAAAAAAAAAABAhEhMQMSQVEi/9oADAMBAAIRAxEAPwAyNssnmrmTBPfej7WaByY3BMit6uLPLpj6Yqd02/FuTFccUU6sfNR13Vs9Ka6Zdh5GlK7KSqtzBGBzrkUnRQwm1GOWa4tBblZrpBHHOF9Sb+/2pJrEtwNQn9LtbboDHgnhUY3+1M9PLy6q1zIqERgsTjYED360iWYpqBEE8jRMxfzMc8869P8Al6ec6j6LmKXBCgdwK1l1FbePCAt12Pah9SuYLibMUCo3NmQYz9KT37sF2ZtuijJ/FdF/O6WAj4FL02uNfu/MeRYyqnkCMmgbzxJcyReWRwnqd6DmlkbJjiI93yT+KX+S8rkSKflWK2a4Q3sfEl3BJw2+FzscAcqe2niHy2IdmBbdgxH3qPuLd7fDxqcAb961SZp4Mhm4h05Vrtsz6I6PaZuwZ1cbAbqdj86/GSeGZVWIkdNtq59Z6rc6fMrQl1XqrNnNV2mauuow5RwrLsVc43oeG5o/tx56lbjBwcgjagLq8mhlKKhI4yoY7kgVtZTq2WlXhUbDJ51td26Xqo/EOFWyCp/FaqC5Mo7oOoKrg43TOSK9CTi3II+W4rM6bCR6HkjYHIwdvzXiS0uY1D+YCRgkY5/WrT8iSJuG2VvjLwtBqzG8s41W8A3AG02Oh9/epDTHbT2Mc8QBBCvG2xVscsH5V0gXkc0SSRksCMnBO3zNK9e0m11OESspSVRlJYxk/IjqK5d/h0JfjFFmkb2sw5B1Iz7H2+9QWp3EdnN8LFu6nBxyp/q15daPayW91HwSg/qHIqBgY/Nc41W8eN2f97cz/ailrKeIcy6mkCjOC3RRyFZw6mrnB4uEjGFGCaUaRY3F/LnkOZJ6V0nw74RjVFlnUjPTG9ZTS4OJb6SsUEs7sfhyCerbkiiU0G6mdQifjGK6hbaPbQrhIlB71q1tHEvpUDvWa/RZPhzdvCty0JEhGe2Kn7/QrmwYsqNt/tNdgcDfagL22ilUhwKKtoT+OWcZaUglJVOezGtILx7KVZYhlDsynqKrPEfh+N1Z4l36EVDzK8TlJBuNj71eWmc9z9ToVteQPaxyrMTEwzuM4pnp13HImYl9LYyQP61z/wANlZLj4VnHr2j4uWe1PZre/sJOKJGRM8yOfttzrcJlXM/lOSxJXuOdbKyzIQSG7ZqYsdWd5Ss8qBcfqYhfxTayvEl4vKPGFHqO2P8AOdePBuka0QzSWkknAjFSN+E7bHt3qjsdVWeExyYWUZAJYY+lI4re3mtZUMfkySYwDhRigdQDWdoqqFw3pEsZ/TgH7dBRYl0ReNdTN3qK2qseFSCQTk532/vUdewB541G+TkV51O6I1Ccox2chSeeM86ItSbnUbaFBlicVng13h0Xwbo0MVpHLIgLcx2z3qwX0jagNHg8q3SMdBTXyigy2BUOs6fOHzjYDnWUrkjevrzog6ULJcqx50/wOHiVzQU7tjeiJJl7ihppEI5ijgxVdtxAqetRniTTF3mQbH9VXFxFxeoUh1lOO2lTrg054yVrUc/hcxPlGIdTmuyeG9RTV9DjWb1K2zAkelh2/tXHODjfI/UDg/Or/wDh1Pi0midmADBgB9f+hVaOdFXf6Bp12yNFFwPyyu2e5JoOTwo8JL203Hls79fodqeJORw7gLnljGa2aYIBwsoBO+P6ChppKjUk4uGYPGQNlABye3tWdzds0RILcSjIU4xRHi3w4+ig3NoryWQ2JJy0PzPMr79Km5LjFqZGYSLjGcDb7VumpdIbUMi+mDZ2dj+ao/4dW/xmvNMwysEZI+ZOKWanZvLEbsyIzyMcJ+4DuftVf/Ci1EcV5Iw9TMoz969TX0Yplq1pcyXEtuAIQM45npSq+vNaKloMEc+1ba2morg2VqZs8twAPnUdqD+LAOKOFgM7qHWoz0vXFrCxr2qRzcN0gwOeKbWmpG5TIBqLil1V3X4yByWODtkirXwvp0jq/nrjoK9XGKWs0HvdU8rPUjpSeTVtQuH4bdAv96O8RWbx3PDEM5NTc/8AriE/BWrKoPM4ya2ehprCghuNWjHFK6b/ALcV4kme44hKgDe3I1Px3uuxcLXETsDzBxTuzczqHKspxkgjlT8fSb6uEReKbXVpoj+ktkVW+DpZIHdCMiXkRU/4itidVDDPqAyapvDk3wtvAWt3k9Rw46VSnwipetlyjBWVVycd62ErBchhuN8jmKXW2qWjo+JcOD6uIEBce+K1t723nfiikUqTjJbn8hQPFO2p28kLLKVZSCDncEe9cY8Qm1stduYdN4pbPOSn7Y26ge29Or6/a1EhWTjiTcYJ/rUxYtKxnlDsvmDDN3700jXwItok1K4YAAFR+ldtuY2/FVvgVTALhGGPUDUXok3wus27ndGcI3Yg7f58q6FY2n+n3JAcMrjIxzG/X71C1h0zX2Sf8KmJ1ZgrjKmgdW0K2ucsGkjP/BudeobhQKyu9VSNTxuAKKzBJPdQFa+HbSFuIl5GH+408tIFVgqLtUxZa0dT1IWsD+XEoJd++OgqnhuYbbPFJnA2Oa9+m0mTmsxqbvcCvKaPbXSBjxKf+LYrzrE8U8wCyhWLdDQlhqxtblrWZwwH6X71p5IMbQLeIZLM3/0c0HPbxwqVQU2mv0dOeaTXswIJFKUG0S+oQrJqS8X+2qPTbfyIFgZXxjOeXPpScwrNfo5BODhuwFNob+BpOB5OGQcgTsfvTZCniwaJJlCkiKRkEDv2J96xmsYJZPPKHzCMZB4frtivoPEpxy9xWC3sZfgBw/LBGM1iBpPeJbv4iUWcaMpBzJnt2pZHOI14cY9vbFMjbzzQyahKMSXDEjPQUtniZ7tUCkMoy2+Pl/SrcD3TGJeOffkCcGr3Ttcj1S5NuUKzonE22M8hUXmG2J5nbJIPat9AvfhNZtmk/wDMSrE+4/7qN9LR/ksLm7kgYjtU/ql68xwWIzyFUl7Asw4h1FTeqafLnNuMyY9INRR0J4NfD+libT5eatJkBwcEe4pVdQ6tpkjJcSSyJyBJJB+tY2F14iinNnJw2zAHg9OzfI9aZTWWuvDI81wrhVBxk75p501P+sSGSeeTPG6H2oloXMWSx485ya83Om6hEeJ3APDxbH8Uqub3UEuxZwqszE4J7fWlm+Bbz9H1peOfQTuOdEzSFqEgsmhUSStlsb1uo45AOlGTLfAm1t8ZYrls75HKmJhjYv52JI224GGRmsEThYMnMkZJ6itZG8uLzJGCoMZLHH5pnMzOSAxKXtYk4t8gnB+QNKpZbyQ4NskbrJsS4HKnNpdQTOVSSKXG54HBNLL62je5kKkv6/3ncHtSQWCQ3YnTgQ+lRgewFLrsqkzzKHKbbqNjRt9oU2nXK/DuXhk/Tjnnt9qJXSZbwNxuI0CgqB1PavNjJZ3mupwApVS24I5Cvl+GfUIoo9n4ljXB3z1/rTSWP/TJGjuR/MUegAcx3+9e/D+kvc6gl/cqQFkHAp233JJ+uPvQdYNTvhVM8sBEUm+QCD3oixh82TiIyRWmqwGS2SRB/MjGR70HpeoxpIA5wTsah6WQw1DhVP5kayKOaOMg0lmvbJgyxzXUDHAIWTI2+dVzQw3cWCRuOdKLrw3CxJEmPpTlsoqXjRM3bxTnHn3E7dMtgfjFebGzSFi/CMnoKdPoyw7K+fpWUyRwDAO4pa/A3S/FgLcnYL2516t7ORuGR1/lnOa8Wxjnu+BnG27DNOvPWMcLYVF59hWysIXW8F6vH8OT5iiINgSE4Ga3yssBXKsMYKtXzWLSO+t8oRxruABzoGHzY5AZ4mUtt5itlG6j600iDP1tLZW0fnK8cKybbgjiApo0VvPCJIz5iybh496mAsTTuiqSON154PPNPIWjgWNQ6gBfSvFyB602g6EyXPluPjrOeNFbKyFcqPqNqYRNE6gpuhHMCnwjR1IIBB57bUhvLddOlzECLRjuv/qPcf8AE/j5cuV069NMpoIxL5nAhC7eoZrZoldY5Ux2Py//AGs3Ku64Ppx/hFaWzKpaJT6WGR7Giy3xXjw1mAMWD2qT1S3aCUyR8iaqmYhd+tJ9QjDq3UdqxHSL7DXprYcD+oCjT4kJHWp6ePgcisxkCmj2oe3Ots6+kbnrSe8v3EMkpP6QT86ywTzrWyaA3aR3IykmVHsapJG64aeGfLaNC8LmXJLOR796oXDA5AJy2+eVDoVtAEiU4wAABvRC3iq+JQwOOLcdM09IsyMpiiVj5cI4sHO32FaCOO6glimAdSwKnPI9DXq5jtrgL5rKXVuJVzvn5UK11HAePy5COZCp/WtCKWspLeZ1MZZSx9WeWOpr1AZY5fIClon9StkgjH9s9Kc2t7DdepR6f3bZx7Ulv7mW2c+XHKzo3p8wbcHT/PekmHD/2Q==";

let mockAccounts: Account[] = [
  {
    id: "github.com/alex-morgan",
    host: "github.com",
    login: "alex-morgan",
    name: "Alex Morgan",
    avatarUrl: MOCK_AVATAR,
    orgs: ["alex-morgan", "branchlab"],
    active: true,
    status: null,
  },
];

const mockReviewInbox: ReviewInboxItem[] = [
  {
    id: "acme/web#128",
    accountId: "github.com/alex-morgan",
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
    accountId: "github.com/alex-morgan",
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
    accountId: "github.com/alex-morgan",
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

// Used internally by restartServer; the app drives server lifecycle via events.
function startServer(workspaceId: string): Promise<ServerInfo> {
  return Promise.resolve({
    workspace_id: workspaceId,
    base_url: "http://127.0.0.1:9999",
    port: 9999,
  });
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
let quickChats: Workspace[] = [];

export function createQuickChat(initPrompt?: string): Promise<Workspace> {
  quickChatSeq += 1;
  const id = `quick-${quickChatSeq}`;
  const ws: Workspace = {
    id,
    project_id: "__quick__",
    kind: "QuickChat",
    path: `/mock/quick-chats/${id}`,
    branch: null,
    name: null,
    base_branch: null,
    init_prompt: initPrompt ?? null,
  };
  quickChats.push(ws);
  return Promise.resolve(ws);
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

export function removeWorkspace(workspaceId: string): Promise<void> {
  for (const p of projects) {
    p.workspaces = p.workspaces.filter((w) => w.id !== workspaceId);
  }
  quickChats = quickChats.filter((w) => w.id !== workspaceId);
  return Promise.resolve();
}

export function listWorkspaces(): Promise<Workspace[]> {
  return Promise.resolve([
    ...projects.flatMap((p) => p.workspaces),
    ...quickChats,
  ]);
}

export function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<void> {
  for (const w of [...projects.flatMap((p) => p.workspaces), ...quickChats]) {
    if (w.id === workspaceId) w.name = name;
  }
  return Promise.resolve();
}

export function renameWorkspaceBranch(
  workspaceId: string,
  branch: string,
): Promise<string | null> {
  // Mirror the backend sanitizer: slug each /-segment, keep the prefix.
  const sanitized = branch
    .split("/")
    .map((seg) =>
      seg
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join("/")
    .slice(0, 60);
  for (const w of projects.flatMap((p) => p.workspaces)) {
    if (
      w.id === workspaceId &&
      w.kind === "Worktree" &&
      !w.pr_number &&
      sanitized
    ) {
      w.branch = sanitized;
      return Promise.resolve(sanitized);
    }
  }
  return Promise.resolve(null);
}

export function clearInitPrompt(workspaceId: string): Promise<void> {
  for (const w of [...projects.flatMap((p) => p.workspaces), ...quickChats]) {
    if (w.id === workspaceId) w.init_prompt = null;
  }
  return Promise.resolve();
}

const diffStats: Record<string, DiffStat> = {
  "p1-ws1": { files: 3, insertions: 42, deletions: 7 },
  "p1-ws2": { files: 2, insertions: 21, deletions: 4 },
  "p1-ws4": { files: 1, insertions: 3, deletions: 1 },
  "p2-base": { files: 12, insertions: 120, deletions: 45 },
};

// Used internally by setActiveWorkspace's event simulation.
function workspaceChanges(): Promise<FileChange[]> {
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

export function createWorkspacePr(): Promise<PrResult> {
  return Promise.resolve({
    branch: "feature",
    base: "main",
    url: "https://github.com/test/pr/1",
  });
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
  const turn = (status: string, headline: string) =>
    mockEmit("chat:turn", {
      workspaceId: ws,
      entrySeq: turnSeq,
      status,
      summary: {
        collapsed: true,
        stepCount: 8,
        filesEdited: ["src-tauri/src/config.rs"],
        commandsRun: 3,
        headline,
      },
      usage: null,
      endedAt: status === "completed" ? Date.now() : null,
    });
  const t = (ms: number, fn: () => void) => setTimeout(fn, ms);

  // A showcase turn exercising every step kind the renderer supports:
  // streamed thought, read, search, failed command, edit+diff, fetch,
  // subagent, a (filtered) todo update, and a permission-gated command.
  t(100, () => turn("streaming", ""));
  t(150, () =>
    block({
      type: "reasoning",
      blockId: "r1",
      text: "The failure is in config parsing — the test expects a trailing…",
    }),
  );
  t(450, () =>
    block({
      type: "reasoning",
      blockId: "r1",
      text: "The failure is in config parsing — the test expects a trailing newline to be preserved.\n\nTwo options: normalize in `read_config` or fix the fixture. **Normalizing is safer** because three call sites depend on the current behavior.",
    }),
  );
  t(650, () =>
    block({
      type: "tool",
      blockId: "t-read",
      callId: "c-read",
      name: "read",
      title: "Read config.rs",
      status: "completed",
      input: { filePath: "src-tauri/src/config.rs", offset: 88, limit: 52 },
      output: null,
      diff: null,
      locations: [{ path: "src-tauri/src/config.rs", line: 88 }],
      startedAt: now + 400,
      endedAt: now + 640,
    }),
  );
  t(900, () =>
    block({
      type: "tool",
      blockId: "t-grep",
      callId: "c-grep",
      name: "grep",
      title: "Search read_config(",
      status: "completed",
      input: { pattern: "read_config\\(" },
      output:
        "src-tauri/src/commands.rs:527\nsrc-tauri/src/chat/manager.rs:214\nsrc-tauri/src/config.rs:96",
      diff: null,
    }),
  );
  t(1200, () =>
    block({
      type: "tool",
      blockId: "t-test",
      callId: "c-test",
      name: "bash",
      title: "cargo test config::",
      status: "failed",
      input: { command: "cargo test config::" },
      output:
        'running 3 tests\ntest config::parses_defaults ... ok\ntest config::merges_project ... ok\ntest config::preserves_trailing_newline ... FAILED\n\nassertion `left == right` failed\n  left:  "model = \\"x\\""\n  right: "model = \\"x\\"\\n"',
      diff: null,
      rawOutput: { exitCode: 101 },
      startedAt: now + 900,
      endedAt: now + 5100,
    }),
  );
  t(1550, () =>
    block({
      type: "tool",
      blockId: "t-edit",
      callId: "c-edit",
      name: "edit",
      title: "Edit config.rs",
      status: "completed",
      input: { filePath: "src-tauri/src/config.rs" },
      output: null,
      diff: {
        path: "src-tauri/src/config.rs",
        oldText:
          "pub fn read(dir: &Path) -> ConfigFile {\n    let content = fs::read_to_string(&path).unwrap_or_default();\n    ConfigFile { path, content }\n}\n",
        newText:
          "pub fn read(dir: &Path) -> ConfigFile {\n    let mut content = fs::read_to_string(&path).unwrap_or_default();\n    if !content.is_empty() && !content.ends_with('\\n') {\n        content.push('\\n');\n    }\n    ConfigFile { path, content }\n}\n",
      },
    }),
  );
  t(1850, () =>
    block({
      type: "tool",
      blockId: "t-fetch",
      callId: "c-fetch",
      name: "fetch",
      title: "docs.rs",
      status: "completed",
      input: { url: "https://docs.rs/toml/latest/toml/" },
      output: "toml — A serde-compatible TOML decoder and encoder for Rust…",
      diff: null,
    }),
  );
  t(2150, () =>
    block({
      type: "tool",
      blockId: "t-task",
      callId: "c-task",
      name: "task",
      title: "Verify call sites",
      status: "completed",
      input: {
        description: "Verify the fix doesn't break other config call sites",
      },
      output:
        "Checked all three call sites of `read_config`. The normalization is **additive** — no caller depends on a missing trailing newline. Safe.",
      diff: null,
    }),
  );
  // Todo update — must NOT appear in the transcript (rendered by the strip).
  t(2350, () =>
    block({
      type: "tool",
      blockId: "t-todo",
      callId: "c-todo",
      name: "todowrite",
      title: "Update todos",
      status: "completed",
      input: {
        todos: [
          { content: "Reproduce the failing test", status: "completed" },
          { content: "Fix newline normalization", status: "completed" },
          { content: "Push and confirm CI", status: "in_progress" },
        ],
      },
      output: null,
      diff: null,
    }),
  );
  // Permission-gated push: block stays running until answered.
  t(2600, () => {
    block({
      type: "tool",
      blockId: "t-push",
      callId: "c-push",
      name: "bash",
      title: "git push",
      status: "running",
      input: { command: "git push origin feature/fix-config-parser" },
      output: null,
      diff: null,
    });
    turn("awaitingPermission", "");
    mockEmit("chat:permission", {
      workspaceId: ws,
      entrySeq: turnSeq,
      requestId: `perm-${turnSeq}`,
      toolCallId: "c-push",
      title: "Allow git push to origin?",
      options: [
        { optionId: "allow", name: "Allow once", kind: "allowOnce" },
        { optionId: "always", name: "Always allow", kind: "allowAlways" },
        { optionId: "reject", name: "Reject", kind: "rejectOnce" },
      ],
    });
    pendingPermission = {
      finish(allowed: boolean) {
        block({
          type: "tool",
          blockId: "t-push",
          callId: "c-push",
          name: "bash",
          title: "git push",
          status: allowed ? "completed" : "failed",
          input: { command: "git push origin feature/fix-config-parser" },
          output: allowed
            ? "To github.com:mark/branchlab.git\n   ee67431..584e8fd  feature/fix-config-parser -> feature/fix-config-parser"
            : "permission denied by user",
          diff: null,
          error: null,
        });
        block({
          type: "text",
          blockId: "m1",
          text: allowed
            ? "Fixed. The config parser was dropping the trailing newline that `preserves_trailing_newline` expects — `read()` now normalizes it, and all three call sites are unaffected. Pushed; CI is re-running."
            : "Fixed locally, but the push was rejected — the branch is ready whenever you want to push it yourself.",
        });
        mockEmit("chat:context", { workspaceId: ws, used: 12400, max: 200000 });
        turn("completed", "Fixed the failing config test");
      },
    };
  });
  return Promise.resolve();
}

/** Continuation for the showcase turn's permission gate. */
let pendingPermission: { finish: (allowed: boolean) => void } | null = null;

export function chatGenerateTitle(
  _workspaceId: string,
  text: string,
): Promise<GeneratedTitle | null> {
  const title = text.split(/\s+/).slice(0, 5).join(" ");
  if (!title) return Promise.resolve(null);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return Promise.resolve({
    title,
    branch: slug ? `feature/${slug}` : null,
  });
}
export function chatAbort(): Promise<void> {
  return Promise.resolve();
}
export function chatSetConfig(): Promise<void> {
  return Promise.resolve();
}
export function chatAnswerPermission(
  _workspaceId: string,
  _requestId: string,
  optionId: string | null,
): Promise<void> {
  // Resolve the showcase turn's permission gate.
  const pending = pendingPermission;
  pendingPermission = null;
  pending?.finish(optionId !== null && optionId !== "reject");
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
  // Quick chats have no git state — the real watcher never emits for them.
  if (quickChats.some((w) => w.id === workspaceId)) return Promise.resolve();
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

// Used internally by setActiveWorkspace's event simulation.
function workspacePrStatus(): Promise<PrStatus | null> {
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

// ── Telemetry mocks: never send anything from the browser harness ──

export function telemetryPageview(url: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("telemetry pageview", url);
  return Promise.resolve();
}

let mockTelemetryEnabled = true;

export function telemetryGetEnabled(): Promise<boolean> {
  return Promise.resolve(mockTelemetryEnabled);
}

export function telemetrySetEnabled(enabled: boolean): Promise<void> {
  mockTelemetryEnabled = enabled;
  return Promise.resolve();
}
