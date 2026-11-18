import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, EmptyState, ErrorState, InlineCode, Loading } from '../components/ui';

export default function ConsumersPage() {
  const [consumers, setConsumers] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listConsumers();
      setConsumers(data.consumers || []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function onImport() {
    setImporting(true);
    setImportResult(null);
    setImportError(null);
    try {
      const result = await api.importConsumers();
      setImportResult(result);
      await load();
    } catch (e) {
      setImportError(e);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Consumers</h1>
          <p className="mt-1 text-sm text-slate-600">Services that depend on provider APIs, and the operations/fields they use.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={onImport} className="btn-primary" disabled={importing}>{importing ? 'Importing…' : 'Import from consumers folder'}</button>
          <button onClick={load} className="btn-secondary">Refresh</button>
        </div>
      </div>

      {importError && <ErrorState title="Import failed" error={importError} />}
      {importResult && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
          <p className="font-semibold">Imported {importResult.imported} consumer manifest(s)</p>
          <p className="mt-1 text-sm">{importResult.created} created, {importResult.updated} updated{importResult.directory ? ` from ${importResult.directory}` : ''}.</p>
        </div>
      )}

      {loading && <Loading label="Loading consumers…" />}
      {!loading && error && <ErrorState title="Could not load consumers" error={error} onRetry={load} />}
      {!loading && !error && consumers && consumers.length === 0 && (
        <EmptyState title="No consumers registered" description="Register provider services first, then import consumer manifests from the project's consumers folder." action={<button onClick={onImport} className="btn-primary" disabled={importing}>Import consumers</button>} />
      )}
      {!loading && !error && consumers && consumers.length > 0 && (
        <div className="space-y-4">
          {consumers.map((consumer) => (
            <Card key={consumer.id} title={consumer.name || consumer.slug} description={`${consumer.slug} · Team: ${consumer.team} · ${consumer.uses?.length || 0} usage(s)`}>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="py-2 pr-4 font-medium">Provider</th>
                      <th className="py-2 pr-4 font-medium">Operation</th>
                      <th className="py-2 pr-4 font-medium">Sends</th>
                      <th className="py-2 pr-4 font-medium">Reads</th>
                      <th className="py-2 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(consumer.uses || []).map((use) => (
                      <tr key={use.id} className="border-b border-slate-100 align-top last:border-0">
                        <td className="py-2.5 pr-4 font-medium text-slate-900">{use.provider}</td>
                        <td className="py-2.5 pr-4 text-slate-700"><InlineCode>{use.method} {use.path}</InlineCode></td>
                        <td className="py-2.5 pr-4 text-slate-600">{(use.sends || []).length ? use.sends.join(', ') : '—'}</td>
                        <td className="py-2.5 pr-4 text-slate-600">{(use.reads || []).length ? use.reads.join(', ') : '—'}</td>
                        <td className="py-2.5 text-slate-500">{use.sourceFile || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
