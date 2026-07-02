import { Router, Request, Response } from 'express';
import { getDb, logAllocation } from '../db';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = (page - 1) * limit;
  const conditions = ['deleted = 0'];
  const params: any[] = [];
  if (req.query.status === 'available') { conditions.push('bad = 0 AND allocatedTo IS NULL'); }
  else if (req.query.status === 'bad') { conditions.push('bad = 1'); }
  if (req.query.region) { conditions.push('region = ?'); params.push(req.query.region); }
  if (req.query.allocatedTo) { conditions.push('allocatedTo = ?'); params.push(req.query.allocatedTo); }
  const where = conditions.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) as c FROM proxies WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT * FROM proxies WHERE ${where} ORDER BY addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ data, total, page, limit });
});

router.post('/import', (req: Request, res: Response) => {
  const db = getDb();
  const { proxies = [] } = req.body;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO proxies (id, host, port, user, pass, region, pool, claudeUsed, claudeCount, openaiCount, openaiInUse, openaiInUseCount, bad, bad_reason, deleted, deletedAt, addedAt)
    VALUES (@id, @host, @port, @user, @pass, @region, @pool, @claudeUsed, @claudeCount, @openaiCount, @openaiInUse, @openaiInUseCount, @bad, @bad_reason, @deleted, @deletedAt, @addedAt)
  `);

  const tx = db.transaction(() => {
    let count = 0;
    for (const p of proxies) {
      stmt.run({
        id: p.id || `proxy_${p.host}_${p.port}`,
        host: p.host, port: String(p.port), user: p.user, pass: p.pass,
        region: p.region ?? 'us', pool: p.pool ?? 'static',
        claudeUsed: (p.claudeUsed || p.claude_used) ? 1 : 0,
        claudeCount: p.claudeCount ?? p.claude_count ?? 0,
        openaiCount: p.openaiCount ?? p.openai_count ?? 0,
        openaiInUse: (p.openaiInUse || p.openai_in_use) ? 1 : 0,
        openaiInUseCount: p.openaiInUseCount ?? p.openai_in_use_count ?? 0,
        bad: p.bad ? 1 : 0, bad_reason: p.bad_reason ?? null,
        deleted: p.deleted ? 1 : 0, deletedAt: p.deletedAt ?? null,
        addedAt: p.addedAt ?? new Date().toISOString(),
      });
      count++;
    }
    return count;
  });

  res.json({ imported: tx() });
});

router.post('/text-import', (req: Request, res: Response) => {
  const db = getDb();
  const { text, pool = 'static', region = 'us' } = req.body;
  if (!text || typeof text !== 'string') { res.status(400).json({ error: 'text is required' }); return; }

  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO proxies (id, host, port, user, pass, region, pool, claudeUsed, claudeCount, openaiCount, openaiInUse, openaiInUseCount, bad, bad_reason, deleted, deletedAt, addedAt)
    VALUES (@id, @host, @port, @user, @pass, @region, @pool, 0, 0, 0, 0, 0, 0, NULL, 0, NULL, @addedAt)
  `);

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    let count = 0;
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length < 4) continue;
      const [host, port, user, pass] = parts;
      stmt.run({
        id: `proxy_${host}_${port}`,
        host, port, user, pass,
        region, pool, addedAt: now,
      });
      count++;
    }
    return count;
  });

  res.json({ imported: tx() });
});

router.post('/pull', (req: Request, res: Response) => {
  const db = getDb();
  const { count = 1, machineId, region, pool, preview } = req.body;
  if (!machineId) { res.status(400).json({ error: 'machineId required' }); return; }

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    let query = `SELECT * FROM proxies WHERE bad = 0 AND deleted = 0 AND allocatedTo IS NULL`;
    const params: any[] = [];

    if (region) { query += ` AND region = ?`; params.push(region); }
    if (pool) { query += ` AND pool = ?`; params.push(pool); }

    query += ` ORDER BY addedAt DESC LIMIT ?`;
    params.push(count);

    const rows = db.prepare(query).all(...params) as any[];
    if (rows.length === 0) return { proxies: [] };

    if (!preview) {
      const stmt = db.prepare('UPDATE proxies SET allocatedTo = ?, allocatedAt = ? WHERE id = ?');
      for (const row of rows) {
        stmt.run(machineId, now, row.id);
      }
    }

    return {
      proxies: rows.map(r => ({
        ...r, bad: !!r.bad, deleted: !!r.deleted,
        ...(preview ? {} : { allocatedTo: machineId, allocatedAt: now }),
      })),
    };
  });

  const result = tx();
  if (!preview && result.proxies.length > 0) {
    logAllocation(db, 'proxies', 'pull', req.keyName || '未知', result.proxies.length, {
      pool: pool || '(all)',
      region: region || '(all)',
      count: result.proxies.length,
    });
  }
  res.json(result);
});

