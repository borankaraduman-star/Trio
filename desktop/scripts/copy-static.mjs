// Build step after tsc: copies static/ into dist/static and draws the icons
// (dist/static/icon.png for the window/tray, resources/icon.png for
// electron-builder, which turns it into .ico/.icns).
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { iconPng } from "./icon.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "static");
mkdirSync(out, { recursive: true });
cpSync(join(root, "static"), out, { recursive: true });
writeFileSync(join(out, "icon.png"), iconPng(256));

const resources = join(root, "resources");
mkdirSync(resources, { recursive: true });
const big = join(resources, "icon.png");
if (!existsSync(big)) writeFileSync(big, iconPng(1024));
console.log("static files and icons written");
