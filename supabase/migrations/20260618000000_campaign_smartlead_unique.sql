-- 0012 campaign_smartlead_unique.sql — Phase 2 Hardening Slice 2.8 (audit finding M4).
-- The Smartlead webhook resolves a Velora org/tenant by campaigns.smartlead_campaign_id via
-- .maybeSingle(); without a uniqueness guarantee a duplicate would 500 and silently drop ALL
-- inbound reply/bounce/unsubscribe processing (and the suppression writes those drive). A partial
-- unique index makes that resolution provably at-most-one. Partial (NULL excluded) because most
-- campaigns never go live and leave the column NULL — NULLs must stay non-unique.
create unique index campaigns_smartlead_campaign_id_key
  on public.campaigns (smartlead_campaign_id)
  where smartlead_campaign_id is not null;
