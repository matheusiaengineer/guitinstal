'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { userDataDir, ensureDir } = require('./paths');
const { download, extractArchive, sha256 } = require('./runtime-install');

const ENGINE = {
  file: 'llama-runtime.zip',
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12110/llama-b12110-bin-win-cpu-x64.zip',
  sha256: '98901e327c252875accaf2d1bf364e10e868843b0b63468baad1aa945cdc5da2',
  size: 24708445,
};
const MODEL = {
  id: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
  file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf?download=true',
  sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
  size: 1117320736,
  license: 'Apache-2.0',
};
const VISION_MODEL = {
  id: 'ggml-org/SmolVLM-500M-Instruct-GGUF',
  file: 'SmolVLM-500M-Instruct-Q8_0.gguf',
  url: 'https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/72e986006ef53e37cdd3f6d4241c90b0f01df376/SmolVLM-500M-Instruct-Q8_0.gguf?download=true',
  sha256: '9d4612de6a42214499e301494a3ecc2be0abdd9de44e663bda63f1152fad1bf4',
  size: 436806912,
  license: 'Apache-2.0',
};
const VISION_PROJECTOR = {
  file: 'mmproj-SmolVLM-500M-Instruct-Q8_0.gguf',
  url: 'https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/72e986006ef53e37cdd3f6d4241c90b0f01df376/mmproj-SmolVLM-500M-Instruct-Q8_0.gguf?download=true',
  sha256: 'd1eb8b6b23979205fdf63703ed10f788131a3f812c7b1f72e0119d5d81295150',
  size: 108783360,
};

let installPromise = null;
let installingKind = '';
let engineProcess = null;
let enginePort = 0;
let engineKey = '';
let engineKind = '';
let engineStartup = null;
let engineStartupKind = '';
let inferenceQueue = Promise.resolve();
let installController = null;
let progress = { status: 'idle', message: '', error: '' };

function aiRoot() {
  return path.join(userDataDir(), 'ai');
}

function modelPath() {
  return path.join(aiRoot(), MODEL.file);
}

function visionDir() {
  return path.join(aiRoot(), 'vision');
}

function visionModelPath() {
  return path.join(visionDir(), VISION_MODEL.file);
}

function visionProjectorPath() {
  return path.join(visionDir(), VISION_PROJECTOR.file);
}

function enginePath() {
  return path.join(aiRoot(), 'runtime');
}

function manifestPath() {
  return path.join(aiRoot(), 'verified-assets.json');
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  } catch {
    return {};
  }
}

function findFile(dir, name, depth = 5) {
  if (depth < 0 || !fs.existsSync(dir)) return '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return file;
    if (entry.isDirectory()) {
      const nested = findFile(file, name, depth - 1);
      if (nested) return nested;
    }
  }
  return '';
}

function supported() {
  return process.platform === 'win32' && process.arch === 'x64';
}

function isInstalled(kind = 'text') {
  if (!supported()) return false;
  const manifest = readManifest();
  try {
    const runtimeReady = manifest.runtimeSha256 === ENGINE.sha256 && Boolean(findFile(enginePath(), 'llama-server.exe'));
    if (kind === 'vision') {
      return (
        runtimeReady &&
        manifest.visionModelSha256 === VISION_MODEL.sha256 &&
        manifest.visionProjectorSha256 === VISION_PROJECTOR.sha256 &&
        fs.statSync(visionModelPath()).size === VISION_MODEL.size &&
        fs.statSync(visionProjectorPath()).size === VISION_PROJECTOR.size
      );
    }
    return runtimeReady && manifest.modelSha256 === MODEL.sha256 && fs.statSync(modelPath()).size === MODEL.size;
  } catch {
    return false;
  }
}

function getStatus() {
  const modelInstalled = isInstalled('text');
  const visionInstalled = isInstalled('vision');
  return {
    supported: supported(),
    installed: modelInstalled,
    visionInstalled,
    status: progress.status,
    installingKind: ['downloading', 'installing'].includes(progress.status) ? installingKind : '',
    message: progress.message,
    error: progress.error,
    model: MODEL.id,
    modelSize: MODEL.size,
    visionModel: VISION_MODEL.id,
    visionModelSize: VISION_MODEL.size + VISION_PROJECTOR.size,
    modelLicense: MODEL.license,
    running: Boolean(engineProcess && engineProcess.exitCode === null),
    unavailableReason: supported() ? '' : 'The local AI model is currently available only for Windows x64.',
  };
}

function report(stage, message) {
  progress = { status: stage, message: String(message || ''), error: '' };
}

