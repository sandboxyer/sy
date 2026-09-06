// terminal-tracker.mjs
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import SyPM from './../../../SyPM.js';

// Capture terminal info BEFORE backgrounding
const captureTerminalInfo = () => {
    const info = {
        myPid: process.pid,
        myPpid: process.ppid,
        tty: null,
        shellPid: null,
        sessionId: null,
        startTime: Date.now()
    };

    try {
        // Get my TTY
        info.tty = execSync(`ps -o tty= -p ${info.myPid}`).toString().trim();
        
        // Walk up process tree to find shell
        let currentPid = info.myPpid;
        let attempts = 0;
        
        while (currentPid > 1 && attempts < 10) {
            try {
                const procInfo = fs.readFileSync(`/proc/${currentPid}/stat`, 'utf8');
                const parts = procInfo.split(' ');
                const name = parts[1].replace(/[()]/g, '');
                const ppid = parseInt(parts[3]);
                const tty = execSync(`ps -o tty= -p ${currentPid}`).toString().trim();
                
                // Check if this is a shell
                const shellNames = ['bash', 'zsh', 'sh', 'fish', 'ksh', 'tcsh', 'dash'];
                if (shellNames.some(shell => name.includes(shell))) {
                    info.shellPid = currentPid;
                    info.tty = tty;
                    info.sessionId = execSync(`ps -o sess= -p ${currentPid}`).toString().trim();
                    console.log(`✅ Found shell: PID ${currentPid} (${name})`);
                    console.log(`✅ TTY: ${tty}`);
                    console.log(`✅ Session ID: ${info.sessionId}`);
                    break;
                }
                
                // Check if this is a terminal emulator
                const terminalEmulators = ['gnome-terminal', 'konsole', 'xterm', 'urxvt', 
                    'alacritty', 'kitty', 'terminator', 'tilix', 'st', 'rxvt'];
                
                if (terminalEmulators.some(term => name.includes(term))) {
                    info.tty = tty;
                    console.log(`✅ Found terminal: PID ${currentPid} (${name})`);
                    console.log(`✅ TTY: ${tty}`);
                    break;
                }
                
                currentPid = ppid;
                attempts++;
            } catch (error) {
                break;
            }
        }
        
        console.log('✅ Terminal info captured successfully');
        
    } catch (error) {
        console.error('Error capturing terminal info:', error);
    }
    
    return info;
};

