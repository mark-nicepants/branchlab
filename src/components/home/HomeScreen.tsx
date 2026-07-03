import { CalendarClock, Blocks } from "lucide-react";
import type { ProjectView } from "../../lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Logo } from "../Logo";
import { HomeComposer } from "./HomeComposer";
import { ReviewInbox } from "./ReviewInbox";

interface Props {
  projects: ProjectView[];
  onCreateSession: (
    projectId: string,
    base: string | undefined,
    prompt: string,
  ) => void;
  onQuickChat: (prompt: string) => void;
  onAddProject: () => void;
  /** Check a review-inbox PR out into a fresh worktree. */
  onCheckoutPr: (projectId: string, prNumber: number) => void;
  /** Open Settings → Accounts (from the inbox connect CTA). */
  onOpenAccounts: () => void;
}

/**
 * Landing screen: brand mark, the prompt composer that starts sessions, the
 * review inbox ("Up next"), and cards for extending the app.
 */
export function HomeScreen({
  projects,
  onCreateSession,
  onQuickChat,
  onAddProject,
  onCheckoutPr,
  onOpenAccounts,
}: Props) {
  return (
    <div className="relative h-full">
      {/* Top strip acts as a window-drag region (there's no header here). */}
      <div
        data-tauri-drag-region
        className="absolute inset-x-0 top-0 z-10 h-10"
      />
      <ScrollArea className="h-full">
        <div className="mx-auto flex max-w-2xl flex-col px-6 pb-16 pt-[10vh]">
          <Logo className="mb-8 h-24 w-auto self-center text-foreground" />
          <HomeComposer
            projects={projects}
            onCreateSession={onCreateSession}
            onQuickChat={onQuickChat}
            onAddProject={onAddProject}
          />

          <ReviewInbox
            onCheckoutPr={onCheckoutPr}
            onOpenAccounts={onOpenAccounts}
          />

          {/* Extend your experience */}
          <section className="mt-10">
            <h2 className="text-sm font-semibold">Extend your experience</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Find new ways to work with the app, from automating tasks to
              connecting your tools.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <ExtendCard
                icon={<Blocks className="size-5" />}
                title="Extend with MCP servers"
                body="Connect tools like Figma, Playwright, or Azure. MCP servers are managed per session — open the server menu in a session's header."
                action="Managed per session"
                disabled
              />
              <ExtendCard
                icon={<CalendarClock className="size-5" />}
                title="Run recurring automations"
                body="Schedule tasks that run in the background, like summaries, reports, or health checks."
                action="Coming soon"
                disabled
              />
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

function ExtendCard({
  icon,
  title,
  body,
  action,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="mb-3 text-muted-foreground">{icon}</div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">
        {body}
      </p>
      <button
        onClick={onClick}
        disabled={disabled}
        className="mt-3 self-start rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
      >
        {action}
      </button>
    </div>
  );
}
