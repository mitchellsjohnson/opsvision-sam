package httpapi

import (
	"fmt"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

// This file converts between domain types and generated API types. Response
// arrays and objects the contract marks required are never null: every slice
// that leaves through this layer is built non-nil.

func apiTenant(t domain.Tenant) Tenant {
	scale := make([]StatusLevel, 0, len(t.StatusScale))
	for _, l := range t.StatusScale {
		scale = append(scale, StatusLevel{Key: l.Key, Label: l.Label, Color: l.Color, Rank: l.Rank})
	}
	return Tenant{
		Id:                   t.ID,
		Name:                 t.Name,
		Auth0OrgId:           t.Auth0OrgID,
		FiscalYearStartMonth: int(t.FiscalYearStartMonth),
		StatusScale:          scale,
		DefaultRole:          Role(t.DefaultRole),
		CreatedAt:            t.CreatedAt,
	}
}

func apiScope(s domain.Scope) Scope {
	return Scope{
		OrgUnitIds: append([]Id{}, s.OrgUnitIDs...),
		MetricKeys: append([]Key{}, s.MetricKeys...),
	}
}

func domainScope(s Scope) domain.Scope {
	return domain.Scope{
		OrgUnitIDs: append([]string{}, s.OrgUnitIds...),
		MetricKeys: append([]string{}, s.MetricKeys...),
	}
}

func apiMembership(m domain.Membership) Membership {
	return Membership{
		UserId:    m.UserID,
		Email:     m.Email,
		Name:      m.Name,
		Role:      Role(m.Role),
		Scope:     apiScope(m.Scope),
		CreatedAt: m.CreatedAt,
	}
}

func apiMemberships(ms []domain.Membership) []Membership {
	out := make([]Membership, 0, len(ms))
	for _, m := range ms {
		out = append(out, apiMembership(m))
	}
	return out
}

func apiLevel(l domain.Level) Level {
	return Level{Id: l.ID, Name: l.Name, Depth: l.Depth}
}

func apiLevels(ls []domain.Level) []Level {
	out := make([]Level, 0, len(ls))
	for _, l := range ls {
		out = append(out, apiLevel(l))
	}
	return out
}

func apiOrgUnit(u domain.OrgUnit) OrgUnit {
	out := OrgUnit{
		Id:         u.ID,
		Name:       u.Name,
		LevelId:    u.LevelID,
		ParentId:   u.ParentID,
		SourceKeys: append([]string{}, u.SourceKeys...),
	}
	if u.RetiredFrom != nil {
		s := u.RetiredFrom.String()
		out.RetiredFrom = &s
	}
	return out
}

func apiOrgUnits(us []domain.OrgUnit) []OrgUnit {
	out := make([]OrgUnit, 0, len(us))
	for _, u := range us {
		out = append(out, apiOrgUnit(u))
	}
	return out
}

func apiOrgMove(m domain.OrgMove) OrgMove {
	return OrgMove{
		UnitId:         m.UnitID,
		NewParentId:    m.NewParentID,
		EffectiveMonth: m.EffectiveMonth.String(),
		Note:           m.Note,
	}
}

// periodString formats a period for the API: the empty string when unset.
func periodString(p period.Period) string {
	if p == (period.Period{}) {
		return ""
	}
	return p.String()
}

func apiVersion(v domain.MethodologyVersion) MethodologyVersion {
	return MethodologyVersion{
		Id:            v.ID,
		ScorecardId:   v.ScorecardID,
		Name:          v.Name,
		Status:        VersionStatus(v.Status),
		EffectiveFrom: periodString(v.EffectiveFrom),
		PublishedAt:   v.PublishedAt,
		Revision:      v.Revision,
		Content:       apiMethodology(v.Content),
	}
}

func apiVersions(vs []domain.MethodologyVersion) []MethodologyVersion {
	out := make([]MethodologyVersion, 0, len(vs))
	for _, v := range vs {
		out = append(out, apiVersion(v))
	}
	return out
}

func apiMethodology(m domain.Methodology) Methodology {
	out := Methodology{
		Categories: make([]Category, 0, len(m.Categories)),
		Measures:   make([]Measure, 0, len(m.Measures)),
		Metrics:    make([]Metric, 0, len(m.Metrics)),
	}
	for _, c := range m.Categories {
		out.Categories = append(out.Categories, Category{Id: c.ID, Name: c.Name, Order: c.Order})
	}
	for _, ms := range m.Measures {
		out.Measures = append(out.Measures, apiMeasure(ms))
	}
	for _, mt := range m.Metrics {
		out.Metrics = append(out.Metrics, apiMetric(mt))
	}
	return out
}

func apiMeasure(ms domain.Measure) Measure {
	out := Measure{
		Key: ms.Key, Name: ms.Name, Unit: ms.Unit, OrgAgg: Agg(ms.OrgAgg), TimeAgg: Agg(ms.TimeAgg),
	}
	if ms.Source != "" {
		src := MeasureSource(ms.Source)
		out.Source = &src
	}
	if d := ms.Derive; d != nil {
		rule := DeriveRule{RecordType: Id(d.RecordType), Op: DeriveRuleOp(d.Op)}
		rule.BucketBy = optString(d.BucketBy)
		rule.Field = optString(d.Field)
		rule.Where = optString(d.Where)
		rule.AgeFrom = optString(d.AgeFrom)
		rule.AgeTo = optString(d.AgeTo)
		if d.Outcome != "" {
			oc := DeriveRuleOutcome(d.Outcome)
			rule.Outcome = &oc
		}
		if d.Weights != nil {
			w := make(map[string]float64, len(d.Weights))
			for k, v := range d.Weights {
				w[k] = v
			}
			rule.Weights = &w
		}
		out.Derive = &rule
	}
	return out
}

// optString returns nil for the empty string so optional fields are omitted.
func optString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// strOrEmpty dereferences an optional string, treating nil as empty.
func strOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func domainMeasure(ms Measure) domain.Measure {
	out := domain.Measure{
		Key: ms.Key, Name: ms.Name, Unit: ms.Unit, OrgAgg: domain.Agg(ms.OrgAgg), TimeAgg: domain.Agg(ms.TimeAgg),
	}
	if ms.Source != nil {
		out.Source = string(*ms.Source)
	}
	if d := ms.Derive; d != nil {
		rule := domain.DeriveRule{
			RecordType: string(d.RecordType),
			Op:         domain.DeriveOp(d.Op),
			BucketBy:   strOrEmpty(d.BucketBy),
			Field:      strOrEmpty(d.Field),
			Where:      strOrEmpty(d.Where),
			AgeFrom:    strOrEmpty(d.AgeFrom),
			AgeTo:      strOrEmpty(d.AgeTo),
		}
		if d.Outcome != nil {
			rule.Outcome = string(*d.Outcome)
		}
		if d.Weights != nil {
			rule.Weights = make(map[string]float64, len(*d.Weights))
			for k, v := range *d.Weights {
				rule.Weights[k] = v
			}
		}
		out.Derive = &rule
	}
	return out
}

func apiMetric(mt domain.Metric) Metric {
	out := Metric{
		Key:            mt.Key,
		Name:           mt.Name,
		CategoryId:     mt.CategoryID,
		Formula:        mt.Formula,
		Format:         MetricFormat(mt.Format),
		Direction:      Direction(mt.Direction),
		Frequency:      Frequency(mt.Frequency),
		ReportedAt:     make([]Subject, 0, len(mt.ReportedAt)),
		RollItemsToOrg: mt.RollItemsToOrg,
		Rule:           apiRule(mt.Rule),
		Targets:        make([]Target, 0, len(mt.Targets)),
		Definition:     mt.Definition,
		Notes:          mt.Notes,
		Example:        mt.Example,
		Source:         mt.Source,
		Link:           mt.Link,
	}
	for _, s := range mt.ReportedAt {
		out.ReportedAt = append(out.ReportedAt, Subject{Kind: SubjectKind(s.Kind), Id: s.ID})
	}
	for _, t := range mt.Targets {
		out.Targets = append(out.Targets, Target{
			Label: t.Label, From: periodString(t.From), To: periodString(t.To), Value: t.Value, SubjectId: t.SubjectID,
		})
	}
	return out
}

func apiBands(bs []domain.Band) []Band {
	out := make([]Band, 0, len(bs))
	for _, b := range bs {
		out = append(out, Band{Status: b.Status, Op: b.Op, Value: b.Value})
	}
	return out
}

func apiRule(r domain.StatusRule) StatusRule {
	out := StatusRule{Type: RuleType(r.Type)}
	if len(r.Bands) > 0 {
		bs := apiBands(r.Bands)
		out.Bands = &bs
	}
	if r.Compare != "" {
		c := Comparison(r.Compare)
		out.Compare = &c
	}
	if len(r.PerSubject) > 0 {
		ps := make([]SubjectBands, 0, len(r.PerSubject))
		for _, s := range r.PerSubject {
			ps = append(ps, SubjectBands{SubjectId: s.SubjectID, Bands: apiBands(s.Bands)})
		}
		out.PerSubject = &ps
	}
	if len(r.Scale) > 0 {
		sc := make([]ScaleStep, 0, len(r.Scale))
		for _, s := range r.Scale {
			sc = append(sc, ScaleStep{Status: s.Status, Min: s.Min})
		}
		out.Scale = &sc
	}
	return out
}

// domainMethodology converts a request body to the domain type. Every slice
// is non-nil. A target period that does not parse is recorded in pr under the
// content path.
func domainMethodology(m Methodology, pr *problems) domain.Methodology {
	out := domain.Methodology{
		Categories: make([]domain.Category, 0, len(m.Categories)),
		Measures:   make([]domain.Measure, 0, len(m.Measures)),
		Metrics:    make([]domain.Metric, 0, len(m.Metrics)),
	}
	for _, c := range m.Categories {
		out.Categories = append(out.Categories, domain.Category{ID: c.Id, Name: c.Name, Order: c.Order})
	}
	for _, ms := range m.Measures {
		out.Measures = append(out.Measures, domainMeasure(ms))
	}
	for i, mt := range m.Metrics {
		out.Metrics = append(out.Metrics, domainMetric(mt, fmt.Sprintf("content.metrics[%d]", i), pr))
	}
	return out
}

func domainMetric(mt Metric, path string, pr *problems) domain.Metric {
	out := domain.Metric{
		Key:            mt.Key,
		Name:           mt.Name,
		CategoryID:     mt.CategoryId,
		Formula:        mt.Formula,
		Format:         string(mt.Format),
		Direction:      domain.Direction(mt.Direction),
		Frequency:      domain.Frequency(mt.Frequency),
		ReportedAt:     make([]domain.Subject, 0, len(mt.ReportedAt)),
		RollItemsToOrg: mt.RollItemsToOrg,
		Rule:           domainRule(mt.Rule),
		Targets:        make([]domain.Target, 0, len(mt.Targets)),
		Definition:     mt.Definition,
		Notes:          mt.Notes,
		Example:        mt.Example,
		Source:         mt.Source,
		Link:           mt.Link,
	}
	for _, s := range mt.ReportedAt {
		out.ReportedAt = append(out.ReportedAt, domain.Subject{Kind: string(s.Kind), ID: s.Id})
	}
	for j, t := range mt.Targets {
		tp := fmt.Sprintf("%s.targets[%d]", path, j)
		from, to := optionalPeriod(pr, tp+".from", t.From), optionalPeriod(pr, tp+".to", t.To)
		out.Targets = append(out.Targets, domain.Target{Label: t.Label, From: from, To: to, Value: t.Value, SubjectID: t.SubjectId})
	}
	return out
}

// optionalPeriod parses a period that may be the empty string (unset).
func optionalPeriod(pr *problems, path, v string) period.Period {
	if v == "" {
		return period.Period{}
	}
	p, err := period.Parse(v)
	if err != nil {
		pr.add(path, "must be empty or a period such as 2026-M07")
		return period.Period{}
	}
	return p
}

func domainBands(bs []Band) []domain.Band {
	out := make([]domain.Band, 0, len(bs))
	for _, b := range bs {
		out = append(out, domain.Band{Status: b.Status, Op: b.Op, Value: b.Value})
	}
	return out
}

func domainRule(r StatusRule) domain.StatusRule {
	out := domain.StatusRule{Type: domain.RuleType(r.Type)}
	if r.Bands != nil && len(*r.Bands) > 0 {
		out.Bands = domainBands(*r.Bands)
	}
	if r.Compare != nil {
		out.Compare = domain.Comparison(*r.Compare)
	}
	if r.PerSubject != nil && len(*r.PerSubject) > 0 {
		out.PerSubject = make([]domain.SubjectBands, 0, len(*r.PerSubject))
		for _, s := range *r.PerSubject {
			out.PerSubject = append(out.PerSubject, domain.SubjectBands{SubjectID: s.SubjectId, Bands: domainBands(s.Bands)})
		}
	}
	if r.Scale != nil && len(*r.Scale) > 0 {
		out.Scale = make([]domain.ScaleStep, 0, len(*r.Scale))
		for _, s := range *r.Scale {
			out.Scale = append(out.Scale, domain.ScaleStep{Status: s.Status, Min: s.Min})
		}
	}
	return out
}
