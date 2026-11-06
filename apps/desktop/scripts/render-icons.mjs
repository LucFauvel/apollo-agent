// Renders the icon sources in resources/icons/*.svg into the files the app and
// its installers use. Run with Electron (it rasterizes the SVGs): `pnpm icons`.
// Output (committed): resources/icon.{png,icns,ico}, resources/tray/*.png and ../mobile/assets/icon.png.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const resources = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");
const source = (name) => readFileSync(join(resources, "icons", `${name}.svg`), "utf8");

const scratch = mkdtempSync(join(tmpdir(), "apollo-render-"));
let counter = 0;

/** Renders an SVG at `size` px with a transparent background; returns PNG bytes. */
let window = null;
const render = async (svg, size) => {
  // One offscreen window for every render: spawning a renderer per image is slow.
  window ??= new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  window.setContentSize(size, size);
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}" style="display:block">
  </body></html>`;
  const file = join(scratch, `render-${counter++}.html`);
  writeFileSync(file, html);
  await window.loadFile(file);
  await new Promise((r) => setTimeout(r, 150));
  let image = await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  if (image.getSize().width !== size) image = image.resize({ width: size, height: size, quality: "best" });
  return image.toPNG();
};

/** An .ico holding PNG images (supported since Windows Vista). */
const ico = (images) => {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4); // color planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
};

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const appSvg = source("app");
  const traySvg = source("tray");
  const cache = new Map();
  const appPng = async (size) => {
    if (!cache.has(size)) cache.set(size, await render(appSvg, size));
    return cache.get(size);
  };

  // The phone app (apps/mobile): full bleed, since iOS fills transparent corners with white.
  writeFileSync(join(resources, "..", "..", "mobile", "assets", "icon.png"), await render(source("mobile"), 1024));

  // Linux (and the window icon): one large PNG.
  writeFileSync(join(resources, "icon.png"), await appPng(1024));

  // Windows: a multi-size .ico.
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoImages = [];
  for (const size of icoSizes) icoImages.push({ size, png: await appPng(size) });
  writeFileSync(join(resources, "icon.ico"), ico(icoImages));

  // macOS: an .icns, built with iconutil (macOS only).
  if (process.platform === "darwin") {
    const iconset = join(mkdtempSync(join(tmpdir(), "apollo-icon-")), "icon.iconset");
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      writeFileSync(join(iconset, `icon_${size}x${size}.png`), await appPng(size));
      writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), await appPng(size * 2));
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(resources, "icon.icns")]);
    rmSync(dirname(iconset), { recursive: true, force: true });
  } else {
    console.warn("icon.icns is only rebuilt on macOS; kept the existing one.");
  }

  // Tray: a template image for the macOS menu bar (the system tints it), and
  // the full-color icon for Windows and Linux trays.
  mkdirSync(join(resources, "tray"), { recursive: true });
  writeFileSync(join(resources, "tray", "trayTemplate.png"), await render(traySvg, 16));
  writeFileSync(join(resources, "tray", "trayTemplate@2x.png"), await render(traySvg, 32));
  writeFileSync(join(resources, "tray", "tray.png"), await appPng(32));
  writeFileSync(join(resources, "tray", "tray@2x.png"), await appPng(64));

  window?.destroy();
  rmSync(scratch, { recursive: true, force: true });
  console.log("Icons written to", resources);
  app.quit();
});
