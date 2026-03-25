const SANDBOX_CONFIG = {
  defaultImage: 'debian:bookworm-slim',
  memoryLimit: '512m',
  timeoutMs: 120000,
  networkMode: 'bridge',
  hotCacheTtlMs: 300000, // 5 minutes
  restrictedMounts: [
    '/etc',
    '/proc',
    '/sys',
    '/dev',
    '/root',
    '/boot',
    '/var/run/docker.sock'
  ],
  defaultWorkdir: '/workspace',
  seccompProfile: 'default'
};

module.exports = SANDBOX_CONFIG;
