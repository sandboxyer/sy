#!/usr/bin/env node

// ============================================================================
// QEMU VM IP Runner - Run commands on all saved VM instances
// ============================================================================

import { exec } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// --- Configuration ---
const IP_FILE = '/tmp/qemu_vm_ips.txt';
const VM_DIR_PATTERN = /-vm-/;
const DEFAULT_SSH_PASSWORD = '123';

/**
 * Parse the IP mapping file to get VM name -> IP mappings
 * @returns {Promise<Map<string, string>>} Map of VM names to IPs
 */
async function parseIpFile() {
  const ipMap = new Map();
  
  try {
    const content = await readFile(IP_FILE, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      const [vmName, ip] = line.split('=');
      if (vmName && ip) {
        ipMap.set(vmName.trim(), ip.trim());
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`Warning: Could not read IP file: ${error.message}`);
    }
  }
  
  return ipMap;
}

/**
 * Discover VMs by scanning the current directory
 * @returns {Promise<string[]>} List of VM directory names
 */
async function discoverVmDirectories() {
  try {
    const entries = await readdir(process.cwd());
    return entries.filter(entry => VM_DIR_PATTERN.test(entry));
  } catch (error) {
    console.error(`Error scanning for VMs: ${error.message}`);
    return [];
  }
}

/**
 * Extract OS type from VM directory name
 * @param {string} dirName - Directory name like "alpine-vm-mytest"
 * @returns {string} OS type (alpine or ubuntu)
 */
function getOsType(dirName) {
  if (dirName.startsWith('alpine-')) return 'alpine';
  if (dirName.startsWith('noble-')) return 'ubuntu';
  return 'unknown';
}

/**
 * Get the list of all saved VMs with their IPs
 * @returns {Promise<Array<{name: string, ip: string, os: string, dir: string}>>}
 */
async function getAllVms() {
  const ipMap = await parseIpFile();
  const dirs = await discoverVmDirectories();
  const vms = [];
  
  for (const dir of dirs) {
    const vmName = dir.replace(VM_DIR_PATTERN, '').split('-vm-').pop();
    const os = getOsType(dir);
    const ip = ipMap.get(vmName) || null;
    
    if (vmName) {
      vms.push({
        name: vmName,
        ip: ip,
        os: os,
        dir: dir,
      });
    }
  }
  
  return vms;
}

/**
 * Check if an IP is reachable via ping
 * @param {string} ip - IP address to check
 * @returns {Promise<boolean>}
 */
