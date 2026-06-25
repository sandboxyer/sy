// qemu-interface.mjs
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { 
    readFile, writeFile, access, readdir, stat, unlink, rm 
} from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { networkInterfaces } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const QEMU_SCRIPT_PATH = resolve(__dirname, 'qemu.sh');
const QEMU_SCRIPT_DIR = dirname(QEMU_SCRIPT_PATH);

const VM_IPS_FILE = '/tmp/qemu_vm_ips.txt';
const IP_LOCK_DIR = '/tmp/qemu_vm_ip_locks';
const DOWNLOAD_LOCK_DIR = '/tmp/qemu_vm_download_locks';

const managedProcesses = new Map();

class Qemu {
    // ==================== PRIVATE HELPERS ====================

    static async #ensureScript() {
        try {
            await access(QEMU_SCRIPT_PATH);
            return true;
        } catch {
            try {
                await exec(`chmod +x "${QEMU_SCRIPT_PATH}"`);
                await access(QEMU_SCRIPT_PATH);
                return true;
            } catch (err) {
                throw new Error(`Cannot access qemu.sh at: ${QEMU_SCRIPT_PATH}`);
            }
        }
    }

    static async #exec(command, options = {}) {
        const {
            timeout = 30000,
            maxBuffer = 50 * 1024 * 1024,
            cwd = QEMU_SCRIPT_DIR,
            env = {}
        } = options;

        return new Promise((resolve) => {
            const child = exec(
                command,
                { timeout, maxBuffer, cwd, env: { ...process.env, ...env }, shell: '/bin/bash' },
                (error, stdout, stderr) => {
                    resolve({
                        success: !error,
                        exitCode: error?.code || 0,
                        stdout: stdout?.trim() || '',
                        stderr: stderr?.trim() || '',
                        error: error?.message || null
                    });
                }
            );
        });
    }

    static async #getVMIPs() {
        const ips = new Map();
        try {
            const content = await readFile(VM_IPS_FILE, 'utf-8');
            const lines = content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx === -1) continue;
                const name = trimmed.substring(0, eqIdx).trim();
                const ip = trimmed.substring(eqIdx + 1).trim();
                if (name && ip) ips.set(name, ip);
            }
        } catch {}
        return ips;
    }

    static async #getIPLocks() {
        const locks = [];
        try {
            const entries = await readdir(IP_LOCK_DIR);
            for (const entry of entries) {
                if (entry.startsWith('ip_')) locks.push(entry.substring(3));
            }
        } catch {}
        return locks;
    }

    static async #findIPForVM(vmName, vmIPs) {
        if (vmIPs.has(vmName)) return vmIPs.get(vmName);

        for (const [key, ip] of vmIPs) {
            if (key.includes(vmName) || vmName.includes(key)) return ip;
        }

        if (vmName.startsWith('tmp.')) {
            for (const [key, ip] of vmIPs) {
                if (key.startsWith('temp-') || key.includes('tmp')) return ip;
            }
        }

        return null;
    }

    static async #resolveIPFromARP(tapInterface, vmIPs) {
        if (!tapInterface) return null;

        try {
            const { stdout: tapMac } = await this.#exec(
                `cat /sys/class/net/${tapInterface}/address 2>/dev/null`,
                { timeout: 2000, cwd: '/tmp' }
            );
            if (tapMac) {
                const mac = tapMac.trim().toLowerCase();
                const { stdout: arpOutput } = await this.#exec(
                    `arp -an 2>/dev/null`,
                    { timeout: 2000, cwd: '/tmp' }
                );
                if (arpOutput) {
                    for (const line of arpOutput.split('\n')) {
                        if (line.toLowerCase().includes(mac)) {
                            const ipMatch = line.match(/\((\d+\.\d+\.\d+\.\d+)\)/);
                            if (ipMatch) return ipMatch[1];
                        }
                    }
                }
            }
        } catch {}

        for (const [name, ip] of vmIPs) {
            try {
                const { stdout: pingResult } = await this.#exec(
                    `ping -c 1 -W 1 ${ip} 2>/dev/null >/dev/null && echo "ALIVE"`,
                    { timeout: 2000, cwd: '/tmp' }
                );
                if (pingResult.includes('ALIVE')) {
                    const { stdout: arpResult } = await this.#exec(
                        `arp -an ${ip} 2>/dev/null`,
                        { timeout: 1000, cwd: '/tmp' }
                    );
                    if (arpResult.includes(tapInterface) || arpResult.includes('qemu')) {
                        return ip;
                    }
                }
            } catch {}
        }

        return null;
    }

    static async #findAllQemuProcesses() {
        const processes = [];

        try {
            const { stdout } = await this.#exec(
                'ps aux | grep -E "qemu-system-x86_64|qemu-system" | grep -v grep',
                { timeout: 5000, cwd: '/tmp' }
            );

            if (!stdout) return processes;

            const lines = stdout.split('\n');
            const vmIPs = await this.#getVMIPs();
            const ipLocks = await this.#getIPLocks();

            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 11) continue;

                const pid = parseInt(parts[1]);
                const command = parts.slice(10).join(' ');

                const processInfo = {
                    user: parts[0],
                    pid,
                    cpu: parts[2],
                    mem: parts[3],
                    startTime: parts[8],
                    command
                };

                const cmdStr = processInfo.command;

                const imgMatch = cmdStr.match(/-drive\s+file=([^,]+)/);
                if (imgMatch) {
                    processInfo.imageFile = imgMatch[1];
                    const dirName = dirname(imgMatch[1]);
                    const baseDir = basename(dirName);

                    const nameMatch = baseDir.match(/-vm-(.+)$/);
                    if (nameMatch) {
                        processInfo.vmName = nameMatch[1];
                    } else {
                        const tempMatch = baseDir.match(/(?:alpine|noble)-vm-(tmp\.[A-Za-z0-9]+)$/);
                        if (tempMatch) {
                            processInfo.vmName = tempMatch[1];
                        } else {
                            processInfo.vmName = baseDir;
                        }
                    }

                    if (baseDir.includes('alpine') || cmdStr.includes('alpine')) {
                        processInfo.os = 'alpine';
                    } else if (baseDir.includes('noble') || baseDir.includes('ubuntu')) {
                        processInfo.os = 'ubuntu';
                    }
                }

                const memMatch = cmdStr.match(/-m\s+(\d+)/);
                if (memMatch) processInfo.memory = parseInt(memMatch[1]);

                const cpuMatch = cmdStr.match(/-smp\s+(\d+)/);
                if (cpuMatch) processInfo.cpu = parseInt(cpuMatch[1]);

                processInfo.bridgeMode = cmdStr.includes('-netdev tap');

                const tapMatch = cmdStr.match(/ifname=([^\s,]+)/);
                if (tapMatch) processInfo.tapInterface = tapMatch[1];

                const portMatch = cmdStr.match(/hostfwd=tcp::(\d+)-:22/);
                if (portMatch) processInfo.sshPort = parseInt(portMatch[1]);

                processInfo.kvm = cmdStr.includes('-enable-kvm');
                processInfo.managed = Array.from(managedProcesses.values())
                    .some(p => p.pid === processInfo.pid);

                let vmIP = null;

                if (processInfo.vmName) {
                    vmIP = await this.#findIPForVM(processInfo.vmName, vmIPs);
                }

                if (!vmIP && processInfo.tapInterface) {
                    vmIP = await this.#resolveIPFromARP(processInfo.tapInterface, vmIPs);
                }

                if (!vmIP && processInfo.tapInterface) {
                    for (const ip of ipLocks) {
                        try {
                            const { stdout: pingResult } = await this.#exec(
                                `ping -c 1 -W 1 ${ip} 2>/dev/null >/dev/null && echo "ALIVE"`,
                                { timeout: 2000, cwd: '/tmp' }
                            );
                            if (pingResult.includes('ALIVE')) {
                                const { stdout: arpResult } = await this.#exec(
                                    `arp -an ${ip} 2>/dev/null`,
                                    { timeout: 1000, cwd: '/tmp' }
                                );
                                if (arpResult.includes(processInfo.tapInterface)) {
                                    vmIP = ip;
                                    break;
                                }
                            }
                        } catch {}
                    }
                }

                processInfo.network = {
                    bridgeMode: processInfo.bridgeMode,
                    vmIP,
                    sshHost: vmIP || 'localhost',
                    sshPort: processInfo.sshPort || (processInfo.bridgeMode ? '22' : '2222'),
                    tapInterface: processInfo.tapInterface || null
                };

                processes.push(processInfo);
            }
        } catch {}

        return processes;
    }

    static async #findVMDirectories() {
        const directories = [];
        try {
            const entries = await readdir(QEMU_SCRIPT_DIR);
            for (const entry of entries) {
                if (!entry.includes('-vm-')) continue;
                const fullPath = join(QEMU_SCRIPT_DIR, entry);
                try {
                    const dirStat = await stat(fullPath);
                    if (!dirStat.isDirectory()) continue;

                    let os = 'unknown';
                    if (entry.startsWith('alpine')) os = 'alpine';
                    else if (entry.startsWith('noble')) os = 'ubuntu';

                    const nameMatch = entry.match(/-vm-(.+)$/);
                    const vmName = nameMatch ? nameMatch[1] : entry;

                    let imageFile = null;
                    let diskSize = null;
                    let isoFile = null;

                    try {
                        const files = await readdir(fullPath);
                        for (const file of files) {
                            if (file.endsWith('.qcow2') || file.endsWith('.img')) {
                                imageFile = join(fullPath, file);
                                try {
                                    const { stdout } = await this.#exec(
                                        `qemu-img info "${imageFile}"`,
                                        { timeout: 5000 }
                                    );
                                    const sizeMatch = stdout.match(/virtual size:\s+(\d+\s*\w+)/i);
                                    if (sizeMatch) diskSize = sizeMatch[1];
                                } catch {}
                                break;
                            }
                        }
                        const iso = files.find(f => f.endsWith('-cloud-init.iso'));
                        if (iso) isoFile = join(fullPath, iso);
                    } catch {}

                    directories.push({
                        directory: fullPath,
                        vmName,
                        os,
                        imageFile,
                        diskSize,
                        isoFile,
                        created: dirStat.birthtime?.toISOString() || dirStat.mtime.toISOString()
                    });
                } catch {}
            }
        } catch {}
        return directories;
    }

    // ==================== PUBLIC API ====================

    static async startVM(config = {}) {
        const {
            os = 'alpine',
            name = `vm_${Date.now().toString(36)}`,
            size = '5G',
            memory,
            cpu = 1,
            port,
            bridge = true,
            kvm = true,
            sshSetup = true,
            retryAttempts = 18,
            retryDelay = 3
        } = config;

        const args = [`--${os}`, name];
        if (size) args.push('--size', size);
        if (memory) args.push('--memory', String(memory));
        if (cpu) args.push('--cpu', String(cpu));
        if (port) args.push('--port', String(port));
        if (!bridge) args.push('--no-bridge');
        if (!kvm) args.push('--no-kvm');
        if (!sshSetup) args.push('--no-ssh-setup');
        if (retryAttempts) args.push('--retry-attempts', String(retryAttempts));
        if (retryDelay) args.push('--retry-delay', String(retryDelay));

        try {
            await this.#ensureScript();

            const timestamp = Date.now();
            const logFile = `/tmp/qemu_vm_${name}_${timestamp}.log`;
            const pidFile = `/tmp/qemu_vm_${name}.pid`;

            const child = spawn(
                'nohup',
                ['bash', QEMU_SCRIPT_PATH, ...args],
                {
                    detached: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    cwd: QEMU_SCRIPT_DIR
                }
            );

            const pid = child.pid;
            await writeFile(pidFile, String(pid)).catch(() => {});

            if (child.stdout && child.stderr) {
                const logStream = createWriteStream(logFile, { flags: 'a' });
                child.stdout.pipe(logStream);
                child.stderr.pipe(logStream);
            }

            const processInfo = {
                pid, vmId: name, vmName: name, logFile, pidFile,
                startedAt: new Date().toISOString(), args
            };

            managedProcesses.set(name, processInfo);
            child.unref();

            await new Promise(resolve => setTimeout(resolve, 5000));

            const vmIPs = await this.#getVMIPs();
            let vmIP = vmIPs.get(name) || null;

            let logContent = '';
            try { logContent = await readFile(logFile, 'utf-8'); } catch {}

            const bridgeEnabled = logContent.includes('BRIDGE NETWORKING ENABLED');

            if (!vmIP) {
                const ipMatch = logContent.match(/VM IP:\s+(\S+)/);
                if (ipMatch) vmIP = ipMatch[1];
            }

            let tapInterface = null;
            const tapMatch = logContent.match(/TAP:\s+(\S+)/);
            if (tapMatch) tapInterface = tapMatch[1];

            return {
                success: true,
                vmName: name,
                os,
                pid,
                startedAt: processInfo.startedAt,
                logFile,
                pidFile,
                network: {
                    bridgeEnabled,
                    vmIP,
                    sshHost: (bridgeEnabled && vmIP) ? vmIP : 'localhost',
                    sshPort: (bridgeEnabled && vmIP) ? '22' : (port || '2222'),
                    tapInterface
                },
                config: { size, memory: memory || 'auto', cpu, bridge, kvm, sshSetup },
                managed: true
            };

        } catch (error) {
            return { success: false, vmName: name, error: error.message };
        }
    }

    static async stopVM(identifier) {
        const allVMs = await this.listVMs();
        const vm = allVMs.running.find(v =>
            v.vmName === String(identifier) || v.pid === parseInt(identifier)
        );

        if (!vm) {
            return { success: false, identifier, error: 'VM not found or not running' };
        }

        try {
            process.kill(vm.pid, 'SIGTERM');
            await new Promise(resolve => setTimeout(resolve, 3000));
            try { process.kill(vm.pid, 'SIGKILL'); } catch {}
            managedProcesses.delete(vm.vmName);
            return { success: true, vmName: vm.vmName, pid: vm.pid };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    static async stopAllVMs() {
        const processes = await this.#findAllQemuProcesses();
        const results = [];

        for (const proc of processes) {
            const result = await this.stopVM(proc.pid);
            results.push({ pid: proc.pid, vmName: proc.vmName, success: result.success });
        }

        return {
            stopped: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            total: results.length,
            details: results
        };
    }

    static async listVMs() {
        const result = {
            timestamp: new Date().toISOString(),
            running: [],
            persistent: [],
            all: []
        };

        try {
            const runningProcesses = await this.#findAllQemuProcesses();
            const vmIPs = await this.#getVMIPs();
            const vmDirs = await this.#findVMDirectories();

            for (const proc of runningProcesses) {
                const vmInfo = {
                    vmName: proc.vmName || `unknown_${proc.pid}`,
                    pid: proc.pid,
                    os: proc.os || 'unknown',
                    memory: proc.memory,
                    cpu: proc.cpu,
                    bridgeMode: proc.bridgeMode,
                    kvm: proc.kvm,
                    managed: proc.managed,
                    running: true,
                    startTime: proc.startTime,
                    imageFile: proc.imageFile,
                    network: {
                        bridgeMode: proc.bridgeMode,
                        vmIP: proc.network?.vmIP || null,
                        sshHost: proc.network?.sshHost || 'localhost',
                        sshPort: proc.network?.sshPort || '22',
                        tapInterface: proc.tapInterface || null
                    }
                };

                try {
                    const { stdout } = await this.#exec(
                        `ls -t /tmp/qemu_vm_${vmInfo.vmName}_*.log 2>/dev/null | head -1`
                    );
                    if (stdout) vmInfo.logFile = stdout.trim();
                } catch {}

                result.running.push(vmInfo);
            }

            for (const dir of vmDirs) {
                const isRunning = result.running.some(r => r.vmName === dir.vmName);
                const vmInfo = {
                    vmName: dir.vmName,
                    os: dir.os,
                    directory: dir.directory,
                    imageFile: dir.imageFile,
                    diskSize: dir.diskSize,
                    isoFile: dir.isoFile,
                    created: dir.created,
                    running: isRunning,
                    ip: vmIPs.get(dir.vmName) || null
                };

                if (isRunning) {
                    const runningInfo = result.running.find(r => r.vmName === dir.vmName);
                    Object.assign(vmInfo, {
                        pid: runningInfo.pid,
                        memory: runningInfo.memory,
                        cpu: runningInfo.cpu,
                        bridgeMode: runningInfo.bridgeMode,
                        kvm: runningInfo.kvm,
                        network: runningInfo.network,
                        logFile: runningInfo.logFile
                    });
                }

                result.persistent.push(vmInfo);
            }

            const allVMs = new Map();
            for (const vm of result.running) {
                if (vm.vmName) allVMs.set(vm.vmName, { ...vm, source: 'running' });
            }
            for (const vm of result.persistent) {
                if (!allVMs.has(vm.vmName)) {
                    allVMs.set(vm.vmName, { ...vm, source: 'persistent' });
                }
            }
            result.all = Array.from(allVMs.values());

            result.network = (() => {
                const interfaces = networkInterfaces();
                const bridges = [], taps = [], physical = [];
                for (const [name, addrs] of Object.entries(interfaces)) {
                    if (!addrs || addrs.length === 0) continue;
                    const info = { name, addresses: addrs.map(a => ({ address: a.address, netmask: a.netmask, mac: a.mac })) };
                    if (name.startsWith('qemubr')) bridges.push(info);
                    else if (name.startsWith('qemutap')) taps.push(info);
                    else if (name.match(/^(eth|ens|enp|wlan|wlp)/)) physical.push(info);
                }
                return { bridges, taps, physical };
            })();

            result.summary = {
                total: result.all.length,
                running: result.running.length,
                persistent: result.persistent.length,
                managed: managedProcesses.size
            };

        } catch (err) {
            result.error = err.message;
        }

        return result;
    }

    static async getRunningVMs() {
        const processes = await this.#findAllQemuProcesses();
        const vmIPs = await this.#getVMIPs();

        return processes.map(p => ({
            vmName: p.vmName || `pid_${p.pid}`,
            pid: p.pid,
            os: p.os || 'unknown',
            memory: p.memory,
            cpu: p.cpu,
            bridgeMode: p.bridgeMode,
            kvm: p.kvm,
            managed: p.managed,
            ip: p.network?.vmIP || (p.vmName ? vmIPs.get(p.vmName) || null : null),
            sshHost: p.network?.sshHost || 'localhost',
            sshPort: p.network?.sshPort || '22',
            tapInterface: p.tapInterface || null,
            startTime: p.startTime
        }));
    }

    static async getVMInfo(vmName) {
        const allVMs = await this.listVMs();
        const vm = allVMs.all.find(v => v.vmName === vmName);

        if (!vm) {
            return { exists: false, vmName, message: 'VM not found' };
        }

        let recentLogs = null;
        if (vm.running && vm.logFile) {
            try {
                const content = await readFile(vm.logFile, 'utf-8');
                const lines = content.split('\n');
                recentLogs = lines.slice(-50);
            } catch {}
        }

        return {
            exists: true,
            ...vm,
            recentLogs,
            detailed: true
        };
    }

    static async getVMLogs(vmName, lines = 100) {
        try {
            const vmInfo = await this.getVMInfo(vmName);
            if (!vmInfo.exists) {
                return { success: false, vmName, error: 'VM not found' };
            }

            let logFile = vmInfo.logFile;
            if (!logFile) {
                const { stdout } = await this.#exec(
                    `ls -t /tmp/qemu_vm_${vmName}_*.log 2>/dev/null | head -1`
                );
                logFile = stdout?.trim();
            }

            if (!logFile) {
                return { success: false, vmName, error: 'No log file found' };
            }

            const content = await readFile(logFile, 'utf-8');
            const logLines = content.split('\n');
            const totalLines = logLines.length;
            const startIdx = Math.max(0, totalLines - lines);
            const recentLines = logLines.slice(startIdx);

            return {
                success: true,
                vmName,
                logFile,
                totalLines,
                linesReturned: recentLines.length,
                logs: recentLines
            };

        } catch (err) {
            return { success: false, vmName, error: err.message };
        }
    }

    static async deleteVM(vmName) {
        try {
            await this.stopVM(vmName);
            const result = await this.#exec(`delete ${vmName}`, { timeout: 30000 });

            return {
                success: result.success,
                vmName,
                output: result.stdout,
                error: result.error
            };
        } catch (err) {
            return { success: false, vmName, error: err.message };
        }
    }

    static async waitForVM(vmName, timeout = 300) {
        const startTime = Date.now();
        const checkInterval = 5000;

        while (Date.now() - startTime < timeout * 1000) {
            const vmInfo = await this.getVMInfo(vmName);

            if (!vmInfo.exists || !vmInfo.running) {
                return {
                    ready: false,
                    vmName,
                    reason: 'VM not found or not running',
                    waited: Math.floor((Date.now() - startTime) / 1000)
                };
            }

            if (vmInfo.logFile) {
                try {
                    const logs = await readFile(vmInfo.logFile, 'utf-8');
                    if (logs.includes('SSH SETUP COMPLETE') ||
                        logs.includes('Passwordless SSH: READY') ||
                        logs.includes('SSH key deployment succeeded')) {
                        return {
                            ready: true,
                            vmName,
                            network: vmInfo.network || {},
                            waited: Math.floor((Date.now() - startTime) / 1000),
                            sshCommand: `ssh root@${vmInfo.network?.sshHost || 'localhost'} -p ${vmInfo.network?.sshPort || '22'}`
                        };
                    }
                } catch {}
            }

            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        return { ready: false, vmName, timeout: true, waited: timeout };
    }

    /**
 * Clear VM files and data.
 * 
 * Modes:
 * - safe (default):  Remove persistent VM directories for non-running UNNAMED VMs + associated files.
 *                    Named VMs are NEVER touched.
 * - hard:            Stop running UNNAMED VMs, then remove all persistent UNNAMED VM directories.
 *                    Named VMs are NEVER touched (even if running).
 * - super-hard:      Kill ALL qemu processes, remove ALL VM directories (named + unnamed),
 *                    ALL /tmp/qemu_* files, ALL IP locks, ALL download locks. Complete nuke.
 * 
 * A "named" VM is one that was created with an explicit --name by the user.
 * Auto-generated names (vm_xxxxxxxxx pattern from startVM default) are considered unnamed.
 * VMs started via qemu.sh directly without a name (temp mode) are also unnamed.
 * 
 * @param {Object} options - Clear options
 * @param {boolean} [options.hard=false] - If true, stops running unnamed VMs then clears them
 * @param {boolean} [options.superHard=false] - If true, complete nuclear cleanup of everything (named + unnamed)
 * @param {string[]} [options.include=[]] - Specific VM names to clear (overrides default scope)
 * @param {boolean} [options.dryRun=false] - If true, only return what would be deleted without actually deleting
 * @returns {Object} Results of the clear operation
 */
static async clearVMs(options = {}) {
    const {
        hard = false,
        superHard = false,
        include = [],
        dryRun = false
    } = options;

    const mode = superHard ? 'super-hard' : hard ? 'hard' : 'safe';

    const result = {
        success: true,
        timestamp: new Date().toISOString(),
        mode,
        dryRun,
        deleted: {
            directories: [],
            logFiles: [],
            pidFiles: [],
            ipLocks: [],
            tempFiles: [],
            downloadLocks: [],
            otherFiles: []
        },
        stopped: [],
        skipped: [],
        errors: [],
        summary: {
            totalProcessed: 0,
            totalDeleted: 0,
            totalStopped: 0,
            totalSkipped: 0,
            totalErrors: 0
        }
    };

    try {
        // ================================================================
        // SUPER HARD MODE: Nuclear cleanup - kill everything QEMU-related
        // Only this mode can touch NAMED VMs
        // ================================================================
        if (superHard) {
            // Step 1: Kill ALL qemu processes forcefully
            try {
                const { stdout: allQemuPids } = await this.#exec(
                    `ps aux | grep -E "qemu-system-x86_64|qemu-system" | grep -v grep | awk '{print $2}'`,
                    { timeout: 5000, cwd: '/tmp' }
                );

                if (allQemuPids) {
                    const pids = allQemuPids.split('\n').filter(Boolean);
                    for (const pid of pids) {
                        const pidNum = parseInt(pid);
                        if (!dryRun) {
                            try {
                                process.kill(pidNum, 'SIGKILL');
                            } catch {}
                        }
                        result.stopped.push({
                            pid: pidNum,
                            note: dryRun ? '[DRY RUN] Would kill' : 'Killed'
                        });
                        result.summary.totalStopped++;
                    }
                    if (!dryRun) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            } catch {}

            // Step 2: Clear managed processes tracking
            const managedCount = managedProcesses.size;
            if (!dryRun) {
                managedProcesses.clear();
            }
            result.summary.totalStopped += managedCount;

            // Step 3: Remove ALL VM directories (named + unnamed)
            try {
                const entries = await readdir(QEMU_SCRIPT_DIR);
                for (const entry of entries) {
                    if (!entry.includes('-vm-')) continue;
                    const fullPath = join(QEMU_SCRIPT_DIR, entry);

                    let statInfo;
                    try {
                        statInfo = await stat(fullPath);
                    } catch { continue; }

                    if (!statInfo.isDirectory()) continue;

                    const nameMatch = entry.match(/-vm-(.+)$/);
                    const vmName = nameMatch ? nameMatch[1] : 'unknown';

                    const dirInfo = {
                        path: fullPath,
                        directory: entry,
                        vmName
                    };

                    if (!dryRun) {
                        try {
                            await rm(fullPath, { recursive: true, force: true });
                            result.deleted.directories.push(dirInfo);
                            result.summary.totalDeleted++;
                        } catch (rmErr) {
                            result.errors.push({
                                operation: 'delete_directory',
                                path: fullPath,
                                error: rmErr.message
                            });
                            result.summary.totalErrors++;
                        }
                    } else {
                        dirInfo.note = '[DRY RUN] Would delete';
                        result.deleted.directories.push(dirInfo);
                        result.summary.totalDeleted++;
                    }
                }
            } catch {}

            // Step 4: Nuke ALL /tmp/qemu_* files
            try {
                const { stdout: tmpFiles } = await this.#exec(
                    `ls /tmp/qemu_* 2>/dev/null`,
                    { timeout: 5000, cwd: '/tmp' }
                );
                if (tmpFiles) {
                    const files = tmpFiles.split('\n').filter(Boolean);
                    for (const file of files) {
                        if (file === IP_LOCK_DIR || file === DOWNLOAD_LOCK_DIR) continue;

                        const fileInfo = { path: file };
                        if (!dryRun) {
                            try {
                                await rm(file, { recursive: true, force: true });
                                result.deleted.otherFiles.push(fileInfo);
                                result.summary.totalDeleted++;
                            } catch {}
                        } else {
                            fileInfo.note = '[DRY RUN] Would delete';
                            result.deleted.otherFiles.push(fileInfo);
                            result.summary.totalDeleted++;
                        }
                    }
                }
            } catch {}

            // Step 5: Clear ALL IP locks
            try {
                const entries = await readdir(IP_LOCK_DIR).catch(() => []);
                for (const entry of entries) {
                    const lockPath = join(IP_LOCK_DIR, entry);
                    const lockInfo = { path: lockPath, ip: entry.startsWith('ip_') ? entry.substring(3) : entry };
                    if (!dryRun) {
                        try {
                            await rm(lockPath, { recursive: true, force: true });
                            result.deleted.ipLocks.push(lockInfo);
                            result.summary.totalDeleted++;
                        } catch {}
                    } else {
                        lockInfo.note = '[DRY RUN] Would delete';
                        result.deleted.ipLocks.push(lockInfo);
                        result.summary.totalDeleted++;
                    }
                }
            } catch {}

            // Step 6: Clear ALL download locks
            try {
                const entries = await readdir(DOWNLOAD_LOCK_DIR).catch(() => []);
                for (const entry of entries) {
                    const lockPath = join(DOWNLOAD_LOCK_DIR, entry);
                    const lockInfo = { path: lockPath };
                    if (!dryRun) {
                        try {
                            await rm(lockPath, { recursive: true, force: true });
                            result.deleted.downloadLocks.push(lockInfo);
                            result.summary.totalDeleted++;
                        } catch {}
                    } else {
                        lockInfo.note = '[DRY RUN] Would delete';
                        result.deleted.downloadLocks.push(lockInfo);
                        result.summary.totalDeleted++;
                    }
                }
            } catch {}

            // Step 7: Wipe the IPs file
            if (!dryRun) {
                try {
                    await writeFile(VM_IPS_FILE, '');
                } catch {}
            }

            return result;
        }

        // ================================================================
        // SAFE & HARD MODE: Only touch UNNAMED VMs
        // Named VMs are ALWAYS skipped in safe and hard modes
        // ================================================================
        
        // A "named" VM = the user explicitly gave it a name via --name
        // Auto-generated names from startVM() follow pattern: vm_ + base36 timestamp (e.g., vm_mqi2v926)
        // These auto-generated names are 11-13 chars: "vm_" + 8-10 random chars
        // Temp VMs from qemu.sh: start with "tmp." or "temp-"
        //
        // Strategy: Collect user-named VMs from managedProcesses args
        // A VM is "user-named" if it was started with an explicit --name that doesn't match the auto-gen pattern
        const userNamedVMs = new Set();
        
        // Check managedProcesses for VMs started with explicit names
        for (const [vmName, procInfo] of managedProcesses) {
            // If the VM was started via startVM() with an explicit name config
            // The auto-generated name pattern is: vm_ + 8-10 chars from Date.now().toString(36)
            // Example: vm_mqi2v926, vm_mqhzl0xr
            const isAutoGenerated = /^vm_[a-z0-9]{8,10}$/.test(vmName);
            
            if (!isAutoGenerated && !vmName.startsWith('tmp.') && !vmName.startsWith('temp-')) {
                userNamedVMs.add(vmName);
            }
        }
        
        // Also check persistent directories for non-auto-generated names
        const allVMs = await this.listVMs();
        const runningVMs = allVMs.running;
        const persistentVMs = allVMs.persistent;
        
        for (const vm of persistentVMs) {
            const isAutoGenerated = /^vm_[a-z0-9]{8,10}$/.test(vm.vmName);
            if (!isAutoGenerated && !vm.vmName.startsWith('tmp.') && !vm.vmName.startsWith('temp-')) {
                userNamedVMs.add(vm.vmName);
            }
        }

        // Determine which VMs to process
        let vmsToProcess = [];
        // Use a Set to track already-processed VM names to avoid duplicates
        const processedVMNames = new Set();

        if (include.length > 0) {
            // Specific VMs requested - skip the named/unnamed logic
            for (const vmName of include) {
                if (processedVMNames.has(vmName)) continue;
                processedVMNames.add(vmName);
                
                const persistent = persistentVMs.find(v => v.vmName === vmName);
                const running = runningVMs.find(v => v.vmName === vmName);

                if (persistent || running) {
                    vmsToProcess.push({
                        vmName,
                        persistent: persistent || null,
                        running: running || null,
                        isRunning: !!running
                    });
                } else {
                    result.skipped.push({ vmName, reason: 'VM not found' });
                    result.summary.totalSkipped++;
                }
            }
        } else if (hard) {
            // Hard mode: process all UNNAMED persistent VMs (running + non-running)
            // Named VMs are always skipped
            
            for (const vm of persistentVMs) {
                if (processedVMNames.has(vm.vmName)) continue;
                processedVMNames.add(vm.vmName);
                
                // Check if this is a user-named VM
                if (userNamedVMs.has(vm.vmName)) {
                    result.skipped.push({
                        vmName: vm.vmName,
                        reason: 'Named VM protected (use superHard=true to force)',
                        running: vm.running,
                        pid: vm.pid || null
                    });
                    result.summary.totalSkipped++;
                    continue;
                }

                const running = runningVMs.find(v => v.vmName === vm.vmName);
                vmsToProcess.push({
                    vmName: vm.vmName,
                    persistent: vm,
                    running: running || null,
                    isRunning: !!running
                });
            }

            // Also catch running unnamed VMs that might not have persistent dirs
            // (e.g., temp VMs from qemu.sh direct invocation)
            for (const vm of runningVMs) {
                if (processedVMNames.has(vm.vmName)) continue;
                processedVMNames.add(vm.vmName);
                
                if (userNamedVMs.has(vm.vmName)) {
                    result.skipped.push({
                        vmName: vm.vmName,
                        reason: 'Named VM protected (use superHard=true to force)',
                        running: true,
                        pid: vm.pid
                    });
                    result.summary.totalSkipped++;
                    continue;
                }
                
                vmsToProcess.push({
                    vmName: vm.vmName,
                    persistent: null,
                    running: vm,
                    isRunning: true
                });
            }
        } else {
            // Safe mode: only non-running UNNAMED persistent VMs
            
            for (const vm of persistentVMs) {
                if (processedVMNames.has(vm.vmName)) continue;
                processedVMNames.add(vm.vmName);
                
                // Check if this is a user-named VM
                if (userNamedVMs.has(vm.vmName)) {
                    result.skipped.push({
                        vmName: vm.vmName,
                        reason: 'Named VM protected (use superHard=true to force)',
                        running: vm.running,
                        pid: vm.pid || null
                    });
                    result.summary.totalSkipped++;
                    continue;
                }

                if (!vm.running) {
                    vmsToProcess.push({
                        vmName: vm.vmName,
                        persistent: vm,
                        running: null,
                        isRunning: false
                    });
                } else {
                    result.skipped.push({
                        vmName: vm.vmName,
                        reason: 'VM is currently running (use hard=true to force)',
                        pid: vm.pid
                    });
                    result.summary.totalSkipped++;
                }
            }
        }

        result.summary.totalProcessed = vmsToProcess.length;

        // Process each VM
        for (const vm of vmsToProcess) {
            try {
                // Stop running VMs in hard mode
                if (vm.isRunning && vm.running) {
                    if (!dryRun) {
                        const stopResult = await this.stopVM(vm.running.pid);
                        if (stopResult.success) {
                            result.stopped.push({
                                vmName: vm.vmName,
                                pid: vm.running.pid
                            });
                            result.summary.totalStopped++;
                        } else {
                            result.errors.push({
                                vmName: vm.vmName,
                                operation: 'stop',
                                error: stopResult.error || 'Failed to stop VM'
                            });
                            result.summary.totalErrors++;
                            continue;
                        }
                    } else {
                        result.stopped.push({
                            vmName: vm.vmName,
                            pid: vm.running.pid,
                            note: '[DRY RUN] Would stop'
                        });
                        result.summary.totalStopped++;
                    }
                }

                // Delete VM directory
                if (vm.persistent && vm.persistent.directory) {
                    const dirInfo = {
                        vmName: vm.vmName,
                        path: vm.persistent.directory,
                        diskSize: vm.persistent.diskSize || 'unknown'
                    };

                    if (!dryRun) {
                        try {
                            await rm(vm.persistent.directory, { recursive: true, force: true });
                            result.deleted.directories.push(dirInfo);
                            result.summary.totalDeleted++;
                        } catch (rmErr) {
                            result.errors.push({
                                vmName: vm.vmName,
                                operation: 'delete_directory',
                                path: vm.persistent.directory,
                                error: rmErr.message
                            });
                            result.summary.totalErrors++;
                        }
                    } else {
                        dirInfo.note = '[DRY RUN] Would delete';
                        result.deleted.directories.push(dirInfo);
                        result.summary.totalDeleted++;
                    }
                }

                // Clean up associated files for this VM
                const vmPattern = vm.vmName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

                // Log files
                try {
                    const { stdout: logFiles } = await this.#exec(
                        `ls /tmp/qemu_vm_${vmPattern}_*.log 2>/dev/null`,
                        { timeout: 2000, cwd: '/tmp' }
                    );
                    if (logFiles) {
                        const logs = logFiles.split('\n').filter(Boolean);
                        for (const logFile of logs) {
                            const logInfo = { vmName: vm.vmName, path: logFile };
                            if (!dryRun) {
                                try {
                                    await unlink(logFile);
                                    result.deleted.logFiles.push(logInfo);
                                    result.summary.totalDeleted++;
                                } catch {}
                            } else {
                                logInfo.note = '[DRY RUN] Would delete';
                                result.deleted.logFiles.push(logInfo);
                                result.summary.totalDeleted++;
                            }
                        }
                    }
                } catch {}

                // PID files
                try {
                    const { stdout: pidFiles } = await this.#exec(
                        `ls /tmp/qemu_vm_${vmPattern}.pid 2>/dev/null`,
                        { timeout: 2000, cwd: '/tmp' }
                    );
                    if (pidFiles) {
                        const pids = pidFiles.split('\n').filter(Boolean);
                        for (const pidFile of pids) {
                            const pidInfo = { vmName: vm.vmName, path: pidFile };
                            if (!dryRun) {
                                try {
                                    await unlink(pidFile);
                                    result.deleted.pidFiles.push(pidInfo);
                                    result.summary.totalDeleted++;
                                } catch {}
                            } else {
                                pidInfo.note = '[DRY RUN] Would delete';
                                result.deleted.pidFiles.push(pidInfo);
                                result.summary.totalDeleted++;
                            }
                        }
                    }
                } catch {}

                if (!dryRun) {
                    managedProcesses.delete(vm.vmName);
                }

            } catch (vmErr) {
                result.errors.push({
                    vmName: vm.vmName,
                    operation: 'process',
                    error: vmErr.message
                });
                result.summary.totalErrors++;
            }
        }

        // Release IP locks for deleted VMs
        try {
            const currentIPs = await this.#getVMIPs();
            const remainingVMNames = new Set(
                (await this.listVMs()).all.map(v => v.vmName)
            );

            for (const [vmName, ip] of currentIPs) {
                if (!remainingVMNames.has(vmName)) {
                    const lockDir = `${IP_LOCK_DIR}/ip_${ip}`;
                    const ipInfo = { vmName, ip, path: lockDir };
                    if (!dryRun) {
                        try {
                            await rm(lockDir, { recursive: true, force: true });
                            result.deleted.ipLocks.push(ipInfo);
                            result.summary.totalDeleted++;
                        } catch {}
                    } else {
                        ipInfo.note = '[DRY RUN] Would release';
                        result.deleted.ipLocks.push(ipInfo);
                        result.summary.totalDeleted++;
                    }
                }
            }

            if (!dryRun) {
                try {
                    const remaining = new Map();
                    for (const [name, ip] of currentIPs) {
                        if (remainingVMNames.has(name)) {
                            remaining.set(name, ip);
                        }
                    }
                    let newContent = '';
                    for (const [name, ip] of remaining) {
                        newContent += `${name}=${ip}\n`;
                    }
                    await writeFile(VM_IPS_FILE, newContent);
                } catch {}
            }
        } catch {}

        // Clean up orphaned temp files
        try {
            const { stdout: tempFiles } = await this.#exec(
                `ls /tmp/qemu_vm_tmp.* /tmp/qemu_vm_ssh_setup_*.log /tmp/qemu_vm_ssh_done_*.marker /tmp/qemu_vm_download_pid_* 2>/dev/null`,
                { timeout: 2000, cwd: '/tmp' }
            );
            if (tempFiles) {
                const temps = tempFiles.split('\n').filter(Boolean);
                const remainingVMNames = new Set(
                    (await this.listVMs()).all.map(v => v.vmName)
                );
                for (const tempFile of temps) {
                    const baseName = tempFile.split('/').pop();
                    const isOrphaned = Array.from(remainingVMNames).every(
                        name => !baseName.includes(name)
                    );
                    if (isOrphaned) {
                        const tempInfo = { path: tempFile };
                        if (!dryRun) {
                            try {
                                await unlink(tempFile);
                                result.deleted.tempFiles.push(tempInfo);
                                result.summary.totalDeleted++;
                            } catch {}
                        } else {
                            tempInfo.note = '[DRY RUN] Would delete';
                            result.deleted.tempFiles.push(tempInfo);
                            result.summary.totalDeleted++;
                        }
                    }
                }
            }
        } catch {}

        // Clean up stale download locks (older than 1 hour)
        try {
            const entries = await readdir(DOWNLOAD_LOCK_DIR).catch(() => []);
            for (const entry of entries) {
                const lockPath = join(DOWNLOAD_LOCK_DIR, entry);
                try {
                    const lockStat = await stat(lockPath);
                    const age = Date.now() - lockStat.mtimeMs;
                    if (age > 3600000) {
                        const lockInfo = { path: lockPath, entry, age: Math.floor(age / 1000) + 's' };
                        if (!dryRun) {
                            await rm(lockPath, { recursive: true, force: true });
                            result.deleted.downloadLocks.push(lockInfo);
                            result.summary.totalDeleted++;
                        } else {
                            lockInfo.note = '[DRY RUN] Would delete (stale)';
                            result.deleted.downloadLocks.push(lockInfo);
                            result.summary.totalDeleted++;
                        }
                    }
                } catch {}
            }
        } catch {}

    } catch (err) {
        result.success = false;
        result.errors.push({
            vmName: 'global',
            operation: 'clearVMs',
            error: err.message
        });
        result.summary.totalErrors++;
    }

    result.summary.totalDeleted =
        result.deleted.directories.length +
        result.deleted.logFiles.length +
        result.deleted.pidFiles.length +
        result.deleted.ipLocks.length +
        result.deleted.tempFiles.length +
        result.deleted.downloadLocks.length +
        result.deleted.otherFiles.length;

    result.summary.totalSkipped = result.skipped.length;

    return result;
}

    static async getSystemInfo() {
        const info = {
            timestamp: new Date().toISOString(),
            script: {
                path: QEMU_SCRIPT_PATH,
                directory: QEMU_SCRIPT_DIR
            },
            host: {},
            vms: {},
            network: {}
        };

        try {
            const { stdout: kvmCheck } = await this.#exec(
                'test -e /dev/kvm && test -r /dev/kvm && test -w /dev/kvm && echo "available" || echo "unavailable"'
            );
            info.host.kvm = kvmCheck?.trim() || 'unknown';

            const { stdout: cpuCount } = await this.#exec(
                'nproc --all 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "unknown"'
            );
            info.host.cpuCores = parseInt(cpuCount) || 'unknown';

            const { stdout: memInfo } = await this.#exec(
                'free -m 2>/dev/null | awk \'/^Mem:/ {print $2" "$3" "$4" "$7}\' || echo "unknown"'
            );
            if (memInfo && memInfo !== 'unknown') {
                const [total, used, free, available] = memInfo.split(' ');
                info.host.memory = {
                    total: parseInt(total),
                    used: parseInt(used),
                    free: parseInt(free),
                    available: parseInt(available)
                };
            }

            info.network = (() => {
                const interfaces = networkInterfaces();
                const bridges = [], taps = [], physical = [];
                for (const [name, addrs] of Object.entries(interfaces)) {
                    if (!addrs || addrs.length === 0) continue;
                    const netInfo = { name, addresses: addrs.map(a => ({ address: a.address, netmask: a.netmask, mac: a.mac })) };
                    if (name.startsWith('qemubr')) bridges.push(netInfo);
                    else if (name.startsWith('qemutap')) taps.push(netInfo);
                    else if (name.match(/^(eth|ens|enp|wlan|wlp)/)) physical.push(netInfo);
                }
                return { bridges, taps, physical };
            })();

            const allProcesses = await this.#findAllQemuProcesses();
            const vmIPs = await this.#getVMIPs();
            const vmDirs = await this.#findVMDirectories();

            info.vms = {
                running: allProcesses.length,
                managed: managedProcesses.size,
                persistent: vmDirs.length,
                ipAssignments: Object.fromEntries(vmIPs),
                processes: allProcesses.map(p => ({
                    pid: p.pid,
                    vmName: p.vmName,
                    os: p.os,
                    memory: p.memory,
                    cpu: p.cpu,
                    ip: p.network?.vmIP || null
                }))
            };

            await this.#ensureScript();
            info.script.accessible = true;
            info.script.executable = true;

        } catch (err) {
            info.error = err.message;
            info.script.accessible = false;
        }

        return info;
    }
}

