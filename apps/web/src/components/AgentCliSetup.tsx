import type { AccountProvider } from "@apollo/contracts";
import { CircleAlert, Download, ExternalLink, Loader2, LogIn, X } from "lucide-react";
import { useState } from "react";
import { useAgentCli } from "../agentClis.ts";
import { errorMessage, rpc } from "../rpc.ts";
import { accountDetail } from "./Accounts.tsx";
import { Badge, Button, cx, inputClass } from "./ui.tsx";

const COPY: Record<AccountProvider, { name: string; cli: string; site: string }> = {
  claude: { name: "Claude Code", cli: "claude", site: "Claude" },
  codex: { name: "Codex", cli: "codex", site: "ChatGPT" },
};

/** Installs Claude Code or Codex on this computer, and signs its own login in. */
export function AgentCliSetup({ provider }: { provider: AccountProvider }) {
  const cli = useAgentCli(provider);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    f()
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const copy = COPY[provider];
  if (!cli) return null;

  const box = "rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 text-xs";
  const errorLine = (text: string | null) =>
    text ? (
      <p className="mt-2 flex items-start gap-1 text-[11px] text-red-400">
        <CircleAlert className="mt-px size-3 shrink-0" /> {text}
      </p>
    ) : null;

  if (cli.install) {
    return (
      <div className={cx(box, "flex items-center gap-2 text-sky-300")}>
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        <span className="min-w-0 flex-1 truncate" title={cli.install.step}>
          Installing {copy.name}: {cli.install.step}
        </span>
      </div>
    );
  }

  if (!cli.executable) {
    // Development: sessions run the Claude Code that comes with Apollo.
    if (cli.bundled) return null;
    return (
      <div className={box}>
        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-zinc-400">
            {copy.name} is not installed on this computer. Apollo runs its official installer (into{" "}
            <span className="font-mono text-zinc-300">~/.local/bin</span>), then you sign in.
          </p>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => rpc((c) => c["agentClis.install"]({ provider })))}>
            {busy ? <Loader2 className="animate-spin" /> : <Download />} Install
          </Button>
        </div>
        {errorLine(cli.installError ? `Install failed: ${cli.installError}` : error)}
      </div>
    );
  }

  const signIn = cli.signIn;
  const login = cli.login;
  return (
    <div className={box}>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-zinc-400">
          <span className="text-zinc-300">This computer's login: </span>
          {signIn ? "signing in…" : login ? accountDetail(login) : "checking…"}
        </span>
        {login?.loggedIn && !signIn ? <Badge tone="emerald">Signed in</Badge> : null}
        {signIn ? (
          <Button size="sm" variant="ghost" disabled={busy} title="Stop signing in" onClick={() => run(() => rpc((c) => c["agentClis.cancelSignIn"]({ provider })))}>
            <X />
          </Button>
        ) : login ? (
          <Button
            size="sm"
            variant={login.loggedIn ? "ghost" : "primary"}
            disabled={busy}
            onClick={() => run(() => rpc((c) => c["agentClis.signIn"]({ provider })))}
          >
            {busy ? <Loader2 className="animate-spin" /> : <LogIn />} {login.loggedIn ? "Switch account" : "Sign in"}
          </Button>
        ) : null}
      </div>
      {signIn ? (
        <div className="mt-2.5 space-y-2 border-t border-zinc-800 pt-2.5">
          <p className="text-[11px] leading-relaxed text-zinc-400">
            Your browser opened {copy.site}'s sign-in page.
            {signIn.url ? (
              <>
                {" "}
                <a className="inline-flex items-center gap-0.5 text-sky-300 hover:underline" href={signIn.url} target="_blank" rel="noreferrer">
                  Open it again <ExternalLink className="size-3" />
                </a>
              </>
            ) : null}{" "}
            {signIn.userCode ? (
              <>
                Enter the code <span className="font-mono text-zinc-200">{signIn.userCode}</span> there.
              </>
            ) : signIn.needsCode ? (
              "If the page shows a code, paste it here."
            ) : (
              "This finishes by itself once you are signed in."
            )}
          </p>
          {signIn.needsCode ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) run(() => rpc((c) => c["agentClis.submitCode"]({ provider, code })).then(() => setCode("")));
              }}
            >
              <input className={cx(inputClass, "font-mono text-xs")} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from the sign-in page" />
              <Button type="submit" size="sm" disabled={busy || !code.trim()}>
                {busy ? <Loader2 className="animate-spin" /> : null} Continue
              </Button>
            </form>
          ) : null}
          {errorLine(signIn.error)}
        </div>
      ) : null}
      {errorLine(error)}
    </div>
  );
}

/** The install prompt only, where Claude Code or Codex is picked for a bot. */
export function AgentCliMissing({ provider }: { provider: AccountProvider }) {
  const cli = useAgentCli(provider);
  if (!cli || cli.bundled || (cli.executable && !cli.install)) return null;
  return <AgentCliSetup provider={provider} />;
}
