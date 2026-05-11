'use strict';

/**
 * PM2 config shipped inside the deploy bundle (`cwd` = bundle root on the VM).
 * Loads secrets from `/etc/atent/listener.env` (not copied from dev machines).
 */
const path = require('path');
const fs = require('fs');

const envPath = '/etc/atent/listener.env';
const env = { NODE_ENV: 'production' };

if (fs.existsSync(envPath)) {
  // Resolved from bundle's node_modules after rsync
  const dotenv = require('dotenv');
  Object.assign(env, dotenv.parse(fs.readFileSync(envPath, 'utf8')));
}

module.exports = {
  apps: [
    {
      name: 'atent-listener',
      cwd: __dirname,
      script: path.join(__dirname, 'dist/index.js'),
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      kill_timeout: 8000,
      restart_delay: 5000,
      max_restarts: 8,
      min_uptime: '5s',
      max_memory_restart: '850M',
      env,
    },
    /**
     * TryCloudflare quick tunnel → HTTPS for GitHub Pages (URL may change on restart).
     * Requires: `sudo apt install cloudflared` (or .deb from GitHub). Binary must exist at `script` path.
     * Remove this block if you terminate TLS another way (nginx, named Cloudflare tunnel, etc.).
     */
    {
      name: 'cloudflared-tunnel',
      cwd: __dirname,
      script: '/usr/bin/cloudflared',
      args: 'tunnel --url http://127.0.0.1:3001',
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '120M',
      env,
    },
  ],
};
