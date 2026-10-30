package httpapi

import "context"

// unimplemented supplies a 501 not_implemented response for every operation
// that no task has implemented yet. Server embeds it; a method defined on
// *Server shadows the embedded stub. When a task implements an operation it
// deletes the matching stub here.
type unimplemented struct{}

func (unimplemented) ListAudit(context.Context, ListAuditRequestObject) (ListAuditResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) ListImportTemplates(context.Context, ListImportTemplatesRequestObject) (ListImportTemplatesResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) ReplaceImportTemplates(context.Context, ReplaceImportTemplatesRequestObject) (ReplaceImportTemplatesResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) PutImportTemplate(context.Context, PutImportTemplateRequestObject) (PutImportTemplateResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) CreateImportUpload(context.Context, CreateImportUploadRequestObject) (CreateImportUploadResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) ApplyImport(context.Context, ApplyImportRequestObject) (ApplyImportResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) ParseImport(context.Context, ParseImportRequestObject) (ParseImportResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) ListScorecards(context.Context, ListScorecardsRequestObject) (ListScorecardsResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) CreateScorecard(context.Context, CreateScorecardRequestObject) (CreateScorecardResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) BatchSaveData(context.Context, BatchSaveDataRequestObject) (BatchSaveDataResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) GetDataEntry(context.Context, GetDataEntryRequestObject) (GetDataEntryResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) GetDataHistory(context.Context, GetDataHistoryRequestObject) (GetDataHistoryResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) DeleteOverride(context.Context, DeleteOverrideRequestObject) (DeleteOverrideResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) PutOverride(context.Context, PutOverrideRequestObject) (PutOverrideResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) PreviewData(context.Context, PreviewDataRequestObject) (PreviewDataResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) ListVersions(context.Context, ListVersionsRequestObject) (ListVersionsResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) CreateVersion(context.Context, CreateVersionRequestObject) (CreateVersionResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) GetVersion(context.Context, GetVersionRequestObject) (GetVersionResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) PutVersion(context.Context, PutVersionRequestObject) (PutVersionResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) GetVersionDiff(context.Context, GetVersionDiffRequestObject) (GetVersionDiffResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) PublishVersion(context.Context, PublishVersionRequestObject) (PublishVersionResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) ValidateVersion(context.Context, ValidateVersionRequestObject) (ValidateVersionResponseObject, error) {
	return nil, errNotImplemented
}

func (unimplemented) GetScorecardView(context.Context, GetScorecardViewRequestObject) (GetScorecardViewResponseObject, error) {
	return nil, errNotImplemented
}