async function isReachable(ip) {
  try {
    const pingCmd = process.platform === 'darwin' 
      ? `ping -c 1 -W 1000 ${ip}`
      : `ping -c 1 -w 1 ${ip}`;
    
    await execAsync(pingCmd, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a command on a VM via SSH
 * @param {string} ip - VM IP address
 * @param {string} command - Command to execute
 * @param {string} password - SSH password
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function executeOnVm(ip, command, password = DEFAULT_SSH_PASSWORD) {
  const sshCmd = `sshpass -p '${password}' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 root@${ip} '${command}'`;
  
  return execAsync(sshCmd, { timeout: 30000 });
}

/**
 * Run a command on a single VM with error handling
 * @param {object} vm - VM object
 * @param {string} command - Command to execute
 * @returns {Promise<{vm: object, success: boolean, output: string, error: string}>}
 */
async function runOnSingleVm(vm, command) {
  const result = {
    vm: vm,
    success: false,
    output: '',
    error: '',
  };
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`VM: ${vm.name} (${vm.os})`);
  console.log(`IP: ${vm.ip || 'Not assigned'}`);
  console.log(`${'='.repeat(60)}`);
  
  if (!vm.ip) {
    result.error = 'No IP assigned';
    console.log(`❌ ${result.error}`);
    return result;
  }
  
  // Check if reachable
  process.stdout.write(`Checking connectivity to ${vm.ip}... `);
  const reachable = await isReachable(vm.ip);
  
  if (!reachable) {
    result.error = 'VM is not reachable';
    console.log('❌ Not reachable');
    return result;
  }
  console.log('✅ Reachable');
  
  // Execute command
  process.stdout.write(`Executing command... `);
  try {
    const { stdout, stderr } = await executeOnVm(vm.ip, command);
    result.success = true;
    result.output = stdout;
    console.log('✅ Success');
    
    if (stdout) {
      console.log('\n--- Output ---');
      console.log(stdout);
    }
    
    if (stderr) {
      console.log('\n--- Stderr ---');
      console.log(stderr);
    }
  } catch (error) {
    result.error = error.message;
    console.log(`❌ Failed: ${error.message}`);
  }
  
  return result;
}

/**
 * Run a command on all saved VMs
 * @param {string} command - Shell command to execute on each VM
 * @returns {Promise<void>}
 */
async function runOnAllVms(command) {
  console.log('🔍 Discovering saved VMs...');
  const vms = await getAllVms();
  
  if (vms.length === 0) {
    console.log('No saved VMs found.');
    return;
  }
  
  console.log(`\nFound ${vms.length} VM(s):`);
  vms.forEach(vm => {
    const ipInfo = vm.ip ? ` (IP: ${vm.ip})` : ' (No IP)';
    console.log(`  • ${vm.name} [${vm.os}]${ipInfo}`);
  });
  
  console.log(`\n🚀 Executing on all VMs: "${command}"\n`);
  
  const results = [];
  
  for (const vm of vms) {
    const result = await runOnSingleVm(vm, command);
    results.push(result);
  }
  
  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`✅ Successful: ${successful.length}/${vms.length}`);
  if (successful.length > 0) {
    successful.forEach(r => console.log(`   ${r.vm.name} (${r.vm.ip})`));
  }
  
  console.log(`❌ Failed: ${failed.length}/${vms.length}`);
  if (failed.length > 0) {
    failed.forEach(r => console.log(`   ${r.vm.name} - ${r.error}`));
  }
}

/**
 * Start all saved VMs sequentially using the bash script
 * @returns {Promise<void>}
 */
async function startAllVms() {
  console.log('🔍 Discovering saved VMs...');
  const vms = await getAllVms();
  
  if (vms.length === 0) {
    console.log('No saved VMs found.');
    return;
  }
  
  console.log(`\nFound ${vms.length} VM(s) to start:\n`);
  
  for (const vm of vms) {
    console.log(`Starting ${vm.name} (${vm.os})...`);
    
    try {
      const cmd = `bash qemu.sh --${vm.os} ${vm.name}`;
      console.log(`  Executing: ${cmd}`);
      
      // Note: This will block until the VM exits unless you daemonize it
      const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
      
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);
      
      console.log(`✅ Started ${vm.name}\n`);
    } catch (error) {
      console.error(`❌ Failed to start ${vm.name}: ${error.message}\n`);
    }
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

/**
 * Show help message
 */
function showHelp() {
  console.log(`
QEMU VM IP Runner - Execute commands on saved VMs
===================================================

USAGE: node qemu-runner.mjs [COMMAND] [OPTIONS]

COMMANDS:
  list                        List all saved VMs with their IPs
  exec <shell-command>        Execute a command on all VMs
  start                       Start all saved VMs (calls qemu.sh for each)
  --help, -h                  Show this help

EXAMPLES:
  node qemu-runner.mjs list
  node qemu-runner.mjs exec "uptime"
  node qemu-runner.mjs exec "df -h"
  node qemu-runner.mjs exec "cat /etc/os-release"
  node qemu-runner.mjs start

REQUIREMENTS:
  - sshpass (for password-based SSH)
  - The VMs must be reachable at their assigned IPs
`);
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp();
    return;
  }
  
  const command = args[0];
  
  switch (command) {
    case 'list': {
      const vms = await getAllVms();
      
      if (vms.length === 0) {
        console.log('No saved VMs found.');
      } else {
        console.log(`\nSaved VMs (${vms.length}):\n`);
        console.log('Name'.padEnd(25) + 'OS'.padEnd(12) + 'IP'.padEnd(18) + 'Directory');
        console.log('-'.repeat(75));
        
        for (const vm of vms) {
          console.log(
            vm.name.padEnd(25) + 
            vm.os.padEnd(12) + 
            (vm.ip || 'Not assigned').padEnd(18) + 
            vm.dir
          );
        }
      }
      break;
    }
    
    case 'exec': {
      if (args.length < 2) {
        console.error('ERROR: exec requires a command argument');
        console.error('Usage: node qemu-runner.mjs exec "your command here"');
        process.exit(1);
      }
      
      const cmdToRun = args.slice(1).join(' ');
      await runOnAllVms(cmdToRun);
      break;
    }
    
    case 'start': {
      await startAllVms();
      break;
    }
    
    default: {
      console.error(`Unknown command: ${command}`);
      console.error('Use --help for usage information');
      process.exit(1);
    }
  }
}

// --- Run ---
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
