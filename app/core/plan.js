'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resolveTool, installHint, venvPython, pythonExecutable } = require('./tools');
const { adapterIds, adapterProvides, describe: describeTool, supportedIds } = require('./runtime-install');
const { linuxInstallCommands } = require('./linux-install-guides');
const { isSafeScriptName, safeDirName } = require('./repo-url');
const { appRoot } = require('./paths');
const { checkDiskSpace } = require('./disk');
const { normalizeRemote, remoteOriginUrl } = require('./workspace');
const compatibilityEngine = require('./engine/compatibility');

/**
 * Turns a repository analysis into an ordered, reviewable installation plan.
 * Every step carries the exact command that will run, why it runs and how
 * risky it is. Nothing is executed here: the user approves each step first.
 */

const RISK = {
  low: { id: 'low', label: 'Low risk', detail: 'Read-only, or copying files.' },
  medium: { id: 'medium', label: 'Medium risk', detail: 'Downloads dependencies and may run project scripts.' },
  high: { id: 'high', label: 'High risk', detail: 'Runs the project code on your machine.' },
};

/** Which command answers to each runtime id, and which runtimes each stack needs. */
const COMMAND_FOR = { maven: 'mvn' };
const RUNTIME_FOR = {
  node: ['node', 'npm'],
  python: ['python'],
  go: ['go'],
  rust: ['cargo'],
  java: ['maven'],
  php: ['php', 'composer'],
  ruby: ['bundle'],
  dotnet: ['dotnet'],
  docker: ['docker'],
  make: ['make'],
};

function step(definition) {
  return {
    optional: false,
    autoApprovable: false,
    requires: [],
    notes: '',
    ...definition,
  };
}

function cloneStep({ repo, cloneUrl, dir, shallow }) {
  const tool = resolveTool('git');
  const args = ['clone'];
  if (shallow) args.push('--depth', '1');
  args.push(cloneUrl, dir);
  return step({
    id: 'clone',
    title: 'Clone the repository',
    purpose: 'Downloads the source code from GitHub into your workspace folder.',
    command: `git clone${shallow ? ' --depth 1' : ''} ${cloneUrl} ${dir}`,
    exec: { cmd: tool.cmd, args: tool.args.concat(args), shell: tool.shell === true },
    cwd: 'workspace',
    risk: 'low',
    autoApprovable: true,
    requires: ['git'],
    target: dir,
    cloneUrl,
    mode: 'clone',
  });
}

/**
 * A runtime GUITinstal can install for itself. It is a step like any other:
 * the human approves it, the run log keeps its output, and a bad checksum
 * shows up as a failed step instead of a silently broken tool.
 */
function prepareStep(id) {
  const info = describeTool(id) || {};
  return step({
    id: `prepare-${id}`,
    title: `Install ${info.label || id}`,
    purpose: 'GUITinstal downloads this tool from its official site and checks the expected SHA-256 before anything runs.',
    command: `GUITinstal runtime setup: ${info.label || id}`,
    exec: {
      cmd: process.execPath,
      args: [path.join(appRoot(), 'core', 'prepare-tool.js'), id],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
    },
    cwd: 'workspace',
    risk: 'medium',
    provides: id,
    notes: `${info.detail || ''} Download size: ${info.estimate || 'unknown'}. License: ${info.license || 'see the official site'}.`,
  });
}

function nodeSteps({ detection, dir }) {
  const steps = [];
  const npm = resolveTool('npm');
  const wanted = detection.packageManager || 'npm';
  const scripts = detection.scripts || {};
  const lockName = wanted === 'yarn' ? 'yarn.lock' : wanted === 'pnpm' ? 'pnpm-lock.yaml' : '';
  // Every command below prints "npm" because npm is what runs. yarn and pnpm
  // reach Windows as .cmd shims, and Node refuses to spawn those without a
  // shell, so labelling a step "yarn install" while npm executes it is a lie
  // the user cannot check.
  const installNotes = lockName
    ? `${lockName} is in this repository, but ${wanted} is not on this machine's PATH, so npm installs from package.json instead. Install ${wanted} first if the project needs its exact lockfile.`
    : "npm runs the project's own lifecycle scripts (postinstall).";
  const installArgs = detection.hasLock ? ['ci'] : ['install'];
  steps.push(
    step({
      id: 'install',
      title: 'Install dependencies',
      purpose: `Downloads the dependencies declared in package.json (${detection.dependencyCount || 0} in dependencies).`,
      command: `npm ${installArgs.join(' ')}`,
      exec: { cmd: npm.cmd, args: npm.args.concat(installArgs), shell: npm.shell === true },
      cwd: 'project',
      risk: 'medium',
      autoApprovable: false,
      requires: ['node', 'npm'],
      notes: installNotes,
    }),
  );

  if (isSafeScriptName(scripts.build)) {
    steps.push(
      step({
        id: 'build',
        title: 'Build the project',
        purpose: 'Runs the build script defined by the project.',
        command: 'npm run build',
        exec: { cmd: npm.cmd, args: npm.args.concat(['run', 'build']), shell: npm.shell === true },
        cwd: 'project',
        risk: 'medium',
        optional: true,
        requires: ['node', 'npm'],
      })
    );
  }

  // Only the script NAME reaches the command line, so only the name needs the
  // safe-token check. The body ("node ./bin/http-server --port 8080") is run by
  // npm itself; validating it as a name discarded every real start command.
  const launch = ['dev', 'start', 'serve', 'preview'].find(
    (name) => isSafeScriptName(name) && typeof scripts[name] === 'string' && scripts[name].trim().length,
  );
  if (launch) {
    const args = launch === 'start' ? ['start'] : ['run', launch];
    steps.push(
      step({
        id: 'launch',
        title: 'Start the project',
        purpose: `Starts the project development server (script "${launch}").`,
        command: `npm ${args.join(' ')}`,
        exec: { cmd: npm.cmd, args: npm.args.concat(args), shell: npm.shell === true },
        cwd: 'project',
        risk: 'high',
        optional: true,
        notes: 'This step leaves a server running. You can stop it later.',
      })
    );
  } else if (detection.entry) {
    steps.push(
      step({
        id: 'launch',
        title: 'Start the project',
        purpose: 'Runs the entry file detected in the repository.',
        command: `node ${detection.entry}`,
        exec: { cmd: resolveTool('node').cmd, args: resolveTool('node').args.concat([detection.entry]), shell: false },
        cwd: 'project',
        risk: 'high',
        optional: true,
      })
    );
  }

  return steps;
}

