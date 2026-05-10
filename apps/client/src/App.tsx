import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { supabase } from './lib/supabase';
import { ToastProvider } from './components/Toast';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { SetupPage } from './pages/Setup';
import { DashboardPage } from './pages/Dashboard';
import { Spinner } from './components/Spinner';

function AuthGate({ children, requireAuth }: { children: React.ReactNode; requireAuth: boolean }) {
  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAuthed(!!data.session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthed(!!session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (requireAuth && !authed) return <Navigate to="/login" replace />;
  if (!requireAuth && authed) return <Navigate to="/setup" replace />;

  return <>{children}</>;
}

export function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route
          path="/login"
          element={
            <AuthGate requireAuth={false}>
              <LoginPage />
            </AuthGate>
          }
        />
        <Route
          path="/setup"
          element={
            <AuthGate requireAuth={true}>
              <Layout>
                <SetupPage />
              </Layout>
            </AuthGate>
          }
        />
        <Route
          path="/dashboard"
          element={
            <AuthGate requireAuth={true}>
              <Layout>
                <DashboardPage />
              </Layout>
            </AuthGate>
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </ToastProvider>
  );
}
