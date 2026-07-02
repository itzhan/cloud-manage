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
  const total = (db.prepare(`SELECT COUNT(*) as c FROM openai_keys WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT * FROM openai_keys WHERE ${where} ORDER BY uploadedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ data, total, page, limit });
});

router.post('/import', (req: Request, res: Response) => {
  const db = getDb();
  const { accounts = [] } = req.body;
  const now = new Date().toISOString();
  const sourceKeyName = req.keyName || '未知';

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO openai_keys (id, email, apiKey, status, sourceKeyName, uploadedAt)
    VALUES (@id, @email, @apiKey, @status, @sourceKeyName, @uploadedAt)
  `);

  const tx = db.transaction(() => {
    let count = 0;
    for (const a of accounts) {
      stmt.run({
        id: a.id || `ok_${Date.now()}_${String(count).padStart(4, '0')}`,
        email: a.email || '',
        apiKey: a.apiKey || '',
        status: a.status ?? 'active',
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
  const active = (db.prepare("SELECT COUNT(*) as c FROM openai_keys WHERE status = 'active'").get() as any).c;

  const sourceRows = db.prepare('SELECT sourceKeyName, COUNT(*) as c FROM openai_keys GROUP BY sourceKeyName').all() as any[];
  const bySource: Record<string, number> = {};
  for (const r of sourceRows) bySource[r.sourceKeyName || ''] = r.c;

  res.json({ total, exported, unexported, active, bySource });
});

router.get('/export', (req: Request, res: Response) => {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];
  if (req.query.sourceKeyName) { conditions.push('sourceKeyName = ?'); params.push(req.query.sourceKeyName); }
  if (req.query.exported === '1') { conditions.push('exported = 1'); }
  else { conditions.push('(exported = 0 OR exported IS NULL)'); }
  conditions.push("apiKey IS NOT NULL AND apiKey != ''");
  const where = conditions.join(' AND ');

  const rows = db.prepare(`SELECT id, apiKey FROM openai_keys WHERE ${where} ORDER BY uploadedAt DESC`).all(...params) as any[];
  const text = rows.map((r: any) => r.apiKey).join('\n');

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
