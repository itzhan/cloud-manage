import { Router, Request, Response } from 'express';
import { getDb } from '../db';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare("SELECT DISTINCT brand FROM cards WHERE brand IS NOT NULL AND brand != '' ORDER BY brand").all() as any[];
  res.json({ brands: rows.map(r => r.brand) });
});

router.post('/', (_req: Request, res: Response) => {
  // Brands are auto-created when cards are imported
  res.json({ success: true });
});

export default router;
