import { Router, Request, Response } from 'express';
import { getDb, logAllocation } from '../db';

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

  // 异步 prelogin（不阻塞响应）
  if (result.importedEmails.length > 0) {
    (async () => {
      try {
        // @ts-ignore
        const { MailComClient, MemorySessionStore } = await import('../mailcom-sdk/index.js');
        const dbInner = getDb();
        const accts = dbInner.prepare(`SELECT email, password FROM mailcom_accounts WHERE email IN (${result.importedEmails.map(() => '?').join(',')})`)
          .all(...result.importedEmails) as any[];
        for (const row of accts) {
          try {
            const store = new MemorySessionStore();
            const client = new MailComClient({ email: row.email, password: row.password, sessionStore: store });
            const session = await client.auth.login();
            dbInner.prepare(`UPDATE mailcom_accounts SET accessToken = ?, refreshToken = ?, sessionExpiresAt = ?, tokenStatus = 'ok', tokenAt = ? WHERE email = ?`)
              .run(session.accessToken, session.refreshToken, session.expiresAt ? new Date(session.expiresAt).toISOString() : null, new Date().toISOString(), row.email);
          } catch (e: any) {
            dbInner.prepare(`UPDATE mailcom_accounts SET tokenStatus = 'failed', tokenError = ? WHERE email = ?`).run(e.message || String(e), row.email);
          }
        }
      } catch { /* ignore */ }
    })();
  }
});

