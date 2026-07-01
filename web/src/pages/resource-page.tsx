import { useState, useEffect, useCallback } from 'react'
import { api, getMachineId, setMachineId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { RefreshCw, Upload, Download, ChevronLeft, ChevronRight, Copy, Check } from 'lucide-react'

interface ColumnDef {
  key: string
  label: string
  render?: (value: any, row: any) => React.ReactNode
  className?: string
}

interface PullField {
  key: string
  label: string
  type: 'number' | 'select'
  options?: { value: string; label: string }[]
  defaultValue?: string | number
  required?: boolean
  fromStats?: (stats: any) => { value: string; label: string }[]
}

interface ResourceConfig {
  columns: ColumnDef[]
  importKey: string
  importPlaceholder: string
  statCards?: (stats: any) => { label: string; value: string | number }[]
  pullFields: PullField[]
  pullResultKey: string
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
    pullFields: [
      { key: 'platform', label: '平台', type: 'select', required: true, defaultValue: 'claude', options: [
        { value: 'claude', label: 'Claude' },
        { value: 'codex', label: 'Codex' },
        { value: 'claudePlatform', label: 'Claude Platform' },
        { value: 'openaiPlatform', label: 'OpenAI Platform' },
      ]},
      { key: 'brand', label: '品牌', type: 'select', fromStats: s => {
        const brands = s?.byBrand ? Object.keys(s.byBrand) : []
        return [{ value: '', label: '全部品牌' }, ...brands.map(b => ({ value: b, label: `${b} (${s.byBrand[b].active})` }))]
      }},
      { key: 'count', label: '数量', type: 'number', defaultValue: 5, required: true },
    ],
    pullResultKey: 'cards',
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
    pullFields: [
      { key: 'count', label: '数量', type: 'number', defaultValue: 10, required: true },
    ],
    pullResultKey: 'accounts',
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
    pullFields: [
      { key: 'count', label: '数量', type: 'number', defaultValue: 30, required: true },
    ],
    pullResultKey: 'accounts',
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
    pullFields: [
      { key: 'purpose', label: '用途', type: 'select', defaultValue: 'claude', required: true, options: [
        { value: 'claude', label: 'Claude' },
        { value: 'openai', label: 'OpenAI' },
      ]},
      { key: 'region', label: '区域', type: 'select', defaultValue: '', options: [
        { value: '', label: '全部区域' },
        { value: 'us', label: 'US' },
        { value: 'ph', label: 'PH' },
      ]},
      { key: 'count', label: '数量', type: 'number', defaultValue: 10, required: true },
    ],
    pullResultKey: 'proxies',
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
    pullFields: [
      { key: 'count', label: '数量', type: 'number', defaultValue: 5, required: true },
    ],
    pullResultKey: 'credentials',
  },
}

const INPUT_CLS = 'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
const SELECT_CLS = INPUT_CLS + ' appearance-none'

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
  // Import
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importResult, setImportResult] = useState('')
  // Pull
  const [showPull, setShowPull] = useState(false)
  const [pullForm, setPullForm] = useState<Record<string, any>>({})
  const [pullLoading, setPullLoading] = useState(false)
  const [pullResult, setPullResult] = useState<any[] | null>(null)
  const [pullError, setPullError] = useState('')
  const [copied, setCopied] = useState(false)

  const config = CONFIGS[resource]
  const limit = 20

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
  useEffect(() => { setPage(1) }, [resource])

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

  const openPull = () => {
    const defaults: Record<string, any> = {}
    for (const f of config.pullFields) {
      defaults[f.key] = f.defaultValue ?? ''
    }
    setPullForm(defaults)
    setPullResult(null)
    setPullError('')
    setCopied(false)
    setShowPull(true)
  }

  const handlePull = async () => {
    const machineId = getMachineId()
    if (!machineId) {
      setPullError('请先设置机器名称')
      return
    }
    setPullLoading(true)
    setPullError('')
    try {
      const body: Record<string, any> = { machineId }
      for (const f of config.pullFields) {
        const v = pullForm[f.key]
        if (f.type === 'number') {
          body[f.key] = parseInt(v) || 0
        } else if (v) {
          body[f.key] = v
        }
      }
      const res = await api.pull(resource, body)
      const items = res[config.pullResultKey] || res.accounts || res.cards || res.proxies || res.credentials || []
      setPullResult(items)
      if (items.length === 0) setPullError('没有可用的资源')
      load()
    } catch (e: any) {
      setPullError(e.message)
    }
    setPullLoading(false)
  }

  const copyResult = () => {
    if (!pullResult) return
    navigator.clipboard.writeText(JSON.stringify(pullResult, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
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
          <Button variant="outline" size="sm" onClick={openPull}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            拉取
          </Button>
          <Button size="sm" onClick={() => { setShowImport(true); setImportResult('') }}>
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            导入
          </Button>
        </div>
      </div>

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

      {/* Pull Dialog */}
      <Dialog open={showPull} onOpenChange={setShowPull}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>拉取 {title}</DialogTitle>
            <DialogDescription>从资源池中分配资源到本机</DialogDescription>
          </DialogHeader>

          {!pullResult ? (
            <div className="space-y-4">
              {/* Machine ID */}
              <div>
                <label className="text-sm font-medium mb-1.5 block">机器名称</label>
                <input
                  value={getMachineId()}
                  onChange={e => { setMachineId(e.target.value); setPullError('') }}
                  placeholder="例如 win-server-01"
                  className={INPUT_CLS}
                />
              </div>

              {config.pullFields.map(field => (
                <div key={field.key}>
                  <label className="text-sm font-medium mb-1.5 block">{field.label}</label>
                  {field.type === 'number' ? (
                    <input
                      type="number"
                      min={1}
                      value={pullForm[field.key] ?? ''}
                      onChange={e => setPullForm(f => ({ ...f, [field.key]: e.target.value }))}
                      className={INPUT_CLS}
                    />
                  ) : (
                    <select
                      value={pullForm[field.key] ?? ''}
                      onChange={e => setPullForm(f => ({ ...f, [field.key]: e.target.value }))}
                      className={SELECT_CLS}
                    >
                      {(field.fromStats ? field.fromStats(stats) : field.options || []).map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  )}
                </div>
              ))}

              {pullError && <p className="text-sm text-destructive">{pullError}</p>}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setShowPull(false)}>取消</Button>
                <Button onClick={handlePull} disabled={pullLoading}>
                  {pullLoading ? '拉取中...' : '拉取'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-emerald-600 font-medium">
                  成功拉取 {pullResult.length} 条资源
                </p>
                <Button variant="outline" size="sm" onClick={copyResult}>
                  {copied ? <Check className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
                  {copied ? '已复制' : '复制 JSON'}
                </Button>
              </div>
              <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 text-xs font-mono">
                {JSON.stringify(pullResult, null, 2)}
              </pre>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setPullResult(null)}>继续拉取</Button>
                <Button onClick={() => setShowPull(false)}>关闭</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

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
