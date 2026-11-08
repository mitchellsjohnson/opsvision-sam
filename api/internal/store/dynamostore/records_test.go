package dynamostore

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// flakyWrites wraps memDynamo and fails BatchWriteItem from the failAfter-th
// call on, recording how many requests each call carried.
type flakyWrites struct {
	*memDynamo
	failAfter int
	calls     []int
}

var errBoom = errors.New("boom")

func (f *flakyWrites) BatchWriteItem(ctx context.Context, in *dynamodb.BatchWriteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error) {
	n := 0
	for _, r := range in.RequestItems {
		n += len(r)
	}
	f.calls = append(f.calls, n)
	if f.failAfter > 0 && len(f.calls) > f.failAfter {
		return nil, errBoom
	}
	return f.memDynamo.BatchWriteItem(ctx, in, opts...)
}

func testRevs(t *testing.T, n int, snapID string) []store.RecordRevisionWrite {
	t.Helper()
	asOf, err := domain.ParseDate("2026-10-05")
	if err != nil {
		t.Fatal(err)
	}
	out := make([]store.RecordRevisionWrite, n)
	for i := range out {
		out[i] = store.RecordRevisionWrite{
			Source: "tracker-a", ExternalID: fmt.Sprintf("CHK-%03d", i), Type: "defect",
			Rev: domain.RecordRevision{AsOf: asOf, SnapshotID: snapID, Fields: domain.RecordFields{SubjectKey: "checkout", State: domain.StateOpen}},
		}
	}
	return out
}

func testSnapshot(t *testing.T, id string) domain.Snapshot {
	t.Helper()
	asOf, err := domain.ParseDate("2026-10-05")
	if err != nil {
		t.Fatal(err)
	}
	return domain.Snapshot{ID: id, RecordType: "defect", Source: "tracker-a", AsOf: asOf, CreatedAt: testAt}
}

// TestApplySnapshotChunksBatchWrites checks that no BatchWriteItem call
// carries more than 25 requests, and that unprocessed items are retried until
// every revision is stored (memDynamo processes only 10 per call).
func TestApplySnapshotChunksBatchWrites(t *testing.T) {
	d := &flakyWrites{memDynamo: newMemDynamo()}
	s := New(d, "t")
	s.backoff = 0
	ctx := context.Background()

	if err := s.ApplySnapshot(ctx, "acme", testSnapshot(t, "s1"), testRevs(t, 60, "s1")); err != nil {
		t.Fatal(err)
	}
	for _, n := range d.calls {
		if n > batchWriteLimit {
			t.Errorf("BatchWriteItem with %d requests, limit is %d", n, batchWriteLimit)
		}
	}
	if len(d.calls) <= 3 {
		t.Errorf("BatchWriteItem calls = %v, want unprocessed items to be retried", d.calls)
	}
	recs, err := s.ListRecords(ctx, "acme", "defect")
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 60 {
		t.Fatalf("records = %d, want 60", len(recs))
	}
}

// TestApplySnapshotPartialFailureLeavesNoSnapshot checks the retry story: a
// failure mid-batch leaves no snapshot item, and applying again, even with the
// same snapshot ID, succeeds.
func TestApplySnapshotPartialFailureLeavesNoSnapshot(t *testing.T) {
	d := &flakyWrites{memDynamo: newMemDynamo(), failAfter: 2}
	s := New(d, "t")
	s.backoff = 0
	ctx := context.Background()

	err := s.ApplySnapshot(ctx, "acme", testSnapshot(t, "s1"), testRevs(t, 60, "s1"))
	if !errors.Is(err, errBoom) {
		t.Fatalf("error = %v, want the batch failure", err)
	}
	snaps, err := s.ListSnapshots(ctx, "acme", "defect")
	if err != nil || len(snaps) != 0 {
		t.Fatalf("snapshots = %v, %v; want none after a failed apply", snaps, err)
	}

	d.failAfter = 0
	if err := s.ApplySnapshot(ctx, "acme", testSnapshot(t, "s1"), testRevs(t, 60, "s1")); err != nil {
		t.Fatalf("retry with the same ID: %v", err)
	}
	recs, err := s.ListRecords(ctx, "acme", "defect")
	if err != nil || len(recs) != 60 {
		t.Fatalf("records = %d, %v; want 60", len(recs), err)
	}
	for _, r := range recs {
		if len(r.Revisions) != 1 {
			t.Fatalf("record %s has %d revisions, want 1 (deterministic keys)", r.ExternalID, len(r.Revisions))
		}
	}
}

// TestPutTemplateLegacyItem checks that a template stored before templates had
// revisions (no Revision attribute) is revision 0 and saves as revision 1.
func TestPutTemplateLegacyItem(t *testing.T) {
	d := newMemDynamo()
	s := New(d, "t")
	s.backoff = 0
	ctx := context.Background()

	d.items[keyID(tenantPK("acme"), templateSK("old"))] = avMap{
		"PK": str(tenantPK("acme")), "SK": str(templateSK("old")), "ID": str("old"), "Name": str("Legacy"),
	}
	if err := s.PutTemplate(ctx, "acme", store.Template{ID: "old", Name: "Legacy v2"}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutTemplate(ctx, "acme", store.Template{ID: "old", Name: "Legacy v3"}); err != nil {
		t.Fatal(err)
	}
	ts, err := s.ListTemplates(ctx, "acme")
	if err != nil {
		t.Fatal(err)
	}
	if len(ts) != 1 || ts[0].Revision != 2 || ts[0].Name != "Legacy v3" {
		t.Fatalf("templates = %+v, want revision 2", ts)
	}
}

// TestDeleteKeepsTombstoneCurrentItem pins the on-disk shape of a delete: the
// current item stays as a tombstone holding the new revision, so a later write
// is conditioned on it and history is never overwritten.
func TestDeleteKeepsTombstoneCurrentItem(t *testing.T) {
	d := newMemDynamo()
	s := New(d, "t")
	s.backoff = 0
	ctx := context.Background()

	_, err := s.PutDataPoints(ctx, "acme", "sc", []store.DataWrite{{Point: testPoint("m1", 1), ExpectedRevision: store.MustNotExist}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutDataPoints(ctx, "acme", "sc", []store.DataWrite{{Point: testPoint("m1", 0), ExpectedRevision: 1, Delete: true}}); err != nil {
		t.Fatal(err)
	}
	cur := d.items[keyID(dataPK("acme", "sc", testPeriod.FY), pointSK(testPeriod, "m1", "u1"))]
	if cur == nil {
		t.Fatal("current item was removed; want a tombstone")
	}
	tomb, err := unmarshal[pointItem](cur)
	if err != nil {
		t.Fatal(err)
	}
	if !tomb.Deleted || tomb.Revision != 2 || tomb.Source != domain.SourceRecords {
		t.Fatalf("tombstone item = %+v", tomb)
	}
	hist := d.items[keyID(histPK("acme", "sc"), histSK(testPeriod, "m1", "u1", 2))]
	if hist == nil {
		t.Fatal("no tombstone history item at revision 2")
	}
}
