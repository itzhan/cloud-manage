import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config';

let db: Database.Database;

export function getDb(): Database.Database {
  if (db) return db;

  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  initTables(db);
  return db;
}

function initTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_accounts (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      balance   REAL DEFAULT 0,
      currency  TEXT DEFAULT 'USD',
      note      TEXT,
      addedAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id                      TEXT PRIMARY KEY,
      cardNumber              TEXT NOT NULL,
      expiry                  TEXT,
      cvv                     TEXT,
      brand                   TEXT,
      cardholder              TEXT,
      country                 TEXT,
      address1                TEXT,
      city                    TEXT,
      state                   TEXT,
      zip                     TEXT,
      accountId               TEXT REFERENCES payment_accounts(id),
      claudeUsedCount         INTEGER DEFAULT 0,
      claudeMaxUsage          INTEGER DEFAULT 1,
      codexUsedCount          INTEGER DEFAULT 0,
      codexMaxUsage           INTEGER DEFAULT 3,
      claudePlatformUsedCount INTEGER DEFAULT 0,
      claudePlatformMaxUsage  INTEGER DEFAULT 3,
      openaiPlatformUsedCount INTEGER DEFAULT 0,
      openaiPlatformMaxUsage  INTEGER DEFAULT 5,
      status                  TEXT DEFAULT 'active',
      allocatedTo             TEXT,
      allocatedAt             TEXT,
      deleted                 INTEGER DEFAULT 0,
      deletedAt               TEXT,
      addedAt                 TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
    CREATE INDEX IF NOT EXISTS idx_cards_brand ON cards(brand);
    CREATE INDEX IF NOT EXISTS idx_cards_allocated ON cards(allocatedTo);

    CREATE TABLE IF NOT EXISTS codex_credentials (
      id                    TEXT PRIMARY KEY,
      email                 TEXT NOT NULL,
      accessToken           TEXT NOT NULL,
      chatgptAccountId      TEXT,
      expiresAt             TEXT,
      planType              TEXT,
      sourceAccountId       TEXT,
      sourceTemplateId      TEXT,
      sourceTemplateName    TEXT,
      usedInvites           INTEGER DEFAULT 0,
      maxInvites            INTEGER DEFAULT 3,
      invites               TEXT DEFAULT '[]',
      subscriptionExpiresAt TEXT,
      allocatedTo           TEXT,
      allocatedAt           TEXT,
      addedAt               TEXT NOT NULL,
      refreshedAt           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_codex_allocated ON codex_credentials(allocatedTo);

    CREATE TABLE IF NOT EXISTS mailcom_accounts (
      id           TEXT PRIMARY KEY,
      email        TEXT NOT NULL UNIQUE,
      password     TEXT NOT NULL,
      tokenStatus  TEXT DEFAULT 'ok',
      tokenAt      TEXT,
      tokenError   TEXT,
      banned       INTEGER DEFAULT 0,
      mailBannedAt TEXT,
      mailPaidAt   TEXT,
      allocatedTo  TEXT,
      allocatedAt  TEXT,
      addedAt      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mailcom_allocated ON mailcom_accounts(allocatedTo);
    CREATE INDEX IF NOT EXISTS idx_mailcom_banned ON mailcom_accounts(banned);

    CREATE TABLE IF NOT EXISTS google_accounts (
      id              TEXT PRIMARY KEY,
      email           TEXT NOT NULL UNIQUE,
      password        TEXT NOT NULL,
      recoveryEmail   TEXT,
      twoFaSecret     TEXT,
      used            INTEGER DEFAULT 0,
      captcha         INTEGER DEFAULT 0,
      abnormal        INTEGER DEFAULT 0,
      abnormal_reason TEXT,
      allocatedTo     TEXT,
      allocatedAt     TEXT,
      addedAt         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_google_used ON google_accounts(used);
    CREATE INDEX IF NOT EXISTS idx_google_allocated ON google_accounts(allocatedTo);

    CREATE TABLE IF NOT EXISTS proxies (
      id               TEXT PRIMARY KEY,
      host             TEXT NOT NULL,
      port             TEXT NOT NULL,
      user             TEXT NOT NULL,
      pass             TEXT NOT NULL,
      region           TEXT DEFAULT 'us',
      pool             TEXT DEFAULT 'static',
      claudeUsed       INTEGER DEFAULT 0,
      claudeCount      INTEGER DEFAULT 0,
      openaiCount      INTEGER DEFAULT 0,
      openaiInUse      INTEGER DEFAULT 0,
      openaiInUseCount INTEGER DEFAULT 0,
      bad              INTEGER DEFAULT 0,
      bad_reason       TEXT,
      allocatedTo      TEXT,
      allocatedAt       TEXT,
      deleted          INTEGER DEFAULT 0,
      deletedAt        TEXT,
      addedAt          TEXT,
      UNIQUE(host, port)
    );
    CREATE INDEX IF NOT EXISTS idx_proxies_allocated ON proxies(allocatedTo);
    CREATE INDEX IF NOT EXISTS idx_proxies_region ON proxies(region);
  `);
}
