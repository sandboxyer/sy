// ssh-lab.mjs
import { exec } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile, chmod, access } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

export default class SSH {
  /**
   * Install sshpass if not present (apt/apk fallback)
   * @returns {Promise<boolean>}
   */
  static async _ensureSshpass() {
    try {
      await execAsync('which sshpass');
      return true; // already installed
    } catch {
      // Try apt (Debian/Ubuntu)
      try {
        await execAsync('apt-get update -qq && apt-get install -y -qq sshpass', { timeout: 30000 });
        return true;
      } catch {
        // Try apk (Alpine)
        try {
          await execAsync('apk add --no-cache sshpass', { timeout: 30000 });
          return true;
        } catch {
          return false;
        }
      }
    }
  }

  /**
   * One-time global setup: SSH config + key generation
   * @returns {Promise<{success: boolean, message: string}>}
   */
  static async setup() {
    try {
      const sshDir = join(homedir(), '.ssh');
      const configPath = join(sshDir, 'config');
      const keyPath = join(sshDir, 'id_rsa');

      // Create .ssh directory
      await mkdir(sshDir, { recursive: true, mode: 0o700 });

      // Write SSH config
      const configContent = 'Host *\n    StrictHostKeyChecking no\n    UserKnownHostsFile /dev/null\n    LogLevel ERROR\n';
      await writeFile(configPath, configContent, { mode: 0o600 });

      // Generate SSH key if not exists
      try {
        await access(keyPath);
        return { success: true, message: 'SSH already configured, key exists' };
      } catch {
        await execAsync(`ssh-keygen -t rsa -N "" -f ${keyPath} <<< y`);
        return { success: true, message: 'SSH configured and key generated' };
      }
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Copy SSH key using pure bash (no sshpass)
   * @param {string} host
   * @param {string} password
   * @param {string} user
   * @returns {Promise<{success: boolean, message: string}>}
   */
  static async _copyKeyBash(host, password, user) {
    try {
      const askpass = `/tmp/ap_${Date.now()}`;
      
      const cmd = `A="${askpass}"; echo '#!/bin/sh\necho \\'${password}\\'' > $A; chmod 700 $A; cat ~/.ssh/id_rsa.pub | SSH_ASKPASS=$A DISPLAY=:0 ssh -o StrictHostKeyChecking=no ${user}@${host} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys" < /dev/null 2>&1; rm -f $A`;
      
      const { stdout, stderr } = await execAsync(cmd, { timeout: 15000 });
      
      return {
        success: !stderr.includes('Permission denied') && !stderr.includes('Connection refused'),
        message: stdout.trim() || stderr.trim() || 'Key copied'
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Copy SSH key using sshpass (fallback)
   * @param {string} host
   * @param {string} password
   * @param {string} user
   * @returns {Promise<{success: boolean, message: string}>}
   */
  static async _copyKeySshpass(host, password, user) {
    try {
      const cmd = `sshpass -p '${password}' ssh-copy-id -o StrictHostKeyChecking=no ${user}@${host} 2>&1`;
      const { stdout, stderr } = await execAsync(cmd, { timeout: 15000 });
      
      return {
        success: !stderr.includes('Permission denied') && !stderr.includes('Connection refused'),
        message: stdout.trim() || 'Key copied via sshpass'
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Copy SSH key to remote host (auto-fallback: bash -> sshpass)
   * @param {string} host - IP address
   * @param {string} password - SSH password
   * @param {string} user - SSH user (default: root)
   * @returns {Promise<{success: boolean, message: string}>}
   */
  static async copyKey(host, password, user = 'root') {
    // Method 1: Pure bash (no dependencies)
    const bashResult = await this._copyKeyBash(host, password, user);
    if (bashResult.success) {
      return { ...bashResult, method: 'bash' };
    }

    // Method 2: Try installing sshpass
    const sshpassInstalled = await this._ensureSshpass();
    if (sshpassInstalled) {
      const sshpassResult = await this._copyKeySshpass(host, password, user);
      return { ...sshpassResult, method: 'sshpass' };
    }

    // Both failed
    return { success: false, message: 'All methods failed. Bash: ' + bashResult.message, method: 'none' };
  }

  /**
   * Check if SSH port is open and accepting connections
   * @param {string} host - IP address
   * @param {number} port - SSH port (default: 22)
   * @returns {Promise<boolean>}
   */
  static async checkAccess(host, port = 22) {
    try {
      // Use bash built-in /dev/tcp to check if port is open
      const cmd = `timeout 5 bash -c "echo >/dev/tcp/${host}/${port}" 2>&1`;
      await execAsync(cmd, { timeout: 6000 });
      return true;
    } catch {
      // Fallback: try nc if available
      try {
        await execAsync(`nc -zv -w3 ${host} ${port} 2>&1`, { timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * One-time setup + copy key + check access (complete workflow)
   * @param {string} host - IP address
   * @param {string} password - SSH password
   * @param {string} user - SSH user (default: root)
   * @returns {Promise<{success: boolean, message: string}>}
   */
  static async fullSetup(host, password, user = 'root') {
    // Step 0: Check if host is reachable on port 22
    const reachable = await this.checkAccess(host);
    if (!reachable) {
      return { success: false, message: `Host ${host} not reachable on port 22` };
    }

    // Step 1: Global setup
    const setupResult = await this.setup();
    if (!setupResult.success) return setupResult;

    // Step 2: Copy key with fallback
    const copyResult = await this.copyKey(host, password, user);
    if (!copyResult.success) return copyResult;

    // Step 3: Verify passwordless access
    try {
      await execAsync(`ssh -o StrictHostKeyChecking=no -o PasswordAuthentication=no -o ConnectTimeout=5 ${user}@${host} "exit" 2>&1`, { timeout: 8000 });
      return { success: true, message: `Full setup complete via ${copyResult.method}, passwordless SSH working` };
    } catch {
      return { success: false, message: 'Key copied but passwordless SSH verification failed' };
    }
  }
}

// CLI usage when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const [,, method, ...args] = process.argv;

  const usage = `
Usage: node ssh-lab.mjs <method> [args]

Methods:
  setup                              One-time SSH config + key generation
  copyKey <host> <password> [user]   Copy SSH key to remote host
  checkAccess <host> [port]          Check if SSH port is open
  fullSetup <host> <password> [user] Run setup + copyKey + verify

Examples:
  node ssh-lab.mjs setup
  node ssh-lab.mjs copyKey 10.10.10.10 123
  node ssh-lab.mjs checkAccess 10.10.10.10
  node ssh-lab.mjs checkAccess 10.10.10.10 2222
  node ssh-lab.mjs fullSetup 10.10.10.10 123 root
`;

  if (!method) {
    console.log(usage);
    process.exit(1);
  }

  (async () => {
    try {
      switch (method) {
        case 'setup': {
          const result = await SSHLab.setup();
          console.log(JSON.stringify(result));
          break;
        }
        case 'copyKey': {
          const [host, password, user = 'root'] = args;
          if (!host || !password) {
            console.log('Usage: node ssh-lab.mjs copyKey <host> <password> [user]');
            process.exit(1);
          }
          const result = await SSHLab.copyKey(host, password, user);
          console.log(JSON.stringify(result));
          break;
        }
        case 'checkAccess': {
          const [host, port = 22] = args;
          if (!host) {
            console.log('Usage: node ssh-lab.mjs checkAccess <host> [port]');
            process.exit(1);
          }
          const result = await SSHLab.checkAccess(host, port);
          console.log(result);
          break;
        }
        case 'fullSetup': {
          const [host, password, user = 'root'] = args;
          if (!host || !password) {
            console.log('Usage: node ssh-lab.mjs fullSetup <host> <password> [user]');
            process.exit(1);
          }
          const result = await SSHLab.fullSetup(host, password, user);
          console.log(JSON.stringify(result));
          break;
        }
        default:
          console.log(`Unknown method: ${method}`);
          console.log(usage);
          process.exit(1);
      }
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  })();
}