// Create the background tracker code as a string
const createTrackerCode = (info) => {
    return `
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

class TerminalTracker {
    constructor() {
        this.platform = os.platform();
        this.currentPaths = new Map();
        this.trackedPids = new Set();
        this.targetTty = '${info.tty || ''}';
        this.targetShellPid = ${info.shellPid || 'null'};
        this.targetSessionId = '${info.sessionId || ''}';
        this.logFile = path.join(os.homedir(), '.terminal-tracker', 'tracked-terminal.log');
        
        // Ensure log directory exists
        const logDir = path.dirname(this.logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        this.log('🚀 Terminal Tracker Started');
        this.log('📋 Target Info:');
        this.log('  - TTY: ' + (this.targetTty || 'Not found'));
        this.log('  - Shell PID: ' + (this.targetShellPid || 'Not found'));
        this.log('  - Session ID: ' + (this.targetSessionId || 'Not found'));
    }
    
    log(message) {
        const timestamp = new Date().toISOString();
        const logEntry = timestamp + ' - ' + message + '\\n';
        
        console.log(message);
        
        try {
            fs.appendFileSync(this.logFile, logEntry);
        } catch (error) {
            console.error('Error writing to log:', error);
        }
    }
    
    // Find shells on our target TTY
    findShellsOnTty() {
        const shells = [];
        
        if (!this.targetTty || this.targetTty === '?') {
            // If no TTY, try to use shell PID
            if (this.targetShellPid) {
                return [{ pid: this.targetShellPid, name: 'shell', tty: this.targetTty }];
            }
            return shells;
        }
        
        try {
            const psOutput = execSync('ps -e -o pid,comm,tty').toString();
            const lines = psOutput.split('\\n');
            
            const shellNames = ['bash', 'zsh', 'sh', 'fish', 'ksh', 'tcsh', 'dash'];
            
            for (const line of lines) {
                const parts = line.trim().split(/\\s+/);
                if (parts.length >= 3) {
                    const pid = parseInt(parts[0]);
                    const name = parts[1];
                    const tty = parts[2];
                    
                    if (shellNames.some(shell => name.includes(shell)) && tty === this.targetTty) {
                        shells.push({ pid, name, tty });
                    }
                }
            }
        } catch (error) {
            this.log('Error finding shells: ' + error.message);
        }
        
        // If no shells found on TTY, try the specific shell PID
        if (shells.length === 0 && this.targetShellPid) {
            shells.push({ pid: this.targetShellPid, name: 'shell', tty: this.targetTty });
        }
        
        return shells;
    }
    
    // Get CWD of a process
    getCwd(pid) {
        try {
            return fs.readlinkSync('/proc/' + pid + '/cwd');
        } catch (error) {
            return null;
        }
    }
    
    // Track the shells
    track() {
        this.log('🎯 Starting tracking...');
        
        const interval = setInterval(() => {
            const shells = this.findShellsOnTty();
            
            for (const shell of shells) {
                if (!this.trackedPids.has(shell.pid)) {
                    this.trackedPids.add(shell.pid);
                    this.log('🆕 New shell detected: PID ' + shell.pid + ' (' + shell.name + ')');
                }
                
                const currentPath = this.getCwd(shell.pid);
                
                if (currentPath) {
                    const lastPath = this.currentPaths.get(shell.pid);
                    
                    if (!lastPath || lastPath !== currentPath) {
                        if (lastPath) {
                            this.log('🔄 Directory changed (PID ' + shell.pid + '): ' + lastPath + ' → ' + currentPath);
                        } else {
                            this.log('📍 Initial directory (PID ' + shell.pid + '): ' + currentPath);
                        }
                        
                        this.currentPaths.set(shell.pid, currentPath);
                    }
                }
            }
            
            // Clean up dead processes
            for (const pid of this.trackedPids) {
                try {
                    fs.readlinkSync('/proc/' + pid + '/cwd');
                } catch (error) {
                    this.trackedPids.delete(pid);
                    this.currentPaths.delete(pid);
                }
            }
        }, 500);
        
        // Handle shutdown
        const cleanup = () => {
            clearInterval(interval);
            this.log('👋 Tracker stopped');
            process.exit(0);
        };
        
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        process.on('SIGHUP', cleanup);
    }
}

// Start the tracker
const tracker = new TerminalTracker();
tracker.track();
`;
};

// Main execution flow
const main = async () => {
    console.log('🚀 Terminal Tracker Initialization');
    console.log('📋 Capturing terminal info before backgrounding...');
    
    // Capture terminal info
    const capturedInfo = captureTerminalInfo();
    
    console.log('✅ Terminal info captured:');
    console.log(JSON.stringify(capturedInfo, null, 2));
    
    // Create the tracker code with the captured info embedded
    const trackerCode = createTrackerCode(capturedInfo);
    
    // Write the tracker code to a temp file
    const trackerFile = path.join(os.tmpdir(), `terminal-tracker-bg-${Date.now()}.mjs`);
    fs.writeFileSync(trackerFile, trackerCode, 'utf-8');
    
    console.log('📝 Created background tracker file: ' + trackerFile);
    console.log('🚀 Starting tracker as background process with SyPM...');
    
    // Start the tracker as a background process using SyPM
    try {
        const process = SyPM.run(trackerFile, {
            name: 'terminal-tracker',
            autoRestart: true,
            restartTries: 10,
            uniqueNameLock: true
        });
        
        console.log('✅ Terminal tracker started successfully!');
        console.log('📋 Process Info:');
        console.log('  - Name: ' + process.name);
        console.log('  - PID: ' + process.pid);
        console.log('  - ID: ' + process.id);
        console.log('  - Log: ' + process.log);
        
        console.log('\n📝 To view logs:');
        console.log('  node SyPM.js --log ' + process.id);
        console.log('  or');
        console.log('  tail -f ~/.terminal-tracker/tracked-terminal.log');
        
        console.log('\n🔍 To stop tracking:');
        console.log('  node SyPM.js --kill ' + process.id);
        console.log('  or');
        console.log('  node SyPM.js --kill terminal-tracker');
        
    } catch (error) {
        console.error('❌ Error starting tracker:', error);
        process.exit(1);
    }
};

// Run the main function
main();