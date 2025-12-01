import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import prompts from 'prompts';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const DATABASE_URL = 'postgresql://admin:admin@localhost:5432/geocaching';

const CONFIG_FIELDS = [
  'PUBLIC_URL',
  'INSTANCE_NAME',
  'DEFAULT_LOCALES',
  'ENABLED_LOCALES',
  'CACHE_VISIBILITY_RADIUS',
  'CACHE_FOUND_RADIUS',
  'IMPRESSUM_URL',
  'PRIVACY_URL',
  'SUPPORT_EMAIL',
  'DATA_RETENTION_DAYS',
  'ADMIN_EMAIL'
] as const;

type ConfigKey = (typeof CONFIG_FIELDS)[number];
type EnvRecord = Partial<Record<ConfigKey | 'ADMIN_PASSWORD', string>>;

const readExistingEnv = (): EnvRecord => {
  if (!fs.existsSync(ENV_PATH)) return {};
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  return content.split(/\r?\n/).reduce<EnvRecord>((acc, line) => {
    const [key, ...rest] = line.split('=');
    if (!key) return acc;
    acc[key as keyof EnvRecord] = rest.join('=');
    return acc;
  }, {});
};

const defaults: EnvRecord = {
  PUBLIC_URL: 'http://localhost:5173',
  INSTANCE_NAME: 'GeoCachingEngine',
  DEFAULT_LOCALES: 'en',
  ENABLED_LOCALES: 'en,de',
  CACHE_VISIBILITY_RADIUS: '1000',
  CACHE_FOUND_RADIUS: '50',
  IMPRESSUM_URL: 'https://example.com/impressum',
  PRIVACY_URL: 'https://example.com/privacy',
  SUPPORT_EMAIL: 'support@example.com',
  DATA_RETENTION_DAYS: '30',
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'change-me-now'
};

const persistEnv = (values: EnvRecord) => {
  const lines: string[] = [`DATABASE_URL=${DATABASE_URL}`];
  CONFIG_FIELDS.forEach((key) => {
    lines.push(`${key}=${values[key] ?? ''}`);
  });
  lines.push(`ADMIN_PASSWORD=${values.ADMIN_PASSWORD ?? defaults.ADMIN_PASSWORD}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n'));
};

const runWizard = async () => {
  console.log('GeoCachingEngine Setup Wizard');
  console.log('------------------------------');

  const existing = readExistingEnv();
  const onCancel = () => {
    console.log('Setup abgebrochen.');
    process.exit(1);
  };

  const responses = await prompts(
    CONFIG_FIELDS.map((key) => ({
      type: 'text',
      name: key,
      message: key,
      initial: existing[key] || defaults[key]
    })),
    { onCancel }
  );

  const { adminPassword } = await prompts(
    {
      type: 'password',
      name: 'adminPassword',
      message: 'Admin Passwort festlegen (mind. 12 Zeichen)',
      validate: (val) => (val && val.length >= 12 ? true : 'Mindestens 12 Zeichen erforderlich'),
      initial: existing.ADMIN_PASSWORD || defaults.ADMIN_PASSWORD
    },
    { onCancel }
  );

  const { runMigrations } = await prompts(
    {
      type: 'toggle',
      name: 'runMigrations',
      message: 'Prisma-Migrationen jetzt ausführen?',
      initial: true,
      active: 'Ja',
      inactive: 'Nein'
    },
    { onCancel }
  );

  const envValues: EnvRecord = {
    ...responses,
    SUPPORT_EMAIL: responses.SUPPORT_EMAIL,
    ADMIN_PASSWORD: adminPassword ?? existing.ADMIN_PASSWORD ?? defaults.ADMIN_PASSWORD
  };
  persistEnv(envValues);

  console.log(`.env gespeichert unter ${ENV_PATH}`);
  console.log(`DATABASE_URL wurde automatisch gesetzt auf ${DATABASE_URL}`);

  if (runMigrations) {
    try {
      console.log('Starte Prisma Migrationen...');
      execSync('npx prisma migrate dev --name init', { stdio: 'inherit' });
      execSync('npx prisma generate', { stdio: 'inherit' });
      console.log('Migrationen abgeschlossen.');
    } catch (error) {
      console.error('Fehler beim Ausführen der Migrationen:', error);
    }
  } else {
    console.log('Migrationen wurden übersprungen.');
  }
};

void runWizard();
