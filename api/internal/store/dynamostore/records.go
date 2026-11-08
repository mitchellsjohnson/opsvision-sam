package dynamostore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"opsvision/internal/domain"
	"opsvision/internal/store"
)

// Record types, snapshots and records. Types and snapshots live in the tenant
// partition; every record revision is its own item in the record type's
// partition (see recordPK), so one record's revisions are never rewritten
// together and the 400 KB item limit applies per revision.

// parseDate parses a stored date; the empty string is the zero Date.
func parseDate(s string) (domain.Date, error) {
	if s == "" {
		return domain.Date{}, nil
	}
	return domain.ParseDate(s)
}

// batchWriteLimit is DynamoDB's per-request item limit for BatchWriteItem.
const batchWriteLimit = 25

// --- items ------------------------------------------------------------------

// recordTypeItem stores the whole record type as one JSON attribute; ID and
// Revision are also top-level for the revision condition.
type recordTypeItem struct {
	keys
	ID       string `dynamodbav:"ID"`
	Revision int    `dynamodbav:"Revision"`
	Body     string `dynamodbav:"Body"` // JSON
}

func newRecordTypeItem(tid string, rt domain.RecordType, revision int) (recordTypeItem, error) {
	rt.Revision = revision
	body, err := json.Marshal(rt)
	if err != nil {
		return recordTypeItem{}, fmt.Errorf("encode record type %q: %w", rt.ID, err)
	}
	return recordTypeItem{
		keys: keys{PK: tenantPK(tid), SK: recordTypeSK(rt.ID)},
		ID:   rt.ID, Revision: revision, Body: string(body),
	}, nil
}

func (i recordTypeItem) domain() (domain.RecordType, error) {
	var rt domain.RecordType
	if err := json.Unmarshal([]byte(i.Body), &rt); err != nil {
		return domain.RecordType{}, fmt.Errorf("record type %s: %w", i.SK, err)
	}
	rt.ID, rt.Revision = i.ID, i.Revision
	return rt, nil
}

type snapshotItem struct {
	keys
	ID               string         `dynamodbav:"ID"`
	RecordType       string         `dynamodbav:"RecordType"`
	Source           string         `dynamodbav:"Source,omitempty"`
	TemplateID       string         `dynamodbav:"TemplateID,omitempty"`
	TemplateRevision int            `dynamodbav:"TemplateRevision"`
	AsOf             string         `dynamodbav:"AsOf,omitempty"`
	FileName         string         `dynamodbav:"FileName,omitempty"`
	CreatedBy        string         `dynamodbav:"CreatedBy,omitempty"`
	CreatedAt        time.Time      `dynamodbav:"CreatedAt"`
	Counts           map[string]int `dynamodbav:"Counts,omitempty"`
}

func newSnapshotItem(tid string, sn domain.Snapshot) snapshotItem {
	return snapshotItem{
		keys: keys{PK: tenantPK(tid), SK: snapshotSK(sn.RecordType, sn.ID)},
		ID:   sn.ID, RecordType: sn.RecordType, Source: sn.Source, TemplateID: sn.TemplateID,
		TemplateRevision: sn.TemplateRevision, AsOf: sn.AsOf.String(), FileName: sn.FileName,
		CreatedBy: sn.CreatedBy, CreatedAt: sn.CreatedAt, Counts: sn.Counts,
	}
}

func (i snapshotItem) domain() (domain.Snapshot, error) {
	asOf, err := parseDate(i.AsOf)
	if err != nil {
		return domain.Snapshot{}, fmt.Errorf("snapshot %s: %w", i.SK, err)
	}
	return domain.Snapshot{
		ID: i.ID, RecordType: i.RecordType, Source: i.Source, TemplateID: i.TemplateID,
		TemplateRevision: i.TemplateRevision, AsOf: asOf, FileName: i.FileName,
		CreatedBy: i.CreatedBy, CreatedAt: i.CreatedAt, Counts: i.Counts,
	}, nil
}

