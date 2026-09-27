// PM2 process file. Build first (`npm run build`), then: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'grid-bot',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1, // never run more than one instance against the same state file / account
      exec_mode: 'fork',
      autorestart: true,
      // Back off between restarts so a persistent failure (bad key, exchange outage) doesn't
      // hammer the API or flood your inbox with crash emails.
      exp_backoff_restart_delay: 5000,
      min_uptime: '60s',
      max_restarts: 15,
      max_memory_restart: '300M',
      // The bot finishes its current check and saves state on SIGINT; allow time for that.
      kill_timeout: 35000,
      env: {
        NODE_ENV: 'production',
      },
      // PM2's own stdout/stderr capture; the bot also writes rotating JSON logs to ./logs
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
