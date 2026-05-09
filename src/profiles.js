const PRESETS = {
  tiny: { contextMode: 'tiny', maxToolIters: 10 },
  balanced: { contextMode: 'balanced', maxToolIters: 16 },
  deep: { contextMode: 'deep', maxToolIters: 24 },
};

function normalizeProfile(name) {
  const n = String(name || '').toLowerCase();
  return PRESETS[n] ? n : null;
}

function resolveProfile(name) {
  const key = normalizeProfile(name) || 'balanced';
  return { name: key, ...PRESETS[key] };
}

module.exports = { PRESETS, normalizeProfile, resolveProfile };
