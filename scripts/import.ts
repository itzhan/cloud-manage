import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// 复用 src/db.ts 的初始化逻辑（会自动建表）
// 需要先设置 DB_PATH 环境变量，config.ts 会读取
import { getDb } from '../src/db';

const STATE_DIR = process.argv[2];
if (!STATE_DIR) {
  console.error('用法: node dist/scripts/import.js <state目录路径>');
  console.error('例如: node dist/scripts/import.js ../claude注册机/state');
  process.exit(1);
}

function readJson(filename: string): any[] {
  const filepath = path.join(STATE_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.log(`  跳过 ${filename}（文件不存在）`);
    return [];
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

const db = getDb();

console.log('=== Resource Hub 数据导入 ===\n');

// 1. Payment Accounts
console.log('1. 导入 payment_accounts.json ...');
const paymentAccounts = readJson('payment_accounts.json');
if (paymentAccounts.length > 0) {
  const stmt = db.prepare(`INSERT OR REPLACE INTO payment_accounts (id, name, balance, currency, note, addedAt) VALUES (?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const pa of paymentAccounts) {
      stmt.run(pa.id, pa.name, pa.balance ?? 0, pa.currency ?? 'USD', pa.note ?? null, pa.addedAt ?? new Date().toISOString());
    }
  })();
  console.log(`  导入 ${paymentAccounts.length} 条支付账户`);
}

// 2. Cards
console.log('2. 导入 cards.json ...');
let cards = readJson('cards.json');
if (cards.length === 0) cards = readJson('cards.json.migrated');
if (cards.length > 0) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO cards (id, cardNumber, expiry, cvv, brand, cardholder, country, address1, city, state, zip,
      accountId, claudeUsedCount, claudeMaxUsage, codexUsedCount, codexMaxUsage,
      claudePlatformUsedCount, claudePlatformMaxUsage, openaiPlatformUsedCount, openaiPlatformMaxUsage,
      status, deleted, deletedAt, addedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const c of cards) {
      stmt.run(
        c.id, c.cardNumber, c.expiry, c.cvv, c.brand, c.cardholder, c.country, c.address1, c.city, c.state, c.zip,
        c.accountId ?? null,
        c.claudeUsedCount ?? 0, c.claudeMaxUsage ?? 1,
        c.codexUsedCount ?? 0, c.codexMaxUsage ?? 3,
        c.claudePlatformUsedCount ?? 0, c.claudePlatformMaxUsage ?? 3,
        c.openaiPlatformUsedCount ?? 0, c.openaiPlatformMaxUsage ?? 5,
        c.status ?? 'active', c.deleted ? 1 : 0, c.deletedAt ?? null,
        c.addedAt ?? new Date().toISOString(),
      );
    }
  })();
  console.log(`  导入 ${cards.length} 张卡`);
}

// 3. Google Accounts
console.log('3. 导入 google_accounts.json ...');
const google = readJson('google_accounts.json');
if (google.length > 0) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO google_accounts (id, email, password, recoveryEmail, twoFaSecret, used, captcha, abnormal, abnormal_reason, addedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (let i = 0; i < google.length; i++) {
      const a = google[i];
      stmt.run(
        a.id || `ga_imported_${i}`, a.email, a.password,
        a.recoveryEmail ?? null, a.twoFaSecret ?? null,
        a.used ? 1 : 0, a.captcha ? 1 : 0, a.abnormal ? 1 : 0,
        a.abnormal_reason ?? null, a.addedAt ?? new Date().toISOString(),
      );
    }
  })();
  console.log(`  导入 ${google.length} 个谷歌账号`);
}

// 4. Mailcom Accounts
console.log('4. 导入 mailcom_accounts.json ...');
const mailcom = readJson('mailcom_accounts.json');
if (mailcom.length > 0) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO mailcom_accounts (id, email, password, tokenStatus, tokenAt, tokenError, banned, mailBannedAt, mailPaidAt, addedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (let i = 0; i < mailcom.length; i++) {
      const a = mailcom[i];
      stmt.run(
        a.id || `mc_imported_${i}`, a.email, a.password,
        a.tokenStatus ?? 'ok', a.tokenAt ?? null, a.tokenError ?? null,
        a.banned ? 1 : 0, a.mailBannedAt ?? null, a.mailPaidAt ?? null,
        a.addedAt ?? new Date().toISOString(),
      );
    }
  })();
  console.log(`  导入 ${mailcom.length} 个 Mail.com 账号`);
}

// 5. Codex Credentials
console.log('5. 导入 codex_credentials.json ...');
const codex = readJson('codex_credentials.json');
if (codex.length > 0) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO codex_credentials (id, email, accessToken, chatgptAccountId, expiresAt, planType,
      sourceAccountId, sourceTemplateId, sourceTemplateName, usedInvites, maxInvites, invites,
      subscriptionExpiresAt, addedAt, refreshedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const c of codex) {
      stmt.run(
        c.id, c.email, c.accessToken, c.chatgptAccountId ?? null,
        c.expiresAt ?? null, c.planType ?? null,
        c.sourceAccountId ?? null, c.sourceTemplateId ?? null, c.sourceTemplateName ?? null,
        c.usedInvites ?? 0, c.maxInvites ?? 3,
        JSON.stringify(c.invites ?? []),
        c.subscriptionExpiresAt ?? null,
        c.addedAt ?? new Date().toISOString(), c.refreshedAt ?? null,
      );
    }
  })();
  console.log(`  导入 ${codex.length} 个 Codex 凭证`);
}

// 6. Proxies
console.log('6. 导入代理 ...');
const proxyUsage: Record<string, any> = (() => {
  const filepath = path.join(STATE_DIR, 'proxy_usage.json');
  if (!fs.existsSync(filepath)) return {};
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
})();

const proxyMeta: Record<string, any> = (() => {
  const filepath = path.join(STATE_DIR, 'proxy_meta.json');
  if (!fs.existsSync(filepath)) return {};
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
})();

let proxyCount = 0;
const insertProxy = db.prepare(`
  INSERT OR REPLACE INTO proxies (id, host, port, user, pass, region, pool, claudeUsed, claudeCount, openaiCount, openaiInUse, openaiInUseCount, bad, deleted, deletedAt, addedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const filename of ['proxies.json', 'proxy2.csv', 'proxy2_ph.csv']) {
  const filepath = path.join(STATE_DIR, filename);
  if (!fs.existsSync(filepath)) continue;

  if (filename.endsWith('.json')) {
    const proxies = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    db.transaction(() => {
      for (const p of proxies) {
        const key = `${p.host}:${p.port}`;
        const usage = proxyUsage[key] || {};
        const meta = proxyMeta[key] || {};
        insertProxy.run(
          `proxy_${p.host}_${p.port}`, p.host, String(p.port), p.user, p.pass,
          meta.region ?? 'us', 'static',
          usage.claude_used ? 1 : 0, usage.claude_count ?? 0,
          usage.openai_count ?? 0, usage.openai_in_use ? 1 : 0, usage.openai_in_use_count ?? 0,
          p.bad ? 1 : 0, meta.deleted ? 1 : 0, meta.deletedAt ?? null,
          meta.addedAt ?? new Date().toISOString(),
        );
        proxyCount++;
      }
    })();
  } else {
    const lines = fs.readFileSync(filepath, 'utf-8').trim().split('\n').filter(l => l.trim());
    const region = filename.includes('_ph') ? 'ph' : 'us';
    db.transaction(() => {
      for (let line of lines) {
        let used = false, bad = false;
        if (line.startsWith('#BAD')) { bad = true; line = line.replace(/^#BAD\s*/, ''); }
        else if (line.startsWith('#')) { used = true; line = line.replace(/^#\s*/, ''); }

        const parts = line.split(':');
        if (parts.length < 4) continue;
        const [host, port, user, pass] = parts;
        const key = `${host}:${port}`;
        const usage = proxyUsage[key] || {};
        const meta = proxyMeta[key] || {};

        insertProxy.run(
          `proxy_${host}_${port}`, host, port, user, pass,
          meta.region ?? region, 'static',
          used || usage.claude_used ? 1 : 0, usage.claude_count ?? 0,
          usage.openai_count ?? 0, usage.openai_in_use ? 1 : 0, usage.openai_in_use_count ?? 0,
          bad ? 1 : 0, meta.deleted ? 1 : 0, meta.deletedAt ?? null,
          meta.addedAt ?? new Date().toISOString(),
        );
        proxyCount++;
      }
    })();
  }
  console.log(`  从 ${filename} 导入代理`);
}
console.log(`  共导入 ${proxyCount} 个代理`);

console.log('\n=== 导入完成 ===');

const stats: Record<string, number> = {};
for (const table of ['payment_accounts', 'cards', 'google_accounts', 'mailcom_accounts', 'codex_credentials', 'proxies']) {
  stats[table] = (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c;
}
console.log('\n数据库统计:');
for (const [table, count] of Object.entries(stats)) {
  console.log(`  ${table}: ${count}`);
}
