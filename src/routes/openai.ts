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
  if (req.query.status) { conditions.push('oaiStatus = ?'); params.push(req.query.status); }
  if (req.query.sourceKeyName) { conditions.push('sourceKeyName = ?'); params.push(req.query.sourceKeyName); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM openai_keys WHERE ${where}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM openai_keys WHERE ${where} ORDER BY addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];

  const data = rows.map(r => ({
    id: r.id,
    email: r.email,
    hasPassword: !!r.password,
    hasGptPassword: !!r.gptPassword,
    twoFaSecret: r.twoFaSecret,
    hasToken: !!r.rt || !!r.msRefreshToken,
    tokenStatus: r.tokenStatus,
    tokenError: r.tokenError,
    planType: r.planType,
    paidAt: r.paidAt,
    paidCard: r.paidCard,
    paidCardBrand: r.paidCardBrand,
    oaiStatus: r.oaiStatus,
    sub2apiImports: r.sub2apiImports,
    addedAt: r.addedAt,
    sourceKeyName: r.sourceKeyName,
    uploadedAt: r.uploadedAt,
  }));

  res.json({ data, total, page, limit });
});

router.post('/import', (req: Request, res: Response) => {
  const db = getDb();
  const { accounts = [] } = req.body;
  const now = new Date().toISOString();
  const sourceKeyName = req.keyName || '未知';

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO openai_keys (
      id, email, password, gptPassword, twoFaSecret,
      rt, msRefreshToken, tokenStatus, tokenError,
      planType, paidAt, paidCard, paidCardBrand,
      oaiStatus, sub2apiImports, addedAt,
      sourceKeyName, uploadedAt
    ) VALUES (
      @id, @email, @password, @gptPassword, @twoFaSecret,
      @rt, @msRefreshToken, @tokenStatus, @tokenError,
      @planType, @paidAt, @paidCard, @paidCardBrand,
      @oaiStatus, @sub2apiImports, @addedAt,
      @sourceKeyName, @uploadedAt
    )
  `);

  const tx = db.transaction(() => {
    let count = 0;
    for (const a of accounts) {
      stmt.run({
        id: a.id || `oai_${Date.now()}_${String(count).padStart(4, '0')}`,
        email: a.email,
        password: a.password ?? null,
        gptPassword: a.gptPassword ?? null,
        twoFaSecret: a.twoFaSecret ?? null,
        rt: a.rt ?? null,
        msRefreshToken: a.msRefreshToken ?? null,
        tokenStatus: a.tokenStatus ?? 'pending',
        tokenError: a.tokenError ?? null,
        planType: a.planType ?? null,
        paidAt: a.paidAt ?? null,
        paidCard: a.paidCard ?? null,
        paidCardBrand: a.paidCardBrand ?? null,
        oaiStatus: a.oaiStatus ?? '',
        sub2apiImports: typeof a.sub2apiImports === 'string' ? a.sub2apiImports : JSON.stringify(a.sub2apiImports ?? []),
        addedAt: a.addedAt ?? now,
        sourceKeyName,
        uploadedAt: now,
      });
      count++;
    }
    return count;
  });

  const imported = tx();
  logAllocation(db, 'openai_keys', 'upload', sourceKeyName, imported);
  res.json({ imported });
});

router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM openai_keys').get() as any).c;

  const planRows = db.prepare('SELECT planType, COUNT(*) as c FROM openai_keys GROUP BY planType').all() as any[];
  const byPlanType: Record<string, number> = {};
  for (const r of planRows) byPlanType[r.planType || ''] = r.c;

  const statusRows = db.prepare('SELECT oaiStatus, COUNT(*) as c FROM openai_keys GROUP BY oaiStatus').all() as any[];
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.oaiStatus || ''] = r.c;

  const sourceRows = db.prepare('SELECT sourceKeyName, COUNT(*) as c FROM openai_keys GROUP BY sourceKeyName').all() as any[];
  const bySource: Record<string, number> = {};
  for (const r of sourceRows) bySource[r.sourceKeyName || ''] = r.c;

  res.json({ total, byPlanType, byStatus, bySource });
});

router.get('/export', (req: Request, res: Response) => {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];
  if (req.query.status) { conditions.push('oaiStatus = ?'); params.push(req.query.status); }
  if (req.query.sourceKeyName) { conditions.push('sourceKeyName = ?'); params.push(req.query.sourceKeyName); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';

  const rows = db.prepare(`SELECT * FROM openai_keys WHERE ${where} ORDER BY addedAt DESC`).all(...params) as any[];

  const data = rows.map((r, i) => ({
    '序号': i + 1,
    '邮箱': r.email,
    'GPT密码': r.gptPassword || '',
    'Outlook密码': r.password || '',
    '2FA': r.twoFaSecret || '',
    'RT': r.rt || '',
    '套餐': r.planType || '',
    '状态': r.oaiStatus || '',
    '支付卡': r.paidCard || '',
    '卡品牌': r.paidCardBrand || '',
    '添加时间': r.addedAt || '',
    '来源': r.sourceKeyName || '',
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const status = (req.query.status as string) || 'all';
  const date = new Date().toISOString().slice(0, 10);
  const filename = `openai_${status}_${date}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
});

export default router;
