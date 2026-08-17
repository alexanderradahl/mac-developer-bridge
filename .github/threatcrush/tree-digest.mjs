#!/usr/bin/env node
// Canonical digest of the pinned ThreatCrush runtime tree.
//
// `package-lock.json` is the pin: every package that will execute during a
// scan, at an exact version, with the integrity hash npm checks each tarball
// against. This reduces it to one line, so that pin can be reviewed and
// asserted rather than diffed by eye across 209 entries.
//
// The digest is taken over sorted `name@version integrity` lines, so it is a
// digest of the *tree*, not of the file: npm reformatting the lockfile, or
// reordering it, does not move it. Changing what runs does.
//
//   node .github/threatcrush/tree-digest.mjs [path/to/package-lock.json]
//     prints the package count and the digest
//
//   LOCKFILE=... TREE_DIGEST=... CLI_SPEC=... CLI_INTEGRITY=... \
//     node .github/threatcrush/tree-digest.mjs --verify
//     exits non-zero unless the tree is exactly what was pinned
//
// Regenerate the pin after changing the CLI version:
//
//   npm --prefix .github/threatcrush install --ignore-scripts --package-lock-only
//   node .github/threatcrush/tree-digest.mjs .github/threatcrush/package-lock.json
//
// and copy the printed digest into TREE_DIGEST in
// .github/workflows/threatcrush-scan.yml.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const verify = process.argv.includes("--verify");
const lockfile =
  process.argv.slice(2).find((arg) => !arg.startsWith("--")) ??
  process.env.LOCKFILE;

if (!lockfile) {
  console.error("usage: tree-digest.mjs <package-lock.json>   (or LOCKFILE=...)");
  process.exit(2);
}

const lock = JSON.parse(readFileSync(lockfile, "utf8"));

if (lock.lockfileVersion < 2) {
  // Below v2 the lockfile carries no integrity for the root's own deps, so
  // there is nothing here worth asserting.
  console.error(`lockfileVersion ${lock.lockfileVersion} does not pin integrity`);
  process.exit(1);
}

const lines = Object.entries(lock.packages ?? {})
  .filter(([path]) => path !== "")
  .map(([path, meta]) => {
    // The key is a path, and the same package can appear at more than one of
    // them; the name is what identifies it.
    const marker = path.lastIndexOf("node_modules/");
    const name = meta.name ?? path.slice(marker + "node_modules/".length);
    if (!meta.integrity) {
      // A dependency with no integrity is one npm will not be checking. That
      // is the hole this file exists to close, so it is fatal, not a warning.
      console.error(`no integrity pinned for ${path}`);
      process.exit(1);
    }
    return `${name}@${meta.version} ${meta.integrity}`;
  })
  .sort();

const digest = `sha256-${createHash("sha256").update(lines.join("\n")).digest("hex")}`;

if (!verify) {
  console.log(`${lines.length} packages`);
  console.log(digest);
  process.exit(0);
}

let failed = false;
const fail = (message) => {
  console.error(`::error::${message}`);
  failed = true;
};

const expected = process.env.TREE_DIGEST;
if (!expected) {
  fail("TREE_DIGEST is not set — refusing to run an unpinned dependency tree");
} else if (expected !== digest) {
  fail(`ThreatCrush runtime tree does not match the pinned digest`);
  console.error(`::error::expected ${expected}`);
  console.error(`::error::received ${digest} (${lines.length} packages)`);
  console.error("::error::refusing to install — this is not a transient failure");
}

// The top-level tarball, checked separately from the tree it pulls in. It is
// the one value that can be confirmed straight from the registry, so it is
// worth naming rather than folding into the digest alone.
const spec = process.env.CLI_SPEC;
if (spec) {
  const at = spec.lastIndexOf("@");
  const [name, version] = [spec.slice(0, at), spec.slice(at + 1)];
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry) {
    fail(`${name} is not in the lockfile`);
  } else if (entry.version !== version) {
    fail(`lockfile pins ${name}@${entry.version}, workflow expects ${version}`);
  } else if (process.env.CLI_INTEGRITY && entry.integrity !== process.env.CLI_INTEGRITY) {
    fail(`integrity mismatch for ${spec}`);
    console.error(`::error::expected ${process.env.CLI_INTEGRITY}`);
    console.error(`::error::received ${entry.integrity}`);
  }
}

if (failed) process.exit(1);

console.log(`${spec ?? "tree"} verified: ${lines.length} packages, ${digest}`);
