(() => {
  const on = (id) => document.getElementById(id);
  const toast = on('downloadToast');
  const guide = 'download.html';
  let release = null;

  function notice(title, message) {
    if (!toast) return;
    on('toastTitle').textContent = title;
    on('toastMessage').textContent = message;
    toast.classList.add('visible');
    clearTimeout(notice.timer);
    notice.timer = setTimeout(() => toast.classList.remove('visible'), 8000);
  }

  const files = (platform = 'windows') => release?.platforms?.[platform]?.files || [];
  const downloadFallback = (element) => element.dataset.downloadFallback || guide;

  function pick(platform) {
    if (platform === 'auto') platform = currentPlatform();
    const entry = release?.platforms?.[platform];
    if (!entry?.files?.length) return null;
    return entry.files.find((file) => file.recommended) || entry.files[0];
  }

  function currentPlatform() {
    const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
    if (/win/i.test(platform)) return 'windows';
    if (/mac/i.test(platform)) return 'macos';
    if (/linux/i.test(platform)) return 'linux';
    return 'windows';
  }

  function findFile(reference) {
    const [platform, kind] = reference.includes(':') ? reference.split(':', 2) : ['windows', reference];
    return files(platform).find((item) => item.kind === kind);
  }

  function fieldValue(file, field) {
    if (!file) return 'not published yet';
    if (field === 'size') return file.sizeLabel || '—';
    if (field === 'sha') return file.sha256 || '—';
    if (field === 'bytes') return file.size?.toLocaleString('en-US') || '—';
    return file[field] || '';
  }

  function applyRelease() {
    const windowsFile = pick('windows');

    document.querySelectorAll('[data-download]').forEach((element) => {
      const file = pick(element.dataset.download || 'auto');
      if (file?.url) {
        element.setAttribute('href', file.url);
        element.setAttribute('download', file.name);
        element.classList.remove('is-pending');
      } else {
        element.setAttribute('href', downloadFallback(element));
        element.removeAttribute('download');
        element.classList.add('is-pending');
      }
    });

    document.querySelectorAll('[data-file]').forEach((element) => {
      const file = findFile(element.dataset.file);
      if (file?.url) {
        element.setAttribute('href', file.url);
        element.setAttribute('download', file.name);
      } else {
        element.setAttribute('href', 'index.html#download');
        element.classList.add('is-pending');
      }
    });

    document.querySelectorAll('[data-file-field]').forEach((element) => {
      const parts = element.dataset.fileField.split('.');
      const [platform, kind, field] = parts.length === 3 ? parts : ['windows', ...parts];
      element.textContent = fieldValue(findFile(`${platform}:${kind}`), field);
    });

    const meta = (id, value) => {
      const node = on(id);
      if (node) node.textContent = value;
    };
    meta('metaVersion', release?.version || '—');
    meta('metaSize', windowsFile?.sizeLabel || 'not published');
    meta('metaSha', windowsFile?.sha256 ? `${windowsFile.sha256.slice(0, 16)}…` : '—');
    meta('metaDate', release?.releasedAt || '—');
    meta('winCardMeta', windowsFile?.url ? `Installer .exe · ${windowsFile.sizeLabel}` : 'Not hosted yet — see the guide');
    const macFile = pick('macos');
    const linuxFile = pick('linux');
    meta('macCardMeta', macFile?.url ? `Universal DMG · ${macFile.sizeLabel}` : 'Not published yet — see the guide');
    meta('linuxCardMeta', linuxFile?.url ? `AppImage · ${linuxFile.sizeLabel}` : 'Run from the public repository · Node.js 24+');

    // What's new is written once, in releases.json, and read here — the app
    // shows the same notes from its own changelog entry for the same version.
    const whatsNew = on('whatsNewPanel');
    if (whatsNew) {
      if (release?.releaseNotes) {
        meta('whatsNewVersion', release?.version ? `v${release.version}` : '');
        meta('whatsNewNotes', release.releaseNotes);
        meta('whatsNewDate', release?.releasedAt ? `Released ${release.releasedAt}` : '');
        whatsNew.hidden = false;
      } else {
        whatsNew.hidden = true;
      }
    }

    for (const [key, url] of Object.entries(release?.links || {})) {
      document.querySelectorAll(`[data-link="${key}"]`).forEach((link) => {
        if (url) link.setAttribute('href', url);
        else link.remove();
      });
    }

    applySubmitLink();
  }

  document.querySelectorAll('[data-download]').forEach((button) => {
    button.addEventListener('click', (event) => {
      const file = pick(button.dataset.download || 'auto');
      if (file?.url || button.getAttribute('href') === downloadFallback(button)) return;
      event.preventDefault();
      notice('Download not published yet', 'This installer is not in the latest public release yet. Open the install guide for details.');
    });
  });

  on('toastClose')?.addEventListener('click', () => toast.classList.remove('visible'));

  const guidePanel = on('guidePanel');
  const guideToggle = on('guideToggle');
  const guideInput = on('guideInput');
  const guideMessages = on('guideMessages');

  function addGuideMessage(text, speaker) {
    const message = document.createElement('p');
    message.className = `guide-message guide-message-${speaker}`;
    message.textContent = text;
    guideMessages.append(message);
    guideMessages.scrollTop = guideMessages.scrollHeight;
  }

  function guideAnswer(question) {
    const text = question.toLowerCase();
    if (/terminal|shell|command/.test(text)) {
      return 'A terminal is a text window for running a project’s setup or start command from its folder. In the desktop app, Guide can point out commands found in the project files. Review each command before running it; never paste a command you do not trust.';
    }
    if (/privacy|private|code|data|send|ai|artificial intelligence/.test(text)) {
      return 'This website helper uses curated answers: it does not read your files, call an AI model, or send or store your chat. In the desktop app, project Guide works from local project files; external AI is optional and requires your consent before selected context is sent.';
    }
    if (/linux|mac|windows|download|install/.test(text)) {
      return 'Choose your operating system in Downloads. A direct installer is offered only when it exists in the official release. Linux source-based setup instructions are available when an AppImage is not published. Read the install guide and keep your OS security protections enabled.';
    }
    if (/api|freeapi|model/.test(text)) {
      return 'An API catalog such as FreeAPI lists services other apps can connect to; it is not itself an AI model. GUITinstal does not bundle thousands of APIs or promise they are free. Any external AI provider must be configured by you, and its pricing should be checked with that provider.';
    }
    if (/update|news|release|follow|favorite/.test(text)) {
      return 'The site checks the project’s official GitHub release for the latest published version and notes. The desktop app does not silently rewrite or self-evolve; use official releases and review updates before installing. Automatic app updates are not currently available.';
    }
    if (/open|run|start|launch|project|repository|repo/.test(text)) {
      return 'In the desktop app, add a repository to your library, review its setup steps, and approve what you want to run. Once it is saved, select Guide on the project to see its detected stack, start scripts, and useful README instructions. Guide explains the steps; it does not run README commands automatically.';
    }
    if (/what is|what does|about|guitinstal/.test(text)) {
      return 'GUITinstal is a desktop workspace for organizing open-source projects, understanding their setup, and launching them with reviewed steps. Its project Guide can use local project files to explain how to get started.';
    }
    return 'I can help with downloads, project setup, the terminal, privacy, APIs, and updates. Try one of the suggested questions. For guidance about a specific folder, open that project in the desktop app and choose Guide.';
  }

  function askGuide(question) {
    const value = question.trim();
    if (!value || !guideMessages) return;
    addGuideMessage(value, 'user');
    addGuideMessage(guideAnswer(value), 'bot');
  }

  guideToggle?.addEventListener('click', () => {
    const isOpen = guidePanel.hidden;
    guidePanel.hidden = !isOpen;
    guideToggle.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) guideInput?.focus();
  });
  on('guideClose')?.addEventListener('click', () => {
    guidePanel.hidden = true;
    guideToggle?.setAttribute('aria-expanded', 'false');
    guideToggle?.focus();
  });
  on('guideForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    askGuide(guideInput.value);
    guideInput.value = '';
  });
  on('guidePanel')?.addEventListener('click', (event) => {
    const prompt = event.target.closest('[data-guide-question]');
    if (prompt) askGuide(prompt.dataset.guideQuestion);
  });

  const year = on('year');
  if (year) year.textContent = new Date().getFullYear();

  function latestRelease(fallback) {
    const match = fallback?.links?.github?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/?$/);
    if (!match) return Promise.resolve(fallback);
    return fetch(`https://api.github.com/repos/${match[1]}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    }).then((response) => {
      if (!response.ok) throw new Error('latest release unavailable');
      return response.json();
    }).then((data) => {
      const platforms = {
        windows: { ...fallback.platforms?.windows, files: (fallback.platforms?.windows?.files || []).filter((file) => file.source === 'direct') },
        macos: { ...fallback.platforms?.macos, files: (fallback.platforms?.macos?.files || []).filter((file) => file.source === 'direct') },
        linux: { ...fallback.platforms?.linux, files: (fallback.platforms?.linux?.files || []).filter((file) => file.source === 'direct') },
      };
      for (const asset of data.assets || []) {
        let platform;
        let kind;
        if (/^GUITinstal-.*-Setup-x64\.exe$/i.test(asset.name)) [platform, kind] = ['windows', 'setup'];
        else if (/^GUITinstal-.*-Portable-x64\.exe$/i.test(asset.name)) [platform, kind] = ['windows', 'portable'];
        else if (/^GUITinstal-.*-mac-universal\.dmg$/i.test(asset.name)) [platform, kind] = ['macos', 'universal'];
        else if (/^GUITinstal-.*-linux-x64\.AppImage$/i.test(asset.name)) [platform, kind] = ['linux', 'appimage'];
        else continue;
        if (platforms[platform].files.some((file) => file.source === 'direct')) continue;
        platforms[platform].files.push({
          kind,
          name: asset.name,
          url: asset.browser_download_url,
          size: asset.size,
          sizeLabel: `${(asset.size / 1024 / 1024).toFixed(1)} MB`,
          sha256: (asset.digest || '').replace(/^sha256:/, ''),
          builtAt: asset.updated_at,
          recommended: kind === 'setup' || kind === 'universal' || kind === 'appimage',
        });
      }
      return {
        ...fallback,
        version: String(data.tag_name || fallback.version).replace(/^v/, ''),
        releasedAt: data.published_at?.slice(0, 10) || fallback.releasedAt,
        releaseNotes: data.body || fallback.releaseNotes,
        platforms,
      };
    });
  }

  fetch('releases.json', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error('http'))))
    .then((data) => latestRelease(data).catch(() => data))
    .then((data) => {
      release = data;
      applyRelease();
    })
    .catch(() => {
      applyRelease();
      notice('Release list unavailable', 'Could not read releases.json. The install guide still works.');
    });

  const search = on('siteSearch');
  if (search) {
    const searchable = [...document.querySelectorAll('.searchable')];
    search.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      searchable.forEach((item) => {
        const text = `${item.textContent} ${item.dataset.search || ''}`.toLowerCase();
        const match = !query || text.includes(query);
        item.classList.toggle('no-match', Boolean(query) && !match);
        item.classList.toggle('search-match', Boolean(query) && match);
      });
    });
  }

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      search?.focus();
    }
    if (event.key === 'Escape') {
      if (guidePanel && !guidePanel.hidden) {
        guidePanel.hidden = true;
        guideToggle?.setAttribute('aria-expanded', 'false');
        guideToggle?.focus();
      }
      if (search) {
        search.value = '';
        search.dispatchEvent(new Event('input'));
        search.blur();
      }
      toast?.classList.remove('visible');
    }
  });

  const themeButton = on('themeButton');
  themeButton?.addEventListener('click', () => {
    document.documentElement.classList.toggle('light-mode');
    const isLight = document.documentElement.classList.contains('light-mode');
    themeButton.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
    themeButton.innerHTML = isLight ? '<svg><use href="#i-moon"/></svg>' : '<svg><use href="#i-sun"/></svg>';
  });

  const menuButton = on('mobileMenu');
  const sidebar = document.querySelector('.sidebar');
  menuButton?.addEventListener('click', () => {
    const isOpen = sidebar.classList.toggle('open');
    menuButton.setAttribute('aria-expanded', String(isOpen));
  });
  document.querySelectorAll('.side-nav a').forEach((link) =>
    link.addEventListener('click', () => {
      sidebar?.classList.remove('open');
      menuButton?.setAttribute('aria-expanded', 'false');
    }),
  );

  /* ----------------------------- testimonials ----------------------------- */

  const LEVELS = ['Beginner developer', 'Intermediate developer', 'Experienced developer', 'Senior software engineer', 'Open-source maintainer'];

  const html = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');

  // Only reviews written by a real person who agreed to be quoted reach the page.
  function usable(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.consent !== true) return false;
    if (typeof item.quoteEnglish !== 'string' || item.quoteEnglish.trim().length < 20) return false;
    if (typeof item.displayName !== 'string' || !item.displayName.trim()) return false;
    if (!LEVELS.includes(item.level)) return false;
    return true;
  }

  function cardMarkup(item) {
    const origin = [item.country, item.language].filter((part) => typeof part === 'string' && part.trim()).join(' · ');
    const original =
      item.quoteOriginal && item.language
        ? `<p class="t-original"><span>${html(item.language)}</span> “${html(item.quoteOriginal)}”</p>`
        : '';
    return `<article class="t-card">
        <span class="t-level">${html(item.level)}</span>
        <p class="t-quote">“${html(item.quoteEnglish.trim())}”</p>
        ${original}
        <footer class="t-foot">
          <b>${html(item.displayName.trim())}</b>
          ${origin ? `<small>${html(origin)}</small>` : ''}
          ${item.verified === true ? '<em class="t-verified"><svg><use href="#i-check-circle"/></svg> Verified</em>' : ''}
        </footer>
      </article>`;
  }

  const carousel = { items: [], page: 0, pages: 1 };

  const perPage = () => {
    const width = window.innerWidth;
    if (width >= 1100) return 3;
    if (width >= 760) return 2;
    return 1;
  };

  function paintCarousel() {
    const track = on('testimonialTrack');
    const dots = on('testimonialDots');
    if (!track || !dots) return;

    const size = perPage();
    carousel.pages = Math.max(1, Math.ceil(carousel.items.length / size));
    carousel.page = Math.min(carousel.page, carousel.pages - 1);

    const pages = [];
    for (let start = 0; start < carousel.items.length; start += size) {
      pages.push(`<div class="t-page">${carousel.items.slice(start, start + size).map(cardMarkup).join('')}</div>`);
    }
    track.style.setProperty('--per-page', String(size));
    track.innerHTML = pages.join('');
    track.style.transform = `translateX(${-carousel.page * 100}%)`;

    dots.innerHTML = Array.from({ length: carousel.pages }, (_, index) =>
      `<button type="button" class="carousel-dot${index === carousel.page ? ' on' : ''}" data-page="${index}" aria-label="Go to testimonials page ${index + 1}"></button>`,
    ).join('');
  }

  function moveTo(page) {
    carousel.page = (page + carousel.pages) % carousel.pages;
    paintCarousel();
  }

  function showTestimonials(items) {
    carousel.items = items;
    const empty = on('testimonialEmpty');
    const hasStories = items.length > 0;
    if (empty) empty.hidden = hasStories;
    on('testimonialCarousel').hidden = !hasStories;
    on('testimonialDisclosure').textContent = hasStories
      ? `${items.length} published ${items.length === 1 ? 'review' : 'reviews'}, each written by a user who agreed to be quoted.`
      : '';
    if (hasStories) paintCarousel();
  }

  function applySubmitLink() {
    const link = on('testimonialSubmit');
    const note = on('testimonialNote');
    const repo = release?.links?.github;
    if (!link) return;
    if (!repo) {
      link.setAttribute('href', '#download');
      if (note) note.textContent = 'Submissions open with the public repository.';
      return;
    }
    const body = [
      'GUITinstal testimonial submission',
      '',
      'Display name (or handle): ',
      'Experience level: Beginner developer / Intermediate developer / Experienced developer / Senior software engineer / Open-source maintainer',
      'Country (optional): ',
      'Language the review was originally written in: ',
      '',
      'Review in the original language:',
      '> ',
      '',
      'English translation:',
      '> ',
      '',
      'I confirm I used GUITinstal myself and I agree to have this review published on guitinstal.vercel.app: yes / no',
    ].join('\n');
    link.setAttribute('href', `${repo}/issues/new?title=${encodeURIComponent('Testimonial submission')}&body=${encodeURIComponent(body)}`);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noreferrer');
    if (note) note.textContent = 'Published only after we verify the review and your consent to be quoted.';
  }

  on('testimonialPrev')?.addEventListener('click', () => moveTo(carousel.page - 1));
  on('testimonialNext')?.addEventListener('click', () => moveTo(carousel.page + 1));
  on('testimonialDots')?.addEventListener('click', (event) => {
    const dot = event.target.closest('[data-page]');
    if (dot) moveTo(Number(dot.dataset.page));
  });

  const viewport = on('testimonialViewport');
  if (viewport) {
    viewport.tabIndex = 0;
    let touchStartX = null;
    viewport.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') moveTo(carousel.page - 1);
      if (event.key === 'ArrowRight') moveTo(carousel.page + 1);
    });
    viewport.addEventListener('touchstart', (event) => {
      touchStartX = event.touches[0].clientX;
    }, { passive: true });
    viewport.addEventListener('touchend', (event) => {
      if (touchStartX === null) return;
      const delta = event.changedTouches[0].clientX - touchStartX;
      if (Math.abs(delta) > 40) moveTo(carousel.page + (delta < 0 ? 1 : -1));
      touchStartX = null;
    }, { passive: true });
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    if (!carousel.items.length) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(paintCarousel, 150);
  });

  applySubmitLink();

  fetch('testimonials.json', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error('http'))))
    .then((data) => showTestimonials((Array.isArray(data?.items) ? data.items : []).filter(usable)))
    .catch(() => showTestimonials([]));

  /* -------------------------------- partners -------------------------------- */

  const PARTNER_KINDS = { influencer: 'Creator', company: 'Company', community: 'Community' };

  // A partner card only needs a name. Everything else is optional, so adding a
  // name to partners.json never requires touching this file.
  function usablePartner(item) {
    return Boolean(item) && typeof item === 'object' && typeof item.name === 'string' && item.name.trim().length > 1;
  }

  function partnerCard(item) {
    const name = item.name.trim();
    const initials = name
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase();
    const kind = PARTNER_KINDS[item.kind] || 'Supporter';
    const region = String(item.country || '').trim();
    const place = region ? `<span class="partner-place" title="Country">${html(region.length === 2 ? region.toUpperCase() : region)}</span>` : '';
    const handle = typeof item.handle === 'string' && item.handle.trim() ? `<small>${html(item.handle.trim())}</small>` : '';
    const body = typeof item.blurb === 'string' && item.blurb.trim() ? `<p>${html(item.blurb.trim())}</p>` : '';
    const inner = `
        <span class="partner-mark">${html(initials)}</span>
        <div class="partner-main">
          <div class="partner-title"><b>${html(name)}</b>${handle}</div>
          ${body}
          <div class="partner-tags"><span class="partner-kind">${html(kind)}</span>${place}</div>
        </div>`;
    return item.url
      ? `<a class="partner-card" href="${html(item.url)}" target="_blank" rel="noreferrer noopener sponsored">${inner}<svg class="partner-arrow" aria-hidden="true"><use href="#i-arrow-up-right"/></svg></a>`
      : `<article class="partner-card">${inner}</article>`;
  }

  function renderPartners(data) {
    const supporters = (Array.isArray(data?.supporters) ? data.supporters : []).filter(usablePartner);
    const builtWith = (Array.isArray(data?.builtWith) ? data.builtWith : []).filter(usablePartner);

    const grid = on('partnerGrid');
    const empty = on('partnerEmpty');
    if (grid && empty) {
      grid.innerHTML = supporters.map(partnerCard).join('');
      grid.hidden = supporters.length === 0;
      empty.hidden = supporters.length > 0;
    }

    const built = on('builtGrid');
    if (built) {
      built.innerHTML = builtWith
        .map(
          (item) => `<a class="built-chip" href="${html(item.url || '#')}" target="_blank" rel="noreferrer noopener"><b>${html(item.name)}</b>${item.role ? `<small>${html(item.role)}</small>` : ''}</a>`,
        )
        .join('');
    }

    const region = typeof data?.program?.region === 'string' ? data.program.region : '';
    const note = on('partnerNote');
    if (note && region) note.textContent = `Creator or company? The first cohort opens in ${region}; applications open with the public repository.`;

    const disclosure = on('partnerDisclosure');
    if (disclosure) {
      disclosure.textContent = supporters.length
        ? `${supporters.length} listed ${supporters.length === 1 ? 'partner' : 'partners'}, each confirmed with the person or company. Sponsored or affiliate links are marked.`
        : '';
    }
  }

  fetch('partners.json', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error('http'))))
    .then(renderPartners)
    .catch(() => renderPartners(null));

  /* --------------------------- founders countdown --------------------------- */

  const clock = { badge: on('foundersCountdown'), label: on('foundersCountdownLabel'), timer: null };
  const clockCells = [on('cdDays'), on('cdHours'), on('cdMinutes'), on('cdSeconds')];

  function paintClock(deadline) {
    const left = deadline - Date.now();
    if (left <= 0) {
      clearInterval(clock.timer);
      clock.label.textContent = 'FOUNDERS OFFER CLOSED';
      clockCells.forEach((cell) => { cell.textContent = '00'; });
      return;
    }
    const seconds = Math.floor(left / 1000);
    const units = [Math.floor(seconds / 86400), Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60];
    units.forEach((value, index) => { clockCells[index].textContent = String(value).padStart(2, '0'); });
  }

  // The deadline lives in pricing.json, so every visitor sees the same count
  // and nobody gets a timer that restarts on refresh. No date, no badge.
  fetch('pricing.json', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error('http'))))
    .then((data) => {
      const raw = data?.founders?.deadline;
      const deadline = typeof raw === 'string' ? Date.parse(raw) : NaN;
      // No configured date: the badge stays hidden and never invents one.
      if (!Number.isFinite(deadline)) return;
      clock.badge.hidden = false;
      paintClock(deadline);
      if (deadline <= Date.now()) return;
      clock.timer = setInterval(() => paintClock(deadline), 1000);
    })
    .catch(() => {});
})();
