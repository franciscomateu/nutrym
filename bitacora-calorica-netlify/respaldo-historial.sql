-- Historial automático de tus datos en Supabase (ejecutar UNA vez en SQL Editor).
-- Guarda una copia del dato anterior cada vez que se sobrescribe (máx. 1 cada 30 min por usuario y dominio),
-- y conserva 45 días. Si algo se pisa, se puede volver a una versión previa.
create table if not exists user_data_history (
  id bigserial primary key,
  user_id uuid not null,
  domain text not null,
  data jsonb not null,
  original_updated_at timestamptz,
  archived_at timestamptz not null default now()
);
alter table user_data_history enable row level security;  -- sin políticas: solo accesible desde el panel / service role
create index if not exists idx_udh_lookup on user_data_history (user_id, domain, archived_at desc);
create index if not exists idx_udh_archived on user_data_history (archived_at);

create or replace function archive_user_data() returns trigger
language plpgsql security definer as $$
begin
  if not exists (
    select 1 from user_data_history h
    where h.user_id = old.user_id and h.domain = old.domain and h.archived_at > now() - interval '30 minutes'
  ) then
    insert into user_data_history (user_id, domain, data, original_updated_at)
    values (old.user_id, old.domain, old.data, old.updated_at);
    delete from user_data_history where archived_at < now() - interval '45 days';
  end if;
  return new;
end $$;

drop trigger if exists trg_archive_user_data on user_data;
create trigger trg_archive_user_data before update on user_data
  for each row execute function archive_user_data();

-- Para ver versiones previas de tu alimentación:
-- select id, archived_at, original_updated_at, jsonb_object_keys(data->'days') as dias from user_data_history where domain='nutrition' order by archived_at desc;
-- Para restaurar una versión (reemplazar ID):
-- update user_data set data = (select data from user_data_history where id = ID) where domain='nutrition' and user_id = (select user_id from user_data_history where id = ID);
