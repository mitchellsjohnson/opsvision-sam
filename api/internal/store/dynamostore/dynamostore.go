// Package dynamostore is the DynamoDB implementation of store.Store. All data
// lives in one table (see keys.go for the key layout) with a single global
// secondary index, GSI1, projecting all attributes.
//
// Consistency notes:
//
//   - Base-table reads (GetItem, Query, BatchGetItem) are strongly consistent.
//   - ListTenants and TenantsForUser read GSI1, which is eventually
//     consistent. TenantsForUser re-verifies every candidate membership with a
//     strongly consistent read, so a just-deleted membership never appears,
//     but a just-created one can be briefly missing from either list.
//   - Items are limited to 400 KB by DynamoDB; a very large methodology
//     version fails with a DynamoDB validation error.
package dynamostore

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// API is the subset of *dynamodb.Client the store uses. Tests substitute a
// fake.
type API interface {
	GetItem(ctx context.Context, in *dynamodb.GetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(ctx context.Context, in *dynamodb.PutItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	DeleteItem(ctx context.Context, in *dynamodb.DeleteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
	Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error)
	TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error)
	BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error)
}

var (
	_ API         = (*dynamodb.Client)(nil)
	_ store.Store = (*Store)(nil)
)

const (
	gsiName = "GSI1"

	// maxPointsPerTx is the number of data points per TransactWriteItems
	// call. Each point is two items (current + history); DynamoDB allows 100
	// items per transaction.
	maxPointsPerTx = 50
	// batchGetLimit is DynamoDB's per-request key limit for BatchGetItem.
	batchGetLimit = 100
	// maxAuditMonths bounds the audit partitions one ListAudit call reads.
	maxAuditMonths = 240

	codeConditionFailed  = "ConditionalCheckFailed"
	codeTransactionClash = "TransactionConflict"
)

// Store implements store.Store on DynamoDB.
type Store struct {
	client API
	table  string

	// maxAttempts bounds retries of transient failures (transaction
	// conflicts, unprocessed batch keys); backoff is the base delay.
	maxAttempts int
	backoff     time.Duration
}

// New returns a Store that keeps its data in table.
func New(client API, table string) *Store {
	return &Store{client: client, table: table, maxAttempts: 10, backoff: 25 * time.Millisecond}
}

// --- low-level helpers ------------------------------------------------------

type avMap = map[string]types.AttributeValue

func str(s string) types.AttributeValue { return &types.AttributeValueMemberS{Value: s} }

func (s *Store) keyOf(pk, sk string) avMap { return avMap{"PK": str(pk), "SK": str(sk)} }

func marshal(item any) (avMap, error) {
	m, err := attributevalue.MarshalMap(item)
	if err != nil {
		return nil, fmt.Errorf("dynamostore: encode item: %w", err)
	}
	return m, nil
}

func unmarshal[T any](m avMap) (T, error) {
	var out T
	if err := attributevalue.UnmarshalMap(m, &out); err != nil {
		return out, fmt.Errorf("dynamostore: decode item: %w", err)
	}
	return out, nil
}

