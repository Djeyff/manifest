import 'dotenv/config';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

const isLocalMode = process.env['MANIFEST_MODE'] === 'local';
const isCompiledRuntime = __dirname.includes('/dist/');
const entitiesGlob = isCompiledRuntime
  ? join(__dirname, '..', 'entities', '!(*.spec).js')
  : join(__dirname, '..', 'entities', '!(*.spec).ts');
const migrationsGlob = isCompiledRuntime
  ? join(__dirname, 'migrations', '!(*.spec).js')
  : join(__dirname, 'migrations', '!(*.spec).ts');

function createDataSource(): DataSource {
  if (isLocalMode) {
    const dbPath = process.env['MANIFEST_DB_PATH'] || ':memory:';
    return new DataSource({
      type: 'sqljs',
      location: dbPath === ':memory:' ? undefined : dbPath,
      autoSave: dbPath !== ':memory:',
      entities: [entitiesGlob],
      synchronize: true,
    });
  }

  const databaseUrl =
    process.env['MIGRATION_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgresql://myuser:mypassword@localhost:5432/mydatabase';

  return new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [entitiesGlob],
    migrations: [migrationsGlob],
  });
}

export default createDataSource();
