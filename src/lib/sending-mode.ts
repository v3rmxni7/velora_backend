import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError } from './errors.js';

// The org-wide sending master switches (organizations.sending_enabled / sending_dry_run).
// Safe by default (false / true): nothing can perform a live send until BOTH are flipped.
// This is the single central gate the whole Phase 2 send engine respects.
export interface SendingMode {
  sendingEnabled: boolean;
  dryRun: boolean;
}

/** Read the caller-org's sending flags. Pass the user-scoped (RLS) or service-role client. */
export async function getSendingMode(
  db: SupabaseClient,
  organizationId: string,
): Promise<SendingMode> {
  const { data, error } = await db
    .from('organizations')
    .select('sending_enabled, sending_dry_run')
    .eq('id', organizationId)
    .single();
  if (error) throw error;
  return {
    sendingEnabled: data.sending_enabled === true,
    dryRun: data.sending_dry_run !== false, // default-safe: anything but an explicit false is dry-run
  };
}

/**
 * The chokepoint guard (enforced at the real-send step, Slice 2.5). A live send is allowed
 * ONLY when sending is explicitly enabled AND dry-run is explicitly off — every other
 * combination throws, so the safe defaults make a real send structurally impossible until
 * both flags are deliberately flipped.
 */
export function assertLiveSendAllowed(mode: SendingMode): void {
  if (!mode.sendingEnabled || mode.dryRun) {
    throw new AppError('Live sending is disabled for this organization', {
      code: 'sending_disabled',
      statusCode: 409,
    });
  }
}
