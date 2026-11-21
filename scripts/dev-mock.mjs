// npm run dev:mock : 偽Anthropicサーバーと wrangler dev を同時に起動する。課金は発生しない。
import { spawn, spawnSync } from 'node:child_process';

const sh = process.platform === 'win32';
const mig = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local'], { stdio: 'inherit', shell: sh });
if (mig.status !== 0) process.exit(mig.status ?? 1);

const mock = spawn(process.execPath, ['scripts/mock-anthropic.mjs'], { stdio: 'inherit' });
const port = process.env.PORT || '8787';
const dev = spawn(
  'npx',
  ['wrangler', 'dev', '--port', port, '--var', 'ANTHROPIC_BASE_URL:http://127.0.0.1:8788', '--var', 'ANTHROPIC_API_KEY:sk-ant-mock', ...(process.env.CAP_USD ? ['--var', `CAP_USD:${process.env.CAP_USD}`] : [])],
  { stdio: 'inherit', shell: sh },
);
const stop = () => { mock.kill(); dev.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
dev.on('exit', () => { mock.kill(); process.exit(0); });
