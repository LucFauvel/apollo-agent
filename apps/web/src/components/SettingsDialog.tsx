import type { AppSettings, ProjectInfo, UpdateAppSettingsInput } from "@apollo/contracts";
import { Folder, FolderGit2, FolderPlus, Loader2, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";
import { tildify } from "../appSettings.ts";
import { errorMessage, rpc } from "../rpc.ts";
import { Button, cx, ErrorText, Field, FormSection, IconButton, inputClass, Modal } from "./ui.tsx";
import { NotificationSettings, VoiceSettings } from "./Voice.tsx";

const count = (n: number) => (n === 1 ? "1 project" : `${n} projects`);

/** App-wide settings: where the user's projects live, and where new bots get their workspace. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [projects, setProjects] = useState<ReadonlyArray<ProjectInfo> | null>(null);
  const [folder, setFolder] = useState("");
  const [root, setRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = () => {
    setProjects(null);
    rpc((c) => c["app.projects"]())
      .then(setProjects)
      .catch((e) => setError(errorMessage(e)));
  };

  useEffect(() => {
    rpc((c) => c["app.settings"]())
      .then((s) => {
        setSettings(s);
        setRoot(tildify(s.workspaceRoot, s.homeDir));
      })
      .catch((e) => setError(errorMessage(e)));
    loadProjects();
  }, []);

  const save = (input: UpdateAppSettingsInput, then?: () => void) => {
    setBusy(true);
    setError(null);
    rpc((c) => c["app.updateSettings"](input))
      .then((s) => {
        setSettings(s);
        setRoot(tildify(s.workspaceRoot, s.homeDir));
        if (input.projectFolders) loadProjects();
        then?.();
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  const home = settings?.homeDir ?? "";
  const folders = settings?.projectFolders ?? [];
  const addFolder = () => {
    if (folder.trim()) save({ projectFolders: [...folders, folder.trim()] }, () => setFolder(""));
  };
  const rootChanged = settings !== null && root.trim() !== tildify(settings.workspaceRoot, home);

  return (
    <Modal
      title="Settings"
      description="Apply to every bot."
      icon={
        <span className="flex size-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
          <Settings className="size-4 text-zinc-300" />
        </span>
      }
      onClose={onClose}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <FormSection
        title="Project folders"
        description="Folders where you keep your projects, like ~/git. Bots can find, read and edit projects there, and you can pick one as a bot's workspace."
      >
        {settings === null ? (
          <Loader2 className="size-4 animate-spin text-zinc-500" />
        ) : (
          <div className="space-y-1.5">
            {folders.map((f) => {
              const found = projects?.filter((p) => p.folder === f);
              return (
                <div key={f} className="group flex items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/40 py-1.5 pr-1.5 pl-3">
                  <Folder className="size-3.5 shrink-0 text-zinc-500" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200" title={f}>
                    {tildify(f, home)}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-500">
                    {found ? (
                      <>
                        <FolderGit2 className="size-3" /> {count(found.length)}
                      </>
                    ) : (
                      <Loader2 className="size-3 animate-spin" />
                    )}
                  </span>
                  <IconButton
                    icon={X}
                    label="Remove folder"
                    size="sm"
                    disabled={busy}
                    onClick={() => save({ projectFolders: folders.filter((x) => x !== f) })}
                  />
                </div>
              );
            })}
            {folders.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-800 px-3 py-2.5 text-xs text-zinc-500">
                No project folders yet.
              </div>
            ) : null}
            <form
              className="flex gap-2 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                addFolder();
              }}
            >
              <input
                className={cx(inputClass, "font-mono text-xs")}
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="~/git"
                spellCheck={false}
              />
              <Button type="submit" disabled={!folder.trim() || busy}>
                <FolderPlus /> Add
              </Button>
            </form>
          </div>
        )}
      </FormSection>
      <FormSection title="New bots">
        <Field label="Workspace folder" hint="Each new bot gets its own folder here by default (e.g. ~/Apollo/atlas). You can change it when creating the bot.">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (rootChanged) save({ workspaceRoot: root });
            }}
          >
            <input
              className={cx(inputClass, "font-mono text-xs")}
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="~/Apollo"
              spellCheck={false}
            />
            {rootChanged ? (
              <Button type="submit" variant="primary" disabled={!root.trim() || busy}>
                Save
              </Button>
            ) : null}
          </form>
        </Field>
      </FormSection>
      <NotificationSettings />
      <VoiceSettings />
      <ErrorText>{error}</ErrorText>
    </Modal>
  );
}
