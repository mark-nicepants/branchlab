// Shared GitHub account + review-inbox state, pushed from the backend.
//
// The Rust `github` subsystem owns the account list and the cross-repo review
// inbox and pushes `github:accounts` / `github:review_inbox`; this provider
// listens and exposes the latest snapshot via context. No polling — see
// AGENTS.md. Login progress is NOT held here: it's transient and modal-scoped
// (AddAccountDialog subscribes to `github:login` directly).

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  listAccounts,
  resyncGitHub,
  reviewInbox as fetchReviewInbox,
} from "../lib/api";
import { onGitHubAccounts, onReviewInbox } from "../lib/events";
import type { Account, Project, ReviewInboxItem } from "../lib/types";

interface GitHubValue {
  accounts: Account[];
  accountById: Record<string, Account>;
  reviewInbox: ReviewInboxItem[];
  inboxRefreshedAt: number | null;
  inboxError: string | null;
  /** The account bound to a project (override if set, else auto-detected). */
  resolveProjectAccount: (project: Project) => Account | null;
}

const Ctx = createContext<GitHubValue>({
  accounts: [],
  accountById: {},
  reviewInbox: [],
  inboxRefreshedAt: null,
  inboxError: null,
  resolveProjectAccount: () => null,
});

export function GitHubProvider({ children }: { children: React.ReactNode }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [reviewInbox, setReviewInbox] = useState<ReviewInboxItem[]>([]);
  const [inboxRefreshedAt, setInboxRefreshedAt] = useState<number | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const track = (p: Promise<() => void>) =>
      void p.then((fn) => (cancelled ? fn() : unlisteners.push(fn)));

    track(onGitHubAccounts((p) => setAccounts(p.accounts)));
    track(
      onReviewInbox((p) => {
        setReviewInbox(p.items);
        setInboxRefreshedAt(p.refreshedAt);
        setInboxError(p.error);
      }),
    );
    // Seed via request/response — a pushed `resync` event can race the listener
    // registration on cold start and be dropped (events aren't buffered), and
    // accounts have no other re-emit trigger, so a miss would leave the list
    // permanently empty. Direct reads can't be missed.
    void listAccounts().then((a) => {
      if (!cancelled) setAccounts(a);
    });
    void fetchReviewInbox().then((items) => {
      if (!cancelled) setReviewInbox(items);
    });
    // Also nudge a re-emit so inbox refreshedAt/error metadata populates.
    void resyncGitHub();
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const accountById = useMemo(() => {
    const out: Record<string, Account> = {};
    for (const a of accounts) out[a.id] = a;
    return out;
  }, [accounts]);

  const value = useMemo<GitHubValue>(
    () => ({
      accounts,
      accountById,
      reviewInbox,
      inboxRefreshedAt,
      inboxError,
      resolveProjectAccount: (project) =>
        project.account_id ? (accountById[project.account_id] ?? null) : null,
    }),
    [accounts, accountById, reviewInbox, inboxRefreshedAt, inboxError],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGitHub(): GitHubValue {
  return useContext(Ctx);
}
