'use strict';

/**
 * Where credentials are allowed to live.
 *
 * config.json is plain text: credentials never belong there. Windows uses
 * DPAPI, Linux uses Secret Service through secret-tool when available, and
 * macOS currently keeps the credential in memory for the running session.
 * Unsupported or locked keyrings fail visibly instead of writing a plaintext
 * token to disk. GitHub and AI provider credentials use separate names.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { userDataDir, ensureDir } = require('./paths');

const ENTROPY = 'GUITinstal/github-token';
const FILE_NAME = 'github-token.dpapi';
const MARKER = 'guitinstal-protected-v1:';
const memorySecrets = new Map();

function credentialName(name) {
  const value = String(name || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error('Invalid secure credential name.');
  return value;
}

function linuxAttributes(name) {
  return ['service', 'guitinstal', 'account', credentialName(name)];
}

function runSecretTool(args, input = '') {
  return execFileSync('secret-tool', args, {
    input,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function blobPath() {
  return path.join(userDataDir(), FILE_NAME);
}

function credentialPath(name) {
  const value = credentialName(name);
  return value === 'github-token' ? blobPath() : path.join(userDataDir(), `credential-${value}.dpapi`);
}

function entropyFor(name) {
  const value = credentialName(name);
  return value === 'github-token' ? ENTROPY : `GUITinstal/${value}`;
}

/**
 * The token travels over stdin, never inside argv: a command line would show it
 * to any other process that lists them. Only the fixed entropy string is inline.
 */
function protectScript(name) {
  const entropy = entropyFor(name);
  return [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$in=[Console]::In.ReadToEnd().Trim()',
    '$bytes=[Text.Encoding]::UTF8.GetBytes($in)',
    `$ent=[Text.Encoding]::UTF8.GetBytes('${entropy}')`,
    '$out=[Security.Cryptography.ProtectedData]::Protect($bytes,$ent,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
}

function unprotectScript(name) {
  const entropy = entropyFor(name);
  return [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$in=[Console]::In.ReadToEnd().Trim()',
    '$blob=[Convert]::FromBase64String($in)',
    `$ent=[Text.Encoding]::UTF8.GetBytes('${entropy}')`,
    '$out=[Security.Cryptography.ProtectedData]::Unprotect($blob,$ent,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($out))',
  ].join('; ');
}

function runPowerShell(script, input) {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      // Piped, not inherited: PowerShell's own error text must not land in the
      // app log, where it could be mistaken for a token.
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  return String(out || '').trim();
}

/** Reads a named secret without ever storing it in the settings JSON. */
function loadSecret(name) {
  const key = credentialName(name);
  if (process.platform === 'linux') {
    try {
      return { secret: String(runSecretTool(['lookup', ...linuxAttributes(key)]) || '').trim(), engine: 'linux-secret-service', detail: '' };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {
          secret: memorySecrets.get(key) || '',
          engine: 'memory-only',
          detail: 'Install secret-tool and enable a desktop keyring to keep this credential after closing the app.',
        };
      }
      if (error.status === 1 && !String(error.stderr || '').trim()) {
        return { secret: memorySecrets.get(key) || '', engine: 'linux-secret-service', detail: '' };
      }
      return {
        secret: memorySecrets.get(key) || '',
        engine: memorySecrets.has(key) ? 'memory-only' : 'linux-secret-service',
        detail: 'The Linux keyring is unavailable. Unlock it and save this credential again.',
      };
    }
  }

  if (process.platform !== 'win32') {
    return {
      secret: memorySecrets.get(key) || '',
      engine: 'memory-only',
      detail: 'This system has no supported secure store, so this credential lives only in this session.',
    };
  }

  let raw;
  try {
    raw = fs.readFileSync(credentialPath(key), 'utf8');
  } catch {
    return { secret: memorySecrets.get(key) || '', engine: memorySecrets.has(key) ? 'memory-only' : 'windows-dpapi', detail: '' };
  }

  let body = String(raw).trim();
  if (!body) return { secret: '', engine: 'windows-dpapi', detail: '' };
  if (body.startsWith(MARKER)) body = body.slice(MARKER.length);

  try {
    return { secret: runPowerShell(unprotectScript(key), body).trim(), engine: 'windows-dpapi', detail: '' };
  } catch {
    return {
      secret: '',
      engine: 'windows-dpapi',
      detail: 'Windows could not open this saved credential. Enter it again to replace it.',
    };
  }
}

/** Stores a named secret. Unsupported stores keep it in memory only. */
function saveSecret(name, secret) {
  const key = credentialName(name);
  const value = String(secret || '').trim();
  if (!value) memorySecrets.delete(key);

  if (process.platform === 'linux') {
    try {
      if (!value) {
        try {
          runSecretTool(['clear', ...linuxAttributes(key)]);
        } catch (error) {
          if (error.status !== 1 || String(error.stderr || '').trim()) throw error;
        }
        return { stored: false, engine: 'linux-secret-service', path: '', detail: '' };
      }
      runSecretTool(['store', `--label=GUITinstal ${key}`, ...linuxAttributes(key)], `${value}\n`);
      return { stored: true, engine: 'linux-secret-service', path: '', detail: '' };
    } catch (error) {
      const missingTool = error.code === 'ENOENT';
      if (value) memorySecrets.set(key, value);
      return {
        stored: false,
        engine: 'memory-only',
        path: '',
        detail: missingTool
          ? 'Install secret-tool and enable a desktop keyring to keep this credential after closing the app. It is only in memory for now.'
          : 'The Linux keyring could not save this credential. It is only in memory for now; unlock the desktop keyring and save it again.',
      };
    }
  }

  if (process.platform !== 'win32') {
    if (value) memorySecrets.set(key, value);
    return {
      stored: Boolean(value),
      engine: 'memory-only',
      path: '',
      detail: value ? 'This system has no supported secure store, so this credential lives only in this session.' : '',
    };
  }

  const file = credentialPath(key);
  if (!value) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* a file that is already gone needs no second delete */
    }
    return { stored: false, engine: 'windows-dpapi', path: file, detail: '' };
  }

  try {
    const blob = runPowerShell(protectScript(key), value);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, `${MARKER}${blob}`, { encoding: 'utf8' });
    return { stored: true, engine: 'windows-dpapi', path: file, detail: '' };
  } catch {
    memorySecrets.set(key, value);
    return {
      stored: false,
      engine: 'memory-only',
      path: '',
      detail: 'Windows refused to protect this credential. It is only in memory for this session and was not saved on disk.',
    };
  }
}

function load() {
  const result = loadSecret('github-token');
  return { token: result.secret, engine: result.engine, detail: result.detail };
}

function save(token) {
  return saveSecret('github-token', token);
}

/** Lets Settings tell the user how the credential is kept. */
function describe() {
  if (process.platform === 'linux') {
    return { engine: 'linux-secret-service', label: 'Linux desktop keyring (Secret Service)', path: '' };
  }
  if (process.platform !== 'win32') {
    return { engine: 'memory-only', label: 'held in this session only', path: '' };
  }
  return { engine: 'windows-dpapi', label: 'Windows protected storage (this user only)', path: blobPath() };
}

module.exports = { describe, load, loadSecret, save, saveSecret };
