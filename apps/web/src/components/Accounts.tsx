import type { AccountProvider, ProviderAccount } from "@apollo/contracts";
import { CircleAlert, ExternalLink, Loader2, LogIn, Plus, Trash2, UserRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, rpc } from "../rpc.ts";
import { Badge, Button, cx, inputClass } from "./ui.tsx";

/**
 * Other Claude and Codex subscriptions for bots to run on (personal next to work), each
 * with its own login and connectors. Shared by the Providers dialog and the bot dialogs.
 */

let cache: ReadonlyArray<ProviderAccount> = [];

/** The accounts, refreshed every two seconds while one is signing in. */
export function useAccounts() {
  const [accounts, setAccounts] = useState<ReadonlyArray<ProviderAccount>>(cache);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    () =>
      rpc((c) => c["accounts.list"]())
        .then((next) => {
          cache = next;
          setAccounts(next);
          setError(null);
        })
        .catch((e) => setError(errorMessage(e))),
    [],
  );
  useEffect(() => void reload(), [reload]);
  const signingIn = accounts.some((a) => a.signIn !== null);
  useEffect(() => {
    if (!signingIn) return;
    const timer = setInterval(() => void reload(), 2000);
    return () => clearInterval(timer);
  }, [signingIn, reload]);
  return { accounts, error, reload };
}

const PLANS: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", plus: "Plus", business: "Business", free: "Free" };

export const accountDetail = (a: ProviderAccount) =>
  a.loggedIn ? [a.email, a.orgName, a.plan ? (PLANS[a.plan] ?? a.plan) : null].filter(Boolean).join(" · ") : "Not signed in";

function AccountRow({ account, onChange }: { account: ProviderAccount; onChange: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    f()
      .then(onChange)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const signIn = account.signIn;

  return (
    <div className="animate-fade-up rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span
          className={cx(
            "flex size-7 shrink-0 items-center justify-center rounded-full",
            !account.loggedIn ? "bg-zinc-800 text-zinc-500" : account.provider === "claude" ? "bg-[#D97757]/15 text-[#E8A58C]" : "bg-[#8DA9FF]/15 text-[#B4C5FF]",
          )}
        >
          <UserRound className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-zinc-100">{account.name}</div>
          <div className="truncate text-[11px] text-zinc-500">{signIn ? "Signing in…" : accountDetail(account)}</div>
        </div>
        {!account.loggedIn && !signIn ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => run(() => rpc((c) => c["accounts.signIn"]({ accountId: account.id })))}>
            {busy ? <Loader2 className="animate-spin" /> : <LogIn />} Sign in
          </Button>
        ) : null}
        {account.loggedIn ? <Badge tone="emerald">Signed in</Badge> : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          title="Sign out and remove (its bots go back to this Mac's login)"
          onClick={() => {
            if (confirm(`Remove the ${account.name} account? Its bots go back to this Mac's Claude login.`)) {
              run(() => rpc((c) => c["accounts.remove"]({ accountId: account.id })));
            }
          }}
        >
          <Trash2 />
        </Button>
      </div>
      {signIn ? (
        <div className="mt-2.5 space-y-2 border-t border-zinc-800 pt-2.5">
          <p className="text-[11px] leading-relaxed text-zinc-400">
            Your browser opened {account.provider === "claude" ? "Claude" : "ChatGPT"}'s sign-in page: sign in with the {account.name.toLowerCase()} account.
            {signIn.url ? (
              <>
                {" "}
                <a className="inline-flex items-center gap-0.5 text-sky-300 hover:underline" href={signIn.url} target="_blank" rel="noreferrer">
                  Open it again <ExternalLink className="size-3" />
                </a>
              </>
            ) : null}{" "}
            {account.provider === "claude" ? "If the page shows a code, paste it here." : "This finishes by itself once you are signed in."}
          </p>
          {account.provider === "claude" ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) run(() => rpc((c) => c["accounts.submitCode"]({ accountId: account.id, code })).then(() => setCode("")));
            }}
          >
            <input className={cx(inputClass, "font-mono text-xs")} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code from the sign-in page" />
            <Button type="submit" size="sm" disabled={busy || !code.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : null} Continue
            </Button>
          </form>
          ) : null}
          {signIn.error ? (
            <p className="flex items-center gap-1 text-[11px] text-red-400">
              <CircleAlert className="size-3" /> {signIn.error}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="mt-2 text-[11px] text-red-400">{error}</p> : null}
    </div>
  );
}

const COPY: Record<AccountProvider, { title: string; detail: string }> = {
  claude: {
    title: "Other Claude accounts",
    detail: "Run some bots on another subscription, like work next to personal: each account has its own login and claude.ai connectors. Your Claude Code settings, skills and plugins stay shared.",
  },
  codex: {
    title: "Other Codex accounts",
    detail: "Run some bots on another ChatGPT plan, like work next to personal: each account has its own login and ChatGPT apps. Your Codex config, AGENTS.md and skills stay shared.",
  },
};

/** The accounts list in a provider's section of the Providers dialog. */
export function AccountsSection({ provider }: { provider: AccountProvider }) {
  const { accounts: all, error, reload } = useAccounts();
  const accounts = all.filter((a) => a.provider === provider);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const add = () => {
    if (!name.trim()) return;
    setBusy(true);
    setAddError(null);
    rpc((c) => c["accounts.add"]({ provider, name }))
      .then((account) => rpc((c) => c["accounts.signIn"]({ accountId: account.id })))
      .then(() => {
        setName("");
        return reload();
      })
      .catch((e) => setAddError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-2 border-t border-zinc-800/80 pt-3">
      <div>
        <div className="text-xs font-medium text-zinc-200">{COPY[provider].title}</div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{COPY[provider].detail} Pick the account beside the model when you set up a bot.</p>
      </div>
      {accounts.map((account) => (
        <AccountRow key={account.id} account={account} onChange={() => void reload()} />
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className={cx(inputClass, "text-xs")} value={name} onChange={(e) => setName(e.target.value)} placeholder={accounts.length ? "Another account, e.g. Work" : "Name it, e.g. Work"} />
        <Button type="submit" size="sm" disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add and sign in
        </Button>
      </form>
      {addError || error ? <p className="text-[11px] text-red-400">{addError ?? error}</p> : null}
    </div>
  );
}

/**
 * Which Claude or Codex account a bot runs on, as a dropdown beside the model picker. Shown only
 * when there is a choice: another account signed in besides this Mac's login (or the
 * bot already runs on one).
 */
export function AccountSelect({
  provider,
  value,
  onChange,
}: {
  provider: AccountProvider;
  value: string | null;
  onChange: (accountId: string | null) => void;
}) {
  const { accounts } = useAccounts();
  const signedIn = accounts.filter((a) => a.provider === provider && (a.loggedIn || a.id === value));
  if (signedIn.length === 0) return null;
  return (
    <div className="w-40 shrink-0">
      <select
        className={inputClass}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        title={`Which ${provider === "claude" ? "Claude" : "Codex"} account this bot's ${provider === "claude" ? "Claude" : "Codex"} sessions use`}
      >
        <option value="">This Mac's login</option>
        {signedIn.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
            {a.loggedIn ? "" : " (signed out)"}
          </option>
        ))}
      </select>
    </div>
  );
}
