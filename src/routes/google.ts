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
  if (req.query.status === 'available') { conditions.push('used = 0 AND captcha = 0 AND abnormal = 0 AND allocatedTo IS NULL'); }
  else if (req.query.status === 'used') { conditions.push('used = 1'); }
  else if (req.query.status === 'abnormal') { conditions.push('(captcha = 1 OR abnormal = 1)'); }
  if (req.query.allocatedTo) { conditions.push('allocatedTo = ?'); params.push(req.query.allocatedTo); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM google_accounts WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT * FROM google_accounts WHERE ${where} ORDER BY addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ data, total, page, limit });
});

router.post('/import', (req: Request, res: Response) => {
  const db = getDb();
  const { accounts = [] } = req.body;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO google_accounts (id, email, password, recoveryEmail, twoFaSecret, used, captcha, abnormal, abnormal_reason, addedAt)
    VALUES (@id, @email, @password, @recoveryEmail, @twoFaSecret, @used, @captcha, @abnormal, @abnormal_reason, @addedAt)
  `);

  const tx = db.transaction(() => {
    let count = 0;
    for (const a of accounts) {
      stmt.run({
        id: a.id || `ga_${Date.now()}_${count}`,
        email: a.email, password: a.password,
        recoveryEmail: a.recoveryEmail ?? null,
        twoFaSecret: a.twoFaSecret ?? null,
        used: a.used ? 1 : 0,
        captcha: a.captcha ? 1 : 0,
        abnormal: a.abnormal ? 1 : 0,
        abnormal_reason: a.abnormal_reason ?? null,
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
  const { count = 1, machineId, require2fa = false, preview } = req.body;
  if (!machineId) { res.status(400).json({ error: 'machineId required' }); return; }

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    let query = `SELECT * FROM google_accounts WHERE used = 0 AND captcha = 0 AND abnormal = 0 AND allocatedTo IS NULL`;
    if (require2fa) query += ` AND twoFaSecret IS NOT NULL AND twoFaSecret != ''`;
    query += ` LIMIT ?`;

    const rows = db.prepare(query).all(count) as any[];
    if (rows.length === 0) return { accounts: [] };

    if (!preview) {
      const stmt = db.prepare('UPDATE google_accounts SET allocatedTo = ?, allocatedAt = ? WHERE id = ?');
      for (const row of rows) {
        stmt.run(machineId, now, row.id);
      }
    }

    return {
      accounts: rows.map(r => ({
        ...r, used: !!r.used, captcha: !!r.captcha, abnormal: !!r.abnormal,
        ...(preview ? {} : { allocatedTo: machineId, allocatedAt: now }),
      })),
    };
  });

  res.json(tx());
});

router.post('/release', (req: Request, res: Response) => {
  const db = getDb();
  const { machineId, emails = [] } = req.body;
  if (!machineId) { res.status(400).json({ error: 'machineId required' }); return; }

  const stmt = db.prepare('UPDATE google_accounts SET allocatedTo = NULL, allocatedAt = NULL WHERE email = ? AND allocatedTo = ?');
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
          db.prepare('UPDATE google_accounts SET used = 1, allocatedTo = NULL, allocatedAt = NULL WHERE email = ?').run(r.email);
          break;
        case 'captcha':
          db.prepare('UPDATE google_accounts SET used = 1, captcha = 1, allocatedTo = NULL, allocatedAt = NULL WHERE email = ?').run(r.email);
          break;
        case 'abnormal':
          db.prepare('UPDATE google_accounts SET used = 1, abnormal = 1, abnormal_reason = ?, allocatedTo = NULL, allocatedAt = NULL WHERE email = ?').run(r.reason ?? null, r.email);
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
  const total = (db.prepare('SELECT COUNT(*) as c FROM google_accounts').get() as any).c;
  const available = (db.prepare('SELECT COUNT(*) as c FROM google_accounts WHERE used = 0 AND captcha = 0 AND abnormal = 0 AND allocatedTo IS NULL').get() as any).c;
  const allocated = (db.prepare('SELECT COUNT(*) as c FROM google_accounts WHERE allocatedTo IS NOT NULL').get() as any).c;
  const used = (db.prepare('SELECT COUNT(*) as c FROM google_accounts WHERE used = 1').get() as any).c;
  const captcha = (db.prepare('SELECT COUNT(*) as c FROM google_accounts WHERE captcha = 1').get() as any).c;
  const abnormal = (db.prepare('SELECT COUNT(*) as c FROM google_accounts WHERE abnormal = 1').get() as any).c;
  const with2fa = (db.prepare("SELECT COUNT(*) as c FROM google_accounts WHERE used = 0 AND captcha = 0 AND abnormal = 0 AND twoFaSecret IS NOT NULL AND twoFaSecret != ''").get() as any).c;

  res.json({ total, available, allocated, used, captcha, abnormal, availableWith2fa: with2fa });
});

export default router;
