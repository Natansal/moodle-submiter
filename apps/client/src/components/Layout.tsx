import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { APP_NAME } from '../brand';

const navItems = [
  { path: '/setup', label: 'Setup' },
  { path: '/dashboard', label: 'Dashboard' },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate('/login');
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-gray-800/60 bg-gray-950/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between pl-0 pr-4 sm:pl-0 sm:pr-6">
          <div className="flex items-center gap-3">
            <img
              src={`${import.meta.env.BASE_URL}logo.png`}
              alt={`${APP_NAME} logo`}
              className="h-8 w-8 rounded-lg object-cover shadow-md shadow-cyan-500/20"
            />
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-tight text-white sm:text-lg">
                {APP_NAME}
              </span>
            </div>
            <nav className="flex gap-1">
              {navItems.map((item) => (
                <button
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    location.pathname === item.path
                      ? 'bg-gray-800 text-white'
                      : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </nav>
          </div>
          <button onClick={handleLogout} className="btn-secondary !px-3 !py-1.5 text-xs">
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}
