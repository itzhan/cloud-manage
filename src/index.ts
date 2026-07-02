import express from 'express';
import path from 'path';
import { config } from './config';
import { getDb } from './db';
import { authMiddleware } from './middleware/auth';
import cardsRouter from './routes/cards';
import codexRouter from './routes/codex';
import mailcomRouter from './routes/mailcom';
import googleRouter from './routes/google';
import proxiesRouter from './routes/proxies';
import statsRouter from './routes/stats';
import apiKeysRouter, { allocationLogRouter } from './routes/api-keys';

const app = express();

app.use(express.json({ limit: '50mb' }));

// 静态文件服务（前端）
const webDist = path.join(__dirname, '..', '..', 'web', 'dist');
app.use(express.static(webDist));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api', authMiddleware);

app.use('/api/cards', cardsRouter);
app.use('/api/codex', codexRouter);
app.use('/api/mailcom', mailcomRouter);
app.use('/api/google', googleRouter);
app.use('/api/proxies', proxiesRouter);
app.use('/api/stats', statsRouter);
app.use('/api/keys', apiKeysRouter);
app.use('/api/allocation-log', allocationLogRouter);

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(webDist, 'index.html'));
});

getDb();
console.log(`[resource-hub] SQLite: ${config.dbPath}`);

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[resource-hub] listening on 0.0.0.0:${config.port}`);
});
