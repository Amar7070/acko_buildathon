const BASE = import.meta.env.VITE_API_BASE || '';

function buildQuery(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.set(key, String(value));
  });
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

async function request(path, options = {}) {
  const { rawBody, json, headers, allowStatuses, ...rest } = options;
  const init = { ...rest, headers: { ...(headers || {}) } };

  if (rawBody !== undefined) {
    init.body = rawBody;
  } else if (json !== undefined) {
    init.body = JSON.stringify(json);
    if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  const isAllowed = Array.isArray(allowStatuses) && allowStatuses.includes(res.status);
  if (!res.ok && !isAllowed) {
    const message = (data && data.error && data.error.message)
      || (data && data.message)
      || (typeof data === 'string' ? data : `Request failed (${res.status})`);
    const error = new Error(message);
    error.status = res.status;
    error.data = data;
    error.code = data && data.error && data.error.code;
    throw error;
  }

  return data;
}

export const api = {
  health: () => request('/api/health'),

  listServices: () => request('/api/v1/services'),
  getService: (slug) => request(`/api/v1/services/${encodeURIComponent(slug)}`),
  createService: (payload) => request('/api/v1/services', { method: 'POST', json: payload }),

  uploadSpec: (serviceSlug, content, contentType = 'application/yaml') =>
    request(`/api/v1/services/${encodeURIComponent(serviceSlug)}/specs`, {
      method: 'POST',
      rawBody: content,
      headers: { 'Content-Type': contentType },
    }),

  diff: (serviceSlug, params = {}) =>
    request(`/api/v1/services/${encodeURIComponent(serviceSlug)}/diff${buildQuery(params)}`),
  changelog: (serviceSlug, params = {}) =>
    request(`/api/v1/services/${encodeURIComponent(serviceSlug)}/changelog${buildQuery(params)}`),
  attempts: (serviceSlug) =>
    request(`/api/v1/services/${encodeURIComponent(serviceSlug)}/attempts`),

  getSpec: (id) => request(`/api/v1/specs/${encodeURIComponent(id)}`),
  specImpact: (id, params = {}) =>
    request(`/api/v1/specs/${encodeURIComponent(id)}/impact${buildQuery(params)}`),
  publishSpec: (id, payload = {}) =>
    request(`/api/v1/specs/${encodeURIComponent(id)}/publish`, { method: 'POST', json: payload, allowStatuses: [409] }),

  listConsumers: () => request('/api/v1/consumers'),
  importConsumers: (directory) =>
    request('/api/v1/consumers/import', { method: 'POST', json: directory ? { directory } : {} }),

  metrics: () => request('/api/v1/metrics'),
};

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

export function shortDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString();
}
