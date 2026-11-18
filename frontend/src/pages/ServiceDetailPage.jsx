import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate } from '../lib/api';
import { Card, EmptyState, ErrorState, InlineCode, Loading, SeverityBadge, StatusBadge } from '../components/ui';

function versionLabel(v) {
  if (!v) return '—';
  const ver = v.declaredVersion || v.declared_version || '?';
  const rev = v.revision != null ? `r${v.revision}` : '';
  return `v${ver} ${rev} (#${v.id})`.trim();
}

function SummaryCounts({ bySeverity }) {
  const items = [
    ['BREAKING', 'Breaking'],
    ['POTENTIAL', 'Potential'],
    ['NON_BREAKING', 'Non-breaking'],
    ['WARNING', 'Warning'],
    ['INTERNAL', 'Internal'],
  ];
  const s = bySeverity || {};
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(([key, label]) => (
        <span key={key} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm">
          <SeverityBadge severity={key} />
          <span className="font-semibold text-slate-900">{s[key] ?? 0}</span>
          <span className="sr-only">{label}</span>
        </span>
      ))}
    </div>
  );
}

function ChangesList({ changes, emptyText = 'No changes.' }) {
  if (!changes || changes.length === 0) {
    return <p className="text-sm text-slate-600">{emptyText}</p>;
  }
  return (
    <ul className="space-y-3">
      {changes.map((c, idx) => (
        <li key={c.key || `${c.kind}-${idx}`} className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={c.severity} />
              <span className="text-sm font-medium text-slate-900">{c.kind}</span>
              {c.blocksPublish && <span className="badge bg-rose-600 text-white">Blocks publish</span>}
              {c.isInternal && <span className="badge bg-slate-200 text-slate-700">Internal op</span>}
            </div>
            <div className="text-xs text-slate-500">
              <InlineCode>{c.method} {c.path}</InlineCode>
              {c.location ? ` · ${c.location}` : ''}{c.direction ? `/${c.direction}` : ''}
            </div>
          </div>
          <p className="mt-2 text-sm text-slate-800">{c.reason}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
            {c.fieldPath && <span>Field: <InlineCode>{c.fieldPath}</InlineCode></span>}
            {c.parameter && c.parameter.name && <span>Parameter: <InlineCode>{c.parameter.name}</InlineCode>{c.parameter.in ? ` (${c.parameter.in})` : ''}</span>}
            {c.statusCode && <span>Status: <InlineCode>{String(c.statusCode)}</InlineCode></span>}
            {c.before !== undefined && c.before !== null && <span>Before: <InlineCode>{typeof c.before === 'object' ? JSON.stringify(c.before) : String(c.before)}</InlineCode></span>}
            {c.after !== undefined && c.after !== null && <span>After: <InlineCode>{typeof c.after === 'object' ? JSON.stringify(c.after) : String(c.after)}</InlineCode></span>}
          </div>
          {Array.isArray(c.affectedConsumers) && c.affectedConsumers.length > 0 && (
            <div className="mt-3 rounded-md bg-amber-50 p-3 text-sm">
              <p className="font-medium text-amber-900">Affected consumers</p>
              <ul className="mt-1 space-y-1 text-amber-900">
                {c.affectedConsumers.map((ac) => (
                  <li key={ac.id || ac.slug}>
                    <span className="font-medium">{ac.slug}</span>{ac.team ? ` (${ac.team})` : ''}{ac.via ? ` · via ${ac.via}` : ''}
                    {Array.isArray(ac.matchedFields) && ac.matchedFields.length > 0 ? ` · fields: ${ac.matchedFields.join(', ')}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function ImpactPanel({ impact }) {
  if (!impact) return null;
  const affected = impact.affectedConsumers || [];
  return (
    <div className="space-y-3">
      <div className={`rounded-lg border p-4 ${impact.blocked ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50'}`}>
        <p className={`font-semibold ${impact.blocked ? 'text-rose-900' : 'text-emerald-900'}`}>
          {impact.blocked ? 'Publishing blocked by consumer impact' : 'No blocking consumer impact'}
        </p>
        <p className={`mt-1 text-sm ${impact.blocked ? 'text-rose-800' : 'text-emerald-800'}`}>
          {impact.blockingChangeCount || 0} blocking change(s) · {impact.affectedConsumerCount || affected.length || 0} affected consumer(s)
        </p>
      </div>
      {affected.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 pr-4 font-medium">Consumer</th>
                <th className="py-2 pr-4 font-medium">Team</th>
                <th className="py-2 pr-4 font-medium">Severities</th>
                <th className="py-2 pr-4 font-medium">Via</th>
                <th className="py-2 font-medium text-right">Changes</th>
              </tr>
            </thead>
            <tbody>
              {affected.map((c) => (
                <tr key={c.id || c.slug} className="border-b border-slate-100 last:border-0">
                  <td className="py-2.5 pr-4 font-medium text-slate-900">{c.slug}</td>
                  <td className="py-2.5 pr-4 text-slate-600">{c.team || '—'}</td>
                  <td className="py-2.5 pr-4"><div className="flex flex-wrap gap-1">{(c.severities || []).map((s) => <SeverityBadge key={s} severity={s} />)}</div></td>
                  <td className="py-2.5 pr-4 text-slate-600">{(c.vias || []).join(', ') || '—'}</td>
                  <td className="py-2.5 text-right font-semibold text-slate-900">{c.changeCount ?? (c.changes ? c.changes.length : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ComparisonView({ result }) {
  if (!result) return null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
        <span>From <InlineCode>{versionLabel(result.from)}</InlineCode></span>
        <span>→</span>
        <span>To <InlineCode>{versionLabel(result.to)}</InlineCode></span>
        <span className="text-slate-500">· {result.summary?.total ?? (result.changes || []).length} change(s)</span>
      </div>
      <SummaryCounts bySeverity={result.summary?.bySeverity} />
      <ImpactPanel impact={result.impact} />
      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-900">Change details</h3>
        <ChangesList changes={result.changes} emptyText="No semantic changes between these versions." />
      </div>
    </div>
  );
}

export default function ServiceDetailPage() {
  const { slug } = useParams();
  const [serviceData, setServiceData] = useState(null);
  const [attempts, setAttempts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [uploadFile, setUploadFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [uploadResult, setUploadResult] = useState(null);

  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [diff, setDiff] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState(null);

  const [clFrom, setClFrom] = useState('');
  const [clTo, setClTo] = useState('');
  const [changelog, setChangelog] = useState(null);
  const [clLoading, setClLoading] = useState(false);
  const [clError, setClError] = useState(null);

  const [publishBusy, setPublishBusy] = useState(null);
  const [publishResult, setPublishResult] = useState(null);
  const [publishError, setPublishError] = useState(null);

  const [impactBusy, setImpactBusy] = useState(null);
  const [impactResult, setImpactResult] = useState(null);
  const [impactError, setImpactError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [svc, att] = await Promise.all([api.getService(slug), api.attempts(slug).catch(() => ({ attempts: [] }))]);
      setServiceData(svc);
      setAttempts(att.attempts || []);
      const versions = svc.versions || [];
      if (versions.length >= 2) {
        setFromId(String(versions[versions.length - 2].id));
        setToId(String(versions[versions.length - 1].id));
        setClFrom(String(versions[versions.length - 2].id));
        setClTo(String(versions[versions.length - 1].id));
      } else if (versions.length === 1) {
        setFromId(''); setToId(''); setClFrom(''); setClTo('');
      }
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  const versions = useMemo(() => (serviceData && serviceData.versions) || [], [serviceData]);
  const service = serviceData && serviceData.service;

  async function onUpload(e) {
    e.preventDefault();
    if (!uploadFile) return;
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const content = await uploadFile.text();
      const name = uploadFile.name.toLowerCase();
      const contentType = name.endsWith('.json') ? 'application/json' : 'application/yaml';
      const result = await api.uploadSpec(slug, content, contentType);
      setUploadResult(result);
      setUploadFile(null);
      e.target.reset();
      await load();
    } catch (e2) {
      setUploadError(e2);
    } finally {
      setUploading(false);
    }
  }

  async function onCompare(e) {
    e && e.preventDefault();
    setDiffLoading(true);
    setDiffError(null);
    setDiff(null);
    try {
      const params = fromId && toId ? { from: fromId, to: toId } : {};
      const result = await api.diff(slug, params);
      setDiff(result);
    } catch (e2) {
      setDiffError(e2);
    } finally {
      setDiffLoading(false);
    }
  }

  async function onChangelog(e) {
    e && e.preventDefault();
    setClLoading(true);
    setClError(null);
    setChangelog(null);
    try {
      const params = clFrom && clTo ? { from: clFrom, to: clTo } : {};
      const result = await api.changelog(slug, params);
      setChangelog(result);
    } catch (e2) {
      setClError(e2);
    } finally {
      setClLoading(false);
    }
  }

  async function onPublish(id) {
    setPublishBusy(id);
    setPublishError(null);
    setPublishResult(null);
    try {
      const result = await api.publishSpec(id, { actor: 'ui' });
      setPublishResult(result);
      await load();
    } catch (e2) {
      setPublishError(e2);
    } finally {
      setPublishBusy(null);
    }
  }

  async function onImpact(id) {
    setImpactBusy(id);
    setImpactError(null);
    setImpactResult(null);
    try {
      const result = await api.specImpact(id);
      setImpactResult({ specId: id, ...result });
    } catch (e2) {
      setImpactError(e2);
    } finally {
      setImpactBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link to="/" className="text-sm text-slate-500 hover:text-slate-700">← Back to services</Link>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">{service ? service.name : slug}</h1>
          {service && <p className="mt-1 text-sm text-slate-600">{service.slug} · Team {service.ownerTeam}{service.description ? ` · ${service.description}` : ''}</p>}
        </div>
        <button onClick={load} className="btn-secondary w-fit">Refresh</button>
      </div>

      {loading && <Loading label="Loading service…" />}
      {!loading && error && <ErrorState title="Could not load service" error={error} onRetry={load} />}

      {!loading && !error && service && (
        <>
          <Card title="Upload specification" description="Upload an OpenAPI 3.0.x document (YAML or JSON). New uploads are stored as drafts until published.">
            <form onSubmit={onUpload} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label className="label">Spec file</label>
                <input type="file" accept=".yaml,.yml,.json,application/yaml,application/json,text/yaml" className="input" onChange={(e) => setUploadFile(e.target.files && e.target.files[0])} />
              </div>
              <button type="submit" className="btn-primary" disabled={uploading || !uploadFile}>{uploading ? 'Uploading…' : 'Upload spec'}</button>
            </form>
            {uploadError && <ErrorState title="Upload failed" error={uploadError} className="mt-3" />}
            {uploadResult && (
              <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                <p className="font-semibold">Uploaded {versionLabel(uploadResult.version)} as <StatusBadge status={uploadResult.version.status} /></p>
                <p className="mt-1">Hash: <InlineCode>{uploadResult.version.contentHash?.slice(0, 16)}…</InlineCode></p>
                {Array.isArray(uploadResult.warnings) && uploadResult.warnings.length > 0 && (
                  <ul className="mt-2 list-disc pl-5">{uploadResult.warnings.map((w, i) => <li key={i}>{typeof w === 'string' ? w : w.message}</li>)}</ul>
                )}
              </div>
            )}
          </Card>

          <Card title="API version history" description="All uploaded revisions, newest first. Drafts can be evaluated and published.">
            {versions.length === 0 ? (
              <EmptyState title="No versions yet" description="Upload a specification to create the first version." />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="py-2 pr-4 font-medium">Version</th>
                      <th className="py-2 pr-4 font-medium">Revision</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 pr-4 font-medium">Uploaded</th>
                      <th className="py-2 pr-4 font-medium">Published</th>
                      <th className="py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...versions].reverse().map((v) => (
                      <tr key={v.id} className="border-b border-slate-100 align-top last:border-0">
                        <td className="py-3 pr-4">
                          <div className="font-medium text-slate-900">v{v.declaredVersion}</div>
                          <div className="text-xs text-slate-500">#{v.id}{v.uploadedBy ? ` · ${v.uploadedBy}` : ''}</div>
                        </td>
                        <td className="py-3 pr-4 text-slate-700">r{v.revision}</td>
                        <td className="py-3 pr-4"><StatusBadge status={v.status} /></td>
                        <td className="py-3 pr-4 text-slate-600">{formatDate(v.uploadedAt)}</td>
                        <td className="py-3 pr-4 text-slate-600">{formatDate(v.publishedAt)}</td>
                        <td className="py-3">
                          <div className="flex flex-wrap gap-2">
                            <button className="btn-secondary" onClick={() => onImpact(v.id)} disabled={impactBusy === v.id}>{impactBusy === v.id ? 'Checking…' : 'Impact vs baseline'}</button>
                            {v.status === 'draft' && (
                              <button className="btn-primary" onClick={() => onPublish(v.id)} disabled={publishBusy === v.id}>{publishBusy === v.id ? 'Publishing…' : 'Publish'}</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {impactError && <ErrorState title="Impact check failed" error={impactError} className="mt-4" />}
            {impactResult && (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">Impact report (spec #{impactResult.specId})</h3>
                  <button className="text-sm text-slate-500 hover:text-slate-700" onClick={() => setImpactResult(null)}>Dismiss</button>
                </div>
                <ComparisonView result={impactResult} />
              </div>
            )}

            {publishError && <ErrorState title="Publish failed" error={publishError} className="mt-4" />}
            {publishResult && (
              <div className={`mt-4 rounded-xl border p-4 ${publishResult.outcome === 'blocked' ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className={`font-semibold ${publishResult.outcome === 'blocked' ? 'text-rose-900' : 'text-emerald-900'}`}>
                      {publishResult.outcome === 'blocked' ? 'Publish blocked' : 'Published successfully'}
                    </p>
                    <p className={`mt-1 text-sm ${publishResult.outcome === 'blocked' ? 'text-rose-800' : 'text-emerald-800'}`}>
                      Spec <InlineCode>{versionLabel(publishResult.spec)}</InlineCode> · status <StatusBadge status={publishResult.spec?.status} /> · attempt #{publishResult.attempt?.id}
                    </p>
                  </div>
                  <button className="text-sm text-slate-600 hover:text-slate-800" onClick={() => setPublishResult(null)}>Dismiss</button>
                </div>
                <div className="mt-4 space-y-3">
                  {publishResult.summary && <SummaryCounts bySeverity={publishResult.summary.bySeverity} />}
                  {publishResult.impact && <ImpactPanel impact={publishResult.impact} />}
                  {Array.isArray(publishResult.changes) && publishResult.changes.length > 0 && (
                    <details className="rounded-lg border border-slate-200 bg-white p-3">
                      <summary className="cursor-pointer text-sm font-medium text-slate-800">View recorded changes ({publishResult.changes.length})</summary>
                      <div className="mt-3"><ChangesList changes={publishResult.changes} /></div>
                    </details>
                  )}
                </div>
              </div>
            )}
          </Card>

          <Card title="Version comparison" description="Compare two revisions to see semantic diffs, breaking changes, and consumer impact.">
            {versions.length < 2 ? (
              <p className="text-sm text-slate-600">At least two versions are required to compare. Upload another spec first.</p>
            ) : (
              <form onSubmit={onCompare} className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
                  <div>
                    <label className="label">From (base)</label>
                    <select className="input" value={fromId} onChange={(e) => setFromId(e.target.value)}>
                      <option value="">Latest two (auto)</option>
                      {versions.map((v) => <option key={v.id} value={v.id}>{versionLabel(v)} · {v.status}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">To (candidate)</label>
                    <select className="input" value={toId} onChange={(e) => setToId(e.target.value)}>
                      <option value="">Latest two (auto)</option>
                      {versions.map((v) => <option key={v.id} value={v.id}>{versionLabel(v)} · {v.status}</option>)}
                    </select>
                  </div>
                  <div>
                    <button type="submit" className="btn-primary w-full sm:w-auto" disabled={diffLoading}>{diffLoading ? 'Comparing…' : 'Compare versions'}</button>
                  </div>
                </div>
              </form>
            )}
            {diffError && <ErrorState title="Comparison failed" error={diffError} className="mt-4" />}
            {diffLoading && <Loading label="Comparing versions…" />}
            {!diffLoading && diff && <div className="mt-4"><ComparisonView result={diff} /></div>}
          </Card>

          <Card title="Changelog" description="Human-readable changelog between two versions (public view omits internal-only changes).">
            {versions.length < 2 ? (
              <p className="text-sm text-slate-600">At least two versions are required to generate a changelog.</p>
            ) : (
              <form onSubmit={onChangelog} className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
                  <div>
                    <label className="label">From</label>
                    <select className="input" value={clFrom} onChange={(e) => setClFrom(e.target.value)}>
                      <option value="">Latest two (auto)</option>
                      {versions.map((v) => <option key={v.id} value={v.id}>{versionLabel(v)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">To</label>
                    <select className="input" value={clTo} onChange={(e) => setClTo(e.target.value)}>
                      <option value="">Latest two (auto)</option>
                      {versions.map((v) => <option key={v.id} value={v.id}>{versionLabel(v)}</option>)}
                    </select>
                  </div>
                  <div>
                    <button type="submit" className="btn-primary w-full sm:w-auto" disabled={clLoading}>{clLoading ? 'Generating…' : 'Generate changelog'}</button>
                  </div>
                </div>
              </form>
            )}
            {clError && <ErrorState title="Could not generate changelog" error={clError} className="mt-4" />}
            {clLoading && <Loading label="Generating changelog…" />}
            {!clLoading && changelog && (
              <div className="mt-4 space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
                  <span>From <InlineCode>{versionLabel(changelog.from)}</InlineCode></span>
                  <span>→</span>
                  <span>To <InlineCode>{versionLabel(changelog.to)}</InlineCode></span>
                  <span className="text-slate-500">· {changelog.publicSummary?.total ?? (changelog.entries || []).length} public entries</span>
                </div>
                {changelog.publicSummary?.bySeverity && <SummaryCounts bySeverity={changelog.publicSummary.bySeverity} />}
                {changelog.markdown ? (
                  <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">{changelog.markdown}</pre>
                ) : Array.isArray(changelog.entries) && changelog.entries.length > 0 ? (
                  <ul className="space-y-2">
                    {changelog.entries.map((entry, idx) => (
                      <li key={idx} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2"><SeverityBadge severity={entry.severity} /><InlineCode>{entry.method} {entry.path}</InlineCode>{entry.blocksPublish && <span className="badge bg-rose-600 text-white">Blocks publish</span>}</div>
                        <p className="mt-1 text-slate-800">{entry.text || entry.reason}</p>
                        {Array.isArray(entry.affectedConsumers) && entry.affectedConsumers.length > 0 && <p className="mt-1 text-xs text-slate-600">Affects: {entry.affectedConsumers.join(', ')}</p>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-600">No public changelog entries for this range.</p>
                )}
              </div>
            )}
          </Card>

          <Card title="Publish attempts" description="History of publish attempts (including blocked ones) with recorded changes and impact.">
            {attempts.length === 0 ? (
              <p className="text-sm text-slate-600">No publish attempts recorded yet.</p>
            ) : (
              <div className="space-y-3">
                {attempts.map((a) => (
                  <details key={a.id} className="rounded-lg border border-slate-200 bg-white p-4">
                    <summary className="cursor-pointer list-none">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge status={a.outcome} />
                          <span className="font-medium text-slate-900">Attempt #{a.id}</span>
                          <span className="text-sm text-slate-600">{versionLabel(a.candidate)}{a.base ? <> vs <InlineCode>{versionLabel(a.base)}</InlineCode></> : ' (baseline)'}</span>
                        </div>
                        <div className="text-xs text-slate-500">{formatDate(a.createdAt)}{a.actor ? ` · ${a.actor}` : ''}</div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
                        <span>Breaking: <strong className="text-slate-900">{a.breakingCount}</strong></span>
                        <span>Potential: <strong className="text-slate-900">{a.potentialCount}</strong></span>
                        <span>Affected consumers: <strong className="text-slate-900">{a.affectedConsumerCount}</strong></span>
                      </div>
                    </summary>
                    <div className="mt-4 space-y-3">
                      {a.note && <p className="text-sm text-slate-700"><span className="font-medium">Note:</span> {a.note}</p>}
                      {Array.isArray(a.changes) && a.changes.length > 0 ? <ChangesList changes={a.changes} /> : <p className="text-sm text-slate-600">No recorded changes for this attempt.</p>}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}