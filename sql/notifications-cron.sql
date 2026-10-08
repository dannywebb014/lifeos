-- Runs send-reminders every 2 minutes (once a minute, with Realtime watching
-- the database too, wore out the free plan's small server on 2026-10-08). Replace <CRON_SECRET> with the function's
-- CRON_SECRET (a Supabase secret) before running; the real value isn't kept in
-- this repo. Run in the Supabase SQL editor after notifications.sql.
-- To stop notifications everywhere: select cron.unschedule('send-reminders');

select cron.unschedule('send-reminders') where exists (select 1 from cron.job where jobname = 'send-reminders');
select cron.schedule('send-reminders', '*/2 * * * *', $$
  select net.http_post(
    url := 'https://tvpmeysctvlhjyhotfyk.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body := '{}'::jsonb
  );
$$);
