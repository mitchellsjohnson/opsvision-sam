package dynamostore

import (
	"encoding/json"
	"fmt"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
	"opsvision/internal/store"
)

// Each entity is stored through an explicit item struct. Encoding rules:
//
//   - Periods are stored as period.String() text (never via TextMarshaler);
//     the zero Period is stored as "" so unset fields round-trip.
//   - Optional strings, slices and pointers use omitempty, so nil and empty
//     collapse to "absent". Callers compare with EquateEmpty semantics.
//   - json.RawMessage fields are stored as string attributes.
//   - MethodologyVersion.Content is stored as one JSON string attribute.
//   - Times are RFC 3339 strings (attributevalue's default for time.Time).

// keys holds the table's key attributes; it is embedded in every item.
type keys struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI1PK string `dynamodbav:"GSI1PK,omitempty"`
	GSI1SK string `dynamodbav:"GSI1SK,omitempty"`
}

// --- period and raw-JSON helpers ------------------------------------------

func encPeriod(p period.Period) string {
	if p == (period.Period{}) {
		return ""
	}
	return p.String()
}

func decPeriod(s string) (period.Period, error) {
	if s == "" {
		return period.Period{}, nil
	}
	return period.Parse(s)
}

func encPeriodPtr(p *period.Period) *string {
	if p == nil {
		return nil
	}
	s := p.String()
	return &s
}

