module.exports = {
  apps: [
    {
      name: "wechat-agent-bridge",
      script: "dist/index.js",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
      },
      // Write stdout/stderr to files so you can check logs anytime
      out_file: "./data/logs/out.log",
      error_file: "./data/logs/err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      // Windows-specific: use fork mode (cluster doesn't work well on win32)
      exec_mode: "fork",
    },
  ],
};