func unmarshalAll[T any](items []avMap) ([]T, error) {
	out := make([]T, 0, len(items))
	for _, m := range items {
		v, err := unmarshal[T](m)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func isConditionFailed(err error) bool {
	var ccf *types.ConditionalCheckFailedException
	return errors.As(err, &ccf)
}

// canceledError is a TransactionCanceledException with its reason codes.
type canceledError struct {
	codes []string
	err   error
}

func (e *canceledError) Error() string { return e.err.Error() }
func (e *canceledError) Unwrap() error { return e.err }

// conditionFailed reports whether any item's condition check failed.
func (e *canceledError) conditionFailed() bool { return slices.Contains(e.codes, codeConditionFailed) }

// transient reports a cancellation caused only by a concurrent transaction on
// the same item; retrying the same request can succeed.
func (e *canceledError) transient() bool {
	return !e.conditionFailed() && slices.Contains(e.codes, codeTransactionClash)
}

// retryable reports whether the cancellation is a conflict (as opposed to,
// say, a validation error or throttling).
func (e *canceledError) retryable() bool { return e.conditionFailed() || e.transient() }

func asCanceled(err error) *canceledError {
	var ce *canceledError
	if errors.As(err, &ce) {
		return ce
	}
	return nil
}

// sleep waits for a jittered, linearly growing delay, or until ctx is done.
func (s *Store) sleep(ctx context.Context, attempt int) error {
	d := s.backoff * time.Duration(attempt)
	if d > 0 {
		d += time.Duration(rand.Int64N(int64(d)/2 + 1))
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// transact runs one TransactWriteItems call. A cancellation caused only by a
// transient transaction conflict is retried; every cancellation is returned
// as a *canceledError.
func (s *Store) transact(ctx context.Context, items []types.TransactWriteItem) error {
	for attempt := 1; ; attempt++ {
		_, err := s.client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
		if err == nil {
			return nil
		}
		var tce *types.TransactionCanceledException
		if !errors.As(err, &tce) {
			return fmt.Errorf("dynamostore: transaction: %w", err)
		}
		ce := &canceledError{err: err}
		for _, r := range tce.CancellationReasons {
			if r.Code != nil {
				ce.codes = append(ce.codes, *r.Code)
			}
		}
		if !ce.transient() || attempt >= s.maxAttempts {
			return ce
		}
		if err := s.sleep(ctx, attempt); err != nil {
			return err
		}
	}
}

// put writes item, optionally guarded by a condition expression. A failed
// condition returns errConditionFailed.
var errConditionFailed = errors.New("condition failed")

func (s *Store) put(ctx context.Context, item any, cond string, names map[string]string, values avMap) error {
	m, err := marshal(item)
	if err != nil {
		return err
	}
	in := &dynamodb.PutItemInput{TableName: &s.table, Item: m}
	if cond != "" {
		in.ConditionExpression = &cond
		in.ExpressionAttributeNames = names
		in.ExpressionAttributeValues = values
	}
	if _, err := s.client.PutItem(ctx, in); err != nil {
		if isConditionFailed(err) {
			return errConditionFailed
		}
		return fmt.Errorf("dynamostore: put item: %w", err)
	}
	return nil
}

func (s *Store) putPlain(ctx context.Context, item any) error {
	return s.put(ctx, item, "", nil, nil)
}

// putTx builds a transaction Put for item.
func putTx(table string, item any, cond string, names map[string]string, values avMap) (types.TransactWriteItem, error) {
	m, err := marshal(item)
	if err != nil {
		return types.TransactWriteItem{}, err
	}
	p := &types.Put{TableName: &table, Item: m}
	if cond != "" {
		p.ConditionExpression = &cond
		p.ExpressionAttributeNames = names
		p.ExpressionAttributeValues = values
	}
	return types.TransactWriteItem{Put: p}, nil
}

func (s *Store) deleteTx(pk, sk string) types.TransactWriteItem {
	return types.TransactWriteItem{Delete: &types.Delete{TableName: &s.table, Key: s.keyOf(pk, sk)}}
}

const notExists = "attribute_not_exists(PK)"

// get reads one item (strongly consistent); a missing item is ErrNotFound.
func get[T any](ctx context.Context, s *Store, pk, sk string) (T, error) {
	var zero T
	res, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{TableName: &s.table, Key: s.keyOf(pk, sk), ConsistentRead: ptrTo(true)})
	if err != nil {
		return zero, fmt.Errorf("dynamostore: get %s/%s: %w", pk, sk, err)
	}
	if len(res.Item) == 0 {
		return zero, store.ErrNotFound
	}
	return unmarshal[T](res.Item)
}

func ptrTo[T any](v T) *T { return &v }

// queryAll runs a query to completion, following pagination.
func (s *Store) queryAll(ctx context.Context, in *dynamodb.QueryInput) ([]avMap, error) {
	in.TableName = &s.table
	var out []avMap
	for {
		res, err := s.client.Query(ctx, in)
		if err != nil {
			return nil, fmt.Errorf("dynamostore: query: %w", err)
		}
		out = append(out, res.Items...)
		if len(res.LastEvaluatedKey) == 0 {
			return out, nil
		}
		in.ExclusiveStartKey = res.LastEvaluatedKey
	}
}

// queryPK reads every item in a partition whose SK starts with prefix (all
// items if prefix is empty), strongly consistent, ascending unless !forward.
func (s *Store) queryPK(ctx context.Context, pk, prefix string, forward bool) ([]avMap, error) {
	in := &dynamodb.QueryInput{
		ConsistentRead:         ptrTo(true),
		ScanIndexForward:       ptrTo(forward),
		KeyConditionExpression: ptrTo("PK = :pk"),
		ExpressionAttributeValues: avMap{
			":pk": str(pk),
		},
	}
	if prefix != "" {
		in.KeyConditionExpression = ptrTo("PK = :pk AND begins_with(SK, :p)")
		in.ExpressionAttributeValues[":p"] = str(prefix)
	}
	return s.queryAll(ctx, in)
}

func listPrefix[T any](ctx context.Context, s *Store, pk, prefix string) ([]T, error) {
	items, err := s.queryPK(ctx, pk, prefix, true)
	if err != nil {
		return nil, err
	}
	return unmarshalAll[T](items)
}

// queryGSI reads every item with the given GSI1PK (eventually consistent).
func (s *Store) queryGSI(ctx context.Context, gsi1pk string) ([]avMap, error) {
	return s.queryAll(ctx, &dynamodb.QueryInput{
		IndexName:                 ptrTo(gsiName),
		KeyConditionExpression:    ptrTo("GSI1PK = :pk"),
		ExpressionAttributeValues: avMap{":pk": str(gsi1pk)},
	})
}

func strAttr(m avMap, name string) string {
	if v, ok := m[name].(*types.AttributeValueMemberS); ok {
		return v.Value
	}
	return ""
}

func keyID(pk, sk string) string { return pk + "\x00" + sk }

// batchGet reads keys (strongly consistent) in chunks of 100, retrying
// UnprocessedKeys with backoff. Duplicate keys are collapsed. The result is
// keyed by keyID(PK, SK); missing items are absent.
func (s *Store) batchGet(ctx context.Context, keys []avMap) (map[string]avMap, error) {
	seen := map[string]bool{}
	var uniq []avMap
	for _, k := range keys {
		id := keyID(strAttr(k, "PK"), strAttr(k, "SK"))
		if !seen[id] {
			seen[id] = true
			uniq = append(uniq, k)
		}
	}
	out := make(map[string]avMap, len(uniq))
	for chunk := range slices.Chunk(uniq, batchGetLimit) {
		pending := map[string]types.KeysAndAttributes{
			s.table: {Keys: chunk, ConsistentRead: ptrTo(true)},
		}
		for attempt := 1; len(pending) > 0; attempt++ {
			if attempt > s.maxAttempts {
				return nil, fmt.Errorf("dynamostore: batch get: keys still unprocessed after %d attempts", s.maxAttempts)
			}
			if attempt > 1 {
				if err := s.sleep(ctx, attempt-1); err != nil {
					return nil, err
				}
			}
			res, err := s.client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: pending})
			if err != nil {
				return nil, fmt.Errorf("dynamostore: batch get: %w", err)
			}
			for _, it := range res.Responses[s.table] {
				out[keyID(strAttr(it, "PK"), strAttr(it, "SK"))] = it
			}
			pending = res.UnprocessedKeys
		}
	}
	return out, nil
}

// --- TenantStore ------------------------------------------------------------

// CreateTenant implements store.TenantStore. The tenant item and, when
// Auth0OrgID is set, the org-to-tenant map item are written in one
// transaction, so a duplicate ID or org leaves nothing behind.
func (s *Store) CreateTenant(ctx context.Context, t domain.Tenant) error {
	var items []types.TransactWriteItem
	ti, err := putTx(s.table, newTenantItem(t), notExists, nil, nil)
	if err != nil {
		return err
	}
	items = append(items, ti)
	if t.Auth0OrgID != "" {
		mi, err := putTx(s.table, auth0MapItem{keys: keys{PK: auth0OrgPK(t.Auth0OrgID), SK: skAuth0Map}, TenantID: t.ID}, notExists, nil, nil)
		if err != nil {
			return err
		}
		items = append(items, mi)
	}
	err = s.transact(ctx, items)
	if ce := asCanceled(err); ce != nil && ce.retryable() {
		// A transient conflict that outlasted every retry still means
		// another writer is creating the same tenant or org.
		return fmt.Errorf("create tenant %q: %w", t.ID, store.ErrConflict)
	}
	return err
}

// GetTenant implements store.TenantStore.
func (s *Store) GetTenant(ctx context.Context, id string) (domain.Tenant, error) {
	it, err := get[tenantItem](ctx, s, tenantPK(id), skTenant)
	if err != nil {
		return domain.Tenant{}, err
	}
	return it.domain(), nil
}

// TenantByAuth0Org implements store.TenantStore.
func (s *Store) TenantByAuth0Org(ctx context.Context, orgID string) (domain.Tenant, error) {
	if orgID == "" {
		return domain.Tenant{}, store.ErrNotFound
	}
	m, err := get[auth0MapItem](ctx, s, auth0OrgPK(orgID), skAuth0Map)
	if err != nil {
		return domain.Tenant{}, err
	}
	return s.GetTenant(ctx, m.TenantID)
}

// ListTenants implements store.TenantStore. It reads GSI1 (eventually
// consistent).
func (s *Store) ListTenants(ctx context.Context) ([]domain.Tenant, error) {
	raw, err := s.queryGSI(ctx, gsiTenants)
	if err != nil {
		return nil, err
	}
	items, err := unmarshalAll[tenantItem](raw)
	if err != nil {
		return nil, err
	}
	out := make([]domain.Tenant, len(items))
	for i, it := range items {
		out[i] = it.domain()
	}
	slices.SortFunc(out, func(a, b domain.Tenant) int {
		return cmpStr(a.Name, b.Name, a.ID, b.ID)
	})
	return out, nil
}

func cmpStr(a1, b1, a2, b2 string) int {
	if c := strings.Compare(a1, b1); c != 0 {
		return c
	}
	return strings.Compare(a2, b2)
}

// PutMembership implements store.TenantStore.
func (s *Store) PutMembership(ctx context.Context, tenantID string, m domain.Membership) error {
	return s.putPlain(ctx, newMembershipItem(tenantID, m))
}

// GetMembership implements store.TenantStore.
func (s *Store) GetMembership(ctx context.Context, tenantID, userID string) (domain.Membership, error) {
	it, err := get[membershipItem](ctx, s, tenantPK(tenantID), memberSK(userID))
	if err != nil {
		return domain.Membership{}, err
	}
	return it.domain(), nil
}

// DeleteMembership implements store.TenantStore.
func (s *Store) DeleteMembership(ctx context.Context, tenantID, userID string) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName:           &s.table,
		Key:                 s.keyOf(tenantPK(tenantID), memberSK(userID)),
		ConditionExpression: ptrTo("attribute_exists(PK)"),
	})
	if isConditionFailed(err) {
		return store.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("dynamostore: delete membership: %w", err)
	}
	return nil
}

