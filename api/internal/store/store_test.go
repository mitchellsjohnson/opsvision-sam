package store_test

import (
	"context"
	"reflect"
	"testing"

	"opsvision/internal/domain"
	"opsvision/internal/store"
	"opsvision/internal/store/memstore"
)

func TestAddStandardRecordTypes(t *testing.T) {
	ctx := context.Background()
	st := memstore.New()
	edited := domain.RecordType{ID: "defect", Name: "Bug", Priorities: []string{"High", "Low"}}
	if err := st.PutRecordType(ctx, "t1", edited, 0); err != nil {
		t.Fatal(err)
	}

	added, err := store.AddStandardRecordTypes(ctx, st, "t1")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, rt := range added {
		ids = append(ids, rt.ID)
		if rt.Revision != 1 {
			t.Errorf("%s revision = %d, want 1", rt.ID, rt.Revision)
		}
	}
	if want := []string{"epic", "concept"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("added %v, want %v", ids, want)
	}

	types, err := st.ListRecordTypes(ctx, "t1")
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]domain.RecordType{}
	for _, rt := range types {
		byID[rt.ID] = rt
	}
	if len(byID) != 3 || byID["defect"].Name != "Bug" || byID["defect"].Revision != 1 {
		t.Fatalf("types = %+v; the edited defect type must be kept", types)
	}
	if byID["epic"].Name != "Epic" || byID["concept"].Name != "Concept" {
		t.Errorf("types = %+v", types)
	}

	// Again: nothing is missing, so nothing is written.
	if added, err := store.AddStandardRecordTypes(ctx, st, "t1"); err != nil || len(added) != 0 {
		t.Fatalf("second run added %v, %v", added, err)
	}
	if types, _ := st.ListRecordTypes(ctx, "t2"); len(types) != 0 {
		t.Errorf("another tenant got %+v", types)
	}
}
