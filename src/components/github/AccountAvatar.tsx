import { cn } from "@/lib/utils";
import { useState } from "react";
import type { Account } from "../../lib/types";

/** GitHub avatar with an initials fallback (offline, or no avatar URL). */
export function AccountAvatar({
  account,
  className,
}: {
  account: Pick<Account, "login" | "avatarUrl">;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const initials = account.login.slice(0, 2).toUpperCase();
  const base =
    "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[10px] font-medium text-muted-foreground select-none";

  if (account.avatarUrl && !broken) {
    return (
      <img
        src={account.avatarUrl}
        alt={account.login}
        onError={() => setBroken(true)}
        className={cn(base, "size-5", className)}
      />
    );
  }
  return (
    <span className={cn(base, "size-5", className)} aria-hidden>
      {initials}
    </span>
  );
}
