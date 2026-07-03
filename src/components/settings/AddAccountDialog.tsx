import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  addAccountWithToken,
  beginAccountLogin,
  cancelAccountLogin,
  openExternal,
} from "../../lib/api";
import { onGitHubLogin } from "../../lib/events";
import type { GitHubLoginEvent, LoginPhase } from "../../lib/types";

interface Props {
  onClose: () => void;
}

type Mode = "idle" | "device" | "token";

/**
 * Add a GitHub account. The primary path is the backend-driven browser device
 * flow (`gh auth login --web`): the dialog renders each `github:login` step —
 * one-time code, waiting, success/fail. A "paste a token instead" escape hatch
 * handles GitHub Enterprise or a flaky browser flow.
 */
export function AddAccountDialog({ onClose }: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [host, setHost] = useState("github.com");

  // Device-flow state.
  const [loginId, setLoginId] = useState<string | null>(null);
  const [phase, setPhase] = useState<LoginPhase | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successLogin, setSuccessLogin] = useState<string | null>(null);

  // Token-flow state.
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const loginIdRef = useRef<string | null>(null);
  loginIdRef.current = loginId;

  // Subscribe to login lifecycle, filtered to our loginId.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onGitHubLogin((e: GitHubLoginEvent) => {
      if (e.loginId !== loginIdRef.current) return;
      setPhase(e.phase);
      if (e.code) setCode(e.code);
      if (e.url) setUrl(e.url);
      if (e.phase === "failed") setError(e.error ?? "Sign-in failed");
      if (e.phase === "success") {
        setSuccessLogin(e.account?.login ?? null);
        // The provider's account list updates via github:accounts; auto-close.
        setTimeout(() => onClose(), 1200);
      }
    }).then((fn) => (cancelled ? fn() : (unlisten = fn)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onClose]);

  const startDevice = async () => {
    setMode("device");
    setError(null);
    setCode(null);
    setUrl(null);
    setPhase("starting");
    try {
      const id = await beginAccountLogin(host);
      setLoginId(id);
    } catch (e) {
      setPhase("failed");
      setError(String(e));
    }
  };

  const submitToken = async () => {
    if (!token.trim()) return;
    setBusy(true);
    try {
      await addAccountWithToken(token.trim(), host);
      toast.success("GitHub account added");
      onClose();
    } catch (e) {
      toast.error(`Could not add account: ${e}`);
      setBusy(false);
    }
  };

  const handleClose = () => {
    if (loginId && phase && phase !== "success" && phase !== "failed") {
      void cancelAccountLogin(loginId);
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a GitHub account</DialogTitle>
        </DialogHeader>

        {mode === "idle" && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Sign in with your browser. BranchLab keeps each account isolated
              so you can use several at once.
            </p>
            <HostField host={host} onChange={setHost} />
            <Button onClick={startDevice}>Sign in with GitHub</Button>
            <button
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setMode("token")}
            >
              Paste a personal access token instead
            </button>
          </div>
        )}

        {mode === "device" && (
          <DeviceFlow
            phase={phase}
            code={code}
            url={url}
            error={error}
            successLogin={successLogin}
            onRetry={startDevice}
            onOpenUrl={() => url && void openExternal(url)}
          />
        )}

        {mode === "token" && (
          <div className="flex flex-col gap-4">
            <HostField host={host} onChange={setHost} />
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">
                Personal access token
              </label>
              <Input
                type="password"
                placeholder="ghp_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Needs <code>repo</code> and <code>read:org</code> scopes.
              </p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setMode("idle")}>
                Back
              </Button>
              <Button onClick={submitToken} disabled={busy || !token.trim()}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                Add account
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HostField({
  host,
  onChange,
}: {
  host: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">Host</label>
      <Input
        value={host}
        onChange={(e) => onChange(e.target.value)}
        placeholder="github.com"
      />
      <p className="text-xs text-muted-foreground">
        Use a different host for GitHub Enterprise.
      </p>
    </div>
  );
}

function DeviceFlow({
  phase,
  code,
  url,
  error,
  successLogin,
  onRetry,
  onOpenUrl,
}: {
  phase: LoginPhase | null;
  code: string | null;
  url: string | null;
  error: string | null;
  successLogin: string | null;
  onRetry: () => void;
  onOpenUrl: () => void;
}) {
  if (phase === "failed") {
    return (
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <TriangleAlert className="size-8 text-destructive" />
        <p className="text-sm text-muted-foreground">
          {error ?? "Sign-in failed."}
        </p>
        <Button onClick={onRetry}>Try again</Button>
      </div>
    );
  }

  if (phase === "success") {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <Check className="size-8 text-additions" />
        <p className="text-sm">
          Signed in{successLogin ? ` as @${successLogin}` : ""}.
        </p>
      </div>
    );
  }

  if (phase === "awaitingCode" || phase === "polling") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Enter this code at {url ? new URL(url).host : "GitHub"} to authorize
          BranchLab:
        </p>
        <div className="flex items-center justify-center gap-2">
          <code className="rounded-md border border-border bg-muted px-4 py-2 font-mono text-xl tracking-[0.3em]">
            {code ?? "········"}
          </code>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Copy code"
            onClick={() => code && void navigator.clipboard.writeText(code)}
          >
            <Copy className="size-4" />
          </Button>
        </div>
        <Button variant="outline" onClick={onOpenUrl} disabled={!url}>
          <ExternalLink className="size-4" /> Open GitHub
        </Button>
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Waiting for you to authorize…
        </div>
      </div>
    );
  }

  // starting / null
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Starting sign-in…
    </div>
  );
}
