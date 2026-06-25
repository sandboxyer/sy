import SyDB from '../../../../../SyDB.js'
import os from 'os'

class VM {
    // ==========  VM CONFIGURATION  ==========
    static Config = {
        Model: SyDB.Model('VMConfig', {
            name:          { type: 'string', required: true, indexed: true },
            os:            { type: 'string', default: 'alpine' },
            diskSize:      { type: 'string', default: '10G' },
            memory:        { type: 'number' },
            cpu:           { type: 'number', default: 1 },
            port:          { type: 'number' },
            bridge:        { type: 'boolean', default: true },
            kvm:           { type: 'boolean', default: true },
            sshSetup:      { type: 'boolean', default: true },
            retryAttempts: { type: 'number', default: 18 },
            retryDelay:    { type: 'number', default: 3 }
        }),

        // Fallback values (original defaults)
        _fallbackCapabilities: {
            cpuCores: 8,
            totalMem: 8192,
            cpuOptions: [1, 2, 4, 8, 16],
            memOptions: [256, 512, 1024, 2048, 4096, 8192],
            arch: 'x64',
            platform: 'linux',
            hostname: 'localhost'
        },

        // Helper to get host machine capabilities
        getHostCapabilities() {
            try {
                const cpus = os.cpus()
                const totalMem = Math.floor(os.totalmem() / (1024 * 1024)) // MB
                const cpuCores = cpus.length
                
                // Generate CPU options based on actual cores
                const cpuOptions = [1]
                let multiplier = 1
                while (multiplier < cpuCores) {
                    multiplier = Math.min(multiplier * 2, cpuCores)
                    if (!cpuOptions.includes(multiplier)) {
                        cpuOptions.push(multiplier)
                    }
                }
                // Ensure we cap at actual core count
                const uniqueCpuOptions = [...new Set(cpuOptions)].sort((a, b) => a - b)

                // Generate RAM options based on total memory
                const memOptions = [256, 512]
                let memStep = 1024
                while (memStep <= totalMem * 0.8) { // Up to 80% of host RAM
                    if (!memOptions.includes(memStep)) {
                        memOptions.push(memStep)
                    }
                    memStep = memStep >= 8192 ? memStep * 2 : memStep * 2
                }
                // Always include total available as max
                const maxAllocatable = Math.floor(totalMem * 0.8)
                if (!memOptions.includes(maxAllocatable) && maxAllocatable > memOptions[memOptions.length - 1]) {
                    memOptions.push(maxAllocatable)
                }

                return {
                    cpuCores,
                    totalMem,
                    cpuOptions: uniqueCpuOptions,
                    memOptions: memOptions.filter(m => m > 0).sort((a, b) => a - b),
                    arch: os.arch(),
                    platform: os.platform(),
                    hostname: os.hostname()
                }
            } catch (error) {
                console.warn('Failed to detect host capabilities, using fallback values:', error.message)
                return this._fallbackCapabilities
            }
        },

        // UI‑friendly field definitions with dynamic dropdown options
        get fields() {
            let host
            try {
                host = this.getHostCapabilities()
            } catch (error) {
                console.warn('Error getting fields, using fallback capabilities:', error.message)
                host = this._fallbackCapabilities
            }
            
            return [
                {
                    name: 'name',
                    type: 'string',
                    required: true,
                    indexed: true,
                    default: null,
                    description: 'Unique name for the persistent VM'
                },
                {
                    name: 'os',
                    type: 'string',
                    default: 'alpine',
                    possibleValues: ['alpine', 'ubuntu'],
                    description: 'Operating system'
                },
                {
                    name: 'diskSize',
                    type: 'string',
                    default: '10G',
                    possibleValues: ['5G', '10G', '20G', '40G', '80G'],
                    description: 'Virtual disk size (e.g. 10G, 20G)'
                },
                {
                    name: 'memory',
                    type: 'number',
                    default: null,
                    possibleValues: host.memOptions,
                    description: `RAM in MB; leave empty to auto‑calculate based on host`
                },
                {
                    name: 'cpu',
                    type: 'number',
                    default: 1,
                    possibleValues: host.cpuOptions,
                    description: `Number of CPU cores (capped to host max: ${host.cpuCores})`
                },
                {
                    name: 'port',
                    type: 'number',
                    default: null,
                    description: 'SSH port for port‑forwarding mode (auto‑detected if blank)'
                },
                {
                    name: 'bridge',
                    type: 'boolean',
                    default: true,
                    possibleValues: [true, false],
                    description: 'Enable bridge networking (requires root privileges)'
                },
                {
                    name: 'kvm',
                    type: 'boolean',
                    default: true,
                    possibleValues: [true, false],
                    description: 'Use KVM hardware acceleration'
                },
                {
                    name: 'sshSetup',
                    type: 'boolean',
                    default: true,
                    possibleValues: [true, false],
                    description: 'Automatically deploy SSH key after boot'
                },
                {
                    name: 'retryAttempts',
                    type: 'number',
                    default: 18,
                    possibleValues: [5, 10, 18, 30],
                    description: 'Max retries on port conflict'
                },
                {
                    name: 'retryDelay',
                    type: 'number',
                    default: 3,
                    possibleValues: [1, 2, 3, 5, 10],
                    description: 'Delay between retries (seconds)'
                }
            ]
        },

        // Convenience: default values as a plain object
        defaults: {
            os: 'alpine',
            diskSize: '10G',
            cpu: 1,
            bridge: true,
            kvm: true,
            sshSetup: true,
            retryAttempts: 18,
            retryDelay: 3
        }
    }