function pythonSteps({ detection, dir }) {
  const steps = [];
  const python = pythonExecutable();
  const venvDir = path.join(dir, '.venv');
  const venvPythonExe = venvPython(venvDir);

  if (!python) {
    return [
      step({
        id: 'install',
        title: 'Install dependencies',
        purpose: 'Requires Python installed and available on the PATH.',
        command: 'python -m venv .venv',
        exec: { cmd: 'python', args: [], shell: false },
        cwd: 'project',
        risk: 'medium',
        notes: 'Python was not found on this machine. Install Python 3.10+ and try again.',
      }),
    ];
  }

  // uv keeps its own lockfile and creates .venv itself, so the pip route is
  // not used for those projects: two dependency steps would disagree.
  if (detection.packageManager === 'uv') {
    const uv = resolveTool('uv');
    steps.push(
      step({
        id: 'install',
        title: 'Install dependencies with uv',
        purpose: 'Installs the exact versions recorded in uv.lock into the project .venv.',
        command: 'uv sync',
        exec: { cmd: uv.cmd, args: uv.args.concat(['sync']), shell: false },
        cwd: 'project',
        risk: 'medium',
        requires: ['uv'],
        notes: 'uv reads uv.lock and creates .venv inside the project folder, so the system Python is not touched.',
      })
    );
  } else {
  steps.push(
    step({
      id: 'venv',
      title: 'Create a virtual environment',
      purpose: 'Keeps the project dependencies inside .venv so the system Python stays clean.',
      command: 'python -m venv .venv',
      exec: { cmd: python, args: ['-m', 'venv', '.venv'], shell: false },
      cwd: 'project',
      risk: 'low',
      autoApprovable: true,
      requires: ['python'],
    })
  );

  const hasRequirements = detection.requirements && detection.requirements.length > 0;
  const installArgs = hasRequirements
    ? ['-m', 'pip', 'install', '-r', 'requirements.txt']
    : ['-m', 'pip', 'install', '-e', '.'];
  steps.push(
    step({
      id: 'install',
      title: 'Install dependencies',
      purpose: hasRequirements
        ? `Installs the ${detection.requirements.length} dependencies from requirements.txt into .venv.`
        : 'Installs the project itself in editable mode inside .venv.',
      command: `.venv/${path.sep === '\\' ? 'Scripts' : 'bin'}${path.sep}python -m pip install ${installArgs.slice(3).join(' ')}`,
      exec: { cmd: venvPythonExe, args: installArgs, shell: false },
      cwd: 'project',
      risk: 'medium',
      requires: ['python'],
      notes:
        'PyPI packages can run code while they install.' +
        (detection.packageManager === 'poetry' && resolveTool('poetry').missing
          ? ' This project uses Poetry, which is not installed here: the dependencies are installed from the project metadata with pip instead. Install Poetry from https://python-poetry.org/docs/#installation if the project needs its own lockfile.'
          : ''),
    })
  );
  }

  const frameworks = detection.frameworks || [];
  let launch = null;
  if (frameworks.includes('django')) {
    launch = { args: ['manage.py', 'runserver'], command: 'python manage.py runserver' };
  } else if (frameworks.includes('streamlit')) {
    launch = { args: ['-m', 'streamlit', 'run', detection.entry || 'app.py'], command: `python -m streamlit run ${detection.entry || 'app.py'}` };
  } else if (frameworks.includes('uvicorn') || frameworks.includes('fastapi')) {
    launch = { args: ['-m', 'uvicorn', 'main:app', '--reload'], command: 'python -m uvicorn main:app --reload' };
  } else if (frameworks.includes('flask')) {
    launch = { args: ['-m', 'flask', 'run'], command: 'python -m flask run' };
  } else if (detection.entry) {
    launch = { args: [detection.entry], command: `python ${detection.entry}` };
  }

  if (launch) {
    steps.push(
      step({
        id: 'launch',
        title: 'Start the project',
        purpose: 'Starts the project application with the virtual environment interpreter.',
        command: `.venv/${path.sep === '\\' ? 'Scripts' : 'bin'}${path.sep}python ${launch.command.replace('python ', '')}`,
        exec: { cmd: venvPythonExe, args: launch.args, shell: false },
        cwd: 'project',
        risk: 'high',
        optional: true,
      })
    );
  }

  return steps;
}

