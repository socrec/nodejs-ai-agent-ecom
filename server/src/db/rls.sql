-- Applied by seed.ts (admin connection) after drizzle-kit push. Idempotent.
grant usage on schema public to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;
grant usage, select on all sequences in schema public to app_user;

alter table orgs enable row level security;
alter table orgs force row level security;
drop policy if exists tenant_isolation on orgs;
create policy tenant_isolation on orgs
  using (id = current_setting('app.org_id', true));

do $$
declare t text;
begin
  foreach t in array array[
    'products','knowledge_chunks','carts','cart_items','orders','conversations',
    'messages','message_feedback','tickets','outbox','ai_usage'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_setting(''app.org_id'', true)) with check (org_id = current_setting(''app.org_id'', true))',
      t);
  end loop;
end $$;
