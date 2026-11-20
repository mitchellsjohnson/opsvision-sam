package httpapi

import "context"

// DraftCellRca is not implemented yet.
func (s *Server) DraftCellRca(context.Context, DraftCellRcaRequestObject) (DraftCellRcaResponseObject, error) {
	return nil, errNotImplemented
}

// GetCellRcaDraft is not implemented yet.
func (s *Server) GetCellRcaDraft(context.Context, GetCellRcaDraftRequestObject) (GetCellRcaDraftResponseObject, error) {
	return nil, errNotImplemented
}
