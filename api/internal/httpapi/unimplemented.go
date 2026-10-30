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
