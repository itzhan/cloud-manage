import { Router, Request, Response } from 'express';
import { getDb } from '../db';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = (page - 1) * limit;
  const conditions = ['c.deleted = 0'];
  const params: any[] = [];
  if (req.query.status) { conditions.push('c.status = ?'); params.push(req.query.status); }
  if (req.query.brand) { conditions.push('c.brand = ?'); params.push(req.query.brand); }
  if (req.query.allocatedTo) { conditions.push('c.allocatedTo = ?'); params.push(req.query.allocatedTo); }
  const where = conditions.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) as c FROM cards c WHERE ${where}`).get(...params) as any).c;
  const data = db.prepare(`SELECT c.*, pa.name as accountName, pa.balance as accountBalance FROM cards c LEFT JOIN payment_accounts pa ON c.accountId = pa.id WHERE ${where} ORDER BY c.addedAt DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  res.json({ data, total, page, limit });
});

router.post('/import', (req: Request, res: Response) => {
  const db = getDb();
  const { cards = [], paymentAccounts = [] } = req.body;

  const insertPa = db.prepare(`
    INSERT OR REPLACE INTO payment_accounts (id, name, balance, currency, note, addedAt)
    VALUES (@id, @name, @balance, @currency, @note, @addedAt)
  `);
  const insertCard = db.prepare(`
    INSERT OR REPLACE INTO cards (
      id, cardNumber, expiry, cvv, brand, cardholder, country, address1, city, state, zip,
      accountId, claudeUsedCount, claudeMaxUsage, codexUsedCount, codexMaxUsage,
      claudePlatformUsedCount, claudePlatformMaxUsage, openaiPlatformUsedCount, openaiPlatformMaxUsage,
      status, deleted, deletedAt, addedAt
    ) VALUES (
      @id, @cardNumber, @expiry, @cvv, @brand, @cardholder, @country, @address1, @city, @state, @zip,
      @accountId, @claudeUsedCount, @claudeMaxUsage, @codexUsedCount, @codexMaxUsage,
      @claudePlatformUsedCount, @claudePlatformMaxUsage, @openaiPlatformUsedCount, @openaiPlatformMaxUsage,
      @status, @deleted, @deletedAt, @addedAt
    )
  `);

  const tx = db.transaction(() => {
    let paCount = 0, cardCount = 0;
    for (const pa of paymentAccounts) {
      insertPa.run({
        id: pa.id, name: pa.name, balance: pa.balance ?? 0,
        currency: pa.currency ?? 'USD', note: pa.note ?? null,
        addedAt: pa.addedAt ?? new Date().toISOString(),
      });
      paCount++;
    }
    for (const c of cards) {
      insertCard.run({
        id: c.id, cardNumber: c.cardNumber, expiry: c.expiry ?? null, cvv: c.cvv ?? null,
        brand: c.brand ?? null, cardholder: c.cardholder ?? null,
        country: c.country ?? null, address1: c.address1 ?? null,
        city: c.city ?? null, state: c.state ?? null, zip: c.zip ?? null,
        accountId: c.accountId ?? null,
        claudeUsedCount: c.claudeUsedCount ?? 0, claudeMaxUsage: c.claudeMaxUsage ?? 1,
        codexUsedCount: c.codexUsedCount ?? 0, codexMaxUsage: c.codexMaxUsage ?? 3,
        claudePlatformUsedCount: c.claudePlatformUsedCount ?? 0, claudePlatformMaxUsage: c.claudePlatformMaxUsage ?? 3,
        openaiPlatformUsedCount: c.openaiPlatformUsedCount ?? 0, openaiPlatformMaxUsage: c.openaiPlatformMaxUsage ?? 5,
        status: c.status ?? 'active', deleted: c.deleted ? 1 : 0,
        deletedAt: c.deletedAt ?? null, addedAt: c.addedAt ?? new Date().toISOString(),
      });
      cardCount++;
    }
    return { paymentAccounts: paCount, cards: cardCount };
  });

  const result = tx();
  res.json({ imported: result });
});

const PLATFORM_COLS: Record<string, { used: string; max: string }> = {
  claude: { used: 'claudeUsedCount', max: 'claudeMaxUsage' },
  codex: { used: 'codexUsedCount', max: 'codexMaxUsage' },
  claudePlatform: { used: 'claudePlatformUsedCount', max: 'claudePlatformMaxUsage' },
  openaiPlatform: { used: 'openaiPlatformUsedCount', max: 'openaiPlatformMaxUsage' },
};

