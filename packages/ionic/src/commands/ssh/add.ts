import * as os from 'os';
import * as path from 'path';

import * as chalk from 'chalk';

import {
  BACKEND_PRO,
  CommandLineInputs,
  CommandLineOptions,
  CommandMetadata,
  CommandPreRun,
  ERROR_FILE_NOT_FOUND,
  FatalException,
  createFatalAPIFormat,
  isSSHKeyResponse,
  isSuperAgentError,
  pathAccessible,
  pathExists,
  prettyPath,
} from '@ionic/cli-utils';

import { SSHBaseCommand } from './base';

@CommandMetadata({
  name: 'add',
  type: 'global',
  backends: [BACKEND_PRO],
  description: 'Add an SSH public key to Ionic',
  inputs: [
    {
      name: 'pubkey-path',
      description: 'Location of public key file to add to Ionic',
    },
  ],
  options: [
    {
      name: 'use',
      description: 'Use the newly added key as your default SSH key for Ionic',
      type: Boolean,
    },
  ],
})
export class SSHAddCommand extends SSHBaseCommand implements CommandPreRun {
  async preRun(inputs: CommandLineInputs, options: CommandLineOptions): Promise<void> {
    if (!inputs[0]) {
      const fs = await import('fs');
      const defaultPubkeyPath = path.resolve(os.homedir(), '.ssh', 'id_rsa.pub');
      const defaultPubkeyExists = await pathAccessible(defaultPubkeyPath, fs.constants.R_OK);

      const pubkeyPath = await this.env.prompt({
        type: 'input',
        name: 'pubkeyPath',
        message: 'Enter the location to your public key file to upload to Ionic:',
        default: defaultPubkeyExists ? prettyPath(defaultPubkeyPath) : undefined,
      });

      inputs[0] = pubkeyPath;
    }
  }

  async run(inputs: CommandLineInputs, options: CommandLineOptions): Promise<void | number> {
    const {
      ERROR_SSH_ANNOTATION_INVALID_WHITESPACE,
      ERROR_SSH_ANNOTATION_MISSING,
      ERROR_SSH_INVALID_PUBKEY,
      parsePublicKeyFile,
    } = await import('../../lib/ssh');

    const pubkeyPath = path.resolve(inputs[0]);
    const pubkeyName = prettyPath(pubkeyPath);

    let pubkey: string;

    try {
      [ pubkey, , , ] = await parsePublicKeyFile(pubkeyPath);
    } catch (e) {
      if (e === ERROR_FILE_NOT_FOUND) {
        throw new FatalException(
          `${chalk.bold(prettyPath(pubkeyPath))} does not appear to exist. Please specify a valid SSH public key.\n` +
          `If you are having issues, try using ${chalk.green('ionic ssh setup')}.`
        );
      } else if (e === ERROR_SSH_INVALID_PUBKEY) {
        throw new FatalException(
          `${chalk.bold(pubkeyName)} does not appear to be a valid SSH public key. (Not in ${chalk.bold('authorized_keys')} file format.)\n` +
          `If you are having issues, try using ${chalk.green('ionic ssh setup')}.`
        );
      } else if (e === ERROR_SSH_ANNOTATION_MISSING) {
        throw new FatalException(
          `${chalk.bold(pubkeyName)} is missing an annotation/comment after the public key.\n` +
          `If you are using ${chalk.green('ssh-keygen')}, try using the ${chalk.green('-C')} flag.\n` +
          `If you are having issues, try using ${chalk.green('ionic ssh setup')}.`
        );
      } else if (e === ERROR_SSH_ANNOTATION_INVALID_WHITESPACE) {
        throw new FatalException(
          `${chalk.bold(pubkeyName)} has an annotation/comment that has whitespace.\n` +
          `Try changing the comment to something more like an identifier.\n` +
          `If you are having issues, try using ${chalk.green('ionic ssh setup')}.`
        );
      }

      throw e;
    }

    const config = await this.env.config.load();
    const token = await this.env.session.getUserToken();

    const req = this.env.client.make('POST', `/users/${config.user.id}/sshkeys`)
      .set('Authorization', `Bearer ${token}`)
      .send({ pubkey });

    try {
      const res = await this.env.client.do(req);

      if (!isSSHKeyResponse(res)) {
        throw createFatalAPIFormat(req, res);
      }

      const words = res.meta.status === 201 ? 'added to' : 'updated on';

      this.env.log.ok(`Your public key (${chalk.bold(res.data.fingerprint)}) has been ${words} Ionic!`);
    } catch (e) {
      if (isSuperAgentError(e) && e.response.status === 409) {
        this.env.log.info('Pubkey already added to Ionic.');
      } else {
        throw e;
      }
    }

    if (pubkeyPath.endsWith('.pub')) {
      let confirm = options['use'];

      if (!confirm) {
        confirm = await this.env.prompt({
          type: 'confirm',
          name: 'confirm',
          message: 'Would you like to use this key as your default for Ionic?',
        });
      }

      if (confirm) {
        const keyPath = pubkeyPath.substring(0, pubkeyPath.length - 4); // corresponding private key, theoretically
        const keyExists = await pathExists(keyPath);

        if (keyExists) {
          await this.runcmd(['ssh', 'use', keyPath]);
        } else {
          this.env.log.error(
            `SSH key does not exist: ${chalk.bold(prettyPath(keyPath))}.\n` +
            `Please use ${chalk.green('ionic ssh use')} manually to use the corresponding private key.`
          );
        }
      }
    }
  }
}
