'use strict';

const PACKAGE_NAMES = {
  node: { apt: ['nodejs', 'npm'], dnf: ['nodejs', 'npm'], pacman: ['nodejs', 'npm'] },
  npm: { apt: ['nodejs', 'npm'], dnf: ['nodejs', 'npm'], pacman: ['nodejs', 'npm'] },
  python: { apt: ['python3'], dnf: ['python3'], pacman: ['python'] },
  pip: { apt: ['python3-pip'], dnf: ['python3-pip'], pacman: ['python-pip'] },
  venv: { apt: ['python3-venv'], dnf: ['python3'], pacman: ['python'] },
  git: { apt: ['git'], dnf: ['git'], pacman: ['git'] },
  go: { apt: ['golang-go'], dnf: ['golang'], pacman: ['go'] },
  cargo: { apt: ['cargo'], dnf: ['cargo'], pacman: ['cargo'] },
  java: { apt: ['default-jdk'], dnf: ['java-21-openjdk-devel'], pacman: ['jdk21-openjdk'] },
  maven: { apt: ['maven'], dnf: ['maven'], pacman: ['maven'] },
  gradle: { apt: ['gradle'], dnf: ['gradle'], pacman: ['gradle'] },
  php: { apt: ['php-cli'], dnf: ['php-cli'], pacman: ['php'] },
  composer: { apt: ['composer'], dnf: ['composer'], pacman: ['composer'] },
  bundle: { apt: ['ruby', 'ruby-bundler'], dnf: ['ruby', 'rubygems'], pacman: ['ruby'] },
  make: { apt: ['make'], dnf: ['make'], pacman: ['make'] },
};

const PACKAGE_MANAGERS = [
  { id: 'apt', label: 'Debian / Ubuntu', prefix: 'sudo apt-get update && sudo apt-get install -y' },
  { id: 'dnf', label: 'Fedora', prefix: 'sudo dnf install -y' },
  { id: 'pacman', label: 'Arch Linux', prefix: 'sudo pacman -S --needed' },
];

function linuxInstallCommands(runtimeIds = []) {
  const ids = [...new Set(runtimeIds.map((id) => String(id).toLowerCase()))];
  return PACKAGE_MANAGERS.flatMap((manager) => {
    const packages = new Set();
    const covered = [];
    for (const id of ids) {
      const names = PACKAGE_NAMES[id]?.[manager.id];
      if (!names) continue;
      covered.push(id);
      for (const name of names) packages.add(name);
    }
    if (!packages.size) return [];
    return [{
      manager: manager.id,
      label: manager.label,
      command: `${manager.prefix} ${[...packages].join(' ')}`,
      covered,
      uncovered: ids.filter((id) => !covered.includes(id)),
    }];
  });
}

module.exports = { linuxInstallCommands };
