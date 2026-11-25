import type { Mode } from './types';

export type Suggestion = { kind: string; text: string; shell?: boolean };

/**
 * Starter prompts per space. Each pool is a flat list; the welcome screen shows
 * a small window of it and rotates through the rest, so the opening screen has
 * more to offer than the same four cards forever. Keep each pool a multiple of
 * PRESET_WINDOW so every page is a clean cut.
 */
export const PRESETS: Record<Mode, Suggestion[]> = {
  chat: [
    { kind: 'explain', text: 'Explain how OAuth device flow works, like I’m new to it' },
    { kind: 'write', text: 'Draft a short, friendly email declining a meeting' },
    { kind: 'decide', text: 'Compare Postgres and SQLite for a small internal tool' },
    { kind: 'brainstorm', text: 'Give me ten names for a developer newsletter' },
    { kind: 'summarise', text: 'Summarise a long document into five bullets I can skim' },
    { kind: 'rewrite', text: 'Rewrite this paragraph so it sounds plainer and less corporate' },
    { kind: 'plan', text: 'Plan a two-week trip to Lisbon on a mid-range budget' },
    { kind: 'explain', text: 'What actually happens when I type a URL into the browser?' },
    { kind: 'debug', text: 'My code works locally but fails in production. What should I check first?' },
    { kind: 'compare', text: 'Explain the difference between a process and a thread, with an analogy' },
    { kind: 'interview', text: 'Ask me five interview questions for a junior frontend role' },
    { kind: 'cook', text: 'Give me a weeknight dinner I can cook in 20 minutes from a normal fridge' },
    { kind: 'learn', text: 'Teach me the basics of regular expressions with small examples' },
    { kind: 'email', text: 'Turn these rough notes into a clear project update for my team' },
    { kind: 'advice', text: 'How do I say no to extra work without sounding difficult?' },
    { kind: 'math', text: 'Explain compound interest with a simple worked example' },
  ],
  code: [
    { kind: 'understand', text: 'Give me a tour of this codebase: entry points, structure, and how to run it' },
    { kind: 'fix', text: 'Run the tests and fix whatever is failing' },
    { kind: 'shell', text: 'git status', shell: true },
    { kind: 'review', text: 'Review my uncommitted changes for bugs and risky edits' },
    { kind: 'tests', text: 'Add tests for the trickiest function in this project' },
    { kind: 'refactor', text: 'Find duplicated logic and pull it into one helper' },
    { kind: 'perf', text: 'Find the slowest part of this code and tell me how to speed it up' },
    { kind: 'deps', text: 'Which dependencies are unused? List them before removing anything' },
    { kind: 'docs', text: 'Write a README that explains how to install, run and deploy this project' },
    { kind: 'types', text: 'Fix the type errors without changing runtime behaviour' },
    { kind: 'debug', text: 'This stack trace makes no sense. Find the root cause and fix it' },
    { kind: 'shell', text: 'git log --oneline -15', shell: true },
    { kind: 'security', text: 'Look for obvious security problems: injection, path traversal, exposed secrets' },
    { kind: 'cleanup', text: 'Remove dead code and leftover debug logging' },
    { kind: 'ci', text: 'Set up a CI workflow that runs lint and tests on every push' },
    { kind: 'explain', text: 'Explain what this project does in one paragraph a new teammate would understand' },
  ],
  design: [
    { kind: 'landing page', text: 'Design a landing page for a coffee subscription: warm, editorial, one clear call to action' },
    { kind: 'dashboard', text: 'Design an analytics dashboard for a small online shop: revenue, orders, top products' },
    { kind: 'mobile flow', text: 'Design a three-screen mobile onboarding for a habit tracker' },
    { kind: 'options', text: 'Give me three different directions for a pricing page, as separate files' },
    { kind: 'hero', text: 'Design a portfolio hero for a freelance photographer, image-led and quiet' },
    { kind: 'docs', text: 'Design a documentation site for a developer tool, with a sidebar and search' },
    { kind: 'settings', text: 'Design a settings screen for a desktop app, grouped and easy to scan' },
    { kind: 'checkout', text: 'Design a one-page checkout that feels calm and trustworthy' },
    { kind: 'empty state', text: 'Design empty states for a project list, a search and an inbox' },
    { kind: 'pricing', text: 'Design a three-tier pricing page for a B2B SaaS product' },
    { kind: 'onboarding', text: 'Design a five-step onboarding that does not feel like a form' },
    { kind: 'auth', text: 'Design sign-in, sign-up and password reset as one flow' },
    { kind: 'blog', text: 'Design a blog index and article page with a generous reading width' },
    { kind: 'table', text: 'Design a data table with filters, sorting and bulk actions' },
    { kind: 'dialog', text: 'Design a confirmation dialog that explains the consequences clearly' },
    { kind: 'mobile', text: 'Design a mobile home screen for a weather app with one strong visual' },
  ],
  cowork: [
    { kind: 'schedule', text: 'Every weekday at 9, summarise what changed in this repo since yesterday' },
    { kind: 'maintain', text: 'Once a week, check for outdated dependencies and list what is safe to upgrade' },
    { kind: 'do it now', text: 'Go through the TODO comments in this project and turn them into a prioritised report' },
    { kind: 'on a trigger', text: 'Set up a webhook automation that writes release notes from the commits it is sent' },
    { kind: 'schedule', text: 'Every Monday, list the pull requests that are waiting on review' },
    { kind: 'maintain', text: 'Every night, run the test suite and post a short pass or fail summary' },
    { kind: 'audit', text: 'Go through this repo and flag files that have no tests' },
    { kind: 'digest', text: 'Once a day, summarise new issues into one short message' },
    { kind: 'cleanup', text: 'Every Friday, list stale branches and what is safe to delete' },
    { kind: 'report', text: 'Build a weekly report of commits grouped by author' },
    { kind: 'watch', text: 'When a PR is opened, check that its description covers what the template asks for' },
    { kind: 'docs', text: 'Every month, list documentation that no longer matches the code' },
    { kind: 'health', text: 'Run a daily health check: disk, failing jobs, open security alerts' },
    { kind: 'triage', text: 'Sort new issues into bugs, chores and features, with a short note on each' },
    { kind: 'backup', text: 'Every Sunday, verify that the latest backup actually restores' },
    { kind: 'inbox', text: 'Summarise my unread notifications every morning at eight' },
  ],
};

/** How many starter prompts the welcome screen shows at once. */
export const PRESET_WINDOW = 4;

/** A wrapping slice of the pool, so a window never runs off the end. */
export function windowAt<T>(pool: readonly T[], start: number, count = PRESET_WINDOW): T[] {
  if (!pool.length) return [];
  const n = Math.min(count, pool.length);
  const base = ((start % pool.length) + pool.length) % pool.length;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(pool[(base + i) % pool.length]);
  return out;
}

/** The start index of the next full page of prompts. */
export function nextStart(start: number, poolLen: number, count = PRESET_WINDOW): number {
  if (poolLen <= 0) return 0;
  return (start + count) % poolLen;
}

/**
 * A different page's start index for the manual shuffle button. Picks among the
 * other pages so a tap always visibly changes the cards.
 */
export function randomStart(poolLen: number, current: number, count = PRESET_WINDOW, rng: () => number = Math.random): number {
  const pages = Math.floor(poolLen / count);
  if (pages <= 1) return 0;
  const cur = Math.floor(current / count) % pages;
  const pick = Math.floor(rng() * (pages - 1));
  return ((pick >= cur ? pick + 1 : pick) * count) % poolLen;
}
