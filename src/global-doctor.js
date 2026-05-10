const { execSync } = require('child_process');

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); }
  catch (e) { return (e.stdout || e.message || '').toString().trim(); }
}

const prefix = run('npm config get prefix');
const root = run('npm root -g');
const whichShmakk = run('which shmakk || true');
const pathValue = process.env.PATH || '';

console.log('Global doctor');
console.log('-------------');
console.log('npm prefix :', prefix);
console.log('npm root   :', root);
console.log('which shmakk:', whichShmakk || '(not found)');

if (!whichShmakk) {
  console.log('\n`shmakk` is not on PATH.');
  console.log('Run: npm run global:setup');
  console.log('Then open a new terminal and run:');
  console.log('  shmakk --help');
}

if (whichShmakk) {
  console.log('\nLooks good. Try:');
  console.log('  shmakk --help');
}

if (!pathValue.includes('/bin')) {
  console.log('\nPATH looks unusual; verify your shell init files.');
}
