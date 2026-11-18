import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, ErrorState, Loading, Stat } from '../components/ui';

export default function MetricsPage() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.metrics();
      setMetrics(data.metrics);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Protection metrics</h1>
          <p className="mt-1 text-sm text-slate-600">What was uploaded, what was caught, and how often unsafe publishes were blocked.</p>
        </div>
        <button onClick={load} className="btn-secondary w-fit">Refresh</button>
      </div>

      {loading && <Loading label="Loading metrics…" />}
      {!loading && error && <ErrorState title="Could not load metrics" error={error} onRetry={load} />}
      {!loading && !error && metrics && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Services" value={metrics.servicesRegistered} />
            <Stat label="Specs uploaded" value={metrics.specsUploaded} hint={`Draft ${metrics.specsDraft} · Published ${metrics.specsPublished} · Rejected ${metrics.specsRejected}`} />
            <Stat label="Publish attempts" value={metrics.publishAttempts} />
            <Stat label="Blocked publishes" value={metrics.blockedPublishes} tone={metrics.blockedPublishes > 0 ? 'bad' : 'default'} hint={`${metrics.publishedPublishes} published`} />
            <Stat label="Breaking changes" value={metrics.breakingChanges} tone={metrics.breakingChanges > 0 ? 'bad' : 'default'} hint={`${metrics.dangerousChangesCaught} caught on blocked attempts`} />
            <Stat label="Affected consumers" value={metrics.affectedConsumers} tone={metrics.affectedConsumers > 0 ? 'warn' : 'default'} hint={`${metrics.affectedConsumersOnBlocked} on blocked attempts`} />
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title="Quality & coverage" description="Validation and registered consumer coverage.">
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-lg bg-slate-50 p-4">
                  <dt className="text-sm text-slate-600">Validation failure rate</dt>
                  <dd className="mt-1 text-xl font-semibold text-slate-900">{(metrics.validationFailureRate * 100).toFixed(2)}%</dd>
                  <p className="text-xs text-slate-500">{metrics.specsRejected} rejected of {metrics.specsUploaded} uploads</p>
                </div>
                <div className="rounded-lg bg-slate-50 p-4">
                  <dt className="text-sm text-slate-600">Publish success ratio</dt>
                  <dd className="mt-1 text-xl font-semibold text-slate-900">{(metrics.publishSuccessRatio * 100).toFixed(2)}%</dd>
                  <p className="text-xs text-slate-500">{metrics.publishedPublishes} published of {metrics.publishAttempts} attempts</p>
                </div>
                <div className="rounded-lg bg-slate-50 p-4">
                  <dt className="text-sm text-slate-600">Consumers registered</dt>
                  <dd className="mt-1 text-xl font-semibold text-slate-900">{metrics.consumersRegistered}</dd>
                  <p className="text-xs text-slate-500">{metrics.usagesRegistered} endpoint usages</p>
                </div>
                <div className="rounded-lg bg-slate-50 p-4">
                  <dt className="text-sm text-slate-600">Proposals with consumer impact</dt>
                  <dd className="mt-1 text-xl font-semibold text-slate-900">{metrics.proposedVersionsWithConsumerImpact}</dd>
                  <p className="text-xs text-slate-500">Publish attempts where at least one consumer was affected</p>
                </div>
              </dl>
            </Card>

            <Card title="Breaking changes by service" description="Recorded breaking changes across publish attempts.">
              {(!metrics.breakingChangesByService || metrics.breakingChangesByService.length === 0) ? (
                <p className="text-sm text-slate-600">No breaking changes recorded yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-slate-500">
                        <th className="py-2 pr-4 font-medium">Service</th>
                        <th className="py-2 pr-4 font-medium">Slug</th>
                        <th className="py-2 font-medium text-right">Breaking changes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.breakingChangesByService.map((row) => (
                        <tr key={row.serviceId} className="border-b border-slate-100 last:border-0">
                          <td className="py-2.5 pr-4 font-medium text-slate-900">{row.name}</td>
                          <td className="py-2.5 pr-4 text-slate-600">{row.slug}</td>
                          <td className="py-2.5 text-right font-semibold text-rose-700">{row.breakingCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
