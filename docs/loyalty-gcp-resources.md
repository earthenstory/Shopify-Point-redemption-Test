# Loyalty GCP Resources

Created in the existing Earthen Story automation project on 2026-06-21.

## Project

- Project ID: `es-automation-2026`
- Project name: `Earthenstory Automation`
- Primary region for loyalty resources: `asia-south1`

## Cloud SQL

- Instance: `earthen-loyalty-postgres`
- Connection name: `es-automation-2026:asia-south1:earthen-loyalty-postgres`
- Database version: `POSTGRES_16`
- Edition: Enterprise
- Tier: `db-g1-small`
- Availability: zonal
- Database: `earthen_loyalty`
- App database user: `loyalty_app`
- Backups: enabled
- Point-in-time recovery: enabled
- Deletion protection: enabled
- Labels: `app=loyalty`, `store=earthen-story`, `env=prod`

The initial Prisma baseline migration has been applied to the live database:

- `apps/earthen-loyalty-app/prisma/migrations/20260621191500_init_loyalty_schema/migration.sql`

## Secret Manager

- `earthen-loyalty-database-url`
- `earthen-loyalty-db-password`

Do not copy secret values into repo files. Cloud Run should read `DATABASE_URL` from `earthen-loyalty-database-url`.

## Service Account

- `earthen-loyalty-runner@es-automation-2026.iam.gserviceaccount.com`

Granted:

- `roles/cloudsql.client` on project `es-automation-2026`
- `roles/secretmanager.secretAccessor` on the two loyalty secrets

## Network Note

The database was migrated through a temporary authorized network entry for the local machine IP, then the authorized networks list was cleared after migration. Cloud Run should connect through the Cloud SQL integration using the instance connection name rather than opening broad database access.
