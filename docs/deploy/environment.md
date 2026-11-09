# API environment reference

The deployed API (`cmd/api`, an AWS Lambda function) reads all of its
configuration from environment variables. This page lists every one of them
and the rules it checks at startup. When a rule fails, the function logs the
reason and exits before serving any request, so a bad configuration shows up
as a failed cold start, not as wrong behaviour.

The values below (`example.us.auth0.com`, `ops.example.test`, `sample-co`)
are examples. Use your own.

## Modes

The variables group into modes:

- **Always**: every deployment sets these.
- **Single organization**: one organization runs its own instance and signs
  people in through its own identity provider connection. Setting
  `OPSVISION_TENANT_ID` turns it on. Without it the API is multi-tenant and
  picks the tenant from the token's `org_id`.
- **Web app**: `OPSVISION_SERVE_WEB=1` also serves the web app from the same
  function, usually behind an Application Load Balancer.

## Variables

### Always

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `OPSVISION_AUTH_MODE` | yes | none | Must be exactly `auth0`. Anything else, including unset, refuses to start. This is checked first. |
| `OPSVISION_EVENT_SOURCE` | no | `apigateway` | `apigateway` (API Gateway REST, proxy integration) or `alb` (Application Load Balancer; the target group must have multi-value headers enabled). Anything else refuses to start. |
| `TABLE_NAME` | yes | none | DynamoDB table, for example `opsvision-example`. |
| `UPLOADS_BUCKET` | yes | none | S3 bucket for uploaded workbooks and parsed change sets, for example `opsvision-example-uploads`. |
| `AUTH0_DOMAIN` | yes | none | Identity provider domain, for example `example.us.auth0.com`. Tokens must be issued by `https://<AUTH0_DOMAIN>/`, and their keys come from its JWKS. |
| `AUTH0_AUDIENCE` | yes | none | API audience the access tokens are issued for, for example `https://api.ops.example.test`. |
| `CLAIM_NAMESPACE` | no | `https://opsvision/` | Prefix of the email, name and email-verified claims in the token. |
| `ALLOWED_ORIGIN` | no | none | The one browser origin allowed by CORS, for example `https://ops.example.test`. Not needed when the web app is served from the same origin. Unset without the web app logs a warning. |
| `AWS_REGION` | no | set by Lambda | Used for the default `OPSVISION_UPLOADS_ORIGIN`. The AWS SDK also reads it and the usual AWS credential variables. |

### Single organization

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `OPSVISION_TENANT_ID` | to enable the mode | none | The one tenant every trusted caller belongs to, for example `sample-co`. It must match `tenant.id` in the bootstrap file (see below). |
| `OPSVISION_TRUSTED_SUB_PREFIXES` | with the mode | none | Comma-separated token `sub` prefixes allowed to sign in, each ending in `\|`, for example `oidc\|example-employees\|`. Any other `sub` gets 403. |
| `OPSVISION_BOOTSTRAP_ADMINS` | no | none | Comma-separated emails that become admins on their first sign-in, for example `admin@example.test`. Compared case-insensitively. |
| `OPSVISION_USERINFO_URL` | no | `https://<AUTH0_DOMAIN>/userinfo` | The identity provider's https `/userinfo` endpoint. |

### Web app

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `OPSVISION_SERVE_WEB` | no | off | `1` serves the embedded web app on every path except `/v1/...` and `/healthz`. `0` or unset serves the API only. Anything else refuses to start. |
| `OPSVISION_WEB_AUTH0_CLIENT_ID` | with `OPSVISION_SERVE_WEB=1` | none | The web app's client ID at the identity provider, for example `example-client-id`. |
| `OPSVISION_UPLOADS_ORIGIN` | no | `https://<UPLOADS_BUCKET>.s3.<AWS_REGION>.amazonaws.com` | The https origin browsers upload workbooks to; it goes into the web app's Content-Security-Policy. Scheme and host only, such as `https://s3.us-east-1.amazonaws.com`. |

## Startup refusals

The function refuses to start when:

- `OPSVISION_AUTH_MODE` is not exactly `auth0`.
- `OPSVISION_EVENT_SOURCE` is set to anything but `apigateway` or `alb`.
- `TABLE_NAME`, `UPLOADS_BUCKET`, `AUTH0_DOMAIN` or `AUTH0_AUDIENCE` is
  missing.
