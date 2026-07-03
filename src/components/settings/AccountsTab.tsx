import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CircleUser, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { removeAccount } from "../../lib/api";
import type { Account } from "../../lib/types";
import { useGitHub } from "../../hooks/useGitHub";
import { AccountAvatar } from "../github/AccountAvatar";
import { AddAccountDialog } from "./AddAccountDialog";

export function AccountsTab() {
  const { accounts } = useGitHub();
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          GitHub accounts BranchLab can act as. Each is signed in and isolated
          separately, so work and personal repos stay apart.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3.5" /> Add account
        </Button>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          className="py-12"
          icon={<CircleUser className="size-6 text-muted-foreground/60" />}
        >
          No GitHub accounts connected yet.
        </EmptyState>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} />
          ))}
        </div>
      )}

      {adding && <AddAccountDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function AccountRow({ account }: { account: Account }) {
  const remove = () => {
    toast(`Remove @${account.login}?`, {
      action: {
        label: "Remove",
        onClick: () => void removeAccount(account.id),
      },
    });
  };
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <AccountAvatar account={account} className="size-8 text-xs" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {account.name ?? account.login}
          </span>
          {!account.active && (
            <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
              {account.status ?? "Sign-in required"}
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          @{account.login} · {account.host}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-destructive"
        title="Remove account"
        onClick={remove}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
}
