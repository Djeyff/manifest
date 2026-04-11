const { spawn } = require('node:child_process');
const path = require('node:path');

async function run() {
  const backendRoot = __dirname.startsWith('/app/')
    ? __dirname
    : path.resolve(__dirname, '..');

  const datasourceModule = path.join(backendRoot, 'dist', 'database', 'datasource.js');
  const { default: dataSource } = require(datasourceModule);

  console.log('[bootstrap] Running database migrations...');
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();
  console.log('[bootstrap] Database migrations complete');

  const child = spawn('node', [path.join(backendRoot, 'dist', 'main.js')], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

run().catch((error) => {
  console.error('[bootstrap] Startup failed', error);
  process.exit(1);
});
