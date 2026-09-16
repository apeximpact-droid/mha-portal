-- Superseded by making Owned By itself a required, single-select Direct
-- Apex Client picker on materials -- the separate multi-tag checkbox list
-- this table backed is being removed from the admin UI, and no material
-- ever had a real tag recorded, so it's safe to drop outright rather than
-- leave a genuinely unused table around.
drop table if exists material_direct_client_tags;