function dockerSteps({ detection, repo, dir }) {
  const docker = resolveTool('docker');
  const steps = [];
  const imageName = safeDirName(repo).toLowerCase();

  if (detection.compose) {
    steps.push(
      step({
        id: 'build',
        title: 'Build the images',
        purpose: 'Builds the images defined in the compose file.',
        command: 'docker compose build',
        exec: { cmd: docker.cmd, args: docker.args.concat(['compose', 'build']), shell: docker.shell === true },
        cwd: 'project',
        risk: 'medium',
        optional: true,
        requires: ['docker'],
      })
    );
    steps.push(
      step({
        id: 'launch',
        title: 'Start the containers',
        purpose: 'Starts the project services in the background.',
        command: 'docker compose up -d',
        exec: { cmd: docker.cmd, args: docker.args.concat(['compose', 'up', '-d']), shell: docker.shell === true },
        cwd: 'project',
        risk: 'high',
        optional: true,
        requires: ['docker'],
      })
    );
  } else {
    steps.push(
      step({
        id: 'build',
        title: 'Build the image',
        purpose: 'Builds the project Docker image from the Dockerfile.',
        command: `docker build -t ${imageName} .`,
        exec: { cmd: docker.cmd, args: docker.args.concat(['build', '-t', imageName, '.']), shell: docker.shell === true },
        cwd: 'project',
        risk: 'medium',
        requires: ['docker'],
      })
    );
    steps.push(
      step({
        id: 'launch',
        title: 'Start the container',
        purpose: 'Runs the image built for the project.',
        command: `docker run --rm -it ${imageName}`,
        exec: { cmd: docker.cmd, args: docker.args.concat(['run', '--rm', '-it', imageName]), shell: docker.shell === true },
        cwd: 'project',
        risk: 'high',
        optional: true,
        requires: ['docker'],
      })
    );
  }

  return steps;
}

function goSteps({ detection }) {
  const go = resolveTool('go');
  return [
    step({
      id: 'install',
      title: 'Download dependencies',
      purpose: 'Downloads the modules declared in go.mod.',
      command: 'go mod download',
      exec: { cmd: go.cmd, args: go.args.concat(['mod', 'download']), shell: go.shell === true },
      cwd: 'project',
      risk: 'low',
      autoApprovable: true,
      requires: ['go'],
    }),
    step({
      id: 'build',
      title: 'Build the project',
      purpose: 'Compiles the project Go code.',
      command: 'go build ./...',
      exec: { cmd: go.cmd, args: go.args.concat(['build', './...']), shell: go.shell === true },
      cwd: 'project',
      risk: 'medium',
      optional: true,
      requires: ['go'],
    }),
    step({
      id: 'launch',
      title: 'Start the project',
      purpose: 'Runs the Go project in development mode.',
      command: 'go run .',
      exec: { cmd: go.cmd, args: go.args.concat(['run', '.']), shell: go.shell === true },
      cwd: 'project',
      risk: 'high',
      optional: true,
      requires: ['go'],
    }),
  ];
}

function rustSteps() {
  const cargo = resolveTool('cargo');
  return [
    step({
      id: 'build',
      title: 'Build the project',
      purpose: 'Compiles the Rust project with Cargo.',
      command: 'cargo build',
      exec: { cmd: cargo.cmd, args: cargo.args.concat(['build']), shell: cargo.shell === true },
      cwd: 'project',
      risk: 'medium',
      requires: ['cargo'],
    }),
    step({
      id: 'launch',
      title: 'Start the project',
      purpose:
        'Runs one binary with cargo run. A workspace with several binaries needs the name of one, so GUITinstal never picks for you: approve this step yourself, or run the binary in the Terminal.',
      command: 'cargo run',
      exec: { cmd: cargo.cmd, args: cargo.args.concat(['run']), shell: cargo.shell === true },
      cwd: 'project',
      risk: 'high',
      optional: true,
      requires: ['cargo'],
    }),
  ];
}

function javaSteps({ detection }) {
  const maven = resolveTool('maven');
  const steps = [];
  if (detection.runtime === 'maven' || detection.markers.includes('pom.xml')) {
    steps.push(
      step({
        id: 'build',
        title: 'Build the project',
        purpose: 'Compiles the Java project with Maven.',
        command: 'mvn -B package',
        exec: { cmd: maven.cmd, args: maven.args.concat(['-B', 'package']), shell: maven.shell === true },
        cwd: 'project',
        risk: 'medium',
        optional: true,
      })
    );
    if (detection.framework === 'spring') {
      steps.push(
        step({
          id: 'launch',
          title: 'Start the project',
          purpose: 'Starts the Spring Boot application.',
          command: 'mvn -B spring-boot:run',
          exec: { cmd: maven.cmd, args: maven.args.concat(['-B', 'spring-boot:run']), shell: maven.shell === true },
          cwd: 'project',
          risk: 'high',
          optional: true,
        })
      );
    } else if (detection.artifact) {
      steps.push(
        step({
          id: 'launch',
          title: 'Start the project',
          purpose: 'Runs the jar generated in the target folder.',
          command: `java -jar target/${detection.artifact}.jar`,
          exec: { cmd: resolveTool('java').cmd, args: resolveTool('java').args.concat(['-jar', `target/${detection.artifact}.jar`]), shell: false },
          cwd: 'project',
          risk: 'high',
          optional: true,
        })
      );
    }
  }
  return steps;
}

