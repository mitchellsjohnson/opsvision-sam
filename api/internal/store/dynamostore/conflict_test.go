package dynamostore

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// fakeAPI is a scriptable API. Methods without a script fail the test's call.
type fakeAPI struct {
	batchGet func(*dynamodb.BatchGetItemInput) (*dynamodb.BatchGetItemOutput, error)
	transact func(*dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error)

	batchGets []*dynamodb.BatchGetItemInput
	transacts []*dynamodb.TransactWriteItemsInput
}

var errUnexpected = errors.New("unexpected call to fake")

func (f *fakeAPI) GetItem(context.Context, *dynamodb.GetItemInput, ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	return nil, errUnexpected
}

func (f *fakeAPI) PutItem(context.Context, *dynamodb.PutItemInput, ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	return nil, errUnexpected
}

func (f *fakeAPI) DeleteItem(context.Context, *dynamodb.DeleteItemInput, ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	return nil, errUnexpected
}

func (f *fakeAPI) Query(context.Context, *dynamodb.QueryInput, ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	return nil, errUnexpected
}

func (f *fakeAPI) BatchGetItem(_ context.Context, in *dynamodb.BatchGetItemInput, _ ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	f.batchGets = append(f.batchGets, in)
	if f.batchGet == nil {
		return nil, errUnexpected
	}
	return f.batchGet(in)
}

func (f *fakeAPI) TransactWriteItems(_ context.Context, in *dynamodb.TransactWriteItemsInput, _ ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	f.transacts = append(f.transacts, in)
	if f.transact == nil {
		return nil, errUnexpected
	}
	return f.transact(in)
}

const testTable = "test-table"

func newFakeStore(f *fakeAPI) *Store {
	s := New(f, testTable)
	s.backoff = 0 // no sleeping in unit tests
	return s
}

var (
	testPeriod = period.Period{Grain: period.Month, FY: 2026, Index: 4}
	testAt     = time.Date(2026, time.October, 2, 12, 0, 0, 0, time.UTC)
)

func testPoint(measure string, v float64) domain.DataPoint {
	return domain.DataPoint{MeasureKey: measure, SubjectID: "u1", Period: testPeriod, Value: &v, Source: domain.SourceGrid, EnteredBy: "user-1", EnteredAt: testAt}
}

// storedPoint is the BatchGetItem response form of a current data point.
func storedPoint(t *testing.T, tid, sc string, p domain.DataPoint) map[string]types.AttributeValue {
	t.Helper()
	m, err := marshal(newPointItem(keys{PK: dataPK(tid, sc, p.Period.FY), SK: pointSK(p.Period, p.MeasureKey, p.SubjectID)}, p))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func respond(items ...map[string]types.AttributeValue) (*dynamodb.BatchGetItemOutput, error) {
	return &dynamodb.BatchGetItemOutput{Responses: map[string][]map[string]types.AttributeValue{testTable: items}}, nil
}

func canceled(codes ...string) error {
	rs := make([]types.CancellationReason, len(codes))
	for i, c := range codes {
		rs[i] = types.CancellationReason{Code: ptrTo(c)}
	}
	return &types.TransactionCanceledException{CancellationReasons: rs}
}

func asConflict(t *testing.T, err error) *store.ConflictError {
	t.Helper()
	if !errors.Is(err, store.ErrConflict) {
		t.Fatalf("error = %v, want ErrConflict", err)
	}
	var ce *store.ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("error %v (%T) is not a *store.ConflictError", err, err)
	}
	return ce
}

func attrN(t *testing.T, v types.AttributeValue) string {
	t.Helper()
	n, ok := v.(*types.AttributeValueMemberN)
	if !ok {
		t.Fatalf("attribute %T is not a number", v)
	}
	return n.Value
}

