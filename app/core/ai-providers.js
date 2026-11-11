'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { ensureDir, userDataDir } = require('./paths');
const secrets = require('./secret-store');

const MAX_PROVIDERS = 8;
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SECRET_NAME = (id) => `ai-${id}`;

function configPath() {
  return path.join(ensureDir(userDataDir()), 'ai-providers.json');
}

function readProfiles() {
  let raw;
  try {
    raw = fs.readFileSync(configPath(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Could not read AI provider settings: ${error.message}`);
  }
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error('expected an array');
    if (data.length > MAX_PROVIDERS) throw new Error('too many providers');
    const profiles = data.map((item) => validateProfile(item, item));
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
      throw new Error('duplicate provider IDs');
    }
    return profiles;
  } catch (error) {
    throw new Error(`AI provider settings are invalid: ${error.message}`);
  }
}

function writeProfiles(profiles) {
  const file = configPath();
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(profiles, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function privateAddress(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal') {
    return true;
  }
  const version = net.isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (version === 6) {
    return host === '::1' || host === '::' || host.startsWith('fc') ||
      host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') ||
      host.startsWith('fea') || host.startsWith('feb');
  }
  return false;
}

function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('Enter a valid HTTPS OpenAI-compatible API URL.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || privateAddress(parsed.hostname)) {
    throw new Error('AI providers must use a public HTTPS URL without embedded credentials.');
  }
  if (parsed.search || parsed.hash) throw new Error('The provider URL cannot contain a query string or fragment.');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function validateProfile(input, existing = null) {
  const id = String(input.id || existing?.id || crypto.randomUUID()).trim();
  if (!PROFILE_ID.test(id)) throw new Error('Invalid AI provider ID.');
  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 60);
  const model = String(input.model ?? existing?.model ?? '').trim().slice(0, 120);
  if (!name) throw new Error('Name this AI provider.');
  if (!model) throw new Error('Enter the model ID supplied by the provider.');
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? existing?.baseUrl);
  return {
    id,
    name,
    baseUrl,
    model,
    noCost: input.noCost === undefined ? Boolean(existing?.noCost) : input.noCost === true,
    enabled: input.enabled === undefined ? (existing ? existing.enabled !== false : true) : input.enabled === true,
  };
}

function publicProfile(profile) {
  const saved = secrets.loadSecret(SECRET_NAME(profile.id));
  return {
    ...profile,
    hasApiKey: Boolean(saved.secret),
    credentialNote: saved.detail,
    credentialStorage: saved.engine,
  };
}

function listAiProviders() {
  return readProfiles().map(publicProfile);
}

function aiProviderCredentials() {
  return readProfiles()
    .filter((profile) => profile.enabled !== false && profile.noCost === true)
    .map((profile) => {
      const saved = secrets.loadSecret(SECRET_NAME(profile.id));
      return { ...profile, apiKey: saved.secret, credentialNote: saved.detail };
    })
    .filter((profile) => profile.apiKey);
}

function saveAiProvider(input = {}) {
  const profiles = readProfiles();
  const existing = profiles.find((profile) => profile.id === input.id);
  const profile = validateProfile(input, existing);
  if (!existing && profiles.length >= MAX_PROVIDERS) {
    throw new Error(`You can configure up to ${MAX_PROVIDERS} AI providers.`);
  }

  const apiKey = String(input.apiKey || '').trim();
  if (!apiKey && !secrets.loadSecret(SECRET_NAME(profile.id)).secret) {
    throw new Error('Enter an API key for this provider. The key is never returned to the browser or written to settings.');
  }
  if (apiKey) {
    if (apiKey.length > 2000 || /[\r\n]/.test(apiKey)) throw new Error('The API key is invalid.');
    secrets.saveSecret(SECRET_NAME(profile.id), apiKey);
  }
  const next = existing
    ? profiles.map((item) => (item.id === existing.id ? profile : item))
    : [...profiles, profile];
  writeProfiles(next);
  return publicProfile(profile);
}

function reorderAiProviders(ids) {
  if (!Array.isArray(ids)) throw new Error('Provider order must be a list of IDs.');
  const profiles = readProfiles();
  const idSet = new Set(profiles.map((profile) => profile.id));
  if (ids.length !== profiles.length || new Set(ids).size !== ids.length || ids.some((id) => !idSet.has(id))) {
    throw new Error('Provider order must include each configured provider exactly once.');
  }
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const ordered = ids.map((id) => byId.get(id));
  writeProfiles(ordered);
  return ordered.map(publicProfile);
}

function removeAiProvider(id) {
  const key = String(id || '').trim();
  if (!PROFILE_ID.test(key)) throw new Error('Invalid AI provider ID.');
  const profiles = readProfiles();
  if (!profiles.some((profile) => profile.id === key)) throw new Error('AI provider not found.');
  secrets.saveSecret(SECRET_NAME(key), '');
  writeProfiles(profiles.filter((profile) => profile.id !== key));
}

module.exports = {
  aiProviderCredentials,
  listAiProviders,
  normalizeBaseUrl,
  removeAiProvider,
  reorderAiProviders,
  saveAiProvider,
};
