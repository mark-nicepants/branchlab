import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckCircle2, GitPullRequest, RefreshCw } from "lucide-react";
import { openExternal, refreshReviewInbox } from "../../lib/api";
import { useGitHub } from "../../hooks/useGitHub";
import type { ReviewInboxItem } from "../../lib/types";
import { AccountAvatar } from "../github/AccountAvatar";
import { CiIcon } from "../github/CiIcon";

interface Props {
  /** Check a PR out into a fresh worktree (only for repos that map to a project). */
  onCheckoutPr: (projectId: string, prNumber: number) => void;
  /** Open Settings → Accounts (from the connect CTA). */
  onOpenAccounts: () => void;
}

/** "Up next" — PRs awaiting your review across all connected accounts. */
export function ReviewInbox({ onCheckoutPr, onOpenAccounts }: Props) {
  const { accounts, reviewInbox, inboxRefreshedAt, inboxError } = useGitHub();

  return (
    <section className="mt-12">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Up next</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Pull requests waiting on your review.
          </p>
        </div>
        {accounts.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {inboxRefreshedAt && (
              <span>Updated {relativeTime(inboxRefreshedAt)}</span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              title="Refresh"
              onClick={() => void refreshReviewInbox()}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {inboxError && (
        <p className="mt-2 rounded-md bg-warning/10 px-3 py-1.5 text-xs text-warning">
          {inboxError}
        </p>
      )}

      <div className="mt-4">
        {accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card/40 py-12 text-center">
            <GitPullRequest className="size-6 text-muted-foreground/60" />
            <p className="text-sm font-medium">Connect a GitHub account</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              See pull requests waiting on your review, right here.
            </p>
            <Button size="sm" className="mt-1" onClick={onOpenAccounts}>
              Connect GitHub
            </Button>
          </div>
        ) : reviewInbox.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card/40 py-12 text-center">
            <CheckCircle2 className="size-6 text-muted-foreground/60" />
            <p className="text-sm font-medium">You're all caught up</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              No pull requests are waiting on your review.
            </p>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
            {reviewInbox.map((item) => (
              <ReviewRow
                key={item.id}
                item={item}
                onCheckoutPr={onCheckoutPr}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ReviewRow({
  item,
  onCheckoutPr,
}: {
  item: ReviewInboxItem;
  onCheckoutPr: (projectId: string, prNumber: number) => void;
}) {
  return (
    <div className="group flex items-center gap-3 bg-card/40 px-3 py-2.5 hover:bg-accent/40">
      <CiIcon rollup={item.rollup} className="size-4 shrink-0" />
      <button
        className="min-w-0 flex-1 text-left"
        onClick={() => void openExternal(item.url)}
        title="Open on GitHub"
      >
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{item.title}</span>
          {item.isDraft && (
            <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
              Draft
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">
            {item.repo} #{item.number}
          </span>
          <span aria-hidden>·</span>
          <span
            className={cn(
              "rounded px-1 py-0.5 text-[10px]",
              item.reason === "review_requested"
                ? "bg-info/15 text-info"
                : "bg-muted text-muted-foreground",
            )}
          >
            {item.reason === "review_requested"
              ? "Review requested"
              : "Assigned"}
          </span>
          <span aria-hidden>·</span>
          <AccountAvatar
            account={{ login: item.author, avatarUrl: item.authorAvatar }}
            className="size-3.5"
          />
          <span className="truncate">{item.author}</span>
        </div>
      </button>
      {item.projectId ? (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={() => onCheckoutPr(item.projectId!, item.number)}
        >
          Check out
        </Button>
      ) : (
        <span
          className="shrink-0 text-[10px] text-muted-foreground/60"
          title="Add this repo as a project to check it out in the app"
        >
          not a project
        </span>
      )}
    </div>
  );
}

/** Coarse "n minutes/hours/days ago" from an epoch-ms timestamp. */
function relativeTime(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
