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
    INSERT OR REPLACE INTO mailcom_accounts (id, email, password, tokenStatus, tokenAt, tokenError, banned, mailBannedAt, mailPaidAt, accessToken, refreshToken, sessionExpiresAt, addedAt)
    VALUES (@id, @email, @password, @tokenStatus, @tokenAt, @tokenError, @banned, @mailBannedAt, @mailPaidAt, @accessToken, @refreshToken, @sessionExpiresAt, @addedAt)
  `);

  const tx = db.transaction(() => {
    let count = 0;
    const importedEmails: string[] = [];
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
        accessToken: a.accessToken ?? null,
        refreshToken: a.refreshToken ?? null,
        sessionExpiresAt: a.sessionExpiresAt ?? null,
        addedAt: a.addedAt ?? new Date().toISOString(),
      });
      if (!a.accessToken) importedEmails.push(a.email);
      count++;
    }
    return { count, importedEmails };
  });

  const result = tx();
  res.json({ imported: result.count });

  // Async prelogin for newly imported accounts without tokens
  if (result.importedEmails.length > 0) {
    preloginAccounts(result.importedEmails).catch(() => {});
  }
});

router.post('/pull', (req: Request, res: Response) => {
  const db = getDb();
  const { count = 1, machineId, preview } = req.body;
  if (!machineId) { res.status(400).json({ error: 'machineId required' }); return; }

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM mailcom_accounts
      WHERE banned = 0 AND allocatedTo IS NULL AND tokenStatus = 'ok'
      LIMIT ?
    `).all(count) as any[];

    if (rows.length === 0) return { accounts: [] };

    if (!preview) {
      const stmt = db.prepare('UPDATE mailcom_accounts SET allocatedTo = ?, allocatedAt = ? WHERE id = ?');
      for (const row of rows) {
        stmt.run(machineId, now, row.id);
      }
    }

    return {
      accounts: rows.map(r => ({
        ...r, banned: !!r.banned,
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

// --- Token caching & inbox helpers ---

async function preloginAccounts(emails?: string[]) {
  const db = getDb();
  // @ts-ignore - dynamic ESM import
  const { MailComClient, MemorySessionStore } = await import('../mailcom-sdk/index.js');

  let rows: any[];
  if (emails && emails.length > 0) {
    const placeholders = emails.map(() => '?').join(',');
    rows = db.prepare(`SELECT email, password FROM mailcom_accounts WHERE email IN (${placeholders})`).all(...emails) as any[];
  } else {
    rows = db.prepare(`SELECT email, password FROM mailcom_accounts WHERE tokenStatus != 'ok' OR accessToken IS NULL`).all() as any[];
  }

  const results: { email: string; status: string; error?: string }[] = [];
  let success = 0;
  let failed = 0;

  // Concurrency limiter: process N at a time
  const concurrency = 5;
  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(async (row: any) => {
      try {
        const store = new MemorySessionStore();
        const client = new MailComClient({ email: row.email, password: row.password, sessionStore: store });
        const session = await client.auth.login();
        const now = new Date().toISOString();
        db.prepare(`UPDATE mailcom_accounts SET accessToken = ?, refreshToken = ?, sessionExpiresAt = ?, tokenStatus = 'ok', tokenAt = ? WHERE email = ?`)
          .run(session.accessToken, session.refreshToken, session.expiresAt ? new Date(session.expiresAt).toISOString() : null, now, row.email);
        return { email: row.email, status: 'ok' };
      } catch (err: any) {
        db.prepare(`UPDATE mailcom_accounts SET tokenStatus = 'failed', tokenError = ? WHERE email = ?`)
          .run(err.message || String(err), row.email);
        return { email: row.email, status: 'failed', error: err.message || String(err) };
      }
    }));

    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
        if (r.value.status === 'ok') success++;
        else failed++;
      }
    }
  }

  return { total: rows.length, success, failed, results };
}

router.post('/prelogin', async (req: Request, res: Response) => {
  try {
    const { emails } = req.body as { emails?: string[] };
    const result = await preloginAccounts(emails);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

router.get('/inbox', async (req: Request, res: Response) => {
  try {
    const email = req.query.email as string;
    const mailId = req.query.mailId as string | undefined;
    if (!email) { res.status(400).json({ error: 'email query param required' }); return; }

    const db = getDb();
    const account = db.prepare('SELECT * FROM mailcom_accounts WHERE email = ?').get(email) as any;
    if (!account) { res.status(404).json({ error: 'Account not found' }); return; }

    // @ts-ignore - dynamic ESM import
    const { MailComClient, MemorySessionStore } = await import('../mailcom-sdk/index.js');
    const store = new MemorySessionStore();

    // Pre-load cached session if available
    if (account.accessToken) {
      await store.save(email, {
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        accountEmail: email,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(account.sessionExpiresAt ? { expiresAt: new Date(account.sessionExpiresAt).getTime() } : {}),
      });
    }

    const client = new MailComClient({ email: account.email, password: account.password, sessionStore: store });
    await client.auth.login();

    // Update tokens in DB after login (may have been refreshed)
    const session = (client as any).session;
    if (session?.accessToken) {
      db.prepare(`UPDATE mailcom_accounts SET accessToken = ?, refreshToken = ?, sessionExpiresAt = ?, tokenStatus = 'ok', tokenAt = ? WHERE email = ?`)
        .run(session.accessToken, session.refreshToken, session.expiresAt ? new Date(session.expiresAt).toISOString() : null, new Date().toISOString(), email);
    }

    if (mailId) {
      const body = await client.mail.getBody(mailId, { format: 'html', markRead: false });
      res.json({ body });
    } else {
      const result = await client.mail.listIncoming({ amount: 30 });
      const mails = (result.mail ?? []).map((m: any) => ({
        id: m.attribute?.mailIdentifier ?? m.mailURI,
        from: m.mailHeader?.from,
        to: m.mailHeader?.to,
        subject: m.mailHeader?.subject,
        date: m.mailHeader?.date,
        read: m.attribute?.read,
        folder: m.sourceFolder?.folderName ?? m.sourceFolder?.folderType,
      }));
      res.json({ mails });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

export default router;
