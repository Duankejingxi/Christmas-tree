-- 圣诞树共享功能：在 Supabase 控制台 → SQL Editor 里整段粘贴运行（可重复运行）

create extension if not exists pgcrypto with schema extensions;

-- 1) 树
create table if not exists public.trees (
  id          text primary key check (char_length(id) between 6 and 16),
  owner_name  text not null check (char_length(owner_name) between 1 and 16),
  created_at  timestamptz not null default now()
);
-- 主人密钥的哈希：只有知道密钥的人（创建者的浏览器）才能以「主人」身份挂照片
alter table public.trees add column if not exists owner_key_hash text;
-- 圣诞树颜色主题
alter table public.trees add column if not exists theme text not null default 'ice';
alter table public.trees drop constraint if exists trees_theme_chk;
alter table public.trees add constraint trees_theme_chk check (theme in ('ice', 'gold', 'pink'));

-- 2) 照片
create table if not exists public.photos (
  id          uuid primary key default gen_random_uuid(),
  tree_id     text not null references public.trees(id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 1 and 16),
  path        text not null check (char_length(path) < 200),
  created_at  timestamptz not null default now()
);
alter table public.photos add column if not exists is_owner  boolean not null default false;
alter table public.photos add column if not exists message   text;
alter table public.photos add column if not exists owner_key text; -- 只在插入时校验用，触发器会清空
alter table public.photos drop constraint if exists photos_message_len;
alter table public.photos add constraint photos_message_len check (message is null or char_length(message) <= 60);
create index if not exists photos_tree_idx on public.photos (tree_id, created_at);

-- 3) 行级权限：任何人可以读、可以新增；不能修改、不能删除
alter table public.trees  enable row level security;
alter table public.photos enable row level security;
drop policy if exists "trees read"    on public.trees;
drop policy if exists "trees insert"  on public.trees;
drop policy if exists "photos read"   on public.photos;
drop policy if exists "photos insert" on public.photos;
create policy "trees read"    on public.trees  for select using (true);
create policy "trees insert"  on public.trees  for insert with check (true);
create policy "photos read"   on public.photos for select using (true);
create policy "photos insert" on public.photos for insert with check (true);

-- 4) 规则：主人最多 10 张（需密钥），朋友不限（安全上限 500）；并发安全
create or replace function public.limit_photos() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  key_hash text;
begin
  perform pg_advisory_xact_lock(hashtext(new.tree_id));
  if new.path not like new.tree_id || '/%' then
    raise exception 'bad_path';
  end if;
  if new.is_owner then
    select owner_key_hash into key_hash from public.trees where id = new.tree_id;
    if new.owner_key is null or key_hash is null
       or encode(extensions.digest(new.owner_key, 'sha256'), 'hex') <> key_hash then
      raise exception 'bad_owner';
    end if;
    if (select count(*) from public.photos where tree_id = new.tree_id and is_owner) >= 10 then
      raise exception 'tree_full';
    end if;
  else
    -- 同一棵树上朋友的昵称不能重复，也不能和主人同名（不区分大小写、忽略首尾空格）
    if exists (select 1 from public.photos where tree_id = new.tree_id and not is_owner
                 and lower(btrim(nickname)) = lower(btrim(new.nickname)))
       or exists (select 1 from public.trees where id = new.tree_id
                 and lower(btrim(owner_name)) = lower(btrim(new.nickname))) then
      raise exception 'nickname_taken';
    end if;
    -- 朋友人数不限（每人一张由前端控制），这里只设一个防刷的安全上限
    if (select count(*) from public.photos where tree_id = new.tree_id and not is_owner) >= 500 then
      raise exception 'tree_full';
    end if;
  end if;
  new.owner_key := null;
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

-- 6) 表权限：只允许读和新增（新项目默认不再自动授权）
revoke all on public.trees, public.photos from anon, authenticated;
grant select, insert on public.trees, public.photos to anon, authenticated;

-- 7) 旧版本创建的树没有主人密钥：允许（仅一次）补设，之后才能以主人身份加照片
create or replace function public.claim_tree(p_id text, p_hash text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_hash is null or char_length(p_hash) <> 64 then return false; end if;
  update public.trees set owner_key_hash = p_hash where id = p_id and owner_key_hash is null;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.claim_tree(text, text) from public;
grant execute on function public.claim_tree(text, text) to anon, authenticated;

-- 8) 来源：这棵树是从哪棵树的分享链接过来的（用于后台统计传播效果）
alter table public.trees add column if not exists from_tree text;
alter table public.trees drop constraint if exists trees_from_chk;
alter table public.trees add constraint trees_from_chk check (from_tree is null or char_length(from_tree) between 6 and 16);

-- 9) 主人删除朋友的照片：必须出示主人密钥（只保存在种树的那个浏览器里）
--    删除后把图片路径记进 photo_trash，方便之后清理存储里的文件
create table if not exists public.photo_trash (
  path text primary key,
  deleted_at timestamptz not null default now()
);
alter table public.photo_trash enable row level security;
revoke all on public.photo_trash from anon, authenticated;

create or replace function public.delete_photo(p_tree_id text, p_photo_id uuid, p_owner_key text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare
  key_hash text;
  v_path text;
begin
  select owner_key_hash into key_hash from public.trees where id = p_tree_id;
  if key_hash is null or p_owner_key is null
     or encode(extensions.digest(p_owner_key, 'sha256'), 'hex') <> key_hash then
    raise exception 'bad_owner';
  end if;
  delete from public.photos
   where id = p_photo_id and tree_id = p_tree_id and not is_owner
   returning path into v_path;
  if v_path is null then return false; end if;
  insert into public.photo_trash(path) values (v_path) on conflict do nothing;
  return true;
end $$;
revoke all on function public.delete_photo(text, uuid, text) from public;
grant execute on function public.delete_photo(text, uuid, text) to anon, authenticated;
