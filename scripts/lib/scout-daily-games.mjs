// Node-facing entry point for the exact compiler that is deployed with the
// Scout Daily Game Edge Function. Keeping one source prevents browser/service
// scoring drift while the private model values remain server-only.
export * from '../../supabase/functions/_shared/scout-daily-games.mjs';
