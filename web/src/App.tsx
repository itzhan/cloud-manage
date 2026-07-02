import { useState, useEffect, useCallback } from 'react'
import { LayoutDashboard, CreditCard, Mail, Chrome, Globe, Key, Settings, LogIn, ClipboardList, ShieldCheck, UserPlus } from 'lucide-react'
import { api, getApiKey, setApiKey } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import Overview from '@/pages/overview'
import ResourcePage from '@/pages/resource-page'
import AllocationLog from '@/pages/allocation-log'
import ApiKeysPage from '@/pages/api-keys'

const NAV = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'cards', label: '支付卡', icon: CreditCard },
  { id: 'google', label: '谷歌账号', icon: Chrome },
  { id: 'mailcom', label: 'Mail.com', icon: Mail },
  { id: 'proxies', label: '代理 IP', icon: Globe },
  { id: 'codex', label: 'Codex', icon: Key },
  { id: 'registered', label: 'Claude官Key', icon: ShieldCheck },
  { id: 'openai', label: 'OpenAI官Key', icon: UserPlus },
  { id: 'log', label: '分配记录', icon: ClipboardList },
  { id: 'keys', label: '密钥管理', icon: Settings },
] as const

type PageId = (typeof NAV)[number]['id']

export default function App() {
  const [page, setPage] = useState<PageId>('overview')
  const [authed, setAuthed] = useState(!!getApiKey())
  const [keyInput, setKeyInput] = useState('')
  const [error, setError] = useState('')
  const [stats, setStats] = useState<any>(null)

  const loadStats = useCallback(async () => {
    try {
      const data = await api.stats()
      setStats(data)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (authed) loadStats()
  }, [authed, loadStats])

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30">
        <div className="w-full max-w-sm space-y-6 p-8">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Resource Hub</h1>
            <p className="text-sm text-muted-foreground mt-1">输入 API Key 以继续</p>
          </div>
          <form onSubmit={async (e) => {
            e.preventDefault()
            setApiKey(keyInput)
            try {
              await api.stats()
              setAuthed(true)
              setError('')
            } catch {
              setError('认证失败，请检查 API Key')
              setApiKey('')
            }
          }}>
            <input
              type="password"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              placeholder="API Key"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            {error && <p className="text-sm text-destructive mt-2">{error}</p>}
            <Button type="submit" className="w-full mt-4">
              <LogIn className="mr-2 h-4 w-4" />
              登录
            </Button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-56 border-r bg-muted/20 flex flex-col">
        <div className="h-14 flex items-center px-5 border-b">
          <h1 className="text-sm font-semibold tracking-tight">Resource Hub</h1>
        </div>
        <nav className="flex-1 py-3 px-3 space-y-0.5">
          {NAV.map(item => (
            <button
              key={item.id}
              onClick={() => { setPage(item.id); if (item.id === 'overview') loadStats() }}
              className={cn(
                'flex items-center gap-2.5 w-full rounded-md px-3 py-2 text-sm transition-colors',
                page === item.id
                  ? 'bg-secondary text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t">
          <button
            onClick={() => { setApiKey(''); setAuthed(false) }}
            className="flex items-center gap-2.5 w-full rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
          >
            <Settings className="h-4 w-4" />
            退出登录
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto p-8">
          {page === 'overview' && <Overview stats={stats} onRefresh={loadStats} />}
          {page === 'cards' && <ResourcePage resource="cards" title="支付卡" />}
          {page === 'google' && <ResourcePage resource="google" title="谷歌账号" />}
          {page === 'mailcom' && <ResourcePage resource="mailcom" title="Mail.com 邮箱" />}
          {page === 'proxies' && <ResourcePage resource="proxies" title="代理 IP" />}
          {page === 'codex' && <ResourcePage resource="codex" title="Codex 凭证" />}
          {page === 'registered' && <ResourcePage resource="registered" title="Claude 官Key" />}
          {page === 'openai' && <ResourcePage resource="openai" title="OpenAI 官Key" />}
          {page === 'log' && <AllocationLog />}
          {page === 'keys' && <ApiKeysPage />}
        </div>
      </main>
    </div>
  )
}
