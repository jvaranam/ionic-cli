import * as util from 'util';
import * as path from 'path';

import { isCI } from 'ci-info';
import * as chalk from 'chalk';
import * as minimist from 'minimist';

import * as inquirerType from 'inquirer';

import {
  ConfigFile,
  IClient,
  IConfig,
  IHookEngine,
  IProject,
  ISession,
  IonicEnvironment,
  LogLevel,
  RootPlugin,
} from './definitions';

import { LOG_LEVELS, isLogLevel } from './guards';

import { BACKEND_LEGACY, BACKEND_PRO } from './lib/backends';
import { CONFIG_DIRECTORY, CONFIG_FILE, Config, gatherFlags } from './lib/config';
import { DAEMON_JSON_FILE, Daemon } from './lib/daemon';
import { Client } from './lib/http';
import { CLIEventEmitter } from './lib/events';
import { Environment } from './lib/environment';
import { HookEngine } from './lib/hooks';
import { PROJECT_FILE, PROJECT_FILE_LEGACY, Project } from './lib/project';
import { Logger } from './lib/utils/logger';
import { findBaseDirectory } from './lib/utils/fs';
import { InteractiveTaskChain, TaskChain } from './lib/utils/task';
import { Telemetry } from './lib/telemetry';
import { CloudSession, ProSession } from './lib/session';
import { Shell } from './lib/shell';
import { createPromptModule } from './lib/prompts';

export * from './definitions';
export * from './guards';

export * from './lib/app';
export * from './lib/backends';
export * from './lib/command';
export * from './lib/command/command';
export * from './lib/command/namespace';
export * from './lib/command/utils';
export * from './lib/config';
export * from './lib/daemon';
export * from './lib/deploy';
export * from './lib/errors';
export * from './lib/events';
export * from './lib/help';
export * from './lib/hooks';
export * from './lib/http';
export * from './lib/login';
export * from './lib/package';
export * from './lib/plugins';
export * from './lib/project';
export * from './lib/prompts';
export * from './lib/security';
export * from './lib/session';
export * from './lib/shell';
export * from './lib/telemetry';
export * from './lib/utils/archive';
export * from './lib/utils/array';
export * from './lib/utils/environmentInfo';
export * from './lib/utils/format';
export * from './lib/utils/fs';
export * from './lib/utils/logger';
export * from './lib/utils/network';
export * from './lib/utils/npm';
export * from './lib/utils/promise';
export * from './lib/utils/string';
export * from './lib/utils/task';
export * from './lib/validators';

export const name = '__NAME__';
export const version = '__VERSION__';

export function registerHooks(hooks: IHookEngine) {
  hooks.register(name, 'command:info', async () => {
    return [
      { type: 'cli-packages', name, version, path: path.dirname(__filename) },
    ];
  });

  hooks.register(name, 'command:config:set', async ({ env, inputs, options, valueChanged }) => {
    let [ p ] = inputs;
    const { global } = options;

    if (global && p === 'backend' && valueChanged) {
      await hooks.fire('backend:changed', { env });
    }
  });

  hooks.register(name, 'backend:changed', async ({ env }) => {
    const config = await env.config.load();

    if (config.backend === BACKEND_PRO) {
      config.urls.api = 'https://api.ionicjs.com';
      config.urls.dash = 'https://dashboard.ionicjs.com';
    } else if (config.backend === BACKEND_LEGACY) {
      config.urls.api = 'https://api.ionic.io';
      config.urls.dash = 'https://apps.ionic.io';
    }

    const wasLoggedIn = await env.session.isLoggedIn();
    await env.session.logout();

    env.client.host = config.urls.api;
    env.session = await getSession(env.config, env.project, env.client);

    if (wasLoggedIn) {
      env.log.info('You have been logged out.');
    }
  });
}

async function getSession(config: IConfig<ConfigFile>, project: IProject, client: IClient): Promise<ISession> {
  const configData = await config.load();
  return configData.backend === BACKEND_LEGACY ? new CloudSession(config, project, client) : new ProSession(config, project, client);
}

