const path = require('path');
const os = require('os');

const dataDir = path.join(os.homedir(), 'zylos/components/om-marketplace-client');

module.exports = {
  apps: [{
    name: 'om-marketplace-client',
    script: 'src/main.js',
    interpreter: 'node',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/om-marketplace-client'),
    // Drops caller env vars whose name contains COCO_ so the API key never reaches the saved PM2 env.
    filter_env: ['COCO_'],
    env: {
      NODE_ENV: 'production'
    },
    // Configuration errors (EX_CONFIG) stop the service instead of restart-looping.
    stop_exit_codes: [78],
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 5000,
    error_file: path.join(dataDir, 'logs/error.log'),
    out_file: path.join(dataDir, 'logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
