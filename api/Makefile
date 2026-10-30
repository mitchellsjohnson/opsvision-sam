.PHONY: build-ApiFunction

# build-ApiFunction is the AWS SAM custom build ("BuildMethod: makefile") for
# the API Lambda function: a static arm64 Linux binary named bootstrap for the
# provided.al2023 runtime. SAM sets ARTIFACTS_DIR.
build-ApiFunction:
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags lambda.norpc -o $(ARTIFACTS_DIR)/bootstrap ./cmd/api
