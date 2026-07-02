import { useState, useEffect, useCallback, useRef } from 'react'
import { api, getApiKey, getMachineId, setMachineId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { RefreshCw, Upload, Download, ChevronLeft, ChevronRight, Copy, Check, KeyRound, Mail, FileDown } from 'lucide-react'

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
      { label: '静态', value: s?.byPool?.static?.available ?? 0 },
      { label: '家宽', value: s?.byPool?.residential?.available ?? 0 },
    ],
    pullFields: [
      { key: 'pool', label: '类型', type: 'select', defaultValue: '', options: [
        { value: '', label: '全部' },
        { value: 'static', label: '静态' },
        { value: 'residential', label: '家宽' },
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
  registered: {
    importKey: 'accounts',
    importPlaceholder: '粘贴 registered accounts JSON 数组',
    columns: [
      { key: 'email', label: '邮箱', className: 'font-mono text-xs' },
      { key: 'status', label: '状态', render: (v: any) => {
        const colors: Record<string, string> = { authorized: 'success', banned: 'destructive', registered: 'secondary' }
        return <Badge variant={(colors[v] || 'secondary') as any}>{v}</Badge>
      }},
      { key: 'sourceKeyName', label: '来源', render: (v: any) => v ? <Badge variant="outline">{v}</Badge> : '—' },
      { key: 'platform', label: '平台' },
      { key: 'session_key', label: 'SK', render: (v: any) => v ? <span className="font-mono text-xs">{String(v).slice(0, 8)}...</span> : '—' },
      { key: 'exported', label: '导出', render: (v: any) => v ? <Badge variant="secondary">已导出</Badge> : <Badge variant="success">未导出</Badge> },
    ],
    statCards: s => [
      { label: '总数', value: s?.total ?? 0 },
      { label: '未导出', value: s?.unexported ?? 0 },
      { label: '已导出', value: s?.exported ?? 0 },
    ],
    pullFields: [],
    pullResultKey: 'accounts',
  },
  openai: {
    importKey: 'accounts',
    importPlaceholder: '粘贴 openai accounts JSON 数组',
    columns: [
      { key: 'email', label: '邮箱', className: 'font-mono text-xs' },
      { key: 'planType', label: '套餐', render: (v: any) => v ? <Badge variant="secondary">{v}</Badge> : '—' },
      { key: 'oaiStatus', label: '状态', render: (v: any) => !v || v === '' ? <Badge variant="success">正常</Badge> : <Badge variant="destructive">{v}</Badge> },
      { key: 'hasToken', label: 'Token', render: (v: any) => v ? <Badge variant="success">有</Badge> : <span className="text-muted-foreground">—</span> },
      { key: 'sourceKeyName', label: '来源', render: (v: any) => v ? <Badge variant="outline">{v}</Badge> : '—' },
      { key: 'exported', label: '导出', render: (v: any) => v ? <Badge variant="secondary">已导出</Badge> : <Badge variant="success">未导出</Badge> },
    ],
    statCards: s => [
      { label: '总数', value: s?.total ?? 0 },
      { label: '未导出', value: s?.unexported ?? 0 },
      { label: '已导出', value: s?.exported ?? 0 },
    ],
    pullFields: [],
    pullResultKey: 'accounts',
  },
}

const EXPORTABLE = new Set(['registered', 'openai', 'cards'])

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
  const [exportedFilter, setExportedFilter] = useState<'' | '0' | '1'>('')
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
  // Mailcom inbox
  const [inboxEmail, setInboxEmail] = useState('')
  const [inboxMails, setInboxMails] = useState<any[]>([])
  const [inboxLoading, setInboxLoading] = useState(false)
  const [mailBody, setMailBody] = useState('')
  const [mailBodyLoading, setMailBodyLoading] = useState(false)
  // Mailcom prelogin
  const [preloginLoading, setPreloginLoading] = useState(false)
  const [preloginMsg, setPreloginMsg] = useState('')
  // Import mode
  const [importMode, setImportMode] = useState<'text' | 'json'>('text')
  // Cards brand
  const [importBrand, setImportBrand] = useState('')
  const [brands, setBrands] = useState<string[]>([])
  const [newBrand, setNewBrand] = useState('')
  // Proxy import
  const [importPool, setImportPool] = useState('static')
  const [importRegion, setImportRegion] = useState('us')
  // Token progress
  const [tokenProgress, setTokenProgress] = useState<{total:number,ok:number,failed:number}|null>(null)
  const tokenPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const openInbox = async (email: string) => {
    setInboxEmail(email)
    setInboxMails([])
    setMailBody('')
    setInboxLoading(true)
    try {
      const res = await api.inbox(email)
      setInboxMails(res.mails || [])
    } catch { /* ignore */ }
    setInboxLoading(false)
  }

  const openMailBody = async (mailId: string) => {
    setMailBodyLoading(true)
    setMailBody('')
    try {
      const res = await api.inbox(inboxEmail, mailId)
      setMailBody(res.body || '')
    } catch { /* ignore */ }
    setMailBodyLoading(false)
  }

  const doPrelogin = async () => {
    setPreloginLoading(true)
    setPreloginMsg('准备中...')
    try {
      const res = await fetch('/api/mailcom/prelogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': (await import('@/lib/api')).getApiKey() },
        body: JSON.stringify({}),
      })
      if (!res.ok || !res.body) throw new Error('请求失败')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(line.slice(6))
            if (ev.type === 'start') setPreloginMsg(`0/${ev.total}`)
            else if (ev.type === 'progress') setPreloginMsg(`${ev.done}/${ev.total}  ✓${ev.success}  ✗${ev.failed}  ${ev.email}`)
            else if (ev.type === 'done') setPreloginMsg(`完成：成功 ${ev.success}，失败 ${ev.failed}，共 ${ev.total}`)
          } catch { /* skip */ }
        }
      }
      load()
    } catch (e: any) { setPreloginMsg(`错误: ${e.message}`) }
    setPreloginLoading(false)
  }

  // Fetch brands when cards import dialog opens
  useEffect(() => {
    if (resource === 'cards' && showImport) {
      fetch('/api/brands', { headers: { 'X-API-Key': getApiKey() } })
        .then(r => r.ok ? r.json() : { brands: [] })
        .then(d => setBrands(d.brands || []))
        .catch(() => {})
    }
  }, [resource, showImport])

  // Token caching progress polling
  const startTokenPolling = useCallback(() => {
    // Clear any existing poll
    if (tokenPollRef.current) clearInterval(tokenPollRef.current)
    const poll = () => {
      fetch('/api/mailcom/prelogin-status', { headers: { 'X-API-Key': getApiKey() } })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d) return
          setTokenProgress({ total: d.total, ok: d.ok, failed: d.failed })
          if (d.ok + d.failed >= d.total) {
            if (tokenPollRef.current) { clearInterval(tokenPollRef.current); tokenPollRef.current = null }
          }
        })
        .catch(() => {})
    }
    poll()
    tokenPollRef.current = setInterval(poll, 5000)
  }, [])

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (tokenPollRef.current) clearInterval(tokenPollRef.current) }
  }, [])

  const handleTextImport = async () => {
    try {
      let url = ''
      let body: any = {}

      if (resource === 'mailcom') {
        url = '/api/mailcom/text-import'
        body = { text: importText }
      } else if (resource === 'cards') {
        const brand = importBrand === '__new__' ? newBrand.trim() : importBrand
        if (!brand) { setImportResult('错误: 请选择或输入品牌'); return }
        url = '/api/cards/text-import'
        body = { text: importText, brand }
      } else if (resource === 'google') {
        url = '/api/google/text-import'
        body = { text: importText }
      } else if (resource === 'proxies') {
        url = '/api/proxies/text-import'
        body = { text: importText, pool: importPool, region: importRegion }
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': getApiKey() },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setImportResult(`导入成功: ${JSON.stringify(data.imported)}`)
      load()

      // Start token polling after mailcom import
      if (resource === 'mailcom') {
        startTokenPolling()
      }
    } catch (e: any) {
      setImportResult(`错误: ${e.message}`)
    }
  }

  const TEXT_IMPORT_RESOURCES = new Set(['mailcom', 'cards', 'google', 'proxies'])

  const config = CONFIGS[resource]
  const limit = 20

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string> = { page: String(page), limit: String(limit) }
      if (exportedFilter && (resource === 'registered' || resource === 'openai')) params.exported = exportedFilter
      const [listRes, statsRes] = await Promise.all([
        api.list(resource, params),
        api.resourceStats(resource),
      ])
      setData(listRes.data)
      setTotal(listRes.total)
      setStats(statsRes)
    } catch { /* ignore */ }
    setLoading(false)
  }, [resource, page, exportedFilter])

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
      if (resource === 'mailcom') {
        startTokenPolling()
      }
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
        <div className="flex gap-2 items-center">
          {(resource === 'registered' || resource === 'openai') && (
            <select value={exportedFilter} onChange={e => { setExportedFilter(e.target.value as any); setPage(1) }}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs">
              <option value="">全部</option>
              <option value="0">未导出</option>
              <option value="1">已导出</option>
            </select>
          )}
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            刷新
          </Button>
          {resource === 'mailcom' && (
            <Button variant="outline" size="sm" onClick={doPrelogin} disabled={preloginLoading}>
              <KeyRound className="h-3.5 w-3.5 mr-1.5" />
              {preloginLoading ? '缓存中...' : '缓存Token'}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={openPull}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            拉取
          </Button>
          {EXPORTABLE.has(resource) && (
            <Button variant="outline" size="sm" onClick={async () => {
              try {
                const resp = await fetch(`/api/${resource}/export`, { headers: { 'X-API-Key': getApiKey() } })
                if (!resp.ok) throw new Error('导出失败')
                const blob = await resp.blob()
                const disposition = resp.headers.get('content-disposition') || ''
                const match = disposition.match(/filename="?(.+?)"?$/)
                const filename = match ? match[1] : `${resource}_export.xlsx`
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
                URL.revokeObjectURL(url)
                load()
              } catch { /* ignore */ }
            }}>
              <FileDown className="h-3.5 w-3.5 mr-1.5" />导出
            </Button>
          )}
          <Button size="sm" onClick={() => { setShowImport(true); setImportResult(''); setImportMode('text') }}>
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            导入
          </Button>
          {preloginMsg && <span className="text-xs self-center text-muted-foreground">{preloginMsg}</span>}
          {tokenProgress && (
            <span className="text-xs self-center text-muted-foreground">
              Token 缓存: {tokenProgress.ok}个/{tokenProgress.total}个{tokenProgress.failed > 0 ? ` (${tokenProgress.failed}个失败)` : ''}
              {tokenProgress.ok + tokenProgress.failed < tokenProgress.total && ' 缓存中...'}
            </span>
          )}
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
                {(resource === 'mailcom' || resource === 'registered' || resource === 'openai') && <th className="text-left font-medium text-muted-foreground px-4 py-3 whitespace-nowrap">操作</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={config.columns.length + (['mailcom','registered','openai'].includes(resource) ? 1 : 0)} className="text-center py-12 text-muted-foreground">加载中...</td></tr>
              ) : data.length === 0 ? (
                <tr><td colSpan={config.columns.length + (['mailcom','registered','openai'].includes(resource) ? 1 : 0)} className="text-center py-12 text-muted-foreground">暂无数据</td></tr>
              ) : (
                data.map((row, i) => (
                  <tr key={row.id || i} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                    {config.columns.map(col => (
                      <td key={col.key} className={`px-4 py-3 whitespace-nowrap ${col.className || ''}`}>
                        {col.render ? col.render(row[col.key], row) : (row[col.key] ?? '—')}
                      </td>
                    ))}
                    {resource === 'mailcom' && (
                      <td className="px-4 py-3 whitespace-nowrap">
                        <button onClick={() => openInbox(row.email)} className="p-1 rounded hover:bg-accent" title="查看收件箱">
                          <Mail className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                        </button>
                      </td>
                    )}
                    {(resource === 'registered' || resource === 'openai') && (
                      <td className="px-4 py-3 whitespace-nowrap">
                        <button className="text-[11px] text-muted-foreground hover:text-foreground underline" onClick={async () => {
                          const idKey = resource === 'registered' ? 'emails' : 'ids'
                          const idVal = resource === 'registered' ? [row.email] : [row.id]
                          await fetch(`/api/${resource}/exported`, {
                            method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-API-Key': getApiKey() },
                            body: JSON.stringify({ [idKey]: idVal, exported: !row.exported }),
                          })
                          load()
                        }}>{row.exported ? '取消导出' : '标记导出'}</button>
                      </td>
                    )}
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
            <DialogDescription>批量导入资源数据</DialogDescription>
          </DialogHeader>

          {/* Tab switcher - only show if resource supports text import */}
          {TEXT_IMPORT_RESOURCES.has(resource) && (
            <div className="flex gap-1 border-b pb-0">
              <button
                className={`px-3 py-1.5 text-sm font-medium rounded-t-md transition-colors ${importMode === 'text' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setImportMode('text')}
              >
                手动导入
              </button>
              <button
                className={`px-3 py-1.5 text-sm font-medium rounded-t-md transition-colors ${importMode === 'json' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setImportMode('json')}
              >
                JSON 导入
              </button>
            </div>
          )}

          {importMode === 'text' && TEXT_IMPORT_RESOURCES.has(resource) ? (
            <div className="space-y-4">
              {/* Cards: brand selector */}
              {resource === 'cards' && (
                <div>
                  <label className="text-sm font-medium mb-1.5 block">品牌 *</label>
                  <select
                    value={importBrand}
                    onChange={e => setImportBrand(e.target.value)}
                    className={SELECT_CLS}
                  >
                    <option value="">选择品牌...</option>
                    {brands.map(b => <option key={b} value={b}>{b}</option>)}
                    <option value="__new__">+ 新建品牌</option>
                  </select>
                  {importBrand === '__new__' && (
                    <input
                      value={newBrand}
                      onChange={e => setNewBrand(e.target.value)}
                      placeholder="输入新品牌名称"
                      className={INPUT_CLS + ' mt-2'}
                    />
                  )}
                </div>
              )}

              {/* Proxies: pool + region selectors */}
              {resource === 'proxies' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">代理池</label>
                    <select value={importPool} onChange={e => setImportPool(e.target.value)} className={SELECT_CLS}>
                      <option value="static">静态</option>
                      <option value="residential">家宽</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">区域</label>
                    <select value={importRegion} onChange={e => setImportRegion(e.target.value)} className={SELECT_CLS}>
                      <option value="us">us</option>
                      <option value="ph">ph</option>
                    </select>
                  </div>
                </div>
              )}

              <textarea
                value={importText}
                onChange={e => setImportText(e.target.value)}
                placeholder={
                  resource === 'mailcom' ? '每行一个: 邮箱------密码' :
                  resource === 'cards' ? '每行一张卡（Tab或空格分隔）:\n序号  卡号  有效期  CVV  持卡人  州  城市  地址  邮编' :
                  resource === 'google' ? '每行一个（-- 分隔）:\n邮箱 -- 密码 -- 备用邮箱 -- 2FA密钥' :
                  resource === 'proxies' ? '每行一个: host:port:user:pass' : ''
                }
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
                <Button onClick={handleTextImport} disabled={!importText.trim()}>导入</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
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
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Mailcom Inbox Dialog */}
      <Dialog open={!!inboxEmail} onOpenChange={v => { if (!v) { setInboxEmail(''); setMailBody(''); } }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm font-mono">{inboxEmail}</DialogTitle>
            <DialogDescription>收件箱</DialogDescription>
          </DialogHeader>

          {mailBody ? (
            <div className="space-y-3">
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setMailBody('')}>
                ← 返回列表
              </Button>
              {mailBodyLoading ? (
                <p className="text-sm text-muted-foreground py-8 text-center">加载中...</p>
              ) : (
                <iframe
                  srcDoc={mailBody}
                  sandbox="allow-same-origin"
                  className="w-full border rounded-md bg-white"
                  style={{ height: 400 }}
                  title="邮件内容"
                />
              )}
            </div>
          ) : (
            <div className="max-h-96 overflow-auto">
              {inboxLoading ? (
                <p className="text-sm text-muted-foreground py-8 text-center">加载中...</p>
              ) : inboxMails.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">暂无邮件</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">发件人</th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">主题</th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inboxMails.map((m: any) => (
                      <tr key={m.id} className="border-b last:border-0 hover:bg-muted/20 cursor-pointer" onClick={() => { setMailBodyLoading(true); openMailBody(m.id); }}>
                        <td className="px-3 py-2 max-w-[160px] truncate">{m.from}</td>
                        <td className="px-3 py-2 max-w-[250px] truncate font-medium">{m.subject || '(无主题)'}</td>
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{m.date ? new Date(m.date).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
