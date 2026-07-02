import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RefreshCw, CreditCard, Chrome, Mail, Globe, Key } from 'lucide-react'

const RESOURCE_CONFIG = [
  { key: 'cards', label: '支付卡', icon: CreditCard, color: 'text-violet-600' },
  { key: 'google', label: '谷歌账号', icon: Chrome, color: 'text-blue-600' },
  { key: 'mailcom', label: 'Mail.com', icon: Mail, color: 'text-emerald-600' },
  { key: 'proxies', label: '代理 IP', icon: Globe, color: 'text-orange-600' },
  { key: 'codex', label: 'Codex', icon: Key, color: 'text-rose-600' },
]

interface Props {
  stats: any
  onRefresh: () => void
}

export default function Overview({ stats, onRefresh }: Props) {
  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">概览</h2>
          <p className="text-sm text-muted-foreground mt-0.5">资源池状态总览</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          刷新
        </Button>
      </div>

      {!stats ? (
        <p className="text-sm text-muted-foreground">加载中...</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {RESOURCE_CONFIG.map(({ key, label, icon: Icon, color }) => {
            const s = stats[key] || {}
            return (
              <Card key={key}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle>{label}</CardTitle>
                    <Icon className={`h-4 w-4 ${color}`} />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold tabular-nums">
                    {s.available ?? s.active ?? 0}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    可用 / 共 {s.total ?? 0}
                    {s.allocated > 0 && <span className="ml-2">· {s.allocated} 已分配</span>}
                  </p>
                  <div className="mt-3 h-1.5 rounded-full bg-secondary overflow-hidden">
                    <div
                      className={`h-full rounded-full bg-current ${color} opacity-60`}
                      style={{ width: s.total ? `${((s.available ?? s.active ?? 0) / s.total) * 100}%` : '0%' }}
                    />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
