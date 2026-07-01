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
  if (req.query.status === 'available') { conditions.push('allocatedTo IS NULL AND usedInvites < maxInvites'); }
  else if (req.query.status === 'exhausted') { conditions.push('usedInvites >= maxInvites'); }
  if (req.query.allocatedTo) { conditions.push('allocatedTo = ?'); params.push(req.query.allocatedTo); }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM codex_credentials WHERE ${where}`).get(...params) as any).c;
  const rows = db.prepare(`SELECT * FROM codex_credentials WHERE ${where} ORDER BY addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];
  const data = rows.map(r => ({ ...r, invites: JSON.parse(r.invites || '[]') }));
  res.json({ data, total, page, limit });
});

router.post('/import', (req: Request, res: Response) => {
  const db = getDb();
  const { credentials = [] } = req.body;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO codex_credentials (
      id, email, accessToken, chatgptAccountId, expiresAt, planType,
      sourceAccountId, sourceTemplateId, sourceTemplateName,
      usedInvites, maxInvites, invites, subscriptionExpiresAt, addedAt, refreshedAt
    ) VALUES (
      @id, @email, @accessToken, @chatgptAccountId, @expiresAt, @planType,
      @sourceAccountId, @sourceTemplateId, @sourceTemplateName,
      @usedInvites, @maxInvites, @invites, @subscriptionExpiresAt, @addedAt, @refreshedAt
    )
  `);

  const tx = db.transaction(() => {
    let count = 0;
    for (const c of credentials) {
      stmt.run({
        id: c.id || `cx_${Date.now()}_${String(count).padStart(4, '0')}`,
        email: c.email, accessToken: c.accessToken,
        chatgptAccountId: c.chatgptAccountId ?? null,
        expiresAt: c.expiresAt ?? null,
        planType: c.planType ?? null,
        sourceAccountId: c.sourceAccountId ?? null,
        sourceTemplateId: c.sourceTemplateId ?? null,
        sourceTemplateName: c.sourceTemplateName ?? null,
        usedInvites: c.usedInvites ?? 0,
        maxInvites: c.maxInvites ?? 3,
        invites: JSON.stringify(c.invites ?? []),
        subscriptionExpiresAt: c.subscriptionExpiresAt ?? null,
        addedAt: c.addedAt ?? new Date().toISOString(),
        refreshedAt: c.refreshedAt ?? null,
      });
      count++;
    }
    return count;
  });

  res.json({ imported: tx() });
});

router.post('/pull', (req: Request, res: Response) => {
  const db = getDb();
  const { count = 1, machineId, minRemainingInvites = 1 } = req.body;
  if (!machineId) { res.status(400).json({ error: 'machineId required' }); return; }

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM codex_credentials
      WHERE allocatedTo IS NULL AND (maxInvites - usedInvites) >= ?
      ORDER BY usedInvites ASC
      LIMIT ?
    `).all(minRemainingInvites, count) as any[];

    if (rows.length === 0) return { credentials: [] };

    const stmt = db.prepare('UPDATE codex_credentials SET allocatedTo = ?, allocatedAt = ? WHERE id = ?');
    for (const row of rows) {
      stmt.run(machineId, now, row.id);
    }

    return {
      credentials: rows.map(r => ({
        ...r,
        invites: JSON.parse(r.invites || '[]'),
        allocatedTo: machineId,
        allocatedAt: now,
      })),
    };
  });

  res.json(tx());
});

router.post('/release', (req: Request, res: Response) => {
  const db = getDb();
  const { machineId, ids = [] } = req.body;
  if (!machineId) { res.status(400).json({ error: 'machineId required' }); return; }

  const stmt = db.prepare('UPDATE codex_credentials SET allocatedTo = NULL, allocatedAt = NULL WHERE id = ? AND allocatedTo = ?');
  const tx = db.transaction(() => {
    let released = 0;
    for (const id of ids) {
      released += stmt.run(id, machineId).changes;
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
      const updates: string[] = ['allocatedTo = NULL', 'allocatedAt = NULL'];
      const params: any[] = [];

      if (r.usedInvites != null) { updates.push('usedInvites = ?'); params.push(r.usedInvites); }
      if (r.invites != null) { updates.push('invites = ?'); params.push(JSON.stringify(r.invites)); }
      if (r.accessToken) { updates.push('accessToken = ?'); params.push(r.accessToken); }
      if (r.expiresAt) { updates.push('expiresAt = ?'); params.push(r.expiresAt); }
      if (r.refreshedAt) { updates.push('refreshedAt = ?'); params.push(r.refreshedAt); }

      params.push(r.id);
      db.prepare(`UPDATE codex_credentials SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      updated++;
    }
    return updated;
  });

  res.json({ updated: tx() });
});

router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM codex_credentials').get() as any).c;
  const available = (db.prepare('SELECT COUNT(*) as c FROM codex_credentials WHERE allocatedTo IS NULL AND usedInvites < maxInvites').get() as any).c;
  const allocated = (db.prepare('SELECT COUNT(*) as c FROM codex_credentials WHERE allocatedTo IS NOT NULL').get() as any).c;
  const exhausted = (db.prepare('SELECT COUNT(*) as c FROM codex_credentials WHERE usedInvites >= maxInvites').get() as any).c;
  const totalInvitesRemaining = (db.prepare('SELECT COALESCE(SUM(maxInvites - usedInvites), 0) as c FROM codex_credentials WHERE usedInvites < maxInvites').get() as any).c;

  res.json({ total, available, allocated, exhausted, totalInvitesRemaining });
});

export default router;
