const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const SANDBOX_CONFIG = require('./sandbox-config');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

class SandboxExecutor {
  constructor(config = {}) {
    this.config = { ...SANDBOX_CONFIG, ...config };
    this.containerCache = new Map(); // sessionId -> { containerId, lastUsed }
    this.dockerAvailable = null;
  }

  updateConfig(overrides = {}) {
    this.config = { ...this.config, ...overrides };
  }

  async isDockerAvailable() {
    if (this.dockerAvailable !== null) {
      return this.dockerAvailable;
    }
    try {
      await execAsync('docker info');
      this.dockerAvailable = true;
    } catch (err) {
      this.dockerAvailable = false;
    }
    return this.dockerAvailable;
  }

  validateMount(hostPath, containerPath) {
    const normalizedHost = path.resolve(hostPath);
    // Convert to forward slashes for cross-platform checking
    const posixHost = normalizedHost.split(path.sep).join('/');

    // Check for drive root mounts like "C:/" or "/"
    if (/^[a-zA-Z]:\/$/.test(posixHost) || posixHost === '/') {
       const err = new Error(`Mounting root directory is not allowed: ${normalizedHost}`);
       err.code = 'SANDBOX_SECURITY_VIOLATION';
       throw err;
    }

    for (const restricted of this.config.restrictedMounts) {
      const restrictedNormalized = restricted.replace(/\/$/, ''); // e.g. /etc

      // Check if it's EXACTLY the restricted path, or if the host path STARTS with it (as a child)
      // On Windows, the posixHost could look like C:/etc. We split and check the suffix.
      // So if posixHost is "C:/home/user/etc-configs", it should be allowed because /etc does not match exactly the top level parts.

      const posixParts = posixHost.split('/').filter(Boolean);
      // Remove windows drive letter if present
      if (posixParts.length > 0 && /^[a-zA-Z]:$/.test(posixParts[0])) {
        posixParts.shift();
      }

      const hostWithoutDrive = '/' + posixParts.join('/');

      // Now compare hostWithoutDrive to restrictedNormalized
      // Example: hostWithoutDrive is "/etc/configs", restrictedNormalized is "/etc"
      const isMatch = hostWithoutDrive === restrictedNormalized || hostWithoutDrive.startsWith(restrictedNormalized + '/');

      if (isMatch) {
        const err = new Error(`Mounting restricted system path is not allowed: ${normalizedHost}`);
        err.code = 'SANDBOX_SECURITY_VIOLATION';
        throw err;
      }
    }
    return true;
  }

  getContainerArgs() {
    const args = [
      'run',
      '-d', // run in background
      '--rm',
      `--memory=${this.config.memoryLimit}`,
      `--network=${this.config.networkMode}`,
      // Seccomp profile default is implied by docker run unless specifically overridden
      // But we explicitly DO NOT pass unconfined.
    ];
    if (this.config.seccompProfile && this.config.seccompProfile !== 'default') {
      args.push(`--security-opt=seccomp=${this.config.seccompProfile}`);
    }
    return args;
  }

  async getOrCreateContainer(sessionId, workDir) {
    this._cleanupHotCache();

    const cacheKey = `${sessionId}:${workDir || 'default'}`;
    if (this.containerCache.has(cacheKey)) {
      const cached = this.containerCache.get(cacheKey);
      cached.lastUsed = Date.now();
      return cached.containerId;
    }

    let mountArgs = [];
    if (workDir) {
      this.validateMount(workDir, this.config.defaultWorkdir);
      // Ensure path is absolute for mount
      const absWorkDir = path.resolve(workDir);
      mountArgs = ['-v', `${absWorkDir}:${this.config.defaultWorkdir}:rw`];
    }

    const args = [
      ...this.getContainerArgs(),
      ...mountArgs,
      '-w', this.config.defaultWorkdir,
      this.config.defaultImage,
      'tail', '-f', '/dev/null' // Keep container alive
    ];

    try {
      const { stdout } = await execFileAsync('docker', args);
      const containerId = stdout.trim();
      this.containerCache.set(cacheKey, { containerId, lastUsed: Date.now() });
      return containerId;
    } catch (err) {
      throw new Error(`Failed to create sandbox container: ${err.message}`);
    }
  }

