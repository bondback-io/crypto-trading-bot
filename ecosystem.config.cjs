/**
 * PM2 process manager config — 24/7 deployment on a VPS or dedicated host.
 *
 * Usage:
 *   npm run build
 *   npm run pm2:start
 *   npm run pm2:logs
 */
module.exports = {
  apps: [
    {
      name: 'solana-copy-bot',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 15_000,
      listen_timeout: 30_000,
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        HOST: '0.0.0.0',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
