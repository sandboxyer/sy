import { exec } from 'child_process';
import os from 'os';

/**
 * Force closes all server processes and frees all ports
 * Supports Linux, macOS, and Windows
 */
async function killAllServers() {
  const platform = os.platform();
  
  return new Promise((resolve, reject) => {
    let command;
    
    if (platform === 'win32') {
      // Windows: Find and kill node processes
      command = 'taskkill /F /IM node.exe';
    } else {
      // Linux/macOS: Kill processes on common server ports (3000-9999)
      command = `
        lsof -ti :3000-9999 | xargs -r kill -9 2>/dev/null;
        pkill -f node;
        pkill -f python;
        pkill -f java;
        echo "done"
      `;
    }
    
    exec(command, (error, stdout, stderr) => {
      if (error && platform !== 'win32') {
        // On Unix systems, pkill might return error if no processes found, which is fine
        console.log('All server processes terminated (or none were running)');
        resolve();
      } else if (error) {
        console.error('Error killing processes:', error.message);
        reject(error);
      } else {
        console.log('All server processes forcefully terminated');
        console.log('Output:', stdout);
        resolve(stdout);
      }
    });
  });
}

/**
 * Force closes the process running on a specific port
 * Supports Linux, macOS, and Windows
 * @param {number|string} port - The port to free
 */
async function killPort(port) {
  const platform = os.platform();
  const portNumber = parseInt(port, 10);

  if (!portNumber || portNumber < 1 || portNumber > 65535) {
    return Promise.reject(new Error(`Invalid port: ${port}`));
  }

  return new Promise((resolve, reject) => {
    let command;

    if (platform === 'win32') {
      // Windows: Find the PID listening on the port and kill it
      command = `
        for /f "tokens=5" %a in ('netstat -ano ^| findstr :${portNumber} ^| findstr LISTENING') do taskkill /F /PID %a
      `;
    } else {
      // Linux/macOS: Find the PID listening on the port and kill it
      command = `
        pids=$(lsof -ti :${portNumber});
        if [ -n "$pids" ]; then
          echo "$pids" | xargs kill -9;
          echo "killed";
        else
          echo "no process on port ${portNumber}";
        fi
      `;
    }

    exec(command, (error, stdout, stderr) => {
      if (error) {
        // On Unix, lsof might return non-zero if no process found; treat as success
        if (platform !== 'win32') {
          console.log(`No process found on port ${portNumber} (or already free)`);
          resolve();
        } else {
          console.error(`Error killing process on port ${portNumber}:`, error.message);
          reject(error);
        }
      } else {
        console.log(`Port ${portNumber} cleared`);
        console.log('Output:', stdout);
        resolve(stdout);
      }
    });
  });
}

// Main execution when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const argPort = process.argv[2];

  if (argPort) {
    // Specific port mode: clear ONLY that port
    console.log(`Force closing process on port ${argPort}...`);

    killPort(argPort)
      .then(() => {
        console.log(`✓ Port ${argPort} should now be free`);
        process.exit(0);
      })
      .catch((error) => {
        console.error(`✗ Failed to kill process on port ${argPort}:`, error);
        process.exit(1);
      });
  } else {
    // Default mode: kill all servers (original behavior, untouched)
    console.log('Force closing all server processes...');

    killAllServers()
      .then(() => {
        console.log('✓ All ports should now be free');
        process.exit(0);
      })
      .catch((error) => {
        console.error('✗ Failed to kill servers:', error);
        process.exit(1);
      });
  }
}

export { killPort };
export default killAllServers;