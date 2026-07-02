import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

declare global {
  namespace Express {
    interface Request {
      keyName?: string;
    }
  }
}

interface ApiKeyEntry {
  name: string;
  key: string;
}

interface ApiKeysConfig {
  keys: ApiKeyEntry[];
}

function getApiKeysPath(): string {
  return path.join(path.dirname(config.dbPath), 'api_keys.json');
}

export function loadApiKeys(): ApiKeyEntry[] {
  const filePath = getApiKeysPath();
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ApiKeysConfig;
      if (data.keys && data.keys.length > 0) return data.keys;
    }
  } catch { /* fall through */ }
  return [{ name: '默认', key: config.apiKey }];
}

export function saveApiKeys(keys: ApiKeyEntry[]): void {
  const filePath = getApiKeysPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ keys }, null, 2), 'utf-8');
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const key = (req.headers['x-api-key'] as string) || (req.query._key as string);
  if (!key) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const keys = loadApiKeys();
  const matched = keys.find(k => k.key === key);
  if (!matched) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  req.keyName = matched.name;
  next();
}
