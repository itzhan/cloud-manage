import { useState, useEffect, useCallback } from 'react'
import { getApiKey } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { RefreshCw, Plus, Trash2, Copy, Check } from 'lucide-react'

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<{ name: string; key: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newKey, setNewKey] = useState('')
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState('')

  const INPUT_CLS = 'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/keys', { headers: { 'X-API-Key': getApiKey() } })
      const d = await res.json()
      setKeys(d.keys || [])
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const addKey = async () => {
    if (!newName.trim()) { setMsg('请输入名称'); return }
    setMsg('')
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': getApiKey() },
        body: JSON.stringify({ name: newName.trim(), key: newKey.trim() || undefined }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setMsg(`已添加，密钥: ${d.key}`)
      setNewName('')
      setNewKey('')
      load()
    } catch (e: any) { setMsg(`错误: ${e.message}`) }
  }

  const deleteKey = async (name: string) => {
    if (!confirm(`确定删除密钥 "${name}"？`)) return
    try {
      const res = await fetch('/api/keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': getApiKey() },
        body: JSON.stringify({ name }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      load()
    } catch (e: any) { setMsg(`错误: ${e.message}`) }
  }

  const copyKey = (key: string) => {
    navigator.clipboard.writeText(key)
    setCopied(key)
    setTimeout(() => setCopied(''), 2000)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">密钥管理</h2>
          <p className="text-sm text-muted-foreground mt-0.5">管理 API 访问密钥，每个密钥对应一台机器</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />刷新
        </Button>
      </div>

      {/* 现有密钥 */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">现有密钥</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? <p className="text-sm text-muted-foreground">加载中...</p> : keys.length === 0 ? <p className="text-sm text-muted-foreground">暂无密钥</p> : (
            <div className="space-y-2">
              {keys.map(k => (
                <div key={k.name} className="flex items-center justify-between py-2 px-3 rounded-md border">
                  <div className="flex items-center gap-3">
                    <Badge variant="secondary">{k.name}</Badge>
                    <span className="font-mono text-xs text-muted-foreground">{k.key}</span>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => copyKey(k.key)} className="p-1.5 rounded hover:bg-accent" title="复制完整密钥">
                      {copied === k.key ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 text-muted-foreground" />}
                    </button>
                    <button onClick={() => deleteKey(k.name)} className="p-1.5 rounded hover:bg-accent" title="删除">
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 添加新密钥 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">添加密钥</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">名称</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="例如 win-server-01" className={INPUT_CLS} />
            </div>
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">密钥（留空自动生成）</label>
              <input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="自动生成" className={INPUT_CLS} />
            </div>
            <Button onClick={addKey} className="h-9">
              <Plus className="h-3.5 w-3.5 mr-1.5" />添加
            </Button>
          </div>
          {msg && <p className={`text-xs mt-2 ${msg.startsWith('错误') ? 'text-destructive' : 'text-emerald-600'}`}>{msg}</p>}
        </CardContent>
      </Card>
    </div>
  )
}
