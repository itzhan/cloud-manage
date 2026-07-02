import { useState, useEffect, useCallback } from 'react'
import { getApiKey } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react'

const RESOURCE_LABELS: Record<string, string> = {
  cards: '支付卡', google: '谷歌', mailcom: 'Mail.com', proxies: '代理', codex: 'Codex',
}

export default function AllocationLog() {
  const [data, setData] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const limit = 20

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/allocation-log?page=${page}&limit=${limit}`, {
        headers: { 'X-API-Key': getApiKey() },
      })
      const d = await res.json()
      setData(d.data || [])
      setTotal(d.total || 0)
    } catch { /* ignore */ }
    setLoading(false)
  }, [page])

  useEffect(() => { load() }, [load])

  const totalPages = Math.ceil(total / limit) || 1

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">分配记录</h2>
          <p className="text-sm text-muted-foreground mt-0.5">共 {total} 条记录</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />刷新
        </Button>
      </div>

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="text-left font-medium text-muted-foreground px-4 py-3">时间</th>
              <th className="text-left font-medium text-muted-foreground px-4 py-3">资源</th>
              <th className="text-left font-medium text-muted-foreground px-4 py-3">操作</th>
              <th className="text-left font-medium text-muted-foreground px-4 py-3">密钥</th>
              <th className="text-left font-medium text-muted-foreground px-4 py-3">数量</th>
              <th className="text-left font-medium text-muted-foreground px-4 py-3">详情</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="text-center py-12 text-muted-foreground">加载中...</td></tr>
            ) : data.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-12 text-muted-foreground">暂无记录</td></tr>
            ) : data.map((row: any) => {
              let detail = ''
              try { const d = JSON.parse(row.detail || '{}'); detail = Object.entries(d).filter(([k]) => k !== 'count').map(([k, v]) => `${k}=${v}`).join(' '); } catch { detail = row.detail || '' }
              return (
                <tr key={row.id} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{row.createdAt ? new Date(row.createdAt).toLocaleString() : '—'}</td>
                  <td className="px-4 py-3"><Badge variant="secondary">{RESOURCE_LABELS[row.resource] || row.resource}</Badge></td>
                  <td className="px-4 py-3">{row.action}</td>
                  <td className="px-4 py-3 font-mono text-xs">{row.keyName}</td>
                  <td className="px-4 py-3 tabular-nums">{row.count}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground max-w-[200px] truncate">{detail}</td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/20">
            <p className="text-xs text-muted-foreground">第 {page} / {totalPages} 页</p>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