function phpSteps({ detection }) {
  const php = resolveTool('php');
  const composer = resolveTool('composer');
  const laravel = Boolean(detection.laravel);
  const steps = [
    step({
      id: 'install',
      title: 'Install dependencies',
      purpose: 'Downloads the dependencies declared in composer.json.',
      command: 'composer install --no-interaction',
      exec: { cmd: composer.cmd, args: composer.args.concat(['install', '--no-interaction']), shell: composer.shell === true },
      cwd: 'project',
      risk: 'medium',
      requires: ['php', 'composer'],
      notes: laravel
        ? 'Laravel is detected. After Composer finishes, GUITinstal creates .env, generates APP_KEY, creates the SQLite database and runs the migrations before starting the server.'
        : '',
    }),
  ];

  if (laravel) {
    steps.push(
      step({
        id: 'configure',
        title: 'Configure the environment',
        purpose: 'Creates .env from .env.example and a local SQLite database when they do not exist.',
        command: `php -r "file_exists('.env') || copy('.env.example', '.env'); file_exists('database/database.sqlite') || touch('database/database.sqlite');"`,
        exec: {
          cmd: php.cmd,
          args: php.args.concat([
            '-r',
            "file_exists('.env') || copy('.env.example', '.env'); file_exists('database/database.sqlite') || touch('database/database.sqlite');",
          ]),
          shell: false,
        },
        cwd: 'project',
        risk: 'low',
        autoApprovable: true,
        requires: ['php'],
        notes: 'An existing .env or database file is never overwritten.',
      }),
      step({
        id: 'configure-key',
        title: 'Generate the application key',
        purpose: 'Writes the APP_KEY Laravel needs to encrypt sessions and cookies.',
        command: 'php artisan key:generate --force',
        exec: { cmd: php.cmd, args: php.args.concat(['artisan', 'key:generate', '--force']), shell: false },
        cwd: 'project',
        risk: 'low',
        requires: ['php'],
      }),
      step({
        id: 'migrate',
        title: 'Create the database tables',
        purpose: 'Runs the migrations that create the tables Laravel uses for sessions, cache and queues.',
        command: 'php artisan migrate --force',
        exec: { cmd: php.cmd, args: php.args.concat(['artisan', 'migrate', '--force']), shell: false },
        cwd: 'project',
        risk: 'medium',
        requires: ['php'],
      }),
    );
  }

  const docroot = detection.entry && detection.entry.startsWith('public/') ? 'public' : '.';
  steps.push(
    step({
      id: 'launch',
      title: 'Start the project',
      purpose: laravel
        ? 'Starts the Laravel development server on this machine.'
        : 'Starts the built-in PHP server for this project.',
      command: laravel ? 'php artisan serve --host=127.0.0.1 --port=8000' : `php -S 127.0.0.1:8000 -t ${docroot}`,
      exec: {
        cmd: php.cmd,
        args: php.args.concat(
          laravel ? ['artisan', 'serve', '--host=127.0.0.1', '--port=8000'] : ['-S', '127.0.0.1:8000', '-t', docroot]
        ),
        shell: false,
      },
      cwd: 'project',
      risk: 'high',
      optional: true,
      requires: ['php'],
      notes: laravel
        ? 'Laravel serves through artisan, which routes requests to public/index.php.'
        : 'Open http://127.0.0.1:8000/ after the server starts.',
    })
  );

  return steps;
}

function rubySteps({ detection }) {
  const bundle = resolveTool('bundle');
  const steps = [
    step({
      id: 'install',
      title: 'Install dependencies',
      purpose: 'Downloads the gems declared in the Gemfile.',
      command: 'bundle install',
      exec: { cmd: bundle.cmd, args: bundle.args.concat(['install']), shell: bundle.shell === true },
      cwd: 'project',
      risk: 'medium',
      requires: ['bundle'],
    }),
  ];
  if (detection.rails) {
    steps.push(
      step({
        id: 'launch',
        title: 'Start the project',
        purpose: 'Starts the Rails server.',
        command: 'bundle exec rails server',
        exec: { cmd: bundle.cmd, args: bundle.args.concat(['exec', 'rails', 'server']), shell: bundle.shell === true },
        cwd: 'project',
        risk: 'high',
        optional: true,
      })
    );
  }
  return steps;
}

const BUILD_TOOLS_URL = 'https://visualstudio.microsoft.com/downloads/';

/**
 * Old-style .NET Framework projects (packages.config) cannot be installed with
 * the dotnet CLI: "dotnet restore" says "Nothing to do" and the build then
 * stops with "Enable NuGet Package Restore". Those need MSBuild or nuget.exe,
 * which come from Visual Studio Build Tools, not from the .NET SDK.
 */
