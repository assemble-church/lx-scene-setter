#!/usr/bin/env node
// Build the Light It Companion module package (companion/lightit.tgz), served by
// the app for download (Companion → Import module).
//
// Versioning: the module's version is bumped (patch) only when its source changed
// since the last build — a fingerprint of the source, help, manifest and
// dependencies (versions excluded) is kept in companion/.build-fingerprint. So
// rebuilding the app doesn't churn the version, but any module change reaches
// Companion as a new version. Bump minor/major by hand in companion/package.json;
// the manifest follows it.
//
//   node scripts/build-companion.js          build (bump if changed)
//   node scripts/build-companion.js --check  report whether a bump is due, build nothing

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const DIR = path.resolve(__dirname, "..", "companion");
const PKG = path.join(DIR, "package.json");
const MANIFEST = path.join(DIR, "companion", "manifest.json");
const FINGERPRINT = path.join(DIR, ".build-fingerprint");
const OUT = path.join(DIR, "lightit.tgz");

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n");

function fingerprint() {
  const h = crypto.createHash("sha256");
  const pkg = readJson(PKG);
  const manifest = readJson(MANIFEST);
  delete pkg.version;
  delete manifest.version;
  h.update(JSON.stringify(pkg));
  h.update(JSON.stringify(manifest));
  for (const f of walk(path.join(DIR, "src")).concat([path.join(DIR, "companion", "HELP.md")])) {
    h.update(path.relative(DIR, f));
    h.update(fs.readFileSync(f));
  }
  return h.digest("hex");
}

function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const bumpPatch = (v) => {
  const [maj, min, pat] = String(v || "1.0.0").split(".").map((n) => parseInt(n, 10) || 0);
  return `${maj}.${min}.${pat + 1}`;
};

const now = fingerprint();
const last = fs.existsSync(FINGERPRINT) ? fs.readFileSync(FINGERPRINT, "utf8").trim() : null;
const changed = now !== last;

if (process.argv.includes("--check")) {
  console.log(changed ? "companion module changed: next build bumps the version" : "companion module unchanged");
  process.exit(0);
}

const pkg = readJson(PKG);
const manifest = readJson(MANIFEST);
if (changed && last !== null) pkg.version = bumpPatch(pkg.version);
// The manifest always carries the package's version (a hand bump in package.json flows through).
if (manifest.version !== pkg.version || changed) {
  manifest.version = pkg.version;
  writeJson(PKG, pkg);
  writeJson(MANIFEST, manifest);
}

if (!changed && fs.existsSync(OUT)) {
  console.log(`companion module v${pkg.version} unchanged, package up to date`);
  process.exit(0);
}

if (!fs.existsSync(path.join(DIR, "node_modules", "@companion-module", "tools"))) {
  console.log("installing companion module build tools…");
  execSync("npm install --no-audit --no-fund", { cwd: DIR, stdio: "inherit" });
}
console.log(`building companion module v${pkg.version}…`);
execSync("npx companion-module-build --output lightit", { cwd: DIR, stdio: "inherit" });
if (!fs.existsSync(OUT)) throw new Error(`build finished but ${OUT} is missing`);
fs.writeFileSync(FINGERPRINT, now + "\n");
console.log(`companion module v${pkg.version} → companion/lightit.tgz (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
