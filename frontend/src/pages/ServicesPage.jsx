import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, EmptyState, ErrorState, Loading, StatusBadge } from '../components/ui';

export default function ServicesPage() {
  const [services, setServices] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ name: '', slug: '', ownerTeam: '', description: '' });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listServices();
      setServices(data.services || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function onCreate(e) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const payload = { name: form.name.trim(), ownerTeam: form.ownerTeam.trim() };
      if (form.slug.trim()) payload.slug = form.slug.trim();
      if (form.description.trim()) payload.description = form.description.trim();
      await api.createService(payload);
      setForm({ name: '', slug: '', ownerTeam: '', description: '' });
      await load();
    } catch (e) {
      setCreateError(e);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Services</h1>
          <p className="mt-1 text-sm text-slate-600">Registered provider APIs, their versions, and publish status.</p>
        </div>
        <button onClick={load} className="btn-secondary w-fit">Refresh</button>
      </div>

      <Card title="Register service" description="Add a provider service so you can upload and govern its specifications.">
        <form onSubmit={onCreate} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label">Name *</label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Quote API" required />
          </div>
          <div>
            <label className="label">Slug</label>
            <input className="input" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="quote-api (optional)" />
          </div>
          <div>
            <label className="label">Owner team *</label>
            <input className="input" value={form.ownerTeam} onChange={(e) => setForm({ ...form, ownerTeam: e.target.value })} placeholder="Quotes" required />
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Optional" />
          </div>
          <div className="sm:col-span-2 lg:col-span-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button type="submit" className="btn-primary w-fit" disabled={creating}>
              {creating ? 'Registering…' : 'Register service'}
            </button>
            {createError && <p className="text-sm text-rose-700">{createError.message}</p>}
          </div>
        </form>
      </Card>

      {loading && <Loading label="Loading services…" />}
      {!loading && error && <ErrorState title="Could not load services" error={error} onRetry={load} />}
      {!loading && !error && services && services.length === 0 && (
        <EmptyState title="No services yet" description="Register a service above, then upload its OpenAPI specs to start comparing and publishing." />
      )}
      {!loading && !error && services && services.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {services.map((service) => (
            <Link key={service.id} to={`/services/${service.slug}`} className="card group p-5 transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-400">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900 group-hover:text-slate-700">{service.name}</h3>
                  <p className="text-sm text-slate-500">{service.slug} · {service.ownerTeam}</p>
                </div>
                {service.latestStatus && <StatusBadge status={service.latestStatus} />}
              </div>
              <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg bg-slate-50 p-2">
                  <dt className="text-xs text-slate-500">Specs</dt>
                  <dd className="text-lg font-semibold text-slate-900">{service.specCount ?? 0}</dd>
                </div>
                <div className="rounded-lg bg-amber-50 p-2">
                  <dt className="text-xs text-amber-700">Drafts</dt>
                  <dd className="text-lg font-semibold text-amber-800">{service.draftCount ?? 0}</dd>
                </div>
                <div className="rounded-lg bg-emerald-50 p-2">
                  <dt className="text-xs text-emerald-700">Published</dt>
                  <dd className="text-lg font-semibold text-emerald-800">{service.publishedCount ?? 0}</dd>
                </div>
              </dl>
              <p className="mt-4 text-sm text-slate-600">
                Latest: <span className="font-medium text-slate-900">{service.latestVersion || '—'}</span>
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