export async function generateIonicEnvironment(plugin: RootPlugin, pargv: string[], env: { [key: string]: string }): Promise<IonicEnvironment> {
  const cwd = process.cwd();
  const argv = minimist(pargv, { boolean: true, string: '_' });
  const config = new Config(env['IONIC_CONFIG_DIRECTORY'] || CONFIG_DIRECTORY, CONFIG_FILE);
  const configData = await config.load();
  const flags = gatherFlags(argv);

  let stream: NodeJS.WritableStream;
  let tasks: TaskChain;
  let bottomBar: inquirerType.ui.BottomBar | undefined;
  let log: Logger;
  let level: LogLevel = 'info';
  let levelInvalid = false;
  let prefix: string | (() => string) = '';

  if (isCI) {
    flags.interactive = false;
  }

  if (argv['log-level']) {
    if (isLogLevel(argv['log-level'])) {
      level = argv['log-level'];
    } else {
      levelInvalid = true;
    }
  }

  if (argv['log-timestamps']) {
    prefix = () => `${chalk.dim('[' + new Date().toISOString() + ']')}`;
  }

  if (flags.interactive) {
    const inquirer = await import('inquirer');
    bottomBar = new inquirer.ui.BottomBar();
    stream = bottomBar.log;
    log = new Logger({ level, prefix, stream });
    tasks = new InteractiveTaskChain({ log, bottomBar });
  } else {
    stream = process.stdout;
    log = new Logger({ level, prefix, stream });
    tasks = new TaskChain({ log });
  }

  const projectDir = await findBaseDirectory(cwd, PROJECT_FILE);

  env['IONIC_PROJECT_DIR'] = projectDir || '';
  env['IONIC_PROJECT_FILE'] = PROJECT_FILE;

  const project = new Project(env['IONIC_PROJECT_DIR'], PROJECT_FILE);
  const client = new Client(configData.urls.api);
  const session = await getSession(config, project, client);
  const hooks = new HookEngine();
  const telemetry = new Telemetry({ config, client, plugin, project, session });
  const shell = new Shell(tasks, log);

  registerHooks(hooks);

  const ienv = new Environment({
    bottomBar,
    client,
    config,
    daemon: new Daemon(CONFIG_DIRECTORY, DAEMON_JSON_FILE),
    events: new CLIEventEmitter(),
    flags,
    hooks,
    log,
    meta: {
      cwd,
      local: env['IONIC_CLI_LOCAL'] ? true : false,
      binPath: env['IONIC_CLI_BIN'],
      libPath: env['IONIC_CLI_LIB'],
    },
    namespace: plugin.namespace,
    plugins: {
      ionic: plugin,
    },
    prompt: await createPromptModule({ confirm: flags.confirm, interactive: flags.interactive, log, config }),
    project,
    session,
    shell,
    tasks,
    telemetry,
  });

  ienv.open();

  if (levelInvalid) {
    log.warn(
      `${chalk.green(argv['log-level'])} is an invalid log level--defaulting back to ${chalk.bold(level)}.\n` +
      `You can choose from the following log levels: ${LOG_LEVELS.map(l => chalk.bold(l)).join(', ')}.`
    );
  }

  log.debug(`CLI flags: ${util.inspect(flags, { breakLength: Infinity, colors: chalk.enabled })}`);

  if (typeof argv['yarn'] === 'boolean') {
    log.warn(`${chalk.green('--yarn')} / ${chalk.green('--no-yarn')} switch is deprecated. Use ${chalk.green('ionic config set -g yarn ' + String(argv['yarn']))}.`);
    configData.yarn = argv['yarn'];
  }

  if (!projectDir) {
    const foundDir = await findBaseDirectory(cwd, PROJECT_FILE_LEGACY);

    if (foundDir) {
      log.warn(`${chalk.bold(PROJECT_FILE_LEGACY)} file found in ${chalk.bold(foundDir)}--please rename it to ${chalk.bold(PROJECT_FILE)}, or your project directory will not be detected!`);
    }
  }

  return ienv;
}
