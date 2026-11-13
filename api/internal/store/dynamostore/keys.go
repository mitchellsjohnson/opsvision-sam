package dynamostore

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"opsvision/internal/domain"
	"opsvision/internal/period"
)

// This file is the single source of truth for the table's key layout. The
// strings are the on-disk format; keys_test.go pins every one of them.
//
// Table: PK (S), SK (S), GSI1PK (S), GSI1SK (S), index GSI1 on
// (GSI1PK, GSI1SK) projecting all attributes.
//
// IDs (tenant, scorecard, measure, subject, ...) are concatenated with '#'
// separators and must not themselves contain '#'; the API layer is
// responsible for generating or validating IDs that way.

// Fixed sort keys and GSI1 partition keys.
const (
	skTenant   = "TENANT"
	skAuth0Map = "MAP"

	gsiTenants = "TENANTS"
)

// Sort-key prefixes inside a tenant partition (T#<tid>) and inside a
// fiscal-year data partition.
const (
	prefixMember        = "MEMBER#"
	prefixLevel         = "LEVEL#"
	prefixUnit          = "UNIT#"
	prefixMove          = "MOVE#"
	prefixKind          = "KIND#"
	prefixItem          = "ITEM#"
	prefixScorecard     = "SC#"
	prefixImport        = "IMPORT#"
	prefixTemplate      = "TEMPLATE#"
	prefixPoint         = "DP#"
	prefixOverride      = "OV#"
	prefixRecType       = "RTYPE#"
	prefixSnapshot      = "SNAP#"
	prefixRecordRev     = "R#"
	prefixLayout        = "LAYOUT#"
	prefixLayoutDef     = "LAYOUTDEFAULT#"
	prefixReportSummary = "REPORTSUMMARY#"
	prefixReportRev     = "REPORT#"

	versionMarker = "#VER#"
)

func tenantPK(tid string) string     { return "T#" + tid }
func auth0OrgPK(orgID string) string { return "AUTH0ORG#" + orgID }
func gsiTenantSK(tid string) string  { return "T#" + tid }
func gsiUserPK(userID string) string { return "USER#" + userID }
func memberSK(userID string) string  { return prefixMember + userID }
func levelSK(id string) string       { return prefixLevel + id }
func unitSK(id string) string        { return prefixUnit + id }
func kindSK(id string) string        { return prefixKind + id }
func itemSK(id string) string        { return prefixItem + id }
func scorecardSK(id string) string   { return prefixScorecard + id }
func layoutSK(userID, scorecardID string) string {
	return prefixLayout + userID + "#" + scorecardID
}
func layoutDefaultSK(scorecardID string) string { return prefixLayoutDef + scorecardID }
func importSK(id string) string                 { return prefixImport + id }
func templateSK(id string) string               { return prefixTemplate + id }
func recordTypeSK(id string) string             { return prefixRecType + id }
func versionPrefix(scID string) string          { return prefixScorecard + scID + versionMarker }

func versionSK(scID, versionID string) string { return versionPrefix(scID) + versionID }

func moveSK(unitID string, month period.Period) string {
	return prefixMove + unitID + "#" + month.String()
}

// snapshotPrefix is the SK prefix shared by every snapshot of one record type.
func snapshotPrefix(recordType string) string { return prefixSnapshot + recordType + "#" }

func snapshotSK(recordType, id string) string { return snapshotPrefix(recordType) + id }

// recordPK is the partition of every record revision of one record type.
func recordPK(tid, recordType string) string { return "T#" + tid + "#REC#" + recordType }

// recordSK is the sort key of one record revision. Source and external ID are
// escaped with url.PathEscape because external IDs may contain '#'.
func recordSK(source, externalID string, asOf domain.Date) string {
	return prefixRecordRev + url.PathEscape(source) + "#" + url.PathEscape(externalID) + "#" + asOf.String()
}

// tenantFromGSISK extracts the tenant ID from a membership's GSI1SK.
func tenantFromGSISK(sk string) string { return strings.TrimPrefix(sk, "T#") }

// dataPK is the partition of current data points and overrides for one
// scorecard and fiscal year.
func dataPK(tid, scID string, fy int) string {
	return "T#" + tid + "#SC#" + scID + "#FY#" + strconv.Itoa(fy)
}

// histPK is the partition of every data point revision for a scorecard.
func histPK(tid, scID string) string { return "T#" + tid + "#SC#" + scID + "#HIST" }

func pointSK(p period.Period, measure, subject string) string {
	return prefixPoint + p.String() + "#" + measure + "#" + subject
}

// histPrefix is the SK prefix shared by all revisions of one data point.
func histPrefix(p period.Period, measure, subject string) string {
	return pointSK(p, measure, subject) + "#R"
}

func histSK(p period.Period, measure, subject string, rev int) string {
	return histPrefix(p, measure, subject) + fmt.Sprintf("%06d", rev)
}

func overrideSK(p period.Period, metric, subject string) string {
	return prefixOverride + p.String() + "#" + metric + "#" + subject
}

// auditPK is the partition of one calendar month (UTC) of audit entries.
func auditPK(tid string, t time.Time) string {
	return "T#" + tid + "#AUDIT#" + t.UTC().Format("2006-01")
}

// auditMonths returns the first instant of every UTC calendar month that
// intersects [from, to). It returns nil for an empty or inverted range.
func auditMonths(from, to time.Time) []time.Time {
	if !from.Before(to) {
		return nil
	}
	from, last := from.UTC(), to.UTC().Add(-time.Nanosecond)
	cur := time.Date(from.Year(), from.Month(), 1, 0, 0, 0, 0, time.UTC)
	var out []time.Time
	for !cur.After(last) {
		out = append(out, cur)
		cur = cur.AddDate(0, 1, 0)
	}
	return out
}
