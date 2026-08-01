const path = require('node:path');

module.exports = {
  apps: [{
    name: 'nv-agenten',
    cwd: __dirname,
    script: path.join(__dirname, 'agent-dashboard', 'dist', 'server.js'),
    interpreter: process.execPath,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '768M',
    restart_delay: 5000,
    exp_backoff_restart_delay: 100,
    kill_timeout: 15000,
    listen_timeout: 10000,
    time: true,
    merge_logs: true,
    out_file: path.join(__dirname, 'data', 'logs', 'app.log'),
    error_file: path.join(__dirname, 'data', 'logs', 'error.log'),
    env: {
      NODE_ENV: 'production',
      PORT: '3000'
    }
  }]
};