function legacyDotnetSteps({ target }) {
  const nuget = resolveTool('nuget');
  const msbuild = resolveTool('msbuild');
  const note = `This is an old-style .NET Framework project (packages.config), so "dotnet restore" cannot fetch its packages. ${
    msbuild.missing && nuget.missing
      ? `It needs MSBuild or nuget.exe from Build Tools for Visual Studio (the ".NET desktop development" workload) at ${BUILD_TOOLS_URL}. Install that, press "Re-check tools", then Try again.`
      : 'GUITinstal uses the build tools already on this machine.'
  }`;

  if (!nuget.missing) {
    return [
      step({
        id: 'install',
        title: 'Restore packages',
        purpose: 'Downloads the NuGet packages listed in packages.config.',
        command: `nuget restore${target ? ` ${target}` : ''}`,
        exec: { cmd: nuget.cmd, args: nuget.args.concat(['restore', ...(target ? [target] : [])]), shell: nuget.shell === true },
        cwd: 'project',
        risk: 'low',
        autoApprovable: true,
        notes: note,
      }),
      step({
        id: 'build',
        title: 'Build the project',
        purpose: 'Compiles the project with MSBuild.',
        command: `msbuild${target ? ` ${target}` : ''}`,
        exec: { cmd: msbuild.cmd, args: msbuild.args.concat([...(target ? [target] : [])]), shell: msbuild.shell === true },
        cwd: 'project',
        risk: 'medium',
        optional: true,
      }),
      desktopLaunchStep(),
    ];
  }

  return [
    step({
      id: 'install',
      title: 'Restore packages',
      purpose: 'Runs the MSBuild restore target that packages.config projects need.',
      command: `msbuild${target ? ` ${target}` : ''} -t:restore`,
      exec: { cmd: msbuild.cmd, args: msbuild.args.concat([...(target ? [target] : []), '-t:restore']), shell: msbuild.shell === true },
      cwd: 'project',
      risk: 'low',
      autoApprovable: true,
      notes: note,
    }),
    step({
      id: 'build',
      title: 'Build the project',
      purpose: 'Compiles the project with MSBuild.',
      command: `msbuild${target ? ` ${target}` : ''}`,
      exec: { cmd: msbuild.cmd, args: msbuild.args.concat([...(target ? [target] : [])]), shell: msbuild.shell === true },
      cwd: 'project',
      risk: 'medium',
      optional: true,
    }),
    desktopLaunchStep(),
  ];
}

function desktopLaunchStep() {
  return step({
    id: 'launch',
    title: 'Start the project',
    purpose: 'This kind of project starts as a desktop program, not as a command.',
    command: '—',
    exec: null,
    cwd: 'project',
    risk: 'high',
    optional: true,
    notes:
      'MSBuild writes an .exe into bin\\Debug (or bin\\Release) inside the project folder. Open that file to start the program: GUITinstal runs projects that start from a command line, and launching a Windows desktop application is not supported yet.',
  });
}

function dotnetSteps({ detection }) {
  const dotnet = resolveTool('dotnet');
  // Only a project file in a subfolder needs to be named: when it sits at the
  // root, dotnet finds it on its own.
  const target = detection.projectFile || '';
  if (detection.packagesConfig) return legacyDotnetSteps({ target });
  const steps = [
    step({
      id: 'install',
      title: 'Restore packages',
      purpose: 'Restores the project NuGet packages.',
      command: `dotnet restore${target ? ` ${target}` : ''}`,
      exec: { cmd: dotnet.cmd, args: dotnet.args.concat(['restore', ...(target ? [target] : [])]), shell: dotnet.shell === true },
      cwd: 'project',
      risk: 'low',
      autoApprovable: true,
      requires: ['dotnet'],
    }),
    step({
      id: 'build',
      title: 'Build the project',
      purpose: 'Compiles the project solution.',
      command: `dotnet build${target ? ` ${target}` : ''}`,
      exec: { cmd: dotnet.cmd, args: dotnet.args.concat(['build', ...(target ? [target] : [])]), shell: dotnet.shell === true },
      cwd: 'project',
      risk: 'medium',
      optional: true,
      requires: ['dotnet'],
    }),
    step({
      id: 'launch',
      title: 'Start the project',
      purpose: 'Runs the project application.',
      command: target ? `dotnet run --project ${target}` : 'dotnet run',
      exec: { cmd: dotnet.cmd, args: dotnet.args.concat(target ? ['run', '--project', target] : ['run']), shell: dotnet.shell === true },
      cwd: 'project',
      risk: 'high',
      optional: true,
      requires: ['dotnet'],
    }),
  ];
  return steps;
}

function makeSteps() {
  const make = resolveTool('make');
  return [
    step({
      id: 'build',
      title: 'Build the project',
      purpose: 'Runs the default Makefile target.',
      command: 'make',
      exec: { cmd: make.cmd, args: make.args.concat([]), shell: make.shell === true },
      cwd: 'project',
      risk: 'medium',
      optional: true,
      requires: ['make'],
    }),
  ];
}

const BUILDERS = {
  node: nodeSteps,
  python: pythonSteps,
  docker: dockerSteps,
  go: goSteps,
  rust: rustSteps,
  java: javaSteps,
  php: phpSteps,
  ruby: rubySteps,
  dotnet: dotnetSteps,
  make: makeSteps,
};

/**
 * GitHub reports one "language" for a repository; that is the only evidence a
 * browse card has before cloning, so compatibility is stated as a language
 * match against BUILDERS and never as a promise that the install will work.
 */
const LANGUAGE_STACK = {
  JavaScript: 'node',
  TypeScript: 'node',
  Vue: 'node',
  Svelte: 'node',
  Astro: 'node',
  Python: 'python',
  Go: 'go',
  Rust: 'rust',
  Java: 'java',
  PHP: 'php',
  Ruby: 'ruby',
  'C#': 'dotnet',
  Shell: 'make',
  Makefile: 'make',
  Dockerfile: 'docker',
};

function stackForLanguage(language) {
  const name = String(language || '').trim();
  return LANGUAGE_STACK[name] || null;
}

/**
 * The clone step runs only when the target folder is free. When the project
 * is already there, the plan syncs it instead of failing on a dirty folder.
 *
 * Two repositories can share a name (owner/a and owner-b/a both called "a"), and
 * the workspace is flat, so "the folder exists" is not proof that it holds THIS
 * project. The remote recorded in .git/config decides.
 */
