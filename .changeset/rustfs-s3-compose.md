---
'@caelestis/backend': patch
---

Run RustFS in the Compose S3 example, since MinIO no longer publishes its images. Existing stacks copy their MinIO data over on the next start and keep the old volume untouched until you delete it.