// recordRevItem is one revision of one record. Source and ExternalID are
// stored unescaped (the SK is escaped), so reads never decode the SK.
type recordRevItem struct {
	keys
	Source     string `dynamodbav:"Source"`
	ExternalID string `dynamodbav:"ExternalID"`
	Type       string `dynamodbav:"Type"`
	AsOf       string `dynamodbav:"AsOf"`
	SnapshotID string `dynamodbav:"SnapshotID,omitempty"`
	Fields     string `dynamodbav:"Fields"` // JSON
}

func newRecordRevItem(tid string, w store.RecordRevisionWrite) (recordRevItem, error) {
	fields, err := json.Marshal(w.Rev.Fields)
	if err != nil {
		return recordRevItem{}, fmt.Errorf("encode record %q/%q: %w", w.Source, w.ExternalID, err)
	}
	return recordRevItem{
		keys:   keys{PK: recordPK(tid, w.Type), SK: recordSK(w.Source, w.ExternalID, w.Rev.AsOf)},
		Source: w.Source, ExternalID: w.ExternalID, Type: w.Type,
		AsOf: w.Rev.AsOf.String(), SnapshotID: w.Rev.SnapshotID, Fields: string(fields),
	}, nil
}

func (i recordRevItem) revision() (domain.RecordRevision, error) {
	asOf, err := parseDate(i.AsOf)
	if err != nil {
		return domain.RecordRevision{}, fmt.Errorf("record revision %s: %w", i.SK, err)
	}
	var f domain.RecordFields
	if err := json.Unmarshal([]byte(i.Fields), &f); err != nil {
		return domain.RecordRevision{}, fmt.Errorf("record revision %s fields: %w", i.SK, err)
	}
	return domain.RecordRevision{AsOf: asOf, SnapshotID: i.SnapshotID, Fields: f}, nil
}

// --- RecordStore ------------------------------------------------------------

// PutRecordType implements store.RecordStore. Like PutVersion, the create
// (expected 0) is conditional on the item not existing and an update on the
// stored Revision equalling expectedRevision.
func (s *Store) PutRecordType(ctx context.Context, tenantID string, rt domain.RecordType, expectedRevision int) error {
	if expectedRevision < 0 {
		return store.ErrConflict
	}
	it, err := newRecordTypeItem(tenantID, rt, expectedRevision+1)
	if err != nil {
		return err
	}
	cond, names, values := notExists, map[string]string(nil), avMap(nil)
	if expectedRevision > 0 {
		cond = "#r = :r"
		names = map[string]string{"#r": "Revision"}
		values = avMap{":r": num(expectedRevision)}
	}
	err = s.put(ctx, it, cond, names, values)
	if errors.Is(err, errConditionFailed) {
		return store.ErrConflict
	}
	return err
}

