import { Router, Request, Response } from 'express';
import { getDb, logAllocation } from '../db';

const router = Router();

const AICARD_BASE = 'https://aicardapi.com';
const AICARD_KEY = process.env.AICARD_API_KEY || '';
const AICARD_CUSTOMER = process.env.AICARD_CUSTOMER_ID || '';
const ISSUANCE_FEE = 1;

async function aicardFetch(method: string, path: string, body?: any, idempotencyKey?: string): Promise<any> {
  const headers: Record<string, string> = {
    'X-API-Key': AICARD_KEY,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${AICARD_BASE}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

// 查看账户余额和可买卡数
router.get('/balance', async (_req: Request, res: Response) => {
  if (!AICARD_KEY) { res.json({ error: 'AICARD_API_KEY not configured' }); return; }
  try {
    const data = await aicardFetch('GET', '/v1/ledger/balances');
    const balance = data?.data?.available_balance_usd ?? data?.data?.cash_usd ?? 0;
    const customerData = AICARD_CUSTOMER
      ? await aicardFetch('GET', `/v1/customers/${AICARD_CUSTOMER}`)
      : null;
    const allocated = customerData?.data?.funding?.allocated_balance_usd ?? 0;
    res.json({
      merchantBalance: balance,
      customerAllocated: allocated,
      customerId: AICARD_CUSTOMER,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// SSE 买卡流程：充值 → 并发创建卡 → 获取卡号 → 导入系统
router.post('/purchase', async (req: Request, res: Response) => {
  if (!AICARD_KEY || !AICARD_CUSTOMER) {
    res.status(400).json({ error: 'AICARD_API_KEY or AICARD_CUSTOMER_ID not configured' });
    return;
  }
  const { count = 10, amountPerCard = 10, concurrency = 5, brand = 'AICard-API' } = req.body;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const send = (data: any) => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

  try {
    const totalCost = count * (amountPerCard + ISSUANCE_FEE);

    // 1. 查客户余额
    const cusData = await aicardFetch('GET', `/v1/customers/${AICARD_CUSTOMER}`);
    const currentBalance = cusData?.data?.funding?.allocated_balance_usd ?? 0;
    const needFund = Math.max(0, totalCost - currentBalance);

    send({ type: 'info', totalCost, currentBalance, needFund, count, amountPerCard });

    // 2. 充值（如果需要）
    if (needFund > 0) {
      send({ type: 'funding', amount: needFund });
      const fundResult = await aicardFetch('POST', `/v1/customers/${AICARD_CUSTOMER}/funding`, {
        amount_usd: needFund,
        reason: `Purchase ${count} cards at $${amountPerCard} each`,
      }, `fund_purchase_${Date.now()}`);
      if (fundResult.error) {
        send({ type: 'error', message: `充值失败: ${fundResult.error.message}` });
        res.end();
        return;
      }
      send({ type: 'funded', newBalance: fundResult?.data?.customer?.funding?.allocated_balance_usd });
    }

    // 3. 并发创建卡
    send({ type: 'creating', count, concurrency });
    const cardIds: string[] = [];
    let created = 0, failed = 0;

    const createOne = async (idx: number): Promise<string | null> => {
      const result = await aicardFetch('POST', '/v1/cards', {
        customer_id: AICARD_CUSTOMER,
        type: 'virtual',
        card_usage_type: 'temporary',
        spend_limit_usd: amountPerCard,
      }, `purchase_card_${Date.now()}_${idx}`);
      if (result?.data?.id) {
        created++;
        send({ type: 'card_created', idx: idx + 1, total: count, id: result.data.id, last4: result.data.last4, created, failed });
        return result.data.id;
      } else {
        failed++;
        send({ type: 'card_failed', idx: idx + 1, total: count, error: result?.error?.message, created, failed });
        return null;
      }
    };

    // 并发控制
    let idx = 0;
    const runWorker = async () => {
      while (idx < count) {
        const i = idx++;
        const id = await createOne(i);
        if (id) cardIds.push(id);
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, count) }, () => runWorker());
    await Promise.all(workers);

    if (cardIds.length === 0) {
      send({ type: 'error', message: '没有成功创建任何卡' });
      res.end();
      return;
    }

    // 4. 获取卡号
    send({ type: 'revealing', count: cardIds.length });
    const db = getDb();
    const now = new Date().toISOString();
    const cards: any[] = [];
    const pas: any[] = [];

    for (let i = 0; i < cardIds.length; i++) {
      const cid = cardIds[i];
      const reveal = await aicardFetch('POST', `/v1/cards/${cid}/secure-reveal`, {
        reason: 'Batch purchase export',
      }, `reveal_purchase_${cid}_${Date.now()}`);
      const d = reveal?.data;
      if (d?.card_number) {
        const exp = d.expiration_date || '';
        const expiry = exp.slice(0, 2) + '/' + exp.slice(2);
        const paId = `pa_aicard_${Date.now()}_${i}`;
        cards.push({
          id: cid, cardNumber: d.card_number, cvv: d.security_code, expiry,
          brand, status: 'active', accountId: paId, addedAt: now,
          claudeUsedCount: 0, claudeMaxUsage: 1, codexUsedCount: 0, codexMaxUsage: 3,
        });
        pas.push({ id: paId, name: `${brand}-${i + 1}`, balance: amountPerCard, currency: 'USD', addedAt: now });
        send({ type: 'revealed', idx: i + 1, total: cardIds.length, cardNumber: d.card_number, cvv: d.security_code, expiry });
      }
    }

    // 5. 导入系统
    if (cards.length > 0) {
      const upsertPa = db.prepare('INSERT OR REPLACE INTO payment_accounts (id,name,balance,currency,note,addedAt) VALUES (?,?,?,?,?,?)');
      const CARD_COLS = ["id","cardNumber","expiry","cvv","brand","usedCount","maxUsage","claudeUsedCount","codexUsedCount","claudeMaxUsage","codexMaxUsage","claudePlatformUsedCount","claudePlatformMaxUsage","openaiPlatformUsedCount","openaiPlatformMaxUsage","accounts","accountId","status","addedAt","cardholder","country","address1","city","state","zip","deleted","deletedAt"];
      const upsertCard = db.prepare(`INSERT OR REPLACE INTO cards (${CARD_COLS.join(',')}) VALUES (${CARD_COLS.map(() => '?').join(',')})`);
      const tx = db.transaction(() => {
        for (const pa of pas) upsertPa.run(pa.id, pa.name, pa.balance, pa.currency, null, pa.addedAt);
        for (const c of cards) {
          const vals = CARD_COLS.map(col => {
            const v = (c as any)[col];
            if (v === undefined || v === null) return null;
            if (typeof v === 'object') return JSON.stringify(v);
            if (typeof v === 'boolean') return v ? 1 : 0;
            return v;
          });
          upsertCard.run(...vals);
        }
      });
      tx();
      logAllocation(db, 'cards', 'aicard-purchase', req.keyName || '未知', cards.length, { brand, amountPerCard, count: cards.length });
    }

    send({ type: 'done', created: cards.length, failed, brand, amountPerCard });
  } catch (e: any) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});

export default router;
