#!/usr/bin/env node
// Standalone test: start vibedit overlay on any running URL or HTML file.
// Usage: node scripts/test-vibedit.js <url-or-file> [projectDir]
// Examples:
//   node scripts/test-vibedit.js http://localhost:5173
//   node scripts/test-vibedit.js ~/my-project/index.html
//   node scripts/test-vibedit.js ./demo.html

const { startVibedit } = require('../src/vibedit');

const args = process.argv.slice(2);
const target = args[0];
const projectDir = args[1] || process.cwd();

if (!target) {
  console.error('Usage: node scripts/test-vibedit.js <url-or-file> [projectDir]');
  console.error('  URL:     http://localhost:5173');
  console.error('  File:    ~/my-project/index.html');
  console.error('  Relpath: ./demo.html');
  process.exit(1);
}

console.log(`Starting vibedit on ${target} (project: ${projectDir})`);
console.log('A Chromium window will open with the overlay puck in the bottom-right.');
console.log('Click the puck to chat, make changes live, then click Save.');
console.log('Ctrl-C to stop.\n');

startVibedit({
  projectDir,
  appUrl: target,
  onSpec: (spec, specPath) => {
    console.log(`\n[test] Spec saved! ${spec.summary || '(no summary)'}`);
    console.log(`[test] Spec file: ${specPath}`);
    console.log('[test] In a real session, this would be injected into the next agent run.\n');
  },
}).then(({ shutdown }) => {
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await shutdown();
    process.exit(0);
  });
}).catch(err => {
  console.error('Failed to start vibedit:', err.message);
  process.exit(1);
});
