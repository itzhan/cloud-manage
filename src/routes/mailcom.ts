import { Router, Request, Response } from 'express';
import { getDb } from '../db';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = (page - 1) * limit;
  const conditions: string[] = [];
  const params: any[] = [];
  if (req.query.status === 'available') { conditions.push("banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok'"); }
  else if (req.query.status === 'banned') { conditions.push('banned = 1'); }
  else if (req.query.status === 'failed') { conditions.push("tokenStatus = 'failed'"); }
  if (req.query.allocatedTo) { conditions.push('allocatedTo = ?'); params.push(req.query.allocatedTo); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM mailcom_accounts WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT * FROM mailcom_accounts WHERE ${where} ORDER BY addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ data, total, page, limit });
});

router.post('/import', (req: Request, res: Response) => {
  const db = getDb();
  const { accounts = [] } = req.body;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO mailcom_accounts (id, email, password, tokenStatus, tokenAt, tokenError, banned, mailBannedAt, mailPaidAt, addedAt)
    VALUES (@id, @email, @password, @tokenStatus, @tokenAt, @tokenError, @banned, @mailBannedAt, @mailPaidAt, @addedAt)
  `);

  const tx = db.transaction(() => {
    let count = 0;
    for (const a of accounts) {
      stmt.run({
        id: a.id || `mc_${Date.now()}_${String(count).padStart(4, '0')}`,
        email: a.email, password: a.password,
        tokenStatus: a.tokenStatus ?? 'ok',
        tokenAt: a.tokenAt ?? null,
        tokenError: a.tokenError ?? null,
        banned: a.banned ? 1 : 0,
        mailBannedAt: a.mailBannedAt ?? null,
        mailPaidAt: a.mailPaidAt ?? null,
        addedAt: a.addedAt ?? new Date().toISOString(),
      });
      count++;
    }
    return count;
  });

  res.json({ imported: tx() });
});

router.post('/pull', (req: Request, res: Response) => {
  const db = getDb();
  const { count = 1, machineId } = req.body;
  if (!machineId) { res.status(400).json({ error: 'machineId required' }); return; }

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM mailcom_accounts
      WHERE banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok'
      LIMIT ?
    `).all(count) as any[];

    if (rows.length === 0) return { accounts: [] };

    const stmt = db.prepare('UPDATE mailcom_accounts SET allocatedTo = ?, allocatedAt = ? WHERE id = ?');
    for (const row of rows) {
      stmt.run(machineId, now, row.id);
    }

    return {
      accounts: rows.map(r => ({ ...r, banned: !!r.banned, allocatedTo: machineId, allocatedAt: now })),
    };
  });

  res.json(tx());
});

router.post('/release', (req: Request, res: Response) => {
  const db = getDb();
  const { machineId, emails = [] } = req.body;
  if (!machineId) { res.status(400).json({ error: 'machineId required' }); return; }

  const stmt = db.prepare('UPDATE mailcom_accounts SET allocatedTo = NULL, allocatedAt = NULL WHERE email = ? AND allocatedTo = ?');
  const tx = db.transaction(() => {
    let released = 0;
    for (const email of emails) {
      released += stmt.run(email, machineId).changes;
    }
    return released;
  });

  res.json({ released: tx() });
});

router.post('/report', (req: Request, res: Response) => {
  const db = getDb();
  const { machineId, reports = [] } = req.body;
  if (!machineId) { res.status(400).json({ error: 'machineId required' }); return; }

  const tx = db.transaction(() => {
    let updated = 0;
    for (const r of reports) {
      switch (r.result) {
        case 'used':
          db.prepare('UPDATE mailcom_accounts SET allocatedTo = NULL, allocatedAt = NULL WHERE email = ?').run(r.email);
          break;
        case 'banned':
          db.prepare('UPDATE mailcom_accounts SET banned = 1, mailBannedAt = ?, allocatedTo = NULL, allocatedAt = NULL WHERE email = ?')
            .run(new Date().toISOString(), r.email);
          break;
        case 'token_failed':
          db.prepare("UPDATE mailcom_accounts SET tokenStatus = 'failed', tokenError = ?, allocatedTo = NULL, allocatedAt = NULL WHERE email = ?")
            .run(r.error ?? null, r.email);
          break;
        default:
          continue;
      }
      updated++;
    }
    return updated;
  });

  res.json({ updated: tx() });
});

router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM mailcom_accounts').get() as any).c;
  const available = (db.prepare("SELECT COUNT(*) as c FROM mailcom_accounts WHERE banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok'").get() as any).c;
  const allocated = (db.prepare('SELECT COUNT(*) as c FROM mailcom_accounts WHERE allocatedTo IS NOT NULL').get() as any).c;
  const banned = (db.prepare('SELECT COUNT(*) as c FROM mailcom_accounts WHERE banned = 1').get() as any).c;
  const tokenFailed = (db.prepare("SELECT COUNT(*) as c FROM mailcom_accounts WHERE tokenStatus = 'failed'").get() as any).c;

  res.json({ total, available, allocated, banned, tokenFailed });
});

export default router;