func TestPutDataPointsPrecheckConflictReturnsCurrent(t *testing.T) {
	existing := testPoint("m1", 5)
	existing.Revision = 2
	f := &fakeAPI{batchGet: func(*dynamodb.BatchGetItemInput) (*dynamodb.BatchGetItemOutput, error) {
		return respond(storedPoint(t, "t1", "sc", existing))
	}}
	s := newFakeStore(f)

	loser := store.DataWrite{Point: testPoint("m1", 9), ExpectedRevision: store.MustNotExist}
	fine := store.DataWrite{Point: testPoint("m2", 1), ExpectedRevision: store.MustNotExist}
	saved, err := s.PutDataPoints(context.Background(), "t1", "sc", []store.DataWrite{fine, loser})

	ce := asConflict(t, err)
	if saved != nil {
		t.Errorf("saved = %+v on conflict, want nil", saved)
	}
	if len(ce.Conflicts) != 1 || ce.Conflicts[0].Write.Point.MeasureKey != "m1" {
		t.Fatalf("conflicts = %+v, want exactly m1", ce.Conflicts)
	}
	cur := ce.Conflicts[0].Current
	if cur == nil || cur.Revision != 2 || cur.Value == nil || *cur.Value != 5 {
		t.Fatalf("Current = %+v, want the stored point at revision 2", cur)
	}
	if len(f.transacts) != 0 {
		t.Fatalf("%d transactions issued after a failed pre-check, want 0", len(f.transacts))
	}
}

func TestPutDataPointsMissingPointWithExpectedRevisionHasNilCurrent(t *testing.T) {
	f := &fakeAPI{batchGet: func(*dynamodb.BatchGetItemInput) (*dynamodb.BatchGetItemOutput, error) { return respond() }}
	_, err := newFakeStore(f).PutDataPoints(context.Background(), "t1", "sc",
		[]store.DataWrite{{Point: testPoint("m9", 1), ExpectedRevision: 3}})
	ce := asConflict(t, err)
	if len(ce.Conflicts) != 1 || ce.Conflicts[0].Current != nil {
		t.Fatalf("conflicts = %+v, want one with nil Current", ce.Conflicts)
	}
}

func TestPutDataPointsConditionFailureMapsToConflictWithFreshCurrent(t *testing.T) {
	winner := testPoint("m1", 42)
	winner.Revision = 1
	calls := 0
	f := &fakeAPI{
		batchGet: func(*dynamodb.BatchGetItemInput) (*dynamodb.BatchGetItemOutput, error) {
			calls++
			if calls == 1 {
				return respond() // pre-check: the point does not exist yet
			}
			return respond(storedPoint(t, "t1", "sc", winner)) // re-read after the race
		},
		transact: func(*dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error) {
			return nil, canceled("None", "ConditionalCheckFailed")
		},
	}
	w := store.DataWrite{Point: testPoint("m1", 7), ExpectedRevision: store.MustNotExist}
	saved, err := newFakeStore(f).PutDataPoints(context.Background(), "t1", "sc", []store.DataWrite{w})

	ce := asConflict(t, err)
	if saved != nil {
		t.Errorf("saved = %+v, want nil", saved)
	}
	if len(ce.Conflicts) != 1 || ce.Conflicts[0].Current == nil || ce.Conflicts[0].Current.Revision != 1 || *ce.Conflicts[0].Current.Value != 42 {
		t.Fatalf("conflicts = %+v, want the winner's point (revision 1, value 42) as Current", ce.Conflicts)
	}
	if len(f.transacts) != 1 {
		t.Fatalf("transactions = %d, want 1 (a conflict is not retried)", len(f.transacts))
	}
}

