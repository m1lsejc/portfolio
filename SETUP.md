# Shared portfolio storage setup

The portfolio is a static site. Supabase provides shared data, uploaded file storage, and password-protected editing.

## 1. Create the Supabase project

Create a project at [supabase.com](https://supabase.com). In **Project Settings → API**, copy the project URL and the **publishable/anon** key. Do not put a `service_role` key in this site.

## 2. Create the database table and access rules

In **SQL Editor**, run:

```sql
create table if not exists public.portfolio (
  id integer primary key check (id = 1),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.portfolio enable row level security;
grant select on public.portfolio to anon, authenticated;
grant insert, update on public.portfolio to authenticated;

create policy "Anyone can view the published portfolio"
  on public.portfolio for select
  to anon, authenticated
  using (id = 1);

create policy "Signed-in editors can publish the portfolio"
  on public.portfolio for insert
  to authenticated
  with check (id = 1);

create policy "Signed-in editors can update the portfolio"
  on public.portfolio for update
  to authenticated
  using (id = 1)
  with check (id = 1);
```

## 3. Create the public file bucket

In **Storage**, create a bucket named `portfolio-files` and enable **Public bucket**. Then run these policies in **SQL Editor**:

```sql
create policy "Anyone can view portfolio files"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'portfolio-files');

create policy "Signed-in editors can upload portfolio files"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'portfolio-files');

create policy "Signed-in editors can update portfolio files"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'portfolio-files')
  with check (bucket_id = 'portfolio-files');

create policy "Signed-in editors can delete portfolio files"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'portfolio-files');
```

## 4. Create the editor account

In **Authentication → Users**, add the editor's email and password. Disable public sign-ups in **Authentication → Settings** so visitors cannot create editor accounts. The editor page only supports signing in.

## 5. Check the site's public Supabase config

The provided Supabase Project URL and publishable key are configured in `config.js`. If you use a different project, replace these values:

```js
window.PORTFOLIO_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_ID.supabase.co",
  supabaseAnonKey: "YOUR_PUBLISHABLE_OR_ANON_KEY",
  storageBucket: "portfolio-files"
};
```

The publishable/anon key is intended for the browser; database and storage access are restricted by the policies above. Never use a `service_role` key here.

Once the SQL setup, bucket, and editor account are ready, commit and push the project to GitHub so Vercel deploys the configuration. Changes are saved to Supabase and available to viewers on any device. Already-open viewer tabs check for updates every 15 seconds.

## 6. First login and migrate existing browser edits

Open `/editor.html` on the deployed site and sign in. If this browser has older local edits and the cloud has no portfolio yet, use **Import this browser's data into the cloud**. This replaces the cloud portfolio with this browser's copy. Other browsers' local data cannot be discovered or merged automatically.

After the first cloud save, the viewer at `/` reads the published portfolio from Supabase. New PDF and image uploads go into the public bucket and can be viewed by visitors. Editing requires the editor account.
