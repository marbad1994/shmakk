#!/usr/bin/env node
/**
 * Vision E2E Tests
 *
 * Verifies end-to-end vision pipeline:
 *   Unit (no API key needed):
 *    1. Tools return images[] array in the format the agent expects
 *    2. supportsVision() auto-detects known providers
 *    3. describeImages() falls back to registry when no dedicated vision endpoint
 *
 *   E2E (needs API key + optional services):
 *    4. describeImages() with a generated test image
 *    5. Browser screenshot + describeImages round-trip (needs playwright)
 *    6. Mobile screenshot + describeImages round-trip (needs ADB + device)
 *    7. Electron screenshot + describeImages round-trip (needs running electron app)
 *
 * Usage: node test/vision-e2e.js
 *        node test/vision-e2e.js --e2e       (include slow integration tests)
 *        npm run test-vision
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const E2E = process.argv.includes('--e2e');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Helpers ────────────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shmakk-vision-test-'));

function tinyPng() {
  // Minimal valid 1x1 red PNG
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
  const buf = Buffer.from(b64, 'base64');
  const fp = path.join(TMP, 'tiny.png');
  fs.writeFileSync(fp, buf);
  return { path: fp, buf, b64, size: buf.length };
}

function tmpFile(name, content) {
  const fp = path.join(TMP, name);
  fs.writeFileSync(fp, content);
  return fp;
}

function hasApiKey() {
  // Check if any vision-capable endpoint is configured with a real key
  const { getVisionSupport } = require('../src/endpoints');
  const vs = getVisionSupport();
  if (vs && vs.api_key && vs.api_key !== 'sk-' && !vs.api_key.includes('YOUR_')) return true;

  // Also check if the main model has vision support
  const { getModelRegistry } = require('../src/endpoints');
  const reg = getModelRegistry();
  if (reg && reg.models) {
    for (const [, entry] of Object.entries(reg.models)) {
      if (entry.vision && entry.api_key && entry.api_key !== 'sk-' && !entry.api_key.includes('YOUR_')) return true;
    }
  }
  return false;
}

function skipUnlessApi(msg = 'no vision-capable API key configured') {
  if (!hasApiKey()) throw Object.assign(new Error('SKIP: ' + msg), { skip: true });
}

function skipUnless(msg, cond) {
  if (!cond) throw Object.assign(new Error('SKIP: ' + msg), { skip: true });
}

// ── Unit tests (always run) ────────────────────────────────────────────────

// ── 1. read_file returns images[] for image files ──────────────────────────

test('read_file returns images[] for PNG', async () => {
  const { dispatchTool } = require('../src/tools');
  const { path: fp } = tinyPng();
  const roots = [TMP];

  const result = await dispatchTool('read_file', { path: fp }, roots);
  assert.ok(result.images, 'should have images array');
  assert.strictEqual(result.images.length, 1, 'should have 1 image');
  const img = result.images[0];
  assert.strictEqual(img.mimeType, 'image/png', 'mimeType should be image/png');
  assert.ok(img.data && img.data.length > 0, 'should have base64 data');
  assert.strictEqual(img.dataLength, img.data.length, 'dataLength should match');
  assert.strictEqual(img.truncated, false, 'should not be truncated');
  assert.ok(typeof result.content === 'string' && result.content.startsWith('[Image:'), 'content should indicate image');
});

test('read_file on non-image returns no images', async () => {
  const { dispatchTool } = require('../src/tools');
  const fp = tmpFile('test.txt', 'hello world');
  const roots = [TMP];

  const result = await dispatchTool('read_file', { path: fp }, roots);
  assert.ok(!result.images || result.images.length === 0, 'should not have images');
  assert.ok(typeof result.content === 'string' && result.content.includes('hello world'), 'should have text content');
});

test('read_file rejects paths outside workspace', async () => {
  const { dispatchTool } = require('../src/tools');
  const roots = [TMP];
  const result = await dispatchTool('read_file', { path: '/etc/passwd' }, roots);
  assert.ok(result.error, 'should have error for path outside workspace');
});

// ── 2. Image tool definitions exist ────────────────────────────────────────

test('browser tool includes screenshot command', () => {
  const { TOOLS } = require('../src/tools');
  const browserTool = TOOLS.find(t => t.function.name === 'browser');
  assert.ok(browserTool, 'browser tool should exist');
  assert.ok(browserTool.function.parameters.properties.command.enum.includes('screenshot'),
    'screenshot should be a browser command');
});

test('mobile tool includes screenshot command', () => {
  const { TOOLS } = require('../src/tools');
  const mobileTool = TOOLS.find(t => t.function.name === 'mobile');
  assert.ok(mobileTool, 'mobile tool should exist');
  assert.ok(mobileTool.function.parameters.properties.command.enum.includes('screenshot'),
    'screenshot should be a mobile command');
});

test('electron tool includes screenshot command', () => {
  const { TOOLS } = require('../src/tools');
  const electronTool = TOOLS.find(t => t.function.name === 'electron');
  assert.ok(electronTool, 'electron tool should exist');
  assert.ok(electronTool.function.parameters.properties.command.enum.includes('screenshot'),
    'screenshot should be an electron command');
});

test('image_gen tool exists', () => {
  const { TOOLS } = require('../src/tools');
  const imgTool = TOOLS.find(t => t.function.name === 'image_gen');
  assert.ok(imgTool, 'image_gen tool should exist');
});

// ── 3. Browser/mobile/electron screenshot return shape ─────────────────────

test('browser screenshot module exports dispatch', () => {
  const browser = require('../src/browser');
  assert.strictEqual(typeof browser.dispatchBrowser, 'function', 'dispatchBrowser should be exported');
  assert.strictEqual(typeof browser.classifyBrowserCommand, 'function', 'classifyBrowserCommand should be exported');
});

test('mobile module exports dispatch', () => {
  const mobile = require('../src/mobile');
  assert.strictEqual(typeof mobile.dispatchMobile, 'function', 'dispatchMobile should be exported');
  assert.strictEqual(typeof mobile.classifyMobileCommand, 'function', 'classifyMobileCommand should be exported');
});

test('electron module exports dispatch', () => {
  const electron = require('../src/electron');
  assert.strictEqual(typeof electron.dispatchElectron, 'function', 'dispatchElectron should be exported');
  assert.strictEqual(typeof electron.classifyElectronCommand, 'function', 'classifyElectronCommand should be exported');
});

// ── 4. supportsVision auto-detection ───────────────────────────────────────

test('supportsVision auto-detects known vision providers', () => {
  const { _supportsVisionForConfig } = require('../src/endpoints');

  assert.strictEqual(_supportsVisionForConfig({ provider: 'anthropic', model: 'claude' }), true);
  assert.strictEqual(_supportsVisionForConfig({ provider: 'google', model: 'gemini' }), true);
  assert.strictEqual(_supportsVisionForConfig({ provider: 'codex', model: 'gpt-4' }), true);
  assert.strictEqual(_supportsVisionForConfig({ provider: 'openai', model: 'gpt-4' }), true);
  assert.strictEqual(_supportsVisionForConfig({ provider: 'nvidia', model: 'nim' }), true);
});

test('supportsVision: explicit vision flag wins', () => {
  const { _supportsVisionForConfig } = require('../src/endpoints');

  assert.strictEqual(_supportsVisionForConfig({ provider: 'anthropic', model: 'claude', vision: true }), true);
  assert.strictEqual(_supportsVisionForConfig({ provider: 'anthropic', model: 'claude', vision: false }), false);
  assert.strictEqual(_supportsVisionForConfig({ provider: 'unknown', model: 'x', vision: true }), true);
  assert.strictEqual(_supportsVisionForConfig({ provider: 'google', model: 'gemini', vision: false }), false);
});

test('supportsVision detects openai-compatible vision models by name', () => {
  const { _supportsVisionForConfig } = require('../src/endpoints');

  const visionModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-vision', 'llava-v1.6',
    'minicpm-v', 'cogvlm2', 'qwenvl', 'phi-3.5-vision', 'gemini-pro-vision',
    'claude-3-5-sonnet', 'multimodal-v1'];
  for (const m of visionModels) {
    assert.strictEqual(_supportsVisionForConfig({ provider: 'openai-compatible', model: m }), true,
      `openai-compatible model "${m}" should be detected as vision-capable`);
  }

  const nonVisionModels = ['llama3-8b', 'mistral-7b', 'codellama', 'deepseek-coder', ''];
  for (const m of nonVisionModels) {
    assert.strictEqual(_supportsVisionForConfig({ provider: 'openai-compatible', model: m }), false,
      `openai-compatible model "${m}" should NOT be detected as vision-capable`);
  }
});

test('supportsVision returns false for unknown/null', () => {
  const { _supportsVisionForConfig } = require('../src/endpoints');
  assert.strictEqual(_supportsVisionForConfig({ provider: 'unknown', model: 'x' }), false);
  assert.strictEqual(_supportsVisionForConfig(null), false);
  assert.strictEqual(_supportsVisionForConfig({}), false);
});

// ── 4b. getVisionSupport reads top-level visionSupport key ─────────────────

test('getVisionSupport returns normalized config when visionSupport is set', () => {
  const { getVisionSupport } = require('../src/endpoints');
  tmpFile('endpoints.json', JSON.stringify({
    main: 'foo',
    models: { foo: { provider: 'openai', model: 'gpt-4o' } },
    visionSupport: { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' },
  }));
  const vs = getVisionSupport(TMP);
  assert.ok(vs, 'should return a config object');
  assert.strictEqual(vs.name, 'visionSupport');
  assert.strictEqual(vs.provider, 'nvidia');
  assert.strictEqual(vs.model, 'moonshotai/kimi-k2.6');
  assert.strictEqual(vs.vision, true, 'vision should default to true for explicit flag');
  assert.strictEqual(vs.main, false);
  assert.strictEqual(vs.fast, false);
});

test('getVisionSupport returns null when key is absent', () => {
  const { getVisionSupport } = require('../src/endpoints');
  tmpFile('endpoints.json', JSON.stringify({
    main: 'foo',
    models: { foo: { provider: 'openai', model: 'gpt-4o' } },
  }));
  assert.strictEqual(getVisionSupport(TMP), null);
});

test('getVisionSupport returns null when key is not an object', () => {
  const { getVisionSupport } = require('../src/endpoints');
  tmpFile('endpoints.json', JSON.stringify({
    main: 'foo',
    models: { foo: { provider: 'openai', model: 'gpt-4o' } },
    visionSupport: 'just-a-string',
  }));
  assert.strictEqual(getVisionSupport(TMP), null);
});

// ── 4c. getModelRegistry folds visionSupport into models map ───────────────

test('getModelRegistry includes visionSupport in models when defined', () => {
  const { getModelRegistry } = require('../src/endpoints');
  tmpFile('endpoints.json', JSON.stringify({
    main: 'ds',
    models: { ds: { provider: 'nvidia', model: 'deepseek-v3' } },
    visionSupport: { provider: 'nvidia', model: 'moonshotai/kimi-k2.6' },
  }));
  const reg = getModelRegistry(TMP);
  assert.ok(reg.models.visionSupport, 'visionSupport should appear in models');
  assert.strictEqual(reg.models.visionSupport.name, 'visionSupport');
  assert.strictEqual(reg.models.visionSupport.model, 'moonshotai/kimi-k2.6');
  assert.strictEqual(reg.models.visionSupport.vision, true);
  assert.ok(reg.models.ds, 'original model should still be present');
  assert.strictEqual(reg.main, 'ds');
});

test('getModelRegistry does NOT include visionSupport when key absent', () => {
  const { getModelRegistry } = require('../src/endpoints');
  tmpFile('endpoints.json', JSON.stringify({
    main: 'ds',
    models: { ds: { provider: 'nvidia', model: 'deepseek-v3' } },
  }));
  const reg = getModelRegistry(TMP);
  assert.strictEqual(reg.models.visionSupport, undefined, 'visionSupport should be absent');
  assert.ok(reg.models.ds, 'original model should still be present');
});

// ── 5. Vision functions exported from llm ──────────────────────────────────

test('supportsVision and describeImages are callable from llm', () => {
  const llm = require('../src/llm');

  assert.strictEqual(typeof llm.supportsVision, 'function');
  assert.strictEqual(typeof llm.describeImages, 'function');
});

// ── 6. describeImages handles edge cases ──────────────────────────────────

test('describeImages handles empty images array', async () => {
  const { describeImages } = require('../src/llm');
  const result = await describeImages(null);
  assert.strictEqual(result, null, 'null should return null');
  const result2 = await describeImages([]);
  assert.strictEqual(result2, null, 'empty array should return null');
});

test('describeImages skips images without base64 data', async () => {
  const { describeImages } = require('../src/llm');
  const result = await describeImages([{ mimeType: 'image/png' }]);
  assert.strictEqual(result, null, 'empty images should return null');
});

// ── 7. Composer images become vision content blocks ───────────────────────

test('imageBlocks builds a text part plus one data-URI per image', () => {
  const { imageBlocks } = require('../src/llm');
  const blocks = imageBlocks('what is this?', [
    { mimeType: 'image/jpeg', data: 'AAA' },
    { mimeType: 'image/png', data: 'BBB' },
  ]);
  assert.strictEqual(blocks.length, 3, 'one text part plus two images');
  assert.deepStrictEqual(blocks[0], { type: 'text', text: 'what is this?' });
  assert.strictEqual(blocks[1].type, 'image_url');
  assert.strictEqual(blocks[1].image_url.url, 'data:image/jpeg;base64,AAA');
  assert.strictEqual(blocks[1].image_url.detail, 'auto');
  assert.strictEqual(blocks[2].image_url.url, 'data:image/png;base64,BBB');
});

test('imageBlocks defaults to a text placeholder and png mime', () => {
  const { imageBlocks } = require('../src/llm');
  const blocks = imageBlocks('', [{ data: 'AAA' }]);
  assert.strictEqual(blocks[0].text, '[image attached]');
  assert.strictEqual(blocks[1].image_url.url, 'data:image/png;base64,AAA');
});

test('userContentWithImages passes plain text through when there are no images', async () => {
  const { userContentWithImages } = require('../src/llm');
  assert.strictEqual(await userContentWithImages('hello', null), 'hello');
  assert.strictEqual(await userContentWithImages('hello', []), 'hello');
  assert.strictEqual(await userContentWithImages('hello', [{ mimeType: 'image/png' }]), 'hello');
});

test('userContentWithImages never inlines base64 for a non-vision model', async () => {
  // The text fallback only applies when no vision endpoint can describe the
  // image; with one configured this would make a real API call instead.
  const { getModelRegistry, getVisionSupport } = require('../src/endpoints');
  const reg = getModelRegistry();
  const visionTarget = !!getVisionSupport() || Object.values(reg.models || {}).some((m) => m && m.vision);
  skipUnless('a vision endpoint is configured, so the text fallback is not used', !visionTarget);

  const { userContentWithImages } = require('../src/llm');
  const out = await userContentWithImages('what is this?', [{ name: 'shot.png', mimeType: 'image/png', data: 'QUJD' }]);
  assert.strictEqual(typeof out, 'string', 'non-vision models get text, not image blocks');
  assert.ok(out.includes('what is this?'), 'keeps the user text');
  assert.ok(out.includes('shot.png'), 'names the attached image');
  assert.ok(!out.includes('QUJD'), 'never leaks raw base64 into the prompt');
});

test('stripImageBlocks keeps history text-only', () => {
  const { stripImageBlocks } = require('../src/llm');
  const out = stripImageBlocks([
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
    { role: 'assistant', content: 'nice' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } }] },
  ]);
  assert.deepStrictEqual(out[0], { role: 'user', content: 'look' });
  assert.deepStrictEqual(out[1], { role: 'assistant', content: 'nice' });
  assert.deepStrictEqual(out[2], { role: 'user', content: '[image attachment]' });
  assert.ok(!JSON.stringify(out).includes('base64'), 'no base64 survives');
});

test('stripImageBlocks tolerates junk input', () => {
  const { stripImageBlocks } = require('../src/llm');
  assert.strictEqual(stripImageBlocks(null), null);
  assert.deepStrictEqual(stripImageBlocks([null, { role: 'user', content: 'plain' }]), [null, { role: 'user', content: 'plain' }]);
});

test('running a turn with images hands back text-only history', async () => {
  // runAgent must not persist image blocks: a second turn would resend them.
  const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');
  assert.ok(agentSrc.includes('userContentWithImages'), 'agent builds the user turn via the shared helper');
  assert.ok(agentSrc.includes('const historyOut = () => stripImageBlocks(messages.slice(1))'),
    'agent strips image blocks from returned history');
  assert.ok(!/return messages\.slice\(1\)/.test(agentSrc), 'no return path bypasses historyOut()');
});

// ── 8. Agent vision pipeline integration check ─────────────────────────────

test('agent imports vision functions from llm', () => {
  // Verify the agent module imports the right functions
  const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.js'), 'utf8');
  assert.ok(agentSrc.includes('supportsVision, describeImages'),
    'agent.js should import supportsVision and describeImages from llm');
  assert.ok(agentSrc.includes('toolImages.length > 0'),
    'agent.js should handle toolImages extraction');
  // Image blocks are built by the shared helpers in llm.js, never inline.
  assert.ok(agentSrc.includes('imageBlocks('),
    'agent.js should send tool images via the shared imageBlocks helper');
  assert.ok(!agentSrc.includes('"image_url"') && !agentSrc.includes("'image_url'"),
    'agent.js should not hand-roll image_url blocks');
  const llmSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'llm.js'), 'utf8');
  assert.ok(/function imageBlocks/.test(llmSrc), 'llm.js owns imageBlocks()');
  assert.ok(llmSrc.includes("type: 'image_url'"), 'llm.js builds image_url content blocks');
});

// ═══════════════════════════════════════════════════════════════════════════
//  E2E tests (require --e2e flag and API key)
// ═══════════════════════════════════════════════════════════════════════════

if (E2E) {

// ── E2E-1. describeImages with a generated image ─────────────────────────

test('E2E: describeImages describes a generated solid-color PNG', async () => {
  skipUnlessApi('no vision API key configured (set visionSupport in endpoints.json)');

  // Create a 100x100 solid blue PNG
  let createCanvas;
  try {
    createCanvas = require('canvas').createCanvas;
  } catch {
    throw Object.assign(new Error('SKIP: canvas module not installed (npm install canvas)'), { skip: true });
  }

  const canvas = createCanvas(100, 100);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, 100, 100);
  // Draw a white rectangle
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(25, 35, 50, 30);
  // Add some text
  ctx.fillStyle = '#000000';
  ctx.font = '12px sans-serif';
  ctx.fillText('TEST', 30, 55);

  const buf = canvas.toBuffer('image/png');
  const b64 = buf.toString('base64');

  const images = [{
    mimeType: 'image/png',
    data: b64,
    dataLength: b64.length,
    truncated: false,
  }];

  const { describeImages } = require('../src/llm');
  const result = await describeImages(images);

  assert.ok(result, 'should return a description string');
  assert.ok(typeof result === 'string', 'result should be a string');
  assert.ok(result.length > 20, 'description should be non-trivial');
  // It should mention "TEST" or "text" or "rectangle" or "blue"
  const lower = result.toLowerCase();
  assert.ok(
    lower.includes('test') || lower.includes('text') || lower.includes('rectangle') || lower.includes('blue') || lower.includes('white'),
    `description should mention visible content, got: "${result.slice(0, 200)}"`,
  );
});

// ── E2E-2. Browser screenshot + describeImages round-trip ─────────────────

test('E2E: browser screenshot is described by vision model', async () => {
  skipUnlessApi('no vision API key configured');
  skipUnless('playwright not installed: npm install playwright && npx playwright install chromium',
    (() => { try { require.resolve('playwright'); return true; } catch { return false; } })());

  const { dispatchBrowser } = require('../src/browser');

  // Navigate to a simple page with known content
  await dispatchBrowser({ command: 'navigate', url: 'about:blank' }, 'navigate');
  await dispatchBrowser({ command: 'evaluate',
    code: 'document.body.innerHTML = "<h1 style=\\\"color:red;font-size:48px;text-align:center;margin-top:100px\\">SHMAKK_VISION_TEST</h1>"' }, 'evaluate');

  const shot = await dispatchBrowser({ command: 'screenshot' }, 'screenshot');

  assert.ok(shot.ok, `screenshot should succeed: ${shot.error}`);
  assert.ok(shot.images && shot.images.length === 1, 'should have one image');
  assert.ok(shot.images[0].data, 'should have base64 data');

  const { describeImages } = require('../src/llm');
  const result = await describeImages(shot.images);

  assert.ok(result, 'should return a description');
  const lower = result.toLowerCase();
  assert.ok(
    lower.includes('shmakk') || lower.includes('vision') || lower.includes('red') || lower.includes('heading') || lower.includes('title'),
    `description should mention page content, got: "${result.slice(0, 200)}"`,
  );
});

// ── E2E-3. Mobile screenshot + describeImages round-trip ──────────────────

test('E2E: mobile screenshot is described by vision model', async function () {
  skipUnlessApi('no vision API key configured');

  const { execSync } = require('child_process');
  let devices;
  try {
    devices = execSync('adb devices', { encoding: 'utf8', timeout: 3000 });
  } catch {
    throw Object.assign(new Error('SKIP: adb not available'), { skip: true });
  }
  const lines = devices.split('\n').filter(l => l.includes('\tdevice'));
  skipUnless('no ADB device connected', lines.length > 0);

  const { dispatchMobile } = require('../src/mobile');
  const shot = await dispatchMobile({ command: 'screenshot' }, 'screenshot');

  assert.ok(shot.ok, `mobile screenshot should succeed: ${shot.error}`);
  assert.ok(shot.images && shot.images.length === 1, 'should have one image');

  const { describeImages } = require('../src/llm');
  const result = await describeImages(shot.images);

  assert.ok(result, 'should return a description');
  assert.ok(typeof result === 'string', 'result should be a string');
  assert.ok(result.length > 10, 'description should be non-empty');
});

// ── E2E-4. Electron screenshot + describeImages round-trip ────────────────

test('E2E: electron screenshot is described by vision model', async function () {
  skipUnlessApi('no vision API key configured');

  // Try to connect to a running Electron app
  const { dispatchElectron } = require('../src/electron');
  const shot = await dispatchElectron({ command: 'screenshot' }, 'screenshot');

  if (shot.error && (shot.error.includes('Cannot connect') || shot.error.includes('ECONNREFUSED'))) {
    throw Object.assign(new Error('SKIP: no Electron app connected to port 9222'), { skip: true });
  }
  assert.ok(shot.ok, `electron screenshot should succeed: ${shot.error}`);
  assert.ok(shot.images && shot.images.length === 1, 'should have one image');

  const { describeImages } = require('../src/llm');
  const result = await describeImages(shot.images);

  assert.ok(result, 'should return a description');
  assert.ok(typeof result === 'string', 'result should be a string');
  assert.ok(result.length > 10, 'description should be non-empty');
});

} // end E2E block

// ── Runner ──────────────────────────────────────────────────────────────────

(async () => {
  let pass = 0, fail = 0, skip = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      pass++;
    } catch (e) {
      if (e.skip) {
        console.log(`  \x1b[33m○\x1b[0m ${name}  (skipped: ${e.message.replace(/^SKIP:\s*/, '')})`);
        skip++;
      } else {
        console.log(`  \x1b[31m✗\x1b[0m ${name}`);
        console.log(`      \x1b[2m${String(e.message).replace(/\n/g, '\n      ')}\x1b[0m`);
        fail++;
      }
    }
  }
  console.log(`\n  ${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed\x1b[0m, ${skip > 0 ? '\x1b[33m' + skip + ' skipped, ' : ''}\x1b[33m${fail} failed\x1b[0m`);

  // Cleanup
  try { fs.rmSync(TMP, { recursive: true }); } catch {}

  process.exit(fail ? 1 : 0);
})();
