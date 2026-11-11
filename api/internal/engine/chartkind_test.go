package engine

import (
	"reflect"
	"testing"

	"opsvision/internal/domain"
)

func metricChart(m domain.Metric) domain.Metric {
	if m.CategoryID == "" {
		m.CategoryID = "c"
	}
	if m.Formula == "" {
		m.Formula = "on_time"
	}
	if !m.Direction.Valid() {
		m.Direction = domain.DirectionHigherBetter
	}
	if !m.Frequency.Valid() {
		m.Frequency = domain.FrequencyMonthly
	}
	if len(m.ReportedAt) == 0 {
		m.ReportedAt = []domain.Subject{{Kind: domain.SubjectLevel, ID: "prod"}}
	}
	return m
}

func moneyPlanBands() []domain.Band {
	return []domain.Band{
		band("G", ">=", 100),
		band("Y", ">=", 95),
		band("R", "<", 90),
	}
}

func TestChartKind(t *testing.T) {
	cases := []struct {
		name string
		m    domain.Metric
		want string
	}{
		{
			name: "override_ratio",
			m: metricChart(domain.Metric{
				Key: "a", Format: domain.FormatPercent1,
				Rule: bandsRule(band("G", ">=", 90), band("R", "", 0)),
				ChartKind: "ratio",
			}),
			want: "ratio",
		},
		{
			name: "override_line_on_ratio_metric",
			m: metricChart(domain.Metric{
				Key: "a", Format: domain.FormatPercent1,
				Rule: bandsRule(band("G", ">=", 90), band("R", "", 0)),
				ChartKind: "line",
			}),
			want: "line",
		},
		{
			name: "invalid_override_falls_through",
			m: metricChart(domain.Metric{
				Key: "a", Format: domain.FormatPercent1,
				Rule: bandsRule(band("G", ">=", 90), band("R", "", 0)),
				ChartKind: "not_a_kind",
			}),
			want: "ratio",
		},
		{
			name: "discrete_quarterly",
			m: metricChart(domain.Metric{
				Key: "a", Format: domain.FormatPercent1, Frequency: domain.FrequencyQuarterly,
				Rule: bandsRule(band("G", ">=", 90), band("R", "", 0)),
			}),
			want: "discrete",
		},
		{
			name: "days",
			m: metricChart(domain.Metric{
				Key: "a", Format: domain.FormatDays0,
				Rule: bandsRule(band("G", "<=", 14), band("R", "", 0)),
			}),
			want: "days",
		},
		{
			name: "change",
			m: metricChart(domain.Metric{
				Key: "a", Format: domain.FormatPercent1,
				Rule: changeRule(domain.ComparePriorPeriod, band("G", ">=", 5), band("R", "", 0)),
			}),
			want: "change",
		},
		{
			name: "uptime",
			m: metricChart(domain.Metric{
				Key: "a", Format: domain.FormatPercent2,
				ReportedAt: []domain.Subject{{Kind: domain.SubjectItemKind, ID: "app"}},
				Rule: bandsRule(band("G", ">=", 99), band("R", "", 0)),
			}),
			want: "uptime",
		},
		{
			name: "money_plan",
			m: metricChart(domain.Metric{
				Key: "a", Format: domain.FormatPercent1,
				Rule: bandsRule(moneyPlanBands()...),
			}),
			want: "money_plan",
		},
		{
			name: "ratio",
			m: metricChart(domain.Metric{
				Key: "a", Format: domain.FormatPercent1,
				Rule: bandsRule(band("G", ">=", 90), band("R", "", 0)),
			}),
			want: "ratio",
		},
		{
			name: "line",
			m: metricChart(domain.Metric{
				Key: "a", Format: domain.FormatNumber0,
				Rule: domain.StatusRule{Type: domain.RuleScale, Scale: []domain.ScaleStep{{Status: "G", Min: 1}}},
			}),
			want: "line",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ChartKind(tc.m); got != tc.want {
				t.Errorf("ChartKind() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestResolveRule(t *testing.T) {
	defaultBands := []domain.Band{band("G", ">=", 90), band("R", "", 0)}
	subjectBands := []domain.Band{band("G", ">=", 80), band("R", "", 0)}
	rule := domain.StatusRule{
		Type:  domain.RuleBands,
		Bands: defaultBands,
		PerSubject: []domain.SubjectBands{
			{SubjectID: "gateway", Bands: subjectBands},
			{SubjectID: "platform", Bands: []domain.Band{band("G", ">=", 70), band("R", "", 0)}},
		},
	}

	got := ResolveRule(rule, "gateway")
	want := domain.StatusRule{
		Type:  domain.RuleBands,
		Bands: subjectBands,
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ResolveRule(gateway) = %+v, want %+v", got, want)
	}

	gotOther := ResolveRule(rule, "analytics")
	wantOther := domain.StatusRule{
		Type:  domain.RuleBands,
		Bands: defaultBands,
	}
	if !reflect.DeepEqual(gotOther, wantOther) {
		t.Errorf("ResolveRule(analytics) = %+v, want default bands %+v", gotOther, wantOther)
	}
}
