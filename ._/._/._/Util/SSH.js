// ssh-lab.mjs
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdir, writeFile, chmod, access, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { networkInterfaces } from 'os';
import * as net from 'net';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);

// Background scan state management
const SCAN_STATE_FILE = join(homedir(), '.ssh-lab-scan-state.json');
const SCAN_PID_FILE = join(homedir(), '.ssh-lab-scan.pid');

export default class SSH {
  /**
   * Execute command and return full output even on error
   */
  static async _exec(cmd, options = {}) {
    try {
      const { stdout, stderr } = await execAsync(cmd, { 
        timeout: 15000,
        ...options 
      });
      return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      return { 
        success: false, 
        stdout: error.stdout?.trim() || '', 
        stderr: error.stderr?.trim() || error.message,
        error: error.message 
      };
    }
  }

  /**
   * Install sshpass if not present
   */
  static async _ensureSshpass() {
    const { success } = await this._exec('which sshpass');
    if (success) return true;

    // Try apt with retry
    for (let i = 0; i < 3; i++) {
      const result = await this._exec('apt-get update -qq 2>/dev/null && apt-get install -y -qq sshpass 2>/dev/null', { timeout: 60000 });
      if (result.success || result.stderr === '') {
        const checkResult = await this._exec('which sshpass');
        if (checkResult.success) return true;
      }
      if (i < 2) await new Promise(r => setTimeout(r, 2000));
    }

    // Try apk
    const apkResult = await this._exec('apk add --no-cache sshpass 2>/dev/null', { timeout: 30000 });
    if (apkResult.success) return true;

    return false;
  }

