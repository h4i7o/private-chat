// npm run setup : ローカル開発の初期設定を一度で済ませる。
import { existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`Node.js 20 以上が必要です(現在 ${process.versions.node})。https://nodejs.org から LTS を入れてください。`);
  process.exit(1);
}
console.log(`✓ Node.js ${process.versions.node}`);

if (!existsSync('.dev.vars')) {
  copyFileSync('.dev.vars.example', '.dev.vars');
  console.log('✓ .dev.vars を作りました。ANTHROPIC_API_KEY を書き換えてください(モック確認だけなら不要です)');
} else {
  console.log('✓ .dev.vars はすでにあります');
}

const r = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log('\n✓ データベースを用意しました\n');
console.log('次の一手:');
console.log('  npm run dev:mock   # 実APIを使わず動作確認(課金なし)');
console.log('  npm run dev        # 実APIにつなぐ(.dev.vars のキーが必要)');
