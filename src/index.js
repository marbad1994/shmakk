const { parseArgs, HELP } = require('./cli');
const { normalizeProfile, resolveProfile } = require('./profiles');

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (opts.printConfig) {
    const profile = resolveProfile(opts.profile || process.env.AITERM_PROFILE);
    const cfg = {
      review: opts.review,
      yesFiles: opts.yesFiles,
      noAi: opts.noAi,
      noCorrection: opts.noCorrection,
      workspace: opts.workspace || process.cwd(),
      shell: process.env.SHELL,
      term: process.env.TERM,
      baseUrl: process.env.AITERM_BASE_URL || null,
      model: process.env.AITERM_MODEL || null,
      correctionModel: process.env.AITERM_CORRECTION_MODEL || null,
      agentModel: process.env.AITERM_AGENT_MODEL || null,
      chatModel: process.env.AITERM_CHAT_MODEL || null,
      profile: profile.name,
    };
    process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
    process.exit(0);
  }

  if (opts.updateGlossary) {
    const { updateGlossary } = require('./glossary');
    await updateGlossary({ debug: opts.debug });
    process.exit(0);
  }

  if (opts.status || opts.stats || opts.compact || opts.loadSkill || opts.resumeStatus || opts.exitNow || opts.restart || opts.reset || opts.profileSet) {
    const ctl = require('./control');
    if (opts.status) process.exit(ctl.status());
    if (opts.stats) process.exit(ctl.stats());
    if (opts.compact) process.exit(ctl.compactContext());
    if (opts.loadSkill) process.exit(ctl.loadSkill(opts.loadSkill));
    if (opts.resumeStatus) process.exit(ctl.resumeStatus());
    if (opts.exitNow) process.exit(ctl.exitParent());
    if (opts.restart) process.exit(ctl.restartParent());
    if (opts.reset) process.exit(ctl.resetConversation());
    if (opts.profileSet) process.exit(ctl.setProfileAndRestart(opts.profileSet));
  }

  if (opts.profile && !normalizeProfile(opts.profile)) {
    process.stderr.write('[aiterm] invalid --profile. Use: tiny|balanced|deep|builder|large-app\n');
    process.exit(2);
  }

  if (opts.unknown.length) {
    process.stderr.write(`[aiterm] unknown args: ${opts.unknown.join(' ')}\n`);
    process.stderr.write(HELP);
    process.exit(2);
  }

  const { start } = require('./orchestrator');
  const exitCode = await start(opts);
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`[aiterm] fatal: ${err && err.stack || err}\n`);
  process.exit(1);
});