  /**
   * Setup SSH directory and config
   */
  static async setup() {
    try {
      const sshDir = join(homedir(), '.ssh');
      const configPath = join(sshDir, 'config');
      const keyPath = join(sshDir, 'id_rsa');

      await mkdir(sshDir, { recursive: true, mode: 0o700 });

      const configContent = 'Host *\n    StrictHostKeyChecking no\n    UserKnownHostsFile /dev/null\n    LogLevel ERROR\n';
      await writeFile(configPath, configContent, { mode: 0o600 });

      try {
        await access(keyPath);
        return { success: true, message: 'SSH already configured, key exists' };
      } catch {
        await this._exec(`ssh-keygen -t rsa -b 2048 -N "" -f ${keyPath} -q`);
        return { success: true, message: 'SSH configured and key generated' };
      }
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Copy SSH key using sshpass (simpler and more reliable)
   */
  static async _copyKeySshpass(host, password, user) {
    const cmd = `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh-copy-id -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host}`;
    const result = await this._exec(cmd);
    
    if (result.success) {
      return { success: true, method: 'sshpass', message: 'Key copied via sshpass' };
    }
    
    // Check if key was already there
    if (result.stderr.includes('already exist')) {
      return { success: true, method: 'sshpass', message: 'Key already exists on target' };
    }
    
    return { success: false, method: 'sshpass', error: result.stderr };
  }

  /**
   * Copy SSH key using pure bash with expect-like behavior
   */
  static async _copyKeyBash(host, password, user) {
    const tmpScript = `/tmp/ssh_copy_${Date.now()}.sh`;
    const escapedPassword = password.replace(/'/g, "'\\''");
    
    const scriptContent = `#!/bin/bash
# Create expect-like script using sshpass approach with /dev/tcp
# First, try direct ssh-copy-id with sshpass
export SSHPASS='${escapedPassword}'
sshpass -e ssh-copy-id -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} 2>&1
exit_code=$?
if [ $exit_code -eq 0 ]; then
  echo "SUCCESS: Key copied"
  exit 0
fi

# Check if key already exists
sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${user}@${host} "test -f ~/.ssh/authorized_keys && grep -q '$(cat ~/.ssh/id_rsa.pub)' ~/.ssh/authorized_keys && echo 'SUCCESS: Key already present' || echo 'FAILED: Key not found'" 2>&1
exit $?`;

    try {
      await writeFile(tmpScript, scriptContent, { mode: 0o700 });
      const result = await this._exec(`bash ${tmpScript}`);
      await this._exec(`rm -f ${tmpScript}`);
      
      if (result.stdout.includes('SUCCESS')) {
        return { success: true, method: 'bash', message: result.stdout.trim() };
      }
      
      return { success: false, method: 'bash', error: result.stdout || result.stderr };
    } catch (error) {
      await this._exec(`rm -f ${tmpScript}`);
      return { success: false, method: 'bash', error: error.message };
    }
  }

  /**
   * Copy SSH key with automatic fallback
   */
  static async copyKey(host, password, user = 'root') {
    console.error('[copyKey] Starting key copy process...');
    
    // Try bash method first (if sshpass is available)
    const hasSshpass = await this._ensureSshpass();
    
    if (hasSshpass) {
      console.error('[copyKey] sshpass available, using sshpass method');
      const result = await this._copyKeySshpass(host, password, user);
      if (result.success) {
        console.error('[copyKey] sshpass method succeeded');
        return result;
      }
      console.error('[copyKey] sshpass method failed:', result.error);
    } else {
      console.error('[copyKey] sshpass not available, falling back to bash method');
    }
    
    // Fall back to bash method
    console.error('[copyKey] Trying bash method...');
    const bashResult = await this._copyKeyBash(host, password, user);
    console.error('[copyKey] Bash method result:', bashResult);
    
    return bashResult;
  }

  /**
   * Check if port is open
   */
  static async checkAccess(host, port = 22) {
    const result = await this._exec(`timeout 3 bash -c "echo >/dev/tcp/${host}/${port}" 2>&1`);
    if (result.success) return true;
    
    // Try nc as fallback
    const ncResult = await this._exec(`nc -zv -w2 ${host} ${port} 2>&1`);
    return ncResult.success || ncResult.stderr.includes('succeeded') || ncResult.stderr.includes('open');
  }

  /**
   * Test SSH connection and return detailed debug info
   */
  static async _testConnection(host, user, useKey = true) {
    const keyOpts = useKey ? '-o PasswordAuthentication=no -o BatchMode=yes' : '';
    const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${keyOpts} ${user}@${host} "echo 'CONNECTION_OK'" 2>&1`;
    
    console.error(`[_testConnection] Testing connection to ${user}@${host} (key=${useKey})...`);
    const result = await this._exec(cmd);
    
    console.error(`[_testConnection] stdout:`, result.stdout);
    console.error(`[_testConnection] stderr:`, result.stderr);
    
    return {
      success: result.stdout.includes('CONNECTION_OK'),
      output: result.stdout,
      error: result.stderr
    };
  }

  /**
   * Full setup workflow
   */
  static async fullSetup(host, password, user = 'root') {
    console.error('\n=== SSH Full Setup Started ===');
    console.error(`Target: ${user}@${host}`);
    
    // Step 0: Check reachability
    console.error('\n[Step 0] Checking if host is reachable...');
    const reachable = await this.checkAccess(host);
    if (!reachable) {
      console.error('[Step 0] Host not reachable');
      return { success: false, message: `Host ${host} not reachable on port 22` };
    }
    console.error('[Step 0] Host is reachable');

    // Step 1: Setup local SSH
    console.error('\n[Step 1] Setting up local SSH...');
    const setupResult = await this.setup();
    if (!setupResult.success) {
      console.error('[Step 1] Setup failed:', setupResult.message);
      return setupResult;
    }
    console.error('[Step 1] Setup complete:', setupResult.message);

    // Step 2: Test current connection status
    console.error('\n[Step 2] Testing current connection...');
    const preTest = await this._testConnection(host, user, true);
    
    if (preTest.success) {
      console.error('[Step 2] Passwordless SSH already working!');
      return { success: true, message: 'Passwordless SSH already configured and working' };
    }
    console.error('[Step 2] Passwordless SSH not working, will copy key');

    // Step 3: Copy SSH key
    console.error('\n[Step 3] Copying SSH key...');
    const copyResult = await this.copyKey(host, password, user);
    
    if (!copyResult.success) {
      console.error('[Step 3] Key copy failed:', copyResult);
      return { 
        success: false, 
        message: `Failed to copy SSH key: ${copyResult.error || 'Unknown error'}`,
        details: copyResult
      };
    }
    console.error('[Step 3] Key copy successful via', copyResult.method);

    // Step 4: Fix permissions on target
    console.error('\n[Step 4] Fixing permissions on target...');
    const fixCmd = `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no ${user}@${host} "chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; restorecon -R ~/.ssh 2>/dev/null; echo 'PERMISSIONS_FIXED'" 2>&1`;
    const fixResult = await this._exec(fixCmd);
    console.error('[Step 4] Fix result:', fixResult.stdout, fixResult.stderr);

    // Step 5: Wait and verify with retries
    console.error('\n[Step 5] Verifying passwordless SSH...');
    
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) {
        const delay = attempt * 2000;
        console.error(`[Step 5] Waiting ${delay/1000}s before attempt ${attempt}...`);
        await new Promise(r => setTimeout(r, delay));
      }
      
      const testResult = await this._testConnection(host, user, true);
      
      if (testResult.success) {
        console.error(`[Step 5] SUCCESS on attempt ${attempt}!`);
        return { 
          success: true, 
          message: `Full setup complete via ${copyResult.method}, passwordless SSH working`,
          method: copyResult.method,
          attempts: attempt
        };
      }
      
      console.error(`[Step 5] Attempt ${attempt} failed:`, testResult.error?.slice(-200));
      
      // On last attempt, try to diagnose the issue
      if (attempt === 5) {
        console.error('\n[Diagnosis] Checking target SSH configuration...');
        
        // Check if authorized_keys has our key
        const checkCmd = `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no ${user}@${host} "echo '---SSHD_CONFIG---'; grep -E '^(PubkeyAuthentication|AuthorizedKeysFile|PasswordAuthentication|PermitRootLogin)' /etc/ssh/sshd_config 2>/dev/null; echo '---AUTH_KEYS---'; ls -la ~/.ssh/ 2>/dev/null; echo '---KEY_CHECK---'; md5sum ~/.ssh/authorized_keys 2>/dev/null" 2>&1`;
        const diagResult = await this._exec(checkCmd);
        console.error('[Diagnosis] Target info:');
        console.error(diagResult.stdout);
        console.error(diagResult.stderr);
      }
    }

    return { 
      success: false, 
      message: 'Key copied but passwordless SSH verification failed after 5 attempts. Check SSH daemon config on target.',
      method: copyResult.method
    };
  }

  /**
   * Check if SSH connection is fully unlocked (passwordless access working)
   * @param {string} host - Target host IP
   * @param {string} user - SSH username (default: root)
   * @returns {Promise<Object>} Result with status and details
   */
  static async checkUnlocked(host, user = 'root') {
    console.error(`[checkUnlocked] Testing unlocked access to ${user}@${host}...`);
    
    // First check if host is reachable
    const reachable = await this.checkAccess(host);
    if (!reachable) {
      return {
        host,
        user,
        accessible: false,
        unlocked: false,
        message: 'Host not reachable on port 22'
      };
    }

    // Test passwordless connection
    const testResult = await this._testConnection(host, user, true);
    
    if (testResult.success) {
      return {
        host,
        user,
        accessible: true,
        unlocked: true,
        message: 'SSH fully unlocked - passwordless access working',
        details: testResult.output
      };
    }

    // Try to determine if SSH is accessible but not unlocked
    const sshTest = await this._exec(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes ${user}@${host} "exit" 2>&1`
    );
    
    if (sshTest.stderr.includes('Permission denied') || 
        sshTest.stderr.includes('password')) {
      return {
        host,
        user,
        accessible: true,
        unlocked: false,
        message: 'SSH accessible but requires password - not unlocked',
        details: sshTest.stderr
      };
    }
    
    if (sshTest.stderr.includes('Connection refused')) {
      return {
        host,
        user,
        accessible: false,
        unlocked: false,
        message: 'SSH port open but connection refused',
        details: sshTest.stderr
      };
    }

    return {
      host,
      user,
      accessible: true,
      unlocked: false,
      message: 'SSH accessible but unlock status unclear',
      details: testResult.error || sshTest.stderr
    };
  }

  /**
   * Ultra-fast TCP port check using native Node.js net module
   * No subprocess spawning - pure async I/O
   * @param {string} host - Target IP
   * @param {number} port - Port to check (default 22)
   * @param {number} timeout - Timeout in ms (default 500)
   * @returns {Promise<boolean>} True if port is open
   */
  static _tcpCheck(host, port = 22, timeout = 500) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let resolved = false;

      socket.setTimeout(timeout);

      socket.on('connect', () => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(true);
        }
      });

