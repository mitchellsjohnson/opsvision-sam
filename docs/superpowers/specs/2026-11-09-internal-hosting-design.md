# OpsVision — Internal Hosting Mode

Status: approved by the maintainer
Date: 2026-11-09
Extends: `2026-10-30-opsvision-design.md` (main spec) §4, §10.2, §10.2.1 and §10.4. Where they disagree, this document wins.

## 1. Intent

The first adopter already runs other internal apps on AWS. Each one is reachable only from the corporate network, signs employees in through the company identity provider, and deploys from a private repository. OpsVision adopts the same shape for the first adopter's deployment, which replaces the spec's planned CloudFront, API Gateway and WAF design for that deployment. The result has fewer moving parts and no network-team dependency, and it reuses sign-in and deploy machinery the company already operates.

## 2. Shape

- **One Lambda serves everything:** the API under `/v1/` plus `/healthz`, and the web app (static files embedded in the binary) for every other path, with an SPA fallback to `index.html`. API and app share one origin, so there is no CORS between them.
- **Internal Application Load Balancer** in an existing VPC, with HTTPS (ACM certificate) and HTTP redirected to HTTPS. Its security group admits only the corporate CIDR ranges. The hostname resolves to private addresses, so the app is reachable on the corporate network or VPN only. The Lambda runs outside the VPC and reaches DynamoDB, S3 and the identity provider directly.
- **Runtime web configuration:** the app reads `/config.json` (identity provider domain, client ID, audience) at startup, so the public build contains no deployment values.
- **Uploads:** browsers upload files with presigned PUTs straight to the uploads bucket, as today. The bucket's CORS allows only the app origin.
- **Data:** the DynamoDB single table is unchanged.

## 3. Single-organization sign-in

The main spec's multi-tenant model (one Auth0 Organization per tenant) stays the default. This mode adds a deployment option for an organization that runs its own instance with one tenant:

- The token comes from the company's existing Auth0 tenant and enterprise connection. Its `sub` must start with one of the configured **trusted subject prefixes**, for example the employee connection's prefix. Anything else is 403.
- Every trusted caller belongs to the one configured **tenant**. `org_id` is not required or consulted.
- **Email** comes from the token's email claim when present, else from the identity provider's `/userinfo` endpoint, cached per user until the token expires. No post-login action is needed.
- **First sign-in provisioning:**
  1. A pending invitation for the caller's verified email binds as today.
  2. Otherwise, an email listed in **bootstrap admins** becomes an admin.
  3. Otherwise, the caller gets the tenant's default role.
- Roles and scopes inside OpsVision work exactly as in the main spec.

## 4. Data loading

A command-line tool loads a bootstrap file (tenant, org model, scorecards, versions, templates) into the deployment's table. It can also import a legacy workbook with a saved template. An operator runs it once with their own cloud credentials. It reuses the dev server's bootstrap and import code, so a configuration that loads locally loads the same way in the cloud.

## 5. Where things live

- **Public repository:** the code above, plus a `make package` target that produces the Lambda deployment zip with the web app embedded. No deployment values.
- **Private deployment repository:** infrastructure as code, the deploy workflow, and the deployment's values (account, domain, identity provider client, CIDR ranges, admin emails). It builds a pinned commit of the public repository.
- **Infrastructure as code** in the private repository uses Terraform, following the company's existing internal apps. Versions are maintainer-supplied: Terraform `~> 1.11.4`, `hashicorp/aws ~> 5.74.0`, and commit-pinned GitHub Actions. The dependency-vetting service has no data for the provider or the actions.

## 6. Non-goals

- The public demo environment and its CloudFront and API Gateway design (main spec §10.2) are deferred. That shape stays in the main spec for a future public deployment.
- Auth0 Organizations and per-tenant enterprise connections are not used in this mode.

## 7. Constraints

- **Lambda response limit:** a load balancer returns at most 1 MB per Lambda response. API responses are gzip-compressed when the client accepts it, which browsers always do. A response that would still exceed the limit returns a clear 502 problem response instead of a truncated body.
- **Security headers on every app response:**
  - HSTS
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - a Content Security Policy that allows only self, the identity provider domain, and the uploads bucket origin
- **Caching:** hashed assets are cached as immutable; `index.html` and `/config.json` are not cached.
- **Never exposed:** the dev server's `/dev/*` endpoints and dev authentication are never reachable in the Lambda.