func TestPutDataPointsTransientTransactionConflictIsRetried(t *testing.T) {
	f := &fakeAPI{batchGet: func(*dynamodb.BatchGetItemInput) (*dynamodb.BatchGetItemOutput, error) { return respond() }}
	f.transact = func(*dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error) {
		if len(f.transacts) < 3 {
			return nil, canceled("TransactionConflict", "TransactionConflict")
		}
		return &dynamodb.TransactWriteItemsOutput{}, nil
	}
	saved, err := newFakeStore(f).PutDataPoints(context.Background(), "t1", "sc",
		[]store.DataWrite{{Point: testPoint("m1", 1), ExpectedRevision: store.MustNotExist}})
	if err != nil {
		t.Fatal(err)
	}
	if len(saved) != 1 || saved[0].Revision != 1 || len(f.transacts) != 3 {
		t.Fatalf("saved = %+v after %d transactions, want one point at revision 1 after 3", saved, len(f.transacts))
	}
}

func TestPutDataPointsPersistentTransactionConflictEndsInErrConflict(t *testing.T) {
	f := &fakeAPI{
		batchGet: func(*dynamodb.BatchGetItemInput) (*dynamodb.BatchGetItemOutput, error) { return respond() },
		transact: func(*dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error) {
			return nil, canceled("TransactionConflict")
		},
	}
	_, err := newFakeStore(f).PutDataPoints(context.Background(), "t1", "sc",
		[]store.DataWrite{{Point: testPoint("m1", 1), ExpectedRevision: store.Unconditional}})
	if !errors.Is(err, store.ErrConflict) {
		t.Fatalf("error = %v, want ErrConflict", err)
	}
}

func TestPutDataPointsOtherCancellationIsNotAConflict(t *testing.T) {
	f := &fakeAPI{
		batchGet: func(*dynamodb.BatchGetItemInput) (*dynamodb.BatchGetItemOutput, error) { return respond() },
		transact: func(*dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error) {
			return nil, canceled("ValidationError")
		},
	}
	_, err := newFakeStore(f).PutDataPoints(context.Background(), "t1", "sc",
		[]store.DataWrite{{Point: testPoint("m1", 1), ExpectedRevision: store.MustNotExist}})
	if err == nil || errors.Is(err, store.ErrConflict) {
		t.Fatalf("error = %v, want a non-conflict error", err)
	}
}

func TestPutDataPointsUnconditionalRaceRetriesAtNewRevision(t *testing.T) {
	// The point is at revision 1 at pre-check, then another writer moves it
	// to revision 3 before our transaction runs. An unconditional write is
	// still valid, so it must be retried as revision 4, conditioned on 3.
	at1, at3 := testPoint("m1", 10), testPoint("m1", 30)
	at1.Revision, at3.Revision = 1, 3
	reads := 0
	f := &fakeAPI{}
	f.batchGet = func(*dynamodb.BatchGetItemInput) (*dynamodb.BatchGetItemOutput, error) {
		reads++
		if reads == 1 {
			return respond(storedPoint(t, "t1", "sc", at1))
		}
		return respond(storedPoint(t, "t1", "sc", at3))
	}
	f.transact = func(*dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error) {
		if len(f.transacts) == 1 {
			return nil, canceled("None", "ConditionalCheckFailed")
		}
		return &dynamodb.TransactWriteItemsOutput{}, nil
	}

	saved, err := newFakeStore(f).PutDataPoints(context.Background(), "t1", "sc",
		[]store.DataWrite{{Point: testPoint("m1", 99), ExpectedRevision: store.Unconditional}})
	if err != nil {
		t.Fatal(err)
	}
	if len(saved) != 1 || saved[0].Revision != 4 {
		t.Fatalf("saved = %+v, want revision 4", saved)
	}

	first, second := f.transacts[0], f.transacts[1]
	if got := attrN(t, first.TransactItems[1].Put.ExpressionAttributeValues[":r"]); got != "1" {
		t.Errorf("first attempt condition revision = %s, want 1", got)
	}
	if got := attrN(t, second.TransactItems[1].Put.ExpressionAttributeValues[":r"]); got != "3" {
		t.Errorf("second attempt condition revision = %s, want 3", got)
	}
	hist := second.TransactItems[0].Put.Item
	if sk := strAttr(hist, "SK"); sk != "DP#2026-M04#m1#u1#R000004" {
		t.Errorf("history SK = %q, want ...#R000004", sk)
	}
	if pk := strAttr(hist, "PK"); pk != "T#t1#SC#sc#HIST" {
		t.Errorf("history PK = %q", pk)
	}
}