// ListMemberships implements store.TenantStore.
func (s *Store) ListMemberships(ctx context.Context, tenantID string) ([]domain.Membership, error) {
	items, err := listPrefix[membershipItem](ctx, s, tenantPK(tenantID), prefixMember)
	if err != nil {
		return nil, err
	}
	out := make([]domain.Membership, len(items))
	for i, it := range items {
		out[i] = it.domain()
	}
	slices.SortFunc(out, func(a, b domain.Membership) int { return strings.Compare(a.UserID, b.UserID) })
	return out, nil
}

// TenantsForUser implements store.TenantStore. Candidates come from GSI1
// (eventually consistent); each is confirmed against the base table so a
// deleted membership never appears.
func (s *Store) TenantsForUser(ctx context.Context, userID string) ([]string, error) {
	raw, err := s.queryGSI(ctx, gsiUserPK(userID))
	if err != nil {
		return nil, err
	}
	var keys []avMap
	for _, m := range raw {
		keys = append(keys, s.keyOf(tenantPK(tenantFromGSISK(strAttr(m, "GSI1SK"))), memberSK(userID)))
	}
	found, err := s.batchGet(ctx, keys)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, m := range raw {
		tid := tenantFromGSISK(strAttr(m, "GSI1SK"))
		if _, ok := found[keyID(tenantPK(tid), memberSK(userID))]; ok {
			out = append(out, tid)
		}
	}
	slices.Sort(out)
	return out, nil
}

