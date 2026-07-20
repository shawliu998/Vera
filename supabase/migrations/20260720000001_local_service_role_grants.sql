-- Supabase CLI projects created after the auto-expose default changed do not
-- automatically grant newly created application tables to service_role.
-- Mike's browser remains auth-only; all application data still goes through
-- the backend after JWT verification.

grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges for role postgres in schema public
  grant all privileges on tables to service_role;
alter default privileges for role postgres in schema public
  grant all privileges on sequences to service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;
