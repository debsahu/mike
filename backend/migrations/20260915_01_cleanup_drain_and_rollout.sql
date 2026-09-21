-- Migration date: 2026-09-15
-- Three changes to the durable-queue contract, all re-runnable:
--
--   1. claim_db_jobs gains an optional kind filter so the document.cleanup
--      handler can coalesce its siblings into one pass instead of draining
--      them five per poll tick.
--   2. Reviving a `failed` cleanup row now respects run_at and pushes it
--      forward on every claim. Without a gate, a runner that cannot execute
--      the kind (the migration-before-code half of a rollout) re-claimed the
--      same rows in a hot loop and starved every other kind.
--   3. document_lifecycle_version() lets the backend prove at boot that the
--      lifecycle RPCs it depends on are actually installed, so the
--      code-before-migration half of a rollout stops the process instead of
--      silently leaking storage objects.

-- Kind-scoped claim scan for the coalescing handler.
create index if not exists db_jobs_pending_kind_idx
  on public.db_jobs (kind, run_at)
  where status = 'pending';

-- The 2-argument signature is replaced rather than overloaded: Postgres
-- cannot resolve claim_db_jobs(5, 600) when both a 2-arg and a 3-arg
-- (defaulted) candidate exist. Dropping first keeps the call site that an
-- older backend still uses working, because it binds to the default.
drop function if exists public.claim_db_jobs(integer, integer);

create or replace function public.claim_db_jobs(
  p_limit integer default 5,
  p_stale_seconds integer default 600,
  p_kind text default null
)
returns setof public.db_jobs
language sql set search_path = ''
as $$
  with abandoned as (
    update public.db_jobs
       set status = 'failed',
           finished_at = now(),
           last_error = coalesce(
             last_error,
             'abandoned: worker died mid-run and attempts are exhausted'
           )
     where status = 'running'
       and claimed_at < now() - make_interval(secs => p_stale_seconds)
       and attempts >= max_attempts
       and kind not in ('storage.cleanup', 'document.cleanup')
    returning id
  ), candidates as (
    select id
      from public.db_jobs
     where (p_kind is null or kind = p_kind)
       and ((status = 'pending' and run_at <= now())
        -- Cleanup intents are retried forever, but politely: a revived
        -- `failed` row waits for its own run_at like everything else.
        or (status = 'failed'
            and kind in ('storage.cleanup', 'document.cleanup')
            and run_at <= now())
        or (status = 'running'
            and claimed_at < now() - make_interval(secs => p_stale_seconds)
            and (
              attempts < max_attempts
              or kind in ('storage.cleanup', 'document.cleanup')
            )))
     order by run_at
     limit p_limit
       for update skip locked
  )
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         finished_at = null,
         attempts = case
           when j.kind in ('storage.cleanup', 'document.cleanup')
             then least(j.attempts::bigint + 1, 2147483647)::integer
           else j.attempts + 1
         end,
         max_attempts = case
           when j.kind in ('storage.cleanup', 'document.cleanup')
             then 2147483647
           else j.max_attempts
         end,
         -- Back the revived row off before running it, so a claimant that
         -- fails the row back to `failed` (an old runner rejecting an unknown
         -- kind) cannot re-enter this branch on the next tick.
         run_at = case
           when j.status = 'failed'
             and j.kind in ('storage.cleanup', 'document.cleanup')
             then now() + least(
               interval '10 minutes',
               make_interval(secs => 30 * least(j.attempts::bigint + 1, 20))
             )
           else j.run_at
         end,
         dedupe_key = case
           when j.status = 'failed'
             and j.kind in ('storage.cleanup', 'document.cleanup')
             then null
           else j.dedupe_key
         end
    from candidates c
   where j.id = c.id
  returning j.*;
$$;
revoke all on function public.claim_db_jobs(integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_db_jobs(integer, integer, text)
  to service_role;

-- Same revive gate on the Redis delivery path.
create or replace function public.claim_db_job(
  p_id uuid,
  p_stale_seconds integer default 600
)
returns setof public.db_jobs
language sql set search_path = ''
as $$
  update public.db_jobs j
     set status = 'running',
         claimed_at = now(),
         finished_at = null,
         attempts = case
           when j.kind in ('storage.cleanup', 'document.cleanup')
             then least(j.attempts::bigint + 1, 2147483647)::integer
           else j.attempts + 1
         end,
         max_attempts = case
           when j.kind in ('storage.cleanup', 'document.cleanup')
             then 2147483647
           else j.max_attempts
         end,
         run_at = case
           when j.status = 'failed'
             and j.kind in ('storage.cleanup', 'document.cleanup')
             then now() + least(
               interval '10 minutes',
               make_interval(secs => 30 * least(j.attempts::bigint + 1, 20))
             )
           else j.run_at
         end,
         dedupe_key = case
           when j.status = 'failed'
             and j.kind in ('storage.cleanup', 'document.cleanup')
             then null
           else j.dedupe_key
         end
   where j.id = p_id
     and ((j.status = 'pending' and j.run_at <= now())
       or (j.status = 'failed'
           and j.kind in ('storage.cleanup', 'document.cleanup')
           and j.run_at <= now())
       or (j.status = 'running'
           and j.claimed_at < now() - make_interval(secs => p_stale_seconds)
           and (
             j.attempts < j.max_attempts
             or j.kind in ('storage.cleanup', 'document.cleanup')
           )))
  returning j.*;
$$;
revoke all on function public.claim_db_job(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_db_job(uuid, integer)
  to service_role;

-- Rollout probe. Returns 1 only when every lifecycle RPC the documents module
-- calls exists; 0 when the 20260914_01 migration has not been applied yet.
-- A missing function makes the RPC itself unresolvable (PostgREST PGRST202),
-- which the backend treats the same way — see lib/dbq/lifecycleGuard.ts.
create or replace function public.document_lifecycle_version()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case when (
    select count(distinct p.proname)
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'create_document_version',
         'create_document_versions',
         'activate_document_version',
         'delete_document_version',
         'queue_document_version_cleanup'
       )
  ) = 5 then 1 else 0 end;
$$;
revoke all on function public.document_lifecycle_version()
  from public, anon, authenticated;
grant execute on function public.document_lifecycle_version() to service_role;

-- PostgREST caches the function signatures it exposes; the dropped 2-argument
-- claim would otherwise stay in its cache until the next reload.
notify pgrst, 'reload schema';