// ListRecordTypes implements store.RecordStore.
func (s *Store) ListRecordTypes(ctx context.Context, tenantID string) ([]domain.RecordType, error) {
	items, err := listPrefix[recordTypeItem](ctx, s, tenantPK(tenantID), prefixRecType)
	if err != nil {
		return nil, err
	}
	out := make([]domain.RecordType, len(items))
	for i, it := range items {
		if out[i], err = it.domain(); err != nil {
			return nil, err
		}
	}
	slices.SortFunc(out, func(a, b domain.RecordType) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

// ApplySnapshot implements store.RecordStore.
//
// An existing snapshot ID is rejected first, before anything is written.
// Revisions are then written with BatchWriteItem in chunks of 25 (a
// repeated key in revs keeps only its last write, since a batch may not
// repeat a key), and the snapshot item is written last, conditional on its ID
// being new. A failure part-way therefore leaves some revisions and no
// snapshot; revision keys are deterministic, so applying again is safe.
func (s *Store) ApplySnapshot(ctx context.Context, tenantID string, sn domain.Snapshot, revs []store.RecordRevisionWrite) error {
	snapKey := s.keyOf(tenantPK(tenantID), snapshotSK(sn.RecordType, sn.ID))
	res, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{TableName: &s.table, Key: snapKey, ConsistentRead: ptrTo(true)})
	if err != nil {
		return fmt.Errorf("dynamostore: get snapshot: %w", err)
	}
	if len(res.Item) > 0 {
		return fmt.Errorf("snapshot %q: %w", sn.ID, store.ErrConflict)
	}

	// Last write wins per key, keeping first-seen order.
	byKey := make(map[string]int, len(revs))
	var reqs []types.WriteRequest
	for _, w := range revs {
		it, err := newRecordRevItem(tenantID, w)
		if err != nil {
			return err
		}
		m, err := marshal(it)
		if err != nil {
			return err
		}
		req := types.WriteRequest{PutRequest: &types.PutRequest{Item: m}}
		if i, ok := byKey[itemID(m)]; ok {
			reqs[i] = req
			continue
		}
		byKey[itemID(m)] = len(reqs)
		reqs = append(reqs, req)
	}
	for chunk := range slices.Chunk(reqs, batchWriteLimit) {
		if err := s.batchWrite(ctx, chunk); err != nil {
			return err
		}
	}

	err = s.put(ctx, newSnapshotItem(tenantID, sn), notExists, nil, nil)
	if errors.Is(err, errConditionFailed) {
		return fmt.Errorf("snapshot %q: %w", sn.ID, store.ErrConflict)
	}
	return err
}

// itemID is the keyID of an item's PK and SK.
func itemID(m avMap) string { return keyID(strAttr(m, "PK"), strAttr(m, "SK")) }

// batchWrite writes up to batchWriteLimit requests, retrying UnprocessedItems
// with backoff, like batchGet does for keys.
func (s *Store) batchWrite(ctx context.Context, reqs []types.WriteRequest) error {
	pending := map[string][]types.WriteRequest{s.table: reqs}
	for attempt := 1; len(pending) > 0; attempt++ {
		if attempt > s.maxAttempts {
			return fmt.Errorf("dynamostore: batch write: items still unprocessed after %d attempts", s.maxAttempts)
		}
		if attempt > 1 {
			if err := s.sleep(ctx, attempt-1); err != nil {
				return err
			}
		}
		res, err := s.client.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{RequestItems: pending})
		if err != nil {
			return fmt.Errorf("dynamostore: batch write: %w", err)
		}
		pending = res.UnprocessedItems
	}
	return nil
}

// ListRecords implements store.RecordStore. It reads the record type's whole
// partition and groups revisions by the (Source, ExternalID) stored in each
// item.
func (s *Store) ListRecords(ctx context.Context, tenantID, recordType string) ([]domain.Record, error) {
	items, err := listPrefix[recordRevItem](ctx, s, recordPK(tenantID, recordType), prefixRecordRev)
	if err != nil {
		return nil, err
	}
	type key struct{ source, externalID string }
	byKey := map[key]*domain.Record{}
	var out []*domain.Record
	for _, it := range items {
		rev, err := it.revision()
		if err != nil {
			return nil, err
		}
		k := key{it.Source, it.ExternalID}
		rec := byKey[k]
		if rec == nil {
			rec = &domain.Record{Source: it.Source, ExternalID: it.ExternalID, Type: it.Type}
			byKey[k] = rec
			out = append(out, rec)
		}
		rec.Revisions = append(rec.Revisions, rev)
	}
	recs := make([]domain.Record, len(out))
	for i, r := range out {
		slices.SortFunc(r.Revisions, func(a, b domain.RecordRevision) int { return a.AsOf.Compare(b.AsOf.Time) })
		recs[i] = *r
	}
	slices.SortFunc(recs, func(a, b domain.Record) int { return cmpStr(a.Source, b.Source, a.ExternalID, b.ExternalID) })
	return recs, nil
}

// ListSnapshots implements store.RecordStore.
func (s *Store) ListSnapshots(ctx context.Context, tenantID, recordType string) ([]domain.Snapshot, error) {
	items, err := listPrefix[snapshotItem](ctx, s, tenantPK(tenantID), snapshotPrefix(recordType))
	if err != nil {
		return nil, err
	}
	out := make([]domain.Snapshot, len(items))
	for i, it := range items {
		if out[i], err = it.domain(); err != nil {
			return nil, err
		}
	}
	slices.SortFunc(out, func(a, b domain.Snapshot) int {
		if c := b.AsOf.Compare(a.AsOf.Time); c != 0 {
			return c
		}
		if c := b.CreatedAt.Compare(a.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out, nil
}
