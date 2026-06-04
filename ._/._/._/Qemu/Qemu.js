// qemu-interface.mjs
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { 
    readFile, writeFile, access, readdir, stat, unlink 
} from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { networkInterfaces } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const QEMU_SCRIPT_PATH = resolve(__dirname, 'qemu.sh');
const QEMU_SCRIPT_DIR = dirname(QEMU_SCRIPT_PATH);

const VM_IPS_FILE = '/tmp/qemu_vm_ips.txt';
const IP_LOCK_DIR = '/tmp/qemu_vm_ip_locks';

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

export default Qemu;
export { Qemu };