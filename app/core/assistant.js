'use strict';

/**
 * The local fallback answers behind the "Ask GUITinstal" panel.
 *
 * Every fallback sentence is built from evidence this machine already holds -
 * the install plan, the project record, the logs on disk, and GitHub metadata.
 * The optional external AI path lives in core/ai.js and only runs after explicit
 * per-request consent.
 */

const TOPICS = [
  { id: 'error', words: ['error', 'fail', 'failed', 'broken', 'why not', 'not working', 'crash', 'problem'] },
  { id: 'run', words: ['run', 'start', 'launch', 'execute', 'serve', 'open', 'command'] },
  { id: 'requirements', words: ['require', 'need', 'install', 'depend', 'runtime', 'version', 'setup', 'prerequisit'] },
  { id: 'explain', words: ['explain', 'what is', 'what does', 'describe', 'summar', 'about', 'stack', 'language'] },
  { id: 'safety', words: ['safe', 'risk', 'approve', 'permission', 'secret', 'password', 'token', 'trust'] },
];

function topicOf(question) {
  const text = String(question || '').toLowerCase();
  for (const topic of TOPICS) {
    if (topic.words.some((word) => text.includes(word))) return topic.id;
  }
  return 'unknown';
}

function bullet(value) {
  const text = String(value ?? '').trim();
  return text ? `- ${text}` : '';
}

function listTitle(topic) {
  if (topic === 'error') return 'What the app can see about the failure';
  if (topic === 'run') return 'How this project runs';
  if (topic === 'requirements') return 'What this project needs';
  if (topic === 'explain') return 'What this project is';
  if (topic === 'safety') return 'What is approved before anything runs';
  return 'What this panel can answer';
}

/** `command` is the label the plan showed; `cmd` + `args` is what really runs. */
function launchLine(launch) {
  if (!launch) return 'No start command is stored. GUITinstal rebuilds it from the files when you press Start.';
  const argv = [launch.cmd].concat(launch.args || []).join(' ');
  const label = launch.command || argv;
  return argv && argv !== label ? `${label} - runs ${argv}` : label;
}

/** The plan is what analyze() built: repo metadata, stack, steps and preflight. */
function stepLine(step) {
  const risk = step.risk && step.risk.label ? step.risk.label : 'risk not labeled';
  const optional = step.optional ? ' (optional)' : '';
  const what = step.command || step.purpose || 'no command';
  return `${step.title || step.id} - ${risk}${optional}: ${what}`;
}

function fromPlan(plan, topic) {
  const lines = [];
  const repo = plan.repo || {};
  const stack = plan.stack || {};
  const steps = plan.steps || [];
  const warnings = (plan.preflight && plan.preflight.warnings) || [];

  if (topic === 'explain') {
    lines.push(bullet(`${repo.fullName || repo.name} is detected as ${stack.label || stack.id || 'an unknown stack'}.`));
    if (repo.description) lines.push(bullet(`GitHub description: ${repo.description}`));
    if (repo.language) lines.push(bullet(`Primary language on GitHub: ${repo.language}.`));
    if (repo.license) lines.push(bullet(`License: ${repo.license}.`));
    if (plan.directory) lines.push(bullet(`It would be installed in ${plan.directory}.`));
  }

  if (topic === 'requirements') {
    const needed = [...new Set((plan.requiredRuntimes || []).concat(plan.suggestedRuntimes || []))];
    lines.push(bullet(needed.length ? `Tools this project needs: ${needed.join(', ')}.` : 'No external tool was detected in the manifests.'));
    const missing = (plan.preflight && plan.preflight.missingRuntimes) || [];
    const pages = ((plan.preflight && plan.preflight.installGuides) || []).map((guide) => guide.url).filter(Boolean);
    lines.push(
      bullet(
        missing.length
          ? `Missing on this machine: ${missing.join(', ')}. GUITinstal does not install tools for you${pages.length ? `; download them from ${pages.join(', ')}` : ''}. After installing, press "Re-check tools" and the step can run without restarting the app.`
          : 'Every tool it asks for is installed here.'
      )
    );
    for (const step of steps) lines.push(bullet(stepLine(step)));
    for (const warning of warnings) lines.push(bullet(`Warning: ${warning}`));
  }

  if (topic === 'run') {
    const launch = steps.find((step) => step.id === 'launch');
    if (launch) {
      lines.push(bullet(`Start command: ${launch.command}`));
      lines.push(bullet(launch.optional ? 'The start step is optional, so it only runs if you approve it.' : 'The start step runs with your approval.'));
    } else {
      lines.push(bullet('No start command was found in this project. It is probably a library or a tool, not an app that runs.'));
    }
    for (const step of steps) {
      if (step.id === 'launch') continue;
      lines.push(bullet(stepLine(step)));
    }
  }

  if (topic === 'safety') {
    lines.push(bullet(`Plan has ${steps.length} step${steps.length === 1 ? '' : 's'}; each one shows its command and risk before it runs.`));
    for (const step of steps) lines.push(bullet(stepLine(step)));
    for (const warning of warnings) lines.push(bullet(`Warning: ${warning}`));
  }

  if (topic === 'error') {
    const failed = steps.filter((step) => step.status === 'failed' || step.error);
    if (failed.length) {
      for (const step of failed) lines.push(bullet(`${step.title || step.id} failed: ${step.error || 'no message was captured'}`));
    } else {
      lines.push(bullet('Nothing in this plan has failed yet, so there is no error to explain. Run the install and ask again - the log is read from disk.'));
    }
    for (const warning of warnings) lines.push(bullet(`Preflight: ${warning}`));
  }

  return lines.filter(Boolean);
}

