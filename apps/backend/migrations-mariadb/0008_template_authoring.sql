ALTER TABLE template_versions ADD COLUMN source_hash varchar(256);
ALTER TABLE template_versions ADD COLUMN recipe_json longtext;
