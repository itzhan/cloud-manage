import { Router, Request, Response } from 'express';
import { getDb, logAllocation } from '../db';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 200);
  const offset = (page - 1) * limit;
  const conditions: string[] = [];
  const params: any[] = [];
  if (req.query.status) { conditions.push('status = ?'); params.push(req.query.status); }
  if (req.query.sourceKeyName) { conditions.push('sourceKeyName = ?'); params.push(req.query.sourceKeyName); }
  if (req.query.exported === '1') { conditions.push('exported = 1'); }
  else if (req.query.exported === '0') { conditions.push('(exported = 0 OR exported IS NULL)'); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM registered_accounts WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT * FROM registered_accounts WHERE ${where} ORDER BY uploadedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ data, total, page, limit });
});

router.post('/import', (req: Request, res: Response) => {
  const db = getDb();
  const { accounts = [] } = req.body;
  const now = new Date().toISOString();
  const sourceKeyName = req.keyName || '未知';

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO registered_accounts (
      email, status, plan_type, session_key, platform,
      registered_at, paid_at, authorized_at,
      paid_card, paid_card_brand, proxy_host,
      google_email, browser_id, sourceKeyName, uploadedAt
    ) VALUES (
      @email, @status, @plan_type, @session_key, @platform,
      @registered_at, @paid_at, @authorized_at,
      @paid_card, @paid_card_brand, @proxy_host,
      @google_email, @browser_id, @sourceKeyName, @uploadedAt
    )
  `);

  const existingKeys = new Set(
    (db.prepare("SELECT session_key FROM registered_accounts WHERE session_key IS NOT NULL AND session_key != ''").all() as any[]).map(r => r.session_key)
  );

  const tx = db.transaction(() => {
    let count = 0, skipped = 0;
    for (const a of accounts) {
      if (a.session_key && existingKeys.has(a.session_key)) { skipped++; continue; }
      stmt.run({
        email: a.email,
        status: a.status ?? 'registered',
        plan_type: a.plan_type ?? null,
        session_key: a.session_key ?? null,
        platform: a.platform ?? null,
        registered_at: a.registered_at ?? null,
        paid_at: a.paid_at ?? null,
        authorized_at: a.authorized_at ?? null,
        paid_card: a.paid_card ?? null,
        paid_card_brand: a.paid_card_brand ?? null,
        proxy_host: a.proxy_host ?? null,
        google_email: a.google_email ?? null,
        browser_id: a.browser_id ?? null,
        sourceKeyName,
        uploadedAt: now,
      });
      if (a.session_key) existingKeys.add(a.session_key);
      count++;
    }
    return { count, skipped };
  });

  const result = tx();
  logAllocation(db, 'registered_accounts', 'upload', sourceKeyName, result.count);
  res.json({ imported: result.count, skipped: result.skipped });
});

// 设置导出状态
router.put('/exported', (req: Request, res: Response) => {
  const db = getDb();
  const { emails, exported } = req.body as { emails: string[]; exported: boolean };
  if (!emails || !Array.isArray(emails)) { res.status(400).json({ error: 'emails required' }); return; }
  const placeholders = emails.map(() => '?').join(',');
  const now = new Date().toISOString();
  if (exported) {
    db.prepare(`UPDATE registered_accounts SET exported = 1, exportedAt = ? WHERE email IN (${placeholders})`).run(now, ...emails);
  } else {
    db.prepare(`UPDATE registered_accounts SET exported = 0, exportedAt = NULL WHERE email IN (${placeholders})`).run(...emails);
  }
  res.json({ updated: emails.length });
});

router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM registered_accounts').get() as any).c;
  const exported = (db.prepare('SELECT COUNT(*) as c FROM registered_accounts WHERE exported = 1').get() as any).c;
  const unexported = total - exported;

  const statusRows = db.prepare('SELECT status, COUNT(*) as c FROM registered_accounts GROUP BY status').all() as any[];
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status || ''] = r.c;

  const sourceRows = db.prepare('SELECT sourceKeyName, COUNT(*) as c FROM registered_accounts GROUP BY sourceKeyName').all() as any[];
  const bySource: Record<string, number> = {};
  for (const r of sourceRows) bySource[r.sourceKeyName || ''] = r.c;

  const platformRows = db.prepare('SELECT platform, COUNT(*) as c FROM registered_accounts GROUP BY platform').all() as any[];
  const byPlatform: Record<string, number> = {};
  for (const r of platformRows) byPlatform[r.platform || ''] = r.c;

  res.json({ total, exported, unexported, byStatus, bySource, byPlatform });
});

// 导出：只输出 key，默认只导未导出的
router.get('/export', (req: Request, res: Response) => {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];
  if (req.query.status) { conditions.push('status = ?'); params.push(req.query.status); }
  if (req.query.sourceKeyName) { conditions.push('sourceKeyName = ?'); params.push(req.query.sourceKeyName); }
  // 默认只导出未导出的
  if (req.query.exported === '1') { conditions.push('exported = 1'); }
  else { conditions.push('(exported = 0 OR exported IS NULL)'); }
  // 只导有 key 的
  conditions.push("session_key IS NOT NULL AND session_key != ''");
  const where = conditions.join(' AND ');

  const exportLimit = parseInt(req.query.limit as string) || 0;
  const query = `SELECT email, session_key FROM registered_accounts WHERE ${where} ORDER BY uploadedAt DESC` + (exportLimit > 0 ? ` LIMIT ${exportLimit}` : '');
  const rows = db.prepare(query).all(...params) as any[];
  const text = rows.map((r: any) => r.session_key).join('\n');

  // 标记为已导出
  if (rows.length > 0) {
    const ids = rows.map((r: any) => r.email);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE registered_accounts SET exported = 1, exportedAt = ? WHERE email IN (${placeholders})`).run(new Date().toISOString(), ...ids);
  }

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="claude_keys_${date}.txt"`);
  res.setHeader('Content-Length', String(Buffer.byteLength(text)));
  res.end(text);
});

// 文本格式导入子弹（每行一个 session_key）
router.post('/text-import', (req: Request, res: Response) => {
  const db = getDb();
  const { text = '' } = req.body as { text?: string };
  const lines = text.split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => l && l.length > 10);
  if (lines.length === 0) { res.json({ imported: 0, skipped: 0 }); return; }

  const sourceKeyName = req.keyName || '未知';
  const now = new Date().toISOString();
  const existingKeys = new Set(
    (db.prepare("SELECT session_key FROM registered_accounts WHERE session_key IS NOT NULL AND session_key != ''").all() as any[]).map(r => r.session_key)
  );

  const stmt = db.prepare(`INSERT OR REPLACE INTO registered_accounts (email, status, session_key, sourceKeyName, uploadedAt) VALUES (?, 'active', ?, ?, ?)`);
  const tx = db.transaction(() => {
    let count = 0, skipped = 0;
    for (const key of lines) {
      if (existingKeys.has(key)) { skipped++; continue; }
      const email = `key_${Date.now()}_${count}@imported`;
      stmt.run(email, key, sourceKeyName, now);
      existingKeys.add(key);
      count++;
    }
    return { count, skipped };
  });
  const result = tx();
  logAllocation(db, 'registered_accounts', 'text-import', sourceKeyName, result.count);
  res.json({ imported: result.count, skipped: result.skipped });
});

// 推送未导出的 key 到上号中枢
router.post('/push-to-hub', async (req: Request, res: Response) => {
  const db = getDb();
  const { hubUrl = 'http://38.34.191.113:3104', count } = req.body as { hubUrl?: string; count?: number };

  const limit = count ? `LIMIT ${count}` : '';
  const rows = db.prepare(`SELECT email, session_key FROM registered_accounts WHERE (exported = 0 OR exported IS NULL) AND session_key IS NOT NULL AND session_key != '' ORDER BY uploadedAt DESC ${limit}`).all() as any[];

  if (rows.length === 0) {
    res.json({ pushed: 0, message: '没有未导出的 key' });
    return;
  }

  const keys = rows.map((r: any) => r.session_key);

  try {
    const resp = await fetch(`${hubUrl}/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    });
    const data = await resp.json() as any;
    if (!data.success) throw new Error(data.error || 'push failed');

    // 标记为已导出
    const emails = rows.map((r: any) => r.email);
    const placeholders = emails.map(() => '?').join(',');
    db.prepare(`UPDATE registered_accounts SET exported = 1, exportedAt = ? WHERE email IN (${placeholders})`).run(new Date().toISOString(), ...emails);

    logAllocation(db, 'registered_accounts', 'push-to-hub', req.keyName || '未知', keys.length, { hubUrl });
    res.json({ pushed: data.data?.added ?? keys.length, total: data.data?.total, skipped: 0 });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