// --- OrgStore ---------------------------------------------------------------

// PutLevels implements store.OrgStore. It replaces the full set in a
// transaction of puts and deletes. A set that needs more than 100 operations
// is applied in several transactions, atomic per transaction only.
func (s *Store) PutLevels(ctx context.Context, tenantID string, ls []domain.Level) error {
	existing, err := s.queryPK(ctx, tenantPK(tenantID), prefixLevel, true)
	if err != nil {
		return err
	}
	keep := map[string]bool{}
	var ops []types.TransactWriteItem
	for _, l := range ls {
		it := newLevelItem(tenantID, l)
		keep[it.SK] = true
		op, err := putTx(s.table, it, "", nil, nil)
		if err != nil {
			return err
		}
		ops = append(ops, op)
	}
	// With duplicate IDs in ls, only the last put may be in the transaction
	// (DynamoDB rejects two operations on one item).
	ops = dedupePuts(ops)
	for _, m := range existing {
		if sk := strAttr(m, "SK"); !keep[sk] {
			ops = append(ops, s.deleteTx(tenantPK(tenantID), sk))
		}
	}
	for chunk := range slices.Chunk(ops, 100) {
		if err := s.transact(ctx, chunk); err != nil {
			return err
		}
	}
	return nil
}

// dedupePuts keeps the last Put for each (PK, SK).
func dedupePuts(ops []types.TransactWriteItem) []types.TransactWriteItem {
	last := map[string]int{}
	for i, op := range ops {
		last[keyID(strAttr(op.Put.Item, "PK"), strAttr(op.Put.Item, "SK"))] = i
	}
	out := ops[:0:0]
	for i, op := range ops {
		if last[keyID(strAttr(op.Put.Item, "PK"), strAttr(op.Put.Item, "SK"))] == i {
			out = append(out, op)
		}
	}
	return out
}

