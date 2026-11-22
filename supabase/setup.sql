-- 圣诞树共享功能：在 Supabase 控制台 → SQL Editor 里整段粘贴运行一次即可

-- 1) 树
create table if not exists public.trees (
  id          text primary key check (char_length(id) between 6 and 16),
  owner_name  text not null check (char_length(owner_name) between 1 and 16),
  created_at  timestamptz not null default now()
);

-- 2) 朋友挂上去的照片
create table if not exists public.photos (
  id          uuid primary key default gen_random_uuid(),
  tree_id     text not null references public.trees(id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 1 and 16),
  path        text not null check (char_length(path) < 200),
  created_at  timestamptz not null default now()
);
create index if not exists photos_tree_idx on public.photos (tree_id, created_at);

-- 3) 权限：任何人可以读、可以新增；不能修改、不能删除
alter table public.trees  enable row level security;
alter table public.photos enable row level security;

drop policy if exists "trees read"   on public.trees;
drop policy if exists "trees insert" on public.trees;
drop policy if exists "photos read"  on public.photos;
drop policy if exists "photos insert" on public.photos;
create policy "trees read"    on public.trees  for select using (true);
create policy "trees insert"  on public.trees  for insert with check (true);
create policy "photos read"   on public.photos for select using (true);
create policy "photos insert" on public.photos for insert with check (true);

-- 4) 每棵树最多 10 张照片（并发安全）
create or replace function public.limit_photos() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.tree_id));
  if new.path not like new.tree_id || '/%' then
    raise exception 'bad_path';
  end if;
  if (select count(*) from public.photos where tree_id = new.tree_id) >= 10 then
    raise exception 'tree_full';
  end if;
  return new;
end $$;

drop trigger if exists photos_limit on public.photos;
create trigger photos_limit before insert on public.photos
  for each row execute function public.limit_photos();

-- 5) 图片存储桶：公开可读，单张最大 3MB，只允许图片
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "photos upload" on storage.objects;
create policy "photos upload" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'photos');
