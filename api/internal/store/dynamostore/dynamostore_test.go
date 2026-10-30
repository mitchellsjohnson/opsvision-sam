package dynamostore

import (
	"context"
	"os"
	"testing"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"opsvision/internal/store"
	"opsvision/internal/store/storetest"
)

// TestContract runs the shared store contract suite against a real DynamoDB
// table. It is skipped unless OPSVISION_DYNAMO_TEST_TABLE names a table with
// the schema in keys.go (PK, SK, GSI1PK, GSI1SK, index GSI1 projecting ALL).
// The suite generates unique tenant IDs per subtest, so it can share a table
// with other data; it does not clean up after itself.
func TestContract(t *testing.T) {
	table := os.Getenv("OPSVISION_DYNAMO_TEST_TABLE")
	if table == "" {
		t.Skip("set OPSVISION_DYNAMO_TEST_TABLE to run against DynamoDB")
	}
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		t.Fatalf("load AWS config: %v", err)
	}
	client := dynamodb.NewFromConfig(cfg)
	storetest.Run(t, func(t *testing.T) store.Store { return New(client, table) })
}
