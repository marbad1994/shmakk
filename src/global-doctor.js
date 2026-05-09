const { execSync } = require('child_process');

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); }
  catch (e) { return (e.stdout || e.message || '').toString().trim(); }
}

const prefix = run('npm config get prefix');
const root = run('npm root -g');
const whichAiterm = run('which aiterm || true');
const pathValue = process.env.PATH || '';

console.log('Global doctor');
console.log('-------------');
console.log('npm prefix :', prefix);
console.log('npm root   :', root);
console.log('which aiterm:', whichAiterm || '(not found)');

if (!whichAiterm) {
  console.log('\n`aiterm` is not on PATH.');
  console.log('Run: npm run global:setup');
  console.log('Then open a new terminal and run:');
  console.log('  aiterm --help');
}

if (whichAiterm) {
  console.log('\nLooks good. Try:');
  console.log('  aiterm --help');
}

if (!pathValue.includes('/bin')) {
  console.log('\nPATH looks unusual; verify your shell init files.');
}
