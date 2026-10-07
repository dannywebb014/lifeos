-- Runs send-reminders once a minute. Replace <CRON_SECRET> with the function's
-- CRON_SECRET (a Supabase secret) before running; the real value isn't kept in
-- this repo. Run in the Supabase SQL editor after notifications.sql.
-- To stop notifications everywhere: select cron.unschedule('send-reminders');

select cron.unschedule('send-reminders') where exists (select 1 from cron.job where jobname = 'send-reminders');
select cron.schedule('send-reminders', '* * * * *', $$
  select net.http_post(
    url := 'https://tvpmeysctvlhjyhotfyk.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body := '{}'::jsonb
  );
$$);