func TestPutDataPointsCreateUsesAttributeNotExists(t *testing.T) {
	f := &fakeAPI{
		batchGet: func(*dynamodb.BatchGetItemInput) (*dynamodb.BatchGetItemOutput, error) { return respond() },
		transact: func(*dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error) {
			return &dynamodb.TransactWriteItemsOutput{}, nil
		},
	}
	_, err := newFakeStore(f).PutDataPoints(context.Background(), "t1", "sc",
		[]store.DataWrite{{Point: testPoint("m1", 1), ExpectedRevision: store.MustNotExist}})
	if err != nil {
		t.Fatal(err)
	}
	items := f.transacts[0].TransactItems
	if len(items) != 2 {
		t.Fatalf("transaction has %d items, want current + history", len(items))
	}
	cur := items[1].Put
	if cur.ConditionExpression == nil || *cur.ConditionExpression != "attribute_not_exists(PK)" {
		t.Errorf("create condition = %v, want attribute_not_exists(PK)", cur.ConditionExpression)
	}
	if len(cur.ExpressionAttributeNames) != 0 || len(cur.ExpressionAttributeValues) != 0 {
		t.Errorf("create condition carries unused names/values (DynamoDB rejects these): %v %v", cur.ExpressionAttributeNames, cur.ExpressionAttributeValues)
	}
	if pk, sk := strAttr(cur.Item, "PK"), strAttr(cur.Item, "SK"); pk != "T#t1#SC#sc#FY#2026" || sk != "DP#2026-M04#m1#u1" {
		t.Errorf("current item key = %q / %q", pk, sk)
	}
}

func TestPutDataPointsChunksAndBatchGetRetriesUnprocessed(t *testing.T) {
	const n = 120
	writes := make([]store.DataWrite, n)
	for i := range writes {
		writes[i] = store.DataWrite{Point: testPoint(fmt.Sprintf("m%03d", i), float64(i)), ExpectedRevision: store.MustNotExist}
	}
	unprocessedOnce := false
	f := &fakeAPI{}
	f.batchGet = func(in *dynamodb.BatchGetItemInput) (*dynamodb.BatchGetItemOutput, error) {
		keys := in.RequestItems[testTable].Keys
		if len(keys) > batchGetLimit {
			t.Errorf("BatchGetItem with %d keys, limit is %d", len(keys), batchGetLimit)
		}
		if !unprocessedOnce {
			unprocessedOnce = true
			return &dynamodb.BatchGetItemOutput{UnprocessedKeys: in.RequestItems}, nil
		}
		return respond()
	}
	f.transact = func(in *dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error) {
		return &dynamodb.TransactWriteItemsOutput{}, nil
	}

	saved, err := newFakeStore(f).PutDataPoints(context.Background(), "t1", "sc", writes)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved) != n {
		t.Fatalf("saved %d points, want %d", len(saved), n)
	}
	for i, p := range saved {
		if p.MeasureKey != writes[i].Point.MeasureKey || p.Revision != 1 {
			t.Fatalf("saved[%d] = %s rev %d, want %s rev 1 (input order)", i, p.MeasureKey, p.Revision, writes[i].Point.MeasureKey)
		}
	}

	var sizes []int
	for _, tx := range f.transacts {
		sizes = append(sizes, len(tx.TransactItems))
	}
	want := []int{100, 100, 40}
	if fmt.Sprint(sizes) != fmt.Sprint(want) {
		t.Fatalf("transaction sizes = %v, want %v (50 points x 2 items per chunk)", sizes, want)
	}
	// 1 retried 100-key request + 100-key request + 20-key request.
	if len(f.batchGets) != 3 {
		t.Fatalf("BatchGetItem calls = %d, want 3 (one unprocessed retry)", len(f.batchGets))
	}
}

