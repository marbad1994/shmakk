const fish = require('./fish');
const bash = require('./bash');
const zsh = require('./zsh');

function configureForShell(name) {
  switch (name) {
    case 'fish': return fish.configure();
    case 'bash': return bash.configure();
    case 'zsh': return zsh.configure();
    default: return { args: ['-i'], env: {}, cleanup: () => {} };
  }
}

module.exports = { configureForShell };