/** A project already on disk: the record, the files, and the real log tail. */
function fromProject(project, topic, log, verify) {
  const lines = [];

  if (topic === 'explain') {
    lines.push(bullet(`${project.fullName} is installed here as ${project.stackLabel || project.stack}.`));
    if (project.description) lines.push(bullet(`GitHub description: ${project.description}`));
    lines.push(bullet(`Folder: ${project.dir}`));
    if (project.branch) lines.push(bullet(`Branch ${project.branch} at ${project.lastCommit || 'an unknown commit'}.`));
  }

  if (topic === 'requirements') {
    lines.push(bullet(`It starts with: ${launchLine(project.launch)}.`));
    lines.push(bullet(verify && verify.ok ? 'The files it needs are on disk.' : `Files still missing: ${(verify && verify.problems || []).join(' ') || 'the folder was not found'}.`));
  }

  if (topic === 'run') {
    lines.push(bullet(project.pid ? `It is running now (process ${project.pid}).` : 'It is not running.'));
    if (project.localUrl) lines.push(bullet(`It answers on ${project.localUrl} - that address comes from its own log.`));
    lines.push(bullet(launchLine(project.launch)));
  }

  if (topic === 'error') {
    if (typeof project.lastExit !== 'number' || project.lastExit === 0) {
      lines.push(bullet('The last run did not report a failure.'));
    } else {
      lines.push(bullet(`The start command exited with code ${project.lastExit}.`));
    }
    const problems = (verify && verify.problems) || [];
    for (const problem of problems) lines.push(bullet(`On disk: ${problem}`));
    const tail = (log && log.lines ? log.lines.slice(-8) : []).filter(Boolean);
    if (tail.length) {
      lines.push(bullet(`Last lines of ${log.source} log:`));
      for (const line of tail) lines.push(`   ${String(line).slice(0, 220)}`);
    } else {
      lines.push(bullet('There is no log file for this project yet, so nothing has been run through GUITinstal.'));
    }
  }

  if (topic === 'safety') {
    lines.push(bullet('Installing ran only the commands you approved. Nothing was scheduled, and no command runs again until you press Start.'));
    lines.push(bullet(`Stored start command: ${launchLine(project.launch)}`));
  }

  return lines.filter(Boolean);
}

function unknownTopic(project, plan) {
  const name = (project && project.fullName) || (plan && plan.repo && plan.repo.fullName) || 'this repository';
  return [
    `- This panel answers questions about ${name} on five topics: what it is, what it needs, how it runs, why something failed, and what is approved before a command runs.`,
    '- It is not a chat model. No AI provider is configured in this build, so nothing here was generated from a prompt and no text from your machine was sent to a service.',
    '- Ask with words like "explain", "requirements", "how do I run it", "why did it fail" or "is this safe".',
  ];
}

/**
 * Builds the panel answer. `context` is either { plan } from an analysis or
 * { project, log, verify } from an installed project - never both, because the
 * honest scope is the one the user is looking at.
 */
function explain(question, context = {}) {
  const topic = topicOf(question);
  const plan = context.plan || null;
  const project = context.project || null;
  let lines = [];

  if (topic === 'unknown') lines = unknownTopic(project, plan);
  else if (project) lines = fromProject(project, topic, context.log, context.verify);
  else if (plan) lines = fromPlan(plan, topic);
  else lines = ['- Nothing is selected yet. Analyze a repository or open one of your projects first.'];

  if (!lines.length) lines = ['- The evidence on this machine does not answer that question yet.'];

  const scope = project ? project.fullName : plan && plan.repo ? plan.repo.fullName : '';
  return {
    topic,
    title: listTitle(topic),
    scope,
    lines,
    provider: { configured: false, model: '', note: 'No AI provider is configured. These lines are read from the plan, the project record and the logs on this machine.' },
  };
}

module.exports = { explain, topicOf };