    // ==========  VM STATE (running instances)  ==========
    static State = {
        Model: SyDB.Model('VMState', {
            vmName:       { type: 'string', required: true, indexed: true },
            pid:          { type: 'number', required: true },
            status:       { type: 'string', default: 'running' },
            ip:           { type: 'string' },
            sshPort:      { type: 'number' },
            tapInterface: { type: 'string' },
            logFile:      { type: 'string' },
            startTime:    { type: 'string', default: () => new Date().toISOString() },
            managed:      { type: 'boolean', default: true },
            configName:   { type: 'string' }
        }),

        // Fallback status options
        _fallbackStatusOptions: ['running', 'stopped', 'error'],

        // Get dynamic status options based on actual VM states
        getStatusOptions() {
            try {
                // Could be extended with custom statuses from SyDB queries
                // For now, return the base statuses
                return this._fallbackStatusOptions
            } catch (error) {
                console.warn('Error getting status options, using fallback:', error.message)
                return this._fallbackStatusOptions
            }
        },

        fields: [
            {
                name: 'vmName',
                type: 'string',
                required: true,
                indexed: true,
                default: null,
                description: 'Name of the VM (matches VMConfig name)'
            },
            {
                name: 'pid',
                type: 'number',
                required: true,
                default: null,
                description: 'Process ID of the QEMU instance'
            },
            {
                name: 'status',
                type: 'string',
                default: 'running',
                possibleValues: () => {
                    try {
                        return VM.State.getStatusOptions()
                    } catch (error) {
                        return ['running', 'stopped', 'error']
                    }
                },
                description: 'Current VM status'
            },
            {
                name: 'ip',
                type: 'string',
                default: null,
                description: 'Assigned IP address (bridge mode)'
            },
            {
                name: 'sshPort',
                type: 'number',
                default: null,
                description: 'SSH port (port‑forwarding mode)'
            },
            {
                name: 'tapInterface',
                type: 'string',
                default: null,
                description: 'TAP interface name (bridge mode)'
            },
            {
                name: 'logFile',
                type: 'string',
                default: null,
                description: 'Path to the QEMU log file'
            },
            {
                name: 'startTime',
                type: 'string',
                default: () => new Date().toISOString(),
                description: 'ISO timestamp when the VM started'
            },
            {
                name: 'managed',
                type: 'boolean',
                default: true,
                possibleValues: [true, false],
                description: 'Whether the process is managed by the interface'
            },
            {
                name: 'configName',
                type: 'string',
                default: null,
                description: 'Reference to the VMConfig name used for this instance'
            }
        ],

        defaults: {
            status: 'running',
            managed: true
        }
    }
}

export default VM