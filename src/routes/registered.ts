import { Router, Request, Response } from 'express';
import { getDb, logAllocation } from '../db';
import * as XLSX from 'xlsx';

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
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM registered_accounts WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT * FROM registered_accounts WHERE ${where} ORDER BY registered_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
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

  const tx = db.transaction(() => {
    let count = 0;
    for (const a of accounts) {
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
      count++;
    }
    return count;
  });

  const imported = tx();
  logAllocation(db, 'registered_accounts', 'upload', sourceKeyName, imported);
  res.json({ imported });
});

router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM registered_accounts').get() as any).c;

  const statusRows = db.prepare('SELECT status, COUNT(*) as c FROM registered_accounts GROUP BY status').all() as any[];
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status || ''] = r.c;

  const sourceRows = db.prepare('SELECT sourceKeyName, COUNT(*) as c FROM registered_accounts GROUP BY sourceKeyName').all() as any[];
  const bySource: Record<string, number> = {};
  for (const r of sourceRows) bySource[r.sourceKeyName || ''] = r.c;

  const platformRows = db.prepare('SELECT platform, COUNT(*) as c FROM registered_accounts GROUP BY platform').all() as any[];
  const byPlatform: Record<string, number> = {};
  for (const r of platformRows) byPlatform[r.platform || ''] = r.c;

  res.json({ total, byStatus, bySource, byPlatform });
});

router.get('/export', (req: Request, res: Response) => {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];
  if (req.query.status) { conditions.push('status = ?'); params.push(req.query.status); }
  if (req.query.sourceKeyName) { conditions.push('sourceKeyName = ?'); params.push(req.query.sourceKeyName); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';

  const rows = db.prepare(`SELECT * FROM registered_accounts WHERE ${where} ORDER BY registered_at DESC`).all(...params) as any[];

  const data = rows.map((r, i) => ({
    '序号': i + 1,
    '邮箱': r.email,
    'SessionKey': r.session_key || '',
    '状态': r.status || '',
    '套餐': r.plan_type || '',
    '平台': r.platform || '',
    '注册时间': r.registered_at || '',
    '授权时间': r.authorized_at || '',
    '卡号': r.paid_card || '',
    '卡品牌': r.paid_card_brand || '',
    '代理IP': r.proxy_host || '',
    '来源': r.sourceKeyName || '',
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const status = (req.query.status as string) || 'all';
  const date = new Date().toISOString().slice(0, 10);
  const filename = `registered_${status}_${date}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
});

export default router;