func TestPutDataPointsSamePointTwiceInOneBatch(t *testing.T) {
	f := &fakeAPI{
		batchGet: func(*dynamodb.BatchGetItemInput) (*dynamodb.BatchGetItemOutput, error) { return respond() },
		transact: func(*dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error) {
			return &dynamodb.TransactWriteItemsOutput{}, nil
		},
	}
	saved, err := newFakeStore(f).PutDataPoints(context.Background(), "t1", "sc", []store.DataWrite{
		{Point: testPoint("m1", 1), ExpectedRevision: store.MustNotExist},
		{Point: testPoint("m1", 2), ExpectedRevision: 1}, // sees the first write
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(saved) != 2 || saved[0].Revision != 1 || saved[1].Revision != 2 {
		t.Fatalf("saved = %+v, want revisions 1 then 2", saved)
	}
	// DynamoDB rejects two operations on one item in a transaction: expect
	// two history items and ONE current item holding revision 2.
	items := f.transacts[0].TransactItems
	if len(items) != 3 {
		t.Fatalf("transaction has %d items, want 3", len(items))
	}
	seen := map[string]bool{}
	for _, it := range items {
		id := keyID(strAttr(it.Put.Item, "PK"), strAttr(it.Put.Item, "SK"))
		if seen[id] {
			t.Fatalf("item %q appears twice in one transaction", id)
		}
		seen[id] = true
	}
	cur := items[2].Put
	if got := attrN(t, cur.Item["Revision"]); got != "2" {
		t.Errorf("current item revision = %s, want 2", got)
	}
	if cur.ConditionExpression == nil || *cur.ConditionExpression != "attribute_not_exists(PK)" {
		t.Errorf("current item condition = %v, want attribute_not_exists(PK)", cur.ConditionExpression)
	}
}

func TestCreateTenantConditionFailureIsErrConflict(t *testing.T) {
	f := &fakeAPI{transact: func(in *dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error) {
		return nil, canceled("None", "ConditionalCheckFailed")
	}}
	err := newFakeStore(f).CreateTenant(context.Background(), domain.Tenant{ID: "t1", Name: "T", Auth0OrgID: "org_1"})
	if !errors.Is(err, store.ErrConflict) {
		t.Fatalf("error = %v, want ErrConflict", err)
	}
	items := f.transacts[0].TransactItems
	if len(items) != 2 {
		t.Fatalf("transaction has %d items, want tenant + org map", len(items))
	}
	for _, it := range items {
		if it.Put.ConditionExpression == nil || *it.Put.ConditionExpression != "attribute_not_exists(PK)" {
			t.Errorf("item %q lacks attribute_not_exists(PK)", strAttr(it.Put.Item, "PK"))
		}
	}
	if pk, sk := strAttr(items[1].Put.Item, "PK"), strAttr(items[1].Put.Item, "SK"); pk != "AUTH0ORG#org_1" || sk != "MAP" {
		t.Errorf("org map key = %q / %q", pk, sk)
	}
}

func TestCreateTenantWithoutOrgWritesOnlyTheTenant(t *testing.T) {
	f := &fakeAPI{transact: func(*dynamodb.TransactWriteItemsInput) (*dynamodb.TransactWriteItemsOutput, error) {
		return &dynamodb.TransactWriteItemsOutput{}, nil
	}}
	if err := newFakeStore(f).CreateTenant(context.Background(), domain.Tenant{ID: "t1"}); err != nil {
		t.Fatal(err)
	}
	if n := len(f.transacts[0].TransactItems); n != 1 {
		t.Fatalf("transaction has %d items, want only the tenant", n)
	}
}
