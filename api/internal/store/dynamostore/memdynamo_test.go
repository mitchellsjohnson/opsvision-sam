package dynamostore

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"opsvision/internal/store"
	"opsvision/internal/store/storetest"
)

// memDynamo is a small in-memory DynamoDB that implements API. It supports
// exactly the expression forms this package emits, and it enforces the real
// service's limits that matter here (no duplicate items or unused expression
// attributes in a transaction, at most 100 transaction items, 100 BatchGet
// keys, non-empty keys). It deliberately paginates Query and returns
// UnprocessedKeys from BatchGetItem to exercise those paths.
//
// It is NOT a substitute for the real-table run of the contract suite: it does
// not model eventual consistency or TransactionConflict.
type memDynamo struct {
	mu    sync.Mutex
	items map[string]avMap
}

const (
	memPageSize     = 7  // Query returns at most this many items per page
	memBatchPerCall = 60 // BatchGetItem processes at most this many keys per call
)

func newMemDynamo() *memDynamo { return &memDynamo{items: map[string]avMap{}} }

func idOf(m avMap) string { return keyID(strAttr(m, "PK"), strAttr(m, "SK")) }

// check evaluates a condition expression against the existing item (nil if
// absent).
func check(cond *string, names map[string]string, values avMap, existing avMap) (bool, error) {
	if cond == nil {
		return true, nil
	}
	usedNames := map[string]bool{}
	var ok bool
	switch *cond {
	case "attribute_not_exists(PK)":
		ok = existing == nil
	case "attribute_exists(PK)":
		ok = existing != nil
	case "#r = :r":
		usedNames["#r"] = true
		want, _ := values[":r"].(*types.AttributeValueMemberN)
		have, _ := existing["Revision"].(*types.AttributeValueMemberN)
		ok = existing != nil && want != nil && have != nil && want.Value == have.Value
		_ = names
	default:
		return false, fmt.Errorf("memDynamo: unsupported condition %q", *cond)
	}
	for n := range names {
		if !usedNames[n] {
			return false, fmt.Errorf("memDynamo: ValidationException: unused expression attribute name %s", n)
		}
	}
	if *cond != "#r = :r" && len(values) > 0 {
		return false, fmt.Errorf("memDynamo: ValidationException: unused expression attribute values")
	}
	return ok, nil
}

func validKey(m avMap) error {
	if strAttr(m, "PK") == "" || strAttr(m, "SK") == "" {
		return fmt.Errorf("memDynamo: ValidationException: empty key attribute in %v", m)
	}
	return nil
}

func (d *memDynamo) GetItem(_ context.Context, in *dynamodb.GetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return &dynamodb.GetItemOutput{Item: d.items[idOf(in.Key)]}, nil
}

func (d *memDynamo) PutItem(_ context.Context, in *dynamodb.PutItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := validKey(in.Item); err != nil {
		return nil, err
	}
	ok, err := check(in.ConditionExpression, in.ExpressionAttributeNames, in.ExpressionAttributeValues, d.items[idOf(in.Item)])
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, &types.ConditionalCheckFailedException{}
	}
	d.items[idOf(in.Item)] = in.Item
	return &dynamodb.PutItemOutput{}, nil
}

func (d *memDynamo) DeleteItem(_ context.Context, in *dynamodb.DeleteItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	ok, err := check(in.ConditionExpression, in.ExpressionAttributeNames, in.ExpressionAttributeValues, d.items[idOf(in.Key)])
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, &types.ConditionalCheckFailedException{}
	}
	delete(d.items, idOf(in.Key))
	return &dynamodb.DeleteItemOutput{}, nil
}

func (d *memDynamo) BatchGetItem(_ context.Context, in *dynamodb.BatchGetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := &dynamodb.BatchGetItemOutput{Responses: map[string][]avMap{}, UnprocessedKeys: map[string]types.KeysAndAttributes{}}
	for table, ka := range in.RequestItems {
		if len(ka.Keys) > batchGetLimit {
			return nil, fmt.Errorf("memDynamo: ValidationException: %d keys in BatchGetItem", len(ka.Keys))
		}
		seen := map[string]bool{}
		for i, k := range ka.Keys {
			if seen[idOf(k)] {
				return nil, fmt.Errorf("memDynamo: ValidationException: duplicate key in BatchGetItem")
			}
			seen[idOf(k)] = true
			if i >= memBatchPerCall {
				rest := ka
				rest.Keys = ka.Keys[memBatchPerCall:]
				out.UnprocessedKeys[table] = rest
				break
			}
			if it, ok := d.items[idOf(k)]; ok {
				out.Responses[table] = append(out.Responses[table], it)
			}
		}
	}
	return out, nil
}

