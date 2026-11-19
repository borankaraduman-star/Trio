// Build step after tsc: copies static/ into dist/static, with the icons the
// main process loads at runtime: the window icon (also the connect page's
// logo) and the tray icons. electron-builder takes build/icon.png itself
// (the "icon" option in package.json) and turns it into .ico/.icns.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "static");
mkdirSync(out, { recursive: true });
cpSync(join(root, "static"), out, { recursive: true });

const assets = join(root, "assets");
cpSync(join(assets, "icon-256.png"), join(out, "icon.png"));
for (const name of ["tray.png", "tray@2x.png", "trayTemplate.png", "trayTemplate@2x.png"]) {
  cpSync(join(assets, name), join(out, name));
}
console.log("static files and icons copied");
