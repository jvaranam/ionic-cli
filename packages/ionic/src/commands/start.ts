import * as path from 'path';

import * as chalk from 'chalk';

import {
  App,
  BACKEND_LEGACY,
  BACKEND_PRO,
  Command,
  CommandLineInputs,
  CommandLineOptions,
  CommandMetadata,
  CommandPreRun,
  PROJECT_FILE,
  Project,
  fsMkdir,
  getCommandInfo,
  isValidPackageName,
  pathExists,
  pkgInstallPluginArgs,
  pkgManagerArgs,
  prettyPath,
  promisify,
  promptToLogin,
  validators,
} from '@ionic/cli-utils';

import { StarterTemplate } from '../definitions';

import {
  STARTER_TEMPLATES,
  STARTER_TYPES,
  createProjectConfig,
  getHelloText,
  getStarterTemplateTextList,
  isProjectNameValid,
  isSafeToCreateProjectIn,
  patchPackageJsonForCli,
  tarXvfFromUrl,
  updatePackageJsonForCli,
} from '../lib/start';

@CommandMetadata({
  name: 'start',
  type: 'global',
  description: 'Create a new project',
  longDescription: `
This command creates a working Ionic app. It installs dependencies for you and sets up your project.

${chalk.green('ionic start')} will create an app from a template. You can list all templates with the ${chalk.green('--list')} option.

If you want to create an Ionic/Cordova app, use the ${chalk.green('--cordova')} option.
  `,
  exampleCommands: [
    '',
    '--list',
    'myApp blank',
    'myApp tabs --cordova',
    'myApp blank --type=ionic1',
  ],
  inputs: [
    {
      name: 'name',
      description: 'The name of your project directory',
    },
    {
      name: 'template',
      description: `The starter template to use (e.g. ${['blank', 'tabs'].map(t => chalk.green(t)).join(', ')}; use ${chalk.green('--list')} to see all)`,
    }
  ],
  options: [
    {
      name: 'type',
      description: `Type of project to start (e.g. ${STARTER_TYPES.map(st => chalk.green(st.id)).join(', ')})`,
      type: String,
      default: 'ionic-angular',
    },
    {
      name: 'app-name',
      description: 'Human-readable name (use quotes around the name)',
      type: String,
      aliases: ['n'],
    },
    {
      name: 'list',
      description: 'List starter templates available',
      type: Boolean,
      aliases: ['l'],
    },
    {
      name: 'cordova',
      description: 'Include Cordova integration',
      type: Boolean,
    },
    {
      name: 'deps',
      description: 'Do not install npm/yarn dependencies',
      type: Boolean,
      default: true,
    },
    {
      name: 'git',
      description: 'Do not initialize a git repo',
      backends: [BACKEND_LEGACY],
      type: Boolean,
      default: true,
    },
    {
      name: 'link',
      description: 'Do not ask to connect the app with the Ionic Dashboard',
      type: Boolean,
      default: true,
    },
    {
      name: 'pro-id',
      description: 'Specify an app ID from the Ionic Dashboard to link',
      visible: false,
    },
  ],
})
export class StartCommand extends Command implements CommandPreRun {
  async preRun(inputs: CommandLineInputs, options: CommandLineOptions): Promise<number | void> {
    // If the action is list then lets just end here.
    if (options['list']) {
      this.env.log.msg(getStarterTemplateTextList(STARTER_TEMPLATES).join('\n'));
      return 0;
    }

    if (options['skip-deps']) {
      options['deps'] = false;
    }

    if (options['skip-link']) {
      options['link'] = false;
    }

    if (options['pro-id']) {
      options['link'] = true;
    }

    let proAppId = <string>options['pro-id'] || '';
    const config = await this.env.config.load();

    if (proAppId && config.backend !== BACKEND_PRO) {
      await this.runcmd(['config', 'set', '-g', 'backend', 'pro'], { showExecution: false, showLogs: false });
      this.env.log.nl();
      this.env.log.info(
        `${chalk.bold(chalk.blue.underline('You have opted in to Ionic Pro!') + ' The CLI is now set up to use Ionic Pro services.')}\n` +
        `You can revert back to Ionic Cloud (legacy) services at any time:\n\n` +
        `${chalk.green('ionic config set -g backend legacy')}\n`
      );
    }

    if (this.env.project.directory) {
      const confirm = await this.env.prompt({
        type: 'confirm',
        name: 'confirm',
        message: 'You are already in an Ionic project directory. Do you really want to start another project here?',
        default: false,
      });

      if (!confirm) {
        this.env.log.info('Not starting project within existing project.');
        return 0;
      }
    }

    if (options['v1'] || options['v2']) {
      const type = options['v1'] ? 'ionic1' : 'ionic-angular';

      throw this.exit(
        `Sorry! The ${chalk.green('--v1')} and ${chalk.green('--v2')} flags have been removed.\n` +
        `Use the ${chalk.green('--type')} option. (${chalk.green('ionic start --help')})\n\n` +
        `For ${chalk.bold(this.env.project.formatType(type))} projects, try ${chalk.green('ionic start ' + (inputs.length > 0 ? inputs.join(' ') + ' ' : '') + '--type=' + type)}`
      );
    }

    if (proAppId) {
      if (!(await this.env.session.isLoggedIn())) {
        await promptToLogin(this.env);
      }
    }

    if (!inputs[0]) {
      if (proAppId) {
        const token = await this.env.session.getUserToken();
        const appLoader = new App(token, this.env.client);
        const app = await appLoader.load(proAppId);
        this.env.log.info(`Using ${chalk.bold(app.slug)} for ${chalk.green('name')}.`);
        inputs[0] = app.slug;
      } else {
        const name = await this.env.prompt({
          type: 'input',
          name: 'name',
          message: 'What would you like to name your project:',
          validate: v => validators.required(v, 'name'),
        });

        inputs[0] = name;
      }
    }

    if (!inputs[1]) {
      const template = await this.env.prompt({
        type: 'list',
        name: 'template',
        message: 'What starter would you like to use:',
        choices: () => {
          const starterTemplates = STARTER_TEMPLATES.filter(st => st.type === options['type']);

          return getStarterTemplateTextList(starterTemplates)
            .map((text: string, index: number) => {
              return {
                name: text,
                short: starterTemplates[index].name,
                value: starterTemplates[index].name
              };
            });
        }
      });

      inputs[1] = template;
    }
  }