// ==================== CLI INTERFACE ====================
// Run directly: node qemu-interface.mjs <command> [options]

async function cli() {
    const args = process.argv.slice(2);
    const command = args[0]?.toLowerCase();

    if (!command) {
        console.log(`
Qemu VM Manager - CLI Interface
===============================

Usage: node qemu-interface.mjs <command> [options]

Commands:
  list                    List all VMs (running and persistent)
  running                 List only running VMs
  info <vm-name>          Get detailed info for a specific VM
  logs <vm-name> [lines]  Get recent logs for a VM (default: 100 lines)
  start [options]         Start a new VM (detached, returns immediately)
  stop <vm-name|pid>      Stop a running VM
  stop-all                Stop all running VMs
  delete <vm-name>        Delete a persistent VM
  clear [options]         Clear VM files (see options below)
  system                  Show system info
  help                    Show this help

Start options (after start command):
  --os <alpine|ubuntu>    OS type (default: alpine)
  --name <name>           VM name (default: auto-generated)
  --size <size>           Disk size (default: 5G)
  --memory <mb>           RAM in MB (default: auto)
  --cpu <cores>           CPU cores (default: 1)
  --port <port>           SSH port (default: auto)
  --no-bridge             Disable bridge networking
  --no-kvm                Disable KVM acceleration
  --no-ssh-setup          Skip SSH key setup

Clear modes:
  clear                   SAFE: Remove only non-running UNNAMED VMs
                          (Named VMs are ALWAYS protected)
  clear --hard            HARD: Stop running UNNAMED VMs, then remove them
                          (Named VMs are ALWAYS protected)
  clear --super-hard      SUPER HARD: Kill ALL qemu, nuke EVERYTHING
                          (named + unnamed). Complete reset.

Clear options:
  --include <names...>    Only clear specific VMs (comma-separated or multiple args)
  --dry-run               Show what would be deleted without actually deleting

Examples:
  node qemu-interface.mjs list
  node qemu-interface.mjs start --os alpine --name myvm --size 10G
  node qemu-interface.mjs clear                          # Safe: only unnamed non-running
  node qemu-interface.mjs clear --hard                   # Hard: unnamed only
  node qemu-interface.mjs clear --super-hard             # Nuclear: wipe everything
  node qemu-interface.mjs clear --include vm_abc,vm_def  # Only specific VMs
  node qemu-interface.mjs clear --super-hard --dry-run   # Preview nuke
`);
        process.exit(0);
    }

    try {
        switch (command) {
            case 'list': {
                const result = await Qemu.listVMs();
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'running': {
                const result = await Qemu.getRunningVMs();
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'info': {
                const vmName = args[1];
                if (!vmName) {
                    console.error('ERROR: VM name required');
                    process.exit(1);
                }
                const result = await Qemu.getVMInfo(vmName);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'logs': {
                const vmName = args[1];
                const lines = parseInt(args[2]) || 100;
                if (!vmName) {
                    console.error('ERROR: VM name required');
                    process.exit(1);
                }
                const result = await Qemu.getVMLogs(vmName, lines);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'start': {
                const config = {};
                for (let i = 1; i < args.length; i++) {
                    const arg = args[i];
                    switch (arg) {
                        case '--os':
                            config.os = args[++i];
                            break;
                        case '--name':
                            config.name = args[++i];
                            break;
                        case '--size':
                            config.size = args[++i];
                            break;
                        case '--memory':
                            config.memory = parseInt(args[++i]);
                            break;
                        case '--cpu':
                            config.cpu = parseInt(args[++i]);
                            break;
                        case '--port':
                            config.port = parseInt(args[++i]);
                            break;
                        case '--no-bridge':
                            config.bridge = false;
                            break;
                        case '--no-kvm':
                            config.kvm = false;
                            break;
                        case '--no-ssh-setup':
                            config.sshSetup = false;
                            break;
                    }
                }

                // Start VM in detached mode - do NOT await the full result
                // Fire and forget, print the result as JSON
                Qemu.startVM(config).then(result => {
                    // Write result to a temp file so the user can check it
                    const resultFile = `/tmp/qemu_start_${result.vmName || Date.now()}.json`;
                    writeFile(resultFile, JSON.stringify(result, null, 2)).catch(() => {});
                });

                // Print immediate response and exit
                console.log(JSON.stringify({
                    status: 'started',
                    message: 'VM start initiated. The VM will boot in the background.',
                    hint: 'Use "list" command to check status, or check /tmp/qemu_start_*.json for result.',
                    config: config
                }, null, 2));

                // Force exit after a short delay to let the spawn happen
                setTimeout(() => process.exit(0), 500);
                return;
            }

            case 'stop': {
                const identifier = args[1];
                if (!identifier) {
                    console.error('ERROR: VM name or PID required');
                    process.exit(1);
                }
                const result = await Qemu.stopVM(identifier);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'stop-all': {
                console.log('Stopping all VMs...');
                const result = await Qemu.stopAllVMs();
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'delete': {
                const vmName = args[1];
                if (!vmName) {
                    console.error('ERROR: VM name required');
                    process.exit(1);
                }
                const result = await Qemu.deleteVM(vmName);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'clear': {
                const options = {};
                for (let i = 1; i < args.length; i++) {
                    const arg = args[i];
                    switch (arg) {
                        case '--hard':
                            options.hard = true;
                            break;
                        case '--super-hard':
                            options.superHard = true;
                            break;
                        case '--dry-run':
                            options.dryRun = true;
                            break;
                        case '--include': {
                            i++;
                            const includeVMs = [];
                            while (i < args.length && !args[i].startsWith('--')) {
                                const names = args[i].split(',').map(n => n.trim()).filter(Boolean);
                                includeVMs.push(...names);
                                i++;
                            }
                            i--;
                            if (includeVMs.length > 0) {
                                options.include = includeVMs;
                            }
                            break;
                        }
                    }
                }

                if (options.superHard) {
                    console.log('☢️  SUPER HARD MODE: Nuclear cleanup - killing all QEMU processes and wiping everything (named + unnamed)...');
                } else if (options.hard) {
                    console.log('🔴 HARD MODE: Stopping unnamed VMs and clearing all unnamed persistent VMs...');
                    console.log('🛡️  Named VMs are PROTECTED and will NOT be touched.');
                } else {
                    console.log('🟢 SAFE MODE: Only clearing non-running unnamed persistent VMs...');
                    console.log('🛡️  Named VMs are PROTECTED and will NOT be touched.');
                }

                if (options.dryRun) {
                    console.log('🔍 DRY RUN: No files will actually be deleted...');
                }

                const result = await Qemu.clearVMs(options);
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'system': {
                const result = await Qemu.getSystemInfo();
                console.log(JSON.stringify(result, null, 2));
                break;
            }

            case 'help': {
                break;
            }

            default:
                console.error(`Unknown command: ${command}`);
                console.error('Run without arguments for help');
                process.exit(1);
        }
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

// Run CLI if file is executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    cli();
}

export default Qemu;
export { Qemu };