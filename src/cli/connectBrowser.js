// CLI entry point for `shmakk connect-browser`.
// Connects to a running Chrome instance via CDP, enabling the agent
// to interact with the user's own authenticated browser sessions.
//
// Usage:
//   shmakk connect-browser              # auto-detect CDP port
//   shmakk connect-browser --port 9222  # connect to specific port
//   shmakk connect-browser --disconnect # disconnect
//   shmakk connect-browser --status     # show connection status

const path = require('path');
const fs = require('fs');

function resolveConnector() {
  try {
    return require('../core/browserConnector');
  } catch (e) {
    process.stderr.write(
      '[shmakk] Browser connector unavailable.\n' +
      '[shmakk] Install playwright: npm install playwright\n' +
      `[shmakk] Details: ${e.message}\n`,
    );
    process.exit(1);
  }
}

function parseArgs(argv) {
  const args = {
    port: null,
    disconnect: false,
    status: false,
    help: false,
  };

  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--port' || a === '-p') {
      args.port = parseInt(argv[++i], 10);
      if (isNaN(args.port) || args.port < 1 || args.port > 65535) {
        process.stderr.write(`[shmakk] invalid port: ${argv[i]}\n`);
        process.exit(2);
      }
    } else if (a === '--disconnect' || a === '-d') {
      args.disconnect = true;
    } else if (a === '--status' || a === '-s') {
      args.status = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === 'connect-browser') {
      // skip the subcommand name itself
    } else {
      process.stderr.write(`[shmakk] connect-browser: unknown option: ${a}\n`);
      args.help = true;
    }
    i++;
  }

  return args;
}

const HELP = `shmakk connect-browser — connect to a running Chrome instance via CDP

Usage:
  shmakk connect-browser [options]

Options:
  --port, -p <port>    Connect to Chrome on a specific CDP port (default: auto-detect)
  --disconnect, -d     Disconnect from Chrome
  --status, -s         Show connection status
  --help, -h           Show this help

Before running this command, start Chrome with remote debugging enabled:
  google-chrome-stable --remote-debugging-port=9222

When connected, the agent's browser tool will interact with your
Chrome instance, preserving logins, cookies, and extensions.
`;

async function main() {
  const rawArgs = process.argv.slice(2);

  // If no subcommand-like arg, default to connect.
  const args = parseArgs(rawArgs);

  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const bc = resolveConnector();

  if (!bc.isAvailable()) {
    process.stderr.write(
      '[shmakk] playwright is required for browser CDP connection.\n' +
      '[shmakk] Run: npm install playwright && npx playwright install chromium\n',
    );
    process.exit(1);
  }

  if (args.disconnect) {
    const result = await bc.disconnect();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  }

  if (args.status) {
    const result = await bc.getStatus();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  }

  // Default: connect
  const connectArgs = {};
  if (args.port) connectArgs.port = args.port;

  process.stdout.write('[shmakk] connecting to Chrome via CDP...\n');

  const result = await bc.connect(connectArgs);

  if (result.ok) {
    process.stdout.write(
      `[shmakk] connected to Chrome (port ${result.port})\n` +
      `[shmakk] current page: ${result.url || '(about:blank)'}\n` +
      `[shmakk] title: ${result.title || '(none)'}\n`,
    );
    process.exit(0);
  } else {
    process.stderr.write(`[shmakk] connection failed: ${result.error}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[shmakk] connect-browser fatal: ${err && err.stack || err}\n`);
  process.exit(1);
});
