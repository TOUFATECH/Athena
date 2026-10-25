create extension if not exists pg_cron;
select cron.schedule('athena-run', '* * * * *', 'select athena.run_due()');
