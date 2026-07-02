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
  if (req.query.status) { conditions.push('oaiStatus = ?'); params.push(req.query.status); }
  if (req.query.sourceKeyName) { conditions.push('sourceKeyName = ?'); params.push(req.query.sourceKeyName); }
  if (req.query.exported === '1') { conditions.push('exported = 1'); }
  else if (req.query.exported === '0') { conditions.push('(exported = 0 OR exported IS NULL)'); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM openai_keys WHERE ${where}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM openai_keys WHERE ${where} ORDER BY addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];

  const data = rows.map(r => ({
    id: r.id, email: r.email,
    hasPassword: !!r.password, hasGptPassword: !!r.gptPassword,
    twoFaSecret: r.twoFaSecret, hasToken: !!r.rt || !!r.msRefreshToken,
    tokenStatus: r.tokenStatus, planType: r.planType,
    paidAt: r.paidAt, paidCard: r.paidCard, paidCardBrand: r.paidCardBrand,
    oaiStatus: r.oaiStatus, addedAt: r.addedAt,
    sourceKeyName: r.sourceKeyName, exported: r.exported || 0,
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
        email: a.email, password: a.password ?? null, gptPassword: a.gptPassword ?? null,
        twoFaSecret: a.twoFaSecret ?? null, rt: a.rt ?? null, msRefreshToken: a.msRefreshToken ?? null,
        tokenStatus: a.tokenStatus ?? 'pending', tokenError: a.tokenError ?? null,
        planType: a.planType ?? null, paidAt: a.paidAt ?? null,
        paidCard: a.paidCard ?? null, paidCardBrand: a.paidCardBrand ?? null,
        oaiStatus: a.oaiStatus ?? '',
        sub2apiImports: typeof a.sub2apiImports === 'string' ? a.sub2apiImports : JSON.stringify(a.sub2apiImports ?? []),
        addedAt: a.addedAt ?? now, sourceKeyName, uploadedAt: now,
      });
      count++;
    }
    return count;
  });

  const imported = tx();
  logAllocation(db, 'openai_keys', 'upload', sourceKeyName, imported);
  res.json({ imported });
});

// 设置导出状态
router.put('/exported', (req: Request, res: Response) => {
  const db = getDb();
  const { ids, exported } = req.body as { ids: string[]; exported: boolean };
  if (!ids || !Array.isArray(ids)) { res.status(400).json({ error: 'ids required' }); return; }
  const placeholders = ids.map(() => '?').join(',');
  if (exported) {
    db.prepare(`UPDATE openai_keys SET exported = 1, exportedAt = ? WHERE id IN (${placeholders})`).run(new Date().toISOString(), ...ids);
  } else {
    db.prepare(`UPDATE openai_keys SET exported = 0, exportedAt = NULL WHERE id IN (${placeholders})`).run(...ids);
  }
  res.json({ updated: ids.length });
});

router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM openai_keys').get() as any).c;
  const exported = (db.prepare('SELECT COUNT(*) as c FROM openai_keys WHERE exported = 1').get() as any).c;
  const unexported = total - exported;

  const planRows = db.prepare('SELECT planType, COUNT(*) as c FROM openai_keys GROUP BY planType').all() as any[];
  const byPlanType: Record<string, number> = {};
  for (const r of planRows) byPlanType[r.planType || ''] = r.c;

  const sourceRows = db.prepare('SELECT sourceKeyName, COUNT(*) as c FROM openai_keys GROUP BY sourceKeyName').all() as any[];
  const bySource: Record<string, number> = {};
  for (const r of sourceRows) bySource[r.sourceKeyName || ''] = r.c;

  res.json({ total, exported, unexported, byPlanType, bySource });
});

// 导出：只输出 key（rt），默认只导未导出的
router.get('/export', (req: Request, res: Response) => {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];
  if (req.query.sourceKeyName) { conditions.push('sourceKeyName = ?'); params.push(req.query.sourceKeyName); }
  if (req.query.exported === '1') { conditions.push('exported = 1'); }
  else { conditions.push('(exported = 0 OR exported IS NULL)'); }
  conditions.push("rt IS NOT NULL AND rt != ''");
  const where = conditions.join(' AND ');

  const rows = db.prepare(`SELECT id, rt FROM openai_keys WHERE ${where} ORDER BY addedAt DESC`).all(...params) as any[];
  const text = rows.map((r: any) => r.rt).join('\n');

  if (rows.length > 0) {
    const ids = rows.map((r: any) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE openai_keys SET exported = 1, exportedAt = ? WHERE id IN (${placeholders})`).run(new Date().toISOString(), ...ids);
  }

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="openai_keys_${date}.txt"`);
  res.setHeader('Content-Length', String(Buffer.byteLength(text)));
  res.end(text);
});

export default router;