router.post('/text-import', (req: Request, res: Response) => {
  const db = getDb();
  const { text = '' } = req.body as { text?: string };
  const lines = text.split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => l);

  const accounts: { email: string; password: string }[] = [];
  for (const line of lines) {
    const parts = line.split(/\s*-{2,}\s*/);
    if (parts.length >= 2) {
      // 去掉"卡号："等中文前缀
      let email = parts[0].trim().replace(/^[^\x00-\x7F]+[：:]\s*/, '');
      const password = parts[1].trim();
      if (email && password && email.includes('@')) accounts.push({ email, password });
    }
  }

  if (accounts.length === 0) {
    res.json({ imported: 0, accounts: [] });
    return;
  }

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO mailcom_accounts (id, email, password, tokenStatus, tokenAt, tokenError, banned, mailBannedAt, mailPaidAt, accessToken, refreshToken, sessionExpiresAt, addedAt)
    VALUES (@id, @email, @password, @tokenStatus, @tokenAt, @tokenError, @banned, @mailBannedAt, @mailPaidAt, @accessToken, @refreshToken, @sessionExpiresAt, @addedAt)
  `);

  const importedEmails: string[] = [];

  const tx = db.transaction(() => {
    let count = 0;
    for (const a of accounts) {
      stmt.run({
        id: `mc_${Date.now()}_${String(count).padStart(4, '0')}`,
        email: a.email, password: a.password,
        tokenStatus: 'pending',
        tokenAt: null, tokenError: null,
        banned: 0, mailBannedAt: null, mailPaidAt: null,
        accessToken: null, refreshToken: null, sessionExpiresAt: null,
        addedAt: new Date().toISOString(),
      });
      importedEmails.push(a.email);
      count++;
    }
    return count;
  });

  const count = tx();
  res.json({ imported: count, accounts });

  // Async prelogin (same pattern as /import)
  if (importedEmails.length > 0) {
    (async () => {
      try {
        // @ts-ignore
        const { MailComClient, MemorySessionStore } = await import('../mailcom-sdk/index.js');
        const dbInner = getDb();
        const accts = dbInner.prepare(`SELECT email, password FROM mailcom_accounts WHERE email IN (${importedEmails.map(() => '?').join(',')})`)
          .all(...importedEmails) as any[];
        for (const row of accts) {
          try {
            const store = new MemorySessionStore();
            const client = new MailComClient({ email: row.email, password: row.password, sessionStore: store });
            const session = await client.auth.login();
            dbInner.prepare(`UPDATE mailcom_accounts SET accessToken = ?, refreshToken = ?, sessionExpiresAt = ?, tokenStatus = 'ok', tokenAt = ? WHERE email = ?`)
              .run(session.accessToken, session.refreshToken, session.expiresAt ? new Date(session.expiresAt).toISOString() : null, new Date().toISOString(), row.email);
          } catch (e: any) {
            dbInner.prepare(`UPDATE mailcom_accounts SET tokenStatus = 'failed', tokenError = ? WHERE email = ?`).run(e.message || String(e), row.email);
          }
        }
      } catch { /* ignore */ }
    })();
  }
});

router.get('/prelogin-status', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare("SELECT tokenStatus, COUNT(*) as c FROM mailcom_accounts GROUP BY tokenStatus").all() as any[];
  const total = (db.prepare("SELECT COUNT(*) as c FROM mailcom_accounts").get() as any).c;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.tokenStatus ?? 'noToken'] = r.c;
  res.json({
    total,
    ok: counts['ok'] ?? 0,
    failed: counts['failed'] ?? 0,
    pending: counts['pending'] ?? 0,
    noToken: counts['noToken'] ?? 0,
  });
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

  const result = tx();
  if (!preview && result.accounts.length > 0) {
    logAllocation(db, 'mailcom', 'pull', req.keyName || '未知', result.accounts.length, {
      emails: result.accounts.map((a: any) => a.email),
      count: result.accounts.length,
    });
  }
  res.json(result);
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

router.post('/prelogin', async (req: Request, res: Response) => {
  const db = getDb();
  const { emails } = req.body as { emails?: string[] };

  let rows: any[];
  if (emails && emails.length > 0) {
    const placeholders = emails.map(() => '?').join(',');
    rows = db.prepare(`SELECT email, password FROM mailcom_accounts WHERE email IN (${placeholders})`).all(...emails) as any[];
  } else {
    rows = db.prepare(`SELECT email, password FROM mailcom_accounts WHERE tokenStatus != 'ok' OR accessToken IS NULL`).all() as any[];
  }

  if (rows.length === 0) {
    res.json({ total: 0, success: 0, failed: 0 });
    return;
  }

  // 加载代理池
  const proxies = db.prepare("SELECT host, port, user, pass FROM proxies WHERE bad = 0 AND deleted = 0").all() as any[];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const send = (data: any) => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

  // @ts-ignore
  const { MailComClient, MemorySessionStore } = await import('../mailcom-sdk/index.js');
  const { ProxyAgent, fetch: undiciFetch } = await import('undici');

  const total = rows.length;
  let done = 0, success = 0, failed = 0;

  // 每个代理最多承担 20 个，随机打散
  const PER_PROXY = 20;
  const proxyUsage = new Map<number, number>();

  const getProxyFetch = () => {
    if (proxies.length === 0) return undefined;
    // 找使用次数最少的代理
    let bestIdx = Math.floor(Math.random() * proxies.length);
    let bestCount = proxyUsage.get(bestIdx) ?? 0;
    for (let i = 0; i < 5; i++) {
      const ri = Math.floor(Math.random() * proxies.length);
      const rc = proxyUsage.get(ri) ?? 0;
      if (rc < bestCount) { bestIdx = ri; bestCount = rc; }
    }
    if (bestCount >= PER_PROXY) {
      // 所有随机采样的都满了，找一个真正最小的
      let minIdx = 0, minCount = proxyUsage.get(0) ?? 0;
      for (let i = 1; i < proxies.length; i++) {
        const c = proxyUsage.get(i) ?? 0;
        if (c < minCount) { minIdx = i; minCount = c; }
      }
      bestIdx = minIdx;
    }
    proxyUsage.set(bestIdx, (proxyUsage.get(bestIdx) ?? 0) + 1);
    const p = proxies[bestIdx];
    const proxyUrl = `http://${p.user}:${p.pass}@${p.host}:${p.port}`;
    const agent = new ProxyAgent(proxyUrl);
    return (url: any, init: any) => undiciFetch(url, { ...init, dispatcher: agent });
  };

  send({ type: 'start', total, proxies: proxies.length });

  const CONCURRENCY = 15;
  let idx = 0;

  const runOne = async (): Promise<void> => {
    while (idx < rows.length) {
      const row = rows[idx++];
      try {
        const store = new MemorySessionStore();
        const proxyFetch = getProxyFetch();
        const client = new MailComClient({
          email: row.email, password: row.password, sessionStore: store,
          ...(proxyFetch ? { fetch: proxyFetch } : {}),
        });
        const session = await client.auth.login();
        const now = new Date().toISOString();
        db.prepare(`UPDATE mailcom_accounts SET accessToken = ?, refreshToken = ?, sessionExpiresAt = ?, tokenStatus = 'ok', tokenAt = ?, tokenError = NULL WHERE email = ?`)
          .run(session.accessToken, session.refreshToken, session.expiresAt ? new Date(session.expiresAt).toISOString() : null, now, row.email);
        success++;
        send({ type: 'progress', email: row.email, status: 'ok', done: ++done, total, success, failed });
      } catch (err: any) {
        const msg = err.message || String(err);
        db.prepare(`UPDATE mailcom_accounts SET tokenStatus = 'failed', tokenError = ? WHERE email = ?`).run(msg, row.email);
        failed++;
        send({ type: 'progress', email: row.email, status: 'failed', error: msg, done: ++done, total, success, failed });
      }
    }
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => runOne());
  await Promise.all(workers);

  send({ type: 'done', total, success, failed });
  res.end();
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
