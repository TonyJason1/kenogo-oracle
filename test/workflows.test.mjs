/* KenoGO Oracle — CI supply-chain and pipeline-shape invariants.
 *
 * Deliberately regex-based rather than YAML-parsed: these assertions run in
 * the zero-dependency core suite, which the 6-hourly data pipeline itself
 * executes. Pulling in a YAML parser to check that the pipeline has no
 * dependencies would be self-defeating.
 *
 * What is pinned here:
 *   - every action is referenced by immutable commit SHA, never a mutable tag
 *   - every job declares timeout-minutes; permissions are job-scoped
 *   - the data pipeline never installs third-party packages
 *   - the updater runs BEFORE the --strict audit, and the audit/tests/commit
 *     steps all skip in catch-up mode (the local backfill owns that state)
 *   - a failing pipeline raises a pipeline-failure issue, never dies quietly
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { fail++; console.error(`FAIL  ${name}\n      ${err.message}`); }
}
function ok(cond, what) { if (!cond) throw new Error(what); }

const WF_DIR = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const files = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
const read = (f) => readFileSync(`${WF_DIR}${f}`, "utf8");

ok(files.length >= 2, "expected at least the data pipeline and CI workflows");

/* ------------------------------------------------------------ SHA pins */

const SHA_PINNED = /^\s*-?\s*uses:\s*([\w.-]+\/[\w.-]+(?:\/[\w.-]+)*)@([0-9a-f]{40})\s*(#.*)?$/;
const ANY_USES = /^\s*-?\s*uses:\s*(\S+)/;

for (const file of files) {
  check(`${file}: every action is pinned to a 40-char commit SHA`, () => {
    const usesLines = read(file).split(/\r?\n/).filter((l) => ANY_USES.test(l));
    ok(usesLines.length > 0, "expected at least one action reference");
    for (const line of usesLines) {
      const ref = line.match(ANY_USES)[1];
      ok(SHA_PINNED.test(line),
        `not SHA-pinned: "${ref}" — a moved tag on a third-party action must not be able to run in this repo`);
    }
  });

  check(`${file}: every SHA pin records the human-readable version it came from`, () => {
    for (const line of read(file).split(/\r?\n/)) {
      if (!ANY_USES.test(line)) continue;
      const m = line.match(SHA_PINNED);
      ok(m && m[3] && /#\s*v?\d+\.\d+/.test(m[3]),
        `missing "# vX.Y.Z" comment on: ${line.trim()} — an unlabelled SHA is unreviewable`);
    }
  });
}

/* ------------------------------------------------- timeouts + scoping */

/** Job blocks are the two-space-indented keys under `jobs:`. */
function jobBlocks(src) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  ok(start !== -1, "no jobs: block");
  const out = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const header = line.match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
    if (header) {
      if (current) out.push(current);
      current = { name: header[1], body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) out.push(current);
  return out;
}

for (const file of files) {
  check(`${file}: every job sets timeout-minutes`, () => {
    const jobs = jobBlocks(read(file));
    ok(jobs.length > 0, "no jobs found");
    for (const job of jobs) {
      const has = job.body.some((l) => /^ {4}timeout-minutes:\s*\d+/.test(l));
      ok(has, `job "${job.name}" has no timeout-minutes — it would inherit GitHub's 360-minute default`);
    }
  });

  check(`${file}: permissions are job-scoped, not workflow-wide`, () => {
    const src = read(file);
    ok(!/^permissions:/m.test(src),
      "workflow-level permissions grant every job the same rights — scope them per job");
    const jobs = jobBlocks(src);
    for (const job of jobs) {
      ok(job.body.some((l) => /^ {4}permissions:\s*$/.test(l)),
        `job "${job.name}" declares no permissions block`);
    }
  });
}

/* ------------------------------------- data pipeline supply-chain rule */

/** Executable content only — a rule must not be tripped by the prose explaining it. */
function withoutComments(src) {
  return src
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

check("update-data.yml installs no third-party packages", () => {
  const src = withoutComments(read("update-data.yml"));
  ok(!/npm (ci|install|i)\b/.test(src),
    "the data pipeline must not install packages — every script it runs uses only Node builtins and repo code");
  ok(/npm run test:core/.test(src),
    "the pipeline must run the zero-dependency core suite");
  ok(!/npm run test:dom|npm test\b/.test(src),
    "the pipeline must not run the jsdom suite, which would require an install");
});

check("withoutComments strips prose but keeps run: steps", () => {
  const sample = "# npm install is forbidden here\n      - run: node scripts/x.mjs\n";
  ok(!/npm install/.test(withoutComments(sample)), "comment stripped");
  ok(/node scripts\/x\.mjs/.test(withoutComments(sample)), "executable line kept");
});

check("update-data.yml runs on a 6-hourly schedule", () => {
  ok(/cron:\s*"[^"]*\*\/6[^"]*"/.test(read("update-data.yml")), "expected a */6 hours cron");
});

check("update-data.yml runs the audit in --strict mode after the updater", () => {
  const src = read("update-data.yml");
  const audit = src.indexOf("audit-data.mjs");
  ok(audit !== -1, "audit step missing");
  ok(/audit-data\.mjs --strict/.test(src),
    "post-updater audit must be --strict, or a stalled fetch still reconciles");
  ok(src.indexOf("update-data.mjs") < audit, "the updater must run before the audit");
});

check("update-data.yml: audit, tests and commit all SKIP in catch-up mode", () => {
  const src = read("update-data.yml");
  ok(/id:\s*update/.test(src), "the updater step needs an id for its mode output");
  const conds = (src.match(/if:\s*steps\.update\.outputs\.mode == 'steady'/g) || []).length;
  ok(conds >= 3,
    `expected the strict audit, the test run and the commit to be steady-gated — found ${conds} gates. ` +
    "In catch-up the local backfill owns the archive: a strict audit would fail on EXPECTED staleness " +
    "and open a false pipeline-failure issue every 6 hours.");
});

check("update-data.yml raises an alert when the pipeline fails", () => {
  const src = read("update-data.yml");
  ok(/if:\s*failure\(\)/.test(src), "no failure-conditional step — a dead pipeline would be silent");
  ok(/gh issue (create|comment)/.test(src), "failure path must open or update a tracking issue");
  ok(/issues:\s*write/.test(src), "issue creation needs issues: write");
});

check("update-data.yml still holds contents: write and pushes", () => {
  const src = read("update-data.yml");
  ok(/contents:\s*write/.test(src), "must be able to commit refreshed data");
  ok(/git push/.test(src), "must push");
});

/* ---------------------------------------------------------- CI workflow */

check("ci.yml runs both suites and cannot write to the repo", () => {
  const src = read("ci.yml");
  ok(/contents:\s*read/.test(src), "CI must be read-only");
  ok(!/contents:\s*write/.test(src), "CI must not hold write access");
  ok(/npm run test:core/.test(src) && /npm run test:dom/.test(src), "CI must run both suites");
});

check("ci.yml guards the zero-production-dependency claim", () => {
  const src = read("ci.yml");
  ok(/package-lock\.json/.test(src) && /!meta\.dev/.test(src),
    "CI must assert the lockfile carries no production dependencies");
});

/* ------------------------------------------------------------- report */

console.log(`\nWorkflow invariants: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