func (d *memDynamo) Query(_ context.Context, in *dynamodb.QueryInput, _ ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	pkAttr, skAttr := "PK", "SK"
	if in.IndexName != nil {
		pkAttr, skAttr = "GSI1PK", "GSI1SK"
	}
	var wantPK, prefix string
	var hasPrefix bool
	switch *in.KeyConditionExpression {
	case "PK = :pk", "GSI1PK = :pk":
		wantPK = strAttr(in.ExpressionAttributeValues, ":pk")
	case "PK = :pk AND begins_with(SK, :p)":
		wantPK = strAttr(in.ExpressionAttributeValues, ":pk")
		prefix, hasPrefix = strAttr(in.ExpressionAttributeValues, ":p"), true
	default:
		return nil, fmt.Errorf("memDynamo: unsupported key condition %q", *in.KeyConditionExpression)
	}

	var matched []avMap
	for _, it := range d.items {
		if strAttr(it, pkAttr) != wantPK {
			continue
		}
		if hasPrefix && !strings.HasPrefix(strAttr(it, skAttr), prefix) {
			continue
		}
		matched = append(matched, it)
	}
	slices.SortFunc(matched, func(a, b avMap) int {
		if c := strings.Compare(strAttr(a, skAttr), strAttr(b, skAttr)); c != 0 {
			return c
		}
		return strings.Compare(idOf(a), idOf(b))
	})
	if in.ScanIndexForward != nil && !*in.ScanIndexForward {
		slices.Reverse(matched)
	}

	start := 0
	if len(in.ExclusiveStartKey) > 0 {
		start = len(matched)
		for i, it := range matched {
			if idOf(it) == idOf(in.ExclusiveStartKey) {
				start = i + 1
				break
			}
		}
	}
	end := min(start+memPageSize, len(matched))
	out := &dynamodb.QueryOutput{Items: matched[start:end]}
	if end < len(matched) {
		out.LastEvaluatedKey = avMap{"PK": matched[end-1]["PK"], "SK": matched[end-1]["SK"]}
	}
	return out, nil
}

func (d *memDynamo) TransactWriteItems(_ context.Context, in *dynamodb.TransactWriteItemsInput, _ ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(in.TransactItems) > 100 {
		return nil, fmt.Errorf("memDynamo: ValidationException: %d transaction items", len(in.TransactItems))
	}
	seen := map[string]bool{}
	reasons := make([]types.CancellationReason, len(in.TransactItems))
	failed := false
	for i, it := range in.TransactItems {
		var key avMap
		var cond *string
		var names map[string]string
		var values avMap
		switch {
		case it.Put != nil:
			if err := validKey(it.Put.Item); err != nil {
				return nil, err
			}
			key, cond, names, values = it.Put.Item, it.Put.ConditionExpression, it.Put.ExpressionAttributeNames, it.Put.ExpressionAttributeValues
		case it.Delete != nil:
			key, cond, names, values = it.Delete.Key, it.Delete.ConditionExpression, it.Delete.ExpressionAttributeNames, it.Delete.ExpressionAttributeValues
		default:
			return nil, fmt.Errorf("memDynamo: unsupported transaction item")
		}
		if seen[idOf(key)] {
			return nil, fmt.Errorf("memDynamo: ValidationException: transaction has two operations on item %q", idOf(key))
		}
		seen[idOf(key)] = true
		ok, err := check(cond, names, values, d.items[idOf(key)])
		if err != nil {
			return nil, err
		}
		reasons[i] = types.CancellationReason{Code: ptrTo("None")}
		if !ok {
			reasons[i].Code = ptrTo("ConditionalCheckFailed")
			failed = true
		}
	}
	if failed {
		return nil, &types.TransactionCanceledException{CancellationReasons: reasons}
	}
	for _, it := range in.TransactItems {
		switch {
		case it.Put != nil:
			d.items[idOf(it.Put.Item)] = it.Put.Item
		case it.Delete != nil:
			delete(d.items, idOf(it.Delete.Key))
		}
	}
	return &dynamodb.TransactWriteItemsOutput{}, nil
}

// TestContractAgainstMemDynamo runs the full contract suite, including the
// concurrent-writer subtests, through the real Store code against the
// in-memory DynamoDB, so the suite exercises this package on every
// `go test` without AWS.
func TestContractAgainstMemDynamo(t *testing.T) {
	d := newMemDynamo()
	storetest.Run(t, func(t *testing.T) store.Store {
		s := New(d, "mem-table")
		s.backoff = 0
		return s
	})
}