func decPeriodPtr(s *string) (*period.Period, error) {
	if s == nil {
		return nil, nil
	}
	p, err := period.Parse(*s)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func rawToString(r json.RawMessage) string { return string(r) }

func stringToRaw(s string) json.RawMessage {
	if s == "" {
		return nil
	}
	return json.RawMessage(s)
}

func clonePtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

// --- tenants and memberships ----------------------------------------------

type statusLevelItem struct {
	Key   string `dynamodbav:"Key"`
	Label string `dynamodbav:"Label,omitempty"`
	Color string `dynamodbav:"Color,omitempty"`
	Rank  int    `dynamodbav:"Rank"`
}

type tenantItem struct {
	keys
	ID                   string            `dynamodbav:"ID"`
	Name                 string            `dynamodbav:"Name,omitempty"`
	Auth0OrgID           string            `dynamodbav:"Auth0OrgID,omitempty"`
	FiscalYearStartMonth int               `dynamodbav:"FiscalYearStartMonth"`
	StatusScale          []statusLevelItem `dynamodbav:"StatusScale,omitempty"`
	DefaultRole          string            `dynamodbav:"DefaultRole,omitempty"`
	CreatedAt            time.Time         `dynamodbav:"CreatedAt"`
}

func newTenantItem(t domain.Tenant) tenantItem {
	scale := make([]statusLevelItem, len(t.StatusScale))
	for i, l := range t.StatusScale {
		scale[i] = statusLevelItem(l)
	}
	return tenantItem{
		keys:                 keys{PK: tenantPK(t.ID), SK: skTenant, GSI1PK: gsiTenants, GSI1SK: gsiTenantSK(t.ID)},
		ID:                   t.ID,
		Name:                 t.Name,
		Auth0OrgID:           t.Auth0OrgID,
		FiscalYearStartMonth: int(t.FiscalYearStartMonth),
		StatusScale:          scale,
		DefaultRole:          string(t.DefaultRole),
		CreatedAt:            t.CreatedAt,
	}
}

func (i tenantItem) domain() domain.Tenant {
	var scale []domain.StatusLevel
	if len(i.StatusScale) > 0 {
		scale = make([]domain.StatusLevel, len(i.StatusScale))
		for n, l := range i.StatusScale {
			scale[n] = domain.StatusLevel(l)
		}
	}
	return domain.Tenant{
		ID:                   i.ID,
		Name:                 i.Name,
		Auth0OrgID:           i.Auth0OrgID,
		FiscalYearStartMonth: time.Month(i.FiscalYearStartMonth),
		StatusScale:          scale,
		DefaultRole:          domain.Role(i.DefaultRole),
		CreatedAt:            i.CreatedAt,
	}
}

type auth0MapItem struct {
	keys
	TenantID string `dynamodbav:"TenantID"`
}

type membershipItem struct {
	keys
	UserID     string    `dynamodbav:"UserID"`
	Email      string    `dynamodbav:"Email,omitempty"`
	Name       string    `dynamodbav:"Name,omitempty"`
	Role       string    `dynamodbav:"Role,omitempty"`
	OrgUnitIDs []string  `dynamodbav:"OrgUnitIDs,omitempty"`
	MetricKeys []string  `dynamodbav:"MetricKeys,omitempty"`
	CreatedAt  time.Time `dynamodbav:"CreatedAt"`
}

func newMembershipItem(tid string, m domain.Membership) membershipItem {
	return membershipItem{
		keys:       keys{PK: tenantPK(tid), SK: memberSK(m.UserID), GSI1PK: gsiUserPK(m.UserID), GSI1SK: gsiTenantSK(tid)},
		UserID:     m.UserID,
		Email:      m.Email,
		Name:       m.Name,
		Role:       string(m.Role),
		OrgUnitIDs: m.Scope.OrgUnitIDs,
		MetricKeys: m.Scope.MetricKeys,
		CreatedAt:  m.CreatedAt,
	}
}

func (i membershipItem) domain() domain.Membership {
	return domain.Membership{
		UserID:    i.UserID,
		Email:     i.Email,
		Name:      i.Name,
		Role:      domain.Role(i.Role),
		Scope:     domain.Scope{OrgUnitIDs: i.OrgUnitIDs, MetricKeys: i.MetricKeys},
		CreatedAt: i.CreatedAt,
	}
}

// --- org model --------------------------------------------------------------

type levelItem struct {
	keys
	ID    string `dynamodbav:"ID"`
	Name  string `dynamodbav:"Name,omitempty"`
	Depth int    `dynamodbav:"Depth"`
}

func newLevelItem(tid string, l domain.Level) levelItem {
	return levelItem{keys: keys{PK: tenantPK(tid), SK: levelSK(l.ID)}, ID: l.ID, Name: l.Name, Depth: l.Depth}
}

func (i levelItem) domain() domain.Level {
	return domain.Level{ID: i.ID, Name: i.Name, Depth: i.Depth}
}

type unitItem struct {
	keys
	ID          string   `dynamodbav:"ID"`
	Name        string   `dynamodbav:"Name,omitempty"`
	LevelID     string   `dynamodbav:"LevelID,omitempty"`
	ParentID    string   `dynamodbav:"ParentID,omitempty"`
	SourceKeys  []string `dynamodbav:"SourceKeys,omitempty"`
	RetiredFrom *string  `dynamodbav:"RetiredFrom,omitempty"`
}

func newUnitItem(tid string, u domain.OrgUnit) unitItem {
	return unitItem{
		keys: keys{PK: tenantPK(tid), SK: unitSK(u.ID)},
		ID:   u.ID, Name: u.Name, LevelID: u.LevelID, ParentID: u.ParentID,
		SourceKeys: u.SourceKeys, RetiredFrom: encPeriodPtr(u.RetiredFrom),
	}
}

func (i unitItem) domain() (domain.OrgUnit, error) {
	rf, err := decPeriodPtr(i.RetiredFrom)
	if err != nil {
		return domain.OrgUnit{}, fmt.Errorf("unit %s retiredFrom: %w", i.ID, err)
	}
	return domain.OrgUnit{ID: i.ID, Name: i.Name, LevelID: i.LevelID, ParentID: i.ParentID, SourceKeys: i.SourceKeys, RetiredFrom: rf}, nil
}

type moveItem struct {
	keys
	UnitID         string `dynamodbav:"UnitID"`
	NewParentID    string `dynamodbav:"NewParentID,omitempty"`
	EffectiveMonth string `dynamodbav:"EffectiveMonth,omitempty"`
	Note           string `dynamodbav:"Note,omitempty"`
}

func newMoveItem(tid string, m domain.OrgMove) moveItem {
	return moveItem{
		keys:   keys{PK: tenantPK(tid), SK: moveSK(m.UnitID, m.EffectiveMonth)},
		UnitID: m.UnitID, NewParentID: m.NewParentID, EffectiveMonth: encPeriod(m.EffectiveMonth), Note: m.Note,
	}
}

func (i moveItem) domain() (domain.OrgMove, error) {
	p, err := decPeriod(i.EffectiveMonth)
	if err != nil {
		return domain.OrgMove{}, fmt.Errorf("move %s: %w", i.SK, err)
	}
	return domain.OrgMove{UnitID: i.UnitID, NewParentID: i.NewParentID, EffectiveMonth: p, Note: i.Note}, nil
}

type kindItem struct {
	keys
	ID   string `dynamodbav:"ID"`
	Name string `dynamodbav:"Name,omitempty"`
}

func newKindItem(tid string, k domain.ItemKind) kindItem {
	return kindItem{keys: keys{PK: tenantPK(tid), SK: kindSK(k.ID)}, ID: k.ID, Name: k.Name}
}

func (i kindItem) domain() domain.ItemKind { return domain.ItemKind{ID: i.ID, Name: i.Name} }

type trackedItem struct {
	keys
	ID         string   `dynamodbav:"ID"`
	KindID     string   `dynamodbav:"KindID,omitempty"`
	Name       string   `dynamodbav:"Name,omitempty"`
	OrgUnitID  string   `dynamodbav:"OrgUnitID,omitempty"`
	SourceKeys []string `dynamodbav:"SourceKeys,omitempty"`
}

func newTrackedItem(tid string, it domain.TrackedItem) trackedItem {
	return trackedItem{
		keys: keys{PK: tenantPK(tid), SK: itemSK(it.ID)},
		ID:   it.ID, KindID: it.KindID, Name: it.Name, OrgUnitID: it.OrgUnitID, SourceKeys: it.SourceKeys,
	}
}

func (i trackedItem) domain() domain.TrackedItem {
	return domain.TrackedItem{ID: i.ID, KindID: i.KindID, Name: i.Name, OrgUnitID: i.OrgUnitID, SourceKeys: i.SourceKeys}
}

// --- methodology ------------------------------------------------------------

type scorecardItem struct {
	keys
	ID   string `dynamodbav:"ID"`
	Name string `dynamodbav:"Name,omitempty"`
}

func newScorecardItem(tid string, s domain.Scorecard) scorecardItem {
	return scorecardItem{keys: keys{PK: tenantPK(tid), SK: scorecardSK(s.ID)}, ID: s.ID, Name: s.Name}
}

func (i scorecardItem) domain() domain.Scorecard { return domain.Scorecard{ID: i.ID, Name: i.Name} }

type versionItem struct {
	keys
	ID            string     `dynamodbav:"ID"`
	ScorecardID   string     `dynamodbav:"ScorecardID"`
	Name          string     `dynamodbav:"Name,omitempty"`
	Status        string     `dynamodbav:"Status,omitempty"`
	EffectiveFrom string     `dynamodbav:"EffectiveFrom,omitempty"`
	PublishedAt   *time.Time `dynamodbav:"PublishedAt,omitempty"`
	Revision      int        `dynamodbav:"Revision"`
	Content       string     `dynamodbav:"Content"` // JSON
}

func newVersionItem(tid string, v domain.MethodologyVersion, revision int) (versionItem, error) {
	content, err := json.Marshal(v.Content)
	if err != nil {
		return versionItem{}, fmt.Errorf("encode version content: %w", err)
	}
	return versionItem{
		keys: keys{PK: tenantPK(tid), SK: versionSK(v.ScorecardID, v.ID)},
		ID:   v.ID, ScorecardID: v.ScorecardID, Name: v.Name, Status: string(v.Status),
		EffectiveFrom: encPeriod(v.EffectiveFrom), PublishedAt: clonePtr(v.PublishedAt),
		Revision: revision, Content: string(content),
	}, nil
}

func (i versionItem) domain() (domain.MethodologyVersion, error) {
	eff, err := decPeriod(i.EffectiveFrom)
	if err != nil {
		return domain.MethodologyVersion{}, fmt.Errorf("version %s effectiveFrom: %w", i.SK, err)
	}
	var content domain.Methodology
	if i.Content != "" {
		if err := json.Unmarshal([]byte(i.Content), &content); err != nil {
			return domain.MethodologyVersion{}, fmt.Errorf("version %s content: %w", i.SK, err)
		}
	}
	return domain.MethodologyVersion{
		ID: i.ID, ScorecardID: i.ScorecardID, Name: i.Name, Status: domain.VersionStatus(i.Status),
		EffectiveFrom: eff, PublishedAt: i.PublishedAt, Revision: i.Revision, Content: content,
	}, nil
}

// --- data -------------------------------------------------------------------

// pointItem is both the current item and a history (revision) item; they
// differ only in their keys.
type pointItem struct {
	keys
	MeasureKey string    `dynamodbav:"MeasureKey"`
	SubjectID  string    `dynamodbav:"SubjectID"`
	Period     string    `dynamodbav:"Period,omitempty"`
	Value      *float64  `dynamodbav:"Value,omitempty"`
	NAReason   string    `dynamodbav:"NAReason,omitempty"`
	Source     string    `dynamodbav:"Source,omitempty"`
	EnteredBy  string    `dynamodbav:"EnteredBy,omitempty"`
	EnteredAt  time.Time `dynamodbav:"EnteredAt"`
	Revision   int       `dynamodbav:"Revision"`
	// Deleted marks a tombstone. A tombstone current item keeps the point's
	// revision so later writes continue numbering past it; readers of
	// current items must skip it.
	Deleted bool `dynamodbav:"Deleted,omitempty"`
}

func newPointItem(k keys, p domain.DataPoint) pointItem {
	return pointItem{
		keys:       k,
		MeasureKey: p.MeasureKey, SubjectID: p.SubjectID, Period: encPeriod(p.Period),
		Value: clonePtr(p.Value), NAReason: p.NAReason, Source: p.Source, EnteredBy: p.EnteredBy,
		EnteredAt: p.EnteredAt, Revision: p.Revision, Deleted: p.Deleted,
	}
}

func (i pointItem) domain() (domain.DataPoint, error) {
	p, err := decPeriod(i.Period)
	if err != nil {
		return domain.DataPoint{}, fmt.Errorf("data point %s: %w", i.SK, err)
	}
	return domain.DataPoint{
		MeasureKey: i.MeasureKey, SubjectID: i.SubjectID, Period: p, Value: i.Value, NAReason: i.NAReason,
		Source: i.Source, EnteredBy: i.EnteredBy, EnteredAt: i.EnteredAt, Revision: i.Revision,
		Deleted: i.Deleted,
	}, nil
}

type overrideItem struct {
	keys
	MetricKey string    `dynamodbav:"MetricKey"`
	SubjectID string    `dynamodbav:"SubjectID"`
	Period    string    `dynamodbav:"Period,omitempty"`
	Value     *float64  `dynamodbav:"Value,omitempty"`
	Status    string    `dynamodbav:"Status,omitempty"`
	Reason    string    `dynamodbav:"Reason,omitempty"`
	By        string    `dynamodbav:"By,omitempty"`
	At        time.Time `dynamodbav:"At"`
}

func newOverrideItem(tid, scID string, o domain.Override) overrideItem {
	return overrideItem{
		keys:      keys{PK: dataPK(tid, scID, o.Period.FY), SK: overrideSK(o.Period, o.MetricKey, o.SubjectID)},
		MetricKey: o.MetricKey, SubjectID: o.SubjectID, Period: encPeriod(o.Period),
		Value: clonePtr(o.Value), Status: o.Status, Reason: o.Reason, By: o.By, At: o.At,
	}
}

func (i overrideItem) domain() (domain.Override, error) {
	p, err := decPeriod(i.Period)
	if err != nil {
		return domain.Override{}, fmt.Errorf("override %s: %w", i.SK, err)
	}
	return domain.Override{
		MetricKey: i.MetricKey, SubjectID: i.SubjectID, Period: p, Value: i.Value,
		Status: i.Status, Reason: i.Reason, By: i.By, At: i.At,
	}, nil
}

// --- audit, imports, templates ----------------------------------------------

type auditItem struct {
	keys
	ID         string    `dynamodbav:"ID"`
	ActorID    string    `dynamodbav:"ActorID,omitempty"`
	Channel    string    `dynamodbav:"Channel,omitempty"`
	Action     string    `dynamodbav:"Action,omitempty"`
	TargetType string    `dynamodbav:"TargetType,omitempty"`
	TargetID   string    `dynamodbav:"TargetID,omitempty"`
	Before     string    `dynamodbav:"Before,omitempty"`
	After      string    `dynamodbav:"After,omitempty"`
	At         time.Time `dynamodbav:"At"`
}

func newAuditItem(tid string, e domain.AuditEntry) auditItem {
	return auditItem{
		keys: keys{PK: auditPK(tid, e.At), SK: e.ID},
		ID:   e.ID, ActorID: e.ActorID, Channel: e.Channel, Action: e.Action,
		TargetType: e.TargetType, TargetID: e.TargetID,
		Before: rawToString(e.Before), After: rawToString(e.After), At: e.At,
	}
}

func (i auditItem) domain() domain.AuditEntry {
	return domain.AuditEntry{
		ID: i.ID, ActorID: i.ActorID, Channel: i.Channel, Action: i.Action,
		TargetType: i.TargetType, TargetID: i.TargetID,
		Before: stringToRaw(i.Before), After: stringToRaw(i.After), At: i.At,
	}
}

type importItem struct {
	keys
	ID         string    `dynamodbav:"ID"`
	Status     string    `dynamodbav:"Status,omitempty"`
	ObjectKey  string    `dynamodbav:"ObjectKey,omitempty"`
	Profile    string    `dynamodbav:"Profile,omitempty"`
	TemplateID string    `dynamodbav:"TemplateID,omitempty"`
	CreatedBy  string    `dynamodbav:"CreatedBy,omitempty"`
	CreatedAt  time.Time `dynamodbav:"CreatedAt"`
	ChangeSet  string    `dynamodbav:"ChangeSet,omitempty"`
}

func newImportItem(tid string, im store.Import) importItem {
	return importItem{
		keys: keys{PK: tenantPK(tid), SK: importSK(im.ID)},
		ID:   im.ID, Status: im.Status, ObjectKey: im.ObjectKey, Profile: im.Profile,
		TemplateID: im.TemplateID, CreatedBy: im.CreatedBy, CreatedAt: im.CreatedAt,
		ChangeSet: rawToString(im.ChangeSet),
	}
}

func (i importItem) domain() store.Import {
	return store.Import{
		ID: i.ID, Status: i.Status, ObjectKey: i.ObjectKey, Profile: i.Profile,
		TemplateID: i.TemplateID, CreatedBy: i.CreatedBy, CreatedAt: i.CreatedAt,
		ChangeSet: stringToRaw(i.ChangeSet),
	}
}

type templateItem struct {
	keys
	ID      string `dynamodbav:"ID"`
	Name    string `dynamodbav:"Name,omitempty"`
	Profile string `dynamodbav:"Profile,omitempty"`
	Body    string `dynamodbav:"Body,omitempty"`

	Revision int        `dynamodbav:"Revision"`
	LastUsed *time.Time `dynamodbav:"LastUsed,omitempty"`
}

func newTemplateItem(tid string, t store.Template, revision int) templateItem {
	return templateItem{
		keys: keys{PK: tenantPK(tid), SK: templateSK(t.ID)},
		ID:   t.ID, Name: t.Name, Profile: t.Profile, Body: rawToString(t.Body),
		Revision: revision, LastUsed: clonePtr(t.LastUsed),
	}
}

func (i templateItem) domain() store.Template {
	return store.Template{
		ID: i.ID, Name: i.Name, Profile: i.Profile, Body: stringToRaw(i.Body),
		Revision: i.Revision, LastUsed: i.LastUsed,
	}
}