function sourceStep({ repo, cloneUrl, dir, shallow }) {
  if (!fs.existsSync(dir)) {
    return cloneStep({ repo, cloneUrl, dir, shallow });
  }

  if (fs.existsSync(path.join(dir, '.git'))) {
    const origin = normalizeRemote(remoteOriginUrl(dir));
    const wanted = normalizeRemote(cloneUrl);
    if (!origin) {
      throw new Error(`${dir} is a Git repository without an "origin" remote, so GUITinstal cannot confirm it holds ${repo.fullName}. Rename the folder or change the workspace.`);
    }
    if (origin !== wanted) {
      throw new Error(`${dir} already holds a different repository (${origin.replace(/^https?:\/\/[^/]+\//, '')}). Rename that folder or choose another workspace before installing ${repo.fullName}.`);
    }
    const tool = resolveTool('git');
    return step({
      id: 'clone',
      title: 'Update the existing repository',
      purpose: 'This folder already holds the project. Instead of cloning again, it fetches the latest changes.',
      command: 'git pull --ff-only',
      exec: { cmd: tool.cmd, args: tool.args.concat(['pull', '--ff-only']), shell: tool.shell === true },
      cwd: 'project',
      risk: 'low',
      autoApprovable: true,
      requires: ['git'],
      notes: `Folder already exists: ${dir}`,
      target: dir,
      cloneUrl,
      mode: 'pull',
    });
  }

  const clone = cloneStep({ repo, cloneUrl, dir, shallow });
  clone.notes = `The folder ${dir} already exists and is not a Git repository. Move or rename it so the clone can run.`;
  return clone;
}