  async run(inputs: CommandLineInputs, options: CommandLineOptions): Promise<number | void> {
    let [ projectName, starterTemplateName ] = inputs;
    let appName = <string>options['app-name'] || projectName;
    let starterBranchName = <string>options['starterBranchName'] || 'master';
    let wrapperBranchName = <string>options['wrapperBranchName'] || 'master';
    let gitIntegration = false;
    let linkConfirmed = typeof options['pro-id'] === 'string';
    let proAppId = <string>options['pro-id'] || '';

    const config = await this.env.config.load();

    if (!isProjectNameValid(projectName)) {
      throw this.exit(`Please name your Ionic project something meaningful other than ${chalk.green(projectName)}`);
    }

    let starterType = STARTER_TYPES.find(type => type['id'] === options['type']);

    if (!starterType) {
      throw this.exit(`Unable to find starter type for ${chalk.green(String(options['type']))}.`);
    }

    if (!options['cordova']) {
      const confirm = await this.env.prompt({
        type: 'confirm',
        name: 'confirm',
        message: 'Would you like to integrate your new app with Cordova to target native iOS and Android?',
        default: false,
      });

      if (confirm) {
        options['cordova'] = true;
      }
    }

    if (options['deps']) {
      // Check global dependencies
      if (options['cordova']) {
        starterType.globalDependencies.push('cordova');
      }

      this.env.log.debug(`globalDeps=${starterType.globalDependencies}`);

      for (let dep of starterType.globalDependencies) {
        const cmdInstalled = await getCommandInfo(dep);

        if (!cmdInstalled) {
          if (dep === 'cordova') {
            const cdvInstallArgs = await pkgManagerArgs(this.env, { pkg: 'cordova', global: true });
            throw this.exit(
              `Cordova CLI not found on your PATH. Please install Cordova globally (you may need ${chalk.green('sudo')}):\n\n` +
              `${chalk.green(cdvInstallArgs.join(' '))}\n\n` +
              `If that doesn't work, see the installation docs: ${chalk.bold('https://cordova.apache.org/docs/en/latest/guide/cli/#installing-the-cordova-cli')}`
            );
          } else {
            throw this.exit(`Sorry, ${chalk.green(dep)} is a global dependency, but it was not found on your PATH.`);
          }
        }
      }
    }

    if (config.backend === BACKEND_PRO || options['git']) {
      const cmdInstalled = await getCommandInfo('git', ['--version']);

      if (cmdInstalled) {
        gitIntegration = true;
      } else {
        if (config.backend === BACKEND_LEGACY) {
          this.env.log.warn(
            `Git CLI not found on your PATH. You may wish to install it to version control your app.\n` +
            `See installation docs for git: ${chalk.bold('https://git-scm.com/book/en/v2/Getting-Started-Installing-Git')}\n\n` +
            `Use ${chalk.green('--no-git')} to disable this warning.\n`
          );
        }
      }
    }

    const projectRoot = path.resolve(projectName);
    projectName = path.basename(projectRoot);
    let safeProjectName = projectName;

    const shellOptions = { cwd: projectRoot };
    const projectExists = await pathExists(projectName);

    // Create the project directory
    if (!projectExists) {
      this.env.tasks.next(`Creating directory ${chalk.green(prettyPath(projectRoot))}`);
      await fsMkdir(projectRoot, undefined);
    } else if (!(await isSafeToCreateProjectIn(projectRoot))) {
      const confirm = await this.env.prompt({
        type: 'confirm',
        name: 'confirm',
        message: `The directory ${chalk.green(projectName)} contains file(s) that could conflict. ` +
            'Would you like to overwrite the directory with this new project?',
        default: false,
      });

      if (confirm) {
        try {
          this.env.tasks.next(`Creating directory ${chalk.green(prettyPath(projectRoot))}`);
          const rimraf = await import('rimraf');
          const rimrafp = promisify<void, string>(rimraf);
          await rimrafp(projectRoot);
          await fsMkdir(projectRoot, undefined);
        } catch (e) {
          throw e;
        }
      } else {
        this.env.log.info(`Not erasing existing project in ${chalk.green(prettyPath(projectRoot))}.`);
        return 0;
      }
    }

    let starterTemplateMatches: StarterTemplate[] = STARTER_TEMPLATES.filter(t => t.type === options['type'] && t.name === starterTemplateName);
    let starterTemplate: StarterTemplate | undefined = starterTemplateMatches[0];

    if (starterTemplateMatches.length > 1) {
      starterTemplate = starterTemplateMatches.find(t => t.type === options['type']);
    }

    if (!starterTemplate) {
      throw `Unable to find starter template for ${starterTemplateName}`;
    }

    const wrapperBranchPath = starterType.baseArchive.replace('<BRANCH_NAME>', wrapperBranchName);
    const starterBranchPath = starterTemplate.archive.replace('<BRANCH_NAME>', starterBranchName);

    const extractDir = options['type'] === 'ionic1' ? path.join(projectRoot, 'www') : projectRoot;

    this.env.tasks.end();
    this.env.log.info(`Fetching app base (${chalk.dim(wrapperBranchPath)})`);
    const d1Task = this.env.tasks.next('Downloading');

    await tarXvfFromUrl(wrapperBranchPath, projectRoot, { progress: (loaded, total) => {
      d1Task.progress(loaded, total);
    }});

    this.env.tasks.end();
    this.env.log.info(`Fetching starter template ${chalk.green(starterTemplateName.toString())} (${chalk.dim(starterBranchPath)})`);
    const d2Task = this.env.tasks.next('Downloading');
    await tarXvfFromUrl(starterBranchPath, extractDir, { progress: (loaded, total) => {
      d2Task.progress(loaded, total);
    }});

    if (options['type'] === 'ionic1') {
      const resourcesPath = 'https://github.com/ionic-team/ionic-default-resources/archive/master.tar.gz';
      this.env.tasks.end();
      this.env.log.info(`Fetching resources (${chalk.dim(resourcesPath)})`);
      const d3Task = this.env.tasks.next('Downloading');
      await tarXvfFromUrl(resourcesPath, path.join(projectRoot, 'resources'), { progress: (loaded, total) => {
        d3Task.progress(loaded, total);
      }});
    }

    this.env.tasks.next(`Updating ${chalk.bold('package.json')} with app details`);

    if (!isValidPackageName(projectName)) {
      safeProjectName = 'MyApp';
      this.env.log.warn(`${chalk.green(projectName)} was not a valid name for ${chalk.bold('package.json')}. Using ${chalk.bold(safeProjectName)} for now.`);
    }

    await patchPackageJsonForCli(this.env, safeProjectName, starterType, projectRoot);
    await updatePackageJsonForCli(this.env, safeProjectName, starterType, projectRoot);

    this.env.tasks.next(`Creating configuration file ${chalk.bold('ionic.config.json')}`);
    await createProjectConfig(appName, starterType, projectRoot);

    this.env.tasks.end();

    if (options['deps']) {
      // Install local dependencies

      this.env.log.info('Installing dependencies may take several minutes!');

      const [ installer, ...installerArgs ] = await pkgManagerArgs(this.env, { command: 'install' });
      await this.env.shell.run(installer, installerArgs, shellOptions);

      if (options['cordova']) {
        starterType.localDependencies.push('@ionic/cli-plugin-cordova');
      }

      this.env.log.debug(`localDeps=${starterType.localDependencies}`);

      for (let dep of starterType.localDependencies) {
        const [ installer, ...installerArgs ] = await pkgInstallPluginArgs(this.env, dep);
        await this.env.shell.run(installer, installerArgs, shellOptions);
      }

      const [ , ...dedupeArgs ] = await pkgManagerArgs(this.env, { command: 'dedupe' });

      if (dedupeArgs.length > 0) {
        await this.env.shell.run(installer, dedupeArgs, {});
      }
    }

    if (config.backend === BACKEND_PRO && !gitIntegration) {
      throw this.exit(
        `Git CLI not found on your PATH. It must be installed to connect this app to Ionic.\n` +
        `See installation docs for git: ${chalk.bold('https://git-scm.com/book/en/v2/Getting-Started-Installing-Git')}`
      );
    }

    if (gitIntegration) {
      await this.env.shell.run('git', ['init'], shellOptions);
    }

    if (config.backend === BACKEND_PRO) {
      if (options['link'] && !linkConfirmed) {
        const confirm = await this.env.prompt({
          type: 'confirm',
          name: 'confirm',
          message: 'Connect this app to the Ionic Dashboard?',
          noninteractiveValue: false,
        });

        if (confirm) {
          linkConfirmed = true;
        }
      }

      if (linkConfirmed) {
        this.env.project = new Project(projectRoot, PROJECT_FILE);
        const cmdArgs = ['link'];

        if (proAppId) {
          cmdArgs.push(proAppId);
        }

        await this.runcmd(cmdArgs);
      }
    }

    if (gitIntegration) {
      await this.env.shell.run('git', ['add', '-A'], shellOptions);
      await this.env.shell.run('git', ['commit', '-m', 'Initial commit', '--no-gpg-sign'], shellOptions);
    }

    if (config.backend === BACKEND_LEGACY) {
      // Print out hello text about how to get started
      if (this.env.log.shouldLog('info')) {
        this.env.log.msg(getHelloText());
      }
    }

    this.env.log.nl();
    this.env.log.msg(`${chalk.bold('Next Steps')}:\n`);
    this.env.log.msg(`Go to your newly created project: ${chalk.green(`cd ${prettyPath(projectRoot)}`)}`);

    if (config.backend === BACKEND_PRO && linkConfirmed) {
      this.env.log.msg(`Then, push your code to the Ionic Dashboard: ${chalk.green('git push ionic master')}`);
    }

    this.env.log.nl();
  }
}
