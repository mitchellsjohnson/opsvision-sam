package legacy

import (
	"encoding/json"
	"sort"
	"strings"

	"opsvision/internal/changeset"
	"opsvision/internal/domain"
)

// frequencyText maps the words legacy workbooks use onto frequencies.
var frequencyText = map[string]domain.Frequency{
	"monthly":   domain.FrequencyMonthly,
	"quarterly": domain.FrequencyQuarterly,
	"biannual":  domain.FrequencyBiannual,
	"annual":    domain.FrequencyAnnual,
}

// methodology reads one methodology sheet into text changes for a draft
// version. Empty cells change nothing. A change is only produced when the
// version exists, is a draft and has the metric.
func (p *parser) methodology(mm MethodologyMap) {
	sh := p.sheet(mm.Sheet)
	if sh == nil {
		p.find(changeset.SeverityError, mm.Sheet, "", "sheet %q not found in the workbook", mm.Sheet)
		return
	}
	var ver *domain.MethodologyVersion
	for i := range p.base.Versions {
		if p.base.Versions[i].ID == mm.VersionID {
			ver = &p.base.Versions[i]
		}
	}
	switch {
	case ver == nil:
		p.find(changeset.SeverityError, sh.Name, "", "methodology version %q does not exist", mm.VersionID)
		return
	case ver.Status != domain.VersionDraft:
		p.find(changeset.SeverityError, sh.Name, "", "methodology version %q is %s; legacy text can only go into a draft version", mm.VersionID, ver.Status)
		return
	}
	hasMetric := map[string]bool{}
	for _, m := range ver.Content.Metrics {
		hasMetric[m.Key] = true
	}

	labelCol := mm.LabelColumn
	if labelCol == "" {
		labelCol = "A"
	}
	byLabel := map[string]string{}
	for label, key := range mm.Rows {
		byLabel[norm(label)] = key
	}
	cols := make([]string, 0, len(mm.Columns))
	for col := range mm.Columns {
		cols = append(cols, strings.ToUpper(col))
	}
	sort.Slice(cols, func(i, j int) bool { return colNumber(cols[i]) < colNumber(cols[j]) })
	field := map[string]string{} // upper column -> field
	for col, f := range mm.Columns {
		field[strings.ToUpper(col)] = f
	}

	done := map[string]bool{}
	for _, r := range rowNumbers(sh) {
		label := norm(sh.Cells[ref(labelCol, r)].Text)
		key, ok := byLabel[label]
		if !ok || label == "" {
			continue
		}
		lref := ref(labelCol, r)
		if done[label] {
			p.find(changeset.SeverityError, sh.Name, lref, "row %q appears more than once; only the first is used", strings.TrimSpace(sh.Cells[lref].Text))
			continue
		}
		done[label] = true
		if !hasMetric[key] {
			p.find(changeset.SeverityError, sh.Name, lref, "methodology version %s has no metric %q", ver.ID, key)
			continue
		}

		var band [3]string // green, yellow, red
		var bandRef [3]string
		for _, col := range cols {
			cref := ref(col, r)
			text := strings.TrimSpace(sh.Cells[cref].Text)
			if text == "" {
				continue
			}
			switch f := field[col]; f {
			case fieldGreen:
				band[0], bandRef[0] = text, cref
			case fieldYellow:
				band[1], bandRef[1] = text, cref
			case fieldRed:
				band[2], bandRef[2] = text, cref
			case changeset.FieldFrequency:
				freq, ok := frequencyText[strings.ToLower(text)]
				if !ok {
					p.find(changeset.SeverityWarn, sh.Name, cref, "frequency %q is not Monthly, Quarterly, Biannual or Annual; left unchanged", text)
					continue
				}
				p.change(ver.ID, key, f, string(freq))
			default:
				p.change(ver.ID, key, f, text)
			}
		}
		p.bands(sh.Name, ver.ID, key, band, bandRef)
	}

	for _, label := range sortedKeys(mm.Rows) {
		if !done[norm(label)] {
			p.find(changeset.SeverityWarn, sh.Name, "", "methodology row %q was not found in column %s", label, strings.ToUpper(labelCol))
		}
	}
}

func (p *parser) change(versionID, metricKey, field, value string) {
	p.cs.VersionText = append(p.cs.VersionText, changeset.VersionTextChange{
		VersionID: versionID, MetricKey: metricKey, Field: field, Value: value,
	})
}

// bands combines the green, yellow and red texts into one "bands" change.
func (p *parser) bands(sheet, versionID, metricKey string, text, refs [3]string) {
	n, first := 0, ""
	for i, t := range text {
		if t != "" {
			if n == 0 {
				first = refs[i]
			}
			n++
		}
	}
	switch n {
	case 0:
		return
	case 1, 2:
		p.find(changeset.SeverityWarn, sheet, first, "metric %q has some but not all of green, yellow and red text; bands left unchanged", metricKey)
		return
	}
	bs, dir, err := ParseBandText(text[0], text[1], text[2])
	if err != nil {
		p.find(changeset.SeverityWarn, sheet, refs[0], "metric %q: %v; bands left unchanged", metricKey, err)
		return
	}
	b, err := json.Marshal(changeset.BandsValue{Bands: bs, Direction: dir})
	if err != nil {
		p.find(changeset.SeverityWarn, sheet, refs[0], "metric %q: cannot encode bands: %v", metricKey, err)
		return
	}
	p.change(versionID, metricKey, changeset.FieldBands, string(b))
}