router.post('/release', (req: Request, res: Response) => {
  const db = getDb();
  const { machineId, proxies = [] } = req.body;
  if (!machineId) { res.status(400).json({ error: 'machineId required' }); return; }

  const stmt = db.prepare('UPDATE proxies SET allocatedTo = NULL, allocatedAt = NULL WHERE host = ? AND port = ? AND allocatedTo = ?');
  const tx = db.transaction(() => {
    let released = 0;
    for (const p of proxies) {
      released += stmt.run(p.host, String(p.port), machineId).changes;
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
      if (r.result === 'bad') {
        db.prepare('UPDATE proxies SET bad = 1, bad_reason = ?, allocatedTo = NULL, allocatedAt = NULL WHERE host = ? AND port = ?')
          .run(r.reason ?? null, r.host, String(r.port));
      } else if (r.success) {
        if (r.purpose === 'claude') {
          db.prepare('UPDATE proxies SET claudeUsed = 1, claudeCount = claudeCount + 1, allocatedTo = NULL, allocatedAt = NULL WHERE host = ? AND port = ?')
            .run(r.host, String(r.port));
        } else if (r.purpose === 'openai') {
          db.prepare('UPDATE proxies SET openaiCount = openaiCount + 1, allocatedTo = NULL, allocatedAt = NULL WHERE host = ? AND port = ?')
            .run(r.host, String(r.port));
        }
      } else {
        db.prepare('UPDATE proxies SET allocatedTo = NULL, allocatedAt = NULL WHERE host = ? AND port = ?')
          .run(r.host, String(r.port));
      }
      updated++;
    }
    return updated;
  });

  res.json({ updated: tx() });
});

router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM proxies WHERE deleted = 0').get() as any).c;
  const available = (db.prepare('SELECT COUNT(*) as c FROM proxies WHERE deleted = 0 AND bad = 0 AND allocatedTo IS NULL').get() as any).c;
  const allocated = (db.prepare('SELECT COUNT(*) as c FROM proxies WHERE deleted = 0 AND allocatedTo IS NOT NULL').get() as any).c;
  const bad = (db.prepare('SELECT COUNT(*) as c FROM proxies WHERE bad = 1').get() as any).c;
  const claudeAvailable = (db.prepare('SELECT COUNT(*) as c FROM proxies WHERE deleted = 0 AND bad = 0 AND claudeUsed = 0 AND allocatedTo IS NULL').get() as any).c;

  const byRegion = db.prepare(`
    SELECT region, COUNT(*) as total,
      SUM(CASE WHEN bad = 0 AND deleted = 0 AND allocatedTo IS NULL THEN 1 ELSE 0 END) as available
    FROM proxies WHERE deleted = 0 GROUP BY region
  `).all() as any[];

  const regions: Record<string, any> = {};
  for (const r of byRegion) {
    regions[r.region || 'unknown'] = { total: r.total, available: r.available };
  }

  const byPool = db.prepare(`
    SELECT pool, COUNT(*) as total,
      SUM(CASE WHEN bad = 0 AND deleted = 0 AND allocatedTo IS NULL THEN 1 ELSE 0 END) as available
    FROM proxies WHERE deleted = 0 GROUP BY pool
  `).all() as any[];

  const pools: Record<string, any> = {};
  for (const p of byPool) {
    pools[p.pool || 'static'] = { total: p.total, available: p.available };
  }

  res.json({ total, available, allocated, bad, claudeAvailable, byRegion: regions, byPool: pools });
});

export default router;
