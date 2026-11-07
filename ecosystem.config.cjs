module.exports = {
  apps: [{
    name: 'linkedin-bot',
    script: './dist/index.js',
    args: '--live',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 5000,
    min_uptime: '30s',
    max_restarts: 10,
    kill_timeout: 35000,
    time: true
  }]
};