  async execute(command, options = {}) {
    const useSandbox = options.useSandbox !== false; // Default to true if configured
    const isDocker = await this.isDockerAvailable();

    if (!useSandbox || !isDocker) {
      // Fallback to direct execution
      return this._executeDirect(command, options);
    }

    const sessionId = options.sessionId || 'default';
    const workDir = options.workingDirectory || process.cwd();

    let containerId;
    try {
      containerId = await this.getOrCreateContainer(sessionId, workDir);
    } catch (error) {
      if (error.code === 'SANDBOX_SECURITY_VIOLATION') {
        // We MUST NOT fallback on a security violation
        return {
          success: false,
          stdout: '',
          stderr: error.message,
          exitCode: 1,
          environment: { platform: 'linux', shell: 'sh', sandbox: true }
        };
      }
      // Fallback if container creation fails (e.g. image not found)
      console.warn(`[sandbox-executor] Container creation failed: ${error.message}. Falling back to direct execution.`);
      return this._executeDirect(command, options);
    }

    try {
      const args = ['exec', '-i', containerId, 'sh', '-c', command];
      const timeout = options.timeout || this.config.timeoutMs;
      const { stdout, stderr } = await execFileAsync('docker', args, {
        timeout: Math.min(timeout, 600000),
        maxBuffer: 10 * 1024 * 1024,
        // signal: when the agent loop's abort fires, child_process kills
        // the docker exec subprocess. Without this, a cancelled turn would
        // leave a 60-second command running in the container.
        signal: options.signal || undefined
      });

      return {
        success: true,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        exitCode: 0,
        environment: {
          platform: 'linux', // Sandbox is linux
          shell: 'sh',
          sandbox: true
        }
      };
    } catch (error) {
      return {
        success: false,
        stdout: (error.stdout || '').trim(),
        stderr: (error.stderr || error.message || '').trim(),
        exitCode: typeof error.code === 'number' ? error.code : 1,
        environment: {
          platform: 'linux',
          shell: 'sh',
          sandbox: true
        }
      };
    }
  }

  async _executeDirect(command, options) {
    const timeout = options.timeout || this.config.timeoutMs;
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: Math.min(timeout, 600000),
        maxBuffer: 10 * 1024 * 1024,
        cwd: options.workingDirectory || process.cwd(),
        shell: true,
        signal: options.signal || undefined
      });

      const hostShell = process.platform === 'win32'
        ? (process.env.ComSpec || 'cmd.exe')
        : (process.env.SHELL || '/bin/sh');

      return {
        success: true,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        exitCode: 0,
        environment: {
          platform: process.platform,
          shell: hostShell,
          sandbox: false
        }
      };
    } catch (error) {
      const hostShell = process.platform === 'win32'
        ? (process.env.ComSpec || 'cmd.exe')
        : (process.env.SHELL || '/bin/sh');

      return {
        success: false,
        stdout: (error.stdout || '').trim(),
        stderr: (error.stderr || error.message || '').trim(),
        exitCode: typeof error.code === 'number' ? error.code : 1,
        environment: {
          platform: process.platform,
          shell: hostShell,
          sandbox: false
        }
      };
    }
  }

  _cleanupHotCache() {
    const now = Date.now();
    for (const [sessionId, data] of this.containerCache.entries()) {
      if (now - data.lastUsed > this.config.hotCacheTtlMs) {
        // Stop container async, don't wait
        execAsync(`docker rm -f ${data.containerId}`).catch(() => {});
        this.containerCache.delete(sessionId);
      }
    }
  }

  async cleanup() {
    const promises = [];
    for (const [sessionId, data] of this.containerCache.entries()) {
      promises.push(execAsync(`docker rm -f ${data.containerId}`).catch(() => {}));
    }
    await Promise.all(promises);
    this.containerCache.clear();
  }
}

module.exports = SandboxExecutor;
