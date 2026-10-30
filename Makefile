.PHONY: gen gen-check test lint dev denylist

OAPI_SPEC   := ../openapi/openapi.yaml
OAPI_CONFIG := internal/httpapi/oapi-config.yaml
OAPI_OUT    := internal/httpapi/gen.go

# gen regenerates code from openapi/openapi.yaml. Go only for now; the
# TypeScript client is added with the web app.
gen:
	cd api && go tool oapi-codegen -config $(OAPI_CONFIG) $(OAPI_SPEC)

# gen-check fails if the committed generated code differs from what the spec
# produces. It regenerates into a temp file (the config's output path wins
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
	fi

test:
	@echo 'test: not yet configured'

lint:
	@echo 'lint: not yet configured'

dev:
	@echo 'dev: not yet configured'

denylist:
	bash scripts/check-denylist.sh
