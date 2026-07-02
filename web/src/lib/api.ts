const API_KEY_STORAGE = 'resource-hub-api-key'

export function getApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE) || ''
}

export function setApiKey(key: string) {
  localStorage.setItem(API_KEY_STORAGE, key)
}

async function request(path: string, options?: RequestInit) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': getApiKey(),
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json()
}

const MACHINE_ID_KEY = 'resource-hub-machine-id'

export function getMachineId(): string {
  return localStorage.getItem(MACHINE_ID_KEY) || ''
}

export function setMachineId(id: string) {
  localStorage.setItem(MACHINE_ID_KEY, id)
}

export const api = {
  stats: () => request('/api/stats'),

  list: (resource: string, params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return request(`/api/${resource}${qs}`)
  },

  resourceStats: (resource: string) => request(`/api/${resource}/stats`),

  import: (resource: string, body: any) =>
    request(`/api/${resource}/import`, { method: 'POST', body: JSON.stringify(body) }),

  pull: (resource: string, body: any) =>
    request(`/api/${resource}/pull`, { method: 'POST', body: JSON.stringify(body) }),

  inbox: (email: string, mailId?: string) => {
    const qs = mailId ? `?email=${encodeURIComponent(email)}&mailId=${encodeURIComponent(mailId)}` : `?email=${encodeURIComponent(email)}`
    return request(`/api/mailcom/inbox${qs}`)
  },
}
