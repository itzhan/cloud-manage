import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getDb } from '../db';
import { loadApiKeys, saveApiKeys } from '../middleware/auth';

const router = Router();

// GET /api/keys — list all keys (masked)
router.get('/', (_req: Request, res: Response) => {
  const keys = loadApiKeys();
  res.json({
    keys: keys.map(k => ({
      name: k.name,
      key: k.key.length > 4 ? k.key.slice(0, 4) + '****' : '****',
    })),
  });
});

// POST /api/keys — add a new key
router.post('/', (req: Request, res: Response) => {
  const { name, key } = req.body;
  if (!name) { res.status(400).json({ error: 'name required' }); return; }

  const keys = loadApiKeys();
  if (keys.some(k => k.name === name)) {
    res.status(400).json({ error: `key with name "${name}" already exists` });
    return;
  }

  const newKey = key || crypto.randomBytes(16).toString('hex');
  keys.push({ name, key: newKey });
  saveApiKeys(keys);

  res.json({ name, key: newKey });
});

// DELETE /api/keys — delete a key by name
router.delete('/', (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) { res.status(400).json({ error: 'name required' }); return; }

  const keys = loadApiKeys();
  if (keys.length <= 1) {
    res.status(400).json({ error: 'cannot delete the last key' });
    return;
  }

  const idx = keys.findIndex(k => k.name === name);
  if (idx === -1) {
    res.status(404).json({ error: `key "${name}" not found` });
    return;
  }

  keys.splice(idx, 1);
  saveApiKeys(keys);

  res.json({ deleted: name });
});

export default router;

// GET /api/allocation-log — list allocation logs (paginated)
export const allocationLogRouter = Router();

allocationLogRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const page = parseInt(req.query.page as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 200);
  const offset = (page - 1) * limit;

  const total = (db.prepare('SELECT COUNT(*) as c FROM allocation_log').get() as any).c;
  const data = db.prepare('SELECT * FROM allocation_log ORDER BY createdAt DESC LIMIT ? OFFSET ?').all(limit, offset);

  res.json({ data, total, page, limit });
});
