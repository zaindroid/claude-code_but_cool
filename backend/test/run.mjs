// Runs every *.test.mjs in this directory and reports a single verdict.
//
// Each test is spawned as its own process rather than imported, for two reasons: they call
// process.exit() to signal their own result (so an import would end the run at the first file),
// and they each mutate global state -- fs.chownSync, process.env.DATA_DIR -- which must not leak
// between them.
//
// cwd is pinned to the repo root because the tests resolve `backend/src/...` relative to it, so
// the suite behaves the same whether it is started from the repo root or from backend/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const files = fs
  .readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (!files.length) {
  console.error('No tests found');
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  console.log(`\n\u001b[1m── ${f} ──\u001b[0m`);
  const res = spawnSync(process.execPath, [path.join(here, f)], { cwd: repoRoot, stdio: 'inherit' });
  if (res.status !== 0) failed++;
}

console.log(
  failed
    ? `\n\u001b[31m${failed} of ${files.length} test file(s) failed\u001b[0m`
    : `\n\u001b[32mall ${files.length} test file(s) passed\u001b[0m`
);
process.exit(failed ? 1 : 0);