// ListLevels implements store.OrgStore.
func (s *Store) ListLevels(ctx context.Context, tenantID string) ([]domain.Level, error) {
	items, err := listPrefix[levelItem](ctx, s, tenantPK(tenantID), prefixLevel)
	if err != nil {
		return nil, err
	}
	out := make([]domain.Level, len(items))
	for i, it := range items {
		out[i] = it.domain()
	}
	slices.SortFunc(out, func(a, b domain.Level) int {
		if a.Depth != b.Depth {
			return a.Depth - b.Depth
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out, nil
}

// PutOrgUnit implements store.OrgStore.
func (s *Store) PutOrgUnit(ctx context.Context, tenantID string, u domain.OrgUnit) error {
	return s.putPlain(ctx, newUnitItem(tenantID, u))
}

// ListOrgUnits implements store.OrgStore.
func (s *Store) ListOrgUnits(ctx context.Context, tenantID string) ([]domain.OrgUnit, error) {
	items, err := listPrefix[unitItem](ctx, s, tenantPK(tenantID), prefixUnit)
	if err != nil {
		return nil, err
	}
	out := make([]domain.OrgUnit, len(items))
	for i, it := range items {
		if out[i], err = it.domain(); err != nil {
			return nil, err
		}
	}
	slices.SortFunc(out, func(a, b domain.OrgUnit) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

// PutOrgMove implements store.OrgStore.
func (s *Store) PutOrgMove(ctx context.Context, tenantID string, m domain.OrgMove) error {
	return s.putPlain(ctx, newMoveItem(tenantID, m))
}

// ListOrgMoves implements store.OrgStore.
func (s *Store) ListOrgMoves(ctx context.Context, tenantID string) ([]domain.OrgMove, error) {
	items, err := listPrefix[moveItem](ctx, s, tenantPK(tenantID), prefixMove)
	if err != nil {
		return nil, err
	}
	out := make([]domain.OrgMove, len(items))
	for i, it := range items {
		if out[i], err = it.domain(); err != nil {
			return nil, err
		}
	}
	slices.SortFunc(out, func(a, b domain.OrgMove) int {
		if c := strings.Compare(a.UnitID, b.UnitID); c != 0 {
			return c
		}
		return store.ComparePeriod(a.EffectiveMonth, b.EffectiveMonth)
	})
	return out, nil
}

// PutItemKind implements store.OrgStore.
func (s *Store) PutItemKind(ctx context.Context, tenantID string, k domain.ItemKind) error {
	return s.putPlain(ctx, newKindItem(tenantID, k))
}

// ListItemKinds implements store.OrgStore.
func (s *Store) ListItemKinds(ctx context.Context, tenantID string) ([]domain.ItemKind, error) {
	items, err := listPrefix[kindItem](ctx, s, tenantPK(tenantID), prefixKind)
	if err != nil {
		return nil, err
	}
	out := make([]domain.ItemKind, len(items))
	for i, it := range items {
		out[i] = it.domain()
	}
	slices.SortFunc(out, func(a, b domain.ItemKind) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

// PutTrackedItem implements store.OrgStore.
func (s *Store) PutTrackedItem(ctx context.Context, tenantID string, it domain.TrackedItem) error {
	return s.putPlain(ctx, newTrackedItem(tenantID, it))
}

// ListTrackedItems implements store.OrgStore.
func (s *Store) ListTrackedItems(ctx context.Context, tenantID string) ([]domain.TrackedItem, error) {
	items, err := listPrefix[trackedItem](ctx, s, tenantPK(tenantID), prefixItem)
	if err != nil {
		return nil, err
	}
	out := make([]domain.TrackedItem, len(items))
	for i, it := range items {
		out[i] = it.domain()
	}
	slices.SortFunc(out, func(a, b domain.TrackedItem) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

// --- MethodologyStore -------------------------------------------------------

// PutScorecard implements store.MethodologyStore.
func (s *Store) PutScorecard(ctx context.Context, tenantID string, sc domain.Scorecard) error {
	return s.putPlain(ctx, newScorecardItem(tenantID, sc))
}

// GetScorecard implements store.MethodologyStore.
func (s *Store) GetScorecard(ctx context.Context, tenantID, id string) (domain.Scorecard, error) {
	it, err := get[scorecardItem](ctx, s, tenantPK(tenantID), scorecardSK(id))
	if err != nil {
		return domain.Scorecard{}, err
	}
	return it.domain(), nil
}

// ListScorecards implements store.MethodologyStore. Version items share the
// "SC#" prefix and are skipped.
func (s *Store) ListScorecards(ctx context.Context, tenantID string) ([]domain.Scorecard, error) {
	raw, err := s.queryPK(ctx, tenantPK(tenantID), prefixScorecard, true)
	if err != nil {
		return nil, err
	}
	out := []domain.Scorecard{}
	for _, m := range raw {
		if strings.Contains(strAttr(m, "SK"), versionMarker) {
			continue
		}
		it, err := unmarshal[scorecardItem](m)
		if err != nil {
			return nil, err
		}
		out = append(out, it.domain())
	}
	slices.SortFunc(out, func(a, b domain.Scorecard) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}

// PutVersion implements store.MethodologyStore. The create (expected 0) is
// conditional on the item not existing; an update is conditional on the
// stored Revision equalling expectedRevision.
func (s *Store) PutVersion(ctx context.Context, tenantID string, v domain.MethodologyVersion, expectedRevision int) error {
	if expectedRevision < 0 {
		return store.ErrConflict
	}
	it, err := newVersionItem(tenantID, v, expectedRevision+1)
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

func num(n int) types.AttributeValue { return &types.AttributeValueMemberN{Value: strconv.Itoa(n)} }

// GetVersion implements store.MethodologyStore.
func (s *Store) GetVersion(ctx context.Context, tenantID, scorecardID, versionID string) (domain.MethodologyVersion, error) {
	it, err := get[versionItem](ctx, s, tenantPK(tenantID), versionSK(scorecardID, versionID))
	if err != nil {
		return domain.MethodologyVersion{}, err
	}
	return it.domain()
}

// ListVersions implements store.MethodologyStore.
func (s *Store) ListVersions(ctx context.Context, tenantID, scorecardID string) ([]domain.MethodologyVersion, error) {
	items, err := listPrefix[versionItem](ctx, s, tenantPK(tenantID), versionPrefix(scorecardID))
	if err != nil {
		return nil, err
	}
	out := make([]domain.MethodologyVersion, len(items))
	for i, it := range items {
		if out[i], err = it.domain(); err != nil {
			return nil, err
		}
	}
	slices.SortFunc(out, func(a, b domain.MethodologyVersion) int {
		if c := store.ComparePeriod(a.EffectiveFrom, b.EffectiveFrom); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out, nil
}

// --- DataStore --------------------------------------------------------------

type pointKey struct {
	measure, subject string
	period           period.Period
}

// step is one planned write: the point to store (with its new revision) and
// the revision it replaces (0 if the point did not exist).
type step struct {
	write   store.DataWrite
	key     pointKey
	saved   domain.DataPoint
	prevRev int
}

func clonePoint(p domain.DataPoint) domain.DataPoint {
	p.Value = clonePtr(p.Value)
	return p
}

func (s *Store) currentKey(tid, scID string, k pointKey) avMap {
	return s.keyOf(dataPK(tid, scID, k.period.FY), pointSK(k.period, k.measure, k.subject))
}

// plan reads the current state of every point in writes (strongly
// consistent) and simulates the writes in order against it, exactly as the
// in-memory store does: later writes in the batch see earlier ones. It
// returns the planned steps, or the conflicts if any expectation fails.
func (s *Store) plan(ctx context.Context, tid, scID string, writes []store.DataWrite) ([]step, []store.DataConflict, error) {
	keys := make([]avMap, len(writes))
	for i, w := range writes {
		keys[i] = s.currentKey(tid, scID, pointKey{w.Point.MeasureKey, w.Point.SubjectID, w.Point.Period})
	}
	found, err := s.batchGet(ctx, keys)
	if err != nil {
		return nil, nil, err
	}
	state := map[pointKey]*domain.DataPoint{}
	for i, w := range writes {
		k := pointKey{w.Point.MeasureKey, w.Point.SubjectID, w.Point.Period}
		if _, seen := state[k]; seen {
			continue
		}
		m, ok := found[keyID(strAttr(keys[i], "PK"), strAttr(keys[i], "SK"))]
		if !ok {
			state[k] = nil
			continue
		}
		it, err := unmarshal[pointItem](m)
		if err != nil {
			return nil, nil, err
		}
		p, err := it.domain()
		if err != nil {
			return nil, nil, err
		}
		state[k] = &p
	}

	steps := make([]step, 0, len(writes))
	var conflicts []store.DataConflict
	for _, w := range writes {
		k := pointKey{w.Point.MeasureKey, w.Point.SubjectID, w.Point.Period}
		cur := state[k]
		var ok bool
		switch {
		case w.ExpectedRevision == store.Unconditional:
			ok = true
		case w.ExpectedRevision == store.MustNotExist:
			ok = cur == nil
		case w.ExpectedRevision > 0:
			ok = cur != nil && cur.Revision == w.ExpectedRevision
		}
		if !ok {
			c := store.DataConflict{Write: store.DataWrite{Point: clonePoint(w.Point), ExpectedRevision: w.ExpectedRevision}}
			if cur != nil {
				cp := clonePoint(*cur)
				c.Current = &cp
			}
			conflicts = append(conflicts, c)
			continue
		}
		p := clonePoint(w.Point)
		p.Revision = 1
		prev := 0
		if cur != nil {
			prev = cur.Revision
			p.Revision = prev + 1
		}
		state[k] = &p
		steps = append(steps, step{write: w, key: k, saved: clonePoint(p), prevRev: prev})
	}
	return steps, conflicts, nil
}

// txItems builds the transaction for a chunk of steps: one history item per
// step, plus one current item per distinct point holding its final revision,
// conditioned on the revision the chunk started from.
func (s *Store) txItems(tid, scID string, steps []step) ([]types.TransactWriteItem, error) {
	var items []types.TransactWriteItem
	first := map[pointKey]step{}
	last := map[pointKey]step{}
	var order []pointKey
	for _, st := range steps {
		p := st.saved
		hk := keys{PK: histPK(tid, scID), SK: histSK(p.Period, p.MeasureKey, p.SubjectID, p.Revision)}
		h, err := putTx(s.table, newPointItem(hk, p), "", nil, nil)
		if err != nil {
			return nil, err
		}
		items = append(items, h)
		if _, ok := first[st.key]; !ok {
			first[st.key] = st
			order = append(order, st.key)
		}
		last[st.key] = st
	}
	for _, k := range order {
		p := last[k].saved
		ck := keys{PK: dataPK(tid, scID, p.Period.FY), SK: pointSK(p.Period, p.MeasureKey, p.SubjectID)}
		cond, names, values := notExists, map[string]string(nil), avMap(nil)
		if prev := first[k].prevRev; prev > 0 {
			cond = "#r = :r"
			names = map[string]string{"#r": "Revision"}
			values = avMap{":r": num(prev)}
		}
		c, err := putTx(s.table, newPointItem(ck, p), cond, names, values)
		if err != nil {
			return nil, err
		}
		items = append(items, c)
	}
	return items, nil
}

// PutDataPoints implements store.DataStore.
//
// Every write is first checked against the current stored revisions (strongly
// consistent BatchGetItem); if any expectation fails, nothing is written and a
// *store.ConflictError carrying the current points is returned. Otherwise the
// writes are applied in TransactWriteItems chunks of at most 50 points (a
// current item conditioned on its Revision, plus a history item). A chunk is
// atomic; a batch larger than 50 points is atomic per chunk only, so a race
// that fails a later chunk leaves earlier chunks committed (the returned
// *ConflictError then describes what is blocking the rest).
//
// A chunk that loses a race (condition failure or transaction conflict) is
// re-planned against freshly read state: a write whose expectation no longer
// holds becomes a *ConflictError, while a still-valid write (for example an
// Unconditional one) is retried with the new revision.
func (s *Store) PutDataPoints(ctx context.Context, tenantID, scorecardID string, pts []store.DataWrite) ([]domain.DataPoint, error) {
	if len(pts) == 0 {
		return []domain.DataPoint{}, nil
	}
	steps, conflicts, err := s.plan(ctx, tenantID, scorecardID, pts)
	if err != nil {
		return nil, err
	}
	if len(conflicts) > 0 {
		return nil, &store.ConflictError{Conflicts: conflicts}
	}

	attempts := 0
	for start := 0; start < len(steps); {
		end := min(start+maxPointsPerTx, len(steps))
		items, err := s.txItems(tenantID, scorecardID, steps[start:end])
		if err != nil {
			return nil, err
		}
		err = s.transact(ctx, items)
		if err == nil {
			start = end
			continue
		}
		ce := asCanceled(err)
		if ce == nil || !ce.retryable() {
			return nil, err
		}
		if attempts++; attempts >= s.maxAttempts {
			return nil, fmt.Errorf("dynamostore: put data points: %w: gave up after %d contended attempts", store.ErrConflict, attempts)
		}
		if err := s.sleep(ctx, attempts); err != nil {
			return nil, err
		}
		replanned, conflicts, err := s.plan(ctx, tenantID, scorecardID, pts[start:])
		if err != nil {
			return nil, err
		}
		if len(conflicts) > 0 {
			return nil, &store.ConflictError{Conflicts: conflicts}
		}
		steps = append(steps[:start], replanned...)
	}

	saved := make([]domain.DataPoint, len(steps))
	for i, st := range steps {
		saved[i] = clonePoint(st.saved)
	}
	return saved, nil
}

// ListData implements store.DataStore. Each requested fiscal year is one
// partition holding both current points and overrides.
func (s *Store) ListData(ctx context.Context, tenantID, scorecardID string, fiscalYears []int) ([]domain.DataPoint, []domain.Override, error) {
	pts := []domain.DataPoint{}
	ovs := []domain.Override{}
	fys := slices.Clone(fiscalYears)
	slices.Sort(fys)
	for _, fy := range slices.Compact(fys) {
		raw, err := s.queryPK(ctx, dataPK(tenantID, scorecardID, fy), "", true)
		if err != nil {
			return nil, nil, err
		}
		for _, m := range raw {
			switch sk := strAttr(m, "SK"); {
			case strings.HasPrefix(sk, prefixPoint):
				it, err := unmarshal[pointItem](m)
				if err != nil {
					return nil, nil, err
				}
				p, err := it.domain()
				if err != nil {
					return nil, nil, err
				}
				pts = append(pts, p)
			case strings.HasPrefix(sk, prefixOverride):
				it, err := unmarshal[overrideItem](m)
				if err != nil {
					return nil, nil, err
				}
				o, err := it.domain()
				if err != nil {
					return nil, nil, err
				}
				ovs = append(ovs, o)
			}
		}
	}
	slices.SortFunc(pts, func(a, b domain.DataPoint) int {
		if c := cmpStr(a.MeasureKey, b.MeasureKey, a.SubjectID, b.SubjectID); c != 0 {
			return c
		}
		return store.ComparePeriod(a.Period, b.Period)
	})
	slices.SortFunc(ovs, func(a, b domain.Override) int {
		if c := cmpStr(a.MetricKey, b.MetricKey, a.SubjectID, b.SubjectID); c != 0 {
			return c
		}
		return store.ComparePeriod(a.Period, b.Period)
	})
	return pts, ovs, nil
}

// History implements store.DataStore.
func (s *Store) History(ctx context.Context, tenantID, scorecardID, measureKey, subjectID string, p period.Period) ([]domain.DataPoint, error) {
	raw, err := s.queryPK(ctx, histPK(tenantID, scorecardID), histPrefix(p, measureKey, subjectID), false)
	if err != nil {
		return nil, err
	}
	out := make([]domain.DataPoint, 0, len(raw))
	for _, m := range raw {
		it, err := unmarshal[pointItem](m)
		if err != nil {
			return nil, err
		}
		pt, err := it.domain()
		if err != nil {
			return nil, err
		}
		out = append(out, pt)
	}
	return out, nil
}

// PutOverride implements store.DataStore.
func (s *Store) PutOverride(ctx context.Context, tenantID, scorecardID string, o domain.Override) error {
	return s.putPlain(ctx, newOverrideItem(tenantID, scorecardID, o))
}

// DeleteOverride implements store.DataStore.
func (s *Store) DeleteOverride(ctx context.Context, tenantID, scorecardID, metricKey, subjectID string, p period.Period) error {
	_, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName:           &s.table,
		Key:                 s.keyOf(dataPK(tenantID, scorecardID, p.FY), overrideSK(p, metricKey, subjectID)),
		ConditionExpression: ptrTo("attribute_exists(PK)"),
	})
	if isConditionFailed(err) {
		return store.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("dynamostore: delete override: %w", err)
	}
	return nil
}

// --- AuditStore -------------------------------------------------------------

// AppendAudit implements store.AuditStore. The audit log is append-only: an
// entry whose ID already exists in its month is rejected with ErrConflict
// rather than overwritten.
func (s *Store) AppendAudit(ctx context.Context, tenantID string, e domain.AuditEntry) error {
	if e.ID == "" {
		return errors.New("dynamostore: audit entry has no ID")
	}
	err := s.put(ctx, newAuditItem(tenantID, e), notExists, nil, nil)
	if errors.Is(err, errConditionFailed) {
		return fmt.Errorf("audit entry %q: %w", e.ID, store.ErrConflict)
	}
	return err
}

// ListAudit implements store.AuditStore. Entries are partitioned by UTC
// month, so it reads every month partition intersecting [from, to) and
// filters on the exact timestamp. A range spanning more than 240 months is
// rejected.
func (s *Store) ListAudit(ctx context.Context, tenantID string, from, to time.Time) ([]domain.AuditEntry, error) {
	months := auditMonths(from, to)
	if len(months) > maxAuditMonths {
		return nil, fmt.Errorf("dynamostore: audit range spans %d months, limit is %d", len(months), maxAuditMonths)
	}
	out := []domain.AuditEntry{}
	for _, m := range months {
		raw, err := s.queryPK(ctx, auditPK(tenantID, m), "", true)
		if err != nil {
			return nil, err
		}
		for _, r := range raw {
			it, err := unmarshal[auditItem](r)
			if err != nil {
				return nil, err
			}
			if e := it.domain(); !e.At.Before(from) && e.At.Before(to) {
				out = append(out, e)
			}
		}
	}
	slices.SortStableFunc(out, func(a, b domain.AuditEntry) int {
		if c := a.At.Compare(b.At); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out, nil
}

// --- ImportStore ------------------------------------------------------------

// PutImport implements store.ImportStore.
func (s *Store) PutImport(ctx context.Context, tenantID string, im store.Import) error {
	return s.putPlain(ctx, newImportItem(tenantID, im))
}

// GetImport implements store.ImportStore.
func (s *Store) GetImport(ctx context.Context, tenantID, id string) (store.Import, error) {
	it, err := get[importItem](ctx, s, tenantPK(tenantID), importSK(id))
	if err != nil {
		return store.Import{}, err
	}
	return it.domain(), nil
}

// PutTemplate implements store.ImportStore.
func (s *Store) PutTemplate(ctx context.Context, tenantID string, t store.Template) error {
	return s.putPlain(ctx, newTemplateItem(tenantID, t))
}

// ListTemplates implements store.ImportStore.
func (s *Store) ListTemplates(ctx context.Context, tenantID string) ([]store.Template, error) {
	items, err := listPrefix[templateItem](ctx, s, tenantPK(tenantID), prefixTemplate)
	if err != nil {
		return nil, err
	}
	out := make([]store.Template, len(items))
	for i, it := range items {
		out[i] = it.domain()
	}
	slices.SortFunc(out, func(a, b store.Template) int { return strings.Compare(a.ID, b.ID) })
	return out, nil
}
