import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { RefreshCw, Upload, ChevronLeft, ChevronRight } from 'lucide-react'

interface ColumnDef {
  key: string
  label: string
  render?: (value: any, row: any) => React.ReactNode
  className?: string
}

interface ResourceConfig {
  columns: ColumnDef[]
  importKey: string
  importPlaceholder: string
  statCards?: (stats: any) => { label: string; value: string | number }[]
}

const MASK = (s: string) => s ? s.slice(0, 4) + '····' + s.slice(-4) : '—'

const STATUS_BADGE: Record<string, React.ReactNode> = {
  active: <Badge variant="success">active</Badge>,
  exhausted: <Badge variant="warning">exhausted</Badge>,
  disabled: <Badge variant="destructive">disabled</Badge>,
}

const CONFIGS: Record<string, ResourceConfig> = {
  cards: {
    importKey: 'cards',
    importPlaceholder: '粘贴 cards JSON 数组\n支持同时导入 paymentAccounts:\n{"cards": [...], "paymentAccounts": [...]}',
    columns: [
      { key: 'brand', label: '品牌' },
      { key: 'cardNumber', label: '卡号', render: v => <span className="font-mono text-xs">{MASK(v)}</span> },
      { key: 'status', label: '状态', render: v => STATUS_BADGE[v] || <Badge variant="secondary">{v}</Badge> },
      { key: 'claudeUsedCount', label: 'Claude', render: (v, r) => <span className="tabular-nums">{v}/{r.claudeMaxUsage}</span> },
      { key: 'codexUsedCount', label: 'Codex', render: (v, r) => <span className="tabular-nums">{v}/{r.codexMaxUsage}</span> },
      { key: 'accountName', label: '账户' },
      { key: 'allocatedTo', label: '分配', render: v => v ? <Badge variant="outline">{v}</Badge> : <span className="text-muted-foreground">—</span> },
    ],
    statCards: s => [
      { label: '可用', value: s?.active ?? 0 },
      { label: '已耗尽', value: s?.exhausted ?? 0 },
      { label: '已分配', value: s?.allocated ?? 0 },
    ],
  },
  google: {
    importKey: 'accounts',
    importPlaceholder: '粘贴 google_accounts JSON 数组\n[{"email": "...", "password": "...", "twoFaSecret": "..."}]',
    columns: [
      { key: 'email', label: '邮箱', className: 'font-mono text-xs' },
      { key: 'twoFaSecret', label: '2FA', render: v => v ? <Badge variant="success">有</Badge> : <span className="text-muted-foreground">—</span> },
      { key: 'used', label: '状态', render: (v, r) => r.captcha ? <Badge variant="destructive">人机</Badge> : r.abnormal ? <Badge variant="destructive">异常</Badge> : v ? <Badge variant="secondary">已用</Badge> : <Badge variant="success">可用</Badge> },
      { key: 'allocatedTo', label: '分配', render: v => v ? <Badge variant="outline">{v}</Badge> : <span className="text-muted-foreground">—</span> },
      { key: 'addedAt', label: '添加时间', render: v => v ? new Date(v).toLocaleDateString() : '—' },
    ],
    statCards: s => [
      { label: '可用', value: s?.available ?? 0 },
      { label: '有2FA', value: s?.availableWith2fa ?? 0 },
      { label: '已分配', value: s?.allocated ?? 0 },
    ],
  },
  mailcom: {
    importKey: 'accounts',
    importPlaceholder: '粘贴 mailcom_accounts JSON 数组\n[{"email": "...", "password": "..."}]',
    columns: [
      { key: 'email', label: '邮箱', className: 'font-mono text-xs' },
      { key: 'tokenStatus', label: 'Token', render: v => v === 'ok' ? <Badge variant="success">ok</Badge> : <Badge variant="destructive">{v}</Badge> },
      { key: 'banned', label: '状态', render: v => v ? <Badge variant="destructive">封禁</Badge> : <Badge variant="success">正常</Badge> },
      { key: 'allocatedTo', label: '分配', render: v => v ? <Badge variant="outline">{v}</Badge> : <span className="text-muted-foreground">—</span> },
      { key: 'addedAt', label: '添加时间', render: v => v ? new Date(v).toLocaleDateString() : '—' },
    ],
    statCards: s => [
      { label: '可用', value: s?.available ?? 0 },
      { label: '封禁', value: s?.banned ?? 0 },
      { label: '已分配', value: s?.allocated ?? 0 },
    ],
  },
  proxies: {
    importKey: 'proxies',
    importPlaceholder: '粘贴 proxies JSON 数组\n[{"host": "1.2.3.4", "port": "5782", "user": "u", "pass": "p", "region": "us"}]',
    columns: [
      { key: 'host', label: '地址', render: (v, r) => <span className="font-mono text-xs">{v}:{r.port}</span> },
      { key: 'region', label: '区域', render: v => <Badge variant="secondary">{v || 'us'}</Badge> },
      { key: 'claudeCount', label: 'Claude用量', render: (v, r) => <span className="tabular-nums">{v}{r.claudeUsed ? ' ✓' : ''}</span> },
      { key: 'openaiCount', label: 'OpenAI用量', className: 'tabular-nums' },
      { key: 'bad', label: '状态', render: v => v ? <Badge variant="destructive">坏</Badge> : <Badge variant="success">正常</Badge> },
      { key: 'allocatedTo', label: '分配', render: v => v ? <Badge variant="outline">{v}</Badge> : <span className="text-muted-foreground">—</span> },
    ],
    statCards: s => [
      { label: '可用', value: s?.available ?? 0 },
      { label: 'Claude可用', value: s?.claudeAvailable ?? 0 },
      { label: '已分配', value: s?.allocated ?? 0 },
    ],
  },
  codex: {
    importKey: 'credentials',
    importPlaceholder: '粘贴 codex_credentials JSON 数组\n[{"email": "...", "accessToken": "..."}]',
    columns: [
      { key: 'email', label: '邮箱', className: 'font-mono text-xs' },
      { key: 'planType', label: '套餐', render: v => v ? <Badge variant="secondary">{v}</Badge> : '—' },
      { key: 'usedInvites', label: '邀请', render: (v, r) => <span className="tabular-nums">{v}/{r.maxInvites}</span> },
      { key: 'expiresAt', label: '过期', render: v => v ? new Date(v).toLocaleDateString() : '—' },
      { key: 'allocatedTo', label: '分配', render: v => v ? <Badge variant="outline">{v}</Badge> : <span className="text-muted-foreground">—</span> },
    ],
    statCards: s => [
      { label: '可用', value: s?.available ?? 0 },
      { label: '剩余邀请', value: s?.totalInvitesRemaining ?? 0 },
      { label: '已分配', value: s?.allocated ?? 0 },
    ],
  },
}

