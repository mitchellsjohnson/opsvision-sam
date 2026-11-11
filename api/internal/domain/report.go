package domain

import "time"

// ReportSummary is the editable executive summary for one scorecard month.
type ReportSummary struct {
	Text      string    `json:"text"`
	Revision  int       `json:"revision"`
	UpdatedBy string    `json:"updatedBy"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ReportRevision indexes one published report snapshot.
type ReportRevision struct {
	Period      string    `json:"period"`
	Revision    int       `json:"revision"`
	PublishedBy string    `json:"publishedBy"`
	PublishedAt time.Time `json:"publishedAt"`
	ObjectKey   string    `json:"objectKey"`
}