- `OPSVISION_TRUSTED_SUB_PREFIXES`, `OPSVISION_BOOTSTRAP_ADMINS` or
  `OPSVISION_USERINFO_URL` is set without `OPSVISION_TENANT_ID`.
- With `OPSVISION_TENANT_ID`:
  - it has leading or trailing spaces;
  - `OPSVISION_TRUSTED_SUB_PREFIXES` is missing, has an empty entry, or has an
    entry that does not end in `|`;
  - `OPSVISION_BOOTSTRAP_ADMINS` has an empty entry or an entry that is not an
    email address;
  - `OPSVISION_USERINFO_URL` is not an https URL.
- `OPSVISION_SERVE_WEB` is set to anything but `1` or `0`.
- `OPSVISION_WEB_AUTH0_CLIENT_ID` or `OPSVISION_UPLOADS_ORIGIN` is set without
  `OPSVISION_SERVE_WEB=1`.
- With `OPSVISION_SERVE_WEB=1`:
  - `OPSVISION_WEB_AUTH0_CLIENT_ID` is missing;
  - `OPSVISION_UPLOADS_ORIGIN` is not an https origin (it has a path, a
    trailing slash, a query, a port that is not a number, or another scheme);
  - `OPSVISION_UPLOADS_ORIGIN` and `AWS_REGION` are both unset.

Development sign-in and the `/dev/*` routes never exist in this function,
whatever the configuration.

## Single-organization notes

### The tenant ID must match the bootstrap file

The tenant is created by loading a bootstrap file (see
[loading-data.md](loading-data.md)). Its `tenant.id` must equal
`OPSVISION_TENANT_ID`. If no tenant with that ID exists in the table, every
sign-in gets 403 "tenant not provisioned", and the function logs the missing
tenant at error level. Leave `tenant.auth0OrgId` out of the file; the
organization in the token is ignored in this mode.

### The first admin

Nobody is an admin until someone signs in. The first admin comes from
`OPSVISION_BOOTSTRAP_ADMINS`: a listed email becomes an admin on that
person's first sign-in. After that:

- A pending invitation for the same email wins over the list, so the person
  gets the invitation's role.
- A later demotion in the app is kept; signing in again never re-elevates.
- A deleted membership comes back as admin on the next sign-in. To revoke a
  bootstrap admin, remove the email from the list as well.

Everyone else gets their invitation's role, or the tenant's default role.

### Emails and `/userinfo`

The email matters only on a person's first sign-in, to match invitations and
bootstrap admins. It comes from the token's email claim, or else from the
identity provider's `/userinfo` endpoint, called with the person's own access
token. Later sign-ins use the stored membership and make no `/userinfo` call.

Emails from the trusted connection count as verified: it is the
organization's own directory.

If `/userinfo` refuses the token (HTTP 401 or 403), sign-in fails with 503
`identity_misconfigured` and an error in the log. Usually the access token
lacks the `openid` scope. If `/userinfo` times out or fails in another way,
sign-in fails with 503 `identity_unavailable`; retrying later can succeed.

## Web app notes

### Bucket names containing dots

The default `OPSVISION_UPLOADS_ORIGIN` is the bucket's virtual-hosted
address, `https://<UPLOADS_BUCKET>.s3.<AWS_REGION>.amazonaws.com`. A bucket
name containing dots (for example `uploads.ops.example.test`) does not match
the S3 certificate at that address, so uploads use the path-style address
`https://s3.<AWS_REGION>.amazonaws.com/<UPLOADS_BUCKET>/...` instead. Set
`OPSVISION_UPLOADS_ORIGIN` to that origin, for example:

```sh
OPSVISION_UPLOADS_ORIGIN=https://s3.us-east-1.amazonaws.com
```

Otherwise the browser blocks the upload under the Content-Security-Policy.

## Example

A single-organization deployment serving the web app behind a load balancer:

```sh
OPSVISION_AUTH_MODE=auth0
OPSVISION_EVENT_SOURCE=alb
TABLE_NAME=opsvision-example
UPLOADS_BUCKET=opsvision-example-uploads
AUTH0_DOMAIN=example.us.auth0.com
AUTH0_AUDIENCE=https://api.ops.example.test
OPSVISION_TENANT_ID=sample-co
OPSVISION_TRUSTED_SUB_PREFIXES=oidc|example-employees|
OPSVISION_BOOTSTRAP_ADMINS=admin@example.test
OPSVISION_SERVE_WEB=1
OPSVISION_WEB_AUTH0_CLIENT_ID=example-client-id
```