interface Props {
  resource: string
  title: string
}

export default function ResourcePage({ resource, title }: Props) {
  const [data, setData] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importResult, setImportResult] = useState('')

  const config = CONFIGS[resource]
  const limit = 50

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [listRes, statsRes] = await Promise.all([
        api.list(resource, { page: String(page), limit: String(limit) }),
        api.resourceStats(resource),
      ])
      setData(listRes.data)
      setTotal(listRes.total)
      setStats(statsRes)
    } catch { /* ignore */ }
    setLoading(false)
  }, [resource, page])

  useEffect(() => { load() }, [load])

  const totalPages = Math.ceil(total / limit) || 1

  const handleImport = async () => {
    try {
      let parsed = JSON.parse(importText)
      let body: any
      if (Array.isArray(parsed)) {
        body = { [config.importKey]: parsed }
      } else {
        body = parsed
      }
      const res = await api.import(resource, body)
      setImportResult(`导入成功: ${JSON.stringify(res.imported)}`)
      load()
    } catch (e: any) {
      setImportResult(`错误: ${e.message}`)
    }
  }

  const statCards = config.statCards?.(stats) || []

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">共 {total} 条记录</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            刷新
          </Button>
          <Button size="sm" onClick={() => { setShowImport(true); setImportResult('') }}>
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            导入
          </Button>
        </div>
      </div>

      {/* Stat cards */}
      {statCards.length > 0 && (
        <div className="grid grid-cols-3 gap-3 mb-6">
          {statCards.map(sc => (
            <Card key={sc.label}>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">{sc.label}</p>
                <p className="text-xl font-semibold tabular-nums mt-0.5">{sc.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                {config.columns.map(col => (
                  <th key={col.key} className="text-left font-medium text-muted-foreground px-4 py-3 whitespace-nowrap">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={config.columns.length} className="text-center py-12 text-muted-foreground">加载中...</td></tr>
              ) : data.length === 0 ? (
                <tr><td colSpan={config.columns.length} className="text-center py-12 text-muted-foreground">暂无数据</td></tr>
              ) : (
                data.map((row, i) => (
                  <tr key={row.id || i} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                    {config.columns.map(col => (
                      <td key={col.key} className={`px-4 py-3 whitespace-nowrap ${col.className || ''}`}>
                        {col.render ? col.render(row[col.key], row) : (row[col.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/20">
            <p className="text-xs text-muted-foreground">
              第 {page} / {totalPages} 页
            </p>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Import Dialog */}
      <Dialog open={showImport} onOpenChange={setShowImport}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>导入 {title}</DialogTitle>
            <DialogDescription>粘贴 JSON 数据进行批量导入</DialogDescription>
          </DialogHeader>
          <textarea
            value={importText}
            onChange={e => setImportText(e.target.value)}
            placeholder={config.importPlaceholder}
            rows={12}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
          />
          {importResult && (
            <p className={`text-sm ${importResult.startsWith('错误') ? 'text-destructive' : 'text-emerald-600'}`}>
              {importResult}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowImport(false)}>取消</Button>
            <Button onClick={handleImport} disabled={!importText.trim()}>导入</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
