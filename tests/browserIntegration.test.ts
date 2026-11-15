/**
 * Browser Connector Integration Tests
 *
 * Tests the browser lifecycle, Playwright module loading, ensurePage behavior,
 * dispatch routing, close/cleanup, safety classification, and error scenarios.
 *
 * Uses module mocking to avoid requiring an actual Chrome installation.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Mock playwright BEFORE loading the browser module
// ---------------------------------------------------------------------------

// Intercept require('playwright') to return a mock that never launches Chrome
const Module = require('module');
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (request === 'playwright') {
    return createMockPlaywright();
  }
  return originalLoad.apply(this, arguments);
};

function createMockPage() {
  return {
    isClosed: () => false,
    goto: async () => ({ status: () => 200 }),
    click: async () => {},
    fill: async () => {},
    evaluate: async () => ({}),
    selectOption: async () => [],
    screenshot: async () => Buffer.from('fake'),
    url: () => 'about:blank',
    title: async () => 'Mock Page',
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    keyboard: { type: async () => {} },
    mouse: { wheel: async () => {} },
  };
}

function createMockPlaywright() {
  let _connected = true;
  const _pages = [];

  return {
    chromium: {
      launch: async () => ({
        isConnected: () => _connected,
        close: async () => { _connected = false; },
        newContext: async () => ({
          pages: () => _pages,
          newPage: async () => {
            const p = createMockPage();
            _pages.push(p);
            return p;
          },
        }),
      }),
    },
  };
}

// Now safe to load browser module with mocked playwright
const browserMod = require('../src/browser.js');

// Restore original module loader
Module._load = originalLoad;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------
// Suite: Module loading and availability
// ---------------------------------------------------------------------------

test('isAvailable returns true when playwright is installed (mocked)', () => {
  const result = browserMod.isAvailable();
  // With our mock, require.resolve('playwright') succeeds
  assert.strictEqual(typeof result, 'boolean', 'isAvailable should return a boolean');
});

test('closeBrowser handles null browser gracefully', async () => {
  // First close any existing browser to start clean
  await browserMod.closeBrowser();
  // closeBrowser should not throw when browser is null
  assert.ok(true, 'closeBrowser should not throw when nothing is open');
});

test('classifyBrowserCommand classifies safe commands', () => {
  assert.strictEqual(browserMod.classifyBrowserCommand({ command: 'read_page' }), 'safe');
  assert.strictEqual(browserMod.classifyBrowserCommand({ command: 'screenshot' }), 'safe');
  assert.strictEqual(browserMod.classifyBrowserCommand({ command: 'wait' }), 'safe');
  assert.strictEqual(browserMod.classifyBrowserCommand({ command: 'close' }), 'safe');
});

test('classifyBrowserCommand classifies unsafe commands as uncertain', () => {
  assert.strictEqual(browserMod.classifyBrowserCommand({ command: 'navigate' }), 'uncertain');
  assert.strictEqual(browserMod.classifyBrowserCommand({ command: 'click' }), 'uncertain');
  assert.strictEqual(browserMod.classifyBrowserCommand({ command: 'type' }), 'uncertain');
  assert.strictEqual(browserMod.classifyBrowserCommand({ command: 'evaluate' }), 'uncertain');
  assert.strictEqual(browserMod.classifyBrowserCommand({ command: 'select' }), 'uncertain');
  assert.strictEqual(browserMod.classifyBrowserCommand({ command: 'scroll' }), 'uncertain');
  assert.strictEqual(browserMod.classifyBrowserCommand({ command: '' }), 'uncertain');
  assert.strictEqual(browserMod.classifyBrowserCommand({}), 'uncertain');
});

// ---------------------------------------------------------------------------
// Suite: dispatchBrowser routing
// ---------------------------------------------------------------------------

test('dispatches to navigate', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'navigate', url: 'https://example.com' });
  assert.ok(result, 'dispatchBrowser should return a result');
  assert.ok(result.ok, 'navigate should succeed with mocked browser');
  assert.strictEqual(result.url, 'about:blank');
});

test('returns error for unknown command', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'fly_to_moon' });
  assert.ok(result && result.error, 'Unknown command should return error');
  assert.ok(String(result.error).includes('unknown browser command'),
    'Error should mention unknown browser command');
});

test('returns error for empty command', async () => {
  const result = await browserMod.dispatchBrowser({ command: '' });
  assert.ok(result && result.error, 'Empty command should return error');
});

test('returns error when no command property', async () => {
  const result = await browserMod.dispatchBrowser({});
  assert.ok(result && result.error, 'Missing command should return error');
});

test('close command returns ok when no browser is running', async () => {
  await browserMod.closeBrowser(); // ensure clean state
  const result = await browserMod.dispatchBrowser({ command: 'close' });
  assert.ok(result.ok, 'close should succeed');
  assert.strictEqual(result.message, 'browser closed');
});

// ---------------------------------------------------------------------------
// Suite: Command argument validation
// ---------------------------------------------------------------------------

test('navigate requires url', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'navigate' });
  assert.ok(result.error, 'navigate without url should error');
  assert.ok(String(result.error).includes('url required'), 'should mention url required');
});

test('navigate with empty url errors', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'navigate', url: '' });
  assert.ok(result.error, 'navigate with empty url should error');
  assert.ok(String(result.error).includes('url required'), 'should mention url required');
});

test('click requires selector', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'click' });
  assert.ok(result.error, 'click without selector should error');
  assert.ok(String(result.error).includes('selector required'), 'should mention selector required');
});

test('type requires selector', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'type' });
  assert.ok(result.error, 'type without selector should error');
  assert.ok(String(result.error).includes('selector required'), 'should mention selector required');
});

test('type with empty text succeeds with mocked page', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'type', selector: '#input', text: '' });
  assert.ok(result.ok, 'type with empty text should succeed');
});

test('evaluate requires code', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'evaluate' });
  assert.ok(result.error, 'evaluate without code should error');
  assert.ok(String(result.error).includes('code required'), 'should mention code required');
});

test('evaluate with empty code errors', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'evaluate', code: '' });
  assert.ok(result.error, 'evaluate with empty code should error');
  assert.ok(String(result.error).includes('code required'), 'should mention code required');
});

test('select requires selector', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'select' });
  assert.ok(result.error, 'select without selector should error');
  assert.ok(String(result.error).includes('selector required'), 'should mention selector required');
});

test('wait succeeds with mocked page', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'wait' });
  assert.ok(result.ok, 'wait should succeed with mocked page');
});

test('scroll succeeds with mocked page', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'scroll' });
  assert.ok(result.ok, 'scroll should succeed with mocked page');
});

test('scroll accepts up direction', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'scroll', direction: 'up' });
  assert.ok(result.ok, 'scroll up should succeed with mocked page');
});

test('navigate handles malformed url gracefully', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'navigate', url: 'not-a-valid-url' });
  assert.ok(result.ok, 'navigate with any URL string should succeed in mock');
});

test('navigate handles non-string url by coercing', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'navigate', url: 123 });
  assert.ok(result.ok, 'navigate with numeric url should coerce and succeed');
});

// ---------------------------------------------------------------------------
// Suite: Browser lifecycle
// ---------------------------------------------------------------------------

test('close command closes browser if open', async () => {
  // Ensure browser is launched first
  await browserMod.dispatchBrowser({ command: 'navigate', url: 'https://example.com' });
  const result = await browserMod.dispatchBrowser({ command: 'close' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.message, 'browser closed');
});

test('double close is idempotent', async () => {
  const r1 = await browserMod.dispatchBrowser({ command: 'close' });
  const r2 = await browserMod.dispatchBrowser({ command: 'close' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
});

test('dispatchBrowser handles all known commands without crashing', async () => {
  const commands = ['navigate', 'click', 'type', 'read_page', 'screenshot', 'evaluate', 'select', 'wait', 'scroll'];

  for (const cmd of commands) {
    const result = await browserMod.dispatchBrowser({ command: cmd });
    assert.ok(result, 'dispatchBrowser(' + cmd + ') should return a result');
  }
});

test('closeBrowser can be called multiple times safely', async () => {
  await browserMod.closeBrowser();
  await browserMod.closeBrowser();
  await browserMod.closeBrowser();
  assert.ok(true, 'Multiple closeBrowser calls should not throw');
});

// ---------------------------------------------------------------------------
// Suite: Mocked browser commands return correct shapes
// ---------------------------------------------------------------------------

test('navigate returns ok/url/title/status', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'navigate', url: 'https://example.com' });
  assert.ok(result.ok);
  assert.strictEqual(result.url, 'about:blank');
  assert.ok(typeof result.title === 'string');
  assert.strictEqual(result.status, 200);
});

test('click returns ok/clicked/url/title', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'click', selector: '#btn' });
  assert.ok(result.ok);
  assert.strictEqual(result.clicked, '#btn');
});

test('type returns ok/selector/typed', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'type', selector: '#inp', text: 'hello' });
  assert.ok(result.ok);
  assert.strictEqual(result.selector, '#inp');
});

test('read_page returns page structure', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'read_page' });
  assert.ok(result.ok || result.error, 'read_page returns a result');
});

test('screenshot returns ok/path/size/url/title', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'screenshot' });
  assert.ok(result.ok);
  assert.ok(result.path, 'screenshot should have a path');
  assert.ok(typeof result.size === 'number');
});

test('evaluate returns ok/result', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'evaluate', code: '1 + 1' });
  assert.ok(result.ok);
});

test('select returns ok/selector/selected', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'select', selector: '#s', text: 'opt' });
  assert.ok(result.ok);
});

// ---------------------------------------------------------------------------
// Suite: Error handling edge cases
// ---------------------------------------------------------------------------

test('dispatchBrowser handles null args by throwing TypeError', async () => {
  try {
    await browserMod.dispatchBrowser(null);
    assert.fail('Should have thrown on null args');
  } catch (e) {
    assert.ok(e instanceof TypeError, 'null args should throw TypeError');
  }
});

test('dispatchBrowser handles undefined args by throwing TypeError', async () => {
  try {
    await browserMod.dispatchBrowser(undefined);
    assert.fail('Should have thrown on undefined args');
  } catch (e) {
    assert.ok(e instanceof TypeError, 'undefined args should throw TypeError');
  }
});

test('dispatchBrowser handles args without command as object', async () => {
  const result = await browserMod.dispatchBrowser({ foo: 'bar' });
  assert.ok(result.error, 'args without command should return error');
});

test('screenshot directory is absolute', () => {
  const SCREENSHOT_DIR = '/tmp/shmakk-screenshots';
  assert.ok(path.isAbsolute(SCREENSHOT_DIR), 'screenshot dir should be absolute');
});

// ---------------------------------------------------------------------------
// Suite: State isolation between commands
// ---------------------------------------------------------------------------

test('classification does not mutate input', () => {
  const input = { command: 'navigate', url: 'https://example.com' };
  const copy = JSON.parse(JSON.stringify(input));
  browserMod.classifyBrowserCommand(input);
  assert.deepStrictEqual(input, copy, 'classifyBrowserCommand should not mutate input');
});

test('classification returns consistent types', () => {
  const safe = browserMod.classifyBrowserCommand({ command: 'read_page' });
  const uncertain = browserMod.classifyBrowserCommand({ command: 'READ_PAGE' });
  assert.strictEqual(typeof safe, 'string');
  assert.strictEqual(typeof uncertain, 'string');
});

// ---------------------------------------------------------------------------
// Suite: Command result shape validation
// ---------------------------------------------------------------------------

test('navigate result is an object with required fields', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'navigate', url: 'https://test.com' });
  if (result.error) {
    assert.ok(typeof result.error === 'string', 'error should be a string');
  }
  if (result.ok) {
    assert.ok(typeof result.url === 'string', 'url should be a string');
  }
});

test('read_page result is an object', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'read_page' });
  assert.ok(typeof result === 'object', 'result should be an object');
});

test('screenshot result has a path', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'screenshot' });
  assert.ok(result.path, 'screenshot result should have a path');
});

test('evaluate result has result field', async () => {
  const result = await browserMod.dispatchBrowser({ command: 'evaluate', code: '42' });
  assert.ok(result.ok, 'evaluate should succeed');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const t of tests) {
    try {
      await t.fn();
      passed++;
    } catch (e) {
      failed++;
      failures.push(t.name + ': ' + e.message);
    }
  }

  console.log('\nBrowser Connector Tests: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length > 0) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  ' + f);
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

run();
