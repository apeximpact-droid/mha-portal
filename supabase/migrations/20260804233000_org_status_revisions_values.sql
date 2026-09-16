-- Adds Revisions Requested / Revisions Submitted to the partner-facing
-- status enum (materials.status and material_org_status.status both use
-- this type). Must run as standalone statements, each in its own
-- transaction -- a new enum value can't be used in the same transaction
-- that adds it.
alter type material_status add value if not exists 'Revisions Requested';
alter type material_status add value if not exists 'Revisions Submitted';
alter type material_status add value if not exists 'Approved For Use';
