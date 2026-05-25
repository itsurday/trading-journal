-- TradeLog — Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query

-- 1. Trades table
create table if not exists public.trades (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  ticker       text not null,
  direction    text not null check (direction in ('LONG','SHORT')),
  entry_price  numeric(12,4) not null,
  exit_price   numeric(12,4),
  quantity     integer not null,
  entry_date   date not null,
  exit_date    date,
  status       text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  setup        text default 'Breakout',
  emotion      text default 'Neutral',
  notes        text default '',
  tags         text[] default '{}',
  imported     boolean default false,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- 2. Auto-update updated_at
create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trades_updated_at
  before update on public.trades
  for each row execute procedure public.handle_updated_at();

-- 3. Row Level Security
alter table public.trades enable row level security;

create policy "Users can view own trades"
  on public.trades for select
  using (auth.uid() = user_id);

create policy "Users can insert own trades"
  on public.trades for insert
  with check (auth.uid() = user_id);

create policy "Users can update own trades"
  on public.trades for update
  using (auth.uid() = user_id);

create policy "Users can delete own trades"
  on public.trades for delete
  using (auth.uid() = user_id);

-- 4. Indexes
create index if not exists trades_user_id_idx on public.trades(user_id);
create index if not exists trades_entry_date_idx on public.trades(entry_date desc);
