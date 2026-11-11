(async () => {
  'use strict';

  const TOKEN = document.querySelector('meta[name="guit-token"]')?.content || '';
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

  const state = {
    settings: null,
    projects: [],
    workspaceRepos: [],
    defaultWorkspace: '',
    runtimes: [],
    run: null,
    stream: null,
    planSignature: '',
    consoleSignature: '',
    answerDraft: '',
    terminalMode: 'simple',
    view: 'home',
    toastKey: '',
  };

  /* ---------------------------------------------------------------- */
  /* utilities                                                         */
  /* ---------------------------------------------------------------- */

  const esc = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

  // Escaped first, then linked: a URL that cannot be clicked is not an
  // instruction, and the warnings that carry one exist to be followed.
  const linkify = (value) =>
    esc(value).replace(/(https?:\/\/[^\s<]+)/g, (match) => {
      const trail = /[.,;:!?)]+$/.exec(match)?.[0] || '';
      const href = trail ? match.slice(0, match.length - trail.length) : match;
      return `<a href="${href}" target="_blank" rel="noreferrer">${href}</a>${trail}`;
    });

  async function api(path, { method = 'GET', body, retries = 1 } = {}) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(path, {
          method,
          headers: {
            'X-Guit-Token': TOKEN,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        let payload = {};
        try {
          payload = await response.json();
        } catch {
          payload = {};
        }

        if (!response.ok) {
          throw new Error(payload.error || `Request failed (${response.status}).`);
        }
        return payload;
      } catch (error) {
        lastError = error;
        // A dropped keep-alive connection is transient: retry once.
        const transient = error instanceof TypeError || /fetch failed|ECONNRESET|terminated/i.test(error.message);
        if (!transient || attempt === retries) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    throw new Error(
      lastError?.message === 'fetch failed'
        ? 'The local app stopped answering. Is it still running? Restart GUITinstal.'
        : lastError?.message || 'Unexpected error.'
    );
  }

  let toastTimer;
  function toast(title, message, kind = 'info') {
    const element = $('#toast');
    $('#toastTitle').textContent = title;
    $('#toastMessage').textContent = message || '';
    element.classList.remove('error', 'success');
    if (kind !== 'info') element.classList.add(kind);
    element.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('visible'), 6000);
  }

  function formatNumber(value) {
    if (value >= 1000) return `${(value / 1000).toFixed(1).replace('.0', '')}k`;
    return String(value);
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
  }

  function fileCount(count) {
    return `${Number(count || 0).toLocaleString()} file${Number(count) === 1 ? '' : 's'}`;
  }

  /** Tool versions repeat the tool name ("Python 3.12", "git version 2.53"). */
  function cleanVersion(version) {
    if (!version) return '';
    return String(version)
      .replace(/^v/i, '')
      .replace(/^python\s+/i, '')
      .replace(/^git version\s+/i, '')
      .replace(/^go version\s+go/i, '')
      .replace(/\s+(windows\/amd64|linux\/amd64|darwin\/\S+)$/i, '')
      .trim();
  }

  const PROJECT_TYPE_LABEL = {
    app: 'Application',
    library: 'Library',
    cli: 'CLI tool',
    'web-service': 'Web service',
    unsupported: 'Manual setup',
  };

  const STATUS_LABEL = {
    pending: 'waiting',
    'awaiting-approval': 'awaiting approval',
    approved: 'approved',
    running: 'running',
    done: 'done',
    failed: 'failed',
    skipped: 'skipped',
    cancelled: 'cancelled',
  };

  /* ---------------------------------------------------------------- */
  /* routing                                                           */
  /* ---------------------------------------------------------------- */

  function showView(name) {
    // The Discover nav item now points at the board inside Home instead of a
    // second list that would compete with it.
    const known = name === 'discover' ? 'home' : ['home', 'projects', 'updates', 'settings', 'tools'].includes(name) ? name : 'home';
    state.view = known;

    $$('.view').forEach((view) => {
      const active = view.id === `view-${known}`;
      view.hidden = !active;
      view.classList.toggle('active', active);
    });

    $$('.nav-link').forEach((link) => {
      const active = link.dataset.view === name;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    closeSidebar();

    if (known === 'home' && !discovery.loaded) loadDiscover('trending');
    if (known === 'projects') loadWorkspaceRepos();
    if (known === 'tools') loadToolsView();

    if (name === 'discover') {
      $('#discoverBlock').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function routeFromHash() {
    const hash = window.location.hash.replace('#', '') || 'home';
    showView(hash);
  }

  /* ---------------------------------------------------------------- */
  /* sidebar                                                           */
  /* ---------------------------------------------------------------- */

  function openSidebar() {
    $('#sidebar').classList.add('open');
    $('#sidebarScrim').hidden = false;
    $('#menuButton').setAttribute('aria-expanded', 'true');
  }

  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#sidebarScrim').hidden = true;
    $('#menuButton').setAttribute('aria-expanded', 'false');
  }

  /* ---------------------------------------------------------------- */
  /* github account                                                    */
  /* ---------------------------------------------------------------- */

  // The user name and avatar are whatever GitHub answered for the saved token, so
  // this row stays hidden until /api/github-auth/check has run at least once.
  function renderGithubAccount(settings, token) {
    const signedIn = Boolean(settings.githubTokenSet);
    $('#githubAccount').hidden = !signedIn;
    const note = $('#tokenStorageNote');
    const storage = token && token.label ? token.label : 'the local token store';
    if (token && token.note) {
      note.textContent = `${storage}: ${token.note}`;
    } else {
      note.textContent = signedIn
        ? `Saved in ${storage.toLowerCase()}. It never goes into config.json.`
        : `Nothing saved yet. ${storage} is empty on this machine.`;
    }
    if (!signedIn) return;

    $('#accountName').textContent = settings.githubUser ? `@${settings.githubUser}` : 'Signed in';
    $('#accountStatus').textContent = settings.githubCheckedAt
      ? `Valid on GitHub · checked ${sinceDay(settings.githubCheckedAt)}`
      : 'Not verified yet — press Check.';

    const avatar = $('#accountAvatar');
    const source = settings.githubAvatar || 'icon-128.png';
    if (avatar.dataset.loadedFrom !== source) {
      avatar.dataset.loadedFrom = source;
      avatar.src = source;
    }
  }

  async function checkGithubAccount({ quiet = false } = {}) {
    const button = $('#githubCheck');
    if (button) button.disabled = true;
    try {
      const result = await api('/api/github-auth/check', { method: 'POST' });
      state.settings = result.settings;
      renderGithubAccount(result.settings, result.token);
      const pill = $('#tokenPill');
      pill.textContent = result.settings.githubTokenSet ? 'GitHub: signed in' : 'GitHub: not signed in';
      pill.classList.toggle('on', Boolean(result.settings.githubTokenSet));
      if (result.status === 'connected') {
        toast('GitHub connected', `Signed in as @${result.account.login}. API budget is 5000 requests per hour.`, 'success');
      } else if (result.status === 'expired') {
        toast('Authorization expired', result.message, 'error');
      } else if (!quiet) {
        toast('Not signed in', 'Sign in with GitHub or paste a personal token.', 'info');
      }
      return result;
    } catch (error) {
      if (!quiet) toast('Could not reach GitHub', error.message, 'error');
      return null;
    } finally {
      if (button) button.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* state load                                                        */
  /* ---------------------------------------------------------------- */

  async function loadState() {
    try {
      const data = await api('/api/state');
      state.settings = data.settings;
      state.projects = data.projects || [];
      state.workspaceRepos = [];
      state.defaultWorkspace = data.defaultWorkspace || '';
      state.runtimes = data.runtimes || [];
      state.installableRuntimes = data.installableRuntimes || [];

      $('#navProjectCount').textContent = String(state.projects.length);
      $('#workspaceLabel').textContent = data.workspace;
      $('#workspaceInput').value = data.settings.workspace;
      $('#shallowToggle').checked = Boolean(data.settings.shallowClone);
      $('#autoApproveToggle').checked = Boolean(data.settings.autoApproveLowRisk);
      $('#themeSelect').value = data.settings.theme || 'dark';
      $('#dataPathLabel').textContent = `${data.library.engine} library: ${data.library.projects} saved project${data.library.projects === 1 ? '' : 's'}. Database: ${data.library.path}`;
      loadAiProviders().catch((error) => {
        $('#aiProviderStatus').textContent = error.message;
      });

      const pill = $('#tokenPill');
      pill.textContent = data.settings.githubTokenSet ? 'GitHub: signed in' : 'GitHub: not signed in';
      pill.classList.toggle('on', Boolean(data.settings.githubTokenSet));
      renderGithubAccount(data.settings, data.token);

      renderRuntimes();
      renderRecent();
      renderProjects();
      applyTheme(data.settings.theme || 'dark');
      checkUnverified();
      if (state.view === 'projects') loadWorkspaceRepos();
    } catch (error) {
      toast('Could not load', error.message, 'error');
    }
  }

  // Projects installed before the disk checks existed have no record of their
  // files. Counting a large folder takes a moment, so it runs once per project
  // in the background instead of on every poll.
  const rechecking = new Set();

  async function checkUnverified() {
    for (const project of state.projects) {
      if (project.verify || rechecking.has(project.id)) continue;
      rechecking.add(project.id);
      try {
        const fresh = await api(`/api/projects/${encodeURIComponent(project.id)}/recheck`, { method: 'POST' });
        const index = state.projects.findIndex((item) => item.id === fresh.id);
        if (index >= 0) state.projects[index] = fresh;
        renderRecent();
        renderProjects();
      } catch {
        /* the card keeps saying "checking files…" and the next load retries */
      }
      rechecking.delete(project.id);
    }
  }

  /**
   * The version and the changelog entry for exactly this build. Both come from
   * the app's own files, so the panel works offline and cannot show notes for
   * a version other than the one running.
   */
  async function renderWhatsNew() {
    try {
      const info = await api('/api/whats-new');
      if (info.version) $('#appVersion').textContent = info.version;
      if (!info.sections || !info.sections.length) return;
      const plain = (text) => String(text).replace(/\*\*/g, '').replace(/`/g, '');
      $('#whatsNewMeta').textContent = [info.version ? `Version ${info.version}` : '', info.date]
        .filter(Boolean)
        .join(' · ');
      $('#whatsNewBody').innerHTML = info.sections
        .map(
          (section) => `
            <div class="whats-group">
              <h3>${esc(section.title)}</h3>
              <ul>${section.items.map((item) => `<li>${esc(plain(item))}</li>`).join('')}</ul>
            </div>`
        )
        .join('');
      $('#whatsNewBlock').hidden = false;
    } catch {
      // The notes are context, not a dependency: the app keeps working without
      // them, and the sidebar simply keeps the placeholder.
    }
  }

  function renderRuntimes() {
    const strip = $('#runtimeStrip');
    const common = ['node', 'npm', 'python', 'docker', 'git', 'go', 'cargo', 'dotnet'];
    // A tool that is absent is exactly the one the user needs to see, so the
    // strip also lists runtimes outside the common set (composer, make...).
    const relevant = state.runtimes.filter((runtime) => common.includes(runtime.id) || !runtime.available);
    const chips = relevant.map((runtime) => {
      const text = `${esc(runtime.label)}${runtime.available ? ` ${esc(cleanVersion(runtime.version))}` : ' missing'}`;
      if (runtime.available) {
        return `<span class="runtime-chip ok" title="${esc(runtime.version || 'found')}">${text}</span>`;
      }
      if ((state.installableRuntimes || []).includes(runtime.id)) {
        // A chip the user can act on without leaving the app: the same click
        // that used to open a download page now queues a verified setup step.
        return `<button class="runtime-chip install" data-action="prepare-runtime" data-id="${esc(
          runtime.id
        )}" title="GUITinstal downloads ${esc(runtime.label)} from its official site and checks the published checksum before anything runs">${text} · Install</button>`;
      }
      if (runtime.install) {
        return `<a class="runtime-chip" href="${esc(runtime.install)}" target="_blank" rel="noreferrer" title="Download ${esc(runtime.label)}${runtime.note ? `: ${esc(runtime.note)}` : ''}">${text}</a>`;
      }
      return `<span class="runtime-chip">${text}</span>`;
    });
    chips.push(
      '<button class="runtime-chip recheck" data-action="recheck-runtimes" title="Look again for tools installed since GUITinstal was opened">Re-check tools</button>'
    );
    strip.innerHTML = chips.join('');
  }

  async function recheckRuntimes(button) {
    const known = new Set(state.runtimes.filter((runtime) => runtime.available).map((runtime) => runtime.id));
    if (button) button.disabled = true;
    try {
      const result = await api('/api/runtimes/refresh', { method: 'POST' });
      await loadState();
      const found = (result.runtimes || [])
        .filter((runtime) => runtime.available && !known.has(runtime.id))
        .map((runtime) => `${runtime.label} ${runtime.version}`.trim());
      if (found.length) {
        toast('Tool found', `${found.join(', ')} is now usable. Re-run the step that stopped.`, 'success');
      } else if ((result.missing || []).length) {
        toast('Nothing new', `Still missing: ${result.missing.join(', ')}.`, 'error');
      } else {
        toast('All tools present', 'Every runtime GUITinstal knows about is installed here.', 'success');
      }
    } catch (error) {
      toast('Could not re-check', error.message, 'error');
      if (button) button.disabled = false;
    }
  }

  async function prepareRuntime(button) {
    const id = button.dataset.id;
    button.disabled = true;
    try {
      const result = await api('/api/runtimes/prepare', { method: 'POST', body: { id } });
      renderAnalysis(result);
      $('#analysisPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast(
        'Setup step ready',
        'Approve it and GUITinstal downloads the tool from its official site, checks the published checksum, and installs it into its own folder.',
        'info'
      );
    } catch (error) {
      toast('Cannot prepare this tool', error.message, 'error');
      button.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* projects                                                          */
  /* ---------------------------------------------------------------- */

  function projectCard(project) {
    const running = Boolean(project.pid);
    const verify = project.verify;
    const statusTag = running
      ? '<span class="tag green">running</span>'
      : project.status === 'downloaded'
        ? '<span class="tag amber">downloaded · setup pending</span>'
        : project.status === 'incomplete'
          ? '<span class="tag amber">setup incomplete</span>'
          : '';
    const filesTag = verify
      ? `<span class="tag ${verify.ok ? 'green' : 'amber'}" title="${esc(verify.directory)}">${esc(
          `${fileCount(verify.files)}${verify.truncated ? '+' : ''} on disk`
        )}</span>`
      : '<span class="tag">checking files…</span>';
    const actions = [
      running
        ? `<button class="button button-danger" data-action="stop" data-id="${esc(project.id)}"><svg aria-hidden="true"><use href="#i-x"/></svg> Stop</button>`
        : `<button class="button button-ghost" data-action="launch" data-id="${esc(project.id)}"><svg aria-hidden="true"><use href="#i-play"/></svg> Run</button>`,
      running && project.localUrl
        ? `<button class="button button-primary" data-action="browse" data-id="${esc(project.id)}"><svg aria-hidden="true"><use href="#i-arrow-up-right"/></svg> Open app</button>`
        : '',
      `<button class="button button-ghost" data-action="terminal" data-id="${esc(project.id)}"><svg aria-hidden="true"><use href="#i-terminal"/></svg> Terminal</button>`,
      `<button class="button button-ghost" data-action="update" data-id="${esc(project.id)}"><svg aria-hidden="true"><use href="#i-refresh"/></svg> Update</button>`,
      `<button class="button button-ghost" data-action="log" data-id="${esc(project.id)}"><svg aria-hidden="true"><use href="#i-terminal"/></svg> Log</button>`,
      `<button class="button button-ghost" data-action="guide" data-id="${esc(project.id)}"><svg aria-hidden="true"><use href="#i-robot"/></svg> Guide</button>`,
      `<button class="button button-ghost" data-action="open" data-id="${esc(project.id)}"><svg aria-hidden="true"><use href="#i-folder"/></svg> Folder</button>`,
      `<button class="button button-danger" data-action="remove" data-id="${esc(project.id)}" aria-label="Remove ${esc(
        project.name
      )} from GUITinstal"><svg aria-hidden="true"><use href="#i-trash"/></svg></button>`,
    ].join('');

    return `
      <article class="project-card">
        <div class="card-head">
          <img
            class="card-mark"
            src="${esc(project.avatarUrl || 'icon-128.png')}"
            alt=""
            width="30"
            height="30"
            referrerpolicy="no-referrer"
            loading="lazy"
            data-fallback="icon-128.png"
          />
          <div class="card-main">
            <div class="card-title">${esc(project.name)}</div>
            <div class="card-sub">${esc(project.fullName)}</div>
          </div>
        </div>
        <div class="card-meta">
          <span class="tag accent">${esc(project.stackLabel || project.stack)}</span>
          ${filesTag}
          ${statusTag}
          ${project.lastCommit ? `<span class="tag">${esc(project.lastCommit)}</span>` : ''}
          ${project.branch ? `<span class="tag">${esc(project.branch)}</span>` : ''}
        </div>
        <div class="card-path">${esc(project.dir)}</div>
        <div class="card-actions">${actions}</div>
      </article>`;
  }

  function renderProjects() {
    const grid = $('#projectsGrid');
    if (!state.projects.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <svg aria-hidden="true"><use href="#i-folder"/></svg>
          <b>No projects yet</b>
          <p>Paste a repository URL on Home to install your first project.</p>
          <button class="button button-primary" data-goto="home">Install a project</button>
        </div>`;
      return;
    }
    grid.innerHTML = state.projects.map(projectCard).join('');
  }

  function renderRecent() {
    const grid = $('#recentProjects');
    const block = $('#recentBlock');
    const recent = state.projects.slice(0, 3);

    if (!recent.length) {
      block.hidden = true;
      grid.innerHTML = '';
      return;
    }

    block.hidden = false;
    grid.innerHTML = recent.map(projectCard).join('');
  }

  /* ---------------------------------------------------------------- */
  /* workspace gallery                                                 */
  /* ---------------------------------------------------------------- */

  function workspaceRepoCard(item) {
    const avatar = item.owner ? `https://github.com/${encodeURIComponent(item.owner)}.png?size=64` : 'icon-128.png';
    const markers = (item.markers || [])
      .slice(0, 2)
      .map((marker) => `<span class="tag">${esc(marker)}</span>`)
      .join('');
    const github = item.url
      ? `<a class="button button-ghost" href="${esc(item.url)}" target="_blank" rel="noreferrer">GitHub</a>`
      : '';

    return `
      <article class="project-card">
        <div class="card-head">
          <img class="card-mark" src="${esc(avatar)}" alt="" width="30" height="30" referrerpolicy="no-referrer" loading="lazy" data-fallback="icon-128.png" />
          <div class="card-main">
            <div class="card-title">${esc(item.name)}</div>
            <div class="card-sub">${esc(item.fullName)}</div>
          </div>
        </div>
        <div class="card-meta">
          <span class="tag accent">${esc(item.stackLabel)}</span>
          <span class="tag amber">found on disk</span>
          ${markers}
        </div>
        <div class="card-path">${esc(item.dir)}</div>
        <div class="card-actions">
          <button class="button button-primary" data-action="import-repo" data-dir="${esc(item.dir)}">
            <svg aria-hidden="true"><use href="#i-plus"/></svg> Add to My library
          </button>
          <button class="button button-ghost" data-action="open-workspace-repo" data-dir="${esc(item.dir)}">
            <svg aria-hidden="true"><use href="#i-folder"/></svg> Folder
          </button>
          ${github}
        </div>
      </article>`;
  }

  async function loadWorkspaceRepos() {
    const pathLabel = $('#workspaceGalleryPath');
    const block = $('#workspaceGalleryBlock');
    const grid = $('#workspaceGallery');
    if (!pathLabel || !block || !grid) return;

    pathLabel.textContent = 'Scanning the workspace…';
    try {
      const data = await api('/api/workspace/repos');
      state.workspaceRepos = data.items || [];
      const found = state.workspaceRepos.filter((item) => !item.registered);
      const total = state.workspaceRepos.length;
      pathLabel.textContent = total
        ? `${total} Git repositor${total === 1 ? 'y' : 'ies'} in ${data.workspace}. ${
            found.length ? `${found.length} can be added to My library.` : 'All of them are already in My library.'
          }`
        : `No Git repositories found in ${data.workspace} yet. Paste a GitHub link on Home to download the first one.`;

      if (!found.length) {
        block.hidden = true;
        grid.innerHTML = '';
        $('#workspaceGalleryCount').textContent = '';
        return;
      }

      block.hidden = false;
      $('#workspaceGalleryCount').textContent = `${found.length} not in My library`;
      grid.innerHTML = found.map(workspaceRepoCard).join('');
    } catch (error) {
      pathLabel.textContent = `Could not scan the workspace: ${error.message}`;
    }
  }

  async function loadToolsView() {
    const panel = $('#toolsPanel');
    const installAllBlock = $('#installAllBlock');
    const installAllButtonRow = $('#installAllButtonRow');
    const installAllSummary = $('#installAllSummary');
    if (!panel) return;

    // Show the install all button if there are missing tools
    const missing = await checkMissingTools();
    if (missing && missing.length > 0) {
      installAllBlock.hidden = false;
      installAllSummary.textContent = ` ${missing.length} tool${missing.length !== 1 ? 's' : ''} missing`;
      // Create install all button
      const btn = document.createElement('button');
      btn.className = 'button button-primary';
      btn.textContent = 'Install All Missing Tools';
      btn.addEventListener('click', installAllMissingTools);
      installAllButtonRow.innerHTML = '';
      installAllButtonRow.appendChild(btn);
    } else {
      installAllBlock.hidden = true;
      installAllButtonRow.innerHTML = '';
    }

    // Build the tool badges
    const installed = await listInstalledTools();
    panel.innerHTML = '';
    if (installed && installed.length > 0) {
      const fragment = document.createDocumentFragment();
      installed.forEach((tool) => {
        const badge = document.createElement('div');
        badge.className = 'tool-badge installed';
        badge.innerHTML = `<span class="tool-name">${tool.label}</span><span class="tool-version">v${tool.version}</span><span class="tool-status">Installed</span>`;
        fragment.appendChild(badge);
      });
      panel.appendChild(fragment);
    }
    // Add individual install buttons for missing tools
    const missingTools = await checkMissingTools();
    if (missingTools && missingTools.length > 0) {
      const fragment = document.createDocumentFragment();
      missingTools.forEach((tool) => {
        const btn = document.createElement('button');
        btn.className = 'button button-ghost tool-install-btn';
        btn.textContent = `Install ${tool.id}`;
        btn.addEventListener('click', () => installTool(tool.id));
        fragment.appendChild(btn);
      });
      panel.appendChild(fragment);
    }
  }

  async function checkMissingTools() {
    // Check which tools from the TOOLBOX are not installed
    const { TOOLBOX } = require('../core/runtime-install');
    const notInstalled = [];
    for (const id of Object.keys(TOOLBOX)) {
      const existing = await existingTool(id);
      if (!existing) notInstalled.push({ id, label: TOOLBOX[id].label });
    }
    return notInstalled;
  }

  async function listInstalledTools() {
    const { TOOLBOX } = require('../core/runtime-install');
    const installed = [];
    for (const id of Object.keys(TOOLBOX)) {
      const existing = await existingTool(id);
      if (existing) {
        const probe = existing.probe || { cmd: existing.bin, args: TOOLBOX[id].verifyArgs };
        const version = await probeVersion(probe);
        if (version) {
          installed.push({ id, label: TOOLBOX[id].label, version });
        }
      }
    }
    return installed;
  }

  async function installTool(id) {
    // Show a confirmation and install the tool
    if (confirm(`Install ${TOOLBOX[id]?.label || id}? This may take several minutes and require disk space.`)) {
      await prepareTool(id);
      await loadToolsView();
    }
  }

  async function installAllMissingTools() {
    const missing = await checkMissingTools();
    if (!missing || missing.length === 0) {
      toast('No missing tools', 'All tools are already installed.', 'success');
      return;
    }
    // Ask for confirmation since this will download and install multiple tools
    const confirmed = confirm(`Install ${missing.length} missing tools?\n\n` +
      missing.map((t) => `- ${t.label} (${TOOLBOX[t.id].estimate || ''})`).join('\n'));
    if (!confirmed) return;
    installAllButtonRow.innerHTML = '<span class="button button-primary">Processing…</span>';
    const results = {};
    for (const tool of missing) {
      try {
        await prepareTool(tool.id);
        results[tool.id] = 'installed';
      } catch (e) {
        results[tool.id] = 'failed: ' + e.message.split('\n')[0];
      }
    }
    installAllButtonRow.innerHTML = '';
    // Refresh the view
    await loadToolsView();
    // Show a summary toast
    const installed = Object.keys(results).filter((k) => results[k] === 'installed').length;
    const failed = Object.keys(results).filter((k) => results[k].startsWith('failed')).length;
    const msg = [`${installed} tool${installed !== 1 ? 's' : ''} installed`, `${failed} tool${failed !== 1 ? 's' : ''} failed`].filter((m) => m.trim()).join('; ');
    toast('Installation complete', msg, installed > 0 ? 'success' : 'error');
  }

  async function importWorkspaceRepo(directory) {
    try {
      const result = await api('/api/workspace/repos', { method: 'POST', body: { directory } });
      toast('Added to your library', `${result.project.fullName} is now in your library.`, 'success');
      await loadState();
    } catch (error) {
      toast('Could not add repository', error.message, 'error');
    }
  }

  async function openWorkspaceRepo(directory) {
    try {
      const result = await api('/api/workspace/repos/open', { method: 'POST', body: { directory } });
      if (result.ok) toast('Folder opened', 'The repository folder is open in your file manager.', 'success');
      else toast('Could not open folder', 'The folder no longer exists or Windows could not open it.', 'error');
    } catch (error) {
      toast('Could not open', error.message, 'error');
    }
  }

  /* ---------------------------------------------------------------- */
  /* analysis + plan                                                   */
  /* ---------------------------------------------------------------- */

  // The five compatibility verdicts, in the words a person understands.
  const COMPATIBILITY_LABEL = {
    ready: 'Ready',
    installable: 'Installable',
    guided: 'Needs a manual step',
    partial: 'Partially supported',
    blocked: 'Blocked',
    unknown: 'Not checked',
  };

  function compatibilityLabel(verdict) {
    return COMPATIBILITY_LABEL[verdict] || 'Compatibility';
  }

  function riskClass(risk) {
    return risk?.id || 'low';
  }

  function stepHtml(step) {
    const isFocus = step.status === 'awaiting-approval' || step.status === 'failed';
    const isRunning = step.status === 'running';
    const isPending = step.status === 'pending';

    // A blocked step has no approvable action: the runtime it needs cannot
    // run on this platform, and a button would be a promise the engine refuses.
    const approveButton = isFocus && !step.blocked
      ? `<button class="button button-primary" data-run-action="approve" data-step="${esc(step.id)}">${
          step.status === 'failed' ? 'Try again' : 'Approve and run'
        }</button>`
      : '';

    const skipButton = isPending
      ? ''
      : isRunning
      ? '<span class="status-pill running">running…</span>'
      : `<button class="button button-ghost" data-run-action="skip" data-step="${esc(step.id)}" ${
          step.status === 'done' ? 'disabled' : ''
        }>Skip</button>`;

    // A command can stop and ask a question. Without a real stdin the user
    // would only see a spinner, so the question gets an answer box: the exact
    // words the command printed, what each answer does, and a starting value
    // for the cases where one answer is clearly the one the script expects.
    const answerBox = step.awaitingInput
      ? `<div class="step-answer">
          <p class="step-answer-ask">${step.prompt ? `It asked: "${esc(step.prompt)}" ` : ''}${esc(
            step.promptHint || 'The command is waiting for an answer. Type it and press Enter.'
          )}</p>
          <div class="step-answer-row">
            <input class="text-input answer-input" type="text" data-step="${esc(step.id)}" value="${esc(state.answerDraft || step.promptAnswer || '')}" autocomplete="off" spellcheck="false" aria-label="Answer for the running command" />
            <button class="button button-primary" data-run-action="answer" data-step="${esc(step.id)}">Send answer</button>
          </div>
        </div>`
      : '';

    return `
      <article class="plan-step ${esc(step.status)}" data-step="${esc(step.id)}">
        <div class="step-index">${step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : step.index + 1}</div>
        <div class="step-body">
          <div class="step-title">
            ${esc(step.title)}
            <span class="risk-badge ${riskClass(step.risk)}">${esc(step.risk?.label || 'Low risk')}</span>
            <span class="status-pill ${esc(step.status)}">${esc(STATUS_LABEL[step.status] || step.status)}</span>
            ${step.optional ? '<span class="tag">optional</span>' : ''}
          </div>
          <p class="step-purpose">${esc(step.purpose)}</p>
          <div class="step-command">${esc(step.command)}</div>
          ${step.notes ? `<p class="step-note"><svg aria-hidden="true"><use href="#i-alert"/></svg><span>${esc(step.notes)}</span></p>` : ''}
          ${step.error ? `<p class="step-note"><svg aria-hidden="true"><use href="#i-alert"/></svg><span>${linkify(step.error)}</span></p>` : ''}
          ${answerBox}
          <div class="step-actions">${approveButton}${skipButton}</div>
        </div>
      </article>`;
  }

  function renderAnalysis(result) {
    const area = $('#analysisArea');
    const { plan, repo, detection } = result;
    if (state.stream) state.stream.close();
    state.stream = null;
    state.run = null;
    state.analysis = result;
    state.plan = plan;

    const chips = [
      `<span class="tag accent">${esc(plan.stack.label)}</span>`,
      `<span class="tag ${plan.kind === 'unsupported' ? 'amber' : ''}" title="Estimated from the repository manifests">${esc(PROJECT_TYPE_LABEL[plan.kind] || 'Project')}</span>`,
      ...(plan.stack.markers || []).map((marker) => `<span class="tag">${esc(marker)}</span>`),
      ...(detection.secondary || []).map((item) => `<span class="tag">${esc(item.label)}</span>`),
      repo.license ? `<span class="tag">${esc(repo.license)}</span>` : '',
      repo.language ? `<span class="tag">${esc(repo.language)}</span>` : '',
    ].join('');

    const compatibility = plan.compatibility || {};
    const planBlocked = compatibility.verdict === 'blocked';
    const compatibilityBanner = compatibility.verdict
      ? `<p class="plan-warning compat-${esc(compatibility.verdict)}"><strong>${esc(
          compatibilityLabel(compatibility.verdict)
        )}</strong> ${esc(compatibility.summary || '')}</p>`
      : '';

    const preflight = plan.preflight || {};
    const disk = preflight.disk;
    const warnings = (preflight.warnings || []).map((text) => `<p class="plan-warning">${linkify(text)}</p>`).join('');
    const preflightBanner =
      (disk && disk.level !== 'ok'
        ? `<p class="form-error" style="margin:14px 0 0">${
            disk.level === 'block' ? '⛔' : '⚠️'
          } ${esc(disk.message)}</p>`
        : '') + warnings;

    area.innerHTML = `
      <div class="analysis ${state.terminalMode === 'simple' ? 'simple-mode' : ''}" id="analysisPanel">
        <div class="repo-head">
          ${
            repo.ownerAvatar
              ? `<span class="repo-avatar"><img src="${esc(repo.ownerAvatar)}" alt="" referrerpolicy="no-referrer" data-fallback="icon-128.png"></span>`
              : ''
          }
          <div class="repo-head-main">
            <h2>${esc(repo.fullName)}</h2>
            <p>${esc(repo.description || 'No description.')}</p>
            <div class="stack-chips">${chips}</div>
          </div>
          <div class="card-meta">
            <span class="tag"><svg aria-hidden="true" style="width:13px;height:13px"><use href="#i-star"/></svg> ${formatNumber(
              repo.stars
            )}</span>
            <a class="text-button" href="${esc(repo.url)}" target="_blank" rel="noreferrer">View on GitHub
              <svg aria-hidden="true" style="width:13px;height:13px"><use href="#i-arrow-up-right"/></svg></a>
          </div>
        </div>

        ${compatibilityBanner}
        ${preflightBanner}

        <div class="plan" id="planList">
          ${plan.steps
            .map((step, index) =>
              stepHtml({ ...step, status: index === 0 ? 'awaiting-approval' : step.status })
            )
            .join('')}
        </div>

        <div class="button-row">
          ${
            planBlocked
              ? `<button class="button button-primary" disabled>Blocked on this machine</button>
                 <span class="hint" style="align-self:center">${esc(
                   compatibility.summary || 'This project cannot be installed here.'
                 )}</span>`
              : `<button class="button button-primary" id="approveAll">
            <svg aria-hidden="true"><use href="#i-check"/></svg> Approve all and install
          </button>
          <span class="hint" style="align-self:center">Every command runs on your machine, one at a time.</span>`
          }
        </div>

        <div class="console" style="margin-top:16px">
          <div class="console-head">
            <svg aria-hidden="true"><use href="#i-terminal"/></svg>
            <h3>Progress</h3>
            <div class="terminal-modes" role="group" aria-label="Terminal view">
              <button class="terminal-mode" data-terminal-mode="simple" aria-pressed="${state.terminalMode === 'simple'}">Simple</button>
              <button class="terminal-mode" data-terminal-mode="advanced" aria-pressed="${state.terminalMode === 'advanced'}">Advanced</button>
            </div>
            <span class="spacer"></span>
            <span class="status-pill" id="runStatus">awaiting approval</span>
            <button class="button button-ghost" id="cancelRun" style="min-height:30px;padding:0 11px;font-size:12px">Cancel</button>
          </div>
          <div class="console-body" id="consoleBody" role="log" aria-live="polite" aria-label="Command output">
            ${state.terminalMode === 'simple'
              ? simpleStartHtml(preflight)
              : '<p class="log-empty">Waiting for the first approval to start.</p>'}
          </div>
        </div>
      </div>`;

    area.hidden = false;
    state.planSignature = '';
    state.consoleSignature = '';

    const approveAllButton = $('#approveAll');
    if (approveAllButton) approveAllButton.addEventListener('click', () => startRun(true));
    $('#cancelRun').addEventListener('click', cancelRun);
  }

  async function analyze(url) {
    const errorBox = $('#repoError');
    const button = $('#analyzeButton');
    errorBox.hidden = true;
    button.disabled = true;
    button.querySelector('.btn-label').textContent = 'Analyzing…';

    try {
      const result = await api('/api/analyze', { method: 'POST', body: { url } });
      renderAnalysis(result);
      setAskContext({ planId: result.planId }, result.repo.fullName);
      $('#analysisPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('Analysis complete', `${result.repo.fullName} · ${result.plan.steps.length} steps`, 'success');
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      toast('Analysis failed', error.message, 'error');
    } finally {
      button.disabled = false;
      button.querySelector('.btn-label').textContent = 'Prepare project';
    }
  }

  /* ---------------------------------------------------------------- */
  /* ask guitinstal                                                    */
  /* ---------------------------------------------------------------- */

  // The panel answers from evidence the server already holds, so it needs to know
  // which context the user is looking at: the plan just analyzed, or one project.
  const ask = { context: null };
  let aiProviders = [];
  let repairProposal = null;

  function setAskContext(context, label) {
    ask.context = context;
    $('#askScope').textContent = label;
    $('#askAnswer').innerHTML = '';
    $('#repairPanel').hidden = !context?.projectId;
    $('#repairPreview').hidden = true;
    $('#repairStatus').textContent = '';
    repairProposal = null;
    updateRepairButton();
  }

  async function askQuestion() {
    const question = $('#askInput').value.trim();
    const list = $('#askAnswer');
    if (!question) {
      list.innerHTML = '<li class="ask-line">Type what you want to know about this project.</li>';
      return;
    }
    const button = $('#askButton');
    button.disabled = true;
    try {
      const result = await api('/api/assistant', {
        method: 'POST',
        body: { question, ...(ask.context || {}), useAI: $('#askSendContext').checked },
      });
      const answer = result.answer;
      $('#askProviderNote').textContent = answer.provider.note;
      if (answer.scope) $('#askScope').textContent = answer.scope;
      list.innerHTML =
        `<li class="ask-title">${esc(answer.title)}</li>` +
        answer.lines
          .map((line) => {
            const isSub = /^\s{2,}/.test(line);
            const text = line.replace(/^-\s+/, '').trim();
            return `<li class="${isSub ? 'ask-sub' : 'ask-line'}">${esc(text)}</li>`;
          })
          .join('');
    } catch (error) {
      list.innerHTML = `<li class="ask-line">${esc(error.message)}</li>`;
    } finally {
      button.disabled = false;
    }
  }

  function updateRepairButton() {
    const hasFreeProvider = aiProviders.some((provider) => provider.enabled && provider.noCost && provider.hasApiKey);
    $('#repairButton').disabled = !hasFreeProvider || !ask.context?.projectId || !$('#repairConsent').checked;
  }

  function renderAiProviders(providers) {
    aiProviders = Array.isArray(providers) ? providers : [];
    const list = $('#aiProviderList');
    if (!aiProviders.length) {
      list.innerHTML = '<p class="panel-hint">No AI providers configured. Add an OpenAI-compatible provider and mark it no-cost to enable AI assistance.</p>';
    } else {
      list.innerHTML = aiProviders
        .map((provider, index) => {
          const eligibility = provider.enabled && provider.noCost && provider.hasApiKey
            ? 'Enabled for no-cost fallback'
            : provider.hasApiKey
              ? 'Saved, but not eligible for fallback'
              : 'API key missing';
          return `<article class="ai-provider-card">
            <strong>${esc(provider.name)}${provider.noCost ? ' · marked no-cost' : ''}</strong>
            <small>${esc(provider.model)} · ${esc(provider.baseUrl)}<br>${esc(eligibility)}${provider.credentialStorage ? ` · ${esc(provider.credentialStorage)}` : ''}${provider.credentialNote ? `<br>${esc(provider.credentialNote)}` : ''}</small>
            <div class="button-row">
              <button class="button button-ghost" type="button" data-ai-provider-action="up" data-id="${esc(provider.id)}" ${index === 0 ? 'disabled' : ''}>Move up</button>
              <button class="button button-ghost" type="button" data-ai-provider-action="down" data-id="${esc(provider.id)}" ${index === aiProviders.length - 1 ? 'disabled' : ''}>Move down</button>
              <button class="button button-ghost" type="button" data-ai-provider-action="edit" data-id="${esc(provider.id)}">Edit</button>
              <button class="button button-ghost" type="button" data-ai-provider-action="remove" data-id="${esc(provider.id)}">Remove</button>
            </div>
          </article>`;
        })
        .join('');
    }
    updateRepairButton();
  }

  async function loadAiProviders() {
    const result = await api('/api/ai/providers');
    renderAiProviders(result.providers);
  }

  function resetAiProviderForm() {
    $('#aiProviderForm').reset();
    $('#aiProviderId').value = '';
    $('#aiProviderKey').placeholder = 'Stored securely; never shown again';
    $('#aiProviderSave').textContent = 'Save provider';
    $('#aiProviderCancel').hidden = true;
  }

  function showRepairProposal(result) {
    repairProposal = { ...result, projectId: ask.context.projectId };
    $('#repairSummary').textContent = result.summary;
    $('#repairExplanation').textContent = `${result.explanation}\n\nProvider: ${result.provider.name} (${result.provider.model}). No file has been changed.`;
    $('#repairBefore').textContent = result.originalContent;
    $('#repairAfter').textContent = result.replacement;
    const commands = $('#repairCommands');
    commands.hidden = !result.commands.length;
    commands.textContent = result.commands.length
      ? `Suggested terminal commands (not run):\n${result.commands.map((command) => `- ${command}`).join('\n')}`
      : '';
    $('#repairPreview').hidden = false;
  }

  async function proposeFileRepair() {
    if (!ask.context?.projectId || !$('#repairConsent').checked) return;
    const button = $('#repairButton');
    button.disabled = true;
    $('#repairStatus').textContent = 'Reading the selected file and asking a configured no-cost provider…';
    $('#repairPreview').hidden = true;
    try {
      const question = $('#askInput').value.trim() || 'Explain the latest error and suggest a minimal repair.';
      const result = await api('/api/assistant/repair-proposal', {
        method: 'POST',
        body: {
          projectId: ask.context.projectId,
          filePath: $('#repairPath').value.trim(),
          question,
          sendFile: true,
        },
      });
      showRepairProposal(result);
      $('#repairStatus').textContent = 'Review the complete before/after contents. The app has not changed the file.';
    } catch (error) {
      $('#repairStatus').textContent = error.message;
    } finally {
      updateRepairButton();
    }
  }

  async function applyFileRepair() {
    if (!repairProposal) return;
    if (!window.confirm(`Apply the reviewed change to ${repairProposal.filePath}? A backup will be kept in the project.`)) return;
    const button = $('#repairApply');
    button.disabled = true;
    try {
      const result = await api('/api/assistant/apply-repair', {
        method: 'POST',
        body: {
          approved: true,
          projectId: repairProposal.projectId,
          filePath: repairProposal.filePath,
          expectedSha256: repairProposal.expectedSha256,
          replacement: repairProposal.replacement,
        },
      });
      $('#repairStatus').textContent = `Applied ${result.relativePath}. Backup: ${result.backupPath}. Run the suggested command yourself in the project terminal when ready.`;
      $('#repairPreview').hidden = true;
      repairProposal = null;
      await loadState();
    } catch (error) {
      $('#repairStatus').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* run                                                               */
  /* ---------------------------------------------------------------- */

  async function startRun(approveEveryStep = false) {
    if (state.plan?.compatibility?.verdict === 'blocked') {
      toast(
        'Blocked on this machine',
        state.plan.compatibility.summary || 'This project cannot be installed here.',
        'error'
      );
      return;
    }
    try {
      const run = await api('/api/runs', { method: 'POST', body: { planId: state.analysis?.planId } });
      state.run = run;
      renderRun(run);
      openStream(run.id);
      if (approveEveryStep) await approveAllSteps();
    } catch (error) {
      toast('Could not start', error.message, 'error');
    }
  }

  async function approveAllSteps() {
    if (!state.run) return;
    try {
      const snapshot = await api(`/api/runs/${state.run.id}/approve`, { method: 'POST', body: {} });
      state.run = snapshot;
      renderRun(snapshot);
    } catch (error) {
      toast('Could not approve the steps', error.message, 'error');
    }
  }

  function openStream(runId) {
    if (state.stream) state.stream.close();
    const stream = new EventSource(`/api/runs/${runId}/stream?token=${encodeURIComponent(TOKEN)}`);
    state.stream = stream;

    stream.onmessage = (event) => {
      try {
        const snapshot = JSON.parse(event.data);
        state.run = snapshot;
        renderRun(snapshot);
      } catch {
        /* keep the stream alive on malformed frames */
      }
    };

    stream.onerror = () => {
      if (stream.readyState === EventSource.CLOSED) {
        state.stream = null;
      }
    };
  }

  function simpleConsoleHtml(snapshot, current) {
    let title = 'Nothing runs without your approval.';
    let detail = 'Review the steps above. Advanced mode shows the exact commands and raw output.';
    if (snapshot.status === 'running') {
      title = current?.title || 'Working on your project…';
      detail = 'The command is running on your computer. Questions will appear above when your answer is needed.';
    } else if (snapshot.status === 'done') {
      if (snapshot.library && snapshot.library.ok === false) {
        title = 'Files installed; the library entry failed.';
        detail = `GUITinstal could not save this project to your library: ${snapshot.library.error || 'unknown error'}. The folder is still on disk at ${snapshot.directory}.`;
      } else {
        title = snapshot.verification?.ok ? 'Installed and saved.' : 'Commands finished; checking the result.';
        detail = snapshot.verification?.ok
          ? `${fileCount(snapshot.verification.files)} are on disk. Find this project in your library.`
          : 'GUITinstal is checking the project folder before calling this install verified.';
      }
    } else if (snapshot.status === 'failed') {
      title = 'This step needs your attention.';
      detail = current?.error || 'Open Advanced mode to inspect the command output, then try again.';
    } else if (snapshot.status === 'cancelled') {
      title = 'Installation cancelled.';
      detail = 'No further steps will run. Your existing files were not deleted.';
    }
    return `<div class="simple-console"><strong>${esc(title)}</strong><span>${linkify(detail)}</span></div>`;
  }

  // Told before the run, not after it failed: a missing tool is a download the
  // user can start right now, and the plan is already on this screen.
  function simpleStartHtml(preflight) {
    const guides = (preflight?.installGuides || []).filter((guide) => guide.url);
    if (!guides.length) {
      return '<div class="simple-console"><strong>Nothing runs without your approval.</strong><span>Review the steps above. Advanced mode shows the exact commands and raw output.</span></div>';
    }
    const links = guides.map((guide) => `<a href="${esc(guide.url)}" target="_blank" rel="noreferrer">${esc(guide.id)}</a>`).join(', ');
    return `<div class="simple-console"><strong>Something this project needs is not installed here.</strong><span>Install ${links}, press "Re-check tools" and run the step again. GUITinstal reads the Windows PATH again at that moment, so no restart is needed.</span></div>`;
  }

  function setTerminalMode(mode) {
    state.terminalMode = mode === 'advanced' ? 'advanced' : 'simple';
    $('#analysisPanel')?.classList.toggle('simple-mode', state.terminalMode === 'simple');
    $$('[data-terminal-mode]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.terminalMode === state.terminalMode));
    });
    state.consoleSignature = '';
    if (state.run) {
      renderRun(state.run);
    } else if ($('#consoleBody')) {
      $('#consoleBody').innerHTML = state.terminalMode === 'simple'
        ? simpleConsoleHtml({ status: 'awaiting-approval' }, null)
        : '<p class="log-empty">Waiting for the first approval to start.</p>';
    }
  }

  function renderRun(snapshot) {
    const planList = $('#planList');
    const consoleBody = $('#consoleBody');
    const runStatus = $('#runStatus');
    if (!planList || !consoleBody || !runStatus) return;

    const signature = snapshot.steps
      .map((step) => `${step.id}:${step.status}:${step.approved}:${step.awaitingInput ? 1 : 0}`)
      .join('|');
    if (signature !== state.planSignature) {
      state.planSignature = signature;
      planList.innerHTML = snapshot.steps.map(stepHtml).join('');
      const input = planList.querySelector('.answer-input');
      // A question is blocking: the keyboard should already be on the answer.
      if (input) input.focus();
    }

    const current = snapshot.steps.find((step) => step.status === 'running') || snapshot.steps.at(-1);
    const lines = current?.output || [];
    const consoleSignature = `${state.terminalMode}:${snapshot.status}:${current?.id}:${current?.error || ''}:${lines.length}:${lines.at(-1)?.text || ''}`;
    if (consoleSignature !== state.consoleSignature) {
      state.consoleSignature = consoleSignature;
      if (state.terminalMode === 'simple') {
        consoleBody.innerHTML = simpleConsoleHtml(snapshot, current);
      } else if (!lines.length) {
        consoleBody.innerHTML = '<p class="log-empty">Waiting for the first approval to start.</p>';
      } else {
        const atBottom = consoleBody.scrollHeight - consoleBody.scrollTop - consoleBody.clientHeight < 40;
        consoleBody.innerHTML = lines
          .map(
            (line) =>
              `<div class="log-line ${esc(line.stream)}"><span class="marker">${line.stream === 'stderr' ? '!' : line.stream === 'stdin' ? '❯' : '›'}</span><span>${esc(
                line.text
              )}</span></div>`
          )
          .join('');
        if (atBottom) consoleBody.scrollTop = consoleBody.scrollHeight;
      }
    }

    runStatus.textContent = STATUS_LABEL[snapshot.status] || snapshot.status;
    runStatus.className = `status-pill ${snapshot.status === 'failed' ? 'failed' : snapshot.status === 'done' ? 'done' : snapshot.status === 'running' ? 'running' : ''}`;

    const cancelButton = $('#cancelRun');
    if (cancelButton) cancelButton.disabled = snapshot.status === 'done' || snapshot.status === 'cancelled';

    if (snapshot.status === 'done' || snapshot.status === 'failed') {
      const verified = Boolean(snapshot.verification);
      // One failed library write is a busy database, not a lost project: the
      // server retries up to three times, so only a spent budget is a failure.
      const libraryFailed =
        Boolean(snapshot.library) && snapshot.library.ok === false && (snapshot.library.attempts || 0) >= 3;
      // The stream stays open until the verified snapshot arrives: that frame
      // carries the proof, this one only carries the exit codes.
      if ((verified || libraryFailed || snapshot.status === 'failed') && state.stream) {
        state.stream.close();
        state.stream = null;
      }
      loadState();
      if (snapshot.status === 'failed') {
        toast('Install stopped', 'A step failed. Review the command and try again.', 'error');
      } else if (libraryFailed && state.toastKey !== `${snapshot.id}:library`) {
        state.toastKey = `${snapshot.id}:library`;
        // Say it only after looking: a retry that landed makes this frame wrong.
        Promise.resolve(loadState()).then(() => {
          const directory = snapshot.plan?.directory;
          const landed = state.projects.some(
            (item) => (directory && item.dir === directory) || (snapshot.library.id && item.id === snapshot.library.id)
          );
          if (landed) {
            toast('Added to your library', 'The first library write was busy, the retry saved it.', 'success');
            return;
          }
          toast(
            'Not added to your library',
            `The files are on disk, but the library entry failed: ${snapshot.library.error || 'unknown error'}.`,
            'error'
          );
        });
      } else if (!verified) {
        toast('All commands ran', 'Checking the files on disk…');
      } else if (state.toastKey !== `${snapshot.id}:done`) {
        state.toastKey = `${snapshot.id}:done`;
        const check = snapshot.verification;
        toast(
          check.ok ? 'Install verified' : 'Install not verified',
          check.ok
            ? `${snapshot.repo.fullName}: ${fileCount(check.files)}, ${formatBytes(
                check.bytes
              )} at ${check.directory}${check.commit ? `, commit ${check.commit}` : ''}`
            : `${snapshot.directory}: ${(check.problems || []).join(' ') || 'nothing proves the install finished'}`,
          check.ok ? 'success' : 'error'
        );
      }
    }
  }

  async function cancelRun() {
    if (!state.run) return;
    try {
      await api(`/api/runs/${state.run.id}/cancel`, { method: 'POST' });
    } catch (error) {
      toast('Error', error.message, 'error');
    }
  }

  async function approveStep(stepId) {
    // The first approval happens before any run exists: it starts the run.
    if (!state.run) {
      if (!state.analysis?.planId) return;
      await startRun();
      await approveStep(stepId);
      return;
    }

    try {
      const snapshot = await api(`/api/runs/${state.run.id}/approve`, { method: 'POST', body: { stepId } });
      state.run = snapshot;
      renderRun(snapshot);
    } catch (error) {
      toast('Could not approve', error.message, 'error');
    }
  }

  async function skipStep(stepId) {
    if (!state.run) {
      // Nothing is running yet: skip the step in the plan itself.
      const step = state.plan?.steps.find((item) => item.id === stepId);
      if (!step) return;
      step.status = 'skipped';
      renderAnalysis(state.analysis);
      return;
    }

    try {
      const snapshot = await api(`/api/runs/${state.run.id}/skip`, { method: 'POST', body: { stepId } });
      state.run = snapshot;
      renderRun(snapshot);
    } catch (error) {
      toast('Could not skip', error.message, 'error');
    }
  }

  async function answerStep(stepId) {
    if (!state.run) return;
    const field = document.querySelector(`.answer-input[data-step="${CSS.escape(stepId)}"]`);
    const text = field ? field.value : state.answerDraft;

    try {
      const snapshot = await api(`/api/runs/${state.run.id}/input`, { method: 'POST', body: { text } });
      state.answerDraft = '';
      state.run = snapshot;
      renderRun(snapshot);
    } catch (error) {
      toast('Could not send the answer', error.message, 'error');
    }
  }

  /* ---------------------------------------------------------------- */
  /* discover                                                          */
  /* ---------------------------------------------------------------- */

  const discovery = {
    mode: 'trending',
    language: '',
    query: '',
    items: new Map(),
    favorites: 0,
    loaded: false,
    requestId: 0,
  };

  const DISCOVER_MODES = ['trending', 'recent', 'random', 'favorites', 'mine', 'search'];

  function repoOwner(name) {
    const slash = String(name || '').indexOf('/');
    return slash > 0 ? String(name).slice(0, slash) : '';
  }

  /** GitHub gives an ISO stamp; the card only has room for "3 days ago". */
  function sinceDay(value) {
    const at = Date.parse(value || '');
    if (!Number.isFinite(at)) return '';
    const days = Math.round((Date.now() - at) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return '1 day ago';
    if (days < 30) return `${days} days ago`;
    if (days < 365) return `${Math.round(days / 30)} months ago`;
    return `${(days / 365).toFixed(1)} years ago`;
  }

  function discoverCardMarkup(item) {
    const compat = item.installable
      ? `<span class="tag green" title="GUITinstal has an installer for ${esc(item.language || item.stack)} projects">Install-ready</span>`
      : `<span class="tag amber" title="No installer for ${esc(item.language || 'this language')} yet - you would set it up by hand">Manual setup</span>`;
    const updated = sinceDay(item.pushedAt || item.updatedAt);
    const saved = sinceDay(item.savedAt);
    const growth = item.trending
      ? `<span class="tag accent" title="Stars gained since this machine last looked">+${formatNumber(item.growth)} in ${item.spanHours}h</span>`
      : '';

    return `
      <article class="discover-card">
        <div class="card-head">
          <img class="card-mark" src="${esc(item.ownerAvatar || 'icon-128.png')}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="icon-128.png">
          <div class="card-main">
            <div class="card-title">${esc(item.name)}</div>
            <div class="card-sub">${esc(item.fullName)}</div>
          </div>
          <button class="icon-button fav-button${item.favorite ? ' starred' : ''}" type="button"
                  data-favorite="${esc(item.fullName)}" aria-pressed="${item.favorite ? 'true' : 'false'}"
                  title="${item.favorite ? 'Remove from Favorites' : 'Save to Favorites'}"
                  aria-label="${item.favorite ? 'Remove ' + esc(item.fullName) + ' from Favorites' : 'Save ' + esc(item.fullName) + ' to Favorites'}">
            <svg aria-hidden="true"><use href="#i-star"/></svg>
          </button>
        </div>
        <p class="card-desc">${esc(item.description || 'No description.')}</p>
        <div class="card-meta">
          <span class="tag" title="${saved ? 'Stars when this was saved' : 'Stars on GitHub'}">&#9733; ${formatNumber(item.stars)}</span>
          ${item.forks ? `<span class="tag" title="Forks on GitHub">&#8854; ${formatNumber(item.forks)}</span>` : ''}
          ${item.language ? `<span class="tag">${esc(item.language)}</span>` : ''}
          ${compat}
          ${growth}
          ${updated ? `<span class="tag ghost" title="Last push">updated ${updated}</span>` : ''}
          ${saved ? `<span class="tag ghost" title="Saved to Favorites">saved ${saved}</span>` : ''}
        </div>
        <div class="card-actions">
          <button class="button button-primary" data-discover="${esc(item.url)}">
            <svg aria-hidden="true"><use href="#i-download"/></svg> Install
          </button>
          <a class="button button-ghost" href="${esc(item.url)}" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </article>`;
  }

  function discoverSkeletons() {
    return '<div class="skeleton skeleton-card"></div>'.repeat(6);
  }

  function discoverEmpty(title, message) {
    return `
      <div class="empty-state">
        <svg aria-hidden="true"><use href="#i-compass"/></svg>
        <b>${esc(title)}</b>
        <p>${esc(message)}</p>
      </div>`;
  }

  function syncDiscoverChips() {
    $$('#discoverFilters .filter-chip').forEach((chip) => {
      const active = chip.dataset.mode === discovery.mode;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    $('#favoriteCount').textContent = String(discovery.favorites);

    // The language filter is a GitHub search qualifier. It has nothing to narrow
    // inside the saved Favorites list or a search the user typed themselves.
    const lang = $('#discoverLanguage');
    const applies = ['trending', 'recent', 'random'].includes(discovery.mode);
    lang.disabled = !applies;
    lang.title = applies
      ? 'Only show repositories written in this language'
      : 'Not used while browsing Favorites, your repositories, or your own search terms';
  }

  function renderDiscover(data) {
    const grid = $('#discoverGrid');
    const items = data.items || [];
    discovery.items = new Map(items.map((item) => [item.fullName, item]));

    const total = Number.isFinite(data.total) ? ` of ${data.total.toLocaleString()} on GitHub` : '';
    $('#discoverCount').textContent =
      discovery.mode === 'favorites'
        ? `${items.length} saved on this machine`
        : `${data.label || 'Results'}${total} - ${items.length} shown`;

    const note = $('#discoverNote');
    note.textContent = data.note || '';
    note.hidden = !data.note;

    if (!items.length) {
      let empty;
      if (discovery.mode === 'favorites') {
        empty = discoverEmpty(
          'No favorites yet',
          'Tap the star on any card to keep it here. Favorites live in the local library and survive a restart.'
        );
      } else if (discovery.mode === 'mine' && !state.settings?.githubTokenSet) {
        empty = discoverEmpty(
          'Connect GitHub',
          'Sign in from Settings to browse your public repositories here. Private repositories are not requested or accessed.'
        );
      } else if (discovery.mode === 'mine') {
        empty = discoverEmpty('No public repositories found', 'This GitHub account does not have any public repositories to show.');
      } else {
        empty = discoverEmpty('Nothing found', 'Try another term. Search goes straight to the public GitHub API.');
      }
      grid.innerHTML = empty;
      return;
    }
    grid.innerHTML = items.map(discoverCardMarkup).join('');
  }

  async function loadDiscover(mode) {
    if (mode) discovery.mode = DISCOVER_MODES.includes(mode) ? mode : discovery.mode;
    discovery.loaded = true;

    const grid = $('#discoverGrid');
    const errorBox = $('#discoverError');
    const requestId = discovery.requestId + 1;
    discovery.requestId = requestId;

    errorBox.hidden = true;
    syncDiscoverChips();
    grid.innerHTML = discoverSkeletons();

    const body = { mode: discovery.mode, language: discovery.language };
    if (discovery.mode === 'search') {
      body.q = discovery.query;
      body.sort = 'stars';
      if (!body.q) {
        grid.innerHTML = discoverEmpty('Search for a project', 'Type a topic above - "cli", "dashboard", "api" - and the list comes straight from GitHub.');
        $('#discoverCount').textContent = 'Search';
        return;
      }
    }

    try {
      const data = await api('/api/discover', { method: 'POST', body });
      if (requestId !== discovery.requestId) return;
      if (discovery.mode === 'favorites') discovery.favorites = (data.items || []).length;
      renderDiscover(data);
    } catch (error) {
      if (requestId !== discovery.requestId) return;
      // Discovery is a bonus on top of Home: it fails inside its own block only.
      grid.innerHTML = discoverEmpty('GitHub did not answer', 'Your projects and installs are untouched. Retry in a moment, or add a token in Settings for a higher limit.');
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      $('#discoverCount').textContent = 'Unavailable';
    }
  }

  function paintFavorite(fullName, on) {
    $$('[data-favorite]').forEach((button) => {
      if (button.dataset.favorite !== fullName) return;
      button.classList.toggle('starred', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.title = on ? 'Remove from Favorites' : 'Save to Favorites';
    });
    const item = discovery.items.get(fullName);
    if (item) item.favorite = on;
  }

  async function toggleFavorite(button) {
    const fullName = button.dataset.favorite;
    const on = button.getAttribute('aria-pressed') !== 'true';
    button.disabled = true;

    try {
      let data;
      if (on) {
        const item = discovery.items.get(fullName) || {};
        data = await api('/api/favorites', {
          method: 'POST',
          body: {
            fullName,
            owner: repoOwner(fullName),
            name: String(fullName).split('/')[1] || '',
            url: item.url || `https://github.com/${fullName}`,
            description: item.description || '',
            language: item.language || '',
            avatarUrl: item.ownerAvatar || '',
            stars: item.stars || 0,
          },
        });
        toast('Saved to Favorites', `${fullName} is in the local library.`, 'success');
      } else {
        data = await api(`/api/favorites/${encodeURIComponent(fullName).replace('%2F', '/')}`, { method: 'DELETE' });
        toast('Removed from Favorites', fullName);
      }

      discovery.favorites = (data.items || []).length;
      if (discovery.mode === 'favorites') {
        await loadDiscover('favorites');
      } else {
        paintFavorite(fullName, on);
      }
      syncDiscoverChips();
    } catch (error) {
      toast('Could not change the favorite', error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }


  /* ---------------------------------------------------------------- */
  /* updates                                                           */
  /* ---------------------------------------------------------------- */

  async function loadUpdates() {
    const grid = $('#updatesGrid');
    grid.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';

    if (!state.projects.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <svg aria-hidden="true"><use href="#i-refresh"/></svg>
          <b>Nothing to update</b>
          <p>Install a project first to track its repository updates.</p>
        </div>`;
      return;
    }

    const cards = [];
    for (const project of state.projects) {
      let info = { available: false, reason: 'Checking…' };
      try {
        info = await api(`/api/projects/${encodeURIComponent(project.id)}/updates`);
      } catch (error) {
        info = { available: false, reason: error.message };
      }

      // The folder may have been moved or emptied since the install: re-count it
      // so the record says what is on disk now, not what was installed once.
      let fresh = project;
      try {
        fresh = await api(`/api/projects/${encodeURIComponent(project.id)}/recheck`, { method: 'POST' });
        const index = state.projects.findIndex((item) => item.id === fresh.id);
        if (index >= 0) state.projects[index] = fresh;
      } catch {
        fresh = project;
      }

      cards.push(`
        <article class="project-card">
          <div class="card-head">
            <div class="card-main">
              <div class="card-title">${esc(fresh.name)}</div>
              <div class="card-sub">${esc(fresh.fullName)}</div>
            </div>
          </div>
          <div class="card-meta">
            <span class="tag ${info.available ? 'amber' : 'green'}">${
              info.available ? 'Update available' : 'Up to date'
            }</span>
            ${
              fresh.verify
                ? `<span class="tag ${fresh.verify.ok ? 'green' : 'amber'}">${esc(
                    `${fileCount(fresh.verify.files)} on disk`
                  )}</span>`
                : ''
            }
            ${info.local ? `<span class="tag">local ${esc(info.local)}</span>` : ''}
            ${info.remote ? `<span class="tag">remote ${esc(info.remote)}</span>` : ''}
          </div>
          ${info.commits?.length ? `<div class="card-path">${esc(info.commits[0].message)}</div>` : ''}
          ${
            info.reason && !info.available
              ? `<div class="card-path">${esc(info.reason)}</div>`
              : ''
          }
          <div class="card-actions">
            <button class="button ${info.available ? 'button-primary' : 'button-ghost'}" data-action="update" data-id="${esc(project.id)}" ${
              info.available ? '' : 'disabled'
            }>
              <svg aria-hidden="true"><use href="#i-refresh"/></svg> Update
            </button>
          </div>
        </article>`);
    }

    grid.innerHTML = cards.join('');
  }

  /* ---------------------------------------------------------------- */
  /* project actions                                                   */
  /* ---------------------------------------------------------------- */

  async function projectAction(action, id) {
    const project = state.projects.find((item) => item.id === id);
    if (!project) return;

    try {
      if (action === 'launch') {
        const result = await api(`/api/projects/${encodeURIComponent(id)}/launch`, { method: 'POST' });
        if (result.url) {
          const opened = await api(`/api/projects/${encodeURIComponent(id)}/browse`, { method: 'POST' });
          toast(
            opened.ok ? 'Project running' : 'Project running, browser did not open',
            opened.ok ? `The app opened at ${result.url}.` : `It is running at ${result.url}. Use Open app to open it.`,
            opened.ok ? 'success' : 'error'
          );
        } else {
          toast('Project running', `PID ${result.pid}. Output is saved in the project log.`, 'success');
        }
        await loadState();
      } else if (action === 'stop') {
        await api(`/api/projects/${encodeURIComponent(id)}/stop`, { method: 'POST' });
        toast('Project stopped', `${project.name} has been stopped.`, 'success');
        await loadState();
      } else if (action === 'log') {
        await openLog(project);
      } else if (action === 'guide') {
        window.location.hash = 'home';
        showView('home');
        setAskContext({ projectId: project.id }, project.fullName);
        $('#askInput').value = 'How do I open and run this project?';
        $('#askSendContext').checked = false;
        $('#askBlock').scrollIntoView({ behavior: 'smooth', block: 'start' });
        await askQuestion();
      } else if (action === 'open') {
        const result = await api(`/api/projects/${encodeURIComponent(id)}/open`, { method: 'POST' });
        if (result.ok) toast('Folder opened', 'The project folder is open in your file manager.', 'success');
        else toast('Could not open folder', 'The folder no longer exists or Windows could not open it.', 'error');
      } else if (action === 'terminal') {
        const result = await api(`/api/projects/${encodeURIComponent(id)}/terminal`, { method: 'POST' });
        if (result.ok) toast('Terminal opened', 'A terminal was opened in the project folder.', 'success');
        else toast('Could not open terminal', 'The project folder is missing or no supported terminal could be started.', 'error');
      } else if (action === 'browse') {
        const result = await api(`/api/projects/${encodeURIComponent(id)}/browse`, { method: 'POST' });
        if (!result.ok) toast('Could not open', 'The local app address is invalid or unavailable.', 'error');
      } else if (action === 'update') {
        toast('Updating', 'Running git pull --ff-only…');
        const result = await api(`/api/projects/${encodeURIComponent(id)}/update`, { method: 'POST' });
        toast('Project updated', result.lastCommit ? `Now at ${result.lastCommit}.` : 'Done.', 'success');
        await loadState();
      } else if (action === 'remove') {
        await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast('Removed from GUITinstal', 'The files stay in your workspace folder.', 'success');
        await loadState();
      }
    } catch (error) {
      toast('Error', error.message, 'error');
    }
  }

  /** Shows the launcher log of a project, including the reason it died. */
  async function openLog(project) {
    const dialog = $('#logDialog');
    dialog.dataset.project = project.id;
    $('#logTitle').textContent = `Log — ${project.name}`;
    $('#logPath').textContent = project.logPath || 'No log file yet.';
    $('#logBody').innerHTML = '<p class="log-empty">Loading…</p>';

    try {
      const result = await api(`/api/projects/${encodeURIComponent(project.id)}/log`);
      $('#logBody').innerHTML = result.lines.length
        ? result.lines.map((line) => `<div class="log-line"><span class="marker">›</span><span>${esc(line)}</span></div>`).join('')
        : '<p class="log-empty">No install record and no launcher output for this project yet.</p>';
      $('#logPath').textContent = result.path || project.logPath || '';
    } catch (error) {
      $('#logBody').innerHTML = `<p class="log-empty">${esc(error.message)}</p>`;
    }

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  /* ---------------------------------------------------------------- */
  /* settings                                                          */
  /* ---------------------------------------------------------------- */

  async function saveSettings(patch, message) {
    try {
      await api('/api/settings', { method: 'POST', body: patch });
      await loadState();
      toast('Settings saved', message, 'success');
    } catch (error) {
      toast('Could not save', error.message, 'error');
    }
  }

  function applyTheme(theme) {
    document.documentElement.classList.toggle('light-mode', theme === 'light');
    const button = $('#themeButton');
    button.innerHTML = theme === 'light' ? '<svg aria-hidden="true"><use href="#i-moon"/></svg>' : '<svg aria-hidden="true"><use href="#i-sun"/></svg>';
    button.setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
  }

  /* ---------------------------------------------------------------- */
  /* events                                                            */
  /* ---------------------------------------------------------------- */

  document.addEventListener('click', async (event) => {
    const navLink = event.target.closest('.nav-link');
    if (navLink) {
      event.preventDefault();
      window.location.hash = navLink.dataset.view;
      showView(navLink.dataset.view);
      if (navLink.dataset.view === 'updates') loadUpdates();
      return;
    }

    const goto = event.target.closest('[data-goto]');
    if (goto) {
      window.location.hash = goto.dataset.goto;
      showView(goto.dataset.goto);
      return;
    }

    const terminalMode = event.target.closest('[data-terminal-mode]');
    if (terminalMode) {
      setTerminalMode(terminalMode.dataset.terminalMode);
      return;
    }

    const runAction = event.target.closest('[data-run-action]');
    if (runAction) {
      const { runAction: action, step } = runAction.dataset;
      if (action === 'approve') await approveStep(step);
      else if (action === 'skip') await skipStep(step);
      else if (action === 'answer') await answerStep(step);
      return;
    }

    const startInstall = event.target.closest('[data-discover]');
    if (startInstall) {
      window.location.hash = 'home';
      showView('home');
      $('#repoUrl').value = startInstall.dataset.discover;
      await analyze(startInstall.dataset.discover);
      return;
    }

    const star = event.target.closest('[data-favorite]');
    if (star) {
      await toggleFavorite(star);
      return;
    }

    const action = event.target.closest('[data-action]');
    if (action?.dataset.action === 'recheck-runtimes') {
      await recheckRuntimes(action);
      return;
    }
    if (action?.dataset.action === 'prepare-runtime') {
      await prepareRuntime(action);
      return;
    }
    if (action?.dataset.action === 'import-repo') {
      await importWorkspaceRepo(action.dataset.dir);
      return;
    }
    if (action?.dataset.action === 'open-workspace-repo') {
      await openWorkspaceRepo(action.dataset.dir);
      return;
    }
    if (action) {
      await projectAction(action.dataset.action, action.dataset.id);
    }
  });

  $('#repoForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('#repoUrl').value.trim();
    if (!value) {
      const box = $('#repoError');
      box.textContent = 'Paste the URL of a GitHub repository.';
      box.hidden = false;
      return;
    }
    analyze(value);
  });

  $('#discoverForm').addEventListener('submit', (event) => {
    event.preventDefault();
    discovery.query = $('#discoverQuery').value.trim();
    loadDiscover('search');
  });

  $('#askForm').addEventListener('submit', (event) => {
    event.preventDefault();
    askQuestion();
  });

  $('#repairConsent').addEventListener('change', updateRepairButton);
  $('#repairButton').addEventListener('click', proposeFileRepair);
  $('#repairApply').addEventListener('click', applyFileRepair);
  $('#repairDiscard').addEventListener('click', () => {
    repairProposal = null;
    $('#repairPreview').hidden = true;
    $('#repairStatus').textContent = 'Proposal discarded; no file was changed.';
  });
  $('#repairTerminal').addEventListener('click', () => {
    if (ask.context?.projectId) projectAction('terminal', ask.context.projectId);
  });

  $('#aiProviderForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#aiProviderSave');
    button.disabled = true;
    $('#aiProviderStatus').textContent = 'Saving provider settings securely…';
    try {
      const result = await api('/api/ai/providers', {
        method: 'POST',
        body: {
          id: $('#aiProviderId').value || undefined,
          name: $('#aiProviderName').value.trim(),
          baseUrl: $('#aiProviderUrl').value.trim(),
          model: $('#aiProviderModel').value.trim(),
          apiKey: $('#aiProviderKey').value,
          noCost: $('#aiProviderNoCost').checked,
          enabled: $('#aiProviderEnabled').checked,
        },
      });
      $('#aiProviderKey').value = '';
      resetAiProviderForm();
      await loadAiProviders();
      $('#aiProviderStatus').textContent = result.provider.credentialNote ||
        (result.provider.hasApiKey ? 'Provider saved. The key is not shown again.' : 'Provider saved.');
    } catch (error) {
      $('#aiProviderStatus').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('#aiProviderCancel').addEventListener('click', resetAiProviderForm);
  $('#aiProviderList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-ai-provider-action]');
    if (!button) return;
    const provider = aiProviders.find((item) => item.id === button.dataset.id);
    if (!provider) return;
    const action = button.dataset.aiProviderAction;
    try {
      if (action === 'edit') {
        $('#aiProviderId').value = provider.id;
        $('#aiProviderName').value = provider.name;
        $('#aiProviderUrl').value = provider.baseUrl;
        $('#aiProviderModel').value = provider.model;
        $('#aiProviderKey').value = '';
        $('#aiProviderKey').placeholder = provider.hasApiKey ? 'Leave blank to keep saved key' : 'Enter an API key';
        $('#aiProviderNoCost').checked = provider.noCost;
        $('#aiProviderEnabled').checked = provider.enabled;
        $('#aiProviderSave').textContent = 'Update provider';
        $('#aiProviderCancel').hidden = false;
        $('#aiProviderName').focus();
      } else if (action === 'remove') {
        if (!window.confirm(`Remove ${provider.name} and its saved API key?`)) return;
        await api(`/api/ai/providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
        await loadAiProviders();
        if ($('#aiProviderId').value === provider.id) resetAiProviderForm();
      } else if (action === 'up' || action === 'down') {
        const ids = aiProviders.map((item) => item.id);
        const index = ids.indexOf(provider.id);
        const target = action === 'up' ? index - 1 : index + 1;
        if (target < 0 || target >= ids.length) return;
        [ids[index], ids[target]] = [ids[target], ids[index]];
        const result = await api('/api/ai/providers/reorder', { method: 'POST', body: { ids } });
        renderAiProviders(result.providers);
      }
    } catch (error) {
      $('#aiProviderStatus').textContent = error.message;
    }
  });

  $('#discoverFilters').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-mode]');
    if (chip) loadDiscover(chip.dataset.mode);
  });

  $('#discoverLanguage').addEventListener('change', (event) => {
    discovery.language = event.target.value;
    loadDiscover(discovery.mode === 'recent' ? 'recent' : 'trending');
  });

  // GitHub avatars are remote: when one is blocked or missing, the card falls back
  // to the app icon instead of the broken-image glyph. Inline onerror is blocked by
  // the CSP, so this listener runs in the capture phase before the element hides.
  document.addEventListener(
    'error',
    (event) => {
      const image = event.target;
      if (image?.tagName !== 'IMG' || !image.dataset.fallback) return;
      if (image.src.endsWith(image.dataset.fallback)) return;
      image.dataset.fallback = '';
      image.src = 'icon-128.png';
    },
    true
  );

  $('#menuButton').addEventListener('click', () => {
    const open = $('#sidebar').classList.contains('open');
    if (open) closeSidebar();
    else openSidebar();
  });

  $('#sidebarScrim').addEventListener('click', closeSidebar);

  $('#sidebarInstall').addEventListener('click', () => {
    window.location.hash = 'home';
    showView('home');
    $('#repoUrl').focus();
  });

  $('#themeButton').addEventListener('click', async () => {
    const next = document.documentElement.classList.contains('light-mode') ? 'dark' : 'light';
    applyTheme(next);
    await saveSettings({ theme: next }, next === 'light' ? 'Light theme on.' : 'Dark theme on.');
  });

  $('#themeSelect').addEventListener('change', (event) => {
    applyTheme(event.target.value);
    saveSettings({ theme: event.target.value }, 'Theme updated.');
  });

  $('#saveWorkspace').addEventListener('click', () => {
    const value = $('#workspaceInput').value.trim();
    if (!value) {
      toast('Enter a path', 'The workspace folder cannot be empty.', 'error');
      return;
    }
    saveSettings({ workspace: value }, 'Workspace folder updated.');
  });

  $('#resetWorkspace').addEventListener('click', () => {
    const fallback = state.defaultWorkspace || defaultWorkspaceGuess();
    $('#workspaceInput').value = fallback;
    saveSettings({ workspace: fallback }, 'Default folder restored.');
  });

  function defaultWorkspaceGuess() {
    if (state.defaultWorkspace) return state.defaultWorkspace;
    const home = state.settings?.workspace || '';
    const parts = home.split(/[\\/]/);
    return parts.slice(0, parts.length - 1).join('\\') + '\\Repositories';
  }

  $('#openWorkspace').addEventListener('click', async () => {
    try {
      const result = await api('/api/workspace/open', { method: 'POST' });
      if (!result.ok) toast('Could not open', 'The folder does not exist. Create it or pick another path.', 'error');
    } catch (error) {
      toast('Error', error.message, 'error');
    }
  });

  $('#scanWorkspace').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await loadWorkspaceRepos();
      const pending = state.workspaceRepos.filter((item) => !item.registered).length;
      toast(
        'Workspace scanned',
        pending
          ? `${pending} downloaded repositor${pending === 1 ? 'y' : 'ies'} can be added to your library.`
          : 'Every repository on disk is already in your library.',
        pending ? 'info' : 'success'
      );
    } finally {
      button.disabled = false;
    }
  });

  $('#openWorkspaceGallery').addEventListener('click', async () => {
    try {
      const result = await api('/api/workspace/open', { method: 'POST' });
      if (!result.ok) toast('Could not open', 'The workspace folder does not exist yet.', 'error');
    } catch (error) {
      toast('Could not open', error.message, 'error');
    }
  });

  /* github device flow                                                */

  const device = { timer: null, interval: 5000, code: '' };

  function deviceMessage(text, kind = '') {
    const status = $('#deviceStatus');
    status.textContent = text;
    status.className = `device-status ${kind}`.trim();
  }

  function stopDevice() {
    clearInterval(device.timer);
    device.timer = null;
  }

  function closeDevice() {
    stopDevice();
    $('#deviceFlow').hidden = true;
  }

  // The server holds the device code, so this loop is only the rhythm: leaving
  // the screen does not cancel the authorization on GitHub.
  function watchDevice() {
    device.timer = setInterval(async () => {
      let result;
      try {
        result = await api('/api/github-auth/poll', { method: 'POST' });
      } catch (error) {
        closeDevice();
        toast('Sign-in failed', error.message, 'error');
        return;
      }

      if (result.status === 'connected') {
        closeDevice();
        await loadState();
        // Pull the username + avatar from GitHub so the Settings row shows who
        // actually signed in instead of a bare "signed in" flag.
        await checkGithubAccount();
        if (discovery.mode === 'mine') await loadDiscover('mine');
      } else if (result.status === 'expired') {
        closeDevice();
        toast('Code expired', 'Device codes last 15 minutes. Start the sign-in again.', 'error');
      } else if (result.status === 'idle') {
        closeDevice();
      } else if (result.interval) {
        device.interval = Math.max(3, result.interval) * 1000;
        stopDevice();
        watchDevice();
        deviceMessage('GitHub asked us to slow down. Waiting a bit longer…');
      }
    }, device.interval);
  }

  $('#githubSignIn').addEventListener('click', async () => {
    const button = $('#githubSignIn');
    button.disabled = true;
    try {
      const data = await api('/api/github-auth/start', { method: 'POST' });
      stopDevice();
      device.code = data.userCode;
      device.interval = Math.max(3, data.interval || 5) * 1000;
      $('#deviceCode').textContent = data.userCode;
      $('#deviceLink').href = data.verificationUriComplete || data.verificationUri;
      $('#deviceFlow').hidden = false;
      deviceMessage('Waiting for you to authorize…');
      watchDevice();
    } catch (error) {
      toast('Could not start sign-in', error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#deviceCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(device.code);
      deviceMessage('Code copied.');
    } catch {
      deviceMessage('Select the code above and copy it manually.');
    }
  });

  $('#deviceCancel').addEventListener('click', () => {
    closeDevice();
    api('/api/github-auth/cancel', { method: 'POST' }).catch(() => {});
  });

  $('#githubCheck').addEventListener('click', () => checkGithubAccount());

  $('#githubSignOut').addEventListener('click', async () => {
    const button = $('#githubSignOut');
    button.disabled = true;
    try {
      const result = await api('/api/github-auth/disconnect', { method: 'POST' });
      state.settings = result.settings;
      renderGithubAccount(result.settings, result.token);
      await loadState();
      toast('Signed out', 'The token was removed from this computer. Revoke it at github.com/settings/tokens too.', 'info');
      if (discovery.mode === 'mine') await loadDiscover('mine');
    } catch (error) {
      toast('Could not sign out', error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#saveToken').addEventListener('click', () => {
    const value = $('#tokenInput').value.trim();
    saveSettings({ githubToken: value }, value ? 'Token saved on this computer.' : 'Token removed.');
    $('#tokenInput').value = '';
    if (value) {
      checkGithubAccount({ quiet: true }).then(() => {
        if (discovery.mode === 'mine') loadDiscover('mine');
      });
    }
  });

  $('#clearToken').addEventListener('click', () => {
    $('#tokenInput').value = '';
    saveSettings({ githubToken: '' }, 'Token removed.');
    if (discovery.mode === 'mine') loadDiscover('mine');
  });

  $('#shallowToggle').addEventListener('change', (event) => {
    saveSettings({ shallowClone: event.target.checked }, 'Shallow clone updated.');
  });

  $('#autoApproveToggle').addEventListener('change', (event) => {
    saveSettings({ autoApproveLowRisk: event.target.checked }, 'Auto-approval updated.');
  });

  $('#toastClose').addEventListener('click', () => $('#toast').classList.remove('visible'));

  $('#logClose').addEventListener('click', () => $('#logDialog').close());
  $('#logRefresh').addEventListener('click', () => {
    const id = $('#logDialog').dataset.project;
    const project = state.projects.find((item) => item.id === id);
    if (project) openLog(project);
  });
  $('#logDialog').addEventListener('close', () => {
    delete $('#logDialog').dataset.project;
  });

  $('#globalSearch').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    if (!query) {
      renderProjects();
      return;
    }
    const filtered = state.projects.filter((project) =>
      `${project.name} ${project.fullName} ${project.description} ${project.stackLabel}`.toLowerCase().includes(query)
    );
    const grid = $('#projectsGrid');
    window.location.hash = 'projects';
    showView('projects');
    grid.innerHTML = filtered.length
      ? filtered.map(projectCard).join('')
      : `<div class="empty-state"><svg aria-hidden="true"><use href="#i-search"/></svg><b>Nothing found</b><p>No project matches "${esc(query)}".</p></div>`;
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#globalSearch').focus();
    }
    if (event.key === 'Escape') {
      closeSidebar();
      $('#toast').classList.remove('visible');
    }
    if (event.key === 'Enter' && event.target.classList?.contains('answer-input')) {
      event.preventDefault();
      answerStep(event.target.dataset.step);
    }
  });

  // The answer box is rebuilt whenever a step changes state, so the typed
  // text lives in state and not only in the DOM.
  document.addEventListener('input', (event) => {
    if (event.target.classList?.contains('answer-input')) state.answerDraft = event.target.value;
  });

  window.addEventListener('hashchange', routeFromHash);

  /* ---------------------------------------------------------------- */
  /* boot                                                              */
  /* ---------------------------------------------------------------- */

  // The Favorites chip shows a count before the board is opened, so the saved
  // list is read once up front; a failure here only leaves the chip at zero.
  try {
    discovery.favorites = ((await api('/api/favorites')).items || []).length;
  } catch {
    discovery.favorites = 0;
  }

  routeFromHash();
  await renderWhatsNew();
  await loadState();
  if (window.location.hash === '#updates') loadUpdates();

  // Deep link: ?repo=owner/name opens the app already analyzing that project.
  const deepLink = new URLSearchParams(window.location.search).get('repo');
  if (deepLink) {
    $('#repoUrl').value = deepLink;
    await analyze(deepLink);
  }
})();