router.post('/pull', (req: Request, res: Response) => {
  const db = getDb();
  const { count = 1, machineId, platform, brand, minBalance, preview } = req.body;
  if (!machineId) { res.status(400).json({ error: 'machineId required' }); return; }

  const cols = platform ? PLATFORM_COLS[platform] : null;
  if (platform && !cols) { res.status(400).json({ error: `invalid platform: ${platform}` }); return; }

  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    let query = `
      SELECT c.* FROM cards c
      LEFT JOIN payment_accounts pa ON c.accountId = pa.id
      WHERE c.allocatedTo IS NULL AND c.status = 'active' AND c.deleted = 0
    `;
    if (cols) query += ` AND c.${cols.used} < c.${cols.max}`;
    const params: any[] = [];
    if (brand) { query += ` AND c.brand = ?`; params.push(brand); }
    if (minBalance != null) { query += ` AND (pa.balance IS NULL OR pa.balance >= ?)`; params.push(minBalance); }
    query += cols ? ` ORDER BY c.${cols.used} ASC LIMIT ?` : ` ORDER BY c.addedAt DESC LIMIT ?`;
    params.push(count);

    const rows = db.prepare(query).all(...params) as any[];

    if (rows.length === 0) return { cards: [], paymentAccounts: [] };

    if (!preview) {
      if (cols) {
        const updateStmt = db.prepare(`UPDATE cards SET allocatedTo = ?, allocatedAt = ?, ${cols.used} = ${cols.used} + 1 WHERE id = ?`);
        for (const row of rows) updateStmt.run(machineId, now, row.id);
      } else {
        const updateStmt = db.prepare(`UPDATE cards SET allocatedTo = ?, allocatedAt = ? WHERE id = ?`);
        for (const row of rows) updateStmt.run(machineId, now, row.id);
      }
    }

    const accountIds = [...new Set(rows.map(r => r.accountId).filter(Boolean))];
    let accounts: any[] = [];
    if (accountIds.length > 0) {
      const placeholders = accountIds.map(() => '?').join(',');
      accounts = db.prepare(`SELECT * FROM payment_accounts WHERE id IN (${placeholders})`).all(...accountIds) as any[];
    }

    if (preview) {
      return { cards: rows.map(r => ({ ...r, deleted: !!r.deleted })), paymentAccounts: accounts };
    }

    const updatedCards = rows.map(r => ({
      ...r,
      ...(cols ? { [cols.used]: (r[cols.used] ?? 0) + 1 } : {}),
      allocatedTo: machineId,
      allocatedAt: now,
      deleted: !!r.deleted,
    }));

    return { cards: updatedCards, paymentAccounts: accounts };
  });

  res.json(tx());
});

router.post('/release', (req: Request, res: Response) => {
  const db = getDb();
  const { machineId, cardIds = [], platform = 'claude' } = req.body;
  if (!machineId) { res.status(400).json({ error: 'machineId required' }); return; }

  const cols = PLATFORM_COLS[platform];

  const tx = db.transaction(() => {
    let released = 0;
    const stmt = cols
      ? db.prepare(`UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL, ${cols.used} = MAX(0, ${cols.used} - 1) WHERE id = ? AND allocatedTo = ?`)
      : db.prepare(`UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL WHERE id = ? AND allocatedTo = ?`);
    for (const id of cardIds) {
      const r = stmt.run(id, machineId);
      released += r.changes;
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
      const cols = PLATFORM_COLS[r.platform];
      if (!cols) continue;

      if (r.success) {
        // 预占已在 pull 时完成，只需清除 allocatedTo + 重算 status
        const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(r.cardId) as any;
        if (!card) continue;

        let newStatus = card.status;
        if (card.status !== 'disabled') {
          const allExhausted =
            (card.claudeUsedCount + (r.platform === 'claude' ? 0 : 0)) >= card.claudeMaxUsage &&
            (card.codexUsedCount + (r.platform === 'codex' ? 0 : 0)) >= card.codexMaxUsage;
          newStatus = allExhausted ? 'exhausted' : 'active';
        }

        db.prepare('UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL, status = ? WHERE id = ?')
          .run(newStatus, r.cardId);

        if (card.accountId && r.deductBalance) {
          db.prepare('UPDATE payment_accounts SET balance = MAX(0, balance - ?) WHERE id = ?')
            .run(r.deductBalance, card.accountId);
        }
      } else {
        // 失败：回退预占的 usedCount，清除 allocatedTo
        db.prepare(`UPDATE cards SET allocatedTo = NULL, allocatedAt = NULL, ${cols.used} = MAX(0, ${cols.used} - 1) WHERE id = ?`)
          .run(r.cardId);
      }
      updated++;
    }
    return updated;
  });

  res.json({ updated: tx() });
});

router.get('/stats', (_req: Request, res: Response) => {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM cards WHERE deleted = 0').get() as any).c;
  const active = (db.prepare("SELECT COUNT(*) as c FROM cards WHERE deleted = 0 AND status = 'active'").get() as any).c;
  const exhausted = (db.prepare("SELECT COUNT(*) as c FROM cards WHERE deleted = 0 AND status = 'exhausted'").get() as any).c;
  const disabled = (db.prepare("SELECT COUNT(*) as c FROM cards WHERE deleted = 0 AND status = 'disabled'").get() as any).c;
  const allocated = (db.prepare('SELECT COUNT(*) as c FROM cards WHERE deleted = 0 AND allocatedTo IS NOT NULL').get() as any).c;

  const brands = db.prepare(`
    SELECT brand, COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
    FROM cards WHERE deleted = 0 GROUP BY brand
  `).all() as any[];

  const byBrand: Record<string, any> = {};
  for (const b of brands) {
    byBrand[b.brand || '(none)'] = { total: b.total, active: b.active };
  }

  const paStats = db.prepare('SELECT COUNT(*) as total, COALESCE(SUM(balance), 0) as totalBalance FROM payment_accounts').get() as any;

  res.json({ total, active, exhausted, disabled, allocated, byBrand, paymentAccounts: paStats });
});

export default router;