function folderIsEmpty(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/**
 * Re-reads the folder at the moment the clone is about to run.
 *
 * A plan is built when the link is pasted, and "Try again" or a second
 * "Approve all" reuses that same plan: without this check the retry runs
 * `git clone` into the folder the first attempt already filled, and git stops
 * with exit 128 — a dead end for a project that is already on disk.
 *
 * @returns {null|{status: string, notes?: string, error?: string}} what the step should do instead
 */
function recheckCloneStep(step) {
  if (step.id !== 'clone' || !step.target) return null;
  const dir = step.target;

  if (step.mode === 'pull') {
    if (fs.existsSync(dir)) return null;
    return {
      status: 'failed',
      error: `The folder ${dir} is no longer on disk, so there is nothing to update. Run the analysis again and GUITinstal will clone it.`,
    };
  }

  if (!fs.existsSync(dir)) return null;

  if (fs.existsSync(path.join(dir, '.git'))) {
    const origin = normalizeRemote(remoteOriginUrl(dir));
    const wanted = normalizeRemote(step.cloneUrl || '');
    if (origin && wanted && origin !== wanted) {
      return {
        status: 'failed',
        error: `${dir} already holds a different repository (${origin.replace(/^https?:\/\/[^/]+\//, '')}). Rename that folder or choose another workspace before installing this one.`,
      };
    }
    return {
      status: 'done',
      notes: `Already cloned in ${dir}, so nothing was downloaded again. The steps below continue from the files on disk.`,
    };
  }

  if (folderIsEmpty(dir)) return null;

  return {
    status: 'failed',
    error: `The folder ${dir} already exists and is not a Git repository, so GUITinstal will not clone into it. Move or rename that folder, then press Try again.`,
  };
}

/**
 * @param {object} options
 * @param {object} options.repo metadata from GitHub
 * @param {object} options.detection output of detectStack
 * @param {object} options.settings app settings
 * @param {Array<{id: string, available: boolean}>} options.runtimes what this machine has
 */
function projectKind(primary) {
  if (!primary) return 'unsupported';
  if (primary.stack === 'xcode') return 'ios-app';
  if (primary.stack === 'node') {
    if (primary.hasBin) return 'cli';
    if (primary.scripts?.dev || primary.scripts?.serve || primary.scripts?.preview) return 'web-service';
    return primary.scripts?.start || primary.entry ? 'app' : 'library';
  }
  if (primary.stack === 'python') {
    if (primary.frameworks?.some((name) => ['django', 'streamlit', 'fastapi', 'uvicorn', 'flask'].includes(name))) {
      return 'web-service';
    }
    return primary.entry ? 'app' : 'library';
  }
  if (primary.stack === 'docker') return primary.compose ? 'web-service' : 'app';
  if (['php', 'ruby'].includes(primary.stack)) return 'web-service';
  if (primary.stack === 'java' && primary.framework === 'spring') return 'web-service';
  if (['go', 'rust'].includes(primary.stack) && !primary.entry) return 'library';
  return 'app';
}

/**
 * The package manager a project actually uses, which is the one the engine
 * asks about. A manager with no adapter is still reported as used, but the
 * plan falls back to the one that is installed instead of refusing to install.
 */
function packageManagerFor(primary) {
  if (!primary) return '';
  if (primary.stack === 'node') return primary.packageManager || 'npm';
  if (primary.stack === 'python') return primary.packageManager || 'pip';
  if (primary.stack === 'java') return (primary.runtimes || []).includes('gradle') ? 'gradle' : 'maven';
  if (primary.stack === 'rust') return 'cargo';
  return '';
}

function buildPlan({ repo, detection, settings, runtimes = [] }) {
  const dirName = safeDirName(repo.name);
  const dir = path.join(settings.workspace, dirName);
  const steps = [sourceStep({ repo, cloneUrl: repo.cloneUrl, dir, shallow: settings.shallowClone })];

  const primary = detection.primary;
  const xcodeProjectFile =
    detection.all?.find((item) => item.stack === 'xcode')?.projectFile ||
    (primary?.stack === 'xcode' ? primary.projectFile : '');
  if (primary) {
    const builder = BUILDERS[primary.stack];
    if (builder) {
      try {
        steps.push(...builder({ detection: primary, dir, repo: repo.name }));
      } catch {
        /* a broken builder must not break the plan */
      }
    }
  } else {
    steps.push(
      step({
        id: 'install',
        title: 'No stack detected',
        purpose: 'This repository has no known project manifest (package.json, requirements.txt, go.mod...).',
        command: '—',
        exec: null,
        cwd: 'project',
        risk: 'low',
        optional: true,
        notes: 'You can open the project folder and run the commands yourself.',
      })
    );
  }

  const runtimeIds = new Set(primary?.runtimes || []);
  const requiredRuntimes = steps.flatMap((item) => item.requires || []);
  const disk = checkDiskSpace(settings.workspace);

  const installed = new Set(runtimes.filter((item) => item.available).map((item) => item.id));
  // Without an explicit runtime list (tools that build plans offline) fall
  // back to looking the command up on PATH.
  const hasRuntime = (id) =>
    runtimes.length ? installed.has(id) : !resolveTool(COMMAND_FOR[id] || id).missing;

  // The compatibility engine decides what this plan may offer. It is fed the
  // adapters that really exist in this build, so a runtime only becomes a
  // prepare step when there is code behind the promise to install it.
  const adapters = adapterIds();
  const requestedManager = packageManagerFor(primary);
  const managerUsable = Boolean(
    requestedManager && (installed.has(requestedManager) || adapters.includes(requestedManager))
  );
  // npm can install a pnpm or Yarn project from package.json, and pip can
  // install a Poetry metadata project, so those absences are a note. Maven and
  // Gradle have no fallback: dropping them would hide a missing build tool, so
  // their absence has to reach the compatibility verdict.
  const substitutable = ['node', 'python'].includes(primary?.stack);
  const managerForCheck = substitutable && !managerUsable ? '' : requestedManager;
  const compatibility = runtimes.length
    ? compatibilityEngine.forProject({
        stack: primary?.stack || '',
        packageManager: managerForCheck,
        available: [...installed],
        adapters,
      })
    : {
        stack: primary?.stack || '',
        known: Boolean(primary),
        verdict: 'unknown',
        summary: 'This plan was rebuilt from the folder on disk, so its runtimes were checked when it was installed.',
        platform: process.platform,
        runtimes: [],
        requirements: [],
        missing: [],
        prepare: [],
        guide: [],
        blocked: [],
        reasons: [],
      };

  // A missing tool is only a dead end when the user cannot act on it, so the
  // plan carries where each one comes from.
  //
  // git is required by the clone step, not by the stack definition, so the
  // compatibility engine never lists it. Without it here a machine that has
  // never installed Git gets a clone step that cannot run — the exact case the
  // portable MinGit adapter exists for.
  const missingRuntimes = compatibility.known
    ? compatibility.missing.slice()
    : [...new Set(requiredRuntimes.filter((id) => !hasRuntime(id)))];
  if (requiredRuntimes.includes('git') && !hasRuntime('git') && !missingRuntimes.includes('git')) {
    missingRuntimes.unshift('git');
  }
  const installGuides = missingRuntimes.map((id) => {
    const hint = installHint(id);
    return { id, ...hint };
  });
  // Tools GUITinstal can fetch and verify itself become real steps, so they
  // inherit the approval gate, the log and the retry instead of being a link
  // the user has to chase by hand.
  // Anything missing that this build has an adapter for becomes a step, even
  // when the stack definition did not mention it — git is the case: only the
  // clone step asks for it.
  const selfInstallable = compatibility.known ? compatibility.prepare.slice() : [];
  for (const id of missingRuntimes) {
    if (adapters.includes(id) && !selfInstallable.includes(id)) selfInstallable.push(id);
  }
  const prepared = new Set();
  for (const id of selfInstallable) {
    if (prepared.has(id)) continue;
    prepared.add(id);
    // An adapter can satisfy a different catalog id than its own: rustup
    // installs the cargo a Rust build asks for. Matching only the adapter id
    // pushed the setup step to the end of the plan, so "cargo build" ran first
    // and failed with "Rust is not installed" on a machine the app could have
    // fixed by itself. Every id this adapter satisfies counts as a match.
    const covers = [id, ...(adapterProvides(id) || [])];
    const at = steps.findIndex((item) => (item.requires || []).some((needed) => covers.includes(needed)));
    steps.splice(at < 0 ? steps.length : at, 0, prepareStep(id));
  }
  const cannotInstall = missingRuntimes.filter((id) => !adapters.includes(id) && !selfInstallable.includes(id));

  // A step that needs a runtime this platform cannot run is refused, not
  // attempted: the interface must never show a working Install button for it.
  const blockedIds = new Set((compatibility.blocked || []).map((item) => item.id));
  for (const item of steps) {
    const blockedBy = (item.requires || []).filter((id) => blockedIds.has(id));
    if (!blockedBy.length) continue;
    item.blocked = true;
    item.blockedBy = blockedBy;
    item.notes = [item.notes, `Blocked: ${blockedBy.join(', ')} has no build for this platform.`]
      .filter(Boolean)
      .join(' ');
  }

  const warnings = [];
  if (!primary) {
    warnings.push('Automatic dependency setup is unavailable for this repository. You can clone it and follow its documentation manually.');
  }
  if (selfInstallable.length) {
    warnings.push(
      `Not installed here: ${selfInstallable.join(', ')}. GUITinstal adds a setup step for each one, downloads it from the official site, checks the expected SHA-256, and only then runs the project's own commands.`
    );
  }
  if (cannotInstall.length) {
    const guided = compatibility.known
      ? (compatibility.guide || [])
          .filter((item) => cannotInstall.includes(item.id))
          .map((item) => `${item.label}: ${item.url}`)
      : [];
    const pages = guided.length
      ? guided
      : installGuides.filter((guide) => cannotInstall.includes(guide.id)).map((guide) => guide.url).filter(Boolean);
    warnings.push(
      `Not installed on this machine: ${cannotInstall.join(', ')}. The steps that need them stop until they are installed. ` +
        (pages.length ? `Install them from ${pages.join(' ')}. ` : '') +
        'Then press "Re-check tools": GUITinstal scans the current PATH again and finds the tool without a restart.'
    );
  }
  for (const reason of compatibility.reasons || []) {
    if (!warnings.includes(reason)) warnings.push(reason);
  }
  if (primary) {
    for (const item of detection.secondary || []) {
      if (item.stack === 'xcode') {
        warnings.push('This repository also contains an Apple project. Open it in Xcode on a Mac; GUITinstal does not build or sign iOS apps automatically.');
        continue;
      }
      const needed = RUNTIME_FOR[item.stack] || [];
      const absent = needed.filter((id) => !hasRuntime(id));
      warnings.push(
        absent.length
          ? `This repository also holds ${item.label} code. ${absent.join(', ')} is not installed here, so that part is outside this plan.`
          : `This repository also holds ${item.label} code. This plan only installs the ${primary.label} part.`
      );
    }
  }

  return {
    id: `plan-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    preflight: {
      disk,
      missingRuntimes,
      installGuides,
      linuxInstallCommands: process.platform === 'linux' ? linuxInstallCommands(cannotInstall) : [],
      warnings,
      compatibility: {
        verdict: compatibility.verdict,
        summary: compatibility.summary,
        prepare: compatibility.prepare || [],
        guide: compatibility.guide || [],
        blocked: compatibility.blocked || [],
      },
    },
    // The verdict the interface and the run engine honour: a blocked project
    // is explained, not attempted.
    compatibility,
    blocked: compatibility.verdict === 'blocked',
    repo: {
      owner: repo.owner,
      name: repo.name,
      fullName: repo.fullName,
      url: repo.url,
      cloneUrl: repo.cloneUrl,
      description: repo.description,
      stars: repo.stars,
      forks: repo.forks,
      license: repo.license,
      language: repo.language,
      defaultBranch: repo.defaultBranch,
      ownerAvatar: repo.ownerAvatar || '',
      pushedAt: repo.pushedAt || '',
    },
    stack: primary
      ? { id: primary.stack, label: primary.label, confidence: primary.confidence, markers: primary.markers }
      : { id: 'unknown', label: 'Generic project', confidence: 'low', markers: [] },
    xcodeProjectFile,
    directory: dir,
    kind: projectKind(primary),
    steps: steps.map((item, index) => ({
      ...item,
      index,
      risk: typeof item.risk === 'string' ? RISK[item.risk] : item.risk,
      status: 'pending',
    })),
    requiredRuntimes: [...new Set(requiredRuntimes)],
    suggestedRuntimes: [...runtimeIds],
    summary: {
      total: steps.length,
      optional: steps.filter((item) => item.optional).length,
      highestRisk: steps.reduce((acc, item) => {
        const rank = { low: 1, medium: 2, high: 3 };
        return rank[item.risk.id] > rank[acc] ? item.risk.id : acc;
      }, 'low'),
    },
  };
}

/**
 * A plan whose only job is to put one tool on this machine. It goes through
 * the same run engine as a repository: approval gate, step log, checksum
 * failure as a failed step. The UI reaches it from a "missing" chip.
 */
function runtimePlan(id) {
  const info = describeTool(id) || {};
  const steps = [prepareStep(id)].map((item, index) => ({
    ...item,
    index,
    risk: RISK[item.risk] || item.risk,
    status: 'pending',
  }));
  return {
    id: `plan-runtime-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    kind: 'runtime',
    // No repository and no project folder: the step only needs the workspace
    // to exist, which the run engine creates.
    directory: '',
    kind: 'runtime',
    repo: {
      owner: '',
      name: id,
      fullName: `GUITinstal · ${info.label || id}`,
      url: '',
      cloneUrl: '',
      description: info.detail || '',
      stars: 0,
      forks: 0,
      license: info.license || '',
      language: '',
      defaultBranch: '',
      ownerAvatar: '',
      pushedAt: '',
    },
    stack: { id: 'runtime', label: info.label || id, confidence: 'high', markers: [] },
    steps,
    requiredRuntimes: [id],
    suggestedRuntimes: [id],
    preflight: { disk: null, missingRuntimes: [id], installGuides: [], warnings: [] },
    summary: { total: steps.length, optional: 0, highestRisk: 'medium' },
  };
}

module.exports = { buildPlan, recheckCloneStep, runtimePlan, stackForLanguage, RISK };
