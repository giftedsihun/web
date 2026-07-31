-- User-owned Atlas data is isolated with RLS; service-role credentials never reach Electron.
create table if not exists public.atlas_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.atlas_bookmarks (
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null check (char_length(url) between 1 and 2048),
  title text not null default '' check (char_length(title) <= 300),
  created_at timestamptz not null default now(),
  primary key (user_id, url)
);

create table if not exists public.atlas_reading_list (
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null check (char_length(url) between 1 and 2048),
  title text not null default '' check (char_length(title) <= 300),
  saved_at timestamptz not null default now(),
  primary key (user_id, url)
);

create table if not exists public.atlas_saved_searches (
  user_id uuid not null references auth.users(id) on delete cascade,
  query text not null check (char_length(query) between 1 and 300),
  saved_at timestamptz not null default now(),
  primary key (user_id, query)
);

alter table public.atlas_profiles enable row level security;
alter table public.atlas_bookmarks enable row level security;
alter table public.atlas_reading_list enable row level security;
alter table public.atlas_saved_searches enable row level security;

drop policy if exists "Users manage their Atlas profile" on public.atlas_profiles;
create policy "Users manage their Atlas profile" on public.atlas_profiles for all using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists "Users manage their Atlas bookmarks" on public.atlas_bookmarks;
create policy "Users manage their Atlas bookmarks" on public.atlas_bookmarks for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users manage their Atlas reading list" on public.atlas_reading_list;
create policy "Users manage their Atlas reading list" on public.atlas_reading_list for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "Users manage their Atlas saved searches" on public.atlas_saved_searches;
create policy "Users manage their Atlas saved searches" on public.atlas_saved_searches for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.handle_atlas_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.atlas_profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_atlas_profile on auth.users;
create trigger on_auth_user_created_atlas_profile after insert on auth.users for each row execute procedure public.handle_atlas_profile();
