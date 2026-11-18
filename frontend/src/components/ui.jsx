export function Loading({ label = 'Loading…', className = '' }) {
  return (
    <div className={`flex items-center justify-center gap-3 py-10 text-slate-600 ${className}`}>
      <svg className="h-5 w-5 animate-spin text-slate-500" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
      </svg>
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

export function ErrorState({ title = 'Something went wrong', error, onRetry, className = '' }) {
  const message = !error ? null : typeof error === 'string' ? error : (error.message || 'Unexpected error');
  const details = error && error.data && error.data.error && error.data.error.details;
  return (
    <div className={`rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-900 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{title}</p>
          {message && <p className="mt-1 text-sm text-rose-800">{message}</p>}
          {Array.isArray(details) && details.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-rose-800">
              {details.map((d, i) => (
                <li key={i}><span className="font-medium">{d.path ? `${d.path}: ` : ''}</span>{d.message}</li>
              ))}
            </ul>
          )}
        </div>
        {onRetry && (
          <button onClick={onRetry} className="btn-secondary shrink-0 border-rose-300 text-rose-800 hover:bg-rose-100">Retry</button>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ title, description, action }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
      {title && <p className="font-semibold text-slate-800">{title}</p>}
      {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Card({ title, description, action, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="flex flex-col gap-2 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-slate-600">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'default' }) {
  const tones = {
    default: 'text-slate-900',
    good: 'text-emerald-700',
    warn: 'text-amber-700',
    bad: 'text-rose-700',
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tones[tone] || tones.default}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function SeverityBadge({ severity }) {
  const map = {
    BREAKING: 'bg-rose-100 text-rose-800 ring-rose-200',
    POTENTIAL: 'bg-amber-100 text-amber-800 ring-amber-200',
    NON_BREAKING: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
    WARNING: 'bg-sky-100 text-sky-800 ring-sky-200',
    INTERNAL: 'bg-slate-100 text-slate-700 ring-slate-200',
  };
  const label = {
    BREAKING: 'Breaking',
    POTENTIAL: 'Potential',
    NON_BREAKING: 'Non-breaking',
    WARNING: 'Warning',
    INTERNAL: 'Internal',
  }[severity] || severity || 'Unknown';
  return <span className={`badge ring-1 ring-inset ${map[severity] || 'bg-slate-100 text-slate-700 ring-slate-200'}`}>{label}</span>;
}

export function StatusBadge({ status }) {
  const map = {
    published: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
    draft: 'bg-amber-100 text-amber-800 ring-amber-200',
    rejected: 'bg-rose-100 text-rose-800 ring-rose-200',
    blocked: 'bg-rose-100 text-rose-800 ring-rose-200',
  };
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown';
  return <span className={`badge ring-1 ring-inset ${map[status] || 'bg-slate-100 text-slate-700 ring-slate-200'}`}>{label}</span>;
}

export function InlineCode({ children }) {
  return <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-800">{children}</code>;
}
