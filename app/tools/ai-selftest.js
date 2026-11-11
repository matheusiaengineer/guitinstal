'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const originalUserData = process.env.GUITINSTAL_USER_DATA;
  const originalFetch = global.fetch;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guitinstal-ai-'));
  process.env.GUITINSTAL_USER_DATA = path.join(tempRoot, 'data');

  try {
    const providers = require('../core/ai-providers');
    const { answerWithAI, suggestFileRepair } = require('../core/ai');
    const { applyProjectFile, readProjectFile } = require('../core/file-repair');
    const { projectGuide } = require('../core/project-guide');
    const secretStore = require('../core/secret-store');

    secretStore.save('github-selftest-token');
    assert.equal(secretStore.load().token, 'github-selftest-token');
    secretStore.save('');
    assert.equal(secretStore.load().token, '');
    console.log('ok   preserves the existing GitHub credential store API');

    assert.throws(
      () => providers.saveAiProvider({ name: 'Unsafe', baseUrl: 'http://api.example.com/v1', model: 'm', apiKey: 'key' }),
      /public HTTPS URL/
    );
    assert.throws(
      () => providers.saveAiProvider({ name: 'Local', baseUrl: 'https://127.0.0.1/v1', model: 'm', apiKey: 'key' }),
      /public HTTPS URL/
    );
    console.log('ok   rejects insecure and local provider endpoints');

    const first = providers.saveAiProvider({
      name: 'Free One',
      baseUrl: 'https://first.example/v1',
      model: 'free-one',
      apiKey: 'first-secret-value',
      noCost: true,
    });
    const paid = providers.saveAiProvider({
      name: 'Paid Profile',
      baseUrl: 'https://paid.example/v1',
      model: 'paid-model',
      apiKey: 'paid-secret-value',
      noCost: false,
    });
    const second = providers.saveAiProvider({
      name: 'Free Two',
      baseUrl: 'https://second.example/v1',
      model: 'free-two',
      apiKey: 'second-secret-value',
      noCost: true,
    });
    assert.equal(first.hasApiKey, true);
    const rawSettings = fs.readFileSync(path.join(process.env.GUITINSTAL_USER_DATA, 'ai-providers.json'), 'utf8');
    assert.equal(rawSettings.includes('first-secret-value'), false);
    assert.equal(JSON.stringify(providers.listAiProviders()).includes('second-secret-value'), false);
    providers.reorderAiProviders([first.id, paid.id, second.id]);
    console.log('ok   keeps API keys out of provider settings and exposes only safe profiles');

    let attempts = [];
    global.fetch = async (url, options) => {
      attempts.push({ url: String(url), model: JSON.parse(options.body).model, body: options.body });
      if (String(url).startsWith('https://first.example/')) {
        return { ok: false, status: 429, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'The test error is explained.' } }] }),
      };
    };
    const localOnly = await answerWithAI('Why did it fail?', {}, false);
    assert.equal(attempts.length, 0);
    assert.equal(localOnly.provider.configured, false);
    const aiAnswer = await answerWithAI('Why did it fail?', {}, true);
    assert.deepEqual(attempts.map((attempt) => attempt.model), ['free-one', 'free-two']);
    assert.equal(attempts.some((attempt) => attempt.model === 'paid-model'), false);
    assert.equal(aiAnswer.lines[0], 'The test error is explained.');
    assert.match(aiAnswer.provider.note, /Only providers marked no-cost were tried/);
    console.log('ok   uses explicit consent and falls back only to enabled no-cost providers');

    const project = path.join(tempRoot, 'project');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'src', 'app.js'), "console.log('old');\n", 'utf8');
    fs.writeFileSync(path.join(project, '.env'), 'TOKEN=secret-value\n', 'utf8');
    fs.writeFileSync(path.join(project, 'src', 'invalid.bin'), Buffer.from([0xff]));
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ scripts: { start: 'node src/app.js', dev: 'node src/app.js' } }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(project, 'README.md'),
      '# Demo\n\n## Getting Started\nInstall dependencies with npm install.\nRun locally with npm run dev.\nAPI_KEY=top-secret-value\n',
      'utf8'
    );
    const guide = projectGuide(project);
    assert.equal(guide.stack, 'Node.js');
    assert.equal(guide.scripts.dev, 'node src/app.js');
    assert.match(guide.readmeInstructions, /npm run dev/);
    assert.doesNotMatch(guide.readmeInstructions, /top-secret-value/);
    const guideContext = {
      project: { fullName: 'demo/project', dir: project, stackLabel: 'Node.js', launch: { command: 'npm start' } },
      guide,
    };
    const localGuide = await answerWithAI('How do I open and run this project?', guideContext, false);
    assert.ok(localGuide.lines.some((line) => line.includes('README')));
    assert.equal(attempts.length, 2);
    await answerWithAI('How do I open and run this project?', guideContext, true);
    assert.ok(attempts.slice(2).some((attempt) => attempt.body.includes('npm run dev')));
    assert.ok(attempts.slice(2).every((attempt) => !attempt.body.includes('top-secret-value')));
    console.log('ok   scans project launch guidance locally and shares it only with consent');

    const selected = readProjectFile(project, 'src/app.js');
    assert.equal(selected.content, "console.log('old');\n");
    assert.throws(() => readProjectFile(project, '../outside.txt'), /outside the project|normal project file path/);
    assert.throws(() => readProjectFile(project, '.env'), /normal project file path/);
    assert.throws(() => readProjectFile(project, 'src/invalid.bin'), /valid UTF-8/);
    assert.throws(() => applyProjectFile(project, 'src/app.js', '0'.repeat(64), 'changed'), /changed after the preview/);
    assert.throws(
      () => applyProjectFile(project, 'src/app.js', selected.sha256, 'API_KEY=abcdefghijklmnop'),
      /credential/
    );
    console.log('ok   confines file repair to safe project files and rejects stale previews');

    let repairRequest;
    global.fetch = async (url, options) => {
      repairRequest = { url: String(url), body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                summary: 'Fix test output',
                explanation: 'Use the expected output.',
                replacement: "console.log('fixed');\n",
                commands: ['node src/app.js'],
              }),
            },
          }],
        }),
      };
    };
    const proposal = await suggestFileRepair({
      question: 'Fix the output',
      context: {},
      relativePath: selected.relativePath,
      content: selected.content,
    });
    assert.equal(repairRequest.url, 'https://first.example/v1/chat/completions');
    assert.equal(proposal.replacement, "console.log('fixed');\n");
    assert.deepEqual(proposal.commands, ['node src/app.js']);
    assert.equal(fs.readFileSync(selected.file, 'utf8'), selected.content);
    const applied = applyProjectFile(project, selected.relativePath, selected.sha256, proposal.replacement);
    assert.equal(fs.readFileSync(selected.file, 'utf8'), proposal.replacement);
    assert.equal(fs.readFileSync(path.join(project, applied.backupPath), 'utf8'), selected.content);
    console.log('ok   previews a file repair without writing, then backs up on explicit apply');

    providers.removeAiProvider(paid.id);
    providers.removeAiProvider(first.id);
    providers.removeAiProvider(second.id);
    console.log('\nAI assistant self-test: 7/7 checks passed');
  } finally {
    global.fetch = originalFetch;
    if (originalUserData === undefined) delete process.env.GUITINSTAL_USER_DATA;
    else process.env.GUITINSTAL_USER_DATA = originalUserData;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
