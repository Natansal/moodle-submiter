import Boom from '@hapi/boom';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { NextFunction, Request, Response } from 'express';
import ws from 'ws';

type AuthedRequest = Request & { userId?: string; userEmail?: string };

let supabaseSingleton: SupabaseClient | undefined;

function getSupabase(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw Boom.internal('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  if (!supabaseSingleton) {
    supabaseSingleton = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: ws as unknown as never },
    });
  }
  return supabaseSingleton;
}

export async function authMiddleware(req: AuthedRequest, _res: Response, next: NextFunction) {
  try {
    const supabase = getSupabase();
    const header = req.get('authorization');
    const tokenFromHeader =
      header && header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
    const token = tokenFromHeader || (req.query['access_token'] as string | undefined);
    if (!token) throw Boom.unauthorized('Missing bearer token');
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      throw Boom.unauthorized('Invalid access token');
    }

    req.userId = data.user.id;
    req.userEmail = data.user.email ?? undefined;
    next();
  } catch (error) {
    next(Boom.isBoom(error) ? error : Boom.unauthorized('Authentication failed'));
  }
}

export type { AuthedRequest };
