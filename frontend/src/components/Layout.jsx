import { NavLink, Outlet } from 'react-router-dom';

const navItems = [
  { to: '/', label: 'Services', end: true },
  { to: '/consumers', label: 'Consumers' },
  { to: '/metrics', label: 'Metrics' },
];

function navClass({ isActive }) {
  return `rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
  }`;
}

export default function Layout() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-sm font-bold text-white">CG</div>
            <div>
              <p className="text-sm font-semibold text-slate-900 leading-tight">Contract Guard</p>
              <p className="text-xs text-slate-500 leading-tight">API contract registry &amp; publish gate</p>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-1">
            {navItems.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <Outlet />
      </main>
    </div>
  );
}
