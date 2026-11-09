.PHONY: gen gen-check test lint dev denylist package

OAPI_SPEC   := ../openapi/openapi.yaml
OAPI_CONFIG := internal/httpapi/oapi-config.yaml
OAPI_OUT    := internal/httpapi/gen.go

WEB_SCHEMA := web/src/api/schema.d.ts

# Local-only signing secret for `make dev` (the dev server needs 32+ bytes).
DEV_SECRET ?= opsvision-local-dev-secret-not-for-production

# gen regenerates code from openapi/openapi.yaml: the Go server types and the
# TypeScript API types (web/src/api/schema.d.ts, needs `npm --prefix web ci`).
gen:
	cd api && go tool oapi-codegen -config $(OAPI_CONFIG) $(OAPI_SPEC)
	npm --prefix web run gen

# gen-check fails if the committed generated code (Go and TypeScript) differs
# from what the spec produces. It regenerates into a temp file (the config's output path wins
# over -o, so it uses a temp copy of the config) and diffs. The check itself
# exits 1 on drift; make reports a failed recipe as exit 2.
gen-check:
	@dir=$$(mktemp -d) && \
	trap 'rm -rf "$$dir"' EXIT && \
	sed "s|^output:.*|output: $$dir/gen.go|" api/$(OAPI_CONFIG) > "$$dir/config.yaml" && \
	(cd api && go tool oapi-codegen -config "$$dir/config.yaml" $(OAPI_SPEC)) && \
	if diff -u api/$(OAPI_OUT) "$$dir/gen.go"; then \
		echo 'gen-check: generated code is up to date'; \
	else \
		echo 'gen-check: api/$(OAPI_OUT) is out of date; run `make gen`' >&2; \
		exit 1; \
	fi && \
	(cd web && npx --no-install openapi-typescript ../openapi/openapi.yaml -o "$$dir/schema.d.ts" >/dev/null) && \
	if diff -u $(WEB_SCHEMA) "$$dir/schema.d.ts"; then \
		echo 'gen-check: $(WEB_SCHEMA) is up to date'; \
	else \
		echo 'gen-check: $(WEB_SCHEMA) is out of date; run `make gen`' >&2; \
		exit 1; \
	fi

test:
	@echo 'test: not yet configured'

lint:
	@echo 'lint: not yet configured'

# dev runs the API dev server (demo data, dev auth, 127.0.0.1:8080) and the web
# app (http://localhost:5173) together; Ctrl-C stops both. Sign in as any demo
# user from the login page. Run `npm --prefix web ci` first.
dev:
	@trap 'kill 0' INT TERM EXIT; \
	(cd api && go run ./cmd/devserver -seed demo -auth dev -dev-secret "$(DEV_SECRET)") & \
	npm --prefix web run dev; \
	wait

denylist:
	bash scripts/check-denylist.sh

WEBUI_DIST := api/internal/webui/dist
LAMBDA_ZIP := build/opsvision-api-lambda.zip

# package builds the Lambda deployment zip (build/opsvision-api-lambda.zip):
# the API for linux/arm64 as `bootstrap`, with the web app (web/dist) embedded.
# The web build is copied over the placeholder in $(WEBUI_DIST) only while the
# binary compiles; the placeholder is put back afterwards, even on failure.
# Needs Node, Go and zip. The build holds no deployment values: they come from
# the function's environment at runtime (see api/cmd/api).
package:
	npm --prefix web ci
	npm --prefix web run build
	@rm -rf build && mkdir -p build
	cp $(WEBUI_DIST)/index.html build/placeholder.html
	@trap 'rm -rf $(WEBUI_DIST) && mkdir -p $(WEBUI_DIST) && mv build/placeholder.html $(WEBUI_DIST)/index.html' EXIT && \
	cp -R web/dist/. $(WEBUI_DIST)/ && \
	(cd api && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags lambda.norpc -o ../build/bootstrap ./cmd/api) && \
	(cd build && zip -q -X $(notdir $(LAMBDA_ZIP)) bootstrap) && \
	echo 'package: built $(LAMBDA_ZIP)'
