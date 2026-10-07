// Publishes only the deployable files (the same set as the zip bundle) as the root of a `deploy` branch, so a host
// such as Render can build straight from it: Dockerfile, render.yaml, server/ and web/ at the top level, no tests,
// plugin sources or build tooling.
//   npm run deploy-branch                  commit the current files onto the local `deploy` branch
//   npm run deploy-branch -- -m "message"  same, with your own commit message
//   git push -u origin deploy              then publish it
// It works with git plumbing and a throwaway index, so your checkout, working tree and current branch are never touched.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INCLUDE_DIRS, INCLUDE_FILES } from './deploy-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'deploy';
const git = (args, { cwd = ROOT, env = process.env } = {}) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const exists = ref => { try { git(['rev-parse', '--verify', '-q', ref]); return true; } catch { return false; } };

const msgAt = process.argv.indexOf('-m');
const source = git(['rev-parse', '--short', 'HEAD']);
const message = (msgAt > 0 && process.argv[msgAt + 1]) || `Deploy build from ${source}`;

const dirty = git(['status', '--porcelain', '--', ...INCLUDE_DIRS, ...INCLUDE_FILES]);
if (dirty) console.warn(`Warning: these deployable files have uncommitted changes and are included as they are on disk:\n${dirty}\n`);

const stage = mkdtempSync(join(tmpdir(), 'licensex-deploy-'));
const index = stage + '.index';
try {
  for (const d of INCLUDE_DIRS) cpSync(join(ROOT, d), join(stage, d), { recursive: true });
  for (const f of INCLUDE_FILES) cpSync(join(ROOT, f), join(stage, f));
  // Only the scripts that exist on this branch (the tests and the bundler are not part of it).
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  pkg.scripts = { start: pkg.scripts.start, dev: pkg.scripts.dev };
  writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(join(stage, '.gitignore'), 'data/\nnode_modules/\nlicensex.config.json\n');

  const env = { ...process.env, GIT_DIR: git(['rev-parse', '--absolute-git-dir']), GIT_WORK_TREE: stage, GIT_INDEX_FILE: index };
  git(['add', '-A'], { cwd: stage, env });
  const tree = git(['write-tree'], { cwd: stage, env });

  const parent = [`refs/heads/${BRANCH}`, `refs/remotes/origin/${BRANCH}`].find(exists);
  if (parent && git(['rev-parse', `${parent}^{tree}`]) === tree) {
    console.log(`The ${BRANCH} branch already has exactly these files; nothing to commit.`);
  } else {
    const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
    git(['update-ref', `refs/heads/${BRANCH}`, commit]);
    const count = git(['ls-tree', '-r', '--name-only', tree]).split('\n').length;
    console.log(`${BRANCH} -> ${commit.slice(0, 7)} (${count} files). Publish it with: git push -u origin ${BRANCH}`);
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
  rmSync(index, { force: true });
}
