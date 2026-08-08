// Shared auth resolution for the wallet API routes: session user →
// profile → account_id + account_role. Kept out of the routes so the
// four of them don't each re-implement the lookup.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export interface WalletCaller {
  userId: string
  accountId: string
  role: 'owner' | 'admin' | 'agent' | 'viewer'
}

/** Resolve the calling member, or a ready-to-return error response. */
export async function resolveWalletCaller(): Promise<
  { caller: WalletCaller; error?: never } | { caller?: never; error: NextResponse }
> {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!profile?.account_id) {
    return {
      error: NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      ),
    }
  }

  return {
    caller: {
      userId: user.id,
      accountId: profile.account_id as string,
      role: (profile.account_role ?? 'viewer') as WalletCaller['role'],
    },
  }
}

export function requireRole(
  caller: WalletCaller,
  allowed: WalletCaller['role'][],
): NextResponse | null {
  if (!allowed.includes(caller.role)) {
    return NextResponse.json(
      { error: 'You do not have permission to do this.' },
      { status: 403 },
    )
  }
  return null
}