async function downloadAsset(asset, destination, stage, signal) {
  report(stage, `Downloading ${asset.file}…`);
  const received = await download(asset.url, destination, 0, (message) => report(stage, message), signal);
  if (received !== asset.size) {
    throw new Error(`The ${asset.file} download was incomplete (${received} of ${asset.size} bytes).`);
  }
  report(stage, `Verifying ${asset.file}…`);
  const digest = await sha256(destination);
  if (digest !== asset.sha256) {
    throw new Error(`The ${asset.file} checksum did not match. The downloaded file was discarded.`);
  }
}

async function installEngine() {
  const runtime = enginePath();
  const existing = findFile(runtime, 'llama-server.exe');
  if (existing && readManifest().runtimeSha256 === ENGINE.sha256) return existing;

  const root = aiRoot();
  const archive = path.join(root, `${ENGINE.file}.part`);
  const stage = path.join(root, '.runtime-staging');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(runtime, { recursive: true, force: true });
  ensureDir(root);
  try {
    await downloadAsset(ENGINE, archive, 'downloading', installController.signal);
    if (installController.signal.aborted) throw new Error('Local AI download cancelled.');
    ensureDir(stage);
    report('installing', 'Preparing the local AI runtime…');
    await extractArchive(archive, stage);
    const stagedExe = findFile(stage, 'llama-server.exe');
    if (!stagedExe) throw new Error('The verified llama.cpp package did not contain llama-server.exe.');
    fs.renameSync(stage, runtime);
    const executable = findFile(runtime, 'llama-server.exe');
    if (!executable) throw new Error('The local AI runtime could not be installed.');
    return executable;
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function installModel() {
  const destination = modelPath();
  const manifest = readManifest();
  if (fs.existsSync(destination)) {
    const existing = fs.statSync(destination);
    if (existing.isFile() && manifest.modelSha256 === MODEL.sha256 && existing.size === MODEL.size) return;
    if (existing.isFile() && existing.size === MODEL.size) {
      report('installing', 'Verifying the previously downloaded model…');
      if ((await sha256(destination)) === MODEL.sha256) return;
    }
    fs.rmSync(destination, { recursive: true, force: true });
  }

  const partial = `${destination}.part`;
  fs.rmSync(partial, { force: true });
  try {
    await downloadAsset(MODEL, partial, 'downloading', installController.signal);
    if (installController.signal.aborted) throw new Error('Local AI download cancelled.');
    fs.renameSync(partial, destination);
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

async function ensureModelAsset(asset, destination, manifestKey) {
  const manifest = readManifest();
  if (fs.existsSync(destination)) {
    const existing = fs.statSync(destination);
    if (existing.isFile() && manifest[manifestKey] === asset.sha256 && existing.size === asset.size) return;
    if (existing.isFile() && existing.size === asset.size) {
      report('installing', `Verifying the previously downloaded ${asset.file}…`);
      if ((await sha256(destination)) === asset.sha256) return;
    }
    fs.rmSync(destination, { recursive: true, force: true });
  }
  ensureDir(path.dirname(destination));
  const partial = `${destination}.part`;
  fs.rmSync(partial, { force: true });
  try {
    await downloadAsset(asset, partial, 'downloading', installController.signal);
    if (installController.signal.aborted) throw new Error('Local AI download cancelled.');
    fs.renameSync(partial, destination);
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

function writeVerifiedAssets(updates) {
  fs.writeFileSync(manifestPath(), JSON.stringify({ ...readManifest(), ...updates }, null, 2), 'utf8');
}

function beginInstall(kind, work) {
  if (!supported()) throw new Error(getStatus().unavailableReason);
  if (installPromise) {
    if (installingKind === kind) return installPromise;
    throw new Error('Another AI download is already running. Wait for it to finish or cancel it first.');
  }
  installingKind = kind;
  installPromise = (async () => {
    ensureDir(aiRoot());
    installController = new AbortController();
    progress = { status: 'installing', message: 'Preparing the local AI…', error: '' };
    try {
      await work();
      progress = { status: 'ready', message: kind === 'vision' ? 'Local screen vision is installed and ready.' : 'Local AI is installed and ready.', error: '' };
      return getStatus();
    } catch (error) {
      if (installController.signal.aborted) {
        progress = { status: 'idle', message: 'Local AI download cancelled.', error: '' };
        throw new Error('Local AI download cancelled.');
      }
      progress = { status: 'error', message: '', error: error.message };
      throw error;
    } finally {
      installController = null;
      installingKind = '';
      installPromise = null;
    }
  })();
  return installPromise;
}

function install() {
  return beginInstall('text', async () => {
    await installEngine();
    await installModel();
    writeVerifiedAssets({ runtimeSha256: ENGINE.sha256, modelSha256: MODEL.sha256 });
  });
}

function installVision() {
  return beginInstall('vision', async () => {
    await installEngine();
    await ensureModelAsset(VISION_MODEL, visionModelPath(), 'visionModelSha256');
    await ensureModelAsset(VISION_PROJECTOR, visionProjectorPath(), 'visionProjectorSha256');
    writeVerifiedAssets({
      runtimeSha256: ENGINE.sha256,
      visionModelSha256: VISION_MODEL.sha256,
      visionProjectorSha256: VISION_PROJECTOR.sha256,
    });
  });
}

function reservePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function stop() {
  if (engineProcess && engineProcess.exitCode === null) engineProcess.kill();
  engineProcess = null;
  enginePort = 0;
  engineKey = '';
  engineKind = '';
  engineStartup = null;
  engineStartupKind = '';
}

async function stopAndWait() {
  const child = engineProcess;
  stop();
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function start(kind = 'text') {
  if (!isInstalled(kind)) {
    throw new Error(kind === 'vision' ? 'Install the local vision model before analyzing a screen.' : 'Install the local AI model before using it.');
  }
  if (engineProcess && engineProcess.exitCode === null && enginePort && engineKind === kind) {
    return { port: enginePort, key: engineKey };
  }
  if (engineProcess && engineProcess.exitCode === null) await stopAndWait();
  if (engineStartup && engineStartupKind === kind) return engineStartup;

  engineStartupKind = kind;
  engineStartup = (async () => {
    const executable = findFile(enginePath(), 'llama-server.exe');
    const port = await reservePort();
    const key = require('node:crypto').randomBytes(24).toString('hex');
    const binaryDir = path.dirname(executable);
    const selectedModel = kind === 'vision' ? VISION_MODEL : MODEL;
    const selectedModelPath = kind === 'vision' ? visionModelPath() : modelPath();
    const args = [
      '--model',
      selectedModelPath,
      ...(kind === 'vision' ? ['--mmproj', visionProjectorPath()] : []),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--ctx-size',
      '4096',
      '--threads',
      String(Math.max(1, Math.min(4, os.cpus().length - 1))),
      '--n-gpu-layers',
      '0',
      '--no-webui',
      '--api-key',
      key,
    ];
    const child = spawn(
      executable,
      args,
      {
        cwd: binaryDir,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, PATH: `${binaryDir};${process.env.PATH || ''}` },
      }
    );
    engineProcess = child;
    enginePort = port;
    engineKey = key;
    engineKind = kind;
    let spawnError = null;
    child.once('exit', () => {
      if (engineProcess === child) stop();
    });
    child.once('error', (error) => {
      spawnError = error;
      if (engineProcess === child) stop();
    });

    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (spawnError) throw new Error('The local AI engine could not start on this computer.');
      if (child.exitCode !== null) throw new Error('The local AI engine stopped while loading the model.');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) return { port, key };
      } catch {
        // The server is still loading; check it again shortly.
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    stop();
    throw new Error('The local AI engine did not finish loading within two minutes.');
  })();
  try {
    return await engineStartup;
  } finally {
    engineStartup = null;
    engineStartupKind = '';
  }
}

async function complete(messages, maxTokens = 1200, { imageDataUrl = '' } = {}) {
  const kind = imageDataUrl ? 'vision' : 'text';
  const run = async () => {
    if (imageDataUrl && (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl) || imageDataUrl.length > 1400000)) {
      throw new Error('The screen image is invalid or too large. Capture a smaller image and try again.');
    }
    const { port, key } = await start(kind);
    const requestMessages = messages.map((message, index) => {
      const text = String(message.content || '').slice(0, message.role === 'system' ? 2500 : 10000);
      if (kind !== 'vision' || message.role !== 'user' || index !== messages.length - 1) {
        return { role: message.role, content: text };
      }
      return {
        role: message.role,
        content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      };
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: kind === 'vision' ? VISION_MODEL.id : MODEL.id,
        messages: requestMessages,
        temperature: 0.2,
        max_tokens: Math.min(maxTokens, 1200),
        stream: false,
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`The local AI engine returned HTTP ${response.status}.`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((part) => part.text || '').join('\n') : String(content || '');
    if (!text.trim()) throw new Error('The local AI engine returned an empty answer.');
    return text.trim();
  };
  const queued = inferenceQueue.then(run, run);
  inferenceQueue = queued.catch(() => {});
  return queued;
}

async function remove() {
  if (installPromise) throw new Error('Cancel the active AI download before removing local files.');
  await stopAndWait();
  fs.rmSync(aiRoot(), { recursive: true, force: true });
  progress = { status: 'idle', message: '', error: '' };
  return getStatus();
}

function cancelInstall() {
  if (installController) installController.abort();
  return getStatus();
}

process.once('exit', stop);

module.exports = {
  complete,
  cancelInstall,
  getStatus,
  install,
  installVision,
  isInstalled,
  remove,
  supported,
};
