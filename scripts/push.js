#!/usr/bin/env node
/*
 * Interactive release helper — run with `npm run push`.
 *
 * Prompts for a release description, commits your changes, bumps the version
 * (patch/minor/major), and pushes the branch + tag. The GitHub Actions
 * "Publish to npm" workflow then publishes the new version automatically.
 *
 * Cross-platform and shell-injection-safe: git/npm are invoked with argument
 * arrays (no shell), so your description can contain any characters.
 */

const { execFileSync } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const root = process.env.INIT_CWD || process.cwd();
const pkgPath = path.join(root, 'package.json');

// --- helpers ---------------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: root, stdio: 'inherit', ...opts });
}
function gitOut(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
// Invoke npm via the running node + npm-cli.js so it works on Windows too
// (where bare `npm` is npm.cmd and execFileSync can't run it directly).
function npm(args) {
  const npmExec = process.env.npm_execpath;
  if (npmExec) {
    return execFileSync(process.execPath, [npmExec, ...args], { cwd: root, stdio: 'inherit' });
  }
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
  });
}

function ask(question, def = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim() || def);
    });
  });
}

function fail(msg) {
  console.error(`\n[31m✗[0m ${msg}`);
  process.exit(1);
}

function readVersion() {
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
}

// --- main ------------------------------------------------------------------

(async () => {
  try {
    gitOut(['rev-parse', '--is-inside-work-tree']);
  } catch {
    fail('Not a git repository.');
  }

  const branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
  const hasRemote = (() => {
    try { return !!gitOut(['remote']); } catch { return false; }
  })();
  if (!hasRemote) {
    fail('No git remote configured. Add one first:\n  git remote add origin https://github.com/Woopsyyy/MCPANEL.git');
  }

  const status = gitOut(['status', '--short']);
  console.log(`\n[36mmcpanel release[0m  (branch: ${branch}, current: v${readVersion()})`);
  if (status) {
    console.log('\nChanges to include:\n' + status.split('\n').map((l) => '  ' + l).join('\n') + '\n');
  } else {
    console.log('\nNo file changes — this will publish a fresh version bump.\n');
  }

  const desc = await ask('[1mRelease description:[0m ');
  if (!desc) fail('A description is required.');

  let bump = (await ask('[1mVersion bump[0m (patch/minor/major) [patch]: ', 'patch')).toLowerCase();
  if (!['patch', 'minor', 'major'].includes(bump)) fail(`Invalid bump "${bump}". Use patch, minor or major.`);

  // 1) Commit the work under the given description (empty commit if nothing changed,
  //    so the description is always recorded for this release).
  if (status) git(['add', '-A']);
  git(['commit', ...(status ? [] : ['--allow-empty']), '-m', desc]);

  // 2) Bump version -> creates a commit + annotated tag (no user text passed to npm).
  npm(['version', bump]);
  const version = readVersion();

  // 3) Push branch + tags -> triggers the publish workflow.
  console.log(`\nPushing ${branch} and tag v${version}...`);
  git(['push', '--follow-tags']);

  console.log(`\n[32m✓[0m Pushed. GitHub Actions will publish [1m@woopsy/mcpanel@${version}[0m to npm.`);
  console.log('  Watch: https://github.com/Woopsyyy/MCPANEL/actions');
})().catch((err) => {
  fail(err.message || String(err));
});
