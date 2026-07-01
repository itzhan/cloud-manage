import { Router, Request, Response } from 'express';
import { getDb } from '../db';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const db = getDb();

  const count = (table: string, where = '1=1') =>
    (db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE ${where}`).get() as any).c;

  res.json({
    cards: {
      total: count('cards', 'deleted = 0'),
      active: count('cards', "deleted = 0 AND status = 'active'"),
      allocated: count('cards', 'deleted = 0 AND allocatedTo IS NOT NULL'),
    },
    google: {
      total: count('google_accounts'),
      available: count('google_accounts', 'used = 0 AND captcha = 0 AND abnormal = 0 AND allocatedTo IS NULL'),
      allocated: count('google_accounts', 'allocatedTo IS NOT NULL'),
    },
    mailcom: {
      total: count('mailcom_accounts'),
      available: count('mailcom_accounts', "banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok'"),
      allocated: count('mailcom_accounts', 'allocatedTo IS NOT NULL'),
    },
    proxies: {
      total: count('proxies', 'deleted = 0'),
      available: count('proxies', 'deleted = 0 AND bad = 0 AND allocatedTo IS NULL'),
      allocated: count('proxies', 'deleted = 0 AND allocatedTo IS NOT NULL'),
    },
    codex: {
      total: count('codex_credentials'),
      available: count('codex_credentials', 'allocatedTo IS NULL AND usedInvites < maxInvites'),
      allocated: count('codex_credentials', 'allocatedTo IS NOT NULL'),
    },
  });
});

export default router;
