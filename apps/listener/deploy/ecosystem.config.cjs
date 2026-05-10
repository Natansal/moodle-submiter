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
      max_memory_restart: '850M',
      env,
    },
  ],
};