      socket.on('timeout', () => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(false);
        }
      });

      socket.on('error', () => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(false);
        }
      });

      socket.connect(port, host);
    });
  }

  /**
   * Fast check if host has SSH accessible using native TCP
   * @param {string} host - Target IP
   * @returns {Promise<Object|null>} Host info or null if not accessible
   */
  static async _fastCheckAccess(host) {
    const isOpen = await this._tcpCheck(host, 22, 500);
    
    if (isOpen) {
      return {
        host,
        accessible: true,
        unlocked: false,
        type: 'accessible'
      };
    }
    
    return null; // Not accessible, don't include
  }

  /**
   * Fast check if host is unlocked (passwordless) using native SSH
   * @param {string} host - Target IP
   * @param {string} user - SSH user
   * @returns {Promise<Object>} Updated host object with unlock status
   */
  static async _fastCheckUnlocked(host, user = 'root') {
    const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 -o PasswordAuthentication=no -o BatchMode=yes ${user}@${host} "echo 'UNLOCKED'" 2>&1`;
    
    const result = await this._exec(cmd, { timeout: 4000 });
    
    const isUnlocked = result.stdout.includes('UNLOCKED');
    
    return {
      host,
      accessible: true,
      unlocked: isUnlocked,
      type: isUnlocked ? 'unlocked' : 'accessible',
      user: user,
      message: isUnlocked ? 'SSH unlocked - passwordless access' : 'SSH accessible but requires password'
    };
  }

  /**
   * Get all local network IPs from network interfaces
   * @returns {Array<string>} Array of IP addresses with netmask
   */
  static _getLocalIPs() {
    const interfaces = networkInterfaces();
    const ips = [];
    
    for (const [name, nets] of Object.entries(interfaces)) {
      if (!nets) continue;
      for (const net of nets) {
        // Skip internal and non-IPv4 addresses
        if (net.family === 'IPv4' && !net.internal) {
          ips.push({ ip: net.address, netmask: net.netmask });
        }
      }
    }
    
    return ips;
  }

  /**
   * Generate IP range from IP and netmask
   * @param {string} ip - IP address
   * @param {string} netmask - Netmask
   * @returns {Array<string>} Array of IPs in range
   */
  static _generateIPRange(ip, netmask) {
    const ipParts = ip.split('.').map(Number);
    const maskParts = netmask.split('.').map(Number);
    
    const network = ipParts.map((octet, i) => octet & maskParts[i]);
    const broadcast = network.map((octet, i) => octet | (~maskParts[i] & 255));
    
    const ips = [];
    
    // Generate all IPs in range, skip network and broadcast addresses
    for (let a = network[0]; a <= broadcast[0]; a++) {
      for (let b = (a === network[0] ? network[1] : 0); b <= (a === broadcast[0] ? broadcast[1] : 255); b++) {
        for (let c = (a === network[0] && b === network[1] ? network[2] : 0); 
             c <= (a === broadcast[0] && b === broadcast[1] ? broadcast[2] : 255); c++) {
          for (let d = (a === network[0] && b === network[1] && c === network[2] ? network[3] + 1 : 1); 
               d <= (a === broadcast[0] && b === broadcast[1] && c === broadcast[2] ? broadcast[3] - 1 : 254); d++) {
            ips.push(`${a}.${b}.${c}.${d}`);
          }
        }
      }
    }
    
    return ips;
  }

  /**
   * Process IPs in batches with controlled concurrency
   * @param {Array} items - Array of items to process
   * @param {Function} fn - Async function to apply to each item
   * @param {number} concurrency - Max concurrent operations
   * @returns {Promise<Array>} Results array
   */
  static async _batchProcess(items, fn, concurrency = 1000) {
    const results = new Array(items.length);
    let index = 0;

    async function worker() {
      while (index < items.length) {
        const currentIndex = index++;
        try {
          results[currentIndex] = await fn(items[currentIndex]);
        } catch (error) {
          results[currentIndex] = null;
        }
      }
    }

    // Start workers
    const workers = Array(Math.min(concurrency, items.length))
      .fill(null)
      .map(() => worker());

    await Promise.all(workers);
    return results.filter(r => r !== null);
  }

  /**
   * Save scan state to file for persistence
   * @param {Object} state - Scan state to save
   */
  static async _saveScanState(state) {
    try {
      await mkdir(dirname(SCAN_STATE_FILE), { recursive: true });
      await writeFile(SCAN_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      console.error('[scanNetwork] Failed to save scan state:', error.message);
    }
  }

  /**
   * Load scan state from file
   * @returns {Promise<Object|null>} Saved state or null
   */
  static async _loadScanState() {
    try {
      const data = await readFile(SCAN_STATE_FILE, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if background scan is running (async version)
   * @returns {Promise<boolean>}
   */
  static async _isBackgroundScanRunning() {
    try {
      const pidData = await readFile(SCAN_PID_FILE, 'utf8');
      const pid = parseInt(pidData.trim());
      
      if (!pid || isNaN(pid)) return false;
      
      // Check if process is still alive
      try {
        process.kill(pid, 0);
        return true; // Process exists
      } catch (e) {
        // Process doesn't exist, clean up PID file
        try {
          await writeFile(SCAN_PID_FILE, '', 'utf8');
        } catch (err) {
          // Ignore cleanup errors
        }
        return false;
      }
    } catch (error) {
      return false; // No PID file or invalid
    }
  }

  /**
   * Clear scan PID file
   */
  static async _clearScanPid() {
    try {
      await writeFile(SCAN_PID_FILE, '', 'utf8');
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  /**
   * Perform the actual network scan (internal method)
   * @param {Object} config - Scan configuration
   * @returns {Promise<Object>} Scan results
   */
  static async _performScan(config = {}) {
    const startTime = Date.now();
    
    try {
      // Get all local interfaces and generate IP ranges
      const localIPs = this._getLocalIPs();
      const allIPs = new Set();
      
      for (const { ip, netmask } of localIPs) {
        console.error(`[scanNetwork] Interface: ${ip}/${netmask}`);
        const rangeIPs = this._generateIPRange(ip, netmask);
        rangeIPs.forEach(ip => allIPs.add(ip));
      }
      
      const ipArray = Array.from(allIPs);
      console.error(`[scanNetwork] Scanning ${ipArray.length} IPs with ${Math.min(config.concurrency || 1000, ipArray.length)} concurrent TCP connections...`);
      
      // DO NOT save initial state - keep the last completed result intact
      // The PID file itself indicates that a scan is in progress
      
      // PHASE 1: Native TCP check on ALL IPs simultaneously
      const accessResults = await this._batchProcess(
        ipArray,
        (ip) => this._fastCheckAccess(ip),
        config.concurrency || 1000
      );
      
      const accessibleHosts = accessResults.filter(r => r !== null);
      
      console.error(`[scanNetwork] Phase 1 complete in ${((Date.now() - startTime)/1000).toFixed(2)}s: ${accessibleHosts.length} hosts with SSH open`);
      
      if (accessibleHosts.length === 0) {
        const emptyResult = {
          success: true,
          timestamp: new Date().toISOString(),
          duration: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
          total_scanned: ipArray.length,
          accessible: 0,
          unlocked: 0,
          hosts: [],
          scanComplete: true,
          scanInProgress: false
        };
        await this._saveScanState(emptyResult);
        return emptyResult;
      }
      
      // PHASE 2: Check unlock status only for discovered hosts
      console.error(`[scanNetwork] Phase 2: Checking unlock status for ${accessibleHosts.length} hosts...`);
      
      const unlockResults = await Promise.all(
        accessibleHosts.map(host => this._fastCheckUnlocked(host.host))
      );
      
      const finalHosts = unlockResults
        .filter(r => r !== null)
        .sort((a, b) => b.unlocked - a.unlocked); // Unlocked first
      
      const unlockedCount = finalHosts.filter(h => h.unlocked).length;
      const accessibleCount = finalHosts.filter(h => !h.unlocked).length;
      
      const finalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.error(`\n[scanNetwork] Scan complete in ${finalDuration}s`);
      console.error(`[scanNetwork] Total scanned: ${ipArray.length}`);
      console.error(`[scanNetwork] SSH accessible: ${accessibleCount}`);
      console.error(`[scanNetwork] SSH unlocked: ${unlockedCount}`);
      
      const finalResult = {
        success: true,
        timestamp: new Date().toISOString(),
        duration: `${finalDuration}s`,
        total_scanned: ipArray.length,
        accessible: accessibleCount,
        unlocked: unlockedCount,
        hosts: finalHosts,
        scanComplete: true,
        scanInProgress: false
      };
      
      // Save final result
      await this._saveScanState(finalResult);
      
      return finalResult;
    } finally {
      // Always clear PID when scan finishes
      await this._clearScanPid();
    }
  }

  /**
   * Start a truly detached background scan using a separate process
   * @param {Object} config - Scan configuration
   */
  static _startDetachedBackgroundScan(config = {}) {
    // Create a temporary script that will run the scan
    const scanScript = `
      import('${__filename.replace(/'/g, "\\'")}').then(async (module) => {
        const SSH = module.default;
        try {
          // Write PID file
          const { writeFile } = await import('fs/promises');
          const { homedir } = await import('os');
          const { join } = await import('path');
          const pidFile = join(homedir(), '.ssh-lab-scan.pid');
          await writeFile(pidFile, process.pid.toString(), 'utf8');
          
          // Perform scan
          await SSH._performScan(${JSON.stringify(config)});
          
          // Clean up PID file
          await writeFile(pidFile, '', 'utf8');
          process.exit(0);
        } catch (error) {
          // Clean up PID file on error too
          try {
            const { writeFile } = await import('fs/promises');
            const { homedir } = await import('os');
            const { join } = await import('path');
            const pidFile = join(homedir(), '.ssh-lab-scan.pid');
            await writeFile(pidFile, '', 'utf8');
          } catch (e) {}
          process.exit(1);
        }
      });
    `;
    
    // Spawn a completely detached child process
    const child = spawn('node', ['--input-type=module', '-e', scanScript], {
      detached: true,
      stdio: 'ignore', // Detach completely - no output to parent
      env: { ...process.env } // Inherit environment
    });
    
    // Detach the child so it runs independently
    child.unref();
    
    return child;
  }

  /**
   * Scan network for SSH hosts with optional background mode
   * 
   * @param {Object} config - Configuration options
   * @param {boolean} config.background - Enable background scanning mode
   * @param {boolean} config.forceNew - Force start a new scan even if one is running
   * @param {number} config.concurrency - Max concurrent TCP connections (default: 1000)
   * @param {number} config.cacheTimeout - Cache timeout in ms for background mode (default: 0 = always start new scan when no scan running)
   * 
   * Background mode behavior:
   * - Returns instantly with last completed result (or empty if none)
   * - Spawns completely detached process for scan (only if no scan is running)
   * - Terminal is free immediately
   * - Results persisted to ~/.ssh-lab-scan-state.json
   * - NEVER starts a new scan if one is already running
   * - Last completed result is preserved until a new scan finishes
   * 
   * @returns {Promise<Object>} Scan results (instant return in background mode)
   */
  static async scanNetwork(config = {}) {
    // Default config
    const {
      background = false,
      forceNew = false,
      concurrency = 1000,
      cacheTimeout = 0
    } = config;

    // If background mode is disabled, run normal synchronous scan
    if (!background) {
      return await this._performScan({ concurrency });
    }

    // BACKGROUND MODE - Return instantly!
    
    // Load saved state (last completed scan result)
    const savedState = await this._loadScanState();
    
    // Check if a scan is currently running (via PID file)
    const isScanRunning = await this._isBackgroundScanRunning();
    
    // Determine what to return immediately
    let returnState;
    
    if (isScanRunning) {
      // Scan is in progress - return LAST COMPLETED result if available, otherwise empty
      if (savedState && savedState.scanComplete) {
        // Return last completed result with in-progress indicator
        const cacheAge = Date.now() - new Date(savedState.timestamp).getTime();
        returnState = { 
          ...savedState, 
          scanInProgress: true,
          cacheAge: `${(cacheAge/1000).toFixed(1)}s`
        };
      } else {
        returnState = {
          success: true,
          timestamp: new Date().toISOString(),
          duration: '0s',
          total_scanned: 0,
          accessible: 0,
          unlocked: 0,
          hosts: [],
          scanComplete: false,
          scanInProgress: true
        };
      }
      
      // DON'T start a new scan - one is already running
      return returnState;
    }
    
    // No scan is running
    if (savedState && savedState.scanComplete) {
      // We have a completed scan result - return it
      const cacheAge = Date.now() - new Date(savedState.timestamp).getTime();
      returnState = { ...savedState, cacheAge: `${(cacheAge/1000).toFixed(1)}s` };
    } else {
      // No saved state - return empty
      returnState = {
        success: true,
        timestamp: new Date().toISOString(),
        duration: '0s',
        total_scanned: 0,
        accessible: 0,
        unlocked: 0,
        hosts: [],
        scanComplete: false,
        scanInProgress: true
      };
    }

    // Check if we should start a new scan
    const shouldStartNewScan = () => {
      // If forceNew, always start
      if (forceNew) return true;
      
      // Check cache timeout
      if (cacheTimeout > 0 && savedState && savedState.scanComplete) {
        const cacheAge = Date.now() - new Date(savedState.timestamp).getTime();
        if (cacheAge < cacheTimeout) return false;
      }
      
      // No scan running - always start a new one
      return true;
    };

    // Start new background scan if needed
    if (shouldStartNewScan()) {
      this._startDetachedBackgroundScan({ concurrency });
    }

    // Return immediately - terminal is free
    return returnState;
  }

  /**
   * Force stop any running background scan
   */
  static async stopBackgroundScan() {
    try {
      const pidData = await readFile(SCAN_PID_FILE, 'utf8');
      const pid = parseInt(pidData.trim());
      
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (e) {
          // Process might already be dead
        }
      }
      
      await this._clearScanPid();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get current scan status without starting a new scan
   * @returns {Promise<Object>} Current scan state
   */
  static async getScanStatus() {
    const savedState = await this._loadScanState();
    const isScanRunning = await this._isBackgroundScanRunning();
    
    return {
      scanInProgress: isScanRunning,
      lastResult: savedState || null
    };
  }

  /**
   * Clear saved scan state
   */
  static async clearScanCache() {
    try {
      await writeFile(SCAN_STATE_FILE, JSON.stringify({}, null, 2), 'utf8');
      await this._clearScanPid();
      return true;
    } catch (error) {
      return false;
    }
  }
}

// CLI interface - MAINTAINING 100% ORIGINAL INTERFACE COMPATIBILITY
if (import.meta.url === `file://${process.argv[1]}`) {
  const [,, method, ...args] = process.argv;

  const usage = `
Usage: node ssh-lab.mjs <method> [args]

Methods:
  setup                       One-time SSH config + key generation
  copy <host> <password> [user]   Copy SSH key to remote host
  check <host> [port]             Check if SSH port is open
  full <host> <password> [user]   Run setup + copyKey + verify
  unlock-check <host> [user]      Check if SSH is fully unlocked (passwordless)
  scan                            Scan all network interfaces for SSH hosts
  scan-status                    Get current background scan status
  scan-stop                      Stop running background scan
  scan-clear                     Clear scan cache

Scan Options (for 'scan' method):
  --background          Enable background scanning mode (returns instantly, scan runs in separate process)
  --force              Force start new scan even if one is running or cache fresh
  --concurrency=<n>    Max concurrent connections (default: 1000)

Examples:
  node ssh-lab.mjs setup
  node ssh-lab.mjs copy 10.10.10.10 password123 root
  node ssh-lab.mjs check 10.10.10.10
  node ssh-lab.mjs full 10.10.10.10 password123 root
  node ssh-lab.mjs unlock-check 10.10.10.10 root
  node ssh-lab.mjs scan
  node ssh-lab.mjs scan --background
  node ssh-lab.mjs scan --background --force
  node ssh-lab.mjs scan-status
`;

  if (!method) {
    console.log(usage);
    process.exit(1);
  }

  (async () => {
    try {
      let result;
      
      switch (method) {
        case 'setup':
          result = await SSH.setup();
          break;
          
        case 'copy': {
          const [host, password, user = 'root'] = args;
          if (!host || !password) {
            console.error('Usage: node ssh-lab.mjs copy <host> <password> [user]');
            process.exit(1);
          }
          result = await SSH.copyKey(host, password, user);
          break;
        }
          
        case 'check': {
          const [host, port = 22] = args;
          if (!host) {
            console.error('Usage: node ssh-lab.mjs check <host> [port]');
            process.exit(1);
          }
          result = await SSH.checkAccess(host, parseInt(port));
          break;
        }
          
        case 'full': {
          const [host, password, user = 'root'] = args;
          if (!host || !password) {
            console.error('Usage: node ssh-lab.mjs full <host> <password> [user]');
            process.exit(1);
          }
          result = await SSH.fullSetup(host, password, user);
          break;
        }

        case 'unlock-check': {
          const [host, user = 'root'] = args;
          if (!host) {
            console.error('Usage: node ssh-lab.mjs unlock-check <host> [user]');
            process.exit(1);
          }
          result = await SSH.checkUnlocked(host, user);
          break;
        }

        case 'scan': {
          // Parse scan-specific arguments from args (maintaining original interface)
          const scanConfig = {
            background: args.includes('--background'),
            forceNew: args.includes('--force')
          };
          
          // Parse concurrency if specified
          const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
          if (concurrencyArg) {
            scanConfig.concurrency = parseInt(concurrencyArg.split('=')[1]) || 1000;
          }
          
          result = await SSH.scanNetwork(scanConfig);
          break;
        }

        case 'scan-status': {
          result = await SSH.getScanStatus();
          break;
        }

        case 'scan-stop': {
          const stopped = await SSH.stopBackgroundScan();
          result = { success: stopped, message: stopped ? 'Scan stopped' : 'No scan running' };
          break;
        }

        case 'scan-clear': {
          const cleared = await SSH.clearScanCache();
          result = { success: cleared, message: cleared ? 'Cache cleared' : 'Failed to clear cache' };
          break;
        }
          
        default:
          console.error(`Unknown method: ${method}`);
          console.log(usage);
          process.exit(1);
      }
      
      // Output final result as JSON (maintaining original output format)
      console.log(JSON.stringify(result, null, 2));
      
      // Exit with appropriate code
      process.exit(result.success ? 0 : 1);
      
    } catch (error) {
      console.error('Fatal error:', error.message);
      process.exit(1);
    }
  })();
}