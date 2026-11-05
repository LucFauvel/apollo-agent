/**
 * Bundles the Apollo server (and the workspace packages it imports, which are
 * TypeScript sources) into one ESM file the packaged app runs on Electron's Node.
 *
 * Node refuses to strip types under node_modules, so a packaged app cannot run
 * the workspace sources directly the way development does.
 */
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(desktopDir, "build", "server");
rmSync(outDir, { recursive: true, force: true });

const result = await build({
  entryPoints: [join(desktopDir, "../server/src/bin.ts")],
  outfile: join(outDir, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  // Electron 44 embeds Node 24.
  target: "node24",
  // Bundled CommonJS dependencies still call require().
  banner: { js: 'import { createRequire as __apolloRequire } from "node:module"; const require = __apolloRequire(import.meta.url);' },
  // Optional native speedups of `ws`, loaded in try/catch.
  external: ["bufferutil", "utf-8-validate"],
  legalComments: "linked",
  metafile: true,
  logLevel: "warning",
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`server bundle: ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${outDir}`);
