import fs from 'fs';
import path from 'path';
import prompts from 'prompts';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const CONFIG_JSON = path.resolve(process.cwd(), 'deploy/config.json');

type DeployMode = 'local' | 'public';

type EnvKeys = 'BASE_URL' | 'DEPLOY_MODE' | 'PUBLIC_DOMAIN';

const readEnv = (): Partial<Record<EnvKeys, string>> => {
  if (!fs.existsSync(ENV_PATH)) return {};
  return fs
    .readFileSync(ENV_PATH, 'utf-8')
    .split(/\r?\n/)
    .reduce<Partial<Record<EnvKeys, string>>>((acc, line) => {
      const [key, ...rest] = line.split('=');
      if (!key) return acc;
      if (['BASE_URL', 'DEPLOY_MODE', 'PUBLIC_DOMAIN'].includes(key)) {
        acc[key as EnvKeys] = rest.join('=');
      }
      return acc;
    }, {});
};

const persist = (values: Partial<Record<EnvKeys, string>>) => {
  const env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/) : [];
  const map = new Map(env.filter(Boolean).map((line) => {
    const [key, ...rest] = line.split('=');
    return [key, rest.join('=')];
  }));
  Object.entries(values).forEach(([key, val]) => {
    if (val !== undefined) map.set(key, val);
  });
  const nextEnv = Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  fs.writeFileSync(ENV_PATH, nextEnv);
  fs.mkdirSync(path.dirname(CONFIG_JSON), { recursive: true });
  fs.writeFileSync(CONFIG_JSON, JSON.stringify(values, null, 2));
};

const run = async () => {
  console.log('GeoCachingEngine Deployment Wizard');
  const existing = readEnv();
  const onCancel = () => {
    console.log('Abgebrochen');
    process.exit(1);
  };

  const { mode } = await prompts(
    {
      type: 'select',
      name: 'mode',
      message: 'Deployment Mode',
      choices: [
        { title: 'local (nur LAN/localhost)', value: 'local' },
        { title: 'public (Domain / Reverse Proxy)', value: 'public' }
      ],
      initial: existing.DEPLOY_MODE === 'public' ? 1 : 0
    },
    { onCancel }
  );

  let domain: string | undefined;
  if (mode === 'public') {
    const resp = await prompts(
      {
        type: 'text',
        name: 'domain',
        message: 'Domain (z.B. geocache.example.org)',
        initial: existing.PUBLIC_DOMAIN
      },
      { onCancel }
    );
    domain = resp.domain;
  }

  const { baseUrl } = await prompts(
    {
      type: 'text',
      name: 'baseUrl',
      message: 'Basis-URL der Instanz',
      initial: existing.BASE_URL || (domain ? `https://${domain}` : 'http://localhost:4173')
    },
    { onCancel }
  );

  persist({ BASE_URL: baseUrl, DEPLOY_MODE: mode, PUBLIC_DOMAIN: domain });
  console.log('Deployment-Konfiguration gespeichert.');
};

void run();
