const { startBrowserDaemon, DEFAULT_PORT, STATE_PATH } = require('../browser-daemon');

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'browser-daemon') continue;
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--port' || a === '-p') {
      args.port = parseInt(argv[++i], 10);
      if (isNaN(args.port) || args.port < 1 || args.port > 65535) {
        process.stderr.write(`[shmakk] browser-daemon: invalid port: ${argv[i]}\n`);
        process.exit(2);
      }
    } else {
      process.stderr.write(`[shmakk] browser-daemon: unknown option: ${a}\n`);
      args.help = true;
    }
  }
  return args;
}

const HELP = `shmakk browser-daemon — extension automation backend

Usage:
  shmakk browser-daemon [--port 3947]

Runs a single global WebSocket backend for the Chrome extension. State is
written to ${STATE_PATH}.
`;

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const daemon = await startBrowserDaemon({ port: args.port });
  process.stdout.write(`[shmakk browser-daemon] listening on ws://127.0.0.1:${daemon.port}\n`);
  process.stdout.write(`[shmakk browser-daemon] state: ${daemon.statePath}\n`);

  const shutdown = () => {
    process.stdout.write('\n[shmakk browser-daemon] shutting down\n');
    daemon.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise(() => {});
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[shmakk browser-daemon] fatal: ${err && err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = { main, HELP };
