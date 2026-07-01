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

export const api = {
  stats: () => request('/api/stats'),

  list: (resource: string, params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return request(`/api/${resource}${qs}`)
  },

  resourceStats: (resource: string) => request(`/api/${resource}/stats`),

  import: (resource: string, body: any) =>
    request(`/api/${resource}/import`, { method: 'POST', body: JSON.stringify(body) }),
}
