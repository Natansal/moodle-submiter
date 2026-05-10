import { supabase } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';

export function LogoutButton() {
  const navigate = useNavigate();

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate('/login');
  }

  return (
    <button className="btn-secondary text-xs" onClick={handleLogout}>
      Sign out
    </button>
  );
}
