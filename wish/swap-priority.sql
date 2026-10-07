-- Run once, 2026-10-07: wish. now uses red for "really want" and green for
-- "not fussed", matching the traffic light on tasks. This swaps the stored
-- values so every item keeps its meaning. Running it again swaps them back.
update public.wish_items
   set priority = case priority when 'green' then 'red' when 'red' then 'green' end
 where priority in ('green', 'red');
